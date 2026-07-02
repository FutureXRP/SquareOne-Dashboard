import { Router } from "express";
import { config, guard } from "../config.js";
import { requireAuth, logAudit } from "../auth.js";
import { fetchReservations } from "./amilia.js";
import { haConfigured, haOps } from "../haService.js";

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

// Which dashboard door controls a booked room? Explicit DOOR_BOOKING_MAP wins;
// otherwise fuzzy-match the room name against the configured door names.
function doorForRoom(room) {
  const doors = config.homeassistant.entities.doors || {};
  const r = norm(room);
  if (!r) return null;
  for (const [loc, doorId] of Object.entries(config.doors.map)) {
    const l = norm(loc);
    if ((r.includes(l) || l.includes(r)) && doors[doorId]) return doorId;
  }
  for (const [id, def] of Object.entries(doors)) {
    const d = norm(def.name);
    if (d && (r.includes(d) || d.includes(r))) return id;
  }
  return null;
}

const isoDay = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// Reservations (yesterday..tomorrow, so windows spanning midnight are covered)
// -> unlock/relock windows. Cancelled and all-day entries produce no window.
async function computeWindows() {
  const items = await fetchReservations(isoDay(-1), isoDay(1));
  const lead = config.doors.leadMin * 60000;
  const lag = config.doors.lagMin * 60000;
  const now = Date.now();
  return items
    .filter((r) => !r.IsCancelled && !r.AllDay && (r.Start || r.StartDate) && (r.End || r.EndDate))
    .map((r) => {
      const start = new Date(r.Start || r.StartDate).getTime();
      const end = new Date(r.End || r.EndDate).getTime();
      const room = r.Location?.Name || r.LocationName || "";
      const doorId = doorForRoom(room);
      const unlockAt = start - lead;
      const relockAt = end + lag;
      return {
        id: r.ReservationId ?? r.Id,
        room,
        activity: r.Title || r.AdminBooking?.Name || "Reservation",
        doorId,
        doorName: doorId ? config.homeassistant.entities.doors[doorId].name : null,
        unlockAt,
        relockAt,
        status: now < unlockAt ? "scheduled" : now < relockAt ? "open" : "done",
      };
    })
    .sort((a, b) => a.unlockAt - b.unlockAt);
}

// Today's windows for the Bookings tab.
doorsRouter.get(
  "/schedule",
  requireAuth,
  guard("amilia", async () => {
    const windows = await computeWindows();
    return {
      leadMin: config.doors.leadMin,
      lagMin: config.doors.lagMin,
      hubLive: haConfigured(),
      windows,
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

// The reconciler tick. Acts only on unlock/relock edges that passed within the
// lookback period, so a delayed cron still catches them and manual overrides
// outside the edges are left alone.
doorsRouter.all(
  "/run",
  cronAuth,
  guard("amilia", async (req) => {
    const windows = (await computeWindows()).filter((w) => w.doorId);
    const now = Date.now();
    const lookback = config.doors.lookbackMin * 60000;
    const live = haConfigured();

    // A door should be open if ANY of its windows covers "now" — back-to-back
    // bookings must not relock the door between them.
    const openNow = (doorId) => windows.some((w) => w.doorId === doorId && w.unlockAt <= now && now < w.relockAt);

    const actions = [];
    const acted = new Set(); // one action per door per tick
    for (const w of windows) {
      if (acted.has(w.doorId)) continue;
      const unlockEdge = now - lookback < w.unlockAt && w.unlockAt <= now && now < w.relockAt;
      const relockEdge = now - lookback < w.relockAt && w.relockAt <= now && !openNow(w.doorId);
      if (!unlockEdge && !relockEdge) continue;
      const action = unlockEdge ? "unlock" : "lock";
      let executed = false, error = null;
      if (live) {
        try {
          await (action === "unlock" ? haOps.unlockDoor(w.doorId) : haOps.lockDoor(w.doorId));
          executed = true;
        } catch (e) { error = e.message; }
      }
      logAudit(req, `doors.auto-${action}`, w.doorId, { room: w.room, activity: w.activity, executed });
      acted.add(w.doorId);
      actions.push({ door: w.doorId, doorName: w.doorName, action, room: w.room, activity: w.activity, executed, error });
    }

    return { at: new Date(now).toISOString(), hubLive: live, windowCount: windows.length, actions };
  })
);
