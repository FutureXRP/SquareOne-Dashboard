import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { config, guard } from "../config.js";
import { requireAdmin } from "../auth.js";

export const interactiveRouter = Router();

/*
  SquareOne Interactive — the in-house platform that replaced Amilia for
  fitness memberships and ALL room bookings (github.com/FutureXRP/SquareOne-Interactive).

  We read its Supabase tables directly with a service-role client (bypasses
  RLS), exactly how that repo's build.md says the sibling dashboard should
  integrate: "bookings drive door schedules and HVAC pre-conditioning".

  Schema facts this file depends on (verified against its migrations):
    bookings.during        tstzrange, half-open "[from,to)" — comes back as a STRING
    bookings.facility_id   TEXT slug ('gym', 'party', …) — the stable room key
    bookings.status        'hold' | 'confirmed' | 'canceled' | 'completed'
    bookings.approved_at   null = "reservation in review" (member-made, not signed off)
    bookings.setup_min /   minutes of staff setup/cleanup OUTSIDE `during` — the real
      cleanup_min          occupancy window is [from - setup, to + cleanup)
    standing reservations and tour "room holds" are already concrete bookings rows
    member_subscriptions.status  'active' | 'canceling' | 'past_due' | 'canceled'
    check_ins              the door/entry log (Interactive writes app-unlock rows itself)

  Routes (signed-in) mirror the old Amilia shapes so the UI is a drop-in:
    GET /api/interactive/bookings          display rows for the Bookings tab
    GET /api/interactive/members/summary   { total, active, ..., byType }
    GET /api/interactive/facilities        rooms + today's hours
    GET /api/interactive/debug/raw         (admin) raw sample of each table
*/

let _db = null;
function db() {
  if (!_db) _db = createClient(config.interactive.url, config.interactive.serviceKey, { auth: { persistSession: false } });
  return _db;
}

// Postgres returns a tstzrange as text: ["2026-09-02 14:00:00+00","2026-09-02 16:00:00+00")
// Same regex the Interactive app itself uses (lib/staff-bookings-store.ts).
function parseDuring(during) {
  const m = /^[[(]"?([^",]+)"?\s*,\s*"?([^")\]]+)"?[)\]]$/.exec(String(during || ""));
  if (!m) return null;
  const from = new Date(m[1]), to = new Date(m[2]);
  return Number.isNaN(from) || Number.isNaN(to) ? null : { from, to };
}

const isoDay = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const tz = () => config.timezone;
const fmtDate = (d) => new Intl.DateTimeFormat("en-US", { timeZone: tz(), weekday: "short", month: "short", day: "numeric" }).format(d);
const fmtTime = (d) => new Intl.DateTimeFormat("en-US", { timeZone: tz(), hour: "numeric", minute: "2-digit" }).format(d);
// "5.5" (decimal hours from facilities.booking_hours) -> "5:30 AM"
function fmtHour(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return "";
  const hh = Math.floor(n), mm = Math.round((n - hh) * 60);
  const ampm = hh >= 12 ? "PM" : "AM", h12 = ((hh + 11) % 12) + 1;
  return mm ? `${h12}:${String(mm).padStart(2, "0")} ${ampm}` : `${h12} ${ampm}`;
}

// --- Bookings ------------------------------------------------------------------

const BOOKING_COLS = "id, code, facility_id, title, client_name, during, status, approved_at, hold_expires_at, setup_min, cleanup_min, price_cents, canceled_at, facilities(name, color)";

// Raw rows overlapping [fromIso, toIso) in the given statuses, newest-first
// tie-break by start. Expired-but-unreleased holds are dropped here so callers
// never see a hold the app would already consider dead.
async function bookingRows(fromIso, toIso, statuses) {
  const { data, error } = await db()
    .from("bookings")
    .select(BOOKING_COLS)
    .overlaps("during", `[${fromIso},${toIso})`)
    .in("status", statuses);
  if (error) throw new Error(`Interactive bookings: ${error.message}`);
  const now = Date.now();
  return (data || []).filter((r) => !(r.status === "hold" && r.hold_expires_at && new Date(r.hold_expires_at).getTime() < now));
}

// Normalised spans for the door scheduler — CONFIRMED and staff-approved only.
// `start/end` are the billed hours; `accessFrom/accessTo` add the setup/cleanup
// buffers (what the door actually needs to honour).
export async function fetchBookingSpans(fromIso, toIso) {
  const rows = await bookingRows(fromIso, toIso, ["confirmed"]);
  return rows
    .filter((r) => r.approved_at)
    .map((r) => {
      const d = parseDuring(r.during);
      if (!d) return null;
      const setup = (Number(r.setup_min) || 0) * 60000, cleanup = (Number(r.cleanup_min) || 0) * 60000;
      return {
        id: r.id, code: r.code,
        start: d.from.getTime(), end: d.to.getTime(),
        accessFrom: d.from.getTime() - setup, accessTo: d.to.getTime() + cleanup,
        facilityId: r.facility_id,
        room: r.facilities?.name || r.facility_id,
        activity: r.title || "Reservation",
        who: r.client_name || "",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

// Active rooms, with today's opening hours from facilities.booking_hours
// (7-entry array Sun..Sat of { closed, openH, closeH }).
export async function fetchFacilities() {
  const { data, error } = await db()
    .from("facilities")
    .select("id, name, color, active, sort, booking_hours, setup_min, cleanup_min")
    .order("sort");
  if (error) throw new Error(`Interactive facilities: ${error.message}`);
  // Weekday index in the org's timezone (booking_hours is Sun=0 … Sat=6).
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz(), weekday: "short" }).format(new Date());
  const dow = Math.max(0, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd));
  return (data || [])
    .filter((f) => f.active !== false)
    .map((f) => {
      const h = Array.isArray(f.booking_hours) ? f.booking_hours[dow] : null;
      const hours = !h ? "" : h.closed ? "Closed today" : `${fmtHour(h.openH)} – ${fmtHour(h.closeH)}`;
      return { id: f.id, name: f.name, color: f.color, hours, setupMin: f.setup_min, cleanupMin: f.cleanup_min };
    });
}

// --- Memberships -----------------------------------------------------------

const LIVE = ["active", "canceling", "past_due"];

// Every person on a live membership, in the shape the new-member alert diff
// expects ({ membershipId, membership, person: { Id, FirstName, LastName, … } }).
export async function allMembershipPersons() {
  const { data: subs, error } = await db()
    .from("member_subscriptions")
    .select("account_id, plan_id, status, created_at, membership_plans(name)")
    .in("status", LIVE);
  if (error) throw new Error(`Interactive memberships: ${error.message}`);
  const ids = [...new Set((subs || []).map((s) => s.account_id))];
  if (!ids.length) return [];
  const { data: people, error: e2 } = await db()
    .from("clients")
    .select("id, account_id, full_name, email, is_primary")
    .in("account_id", ids);
  if (e2) throw new Error(`Interactive clients: ${e2.message}`);
  const byAccount = new Map();
  for (const p of people || []) (byAccount.get(p.account_id) || byAccount.set(p.account_id, []).get(p.account_id)).push(p);
  const out = [];
  for (const s of subs || []) {
    const plan = s.membership_plans?.name || s.plan_id;
    for (const p of byAccount.get(s.account_id) || []) {
      const [FirstName, ...rest] = String(p.full_name || "").trim().split(/\s+/);
      out.push({
        membershipId: s.plan_id, membership: plan,
        person: { Id: p.id, AccountId: p.account_id, FirstName: FirstName || "", LastName: rest.join(" "), FullName: p.full_name, Email: p.email, IsPrimary: p.is_primary },
      });
    }
  }
  return out;
}

// Same shape the Members tab consumed from Amilia — but now with real values
// for the fields Amilia couldn't give us (new/cancelled this month, inside now).
export async function fetchMembersSummary() {
  const { data: subs, error } = await db()
    .from("member_subscriptions")
    .select("account_id, plan_id, status, created_at, updated_at, membership_plans(name, price_cents)");
  if (error) throw new Error(`Interactive memberships: ${error.message}`);
  const all = subs || [];
  const live = all.filter((s) => LIVE.includes(s.status));

  // Headcount (people) per plan, from the clients on each live account.
  const ids = [...new Set(live.map((s) => s.account_id))];
  let people = [];
  if (ids.length) {
    const { data } = await db().from("clients").select("account_id").in("account_id", ids);
    people = data || [];
  }
  const peoplePerAccount = new Map();
  for (const p of people) peoplePerAccount.set(p.account_id, (peoplePerAccount.get(p.account_id) || 0) + 1);

  const byPlan = new Map();
  for (const s of live) {
    const name = s.membership_plans?.name || s.plan_id;
    const price = (Number(s.membership_plans?.price_cents) || 0) / 100;
    const row = byPlan.get(name) || { type: name, count: 0, fees: 0, price, revenue: 0, basis: "per account", legacy: false };
    row.count += peoplePerAccount.get(s.account_id) || 1;
    row.fees += 1;
    if (s.status !== "canceling") row.revenue += price;   // app's MRR rule: canceling doesn't renew
    byPlan.set(name, row);
  }
  const byType = [...byPlan.values()].sort((a, b) => b.fees - a.fees);

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const since = monthStart.getTime();
  const newThisMonth = live.filter((s) => new Date(s.created_at).getTime() >= since).length;
  const cancelledThisMonth = all.filter((s) => s.status === "canceled" && new Date(s.updated_at || s.created_at).getTime() >= since).length;

  // "Inside now" — the same rule the Interactive check-ins tab uses.
  let checkedInNow = 0;
  try {
    const { count } = await db()
      .from("check_ins")
      .select("id", { count: "exact", head: true })
      .not("account_id", "is", null)
      .is("checked_out_at", null)
      .gte("at", new Date(Date.now() - 16 * 3600000).toISOString());
    checkedInNow = count || 0;
  } catch { /* optional */ }

  return {
    total: byType.reduce((s, r) => s + r.count, 0),
    active: live.filter((s) => s.status !== "canceling").length,
    newThisMonth,
    cancelledThisMonth,
    checkedInNow,
    projectedRevenue: byType.reduce((s, r) => s + r.revenue, 0),
    byType,
  };
}

// --- Routes ------------------------------------------------------------------------

// Display rows for the Bookings tab. Includes unpaid holds (striped in the
// Interactive board) and in-review reservations, flagged by `status`, so staff
// see the whole picture — the door scheduler separately uses confirmed only.
interactiveRouter.get(
  "/bookings",
  guard("interactive", async (req) => {
    const from = req.query.from || isoDay(0);
    const to = req.query.to || isoDay(89);
    const rows = await bookingRows(from, to, ["hold", "confirmed"]);
    return rows
      .map((r) => {
        const d = parseDuring(r.during);
        if (!d) return null;
        return {
          id: r.id, code: r.code, _sort: d.from.getTime(),
          date: fmtDate(d.from), start: fmtTime(d.from), end: fmtTime(d.to),
          room: r.facilities?.name || r.facility_id, facilityId: r.facility_id,
          activity: r.title || "Reservation", who: r.client_name || "",
          type: r.status === "hold" ? "Hold" : r.approved_at ? "" : "In review",
          color: r.facilities?.color || null,
          status: r.status === "hold" ? "hold" : r.approved_at ? "confirmed" : "review",
        };
      })
      .filter(Boolean)
      .sort((a, b) => a._sort - b._sort)
      .map(({ _sort, ...rest }) => rest);
  })
);

interactiveRouter.get("/members/summary", guard("interactive", () => fetchMembersSummary()));
interactiveRouter.get("/facilities", guard("interactive", () => fetchFacilities()));

// Raw peek for Settings → Diagnostics.
interactiveRouter.get(
  "/debug/raw",
  requireAdmin,
  guard("interactive", async () => {
    const sample = async (table, cols) => {
      const { data, error } = await db().from(table).select(cols).limit(5);
      return error ? { error: error.message } : data;
    };
    return {
      facilities: await sample("facilities", "id, name, active, setup_min, cleanup_min"),
      bookings: await sample("bookings", "code, facility_id, title, during, status, approved_at, setup_min, cleanup_min"),
      member_subscriptions: await sample("member_subscriptions", "plan_id, status, current_period_end"),
      todaySpans: await fetchBookingSpans(isoDay(0), isoDay(1)),
    };
  })
);
