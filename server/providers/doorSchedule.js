import { Router } from "express";
import { config, guard } from "../config.js";
import { requireAuth, requireManager, logAudit, supabaseAdmin } from "../auth.js";
import { fetchBookingSpans, fetchFacilities } from "./interactive.js";
import { haConfigured, haOps } from "../haService.js";
import { checkNewMembers } from "./memberAlerts.js";
import { gvDoorOp, gvDoorTree, GV_DOOR_OPS } from "./buildingClouds.js";
import { memberDoorSetting } from "./memberDoor.js";
import { getCachedToken, setCachedToken } from "../tokenStore.js";

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

  GET  /api/doors/schedule      (signed-in) — today's computed windows.
  GET  /api/doors/booking-map   (signed-in) — rooms + doors + mapping + member door.
  PUT  /api/doors/booking-map   (manager)   — save mapping / member door.
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

// Climate zone resolution stays name/env-based (HVAC deferred — dry runs).
function zoneForRoom(room) {
  const r = norm(room);
  if (!r) return null;
  const map = config.climate.map, zones = config.homeassistant.entities.zones || {};
  for (const [loc, id] of Object.entries(map)) { const l = norm(loc); if ((r.includes(l) || l.includes(r)) && zones[id]) return id; }
  for (const [id, def] of Object.entries(zones)) { const d = norm(def.name); if (d && (r.includes(d) || d.includes(r))) return id; }
  return null;
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

// State-based door reconciliation (see header). Per mapped door: desired =
// open if any window covers `now`; act only when that differs from the last
// state we applied. State is recorded only after a real, successful command,
// so dry runs never fake it.
const DOOR_STATE = "door-state";
const STATE_TTL = 30 * 86400000;
async function reconcileDoors(windows, live, req, actions, now) {
  const keys = [...new Set(windows.map((w) => w.doorKey).filter(Boolean))];
  for (const key of keys) {
    const mine = windows.filter((w) => w.doorKey === key);
    const covering = mine.filter((w) => w.unlockAt <= now && now < w.relockAt);
    const wantOpen = covering.length > 0;
    const last = (await getCachedToken(DOOR_STATE, key))?.token || "closed";
    if (wantOpen === (last === "open")) continue;
    // Attribute the action to the booking that drives it: the current window
    // when opening, the most recently ended one when releasing.
    const w = covering[0] || mine.filter((x) => x.relockAt <= now).sort((a, b) => b.relockAt - a.relockAt)[0] || mine[0];
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

const loadAll = () => Promise.all([fetchSpans(), getBookingMap(), gvDoorTree().catch(() => [])]);

// Today's windows for the Bookings/Automation UI.
doorsRouter.get(
  "/schedule",
  requireAuth,
  guard("interactive", async () => {
    const [spans, map, gvDoors] = await loadAll();
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

// The mapping surface: Interactive rooms, real doors, current map, member door.
doorsRouter.get(
  "/booking-map",
  requireAuth,
  guard("interactive", async () => {
    const [rooms, doors, map, memberDoor] = await Promise.all([
      fetchFacilities(true), gvDoorTree().catch(() => []), getBookingMap(), memberDoorSetting(),
    ]);
    return {
      // Inactive rooms are included (flagged) so they can be pre-mapped; the
      // scheduler itself only ever sees bookings, which only active rooms take.
      rooms: rooms.map((r) => ({ id: r.id, name: r.name, color: r.color, active: r.active, setupMin: r.setupMin, cleanupMin: r.cleanupMin })),
      doors: doors || [], map, memberDoor,
      leadMin: config.doors.leadMin, lagMin: config.doors.lagMin, geovisionLive: config.geovision.configured,
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

// The reconciler tick. Acts only on window edges that passed within the lookback
// period, so a delayed cron still catches them and manual overrides outside the
// edges are left alone. Doors → GeoVision; climate → Home Assistant (dry-run
// until thermostats are installed).
doorsRouter.all(
  "/run",
  cronAuth,
  guard("interactive", async (req) => {
    const [spans, map, gvDoors] = await loadAll();
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

    await reconcileDoors(doorWindows(spans, map, gvDoors), config.geovision.configured, req, actions, now);
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
