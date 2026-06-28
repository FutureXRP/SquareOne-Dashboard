# Deployment & multi-account plan (Vercel + Supabase)

This is the target architecture for hosting SquareOne on Vercel with multi-user
login via Supabase. Nothing here is wired yet — it's the plan to review before we
restructure the working local app.

## The one hard constraint: Home Assistant is on your LAN

Vercel runs in the cloud and **cannot reach your on-site Home Assistant**. Every
cloud API (Amilia, Hik-Connect/EZVIZ, OKDHS imports) works fine from Vercel, but
the Security/Climate tabs need a path to HA. Pick one:

1. **Nabu Casa Cloud** (recommended) — HA's official remote service (~$6.50/mo).
   Gives a stable HTTPS URL + token. Set `HA_BASE_URL` to it and Vercel can control
   the campus. Simplest and most secure.
2. **Cloudflare Tunnel** (free) — a secure tunnel from your network to HA. More
   setup, no monthly fee.
3. **On-prem only** — keep hub control on a local box; the cloud app does everything
   except live campus control.

> Exposing door/alarm control to the internet raises the stakes: admin accounts
> get **MFA**, and the HA token is least-privilege.

## Target architecture

```
                         ┌──────────────────────────┐
  Browser (staff) ──────▶│  Vercel                  │
   - Supabase Auth JWT   │  • static frontend (Vite)│
                         │  • /api/* serverless fns │──▶ Amilia / EZVIZ / OKDHS
                         └──────────┬───────────────┘──▶ Home Assistant (via Nabu Casa/Tunnel)
                                    │ service role
                                    ▼
                         ┌──────────────────────────┐
                         │  Supabase                │
                         │  • Auth (users, roles)   │
                         │  • Postgres (config,     │
                         │    audit log, OKDHS data)│
                         │  • Storage (OKDHS files) │
                         │  • token cache           │
                         └──────────────────────────┘
```

### What changes from today
- **Express server → Vercel `/api` functions.** Each `server/providers/*` becomes a
  serverless route. Logic is the same; the entry shape changes.
- **Token caches move out of memory.** EZVIZ (7-day) and Amilia (JWT) tokens are
  currently cached in server memory — serverless functions don't keep memory between
  calls, so these move to a Supabase `token_cache` table (service-role only).
- **Secrets**: shared vendor keys live in **Vercel env vars**. Per-location secrets
  (if you run multiple sites) live encrypted in Supabase, read only by service-role
  functions. Nothing secret ever reaches the browser — same rule as today.
- **Auth gate**: the app requires Supabase login; every `/api` call verifies the
  user's JWT and role before touching a provider.

## Roles & access (multi-account)
- **admin** — everything, incl. settings, user management, emergency lockdown, MFA required.
- **manager** — operate all tabs (lock/unlock, climate, view reports), no settings/users.
- **staff** — read dashboards + run routines/checklists; no security actions.
- Multi-location ready: a user can be granted a role per location.

## Audit trail
Every device action and report import is written to `audit_log` (who, what, when,
detail). Critical for a system that controls physical security and touches children's
data.

## Step-by-step (when we proceed)
1. **Create accounts**: Supabase project + Vercel project; connect the GitHub repo.
2. **Run the schema** (`supabase/schema.sql`) in the Supabase SQL editor.
3. **Set env vars** in Vercel: vendor keys (from `.env.example`) + `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and HA remote URL/token.
4. **Restructure** backend into `/api` functions + add the Supabase client and login UI.
5. **Decide HA access** (Nabu Casa / Tunnel) and point `HA_BASE_URL` at it.
6. **Invite users**, assign roles, enable MFA for admins.
7. **Deploy** — Vercel auto-builds on push to `main`.

## Cost ballpark
- Vercel: free Hobby tier to start; Pro $20/mo if needed.
- Supabase: free tier to start; Pro ~$25/mo when you outgrow it.
- Nabu Casa (optional): ~$6.50/mo.

## Local dev still works
`npm run dev:all` keeps working throughout (Express + Vite). The serverless functions
are additive; we keep local dev runnable so you're never blocked.
