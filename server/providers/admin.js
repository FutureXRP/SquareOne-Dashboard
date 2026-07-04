import { Router } from "express";
import { supabaseAdmin, logAudit } from "../auth.js";

export const adminRouter = Router();

/*
  Admin-only team management. Mounted behind requireAuth + requireAdmin, so every
  route here already has an authenticated admin (req.user). Uses the Supabase
  service role to list/create auth users, manage roles (user_locations) and each
  user's visible tabs (user_prefs.tabs), and read the activity log (audit_log).
*/

// GET /api/admin/auth-check — verify Microsoft (Azure) sign-in is wired without
// requiring anyone to actually log in. Confirms the provider is enabled and that
// Supabase's authorize step produces a valid Microsoft URL with a real tenant
// (catches the "<tenant-id>" placeholder), then checks Microsoft accepts it.
adminRouter.get("/auth-check", async (_req, res) => {
  const url = process.env.SUPABASE_URL;
  const apikey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const out = { azureEnabled: null, tenant: null, microsoft: null, notes: [] };
  if (!url || !apikey) return res.json({ ok: true, data: { ...out, notes: ["Supabase URL/key not set on the server."] } });
  try {
    // 1. Which external providers are enabled?
    const settings = await fetch(`${url}/auth/v1/settings`, { headers: { apikey } }).then((r) => r.json()).catch(() => null);
    out.azureEnabled = settings?.external?.azure ?? null;

    // 2. Ask Supabase to begin the Azure handshake; it 302s to Microsoft.
    const authz = await fetch(`${url}/auth/v1/authorize?provider=azure`, { headers: { apikey }, redirect: "manual", signal: AbortSignal.timeout(9000) });
    const loc = authz.headers.get("location") || "";
    out.authorizeStatus = authz.status;
    if (!loc) { out.notes.push("Supabase did not return a Microsoft redirect — provider may be off or misconfigured."); return res.json({ ok: true, data: out }); }

    // 3. Read the tenant out of the Microsoft URL (…/login.microsoftonline.com/<tenant>/oauth2/…).
    let mUrl; try { mUrl = new URL(loc); } catch { /* not a URL */ }
    if (mUrl && /microsoftonline\.com$/i.test(mUrl.host)) {
      const tenant = mUrl.pathname.split("/").filter(Boolean)[0] || "";
      out.tenant = tenant;
      if (!tenant || tenant.includes("<") || tenant === "tenant-id") out.notes.push("Tenant is still the placeholder — replace <tenant-id> with your Directory (tenant) ID in Supabase.");

      // 4. Does Microsoft accept this tenant + client id? (No login performed.)
      try {
        const ms = await fetch(loc, { redirect: "manual", signal: AbortSignal.timeout(9000) });
        const body = await ms.text();
        const err = (body.match(/AADSTS\d+/) || [])[0];
        out.microsoft = {
          status: ms.status,
          ok: !err && (ms.status === 200 || ms.status === 302),
          error: err || undefined,
          hint: err === "AADSTS900023" ? "Invalid tenant — fix the Azure Tenant URL."
              : err === "AADSTS700016" ? "App/client ID not found in this tenant."
              : err === "AADSTS50011" ? "Redirect URI mismatch — register the Supabase callback in Entra."
              : undefined,
        };
      } catch (e) { out.microsoft = { error: e.message }; }
    } else {
      out.notes.push(`Unexpected redirect host: ${mUrl?.host || loc.slice(0, 60)}`);
    }
  } catch (e) { out.notes.push(`Check failed: ${e.message}`); }
  res.json({ ok: true, data: out });
});

async function firstLocationId() {
  const { data } = await supabaseAdmin.from("locations").select("id").order("created_at").limit(1).maybeSingle();
  if (data?.id) return data.id;
  const { data: made } = await supabaseAdmin.from("locations").insert({ name: "SquareOne Compassion" }).select("id").single();
  return made.id;
}

// GET /api/admin/users — everyone, with role, visible-tabs, and last sign-in.
adminRouter.get("/users", async (_req, res) => {
  try {
    const { data: list, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
    if (error) throw error;
    const users = list.users;
    const ids = users.map((u) => u.id);
    const [{ data: locs }, { data: prefs }] = await Promise.all([
      supabaseAdmin.from("user_locations").select("user_id, role").in("user_id", ids),
      supabaseAdmin.from("user_prefs").select("user_id, prefs").in("user_id", ids),
    ]);
    const roleBy = new Map();
    (locs || []).forEach((r) => { const cur = roleBy.get(r.user_id); if (cur !== "admin") roleBy.set(r.user_id, r.role); });
    const prefBy = new Map((prefs || []).map((p) => [p.user_id, p.prefs || {}]));
    res.json({ ok: true, data: users.map((u) => ({
      id: u.id, email: u.email, role: roleBy.get(u.id) || null,
      lastSignIn: u.last_sign_in_at, tabs: (prefBy.get(u.id) || {}).tabs || null,
    })) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// POST /api/admin/users { email, password, role } — create a login.
adminRouter.post("/users", async (req, res) => {
  const { email, password, role = "staff" } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, message: "Email and password are both required." });
  if (String(password).length < 8) return res.status(400).json({ ok: false, message: "Password must be at least 8 characters." });
  try {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    const loc = await firstLocationId();
    await supabaseAdmin.from("user_locations").upsert({ user_id: data.user.id, location_id: loc, role }, { onConflict: "user_id,location_id" });
    logAudit(req, "admin.create-user", data.user.id, { email, role });
    res.json({ ok: true, data: { id: data.user.id, email } });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// PUT /api/admin/users/:id/role { role }
adminRouter.put("/users/:id/role", async (req, res) => {
  const role = (req.body && req.body.role) || "staff";
  try {
    const loc = await firstLocationId();
    await supabaseAdmin.from("user_locations").upsert({ user_id: req.params.id, location_id: loc, role }, { onConflict: "user_id,location_id" });
    logAudit(req, "admin.set-role", req.params.id, { role });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// PUT /api/admin/users/:id/tabs { tabs: { security:false, ... } }
adminRouter.put("/users/:id/tabs", async (req, res) => {
  const tabs = (req.body && req.body.tabs) || {};
  try {
    const { data } = await supabaseAdmin.from("user_prefs").select("prefs").eq("user_id", req.params.id).maybeSingle();
    const prefs = { ...(data?.prefs || {}), tabs };
    await supabaseAdmin.from("user_prefs").upsert(
      { user_id: req.params.id, prefs, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    logAudit(req, "admin.set-tabs", req.params.id, { tabs });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// DELETE /api/admin/users/:id — remove a login.
adminRouter.delete("/users/:id", async (req, res) => {
  try {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.params.id);
    if (error) throw error;
    logAudit(req, "admin.delete-user", req.params.id, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// GET /api/admin/activity?kind=auth — recent activity, newest first.
adminRouter.get("/activity", async (req, res) => {
  try {
    let q = supabaseAdmin.from("audit_log").select("user_id, action, target, detail, created_at")
      .order("created_at", { ascending: false }).limit(150);
    if (req.query.kind === "auth") q = q.like("action", "auth.%");
    const { data: rows } = await q;
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
    const emailBy = new Map((list?.users || []).map((u) => [u.id, u.email]));
    res.json({ ok: true, data: (rows || []).map((r) => ({
      email: emailBy.get(r.user_id) || "—", action: r.action, target: r.target, detail: r.detail, at: r.created_at,
    })) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
