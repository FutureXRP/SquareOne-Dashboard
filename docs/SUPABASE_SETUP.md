# SquareOne Dashboard — Setup & Operations Guide

One place for everything: signing in, adding people, environment variables, and
the optional pieces. Written for a non-developer — follow top to bottom the first
time, then use it as a reference.

- **Live dashboard:** https://square-one-dashboard.vercel.app
- **Hosting:** Vercel (project `square-one-dashboard`)
- **Login / accounts / database:** Supabase
- **Code:** GitHub `futurexrp/squareone-dashboard`

---

## 0. The two Supabase areas (this trips everyone up)

Supabase has two separate sections you'll use:

| Section (left sidebar) | What it's for |
|---|---|
| **Authentication** | People's login accounts + passwords |
| **SQL Editor** | The database tables + granting admin |

Login accounts live in **Authentication**, NOT in the SQL. The SQL only stores
app data (roles, audit log, saved credentials, etc.).

---

## 1. First-time database setup (once)

1. Supabase → **SQL Editor → New query**.
2. Paste the entire contents of `supabase/schema.sql` and **Run**.
   - This builds every table, function, and security policy in one shot.
   - Run it **only once** — re-running errors on the policy lines (harmless, but
     it means it's already set up).

---

## 2. Environment variables (Vercel)

Vercel → project **square-one-dashboard** → **Settings → Environment Variables**.
Add each, keep all environments checked, then **redeploy** (Deployments → ⋯ →
Redeploy) so they take effect.

### Required — sign-in / database
From Supabase → **Project Settings → API**:

| Variable | Supabase value |
|---|---|
| `VITE_SUPABASE_URL` | Project URL |
| `VITE_SUPABASE_ANON_KEY` | `anon` `public` key |
| `SUPABASE_URL` | same Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` `secret` key |

> `VITE_` values are safe in the browser; `service_role` is secret (server only).

### Required — stored device passwords
| Variable | Value |
|---|---|
| `CREDENTIAL_KEY` | any long random string (encrypts saved alarm/door logins). **Never change it** once people save credentials — that makes saved passwords unreadable. |

### Optional — overnight automation & alerts backstop
| Variable | Value |
|---|---|
| `CRON_SECRET` | any long random string (also add to GitHub, below) |

### Optional — email alerts (new-member sign-ups)
| Variable | Value |
|---|---|
| `RESEND_API_KEY` | from resend.com |
| `ALERT_EMAIL` | where alerts are sent |

### Already set (integrations that are live)
`AMILIA_*`, `HIK_APP_KEY`, `HIK_APP_SECRET` (and `HIK_DEVICE_CODES` for encrypted
cameras). Building systems, when mapped: `PRO1_*`, `NAPCO_*`, `GV_*`.

---

## 3. GitHub secrets (for the every-5-minute background job)

Only needed to run automation/alerts when nobody has the dashboard open.
GitHub → repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `CRON_SECRET` | the **same** string as in Vercel |
| `DASHBOARD_URL` | `https://square-one-dashboard.vercel.app` |

---

## 4. Create a login account

Authentication has no self-signup by default — create accounts here:

1. Supabase → **Authentication → Users → Add user → Create new user**.
2. Enter **email** + a **password**, check **Auto Confirm User**, **Create user**.
3. That email + password is now that person's dashboard login
   (**"use password instead"** on the login screen).

> Magic-link email sign-in also works, but Supabase's built-in email is
> rate-limited (a few per hour) — the password path above avoids that entirely.

**Important:** set Supabase → **Authentication → URL Configuration**:
- **Site URL:** `https://square-one-dashboard.vercel.app`
- **Redirect URLs:** add `https://square-one-dashboard.vercel.app/**`

(Otherwise magic links try to open `localhost` and fail.)

---

## 5. Grant admin rights

An account must exist (step 4, or one sign-in) **before** it can be granted admin.
Supabase → **SQL Editor**, edit the emails, **Run**:

```sql
insert into user_locations (user_id, location_id, role)
select u.id, l.id, 'admin'
from auth.users u
cross join (select id from locations where name = 'SquareOne Compassion'
            order by created_at limit 1) l
where u.email in (
  'the5blairsworld@gmail.com',
  'matt@squareonecompassion.com',
  'justin@squareonecompassion.com'
  -- add more emails here
)
on conflict (user_id, location_id) do update set role = 'admin';
```

If a row reports **0 rows**, that account isn't created yet — do step 4 first.

Roles are `admin`, `manager`, or `staff`. To make someone non-admin, use
`'staff'` or `'manager'` instead of `'admin'`.

**Verify:**
```sql
select u.email, ul.role
from user_locations ul join auth.users u on u.id = ul.user_id
order by ul.role;
```

---

## 6. Per-user device credentials (attribution)

So alarm/door actions show the real operator in the vendor's logs:

1. Server must have `CREDENTIAL_KEY` set (step 2).
2. Each person signs in → **Settings** tab → enters their own **Gemini alarm**
   and **GV-Access** logins (and **Hik** user id).
3. Pro1 thermostats use one shared login (Pro1 allows only one) — dashboard
   actions are still logged against the person's dashboard sign-in.

Passwords are encrypted server-side and never shown again.

---

## 7. Microsoft (Entra) sign-in — optional, when ready

Not required. When you want staff to log in with Microsoft, follow
`docs/AUTH_AND_CREDENTIALS.md` (register an Entra app + enable the Azure provider
in Supabase). The "Sign in with Microsoft" button stays inert until then.

---

## Quick "add a new person" checklist

1. Authentication → Users → **Add user** (email + password + Auto Confirm).
2. If they need admin: run the step-5 SQL with their email.
3. Give them the URL + their password. Done.

---

## Integration status (living list)

| System | Status |
|---|---|
| Amilia (members, revenue, bookings) | ✅ Live |
| Cameras (Hik / EZVIZ) | ✅ Live — channel enumeration for NVR/DVR cameras |
| Email alerts (new members) | ✅ Wired (needs `RESEND_API_KEY`) |
| Door + climate booking automation | ⏳ Built; runs once doors/thermostats connect |
| Pro1 thermostats / Napco alarm / GV-Access doors | 🔧 Cloud login probes built; mapping in progress |
| Home Assistant hub | ⏳ Optional; not required for the above |
