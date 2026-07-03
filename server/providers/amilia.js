import { Router } from "express";
import { config, guard, http } from "../config.js";
import { getCachedToken, setCachedToken } from "../tokenStore.js";
import { requireAdmin } from "../auth.js";

export const amiliaRouter = Router();

/*
  Amilia SmartRec V3 REST API.

  SETUP (one-time):
    - Recommended: create a dedicated service account in your Amilia org (its own
      email + password, placed in a permission group like "Integrations"), then put
      AMILIA_EMAIL / AMILIA_PASSWORD / AMILIA_ORG_ID in .env.
      (Org id is the numeric id or the URL slug, e.g. "yoga-central".)
    - Or paste a pre-generated token as AMILIA_JWT to skip the login step.

  Auth flow:
    GET {base}/api/V3/authenticate  with  Authorization: Basic base64(email:password)
      -> returns a JWT (valid ~1 year). We cache it.
    All other calls use  Authorization: Bearer {jwt}.

  Pagination envelope on list endpoints:  { Items: [...], Paging: { TotalCount, Next } }
*/

async function getJwt() {
  if (config.amilia.jwt) return config.amilia.jwt;
  const scope = config.amilia.orgId || "default";
  const cached = await getCachedToken("amilia", scope);
  if (cached) return cached.token;
  const basic = Buffer.from(`${config.amilia.email}:${config.amilia.password}`).toString("base64");
  // The authenticate call has NO language segment and returns the raw JWT.
  const token = await http(`${config.amilia.baseUrl}/api/V3/authenticate`, {
    headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
  });
  const jwt = typeof token === "string" ? token.replace(/^"|"$/g, "") : token?.Token || token?.token;
  if (!jwt) throw new Error("authenticate did not return a JWT");
  // Amilia JWTs last ~1 year; cache for 300 days.
  await setCachedToken("amilia", scope, jwt, {}, Date.now() + 300 * 24 * 3600 * 1000);
  return jwt;
}

function orgBase() {
  const { baseUrl, lang, orgId } = config.amilia;
  return `${baseUrl}/api/V3/${lang}/org/${orgId}`;
}

async function get(path, jwt) {
  return http(`${orgBase()}${path}`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json", "X-Amilia-Origin": "SquareOne-Dashboard" },
  });
}

// Fetch the people in a membership. Amilia rejected the plain paginated call with
// a 400, so try the documented variants (that return the full list) in order and
// use the first that answers. Returns { items, total, via }.
const PERSON_PATHS = (id) => [
  `/memberships/${id}/persons?status=Active`,
  `/memberships/${id}/persons`,
  `/memberships/${id}/members`,
];

async function fetchPersons(id, jwt) {
  for (const path of PERSON_PATHS(id)) {
    try {
      const r = await get(path, jwt);
      const items = r?.Items || (Array.isArray(r) ? r : []);
      const total = typeof r?.Paging?.TotalCount === "number" ? r.Paging.TotalCount : items.length;
      if (items.length || total) return { items, total, via: path };
    } catch { /* try the next variant */ }
  }
  return { items: [], total: 0, via: null };
}

// How many FEES a membership generates. A family plan is one fee covering several
// people, so headcount overstates revenue. Prefer, in order of reliability:
//   1. subscriptions/purchases sold (each = one fee),
//   2. persons flagged as the primary/account owner (one per family),
//   3. distinct billing accounts among the persons (one per family),
//   4. headcount (only when nothing better is available — matches old behavior).
// Returns { fees, basis }.
const SUBSCRIPTION_PATHS = (id) => [`/memberships/${id}/subscriptions`, `/memberships/${id}/purchases`];
const OWNER_FLAGS = ["IsPrimary", "IsOwner", "IsPrincipal", "IsAccountOwner", "IsMainMember", "IsHeadOfFamily"];
const ACCOUNT_KEYS = ["AccountId", "OwnerId", "OwnerAccountId", "BillingAccountId", "FamilyId", "MainAccountId", "HouseholdId"];

async function countSubscriptions(id, jwt) {
  for (const path of SUBSCRIPTION_PATHS(id)) {
    try {
      const r = await get(path, jwt);
      const tc = r?.Paging?.TotalCount;
      if (typeof tc === "number") return { count: tc, via: path };
      const items = r?.Items || (Array.isArray(r) ? r : []);
      if (items.length) return { count: items.length, via: path };
    } catch { /* endpoint may not exist for this org */ }
  }
  return null;
}

function feesFromPersons(items) {
  if (!items.length) return null;
  // A person flagged as the primary/owner represents one billed family unit.
  for (const f of OWNER_FLAGS) {
    if (f in items[0]) {
      const n = items.filter((p) => p[f] === true).length;
      if (n > 0) return { fees: n, basis: `primary:${f}` };
    }
  }
  // Otherwise collapse people to distinct billing accounts (one fee per family).
  for (const k of ACCOUNT_KEYS) {
    if (items[0][k] != null) {
      const ids = new Set(items.map((p) => p[k]).filter((v) => v != null));
      if (ids.size) return { fees: ids.size, basis: `accounts:${k}` };
    }
  }
  return null;
}

/*
  Admin-only field-verification endpoint. Returns the RAW shape of the Amilia
  responses (field names + one sample record + paging) so we can confirm the exact
  casing/nesting before trusting the mapping in /members/summary and /bookings.

  GET /api/amilia/debug/raw?date=YYYY-MM-DD
  Admin-gated (returns one member's data — treat the response as sensitive).
*/
amiliaRouter.get(
  "/debug/raw",
  requireAdmin,
  guard("amilia", async (req) => {
    const jwt = await getJwt();
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const keys = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : []);
    const unwrap = (r) => (r?.Items || (Array.isArray(r) ? r : []));

    const memberships = await get("/memberships", jwt).catch((e) => ({ error: e.message }));
    const mList = unwrap(memberships);

    let persons = null;
    let subscriptions = null;
    if (mList[0]) {
      const id = mList[0].Id ?? mList[0].id;
      // Full person list (not perPage=1) so we can see whether records carry an
      // owner/primary flag or a billing-account id to collapse family plans on.
      persons = await get(`/memberships/${id}/persons?status=Active`, jwt).catch((e) => ({ error: e.message }));
      // Does this org expose subscriptions/purchases sold? That's the ideal fee count.
      subscriptions = await get(`/memberships/${id}/subscriptions`, jwt).catch((e) => ({ error: e.message }));
    }

    const events = await get(`/events?from=${date}&to=${date}&showParticipants=true&showCanceled=false`, jwt)
      .catch((e) => ({ error: e.message }));
    const eList = unwrap(events);

    // Wide window (30 days back → 90 ahead) to surface a real reservation/event
    // sample so we can map fields exactly (today is often empty).
    const wideFrom = isoDay(-30);
    const wideTo = isoDay(90);
    const sampleOf = async (path) => {
      try {
        const r = await get(path, jwt);
        const items = r?.Items || (Array.isArray(r) ? r : []);
        return { path, ok: true, count: items.length, totalCount: r?.Paging?.TotalCount ?? null, itemKeys: keys(items[0]), sample: items[0] ?? null };
      } catch (e) { return { path, ok: false, error: e.message }; }
    };
    const [reservationsWide, eventsWide, locations] = await Promise.all([
      sampleOf(`/reservations?from=${wideFrom}&to=${wideTo}`),
      sampleOf(`/events?from=${wideFrom}&to=${wideTo}&showParticipants=true`),
      sampleOf(`/locations`),
    ]);

    // Fee-basis check: for every populated membership, report headcount plus what
    // each candidate fee-counting strategy yields, so we can see which one matches
    // the real number of memberships sold (per the org's Membership Management).
    const feeCheck = await Promise.all(
      mList.map(async (m) => {
        const id = m.Id ?? m.id;
        const { items, total, via } = await fetchPersons(id, jwt);
        if (!total) return { membership: m.Name ?? id, headcount: 0 };
        const subs = await countSubscriptions(id, jwt);
        const flags = OWNER_FLAGS.filter((f) => items[0] && f in items[0])
          .map((f) => ({ flag: f, trueCount: items.filter((p) => p[f] === true).length }));
        const accounts = ACCOUNT_KEYS.filter((k) => items[0] && items[0][k] != null)
          .map((k) => ({ key: k, distinct: new Set(items.map((p) => p[k]).filter((v) => v != null)).size }));
        const chosen = subs
          ? { fees: subs.count, basis: `subscriptions:${subs.via}` }
          : (feesFromPersons(items) ?? { fees: total, basis: "headcount" });
        return {
          membership: m.Name ?? id, headcount: total, personsVia: via,
          personKeys: keys(items[0]),
          subscriptions: subs ?? "not exposed",
          ownerFlags: flags, accountKeys: accounts,
          chosen,
        };
      })
    );

    // Discovery: which other feeds exist (status + count only) for future tabs.
    const probe = async (path) => {
      try {
        const r = await get(path, jwt);
        return { path, ok: true, totalCount: r?.Paging?.TotalCount ?? null, itemsLen: (r?.Items || (Array.isArray(r) ? r : [])).length, topKeys: keys(r) };
      } catch (e) { return { path, ok: false, error: e.message }; }
    };
    const probes = await Promise.all([
      `/activities`,
      `/registrations`,
      `/accounts?page=1&perPage=1`,
      `/orders`,
      `/merchandises`,
      `/transactions`,
      `/staff`,
    ].map(probe));

    return {
      date,
      orgBase: orgBase(),
      memberships: { count: mList.length, itemKeys: keys(mList[0]), sample: mList[0] ?? null, paging: memberships?.Paging ?? null, error: memberships?.error },
      membershipPersons: { itemKeys: keys(unwrap(persons)[0]), sample: unwrap(persons)[0] ?? null, paging: persons?.Paging ?? null, error: persons?.error },
      membershipSubscriptions: { itemKeys: keys(unwrap(subscriptions)[0]), sample: unwrap(subscriptions)[0] ?? null, paging: subscriptions?.Paging ?? null, error: subscriptions?.error },
      feeCheck,
      events: { count: eList.length, itemKeys: keys(eList[0]), sample: eList[0] ?? null, paging: events?.Paging ?? null, error: events?.error },
      reservationsWide, eventsWide, locations,
      discovery: probes,
    };
  })
);

// Every person on every membership, flat — shared with the new-member alert
// check (server/providers/memberAlerts.js).
export async function allMembershipPersons() {
  const jwt = await getJwt();
  const list = await listMemberships(jwt);
  const perPlan = await Promise.all(list.map(async (m) => {
    const { items } = await fetchPersons(m.Id ?? m.id, jwt);
    return items.map((p) => ({ membershipId: m.Id ?? m.id, membership: m.Name ?? m.name ?? "", person: p }));
  }));
  return perPlan.flat();
}

// The default /memberships list excludes archived (discontinued) plans, but a
// discontinued plan can still have grandfathered members paying its fee. Try the
// archived-list variants and merge any extra plans found (dedup by Id). Which
// variant works (or that none do) is cached for a day so routine loads don't
// spend three probe calls rediscovering it.
const kvScope = () => String(config.amilia.orgId || "default");
const ARCHIVED_VARIANTS = ["?showArchived=true", "?isArchived=true", "?includeArchived=true"];

async function listMemberships(jwt) {
  const base = await get("/memberships", jwt);
  const list = [...(base?.Items || (Array.isArray(base) ? base : []))];
  const seen = new Set(list.map((m) => m.Id ?? m.id));
  const merge = (r) => {
    const extra = (r?.Items || (Array.isArray(r) ? r : [])).filter((m) => !seen.has(m.Id ?? m.id));
    extra.forEach((m) => { seen.add(m.Id ?? m.id); list.push({ ...m, IsArchived: true }); });
    return extra.length;
  };

  const cached = await getCachedToken("amilia-archived-variant", kvScope());
  const remember = (v) => setCachedToken("amilia-archived-variant", kvScope(), v, {}, Date.now() + 24 * 3600 * 1000);
  if (cached) {
    if (cached.token !== "none") {
      try { merge(await get(`/memberships${cached.token}`, jwt)); } catch { /* variant stopped working — rediscover next day */ }
    }
    return list;
  }
  for (const q of ARCHIVED_VARIANTS) {
    try {
      const r = await get(`/memberships${q}`, jwt);
      if (merge(r)) { await remember(q); return list; }
    } catch { /* unsupported param — try the next */ }
  }
  await remember("none");
  return list;
}

// Membership summary. Each "membership" is a type/tier; per-type counts come from
// the Paging.TotalCount of its persons list. The result is kv-cached briefly so
// page loads render instantly instead of waiting on ~8 upstream Amilia calls —
// the per-plan work runs in parallel when the cache is cold.
const SUMMARY_TTL = 150_000; // effective ~90s freshness (store SKEW is 60s)

amiliaRouter.get(
  "/members/summary",
  guard("amilia", async () => {
    const cached = await getCachedToken("amilia-summary", kvScope());
    if (cached) return JSON.parse(cached.token);

    const jwt = await getJwt();
    const list = await listMemberships(jwt);

    const rows = await Promise.all(list.map(async (m) => {
      const id = m.Id ?? m.id;
      const price = Number(m.Price) || 0;

      // Headcount (people covered) — shown in the UI.
      const { items, total: count } = await fetchPersons(id, jwt);

      // Discontinued plans: keep them while grandfathered members still pay the
      // fee (tagged legacy below), drop them for good once nobody's left.
      if (m.IsArchived && count === 0) return null;

      // Number of fees this membership generates. Verified against this org's
      // live data (2026-07): person records carry AccountId, and for the
      // MultiPerson "Family Fitness" plan the 21 people collapse to exactly the
      // 4 real memberships. Individual plans bill per PERSON (two spouses can
      // share an account but each pays), so only MultiPerson plans group by
      // account. AMILIA_FEE_OVERRIDES still wins if ever set.
      const name = m.Name ?? m.name ?? `Membership ${id}`;
      const override = config.amilia.feeOverrides.find((o) => name.toLowerCase().startsWith(o.prefix));
      const isMultiPerson = m.MembershipType === "MultiPerson" || m.MultiPersonMembership != null;
      let fees, basis;
      if (count === 0) {
        fees = 0; basis = "empty";
      } else if (override) {
        fees = override.count; basis = "override (AMILIA_FEE_OVERRIDES)";
      } else if (isMultiPerson) {
        const accounts = new Set(items.map((p) => p.AccountId).filter((v) => v != null));
        fees = accounts.size || count;
        basis = accounts.size ? "families (distinct accounts)" : "headcount";
      } else {
        fees = count; basis = "per-person";
      }

      return { type: name, count, fees, price, revenue: price * fees, basis, legacy: Boolean(m.IsArchived) };
    }));

    const byType = rows.filter(Boolean);
    const total = byType.reduce((s, r) => s + r.count, 0);
    const projectedRevenue = byType.reduce((s, r) => s + r.revenue, 0);

    const summary = {
      total,
      active: total,            // refine with ?status=Active once you confirm status values
      newThisMonth: 0,          // derive from registrations/date filters when needed
      cancelledThisMonth: 0,
      checkedInNow: 0,          // Amilia has no live check-in count; wire from access control if needed
      projectedRevenue,         // membership list price × number of fees (family plans billed once)
      byType,                   // each: { type, count (people), fees (billed units), price, revenue, basis }
    };
    await setCachedToken("amilia-summary", kvScope(), JSON.stringify(summary), {}, Date.now() + SUMMARY_TTL);
    return summary;
  })
);

// Raw reservation items for a date window — shared with the door scheduler
// (server/providers/doorSchedule.js).
export async function fetchReservations(from, to) {
  const jwt = await getJwt();
  const res = await get(`/reservations?from=${from}&to=${to}`, jwt);
  return res?.Items || (Array.isArray(res) ? res : []) || [];
}

// Facility bookings from Amilia's reservations feed (confirmed valid endpoint).
// Defaults to an upcoming 14-day window since same-day reservations are often 0.
amiliaRouter.get(
  "/bookings",
  guard("amilia", async (req) => {
    const from = req.query.from || isoDay(0);
    const to = req.query.to || isoDay(89); // reservations are sparse — show a 90-day window
    let items = [];
    try { items = await fetchReservations(from, to); } catch { /* fall through to empty */ }

    const norm = items.map((r, i) => {
      const start = r.Start || r.StartDate || r.start;
      const end = r.End || r.EndDate || r.end;
      return {
        id: r.ReservationId ?? r.Id ?? i,
        _sort: start ? new Date(start).getTime() : 0,
        date: fmtDate(start),
        start: r.AllDay ? "All day" : fmtTime(start),
        end: r.AllDay ? "" : fmtTime(end),
        room: r.Location?.Name || r.LocationName || "—",
        activity: r.Title || r.AdminBooking?.Name || r.Activity?.Name || "Reservation",
        who: r.Client?.Name || r.Staff?.Name || "",
        type: r.BookingType?.Name || r.Type || "",
        color: r.BookingType?.Color || null,
        status: r.IsCancelled ? "cancelled" : "confirmed",
      };
    });
    norm.sort((a, b) => a._sort - b._sort);
    norm.forEach((n) => delete n._sort);
    return norm;
  })
);

// Facilities/locations, with today's opening hours. Always populated (13 rooms).
amiliaRouter.get(
  "/facilities",
  guard("amilia", async () => {
    const jwt = await getJwt();
    let res = null;
    try { res = await get("/locations", jwt); } catch { /* empty */ }
    const items = res?.Items || (Array.isArray(res) ? res : []) || [];
    const today = new Date().toLocaleDateString("en-US", { weekday: "long" });
    const hm = (t) => {
      if (!t) return "";
      const [h, m] = t.split(":");
      const H = Number(h);
      return `${((H + 11) % 12) + 1}:${m} ${H >= 12 ? "PM" : "AM"}`;
    };
    return items.map((l) => {
      const oh = (l.OpeningHours || []).find((h) => h.DayOfWeek === today);
      return {
        id: l.Id,
        name: l.Name || l.FullName || "—",
        description: l.Description || "",
        hours: oh ? `${hm(oh.Start)} – ${hm(oh.End)}` : "Closed today",
      };
    });
  })
);

function isoDay(offset) {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}
function fmtTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
