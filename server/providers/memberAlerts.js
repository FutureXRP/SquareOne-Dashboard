import { Router } from "express";
import { config, guard, http } from "../config.js";
import { requireAdmin, logAudit } from "../auth.js";
import { getCachedToken, setCachedToken } from "../tokenStore.js";
import { allMembershipPersons } from "./amilia.js";

export const alertsRouter = Router();

/*
  New-member SMS alerts.

  Every /api/doors/run cron tick also diffs the current membership roster
  against the last-seen roster (persisted in the token_cache kv). Anyone new
  triggers one SMS to ALERT_PHONE via Twilio — batched, so five sign-ups in one
  tick is one text, and capped so a burst can't run up the bill.

  First run seeds the roster silently (no blast of texts for existing members).

  GET /api/alerts/test (admin) — sends a test SMS to verify the Twilio wiring.
*/

const KV_PROVIDER = "member-alerts";
const KV_SCOPE = "known-roster";
const FOREVER = 10 * 365 * 24 * 3600 * 1000;

export async function sendSms(body) {
  const { twilio, phone } = config.alerts;
  const auth = Buffer.from(`${twilio.sid}:${twilio.token}`).toString("base64");
  const params = new URLSearchParams({ To: phone, From: twilio.from, Body: body });
  return http(`https://api.twilio.com/2010-04-01/Accounts/${twilio.sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

// "Alta Birdshead" + "Family Fitness Membership" -> "Alta B. (Family Fitness)"
function label(entry) {
  const p = entry.person;
  const first = p.FirstName || p.FullName || "New member";
  const lastInitial = p.LastName ? ` ${p.LastName[0]}.` : "";
  const plan = entry.membership.replace(/\s*membership\s*$/i, "");
  return `${first}${lastInitial} (${plan})`;
}

// Diff the roster against last-seen and text the owner about anyone new.
// Called from the /api/doors/run cron tick; must never throw.
export async function checkNewMembers(req) {
  if (!config.amilia.configured) return { skipped: "amilia not configured" };
  try {
    const roster = await allMembershipPersons();
    const current = new Map(roster.map((e) => [`${e.person.Id}:${e.membershipId}`, e]));

    const stored = await getCachedToken(KV_PROVIDER, KV_SCOPE);
    const save = () => setCachedToken(KV_PROVIDER, KV_SCOPE, JSON.stringify([...current.keys()]), {}, Date.now() + FOREVER);

    if (!stored) {
      await save(); // first run: seed silently
      return { seeded: current.size, alerted: 0 };
    }

    const known = new Set(JSON.parse(stored.token));
    const fresh = [...current.entries()].filter(([k]) => !known.has(k)).map(([, e]) => e);
    if (!fresh.length) return { alerted: 0 };

    let sent = false, error = null;
    if (config.alerts.configured) {
      const names = fresh.slice(0, 8).map(label).join(", ");
      const more = fresh.length > 8 ? ` +${fresh.length - 8} more` : "";
      const plural = fresh.length === 1 ? "New member" : `${fresh.length} new members`;
      try {
        await sendSms(`SquareOne: ${plural} — ${names}${more}`);
        sent = true;
      } catch (e) { error = e.message; }
    }
    // Mark them seen when the text went out (or SMS isn't set up at all). On a
    // send failure, leave them unseen so the next tick retries the alert.
    if (sent || !config.alerts.configured) await save();
    logAudit(req, "alerts.new-members", null, { count: fresh.length, sent });
    return { alerted: fresh.length, sent, smsConfigured: config.alerts.configured, error };
  } catch (e) {
    return { error: e.message };
  }
}

// Admin: verify the Twilio wiring end-to-end.
alertsRouter.get(
  "/test",
  requireAdmin,
  guard("alerts", async (req) => {
    await sendSms("SquareOne dashboard: test alert — SMS wiring works.");
    logAudit(req, "alerts.test", null, {});
    return { sent: true, to: config.alerts.phone };
  })
);
