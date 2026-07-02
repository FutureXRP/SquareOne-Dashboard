import { Router } from "express";
import { config, guard, http } from "../config.js";
import { requireAdmin, logAudit } from "../auth.js";
import { getCachedToken, setCachedToken } from "../tokenStore.js";
import { allMembershipPersons } from "./amilia.js";

export const alertsRouter = Router();

/*
  New-member alerts.

  Every /api/doors/run cron tick diffs the current membership roster against
  the last-seen roster (persisted in the token_cache kv). Anyone new triggers
  ONE batched alert on every configured channel:
    - Email via Resend (RESEND_API_KEY + ALERT_EMAIL) — easiest to set up.
    - SMS via Twilio (TWILIO_* + ALERT_PHONE) — when texts are wanted.

  First run seeds the roster silently (no blast for existing members).

  GET /api/alerts/test (admin) — sends a test alert on all configured channels.
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

export async function sendEmail(subject, text) {
  const { email, resendKey, emailFrom } = config.alerts;
  return http("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: emailFrom, to: [email], subject, text }),
  });
}

// Send on every configured channel; returns { sent, errors } — sent is true if
// at least one channel delivered.
export async function sendAlert(subject, message) {
  const errors = [];
  let sent = false;
  if (config.alerts.emailConfigured) {
    try { await sendEmail(subject, message); sent = true; }
    catch (e) { errors.push(`email: ${e.message}`); }
  }
  if (config.alerts.smsConfigured) {
    try { await sendSms(`${subject} — ${message}`); sent = true; }
    catch (e) { errors.push(`sms: ${e.message}`); }
  }
  return { sent, errors };
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

    let sent = false, errors = [];
    if (config.alerts.configured) {
      const names = fresh.slice(0, 8).map(label).join(", ");
      const more = fresh.length > 8 ? ` +${fresh.length - 8} more` : "";
      const plural = fresh.length === 1 ? "New member" : `${fresh.length} new members`;
      ({ sent, errors } = await sendAlert(`SquareOne: ${plural}`, `${names}${more}`));
    }
    // Mark them seen when an alert went out (or no channel is set up at all).
    // On a total send failure, leave them unseen so the next tick retries.
    if (sent || !config.alerts.configured) await save();
    logAudit(req, "alerts.new-members", null, { count: fresh.length, sent });
    return { alerted: fresh.length, sent, alertsConfigured: config.alerts.configured, errors };
  } catch (e) {
    return { error: e.message };
  }
}

// Admin: verify the alert wiring end-to-end on every configured channel.
alertsRouter.get(
  "/test",
  requireAdmin,
  guard("alerts", async (req) => {
    const { sent, errors } = await sendAlert("SquareOne dashboard: test alert", "Alert wiring works.");
    logAudit(req, "alerts.test", null, { sent });
    return {
      sent,
      errors,
      channels: {
        email: config.alerts.emailConfigured ? config.alerts.email : null,
        sms: config.alerts.smsConfigured ? config.alerts.phone : null,
      },
    };
  })
);
