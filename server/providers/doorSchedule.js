import { Router } from "express";
import { config, guard } from "../config.js";
import { requireAuth, logAudit } from "../auth.js";
import { fetchReservations } from "./amilia.js";
import { haConfigured, haOps } from "../haService.js";
import { checkNewMembers } from "./memberAlerts.js";

export const doorsRouter = Router();

/*
  Booking-driven door schedule.

  Most bookable rooms are behind access-controlled doors. Each Amilia
  reservation produces an "open window" on its room's door:

      unlockAt = reservation start − DOOR_UNLOCK_LEAD_MIN (default 20)
      relockAt = reservation end   + DOOR_RELOCK_LAG_MIN  (default 30)

  GET  /api/doors/schedule   (signed-in) — today's computed windows for the UI.
  POST /api/doors/run        (cron, Bearer CRON_SECRET) — the reconciler tick:
       finds windows whose unlock/relock moment passed within the lookback
       period and issues the HA lock/unlock. Idempotent — re-locking a locked
       door is harmless — and it only acts on window EDGES, so staff can still
       manually unlock a door mid-day without the cron fighting them.

  The tick runs even before Home Assistant is wired: actions come back with
  executed:false (dry run) so the whole pipeline is testable today.
*/

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Which dashboard door/zone serves a booked room? The explicit env map wins;
// otherwise fuzzy-match the room name against the configured entity names.
function targetForRoom(room, map, entities) {
  const r = norm(room);
  if (!r) return null;
  for (const [loc, id] of Object.entries(map)) {
    const l = norm(loc);
    if ((r.includes(l) || l.includes(r)) && entities[id]) return id;
  }
  for (const [id, def] of Object.entries(entities)) {
    const d = norm(def.name);
    if (d && (r.includes(d) || d.includes(r))) return id;
  }
  return null;
}
const doorForRoom = (room) => targetForRoom(room, config.doors.map, config.homeassistant.entities.doors || {});
const zoneForRoom = (room) => targetForRoom(room, config.climate.map, config.homeassistant.entities.zones || {});

const isoDay = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// Reservations (yesterday..tomorrow, so windows spanning midnight are covered)
// as plain spans. Cancelled and all-day entries produce nothing.
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

// Door windows: unlock before start, relock after end.
function doorWindows(spans) {
  const lead = config.doors.leadMin * 60000;
  const lag = config.doors.lagMin * 60000;
  const now = Date.now();
  return spans
    .map((s) => {
      const doorId = doorForRoom(s.room);
      const unlockAt = s.start - lead;
      const relockAt = s.end + lag;
      return {
        id: s.id, room: s.room, activity: s.activity,
        doorId, doorName: doorId ? config.homeassistant.entities.doors[doorId].name : null,
        unlockAt, relockAt,
        status: now < unlockAt ? "scheduled" : now < relockAt ? "open" : "done",
      };
    })
    .sort((a, b) => a.unlockAt - b.unlockAt);
}

// Climate windows: event setpoint before start, idle setpoint after end.
function climateWindows(spans) {
  const pre = config.climate.preMin * 60000;
  const post = config.climate.postMin * 60000;
  const now = Date.now();
  return spans
    .map((s) => {
      const zoneId = zoneForRoom(s.room);
      const sp = (zoneId && config.climate.setpoints[zoneId]) || {};
      const preAt = s.start - pre;
      const postAt = s.end + post;
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

// Today's windows for the Bookings tab.
doorsRouter.get(
  "/schedule",
  requireAuth,
  guard("amilia", async () => {
    const spans = await fetchSpans();
    return {
      leadMin: config.doors.leadMin,
      lagMin: config.doors.lagMin,
      hubLive: haConfigured(),
      windows: doorWindows(spans),
      climate: {
        preMin: config.climate.preMin,
        postMin: config.climate.postMin,
        eventTemp: config.climate.eventTemp,
        idleTemp: config.climate.idleTemp,
        windows: climateWindows(spans),
      },
    };
  })
);

// Scheduler auth: the tick endpoint is hit by a cron, not a signed-in user.
function cronAuth(req, res, next) {
  const secret = config.doors.cronSecret;
  if (!secret) {
    return res.status(503).json({ ok: false, message: "CRON_SECRET is not set — add it in Vercel env vars." });
  }
  const sent = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.query.key;
  if (sent !== secret) return res.status(401).json({ ok: false, message: "Bad or missing cron secret." });
  next();
}

// The reconciler tick. Acts only on window edges that passed within the
// lookback period, so a delayed cron still catches them and manual overrides
// outside the edges are left alone. Handles both doors and climate.
doorsRouter.all(
  "/run",
  cronAuth,
  guard("amilia", async (req) => {
    const spans = await fetchSpans();
    const now = Date.now();
    const lookback = config.doors.lookbackMin * 60000;
    const live = haConfigured();
    const actions = [];

    // Generic edge reconciler: onAt..offAt windows per target, with overlap
    // coverage — back-to-back/overlapping bookings keep the "on" state until
    // the LAST window clears.
    const reconcile = async (windows, key, onAt, offAt, applyOn, applyOff, label) => {
      const covered = (id) => windows.some((w) => w[key] === id && w[onAt] <= now && now < w[offAt]);
      const acted = new Set(); // one action per target per tick
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
      doorWindows(spans), "doorId", "unlockAt", "relockAt",
      (w) => haOps.unlockDoor(w.doorId), (w) => haOps.lockDoor(w.doorId),
      { on: { name: "unlock", audit: "doors.auto-unlock" }, off: { name: "lock", audit: "doors.auto-lock" } }
    );
    await reconcile(
      climateWindows(spans), "zoneId", "preAt", "postAt",
      (w) => haOps.setTemp(w.zoneId, w.eventTemp), (w) => haOps.setTemp(w.zoneId, w.idleTemp),
      {
        on: { name: "set-event-temp", audit: "climate.auto-event", detail: (w) => ({ temp: w.eventTemp }) },
        off: { name: "set-idle-temp", audit: "climate.auto-idle", detail: (w) => ({ temp: w.idleTemp }) },
      }
    );

    // Same tick also watches for new members (SMS alert) — never fails the tick.
    const memberAlerts = await checkNewMembers(req);

    return { at: new Date(now).toISOString(), hubLive: live, spanCount: spans.length, actions, memberAlerts };
  })
);
