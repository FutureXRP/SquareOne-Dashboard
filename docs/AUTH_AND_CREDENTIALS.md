# Microsoft sign-in + per-user vendor credentials

Two related capabilities, built so that **device actions are attributed to the
real person**, not a shared account:

1. **Microsoft (Entra ID) sign-in** — staff log into the dashboard with their
   work Microsoft account.
2. **Per-user credential vault** — each person stores their own Gemini alarm and
   GV-Access door logins (and Hik user id) on the **Settings** tab. When they arm
   the alarm or unlock a door, the dashboard acts as *them*, so the vendor's own
   log shows who did it.

Pro1 thermostats are the exception: Pro1 allows only one login, so everyone
shares it. Dashboard actions are still logged against the user's dashboard sign-in.

---

## 1. Microsoft sign-in (Supabase + Entra)

This is configured in Supabase and Microsoft Entra — no code changes.

**In Microsoft Entra admin center (your IT guy):**
1. **App registrations → New registration.** Name it e.g. "SquareOne Dashboard".
2. Supported account types: your org (single-tenant) is fine.
3. **Redirect URI** (Web): `https://<your-project>.supabase.co/auth/v1/callback`
   (copy the exact value from Supabase → Authentication → Providers → Azure).
4. After creating it, note the **Application (client) ID** and **Directory
   (tenant) ID**.
5. **Certificates & secrets → New client secret.** Copy the secret **value**.
6. **API permissions:** Microsoft Graph → delegated → `email`, `openid`,
   `profile` (add `User.Read`). Grant admin consent.

**In Supabase → Authentication → Providers → Azure:**
- Enable it, paste the **client ID**, **secret value**, and set the **Azure
  Tenant URL** to `https://login.microsoftonline.com/<tenant-id>`.
- Add your dashboard URL under Authentication → URL Configuration → Redirect URLs
  (e.g. `https://square-one-dashboard.vercel.app`).

The "Sign in with Microsoft" button on the login screen then works. Existing
email/password and magic-link sign-in keep working alongside it.

> Roles (admin/manager/staff) are still assigned in the `user_locations` table
> regardless of how the person signs in.

---

## 2. Per-user credential vault

**One-time server setup (Vercel env vars):**
- `CREDENTIAL_KEY` — any long random string. It encrypts stored passwords
  (AES-256-GCM). Keep it stable: changing it makes existing stored secrets
  unreadable (users just re-enter them).
- Apply the updated `supabase/schema.sql` (adds the `user_credentials` table,
  service-role-only).

**How people use it:** each signed-in user opens **Settings** and enters their
own:
- **Gemini Alarm** — Napco Gemini username + password
- **GV-Access Doors** — GV-Access username + password
- **Hik Cameras** — Hik-Connect user id (attribution label)

**Security properties:**
- Passwords are encrypted server-side; the browser never gets a stored secret
  back (the Settings page only shows whether one is set).
- The `user_credentials` table is service-role only (RLS denies all client
  access) — even the ciphertext never reaches a browser.
- When an action runs, the server uses the acting user's stored login and falls
  back to the shared env credential only if they haven't set their own.
