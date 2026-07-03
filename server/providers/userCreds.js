import { Router } from "express";
import { requireAuth, supabaseAdmin, authEnabled, logAudit } from "../auth.js";
import { encrypt, decrypt, cryptoReady } from "../crypto.js";
import { config } from "../config.js";

export const meRouter = Router();

/*
  Per-user vendor credentials, so alarm/door/camera actions are attributed to
  the real operator in the vendor's own logs instead of a shared account.

  - Stored encrypted (AES-GCM) in the service-role-only user_credentials table.
  - The browser can see WHETHER a credential is set and its username, never the
    secret. Managed under /api/me/credentials.
  - Providers call credsFor(req, provider) to get the acting user's login,
    falling back to the shared env credential when the user hasn't set their own.
  - Pro1 is intentionally not here — it permits only one login, so it stays a
    shared env credential for everyone.
*/

// Providers that support per-user credentials + their shared env fallback.
const PROVIDERS = {
  napco: () => ({ username: config.napco.username, secret: config.napco.password }),
  geovision: () => ({ username: config.geovision.username, secret: config.geovision.password }),
  hik: () => ({ username: "", secret: "" }), // Hik id is attribution-only (see note in README)
};

function isValid(p) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, p);
}

// Resolve the credential a device action should use: the signed-in user's own
// stored login if present, else the shared env fallback. Returns
// { username, secret, source: 'user'|'shared'|'none', actor }.
export async function credsFor(req, provider) {
  const fallback = () => {
    // Vault providers have an explicit env fallback; others (e.g. shared-only
    // Pro1) read straight from their config block.
    const f = PROVIDERS[provider]?.() || { username: config[provider]?.email || "", secret: config[provider]?.password || "" };
    return { ...f, source: f.username || f.secret ? "shared" : "none", actor: null };
  };
  // Only vault-backed providers consult per-user storage; the rest are shared.
  if (!isValid(provider) || !authEnabled || !req?.user || !cryptoReady) return fallback();
  try {
    const { data } = await supabaseAdmin
      .from("user_credentials")
      .select("username, secret_cipher")
      .eq("user_id", req.user.id)
      .eq("provider", provider)
      .maybeSingle();
    if (data && (data.username || data.secret_cipher)) {
      return {
        username: data.username || "",
        secret: data.secret_cipher ? decrypt(data.secret_cipher) : "",
        source: "user",
        actor: data.username || req.user.email || req.user.id,
      };
    }
  } catch (e) {
    console.warn(`credsFor(${provider}) fell back to shared:`, e.message);
  }
  return fallback();
}

// GET /api/me/credentials — status for the signed-in user (no secrets returned).
meRouter.get("/credentials", requireAuth, async (req, res) => {
  const out = {};
  for (const p of Object.keys(PROVIDERS)) out[p] = { username: "", hasSecret: false };
  if (authEnabled && req.user) {
    try {
      const { data } = await supabaseAdmin
        .from("user_credentials")
        .select("provider, username, secret_cipher")
        .eq("user_id", req.user.id);
      for (const row of data || []) {
        if (out[row.provider]) out[row.provider] = { username: row.username || "", hasSecret: Boolean(row.secret_cipher) };
      }
    } catch (e) {
      return res.status(500).json({ ok: false, message: e.message });
    }
  }
  res.json({ ok: true, data: { cryptoReady, authEnabled, providers: out } });
});

// PUT /api/me/credentials/:provider — save this user's own login for a provider.
meRouter.put("/credentials/:provider", requireAuth, async (req, res) => {
  const { provider } = req.params;
  if (!isValid(provider)) return res.status(400).json({ ok: false, message: "Unknown provider." });
  if (!authEnabled || !req.user) return res.status(401).json({ ok: false, message: "Sign in to save credentials." });
  const { username = "", secret = "" } = req.body || {};
  if (secret && !cryptoReady) {
    return res.status(503).json({ ok: false, message: "CREDENTIAL_KEY is not set on the server — can't store passwords yet." });
  }
  try {
    const row = { user_id: req.user.id, provider, username: username || null, updated_at: new Date().toISOString() };
    // Only replace the stored secret when a new one is supplied (empty = keep existing).
    if (secret) row.secret_cipher = encrypt(secret);
    await supabaseAdmin.from("user_credentials").upsert(row, { onConflict: "user_id,provider" });
    logAudit(req, "credentials.save", provider, { username: username || null, secretSet: Boolean(secret) });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// POST /api/me/activity { event } — record this user's sign-in / sign-out.
meRouter.post("/activity", requireAuth, async (req, res) => {
  const event = (req.body && req.body.event) || "";
  if (!["signin", "signout"].includes(event)) return res.status(400).json({ ok: false, message: "Unknown event." });
  await logAudit(req, `auth.${event}`, null, {});
  res.json({ ok: true });
});

// GET /api/me/prefs — this user's UI preferences (camera layout, etc.).
meRouter.get("/prefs", requireAuth, async (req, res) => {
  if (!authEnabled || !req.user) return res.json({ ok: true, data: {} });
  try {
    const { data } = await supabaseAdmin.from("user_prefs").select("prefs").eq("user_id", req.user.id).maybeSingle();
    res.json({ ok: true, data: data?.prefs || {} });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// PUT /api/me/prefs — shallow-merge a patch into this user's prefs blob.
meRouter.put("/prefs", requireAuth, async (req, res) => {
  if (!authEnabled || !req.user) return res.json({ ok: true }); // preview: client uses localStorage
  try {
    const patch = req.body && typeof req.body === "object" ? req.body : {};
    const { data } = await supabaseAdmin.from("user_prefs").select("prefs").eq("user_id", req.user.id).maybeSingle();
    const prefs = { ...(data?.prefs || {}), ...patch };
    await supabaseAdmin.from("user_prefs").upsert(
      { user_id: req.user.id, prefs, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
    res.json({ ok: true, data: prefs });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// DELETE /api/me/credentials/:provider — remove this user's stored login.
meRouter.delete("/credentials/:provider", requireAuth, async (req, res) => {
  const { provider } = req.params;
  if (!isValid(provider)) return res.status(400).json({ ok: false, message: "Unknown provider." });
  if (!authEnabled || !req.user) return res.status(401).json({ ok: false, message: "Sign in first." });
  try {
    await supabaseAdmin.from("user_credentials").delete().eq("user_id", req.user.id).eq("provider", provider);
    logAudit(req, "credentials.delete", provider, {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
