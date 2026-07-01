import { createClient } from "@supabase/supabase-js";

/*
  Server-side Supabase (service role) — used to verify the caller's JWT, write the
  audit log, and cache provider tokens. When SUPABASE_URL / SERVICE_ROLE_KEY are
  not set, auth is DISABLED and the API runs open (local dev / preview).

  The service role key is secret and only ever used here on the server.
*/
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseAdmin =
  url && serviceKey ? createClient(url, serviceKey, { auth: { persistSession: false } }) : null;
export const authEnabled = Boolean(supabaseAdmin);

// Express middleware: require a valid Supabase session when auth is enabled.
export async function requireAuth(req, res, next) {
  if (!authEnabled) return next(); // open mode
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, message: "Not signed in." });
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ ok: false, message: "Invalid or expired session." });
  req.user = data.user;
  next();
}

// Require the signed-in user to hold an 'admin' grant. Assumes requireAuth ran
// first (so req.user is set). In open/local mode (no Supabase) this allows through.
export async function requireAdmin(req, res, next) {
  if (!authEnabled) return next();
  if (!req.user) return res.status(401).json({ ok: false, message: "Not signed in." });
  try {
    const { data, error } = await supabaseAdmin
      .from("user_locations")
      .select("role")
      .eq("user_id", req.user.id)
      .eq("role", "admin")
      .limit(1);
    if (error) throw error;
    if (data && data.length) return next();
    return res.status(403).json({ ok: false, message: "Admin role required for this endpoint." });
  } catch (e) {
    return res.status(500).json({ ok: false, message: `Role check failed: ${e.message}` });
  }
}

// Best-effort audit entry. Never throws into the request path.
export async function logAudit(req, action, target, detail) {
  if (!authEnabled || !req?.user) return;
  try {
    await supabaseAdmin.from("audit_log").insert({
      user_id: req.user.id,
      action,
      target: target || null,
      detail: detail || {},
    });
  } catch (e) {
    console.warn("audit log failed:", e.message);
  }
}
