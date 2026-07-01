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

// Count the people in a membership. Amilia rejected the plain paginated call with
// a 400, so try the documented variants in order and use the first that answers.
// Returns { count, via } (via = the path that worked, or null).
const PERSON_COUNT_PATHS = (id) => [
  `/memberships/${id}/persons?status=Active`,
  `/memberships/${id}/persons`,
  `/memberships/${id}/persons?status=Active&page=1&perPage=1`,
  `/memberships/${id}/members`,
  `/memberships/${id}/persons?page=1&perPage=1`,
];

async function countPersons(id, jwt) {
  for (const path of PERSON_COUNT_PATHS(id)) {
    try {
      const r = await get(path, jwt);
      const tc = r?.Paging?.TotalCount;
      if (typeof tc === "number") return { count: tc, via: path };
      if (Array.isArray(r?.Items)) return { count: r.Items.length, via: path };
      if (Array.isArray(r)) return { count: r.length, via: path };
    } catch { /* try the next variant */ }
  }
  return { count: 0, via: null };
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
    if (mList[0]) {
      const id = mList[0].Id ?? mList[0].id;
      persons = await get(`/memberships/${id}/persons?page=1&perPage=1`, jwt).catch((e) => ({ error: e.message }));
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
      events: { count: eList.length, itemKeys: keys(eList[0]), sample: eList[0] ?? null, paging: events?.Paging ?? null, error: events?.error },
      reservationsWide, eventsWide, locations,
      discovery: probes,
    };
  })
);

// Membership summary. Each "membership" is a type/tier; per-type counts come from
// the Paging.TotalCount of its persons list.
amiliaRouter.get(
  "/members/summary",
  guard("amilia", async () => {
    const jwt = await getJwt();
    const memberships = await get("/memberships", jwt);
    const list = memberships?.Items || memberships || [];

    const byType = [];
    let total = 0;
    let projectedRevenue = 0; // sum of membership list price × active members
    for (const m of list) {
      const { count } = await countPersons(m.Id ?? m.id, jwt);
      const price = Number(m.Price) || 0;
      const revenue = price * count;
      total += count;
      projectedRevenue += revenue;
      byType.push({ type: m.Name ?? m.name ?? `Membership ${m.Id ?? m.id}`, count, price, revenue });
    }

    return {
      total,
      active: total,            // refine with ?status=Active once you confirm status values
      newThisMonth: 0,          // derive from registrations/date filters when needed
      cancelledThisMonth: 0,
      checkedInNow: 0,          // Amilia has no live check-in count; wire from access control if needed
      projectedRevenue,         // based on membership list price × active members
      byType,
    };
  })
);

// Facility bookings from Amilia's reservations feed (confirmed valid endpoint).
// Defaults to an upcoming 14-day window since same-day reservations are often 0.
amiliaRouter.get(
  "/bookings",
  guard("amilia", async (req) => {
    const jwt = await getJwt();
    const from = req.query.from || isoDay(0);
    const to = req.query.to || isoDay(13);
    let res = null;
    try { res = await get(`/reservations?from=${from}&to=${to}`, jwt); } catch { /* fall through to empty */ }
    const items = res?.Items || (Array.isArray(res) ? res : []) || [];

    const norm = items.map((r, i) => {
      const start = r.Start || r.StartDate || r.StartDateTime || r.start;
      const end = r.End || r.EndDate || r.EndDateTime || r.end;
      return {
        id: r.Id ?? r.id ?? i,
        _sort: start ? new Date(start).getTime() : 0,
        date: fmtDate(start),
        start: fmtTime(start),
        end: fmtTime(end),
        room: r.LocationName || r.Location?.Name || r.ResourceName || r.Resource?.Name || r.FacilityName || "—",
        activity: r.Name || r.Title || r.ActivityName || r.Description || r.Notes || "Reservation",
        who: r.ContactName || r.AccountName || r.OwnerName || r.PersonName || r.ClientName || "",
        party: r.Attendees ?? r.ParticipantCount ?? (Array.isArray(r.Participants) ? r.Participants.length : 0),
        status: (r.Status || "confirmed").toString().toLowerCase(),
      };
    });
    norm.sort((a, b) => a._sort - b._sort);
    norm.forEach((n) => delete n._sort);
    return norm;
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
