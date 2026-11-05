import { Router } from "express";
import { config, guard } from "../config.js";
import { requireAuth, requireManager, logAudit, supabaseAdmin } from "../auth.js";
import { fetchBookingSpans, fetchFacilities } from "./interactive.js";
import { fetchThermostats, fetchOneTimes, createOneTime, updateOneTime, deleteOneTime, thermohubConfigured } from "./thermohub.js";
import { checkNewMembers } from "./memberAlerts.js";
import { gvDoorOp, gvDoorTree, GV_DOOR_OPS } from "./buildingClouds.js";
import { memberDoorSetting } from "./memberDoor.js";
import { getCachedToken, setCachedToken, listCachedTokens } from "../tokenStore.js";

export const doorsRouter = Router();

/*
  Booking-driven door schedule — SquareOne Interactive bookings → real GeoVision doors.

  Each confirmed, staff-approved booking opens a window on its room's mapped door.
  Interactive already carries per-booking setup/cleanup buffers (minutes outside
  the billed hours), and we add a lead/lag on top; the door honours whichever is
  earlier/later:
      unlockAt = min(start − DOOR_UNLOCK_LEAD_MIN, start − setup_min)
      relockAt = max(end   + DOOR_RELOCK_LAG_MIN,  end   + cleanup_min)
  Inside a window the door is FORCE_UNLOCKed (held open); outside it's released
  back to its normal schedule. Overlapping bookings hold it open until the last
  one clears. Doors are reconciled by STATE, not by edge: whatever tick lands
  inside a window makes sure the door is open, whatever tick lands outside makes
  sure it's released — but only when that differs from the last state THIS
  scheduler applied (remembered per door in the kv store). So a sparse or late
  cron still converges, and a door someone locked or unlocked by hand isn't
  re-fought every five minutes.

  Room → door mapping is admin-managed (app_settings 'door_booking_map', keyed
  by Interactive facility id like "gym" → "ctrl:door"). Unmapped rooms do nothing.
  The member "Unlock door" button uses a separate door: app_settings 'member_door'.

  Both subsystems sit behind master switches (app_settings 'automation':
  { doors, climate }, default OFF) set from the Automation tab. Off = the
  schedule is still computed and shown, but nothing touches a device, and
  anything already held is released.

  Climate goes through ThermoHub's ONE-TIME SCHEDULES (app_settings
  'climate_booking_map', facility id → ThermoHub thermostat id): every approved
  booking a week out becomes a tagged one-time entry at the event setpoints
  (CLIMATE_EVENT_HEAT/COOL), and ThermoHub's own timer holds the thermostat for
  it — so the room is conditioned on time even if no tick runs that day.
      start = booking start − CLIMATE_PRE_LEAD_MIN
      end   = booking end   + CLIMATE_POST_LAG_MIN
  See the climate section below for the sync rules.

  GET  /api/doors/schedule      (signed-in) — today's computed windows + last tick.
  GET  /api/doors/booking-map   (signed-in) — rooms + doors + thermostats + mappings.
  PUT  /api/doors/booking-map   (manager)   — save mappings / member door.
  POST /api/doors/run           (cron)      — the reconciler tick.
  POST /api/doors/heartbeat     (signed-in) — same tick, fired by open dashboards (gated ~90s).
*/

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const isoDay = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// --- Room → door mapping (admin-managed) --------------------------------------
async function getBookingMap() {
  if (!supabaseAdmin) return {};
  try {
    const { data } = await supabaseAdmin.from("app_settings").select("value").eq("key", "door_booking_map").maybeSingle();
    return data?.value && typeof data.value === "object" ? data.value : {};
  } catch { return {}; }
}
// Resolve a booking's room to a GeoVision door. Facility id (slug) is the key;
// a normalised room-name match is kept as a fallback for older entries.
function resolveDoor(span, map, gvDoors) {
  let val = map[span.facilityId];
  if (!val) {
    const r = norm(span.room);
    for (const [k, v] of Object.entries(map)) if (norm(k) === r) { val = v; break; }
  }
  if (!val) return null;
  const [ctrl, door] = String(val).split(":").map(Number);
  if (!Number.isFinite(ctrl) || !Number.isFinite(door)) return null;
  const gv = (gvDoors || []).find((d) => d.ctrl === ctrl && d.door === door);
  return { ctrl, door, name: gv?.name || `Door ${ctrl}:${door}` };
}

// --- Master switches (app_settings 'automation': { doors, climate }) ----------
// Both default OFF: nothing acts on a real device until a manager turns it on.
// Turning one off also releases whatever it's holding (see runTick).
async function getAutomation() {
  const def = { doors: false, climate: false };
  if (!supabaseAdmin) return def;
  try {
    const { data } = await supabaseAdmin.from("app_settings").select("value").eq("key", "automation").maybeSingle();
    const v = data?.value && typeof data.value === "object" ? data.value : {};
    return { doors: v.doors === true, climate: v.climate === true };
  } catch { return def; }
}

// --- Room → thermostat mapping (admin-managed, ThermoHub ids) ------------------
async function getClimateMap() {
  if (!supabaseAdmin) return {};
  try {
    const { data } = await supabaseAdmin.from("app_settings").select("value").eq("key", "climate_booking_map").maybeSingle();
    return data?.value && typeof data.value === "object" ? data.value : {};
  } catch { return {}; }
}
function resolveThermostat(span, cmap, thermostats) {
  let id = cmap[span.facilityId];
  if (!id) {
    const r = norm(span.room);
    for (const [k, v] of Object.entries(cmap)) if (norm(k) === r) { id = v; break; }
  }
  if (!id) return null;
  const t = (thermostats || []).find((x) => x.id === id);
  return { id, name: t?.name || `Thermostat ${id}`, online: t ? t.online : true };
}

// Confirmed, approved bookings yesterday..tomorrow (buffer-aware spans).
const fetchSpans = () => fetchBookingSpans(isoDay(-1), isoDay(1));

// Door windows: unlock before start, relock after end.
function doorWindows(spans, map, gvDoors) {
  const lead = config.doors.leadMin * 60000, lag = config.doors.lagMin * 60000, now = Date.now();
  return spans
    .map((s) => {
      const d = resolveDoor(s, map, gvDoors);
      const unlockAt = Math.min(s.start - lead, s.accessFrom);
      const relockAt = Math.max(s.end + lag, s.accessTo);
      return {
        id: s.id, code: s.code, room: s.room, facilityId: s.facilityId, activity: s.activity, who: s.who,
        doorKey: d ? `${d.ctrl}:${d.door}` : null, ctrl: d?.ctrl, door: d?.door, doorName: d?.name || null,
        unlockAt, relockAt,
        status: now < unlockAt ? "scheduled" : now < relockAt ? "open" : "done",
      };
    })
    .sort((a, b) => a.unlockAt - b.unlockAt);
}

// Climate windows: hold at the event setpoints before start, resume after end.
function climateWindows(spans, cmap, thermostats) {
  const pre = config.climate.preMin * 60000, post = config.climate.postMin * 60000, now = Date.now();
  return spans
    .map((s) => {
      const t = resolveThermostat(s, cmap, thermostats);
      const preAt = s.start - pre, postAt = s.end + post;
      return {
        id: s.id, code: s.code, room: s.room, facilityId: s.facilityId, activity: s.activity, who: s.who,
        thermostatId: t?.id || null, thermostatName: t?.name || null,
        heat: config.climate.eventHeat, cool: config.climate.eventCool,
        preAt, postAt,
        status: now < preAt ? "scheduled" : now < postAt ? "conditioning" : "done",
      };
    })
    .sort((a, b) => a.preAt - b.preAt);
}

// FORCE_UNLOCK / release one GeoVision door; throws if the panel rejects it.
async function gvForce(ctrl, door, opKey) {
  const r = await gvDoorOp(ctrl, door, GV_DOOR_OPS[opKey]);
  let p = null; try { p = JSON.parse(r.text); } catch { /* not json */ }
  if (!(p?.success === 1 || p?.success === true)) throw new Error(`GeoVision ${opKey} failed`);
}

// State-based door reconciliation (see header). Per mapped door: desired =
// open if any window covers `now`; act only when that differs from the last
// state we applied. State is recorded only after a real, successful command,
// so dry runs never fake it.
const DOOR_STATE = "door-state";
const STATE_TTL = 30 * 86400000;
// Exported for tests only.
export async function reconcileDoors(windows, live, req, actions, now, gvDoors) {
  // Every door a current window names, PLUS every door we still hold open —
  // a booking cancelled (or unmapped) mid-window no longer has a window, and
  // without this the door would stay held open until the next booking ended.
  const held = (await listCachedTokens(DOOR_STATE)).filter((s) => s.token === "open").map((s) => s.scope);
  const keys = [...new Set([...windows.map((w) => w.doorKey).filter(Boolean), ...held])];
  for (const key of keys) {
    const mine = windows.filter((w) => w.doorKey === key);
    const covering = mine.filter((w) => w.unlockAt <= now && now < w.relockAt);
    const wantOpen = covering.length > 0;
    const last = (await getCachedToken(DOOR_STATE, key))?.token || "closed";
    if (wantOpen === (last === "open")) continue;
    // Attribute the action to the booking that drives it: the current window
    // when opening, the most recently ended one when releasing. A held door
    // with no window at all (cancelled booking) is released on its own.
    const w = covering[0] || mine.filter((x) => x.relockAt <= now).sort((a, b) => b.relockAt - a.relockAt)[0] || mine[0] || (() => {
      const [ctrl, door] = key.split(":").map(Number);
      const gv = (gvDoors || []).find((d) => d.ctrl === ctrl && d.door === door);
      return { id: null, ctrl, door, doorName: gv?.name || `Door ${key}`, room: "", activity: "booking cancelled or unmapped" };
    })();
    let executed = false, error = null;
    if (live) {
      try { await gvForce(w.ctrl, w.door, wantOpen ? "force-unlock" : "release"); executed = true; }
      catch (e) { error = e.message; }
      if (executed) await setCachedToken(DOOR_STATE, key, wantOpen ? "open" : "closed", {}, now + STATE_TTL);
    }
    logAudit(req, wantOpen ? "doors.auto-unlock" : "doors.auto-lock", w.id, { room: w.room, activity: w.activity, door: w.doorName, executed, ...(error ? { error } : {}) });
    actions.push({ target: key, name: w.doorName, action: wantOpen ? "unlock" : "lock", room: w.room, activity: w.activity, executed, error });
  }
}

/*
  Climate: keep ThermoHub's ONE-TIME SCHEDULES in step with the bookings.

  Rather than placing holds ourselves at the right minute (which needs our tick
  to be awake at the right minute), we push each upcoming booking into ThermoHub
  as a one-time schedule and let ITS timer start and end the hold. The sync only
  has to happen sometime before the event, so it tolerates hours without a tick.

  ThermoHub has no external-reference field, so every entry we create carries a
  tag in its name — "… (SO#<booking code>)" — and we only ever touch entries
  carrying that tag. Overlapping bookings on one thermostat become ONE merged
  entry (tag "SO#a+b"), since ThermoHub's holds would otherwise clobber each
  other's end times. Entries whose bookings are gone (cancelled, re-opened for
  review, unmapped) are deleted; moved bookings are updated in place.
*/
const TAG_RE = /\(SO#([^)]+)\)\s*$/;
const tagOf = (name) => (String(name || "").match(TAG_RE) || [])[1] || null;

// Merge each thermostat's windows into non-overlapping one-time entries.
// Exported for tests only.
export function climatePlan(windows) {
  const byT = new Map();
  for (const w of windows) if (w.thermostatId) (byT.get(w.thermostatId) || byT.set(w.thermostatId, []).get(w.thermostatId)).push(w);
  const desired = [];
  for (const [thermostatId, list] of byT) {
    list.sort((a, b) => a.preAt - b.preAt);
    let cur = null;
    for (const w of list) {
      if (cur && w.preAt <= cur.end) { cur.end = Math.max(cur.end, w.postAt); cur.windows.push(w); }
      else { cur = { thermostatId, thermostatName: w.thermostatName, start: w.preAt, end: w.postAt, heat: w.heat, cool: w.cool, windows: [w] }; desired.push(cur); }
    }
  }
  for (const d of desired) {
    d.key = d.windows.map((w) => w.code || String(w.id).slice(0, 8)).join("+");
    const label = d.windows.length === 1 ? `${d.windows[0].room} · ${d.windows[0].activity}` : `${d.windows[0].room} · ${d.windows.length} bookings`;
    d.name = `${label} (SO#${d.key})`.slice(0, 120);
  }
  return desired;
}

// Make ThermoHub's tagged one-time entries match `desired`. Exported for tests.
export async function syncOneTimes(desired, existing, live, req, actions, now, thermostats, ops = { createOneTime, updateOneTime, deleteOneTime }) {
  const mine = (existing || []).filter((o) => tagOf(o.name));
  const byKey = new Map(mine.map((o) => [tagOf(o.name), o]));
  const nameOf = (id) => (thermostats || []).find((t) => t.id === id)?.name || `Thermostat ${id}`;
  const bizOf = (id) => (thermostats || []).find((t) => t.id === id)?.businessId || mine[0]?.businessId || null;
  const run = async (action, target, fn, detail) => {
    let executed = false, error = null;
    if (live) { try { await fn(); executed = true; } catch (e) { error = e.message; } }
    logAudit(req, `climate.onetime-${action}`, target.key || null, { thermostat: target.thermostatName, executed, ...detail, ...(error ? { error } : {}) });
    actions.push({ target: target.thermostatId, name: target.thermostatName, action: `onetime-${action}`, room: target.room || "", activity: target.activity || "", executed, error, ...detail });
  };
  const seen = new Set();
  for (const d of desired) {
    if (d.end <= now) continue;                       // already over — ThermoHub drops ended entries itself
    seen.add(d.key);
    const body = { businessId: bizOf(d.thermostatId), name: d.name, buildingIds: [], thermostatIds: [d.thermostatId], start: d.start, end: d.end, heat: d.heat, cool: d.cool };
    const detail = { start: new Date(d.start).toISOString(), end: new Date(d.end).toISOString(), heat: d.heat, cool: d.cool };
    const tgt = { ...d, room: d.windows[0].room, activity: d.windows[0].activity };
    const o = byKey.get(d.key);
    if (!o) { await run("create", tgt, () => ops.createOneTime(body), detail); continue; }
    const same = Number(o.start) === d.start && Number(o.end) === d.end && Number(o.heat) === d.heat && Number(o.cool) === d.cool
      && (o.thermostatIds || []).length === 1 && o.thermostatIds[0] === d.thermostatId && !(o.buildingIds || []).length;
    if (!same) await run("update", tgt, () => ops.updateOneTime(o.id, body), detail);
  }
  for (const o of mine) {
    const key = tagOf(o.name);
    if (seen.has(key)) continue;
    const thermostatId = (o.thermostatIds || [])[0] || null;
    await run("delete", { key, thermostatId, thermostatName: nameOf(thermostatId), activity: "booking cancelled, moved or unmapped" }, () => ops.deleteOneTime(o.id), { name: o.name });
  }
}

// Bookings for the climate sync look a week ahead (entries must exist before
// the event); doors stay on yesterday..tomorrow since they're reconciled live.
const fetchClimateSpans = () => fetchBookingSpans(isoDay(-1), isoDay(7));
const loadAll = () => Promise.all([
  fetchSpans(), getBookingMap(), gvDoorTree().catch(() => []),
  getClimateMap(), thermohubConfigured() ? fetchThermostats().catch(() => []) : Promise.resolve([]),
  getAutomation(), fetchClimateSpans().catch(() => []),
  thermohubConfigured() ? fetchOneTimes().catch(() => []) : Promise.resolve([]),
]);

// Today's windows for the Bookings/Automation UI.
doorsRouter.get(
  "/schedule",
  requireAuth,
  guard("interactive", async () => {
    const [spans, map, gvDoors, cmap, thermostats, automation, climateSpans, oneTimes] = await loadAll();
    // Flag each climate window with whether its ThermoHub one-time entry exists yet.
    const cw = climateWindows(climateSpans, cmap, thermostats);
    const tagged = new Set((oneTimes || []).map((o) => tagOf(o.name)).filter(Boolean));
    const planned = climatePlan(cw);
    for (const w of cw) {
      const entry = planned.find((p) => p.windows.includes(w));
      w.synced = Boolean(entry && tagged.has(entry.key));
    }
    return {
      leadMin: config.doors.leadMin,
      lagMin: config.doors.lagMin,
      geovisionLive: config.geovision.configured,
      thermohubLive: thermohubConfigured(),
      automation,
      cronConfigured: Boolean(config.doors.cronSecret),
      lastTick: await lastTick(),
      windows: doorWindows(spans, map, gvDoors),
      climate: {
        preMin: config.climate.preMin, postMin: config.climate.postMin,
        heat: config.climate.eventHeat, cool: config.climate.eventCool,
        windows: cw,
      },
    };
  })
);

// The mapping surface: Interactive rooms, real doors, current map, member door.
doorsRouter.get(
  "/booking-map",
  requireAuth,
  guard("interactive", async () => {
    const [rooms, doors, map, memberDoor, climateMap, thermostats, automation] = await Promise.all([
      fetchFacilities(true), gvDoorTree().catch(() => []), getBookingMap(), memberDoorSetting(),
      getClimateMap(), thermohubConfigured() ? fetchThermostats().catch(() => []) : Promise.resolve([]),
      getAutomation(),
    ]);
    return {
      // Inactive rooms are included (flagged) so they can be pre-mapped; the
      // scheduler itself only ever sees bookings, which only active rooms take.
      rooms: rooms.map((r) => ({ id: r.id, name: r.name, color: r.color, active: r.active, setupMin: r.setupMin, cleanupMin: r.cleanupMin })),
      doors: doors || [], map, memberDoor,
      thermostats: (thermostats || []).map((t) => ({ id: t.id, name: t.name, building: t.building, online: t.online })),
      climateMap, automation,
      leadMin: config.doors.leadMin, lagMin: config.doors.lagMin, geovisionLive: config.geovision.configured,
      climatePreMin: config.climate.preMin, climatePostMin: config.climate.postMin,
      climateHeat: config.climate.eventHeat, climateCool: config.climate.eventCool, thermohubLive: thermohubConfigured(),
    };
  })
);

// Save the mapping and/or the member door (managers/admins). Values "ctrl:door".
doorsRouter.put(
  "/booking-map",
  requireAuth,
  requireManager,
  guard("interactive", async (req) => {
    const stamp = new Date().toISOString();
    const out = {};
    if (req.body && typeof req.body.map === "object") {
      const clean = {};
      for (const [room, val] of Object.entries(req.body.map)) {
        if (val && /^\d+:\d+$/.test(String(val))) clean[String(room)] = String(val);
      }
      await supabaseAdmin.from("app_settings").upsert({ key: "door_booking_map", value: clean, updated_at: stamp }, { onConflict: "key" });
      logAudit(req, "doors.booking-map", null, { rooms: Object.keys(clean).length });
      out.map = clean;
    }
    if (req.body && "memberDoor" in req.body) {
      const v = String(req.body.memberDoor || "");
      const door = /^\d+:\d+$/.test(v) ? v : "";
      await supabaseAdmin.from("app_settings").upsert({ key: "member_door", value: { door }, updated_at: stamp }, { onConflict: "key" });
      logAudit(req, "doors.member-door", door || null, {});
      out.memberDoor = door;
    }
    if (req.body && typeof req.body.climateMap === "object") {
      const clean = {};
      for (const [room, val] of Object.entries(req.body.climateMap)) {
        if (val && /^[\w.-]{1,64}$/.test(String(val))) clean[String(room)] = String(val);
      }
      await supabaseAdmin.from("app_settings").upsert({ key: "climate_booking_map", value: clean, updated_at: stamp }, { onConflict: "key" });
      logAudit(req, "climate.booking-map", null, { rooms: Object.keys(clean).length });
      out.climateMap = clean;
    }
    if (req.body && typeof req.body.automation === "object") {
      const cur = await getAutomation();
      const next = {
        doors: "doors" in req.body.automation ? req.body.automation.doors === true : cur.doors,
        climate: "climate" in req.body.automation ? req.body.automation.climate === true : cur.climate,
      };
      await supabaseAdmin.from("app_settings").upsert({ key: "automation", value: next, updated_at: stamp }, { onConflict: "key" });
      logAudit(req, "automation.switch", null, next);
      out.automation = next;
      // Pausing releases anything the schedule is holding right away, rather
      // than leaving a door open / a hold in place until the next tick.
      if ((cur.doors && !next.doors) || (cur.climate && !next.climate)) {
        try { out.released = (await runTick(req, "switch")).actions; } catch { /* next tick will catch it */ }
      }
    }
    return out;
  })
);

// Scheduler auth: the tick is hit by a cron, not a signed-in user.
function cronAuth(req, res, next) {
  const secret = config.doors.cronSecret;
  if (!secret) return res.status(503).json({ ok: false, message: "CRON_SECRET is not set — add it in Vercel env vars." });
  const sent = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.query.key;
  if (sent !== secret) return res.status(401).json({ ok: false, message: "Bad or missing cron secret." });
  next();
}

// The reconciler tick. Doors → GeoVision; climate → ThermoHub. Both are
// state-based (see headers), so a sparse or late tick still converges.
// `source` records who fired it ('cron' | 'dashboard') for the status line.
const TICK_KEY = "door-tick", TICK_GATE_TTL = 150_000; // kv skew 60s → ~90s between dashboard ticks
async function runTick(req, source) {
  const [spans, map, gvDoors, cmap, thermostats, automation, climateSpans, oneTimes] = await loadAll();
  const now = Date.now();
  const actions = [];

  // A switched-off subsystem is reconciled against NO windows: nothing new is
  // opened/held, and anything we still hold from before is released — for
  // climate, that means our tagged one-time entries are deleted from ThermoHub.
  await reconcileDoors(automation.doors ? doorWindows(spans, map, gvDoors) : [], config.geovision.configured, req, actions, now, gvDoors);
  const desired = automation.climate ? climatePlan(climateWindows(climateSpans, cmap, thermostats)) : [];
  await syncOneTimes(desired, oneTimes, thermohubConfigured(), req, actions, now, thermostats);

  // Same tick also watches for new members — never fails the tick.
  const memberAlerts = await checkNewMembers(req);

  const result = {
    at: new Date(now).toISOString(), source, automation, geovisionLive: config.geovision.configured, thermohubLive: thermohubConfigured(),
    spanCount: spans.length, actions, memberAlerts,
  };
  await setCachedToken(TICK_KEY, "last", source, { at: result.at, actions: actions.length, errors: actions.filter((a) => a.error).length }, now + STATE_TTL).catch(() => {});
  return result;
}
// When the scheduler last actually ran (for the Automation status line).
async function lastTick() {
  const t = await getCachedToken(TICK_KEY, "last").catch(() => null);
  return t ? { at: t.meta?.at || null, source: t.token, actions: t.meta?.actions ?? 0, errors: t.meta?.errors ?? 0 } : null;
}

doorsRouter.all("/run", cronAuth, guard("interactive", (req) => runTick(req, "cron")));

// Dashboard heartbeat: any open dashboard tab calls this every couple of
// minutes, so the schedule runs even when no external cron is reaching us
// (GitHub's schedule has proven to fire hours apart). Gated in the kv so N
// tabs still mean one tick per ~90s. Signed-in users only; they can't pass
// parameters, so there's nothing to abuse beyond "run the schedule now".
doorsRouter.post("/heartbeat", requireAuth, guard("interactive", async (req) => {
  const gate = await getCachedToken(TICK_KEY, "gate");
  if (gate) return { ran: false, lastTick: await lastTick() };
  await setCachedToken(TICK_KEY, "gate", "1", {}, Date.now() + TICK_GATE_TTL);
  const r = await runTick(req, "dashboard");
  return { ran: true, lastTick: { at: r.at, source: "dashboard", actions: r.actions.length, errors: r.actions.filter((a) => a.error).length }, actions: r.actions };
}));
