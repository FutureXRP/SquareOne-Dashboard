import { Router } from "express";
import { config } from "../config.js";
import { supabaseAdmin, logAudit } from "../auth.js";

export const elcRouter = Router();

/*
  Early Learning Center — manual daily attendance (no ProCare API).

  The classroom roster (names + capacity) is fixed below; each room runs 2
  teachers. Every morning staff enter how many children checked in per room.
  Counts are shared (everyone with access sees the same numbers) and keyed by
  date, so each day starts fresh and yesterday's numbers are preserved.

  Storage: elc_counts (service-role only). Falls back to an in-memory store when
  Supabase isn't configured (local/preview).
*/

// Fixed classroom roster. `id` is a stable key; `name` is what staff see.
export const ELC_ROOMS = [
  { id: "snapping-turtle", name: "Snapping Turtle", teachers: 2, capacity: 8 },
  { id: "scissortails",    name: "Scissortails",    teachers: 2, capacity: 12 },
  { id: "river-otters",    name: "River Otters",    teachers: 2, capacity: 12 },
  { id: "turtle-doves",    name: "Turtle Doves",    teachers: 2, capacity: 14 },
  { id: "prairie-dogs",    name: "Prairie Dogs",    teachers: 2, capacity: 16 },
  { id: "wood-ducks",      name: "Wood Ducks",      teachers: 2, capacity: 22 },
];

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
// "Today" in the org's timezone (server runs in UTC) — en-CA gives YYYY-MM-DD.
// Falls back to UTC if the configured timezone is somehow invalid.
const todayStr = () => {
  try { return new Date().toLocaleDateString("en-CA", { timeZone: config.timezone }); }
  catch { return new Date().toISOString().slice(0, 10); }
};

// In-memory fallback for local/preview (no Supabase). key `${date}:${room}`.
const memStore = new Map();

// GET /api/elc/today[?date=YYYY-MM-DD] — the roster merged with the day's counts.
// Never 500s: if the store can't be read (e.g. the elc_counts table hasn't been
// created yet), the roster still renders and the DB error is surfaced in dbError.
elcRouter.get("/today", async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : todayStr();
  const counts = new Map();
  let lastUpdated = null;
  let dbError = null;
  try {
    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin.from("elc_counts")
        .select("room, present, updated_at, updated_email").eq("date", date);
      if (error) throw error;
      (data || []).forEach((r) => { counts.set(r.room, r); if (!lastUpdated || r.updated_at > lastUpdated) lastUpdated = r.updated_at; });
    } else {
      for (const r of ELC_ROOMS) {
        const v = memStore.get(`${date}:${r.id}`);
        if (v) { counts.set(r.id, v); if (!lastUpdated || v.updated_at > lastUpdated) lastUpdated = v.updated_at; }
      }
    }
  } catch (e) { dbError = e.message; }
  const rooms = ELC_ROOMS.map((r) => ({
    id: r.id, name: r.name, teachers: r.teachers, capacity: r.capacity,
    present: counts.get(r.id)?.present ?? null,            // null = not entered yet
    updatedAt: counts.get(r.id)?.updated_at ?? null,
    updatedBy: counts.get(r.id)?.updated_email ?? null,
  }));
  const present = rooms.reduce((s, r) => s + (r.present || 0), 0);
  const capacity = rooms.reduce((s, r) => s + r.capacity, 0);
  const totals = {
    present, capacity,
    teachers: ELC_ROOMS.reduce((s, r) => s + r.teachers, 0),
    entered: rooms.filter((r) => r.present !== null).length,
    roomCount: ELC_ROOMS.length,
  };
  res.json({ ok: true, data: { date, rooms, totals, lastUpdated, dbError } });
});

// PUT /api/elc/counts { room, present, date? } — set (or clear) one room's count.
// present === null/"" clears the entry.
elcRouter.put("/counts", async (req, res) => {
  const b = req.body || {};
  const date = isDate(b.date) ? b.date : todayStr();
  const room = String(b.room || "");
  if (!ELC_ROOMS.some((r) => r.id === room)) return res.status(400).json({ ok: false, message: "Unknown room." });

  let present = b.present;
  if (present === "" || present === null || present === undefined) present = null;
  else {
    present = Number(present);
    if (!Number.isInteger(present) || present < 0 || present > 999)
      return res.status(400).json({ ok: false, message: "Enter a whole number (0–999)." });
  }

  const email = req.user?.email || null;
  const now = new Date().toISOString();
  try {
    if (supabaseAdmin) {
      if (present === null) {
        await supabaseAdmin.from("elc_counts").delete().eq("date", date).eq("room", room);
      } else {
        const { error } = await supabaseAdmin.from("elc_counts").upsert(
          { date, room, present, updated_by: req.user?.id || null, updated_email: email, updated_at: now },
          { onConflict: "date,room" });
        if (error) throw error;
      }
    } else {
      const key = `${date}:${room}`;
      if (present === null) memStore.delete(key);
      else memStore.set(key, { present, updated_at: now, updated_email: email });
    }
    logAudit(req, "elc.count", room, { date, present });
    res.json({ ok: true, data: { date, room, present, updatedAt: now, updatedBy: email } });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
