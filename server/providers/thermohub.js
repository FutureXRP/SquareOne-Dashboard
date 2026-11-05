import { Router } from "express";
import { config, guard, http } from "../config.js";
import { requireAuth, requireAdmin, requireManager, logAudit } from "../auth.js";

export const thermohubRouter = Router();

/*
  ThermoHub — the thermostat service in front of the ecobee(s).

  ThermoHub's own hub (Home Assistant on the on-site admin PC) talks to the
  thermostats and owns the schedule profiles, motion overrides, smart recovery
  and holds. We never touch the thermostats behind its back: everything goes
  through its cloud API, exactly the calls its web app makes
  (see its api.js / store.js):

    GET  /api/state                         everything: thermostats, buildings, schedules…
    POST /api/thermostats/:id/hold          { heat, cool, until: epoch-ms | null }
    POST /api/thermostats/:id/resume        back to the schedule profile
    POST /api/thermostats/:id/mode          { mode: heat|cool|auto|off }
    POST /api/buildings/:id/resume          resume every thermostat in a building
    POST /api/one-time                      { businessId, name, buildingIds, thermostatIds, start, end, heat, cool }
    PUT  /api/one-time/:id                  same body (+ id); DELETE /api/one-time/:id
      One-time schedules: ThermoHub's own timer places a hold on each target
      at `start` (epoch ms) and clears it at `end`, then drops the entry.
      /api/state lists the pending + running ones as `oneTimeSchedules`.

  Auth is a bearer token. The web app uses a Microsoft sign-in token; a server
  can't get one of those, so THERMOHUB_TOKEN must be an integration token that
  ThermoHub issues for this purpose. Until it's set, everything here reports
  "not configured" and the booking climate automation stays dry-run.

  Routes (mounted at /api/thermohub):
    GET  /thermostats           (signed-in) normalized list
    POST /thermostats/:id/hold  (manager)   { heat, cool, minutes | until }
    POST /thermostats/:id/resume(manager)
    POST /thermostats/:id/mode  (manager)   { mode }
    GET  /debug                 (admin)     raw /api/state summary
*/

const MODES = ["heat", "cool", "auto", "off"];
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

async function thCall(method, path, body) {
  const th = config.thermohub;
  return http(`${th.apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${th.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, 15000);
}

export const thermohubConfigured = () => config.thermohub.configured;

// Raw ThermoHub state (cached for a few seconds — the UI, the Home card and the
// scheduler all read it, and ThermoHub's own app polls at a similar rate).
let stateCache = { at: 0, data: null };
export async function fetchState(maxAgeMs = 5000) {
  if (stateCache.data && Date.now() - stateCache.at < maxAgeMs) return stateCache.data;
  const data = await thCall("GET", "/api/state");
  stateCache = { at: Date.now(), data };
  return data;
}
const invalidate = () => { stateCache = { at: 0, data: null }; };

// --- Schedule maths (ported from ThermoHub's store.js, in the org timezone) ---
function localClock(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  const day = get("weekday").toLowerCase().slice(0, 3);
  const h = Number(get("hour")) % 24, m = Number(get("minute"));
  return { day, min: h * 60 + m };
}
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };
function isScheduledOccupied(sched, ms) {
  if (!sched?.days) return false;
  const { day, min } = localClock(ms);
  return (sched.days[day] || []).some((p) => min >= toMin(p.start) && min < toMin(p.end));
}
function activeHold(t) {
  if (!t.hold) return null;
  if (t.hold.until && t.hold.until <= Date.now()) return null;
  return t.hold;
}
// What the thermostat is targeting right now, and why (hold → schedule).
function effective(t, sched) {
  const hold = activeHold(t);
  if (hold) return { heat: hold.heat, cool: hold.cool, source: hold.type || "manual", hold };
  if (!sched) return { heat: null, cool: null, source: "none", hold: null };
  const occ = isScheduledOccupied(sched, Date.now());
  const recovering = t.recovering && Date.now() < t.recovering;
  const p = occ || recovering ? sched.occupied : sched.unoccupied;
  return { heat: p?.heat ?? null, cool: p?.cool ?? null, source: occ ? "occupied" : recovering ? "recovery" : "unoccupied", hold: null };
}

// --- One-time schedules ---------------------------------------------------------
export async function fetchOneTimes(maxAgeMs) {
  const s = await fetchState(maxAgeMs);
  return Array.isArray(s.oneTimeSchedules) ? s.oneTimeSchedules : [];
}
function cleanOneTime(d) {
  const h = Math.round(Number(d.heat)), c = Math.round(Number(d.cool));
  if (!(h >= 45 && h <= 90 && c >= 50 && c <= 95)) throw new Error("Setpoints must be between 45° and 95°.");
  if (c - h < 2) throw new Error("Cool setpoint must be at least 2° above heat setpoint.");
  if (!(Number(d.end) > Number(d.start))) throw new Error("The end must be after the start.");
  return {
    businessId: d.businessId, name: String(d.name || "").slice(0, 120),
    buildingIds: Array.isArray(d.buildingIds) ? d.buildingIds : [],
    thermostatIds: Array.isArray(d.thermostatIds) ? d.thermostatIds : [],
    start: Number(d.start), end: Number(d.end), heat: h, cool: c,
  };
}
export async function createOneTime(d) {
  const r = await thCall("POST", "/api/one-time", cleanOneTime(d));
  invalidate();
  return r;
}
export async function updateOneTime(id, d) {
  const r = await thCall("PUT", `/api/one-time/${encodeURIComponent(id)}`, { id, ...cleanOneTime(d) });
  invalidate();
  return r;
}
export async function deleteOneTime(id) {
  const r = await thCall("DELETE", `/api/one-time/${encodeURIComponent(id)}`);
  invalidate();
  return r;
}

// Normalized thermostats, optionally limited to THERMOHUB_BUILDING.
export async function fetchThermostats(maxAgeMs) {
  const s = await fetchState(maxAgeMs);
  const buildings = s.buildings || [], businesses = s.businesses || [], schedules = s.schedules || [];
  const oneTimes = Array.isArray(s.oneTimeSchedules) ? s.oneTimeSchedules : [];
  const want = config.thermohub.building.trim().toLowerCase();
  const bld = (id) => buildings.find((b) => b.id === id);
  return (s.thermostats || [])
    .filter((t) => {
      if (!want) return true;
      const b = bld(t.buildingId);
      return t.buildingId === want || (b && b.name.toLowerCase() === want);
    })
    .map((t) => {
      const b = bld(t.buildingId);
      const biz = businesses.find((x) => x.id === t.businessId);
      const sched = schedules.find((x) => x.id === t.scheduleId) || null;
      const e = effective(t, sched);
      // Upcoming/running one-time schedules that cover this thermostat.
      const upcoming = oneTimes
        .filter((o) => (o.thermostatIds || []).includes(t.id) || (o.buildingIds || []).includes(t.buildingId))
        .map((o) => ({ id: o.id, name: o.name, start: o.start, end: o.end, heat: o.heat, cool: o.cool, started: Boolean(o.started) }))
        .sort((a, b) => a.start - b.start);
      return {
        id: t.id, name: t.name, model: t.model || "", building: b?.name || null, buildingId: t.buildingId || null,
        businessId: t.businessId || null,
        temp: t.temp ?? null, humidity: t.humidity ?? null,
        oneTime: upcoming,
        mode: t.mode || null, equipment: t.equipment || "idle", occupied: Boolean(t.occupied),
        heat: e.heat, cool: e.cool, source: e.source,
        hold: e.hold ? { type: e.hold.type || "manual", heat: e.hold.heat, cool: e.hold.cool, until: e.hold.until || null, by: e.hold.by || null } : null,
        schedule: sched ? { id: sched.id, name: sched.name } : null,
        online: Boolean(biz?.hub?.online) && !t.offlineSince,
        hubOnline: Boolean(biz?.hub?.online),
        alert: t.alert || null,
      };
    });
}

// Mutations used by the routes and the booking scheduler.
export async function thHold(id, heat, cool, untilMs) {
  const h = Math.round(Number(heat)), c = Math.round(Number(cool));
  if (!(h >= 45 && h <= 90 && c >= 50 && c <= 95)) throw new Error("Setpoints must be between 45° and 95°.");
  if (c - h < 2) throw new Error("Cool setpoint must be at least 2° above heat setpoint.");
  const r = await thCall("POST", `/api/thermostats/${encodeURIComponent(id)}/hold`, { heat: h, cool: c, until: untilMs ?? null });
  invalidate();
  return r;
}
export async function thResume(id) {
  const r = await thCall("POST", `/api/thermostats/${encodeURIComponent(id)}/resume`);
  invalidate();
  return r;
}
export async function thSetMode(id, mode) {
  if (!MODES.includes(mode)) throw new Error(`Mode must be one of ${MODES.join(", ")}.`);
  const r = await thCall("POST", `/api/thermostats/${encodeURIComponent(id)}/mode`, { mode });
  invalidate();
  return r;
}

// --- Routes -------------------------------------------------------------------
thermohubRouter.get("/thermostats", requireAuth, guard("thermohub", async () => ({
  thermostats: await fetchThermostats(),
  eventHeat: config.climate.eventHeat, eventCool: config.climate.eventCool,
})));

const nameOf = async (id) => (await fetchThermostats().catch(() => []))?.find((t) => t.id === id)?.name || id;

thermohubRouter.post("/thermostats/:id/hold", requireAuth, requireManager, guard("thermohub", async (req) => {
  const { id } = req.params;
  const { heat, cool, minutes, until } = req.body || {};
  // minutes: number | "indefinite"; until: epoch ms (wins when given).
  const untilMs = until != null ? Number(until) || null
    : minutes === "indefinite" || minutes === null ? null
    : Date.now() + (Number(minutes) || 120) * 60000;
  await thHold(id, heat, cool, untilMs);
  logAudit(req, "climate.hold", await nameOf(id), { heat, cool, until: untilMs ? new Date(untilMs).toISOString() : null });
  return { thermostats: await fetchThermostats(0) };
}));

thermohubRouter.post("/thermostats/:id/resume", requireAuth, requireManager, guard("thermohub", async (req) => {
  const { id } = req.params;
  await thResume(id);
  logAudit(req, "climate.resume", await nameOf(id), {});
  return { thermostats: await fetchThermostats(0) };
}));

thermohubRouter.post("/thermostats/:id/mode", requireAuth, requireManager, guard("thermohub", async (req) => {
  const { id } = req.params;
  const mode = String(req.body?.mode || "").toLowerCase();
  await thSetMode(id, mode);
  logAudit(req, "climate.mode", await nameOf(id), { mode });
  return { thermostats: await fetchThermostats(0) };
}));

// Admin probe for Settings → Diagnostics: what the token can see (no users list).
thermohubRouter.get("/debug", requireAuth, requireAdmin, guard("thermohub", async () => {
  const s = await fetchState(0);
  return {
    apiUrl: config.thermohub.apiUrl,
    me: s.user ? { name: s.user.name, role: s.user.role, businessId: s.user.businessId } : null,
    businesses: (s.businesses || []).map((b) => ({ id: b.id, name: b.name, hub: b.hub })),
    buildings: (s.buildings || []).map((b) => ({ id: b.id, name: b.name, businessId: b.businessId })),
    schedules: (s.schedules || []).map((x) => ({ id: x.id, name: x.name, occupied: x.occupied, unoccupied: x.unoccupied })),
    oneTimeSchedules: s.oneTimeSchedules || [],
    thermostats: await fetchThermostats(0),
  };
}));
