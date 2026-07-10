import { Router } from "express";
import { supabaseAdmin, logAudit, firstLocationId } from "../auth.js";
import { getRoleTabs } from "./userCreds.js";
import { config } from "../config.js";

export const adminRouter = Router();

// Business entities a staffer can belong to (scopes which tabs they see).
const ENTITIES = ["medical", "interactive", "elc"];

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

// GET /api/admin/users — the whole team picture: active users (with role, tabs,
// last sign-in), pending invites (authorized but not yet signed in), and the
// role-based tab buckets. Everyone signs in with Microsoft, so there's no
// account creation here — only authorization.
adminRouter.get("/users", async (_req, res) => {
  // Each read is isolated so one missing table (e.g. invites/app_settings not yet
  // created) can't take down the whole panel — it surfaces in `warnings` instead.
  const warnings = [];
  const safe = async (label, q) => {
    try { const { data, error } = await q; if (error) throw error; return data || []; }
    catch (e) { warnings.push(`${label}: ${e.message}`); return []; }
  };
  try {
    const { data: list, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
    if (error) throw error;
    const users = list.users;
    const ids = users.map((u) => u.id);
    const locs = ids.length ? await safe("user_locations", supabaseAdmin.from("user_locations").select("user_id, role").in("user_id", ids)) : [];
    const prefs = ids.length ? await safe("user_prefs", supabaseAdmin.from("user_prefs").select("user_id, prefs").in("user_id", ids)) : [];
    const profs = ids.length ? await safe("profiles", supabaseAdmin.from("profiles").select("id, full_name, entity").in("id", ids)) : [];
    const invites = await safe("invites", supabaseAdmin.from("invites").select("email, role, name, entity, created_at").order("created_at", { ascending: false }));
    let roleTabs = {};
    try { roleTabs = await getRoleTabs(); } catch (e) { warnings.push(`app_settings: ${e.message}`); }
    const roleBy = new Map();
    (locs || []).forEach((r) => { const cur = roleBy.get(r.user_id); if (cur !== "admin") roleBy.set(r.user_id, r.role); });
    const prefBy = new Map((prefs || []).map((p) => [p.user_id, p.prefs || {}]));
    const nameBy = new Map((profs || []).map((p) => [p.id, p.full_name]));
    const entityBy = new Map((profs || []).map((p) => [p.id, p.entity]));
    // A profile's full_name defaults to the email on signup — treat that as "no
    // preferred name set" so the UI shows a placeholder rather than the raw email.
    const preferredName = (u) => { const n = nameBy.get(u.id); return n && n !== u.email ? n : null; };
    // Only surface users who actually have access (a role) — auth.users may hold
    // stragglers who signed in before invite-only or were never authorized.
    const activeUsers = users
      .filter((u) => roleBy.has(u.id))
      .map((u) => ({ id: u.id, email: u.email, name: preferredName(u), entity: entityBy.get(u.id) || null, role: roleBy.get(u.id), lastSignIn: u.last_sign_in_at, tabs: (prefBy.get(u.id) || {}).tabs || null }));
    res.json({ ok: true, data: { users: activeUsers, invites: invites || [], roleTabs, warnings } });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// POST /api/admin/invites { email, role } — authorize a Microsoft account. When
// that person next signs in, they're granted this role automatically.
adminRouter.post("/invites", async (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const role = (req.body && req.body.role) || "staff";
  const name = String((req.body && req.body.name) || "").trim() || null;
  const entity = ENTITIES.includes(req.body?.entity) ? req.body.entity : null;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, message: "A valid email is required." });
  if (!["staff", "manager", "admin"].includes(role)) return res.status(400).json({ ok: false, message: "Invalid role." });
  try {
    // If they've already signed in, just set the role directly instead.
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
    const existing = (list?.users || []).find((u) => (u.email || "").toLowerCase() === email);
    if (existing) {
      const loc = await firstLocationId();
      await supabaseAdmin.from("user_locations").upsert({ user_id: existing.id, location_id: loc, role }, { onConflict: "user_id,location_id" });
      if (name || entity) await supabaseAdmin.from("profiles").upsert({ id: existing.id, ...(name ? { full_name: name } : {}), entity }, { onConflict: "id" });
      logAudit(req, "admin.set-role", existing.id, { email, role, entity });
      return res.json({ ok: true, data: { email, role, status: "active" } });
    }
    await supabaseAdmin.from("invites").upsert({ email, role, name, entity, invited_by: req.user.id }, { onConflict: "email" });
    logAudit(req, "admin.invite", email, { role, entity });
    res.json({ ok: true, data: { email, role, status: "invited" } });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// PUT /api/admin/invites/:email { role?, name?, entity? } — edit a pending invite.
adminRouter.put("/invites/:email", async (req, res) => {
  const email = String(req.params.email || "").toLowerCase();
  const patch = {};
  if (req.body?.role !== undefined) {
    if (!["staff", "manager", "admin"].includes(req.body.role)) return res.status(400).json({ ok: false, message: "Invalid role." });
    patch.role = req.body.role;
  }
  if (req.body?.name !== undefined) patch.name = String(req.body.name || "").trim() || null;
  if (req.body?.entity !== undefined) patch.entity = ENTITIES.includes(req.body.entity) ? req.body.entity : null;
  if (!Object.keys(patch).length) return res.status(400).json({ ok: false, message: "Nothing to update." });
  try {
    await supabaseAdmin.from("invites").update(patch).eq("email", email);
    logAudit(req, "admin.invite-update", email, patch);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// PUT /api/admin/users/:id/name { name } — set a person's preferred/display name.
adminRouter.put("/users/:id/name", async (req, res) => {
  const name = String(req.body?.name || "").trim() || null;
  try {
    await supabaseAdmin.from("profiles").upsert({ id: req.params.id, full_name: name }, { onConflict: "id" });
    logAudit(req, "admin.set-name", req.params.id, { name });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// PUT /api/admin/users/:id/entity { entity } — set a person's entity (staff scoping).
adminRouter.put("/users/:id/entity", async (req, res) => {
  const entity = ENTITIES.includes(req.body?.entity) ? req.body.entity : null;
  try {
    await supabaseAdmin.from("profiles").upsert({ id: req.params.id, entity }, { onConflict: "id" });
    logAudit(req, "admin.set-entity", req.params.id, { entity });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// POST /api/admin/invites/:email/send — email the person a sign-in invite via
// Resend. Note: inviting doesn't otherwise send anything (access is granted when
// they sign in with Microsoft) — this is an explicit "here's how to get in" note.
adminRouter.post("/invites/:email/send", async (req, res) => {
  const email = String(req.params.email || "").toLowerCase();
  if (!config.alerts.resendKey) return res.status(400).json({ ok: false, message: "No email service configured (set RESEND_API_KEY)." });
  try {
    const { data: inv } = await supabaseAdmin.from("invites").select("role, name").eq("email", email).maybeSingle();
    const base = process.env.APP_URL || `https://${req.get("host")}`;
    const first = inv?.name ? inv.name.split(" ")[0] : "there";
    const role = inv?.role || "staff";
    const subject = "Your SquareOne Operations dashboard access";
    const text = `Hi ${first},\n\nYou've been given ${role} access to the SquareOne Operations dashboard.\n\nTo sign in:\n1. Go to ${base}\n2. Click "Sign in with Microsoft"\n3. Use your work email (${email}) — no new password needed.\n\nThat's it — see you inside.\n— SquareOne Compassion`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.alerts.resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.alerts.emailFrom, to: [email], subject, text }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body?.error) {
      const m = body?.error?.message || body?.message || `Email service returned ${r.status}.`;
      return res.status(502).json({ ok: false, message: m });
    }
    logAudit(req, "admin.invite-email", email, {});
    res.json({ ok: true, data: { email, sent: true } });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// DELETE /api/admin/invites/:email — cancel a pending invite.
adminRouter.delete("/invites/:email", async (req, res) => {
  try {
    const email = String(req.params.email || "").toLowerCase();
    await supabaseAdmin.from("invites").delete().eq("email", email);
    logAudit(req, "admin.invite-cancel", email, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// GET/PUT /api/admin/role-tabs — the role-based tab buckets (manager/staff).
adminRouter.put("/role-tabs", async (req, res) => {
  const role = (req.body && req.body.role) || "";
  const tabs = (req.body && req.body.tabs) || {};
  if (!["manager", "staff"].includes(role)) return res.status(400).json({ ok: false, message: "Role must be manager or staff." });
  try {
    const current = await getRoleTabs();
    const value = { ...current, [role]: tabs };
    await supabaseAdmin.from("app_settings").upsert({ key: "role_tabs", value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    logAudit(req, "admin.role-tabs", role, { tabs });
    res.json({ ok: true, data: value });
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
