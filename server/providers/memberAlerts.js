import { Router } from "express";
import { config, guard, http } from "../config.js";
import { requireAuth, requireAdmin, logAudit } from "../auth.js";
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
const CHECK_GATE_TTL = 120_000; // kv store's 60s skew makes this an effective ~60s gate

// Ring buffer of recent sign-up events, shown in the dashboard's Alerts tab.
async function readRecent() {
  const r = await getCachedToken(KV_PROVIDER, "recent");
  try { return r ? JSON.parse(r.token) : []; } catch { return []; }
}
async function appendRecent(entry) {
  const recent = [entry, ...(await readRecent())].slice(0, 20);
  await setCachedToken(KV_PROVIDER, "recent", JSON.stringify(recent), {}, Date.now() + FOREVER);
}

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

    // Record in the in-app feed first — the dashboard shows sign-ups even when
    // no email/SMS channel is configured (or a send fails).
    const names = fresh.slice(0, 8).map(label);
    const more = fresh.length > 8 ? fresh.length - 8 : 0;
    await appendRecent({ at: new Date().toISOString(), count: fresh.length, members: names, more });

    // Email/SMS blasts on new members are opt-in (NOTIFY_NEW_MEMBERS). By default
    // we skip them — the in-app feed above already drives the Members-page congrats
    // popup and the Alerts tab, which is what the team watches.
    let sent = false, errors = [];
    if (config.alerts.notifyNewMembers && config.alerts.configured) {
      const plural = fresh.length === 1 ? "New member" : `${fresh.length} new members`;
      ({ sent, errors } = await sendAlert(`SquareOne: ${plural}`, `${names.join(", ")}${more ? ` +${more} more` : ""}`));
    }
    // The in-app feed has the alert either way — mark the roster seen so the
    // same people aren't re-announced every tick.
    await save();
    logAudit(req, "alerts.new-members", null, { count: fresh.length, sent });
    return { alerted: fresh.length, sent, alertsConfigured: config.alerts.configured, errors };
  } catch (e) {
    return { error: e.message };
  }
}

// Recent sign-up feed for the dashboard's Alerts tab.
alertsRouter.get("/recent", requireAuth, async (_req, res) => {
  res.json({ ok: true, data: await readRecent() });
});

// On-demand check the browser polls while the dashboard is open — much faster
// than waiting for the 5-minute cron. Gated in the kv so no matter how many
// tabs are open (or how often they poll), Amilia is hit at most ~once a minute.
alertsRouter.all("/check", requireAuth, async (req, res) => {
  let checked = false, result = null;
  const gate = await getCachedToken(KV_PROVIDER, "check-gate");
  if (!gate) {
    await setCachedToken(KV_PROVIDER, "check-gate", "1", {}, Date.now() + CHECK_GATE_TTL);
    result = await checkNewMembers(req);
    checked = true;
  }
  res.json({ ok: true, data: { checked, result, recent: await readRecent() } });
});

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
