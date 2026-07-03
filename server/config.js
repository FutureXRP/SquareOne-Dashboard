import "dotenv/config";

// Maps the dashboard's door/zone/alarm ids to Home Assistant entity_ids.
// Override the whole thing by setting HA_ENTITIES to a JSON string of this shape.
const DEFAULT_HA_ENTITIES = {
  alarm: "alarm_control_panel.squareone",
  doors: {
    main: { name: "Main Entrance", entity: "lock.main_entrance" },
    med:  { name: "Medical",        entity: "lock.medical" },
    fit:  { name: "Fitness",        entity: "lock.fitness" },
    elc:  { name: "Early Learning", entity: "lock.early_learning" },
  },
  zones: {
    med: { name: "Medical",        entity: "climate.medical" },
    elc: { name: "Early Learning", entity: "climate.early_learning" },
    fit: { name: "Fitness",        entity: "climate.fitness" },
    off: { name: "Offices",        entity: "climate.offices" },
  },
};

function parseEntities(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { console.warn("HA_ENTITIES is not valid JSON — using defaults"); return null; }
}

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { console.warn(`${name} is not valid JSON — ignoring`); return null; }
}

// "Family Fitness=4;SquareOne Interactive=2" -> [{ prefix: "family fitness", count: 4 }, ...]
function parseFeeOverrides(raw) {
  return raw.split(";").map((pair) => {
    const [name, n] = pair.split("=").map((s) => s?.trim());
    const count = Number(n);
    return name && n && Number.isFinite(count) ? { prefix: name.toLowerCase(), count } : null;
  }).filter(Boolean);
}

// All secrets come from environment variables (see .env.example). Nothing is
// hardcoded and nothing reaches the browser bundle. A provider is considered
// "configured" only when its required vars are present.
export const config = {
  port: Number(process.env.PORT || 8787),

  amilia: {
    // SmartRec V3. Auth = Basic(email:password) -> JWT (valid ~1 year), then Bearer.
    // Org is in the URL path (numeric id or slug). Language is a required path segment.
    baseUrl: process.env.AMILIA_BASE_URL || "https://app.amilia.com",
    email: process.env.AMILIA_EMAIL || "",
    password: process.env.AMILIA_PASSWORD || "",
    // Optional: paste a pre-generated JWT to skip the email/password login.
    jwt: process.env.AMILIA_JWT || "",
    orgId: process.env.AMILIA_ORG_ID || "",
    lang: process.env.AMILIA_LANG || "en",
    // Optional: true fee counts per plan when Amilia can't be derived from the API.
    // Format: "Plan Name=count;Other Plan=count" (name match is case-insensitive,
    // 'starts with' — so "Family Fitness=4" matches "Family Fitness Membership").
    feeOverrides: parseFeeOverrides(process.env.AMILIA_FEE_OVERRIDES || ""),
    get configured() {
      return Boolean(this.orgId && (this.jwt || (this.email && this.password)));
    },
  },

  hik: {
    // EZVIZ / Hik-Connect Open Platform. Region host varies by account
    // (e.g. https://open.ezvizlife.com or https://isgpopen.ezvizlife.com).
    baseUrl: process.env.HIK_BASE_URL || "https://open.ezvizlife.com",
    appKey: process.env.HIK_APP_KEY || "",
    appSecret: process.env.HIK_APP_SECRET || "",
    // Cameras with "video encryption" on need their verification code (the
    // 6-letter sticker code) for live/snapshot calls. JSON by serial:
    // HIK_DEVICE_CODES={"E27757063":"ABCDEF"}
    deviceCodes: parseJsonEnv("HIK_DEVICE_CODES") || {},
    get configured() {
      return Boolean(this.appKey && this.appSecret);
    },
  },

  // ---- Building-system clouds (credential-based, like Amilia) ----
  // Each vendor's app/portal is cloud-backed, so the server can log in with the
  // owner's credentials. APIs are private/undocumented: the /api/<name>/debug
  // endpoints probe login routes so the mapping can be confirmed iteratively.

  // Pro1 IAQ thermostats (the Pro1 phone app's cloud).
  pro1: {
    baseUrl: process.env.PRO1_BASE_URL || "https://app.pro1iaq.com",
    email: process.env.PRO1_EMAIL || "",
    password: process.env.PRO1_PASSWORD || "",
    get configured() {
      return Boolean(this.email && this.password);
    },
  },

  // Napco alarm cloud. The building uses the "Gemini" commercial app (StarLink
  // Connect communicator), which logs in with a USERNAME (e.g. "Mat4185"), not
  // an email. NAPCO_EMAIL still accepted as an alias for the username field.
  napco: {
    baseUrl: process.env.NAPCO_BASE_URL || "",
    app: (process.env.NAPCO_APP || "gemini").toLowerCase(), // "gemini" | "ibridge" | "prima"
    username: process.env.NAPCO_USERNAME || process.env.NAPCO_EMAIL || "",
    password: process.env.NAPCO_PASSWORD || "",
    get email() { return this.username; }, // probe helper reads .email
    get configured() {
      return Boolean(this.username && this.password);
    },
  },

  // GeoVision doors. The building runs the GV-Access mobile app against an
  // on-prem GV-ASManager server (named "SQONE") with Controller 1 & 2. Since
  // the app works remotely, that server is reachable over the internet — set
  // GV_BASE_URL to the same host/DDNS + port the GV-Access app connects to.
  geovision: {
    baseUrl: process.env.GV_BASE_URL || "", // e.g. https://sqone.ddns.net:port
    username: process.env.GV_USERNAME || process.env.GV_EMAIL || "",
    password: process.env.GV_PASSWORD || "",
    get email() { return this.username; }, // probe helper reads .email
    get configured() {
      return Boolean(this.baseUrl && this.username && this.password);
    },
  },

  procare: {
    // ProCare has no broadly-available public API. If you obtain partner/API
    // access, set these. Until then the endpoint reports "not configured".
    baseUrl: process.env.PROCARE_BASE_URL || "",
    apiKey: process.env.PROCARE_API_KEY || "",
    get configured() {
      return Boolean(this.baseUrl && this.apiKey);
    },
  },

  // Owner alerts — e.g. "tell me when a new member joins". Two channels; each
  // is used when its vars are set (email via Resend is the easiest to set up,
  // SMS via Twilio when you want texts). The check runs on the /api/doors/run cron.
  alerts: {
    // Email (Resend — free tier): set RESEND_API_KEY + ALERT_EMAIL.
    email: process.env.ALERT_EMAIL || "",
    resendKey: process.env.RESEND_API_KEY || "",
    // Without a verified domain, Resend only delivers from onboarding@resend.dev
    // to the address you signed up with — sign up with the ALERT_EMAIL address.
    emailFrom: process.env.ALERT_EMAIL_FROM || "SquareOne Dashboard <onboarding@resend.dev>",
    // SMS (Twilio): destination in E.164 form (+19185551234); TWILIO_FROM is
    // your Twilio number.
    phone: process.env.ALERT_PHONE || "",
    twilio: {
      sid: process.env.TWILIO_ACCOUNT_SID || "",
      token: process.env.TWILIO_AUTH_TOKEN || "",
      from: process.env.TWILIO_FROM || "",
    },
    get emailConfigured() {
      return Boolean(this.email && this.resendKey);
    },
    get smsConfigured() {
      return Boolean(this.phone && this.twilio.sid && this.twilio.token && this.twilio.from);
    },
    get configured() {
      return this.emailConfigured || this.smsConfigured;
    },
  },

  // The built-in assistant agent (Claude). Needs an Anthropic API key.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
    get configured() {
      return Boolean(this.apiKey);
    },
  },

  // Booking-driven door schedule: unlock each access-controlled room before its
  // Amilia reservation starts and relock after it ends. Executed by /api/doors/run,
  // which a scheduler (GitHub Actions cron / cron-job.org) hits every few minutes.
  doors: {
    leadMin: Number(process.env.DOOR_UNLOCK_LEAD_MIN || 20),   // unlock N min before start
    lagMin: Number(process.env.DOOR_RELOCK_LAG_MIN || 30),     // relock N min after end
    lookbackMin: Number(process.env.DOOR_CRON_LOOKBACK_MIN || 30), // catch-up window for missed ticks
    // Explicit room -> door mapping, JSON: {"Gym/Auditorium": "fit", "Party Room": "main"}
    // (keys match Amilia location names, values are door ids from HA_ENTITIES).
    // Rooms not mapped here fall back to fuzzy name matching against door names.
    map: parseJsonEnv("DOOR_BOOKING_MAP") || {},
    // Shared secret the scheduler must send (Authorization: Bearer <secret>).
    cronSecret: process.env.CRON_SECRET || "",
  },

  // Booking-driven climate: bring each room to an "event" setpoint ahead of its
  // reservation, revert to an "idle" setpoint after — overlapping events in the
  // same zone hold the event setpoint until the last one clears. Executed by the
  // same /api/doors/run cron tick as the door schedule.
  climate: {
    preMin: Number(process.env.CLIMATE_PRE_LEAD_MIN || 60),   // condition N min before start
    postMin: Number(process.env.CLIMATE_POST_LAG_MIN || 60),  // set back N min after end
    eventTemp: Number(process.env.CLIMATE_EVENT_TEMP || 71),  // occupied setpoint (°F)
    idleTemp: Number(process.env.CLIMATE_IDLE_TEMP || 78),    // setback setpoint (°F)
    // Explicit room -> zone mapping, JSON: {"Gym/Auditorium": "fit"} (values are
    // zone ids from HA_ENTITIES). Unmapped rooms fall back to fuzzy name match.
    map: parseJsonEnv("CLIMATE_BOOKING_MAP") || {},
    // Per-zone setpoint overrides, JSON: {"fit": {"event": 68, "idle": 78}}
    setpoints: parseJsonEnv("CLIMATE_SETPOINTS") || {},
  },

  // The on-site hub: Home Assistant adapts the LAN devices (Gemini alarm,
  // Pro1 HVAC, GV-Access doors) and exposes one REST API.
  // Create a long-lived access token in HA: Profile -> Security -> Long-lived
  // access tokens. Then map your real entity_ids via HA_ENTITIES (JSON) or edit
  // the defaults below.
  homeassistant: {
    baseUrl: process.env.HA_BASE_URL || "", // e.g. http://homeassistant.local:8123
    token: process.env.HA_TOKEN || "",
    alarmCode: process.env.HA_ALARM_CODE || "", // only if your alarm panel requires one
    entities: parseEntities(process.env.HA_ENTITIES) || DEFAULT_HA_ENTITIES,
    get configured() {
      return Boolean(this.baseUrl && this.token);
    },
  },
};

// Wraps a provider handler so a missing config or upstream error never crashes
// the server — the frontend gets a clean JSON status it can fall back on.
export function guard(provider, handler) {
  return async (req, res) => {
    if (!config[provider].configured) {
      return res.status(200).json({
        ok: false,
        configured: false,
        provider,
        message: `${provider} is not configured. Add its keys to .env (see .env.example).`,
      });
    }
    try {
      const data = await handler(req, res);
      if (!res.headersSent) res.json({ ok: true, configured: true, provider, data });
    } catch (err) {
      console.error(`[${provider}]`, err.message);
      res.status(502).json({
        ok: false,
        configured: true,
        provider,
        message: `Upstream ${provider} request failed: ${err.message}`,
      });
    }
  };
}

// Small fetch helper with timeout + non-2xx -> throw.
export async function http(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const detail = typeof body === "string" ? body : JSON.stringify(body);
      throw new Error(`${res.status} ${res.statusText} — ${detail?.slice(0, 300)}`);
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}
