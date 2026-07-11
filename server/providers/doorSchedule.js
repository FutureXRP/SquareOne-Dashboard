import { Router } from "express";
import { config, guard } from "../config.js";
import { requireAuth, requireManager, logAudit, supabaseAdmin } from "../auth.js";
import { fetchReservations } from "./amilia.js";
import { haConfigured, haOps } from "../haService.js";
import { checkNewMembers } from "./memberAlerts.js";
import { gvDoorOp, gvDoorTree, GV_DOOR_OPS } from "./buildingClouds.js";

export const doorsRouter = Router();

/*
  Booking-driven door schedule (real GeoVision doors).

  Each Amilia reservation opens a window on its room's mapped door:
      unlockAt = start − DOOR_UNLOCK_LEAD_MIN (default 20)
      relockAt = end   + DOOR_RELOCK_LAG_MIN  (default 30)
  At unlockAt the door is FORCE_UNLOCKed (held open); at relockAt it's released
  back to its normal schedule. Overlapping bookings hold it open until the last
  one clears; the reconciler only acts on window EDGES, so staff can still lock
  or unlock a door mid-day without the cron fighting them.

  Room → door mapping is admin-managed (app_settings 'door_booking_map', values
  "ctrl:door") — see GET/PUT /api/doors/booking-map. Unmapped rooms do nothing.

  GET  /api/doors/schedule      (signed-in) — today's computed windows.
  GET  /api/doors/booking-map   (signed-in) — rooms + doors + current mapping.
  PUT  /api/doors/booking-map   (manager)   — save the mapping.
  POST /api/doors/run           (cron)      — the reconciler tick.
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
// Resolve a booked room to a GeoVision door via the map. Exact (normalised) name
// wins; otherwise a containment match. Returns { ctrl, door, name } or null.
function resolveDoor(room, map, gvDoors) {
  const r = norm(room);
  if (!r) return null;
  let val = null;
  for (const [k, v] of Object.entries(map)) if (norm(k) === r) { val = v; break; }
  if (!val) for (const [k, v] of Object.entries(map)) { const nk = norm(k); if (nk && (r.includes(nk) || nk.includes(r))) { val = v; break; } }
  if (!val) return null;
  const [ctrl, door] = String(val).split(":").map(Number);
  if (!Number.isFinite(ctrl) || !Number.isFinite(door)) return null;
  const gv = (gvDoors || []).find((d) => d.ctrl === ctrl && d.door === door);
  return { ctrl, door, name: gv?.name || `Door ${ctrl}:${door}` };
}

// Climate zone resolution stays name/env-based (Pro1 not wired — dry runs).
function zoneForRoom(room) {
  const r = norm(room);
  if (!r) return null;
  const map = config.climate.map, zones = config.homeassistant.entities.zones || {};
  for (const [loc, id] of Object.entries(map)) { const l = norm(loc); if ((r.includes(l) || l.includes(r)) && zones[id]) return id; }
  for (const [id, def] of Object.entries(zones)) { const d = norm(def.name); if (d && (r.includes(d) || d.includes(r))) return id; }
  return null;
}

// Reservations (yesterday..tomorrow) as plain spans.
async function fetchSpans() {
  const items = await fetchReservations(isoDay(-1), isoDay(1));
  return items
    .filter((r) => !r.IsCancelled && !r.AllDay && (r.Start || r.StartDate) && (r.End || r.EndDate))
    .map((r) => ({
      id: r.ReservationId ?? r.Id,
      start: new Date(r.Start || r.StartDate).getTime(),
      end: new Date(r.End || r.EndDate).getTime(),
      room: r.Location?.Name || r.LocationName || "",
      activity: r.Title || r.AdminBooking?.Name || "Reservation",
    }));
}

// Distinct bookable room names over the next month, for the mapping UI.
async function fetchRoomNames() {
  try {
    const items = await fetchReservations(isoDay(-1), isoDay(30));
    const names = new Set();
    for (const r of items) { const n = r.Location?.Name || r.LocationName; if (n) names.add(n); }
    return [...names].sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

// Door windows: unlock before start, relock after end.
function doorWindows(spans, map, gvDoors) {
  const lead = config.doors.leadMin * 60000, lag = config.doors.lagMin * 60000, now = Date.now();
  return spans
    .map((s) => {
      const d = resolveDoor(s.room, map, gvDoors);
      const unlockAt = s.start - lead, relockAt = s.end + lag;
      return {
        id: s.id, room: s.room, activity: s.activity,
        doorKey: d ? `${d.ctrl}:${d.door}` : null, ctrl: d?.ctrl, door: d?.door, doorName: d?.name || null,
        unlockAt, relockAt,
        status: now < unlockAt ? "scheduled" : now < relockAt ? "open" : "done",
      };
    })
    .sort((a, b) => a.unlockAt - b.unlockAt);
}

// Climate windows: event setpoint before start, idle setpoint after end.
function climateWindows(spans) {
  const pre = config.climate.preMin * 60000, post = config.climate.postMin * 60000, now = Date.now();
  return spans
    .map((s) => {
      const zoneId = zoneForRoom(s.room);
      const sp = (zoneId && config.climate.setpoints[zoneId]) || {};
      const preAt = s.start - pre, postAt = s.end + post;
      return {
        id: s.id, room: s.room, activity: s.activity,
        zoneId, zoneName: zoneId ? config.homeassistant.entities.zones[zoneId].name : null,
        eventTemp: Number(sp.event) || config.climate.eventTemp,
        idleTemp: Number(sp.idle) || config.climate.idleTemp,
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

// Today's windows for the Bookings/Automation UI.
doorsRouter.get(
  "/schedule",
  requireAuth,
  guard("amilia", async () => {
    const [spans, map, gvDoors] = await Promise.all([fetchSpans(), getBookingMap(), gvDoorTree().catch(() => [])]);
    return {
      leadMin: config.doors.leadMin,
      lagMin: config.doors.lagMin,
      geovisionLive: config.geovision.configured,
      windows: doorWindows(spans, map, gvDoors),
      climate: {
        preMin: config.climate.preMin, postMin: config.climate.postMin,
        eventTemp: config.climate.eventTemp, idleTemp: config.climate.idleTemp,
        windows: climateWindows(spans),
      },
    };
  })
);

// The room→door mapping surface: bookable rooms, real doors, current map.
doorsRouter.get(
  "/booking-map",
  requireAuth,
  guard("amilia", async () => {
    const [rooms, doors, map] = await Promise.all([fetchRoomNames(), gvDoorTree().catch(() => []), getBookingMap()]);
    return { rooms, doors: doors || [], map, leadMin: config.doors.leadMin, lagMin: config.doors.lagMin, geovisionLive: config.geovision.configured };
  })
);

// Save the mapping (managers/admins). Values must be "ctrl:door".
doorsRouter.put(
  "/booking-map",
  requireAuth,
  requireManager,
  guard("amilia", async (req) => {
    const incoming = req.body && typeof req.body.map === "object" ? req.body.map : {};
    const clean = {};
    for (const [room, val] of Object.entries(incoming)) {
      if (val && /^\d+:\d+$/.test(String(val))) clean[String(room)] = String(val);
    }
    await supabaseAdmin.from("app_settings").upsert(
      { key: "door_booking_map", value: clean, updated_at: new Date().toISOString() }, { onConflict: "key" });
    logAudit(req, "doors.booking-map", null, { rooms: Object.keys(clean).length });
    return { map: clean };
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

// The reconciler tick. Acts only on window edges that passed within the lookback
// period, so a delayed cron still catches them and manual overrides outside the
// edges are left alone. Doors → GeoVision; climate → Home Assistant (dry-run
// until Pro1/HA is wired).
doorsRouter.all(
  "/run",
  cronAuth,
  guard("amilia", async (req) => {
    const [spans, map, gvDoors] = await Promise.all([fetchSpans(), getBookingMap(), gvDoorTree().catch(() => [])]);
    const now = Date.now();
    const lookback = config.doors.lookbackMin * 60000;
    const actions = [];

    // Generic edge reconciler with overlap coverage — back-to-back/overlapping
    // bookings keep the "on" state until the LAST window clears.
    const reconcile = async (windows, key, onAt, offAt, applyOn, applyOff, label, live) => {
      const covered = (id) => windows.some((w) => w[key] === id && w[onAt] <= now && now < w[offAt]);
      const acted = new Set();
      for (const w of windows) {
        const id = w[key];
        if (!id || acted.has(id)) continue;
        const onEdge = now - lookback < w[onAt] && w[onAt] <= now && now < w[offAt];
        const offEdge = now - lookback < w[offAt] && w[offAt] <= now && !covered(id);
        if (!onEdge && !offEdge) continue;
        let executed = false, error = null;
        if (live) {
          try { await (onEdge ? applyOn(w) : applyOff(w)); executed = true; }
          catch (e) { error = e.message; }
        }
        const action = onEdge ? label.on : label.off;
        logAudit(req, action.audit, id, { room: w.room, activity: w.activity, executed, ...(action.detail?.(w) || {}) });
        acted.add(id);
        actions.push({ target: id, name: w.doorName || w.zoneName, action: action.name, room: w.room, activity: w.activity, executed, error, ...(action.detail?.(w) || {}) });
      }
    };

    await reconcile(
      doorWindows(spans, map, gvDoors), "doorKey", "unlockAt", "relockAt",
      (w) => gvForce(w.ctrl, w.door, "force-unlock"), (w) => gvForce(w.ctrl, w.door, "release"),
      { on: { name: "unlock", audit: "doors.auto-unlock" }, off: { name: "lock", audit: "doors.auto-lock" } },
      config.geovision.configured
    );
    await reconcile(
      climateWindows(spans), "zoneId", "preAt", "postAt",
      (w) => haOps.setTemp(w.zoneId, w.eventTemp), (w) => haOps.setTemp(w.zoneId, w.idleTemp),
      {
        on: { name: "set-event-temp", audit: "climate.auto-event", detail: (w) => ({ temp: w.eventTemp }) },
        off: { name: "set-idle-temp", audit: "climate.auto-idle", detail: (w) => ({ temp: w.idleTemp }) },
      },
      haConfigured()
    );

    // Same tick also watches for new members — never fails the tick.
    const memberAlerts = await checkNewMembers(req);

    return { at: new Date(now).toISOString(), geovisionLive: config.geovision.configured, spanCount: spans.length, actions, memberAlerts };
  })
);
