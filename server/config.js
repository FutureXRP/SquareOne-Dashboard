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
    get configured() {
      return Boolean(this.appKey && this.appSecret);
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
