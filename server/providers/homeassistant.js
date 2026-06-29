import { Router } from "express";
import { config, guard, http } from "../config.js";
import { logAudit } from "../auth.js";

export const hubRouter = Router();

/*
  Home Assistant hub — the on-site adapter for the LAN devices.

  SETUP:
    1. In Home Assistant: Profile -> Security -> Long-lived access tokens -> create.
    2. Put HA_BASE_URL (e.g. http://homeassistant.local:8123) and HA_TOKEN in .env.
    3. Map your real entity_ids: set HA_ENTITIES to a JSON object, or edit
       DEFAULT_HA_ENTITIES in server/config.js. The dashboard's door/zone ids
       (main/med/fit/elc, off) must each point to a real HA entity.

  HA REST API used:
    GET  /api/states/{entity_id}                 -> current state + attributes
    POST /api/services/{domain}/{service}        -> perform an action
*/

const ha = () => config.homeassistant;
const headers = () => ({ Authorization: `Bearer ${ha().token}`, "Content-Type": "application/json" });

const getState = (entity) =>
  entity ? http(`${ha().baseUrl}/api/states/${entity}`, { headers: headers() }) : Promise.resolve(null);

const callService = (domain, service, data) =>
  http(`${ha().baseUrl}/api/services/${domain}/${service}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(data || {}),
  });

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const num = (v, d = 0) => (v == null || isNaN(Number(v)) ? d : Math.round(Number(v)));

// Resolve a door/zone id to its configured entity_id.
const doorEntity = (id) => ha().entities.doors?.[id]?.entity;
const zoneEntity = (id) => ha().entities.zones?.[id]?.entity;

/* ----------------------------- read state ----------------------------- */
hubRouter.get(
  "/state",
  guard("homeassistant", async () => {
    const ent = ha().entities;

    const doors = [];
    for (const [id, def] of Object.entries(ent.doors || {})) {
      const s = await getState(def.entity).catch(() => null);
      // HA lock states: "locked" / "unlocked". Treat unknown as locked (safe default).
      doors.push({ id, name: def.name, locked: s ? s.state === "locked" : true });
    }

    let alarm = "armed_away";
    if (ent.alarm) {
      const s = await getState(ent.alarm).catch(() => null);
      if (s?.state) alarm = s.state; // e.g. armed_away | armed_home | disarmed | triggered
    }

    const zones = [];
    for (const [id, def] of Object.entries(ent.zones || {})) {
      const s = await getState(def.entity).catch(() => null);
      const a = s?.attributes || {};
      zones.push({
        id, name: def.name,
        set: num(a.temperature, 72),
        now: num(a.current_temperature ?? a.temperature, 72),
        hum: num(a.current_humidity, 0),
        mode: cap(s?.state || "off"),
      });
    }

    return { doors, alarm, zones, lockdown: alarm === "triggered" };
  })
);

/* ----------------------------- actions ----------------------------- */
// Wrap a hub action: run it, then write an audit entry (who did what).
function action(name, handler) {
  return guard("homeassistant", async (req) => {
    const body = req.body || {};
    await handler(body);
    logAudit(req, `hub.${name}`, body.id || body.zoneId || null, body);
    return { applied: true };
  });
}

hubRouter.post("/lock",   action("lock",   async ({ id }) => callService("lock", "lock",   { entity_id: doorEntity(id) })));
hubRouter.post("/unlock", action("unlock", async ({ id }) => callService("lock", "unlock", { entity_id: doorEntity(id) })));

hubRouter.post("/lockAll", action("lockAll", async () => {
  const ids = Object.values(ha().entities.doors || {}).map((d) => d.entity).filter(Boolean);
  await callService("lock", "lock", { entity_id: ids });
}));
hubRouter.post("/unlockAll", action("unlockAll", async () => {
  const ids = Object.values(ha().entities.doors || {}).map((d) => d.entity).filter(Boolean);
  await callService("lock", "unlock", { entity_id: ids });
}));

hubRouter.post("/arm", action("arm", async ({ mode }) => {
  const service = mode === "armed_home" ? "alarm_arm_home" : "alarm_arm_away";
  const data = { entity_id: ha().entities.alarm };
  if (ha().alarmCode) data.code = ha().alarmCode;
  await callService("alarm_control_panel", service, data);
}));
hubRouter.post("/disarm", action("disarm", async () => {
  const data = { entity_id: ha().entities.alarm };
  if (ha().alarmCode) data.code = ha().alarmCode;
  await callService("alarm_control_panel", "alarm_disarm", data);
}));

hubRouter.post("/setTemp", action("setTemp", async ({ zoneId, temperature }) => {
  await callService("climate", "set_temperature", {
    entity_id: zoneEntity(zoneId),
    temperature: Math.max(60, Math.min(85, Number(temperature))),
  });
}));

// Emergency: lock every door and arm away in one call.
hubRouter.post("/lockdown", action("lockdown", async () => {
  const ids = Object.values(ha().entities.doors || {}).map((d) => d.entity).filter(Boolean);
  await callService("lock", "lock", { entity_id: ids });
  const data = { entity_id: ha().entities.alarm };
  if (ha().alarmCode) data.code = ha().alarmCode;
  await callService("alarm_control_panel", "alarm_arm_away", data);
}));
