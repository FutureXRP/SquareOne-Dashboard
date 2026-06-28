import { Router } from "express";
import { config, guard, http } from "../config.js";

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

let jwtCache = "";

async function getJwt() {
  if (config.amilia.jwt) return config.amilia.jwt;
  if (jwtCache) return jwtCache;
  const basic = Buffer.from(`${config.amilia.email}:${config.amilia.password}`).toString("base64");
  // The authenticate call has NO language segment and returns the raw JWT.
  const token = await http(`${config.amilia.baseUrl}/api/V3/authenticate`, {
    headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
  });
  jwtCache = typeof token === "string" ? token.replace(/^"|"$/g, "") : token?.Token || token?.token;
  if (!jwtCache) throw new Error("authenticate did not return a JWT");
  return jwtCache;
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
    for (const m of list) {
      // Pull just the count via perPage=1 and read Paging.TotalCount (cheap).
      let count = 0;
      try {
        const persons = await get(`/memberships/${m.Id ?? m.id}/persons?page=1&perPage=1`, jwt);
        count = persons?.Paging?.TotalCount ?? (persons?.Items?.length || 0);
      } catch { /* a membership with no persons endpoint just counts 0 */ }
      total += count;
      byType.push({ type: m.Name ?? m.name ?? `Membership ${m.Id ?? m.id}`, count });
    }

    return {
      total,
      active: total,            // refine with ?status=Active once you confirm status values
      newThisMonth: 0,          // derive from registrations/date filters when needed
      cancelledThisMonth: 0,
      checkedInNow: 0,          // Amilia has no live check-in count; wire from access control if needed
      byType,
    };
  })
);

// Bookings/schedule for a date (defaults to today). Uses the activity events feed.
amiliaRouter.get(
  "/bookings",
  guard("amilia", async (req) => {
    const jwt = await getJwt();
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    // from/to as the same day => single-day schedule. showParticipants adds party sizes.
    const events = await get(
      `/events?from=${date}&to=${date}&showParticipants=true&showCanceled=false`,
      jwt
    );
    const items = events?.Items || events || [];
    return items.map((e, i) => {
      const start = e.Start || e.StartDate || e.start;
      const end = e.End || e.EndDate || e.end;
      return {
        id: e.Id ?? e.id ?? i,
        room: e.LocationName || e.Location?.Name || e.location || "—",
        activity: e.Name || e.ActivityName || e.title || "Activity",
        start: fmtTime(start),
        end: fmtTime(end),
        party: e.Participants?.length ?? e.ParticipantCount ?? 0,
        status: (e.Status || "confirmed").toString().toLowerCase(),
      };
    });
  })
);

function fmtTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
