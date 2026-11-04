import { supabaseAdmin, authEnabled } from "./auth.js";

/*
  Provider token cache that survives serverless cold/warm boundaries.

  On Vercel each function invocation may be a fresh process, so module-level
  variables can't reliably hold the EZVIZ (7-day) token or the Amilia JWT. When
  Supabase is configured we persist them in the token_cache table (service-role
  only). Locally (no Supabase) we fall back to an in-process Map.
*/
const mem = new Map();
const SKEW = 60_000; // refresh a minute before expiry

export async function getCachedToken(provider, scope = "default") {
  if (authEnabled) {
    const { data } = await supabaseAdmin
      .from("token_cache")
      .select("token, meta, expires_at")
      .eq("provider", provider)
      .eq("scope", scope)
      .maybeSingle();
    if (data && new Date(data.expires_at).getTime() > Date.now() + SKEW) {
      return { token: data.token, meta: data.meta || {} };
    }
    return null;
  }
  const m = mem.get(`${provider}:${scope}`);
  if (m && m.expiresAt > Date.now() + SKEW) return { token: m.token, meta: m.meta };
  return null;
}

// Every live entry for a provider, as { scope, token, meta }. Used by the
// booking scheduler to find doors/thermostats it still holds, even when no
// current booking refers to them any more (cancelled mid-window).
export async function listCachedTokens(provider) {
  const now = Date.now() + SKEW;
  if (authEnabled) {
    const { data } = await supabaseAdmin
      .from("token_cache")
      .select("scope, token, meta, expires_at")
      .eq("provider", provider);
    return (data || [])
      .filter((r) => new Date(r.expires_at).getTime() > now)
      .map((r) => ({ scope: r.scope, token: r.token, meta: r.meta || {} }));
  }
  const out = [];
  for (const [k, m] of mem) {
    if (k.startsWith(`${provider}:`) && m.expiresAt > now) out.push({ scope: k.slice(provider.length + 1), token: m.token, meta: m.meta });
  }
  return out;
}

export async function setCachedToken(provider, scope, token, meta, expiresAtMs) {
  if (authEnabled) {
    await supabaseAdmin.from("token_cache").upsert({
      provider,
      scope,
      token,
      meta: meta || {},
      expires_at: new Date(expiresAtMs).toISOString(),
    });
    return;
  }
  mem.set(`${provider}:${scope}`, { token, meta: meta || {}, expiresAt: expiresAtMs });
}
