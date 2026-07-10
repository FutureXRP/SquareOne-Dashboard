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
// `rates` are the monthly reimbursement per child by funding source (Private /
// DHS / Tribal). Revenue = enrolled count x that monthly rate.
export const ELC_ROOMS = [
  { id: "snapping-turtle", name: "Snapping Turtles", teachers: 2, capacity: 8,  rates: { private: 1125.00, dhs: 1100.55, tribal: 1218.00 } },
  { id: "scissortails",    name: "ScissorTails",     teachers: 2, capacity: 12, rates: { private: 1025.00, dhs: 1046.18, tribal: 1152.75 } },
  { id: "river-otters",    name: "River Otters",     teachers: 2, capacity: 12, rates: { private: 1000.00, dhs: 1046.18, tribal: 1152.75 } },
  { id: "turtle-doves",    name: "Turtle Doves",     teachers: 2, capacity: 14, rates: { private: 965.00,  dhs: 898.28,  tribal: 1065.75 } },
  { id: "prairie-dogs",    name: "Prairie Dogs",     teachers: 2, capacity: 16, rates: { private: 915.00,  dhs: 898.28,  tribal: 1065.75 } },
  { id: "wood-ducks",      name: "Wood Ducks",       teachers: 2, capacity: 20, rates: { private: 810.00,  dhs: 630.75,  tribal: 804.75 } },
];

// Funding sources tracked per room, and the average working days per month used
// to convert monthly reimbursement to a projected daily figure.
const FUND_TYPES = ["private", "dhs", "tribal"];
const WORKING_DAYS = 21.75;

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
// "Today" in the org's timezone (server runs in UTC) — en-CA gives YYYY-MM-DD.
// Falls back to UTC if the configured timezone is somehow invalid.
const todayStr = () => {
  try { return new Date().toLocaleDateString("en-CA", { timeZone: config.timezone }); }
  catch { return new Date().toISOString().slice(0, 10); }
};

// In-memory fallback for local/preview (no Supabase). key `${date}:${room}`.
const memStore = new Map();

// Revenue for one room from its per-funding-source counts. Rates are monthly per
// child; daily = monthly / WORKING_DAYS.
const roomRevenue = (room, c) => {
  const monthly = FUND_TYPES.reduce((s, t) => s + (c[t] || 0) * (room.rates[t] || 0), 0);
  return { monthly, daily: monthly / WORKING_DAYS };
};

// GET /api/elc/today[?date=YYYY-MM-DD] — roster + the day's counts by funding
// source + projected revenue. Never 500s: if the store can't be read (e.g. the
// table/columns aren't there yet), the roster still renders with dbError set.
elcRouter.get("/today", async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : todayStr();
  const counts = new Map();
  let lastUpdated = null;
  let dbError = null;
  try {
    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin.from("elc_counts")
        .select("room, private, dhs, tribal, present, updated_at, updated_email").eq("date", date);
      if (error) throw error;
      (data || []).forEach((r) => { counts.set(r.room, r); if (!lastUpdated || r.updated_at > lastUpdated) lastUpdated = r.updated_at; });
    } else {
      for (const r of ELC_ROOMS) {
        const v = memStore.get(`${date}:${r.id}`);
        if (v) { counts.set(r.id, v); if (!lastUpdated || v.updated_at > lastUpdated) lastUpdated = v.updated_at; }
      }
    }
  } catch (e) { dbError = e.message; }

  const rooms = ELC_ROOMS.map((r) => {
    const row = counts.get(r.id);
    const c = { private: row?.private || 0, dhs: row?.dhs || 0, tribal: row?.tribal || 0 };
    const entered = Boolean(row);
    const { monthly, daily } = roomRevenue(r, c);
    return {
      id: r.id, name: r.name, teachers: r.teachers, capacity: r.capacity, rates: r.rates,
      private: entered ? c.private : null, dhs: entered ? c.dhs : null, tribal: entered ? c.tribal : null,
      present: entered ? c.private + c.dhs + c.tribal : null,
      monthly, daily,
      updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_email ?? null,
    };
  });
  const sum = (f) => rooms.reduce((s, r) => s + (f(r) || 0), 0);
  const totals = {
    present: sum((r) => r.present),
    private: sum((r) => r.private), dhs: sum((r) => r.dhs), tribal: sum((r) => r.tribal),
    capacity: ELC_ROOMS.reduce((s, r) => s + r.capacity, 0),
    teachers: ELC_ROOMS.reduce((s, r) => s + r.teachers, 0),
    monthlyRevenue: sum((r) => r.monthly),
    dailyRevenue: sum((r) => r.daily),
    entered: rooms.filter((r) => r.present !== null).length,
    roomCount: ELC_ROOMS.length,
    workingDays: WORKING_DAYS,
  };
  res.json({ ok: true, data: { date, rooms, totals, lastUpdated, dbError } });
});

// PUT /api/elc/counts { room, private?, dhs?, tribal?, date? } — set one or more
// funding-source counts for a room. Merges with the existing row; a row with all
// three at zero is removed (treated as "not entered").
elcRouter.put("/counts", async (req, res) => {
  const b = req.body || {};
  const date = isDate(b.date) ? b.date : todayStr();
  const room = String(b.room || "");
  if (!ELC_ROOMS.some((r) => r.id === room)) return res.status(400).json({ ok: false, message: "Unknown room." });

  const email = req.user?.email || null;
  const now = new Date().toISOString();
  const key = `${date}:${room}`;
  try {
    // Start from what's stored, then apply only the provided fields.
    let cur = { private: 0, dhs: 0, tribal: 0 };
    if (supabaseAdmin) {
      const { data } = await supabaseAdmin.from("elc_counts").select("private, dhs, tribal").eq("date", date).eq("room", room).maybeSingle();
      if (data) cur = { private: data.private || 0, dhs: data.dhs || 0, tribal: data.tribal || 0 };
    } else if (memStore.has(key)) {
      const v = memStore.get(key); cur = { private: v.private || 0, dhs: v.dhs || 0, tribal: v.tribal || 0 };
    }
    for (const t of FUND_TYPES) {
      if (b[t] === undefined) continue;
      let n = b[t];
      if (n === "" || n === null) n = 0;
      n = Number(n);
      if (!Number.isInteger(n) || n < 0 || n > 999) return res.status(400).json({ ok: false, message: "Enter a whole number (0–999)." });
      cur[t] = n;
    }
    const present = cur.private + cur.dhs + cur.tribal;
    const empty = present === 0;
    if (supabaseAdmin) {
      if (empty) {
        await supabaseAdmin.from("elc_counts").delete().eq("date", date).eq("room", room);
      } else {
        const { error } = await supabaseAdmin.from("elc_counts").upsert(
          { date, room, ...cur, present, updated_by: req.user?.id || null, updated_email: email, updated_at: now },
          { onConflict: "date,room" });
        if (error) throw error;
      }
    } else {
      if (empty) memStore.delete(key);
      else memStore.set(key, { ...cur, present, updated_at: now, updated_email: email });
    }
    logAudit(req, "elc.count", room, { date, ...cur });
    res.json({ ok: true, data: { date, room, ...cur, present, updatedAt: now, updatedBy: email } });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
