import { config, http } from "./config.js";

/*
  Shared Home Assistant operations, used by both the /api/hub routes and the
  built-in assistant agent. Each op maps to an HA REST call. Read operations
  return normalized shapes matching the dashboard.
*/

const ha = () => config.homeassistant;
const headers = () => ({ Authorization: `Bearer ${ha().token}`, "Content-Type": "application/json" });

export const haConfigured = () => config.homeassistant.configured;

export const getState = (entity) =>
  entity ? http(`${ha().baseUrl}/api/states/${entity}`, { headers: headers() }) : Promise.resolve(null);

export const callService = (domain, service, data) =>
  http(`${ha().baseUrl}/api/services/${domain}/${service}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(data || {}),
  });

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const num = (v, d = 0) => (v == null || isNaN(Number(v)) ? d : Math.round(Number(v)));
const doorEntity = (id) => ha().entities.doors?.[id]?.entity;
const zoneEntity = (id) => ha().entities.zones?.[id]?.entity;
const allDoorEntities = () => Object.values(ha().entities.doors || {}).map((d) => d.entity).filter(Boolean);
const alarmData = () => {
  const data = { entity_id: ha().entities.alarm };
  if (ha().alarmCode) data.code = ha().alarmCode;
  return data;
};

// Valid ids (for tool enums / validation), available even before HA is wired.
export const doorIds = () => Object.keys(ha().entities.doors || {});
export const zoneIds = () => Object.keys(ha().entities.zones || {});

// Normalized current state.
export async function readState() {
  const ent = ha().entities;
  const doors = [];
  for (const [id, def] of Object.entries(ent.doors || {})) {
    const s = await getState(def.entity).catch(() => null);
    doors.push({ id, name: def.name, locked: s ? s.state === "locked" : true });
  }
  let alarm = "armed_away";
  if (ent.alarm) {
    const s = await getState(ent.alarm).catch(() => null);
    if (s?.state) alarm = s.state;
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
}

// Mutating operations (shared by routes and the agent).
export const haOps = {
  lockDoor: (id) => callService("lock", "lock", { entity_id: doorEntity(id) }),
  unlockDoor: (id) => callService("lock", "unlock", { entity_id: doorEntity(id) }),
  lockAll: () => callService("lock", "lock", { entity_id: allDoorEntities() }),
  unlockAll: () => callService("lock", "unlock", { entity_id: allDoorEntities() }),
  arm: (mode) =>
    callService("alarm_control_panel", mode === "armed_home" ? "alarm_arm_home" : "alarm_arm_away", alarmData()),
  disarm: () => callService("alarm_control_panel", "alarm_disarm", alarmData()),
  setTemp: (zoneId, temperature) =>
    callService("climate", "set_temperature", {
      entity_id: zoneEntity(zoneId),
      temperature: Math.max(60, Math.min(85, Number(temperature))),
    }),
  lockdown: async () => {
    await callService("lock", "lock", { entity_id: allDoorEntities() });
    await callService("alarm_control_panel", "alarm_arm_away", alarmData());
  },
};
