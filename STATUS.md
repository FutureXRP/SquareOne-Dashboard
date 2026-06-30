# Project status & go-live checklist

Last updated: 2026-06-29. This is the handoff doc — where the project stands and
exactly what's left to make every integration live. Start here.

- **Live preview (PR #1):** https://square-one-dashboard-git-claude-0755ab-matts-projects-9e884c31.vercel.app
- **Run locally:** see [README.md](README.md) → "Run it" (`npm install` → `npm run dev:all`).
- **Architecture:** [README.md](README.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## TL;DR
The app is **fully built and deploys to Vercel**. Everything runs *today* on
realistic sample data with no credentials. Going live = creating accounts and
pasting keys (mostly **owner** actions), plus two genuine build tasks (ProCare
import, OKDHS import) and the on-site **hardware** for Home Assistant.

Legend — **Owner** = account/keys/hardware only the business owner can do ·
**Dev** = code work a developer can do · **Built** = code is done.

---

## Where each piece stands

| Area | Code | Live? | What's left to go live | Who |
|---|---|---|---|---|
| Dashboard UI (11 tabs) | ✅ Built | ✅ runs on sample data | — | — |
| Backend proxy (`/api/*`) | ✅ Built | ✅ deploys on Vercel | — | — |
| Vercel deployment | ✅ Built | ⚠️ preview only | Set env vars; merge PR #1 for production | Owner |
| CI (build check) | ✅ Built | ✅ green on PR #1 | (optional) branch protection on `main` | Owner |
| Supabase auth / roles / audit | ✅ Built | ❌ not configured | Create project, run schema, set keys, make first admin | Owner |
| **Amilia** (members + bookings) | ✅ Built | ❌ needs keys | Service account + org id → env; verify field mapping | Owner + Dev |
| **Hik-Connect** cameras + live HLS | ✅ Built | ❌ needs keys | EZVIZ developer appKey/secret (NA region) → env | Owner |
| **AI assistant** (Claude agent) | ✅ Built | ❌ needs key | `ANTHROPIC_API_KEY` → env (real actions also need the hub) | Owner |
| **Home Assistant** (alarm/HVAC/doors) | ✅ Built | ❌ needs hardware | On-site box + device bridges + token + entity map + tunnel | Owner + Dev |
| **ProCare** (ELC) | ⚠️ Stub only | ❌ no public API | Confirm API access, or build CSV/report import | Owner + Dev |
| **OKDHS / OKConnectECC** | ❌ Not built | ❌ no public API | Build report-upload importer (needs a sample export) | Owner + Dev |

---

## Fastest path to a working cloud demo (no hardware)
These four light up the dashboard with real data from anywhere — no on-site gear:

1. **Supabase** (multi-account login) — Owner
2. **Amilia** (members + bookings) — Owner + Dev verify
3. **Hik-Connect** (cameras) — Owner
4. **AI assistant** — Owner (it'll answer/read; physical actions wait on the hub)

Do these first; tackle Home Assistant, ProCare, and OKDHS after.

---

## Step-by-step to complete the live implementation

### 1. Supabase — multi-account login (Owner)
- [ ] Create a free project at supabase.com.
- [ ] Run [`supabase/schema.sql`](supabase/schema.sql) in the SQL editor.
- [ ] Copy Project URL + `anon` key + `service_role` key.
- [ ] Set env vars (local `.env` and Vercel): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- [ ] Sign up via the login screen, then in Supabase add a `locations` row and a `user_locations` row granting yourself `admin`.
- [ ] Invite staff; assign `manager` / `staff`. Enable MFA for admins.

### 2. Vercel — production (Owner)
- [ ] In the Vercel project → Settings → Environment Variables, add every key you use (Supabase + the vendor keys below). Already connected and deploying previews.
- [ ] Merge PR #1 to `main` → production deploys automatically.
- [ ] (Optional) GitHub → Settings → Branches → require PR + passing CI on `main`.

### 3. Amilia — members + bookings (Owner + Dev)
- [ ] Owner: create a dedicated service account in Amilia (own email/password, "Integrations" permission group). Note the org id (numeric or URL slug).
- [ ] Set env: `AMILIA_EMAIL`, `AMILIA_PASSWORD`, `AMILIA_ORG_ID`, `AMILIA_LANG=en`.
- [ ] Dev: confirm the Bookings tab maps to the right Amilia data. The code uses the **events** feed; if "rooms booked" should come from **facility reservations** instead, adjust `server/providers/amilia.js`. Verify field names against live responses.

### 4. Hik-Connect — cameras (Owner)
- [ ] Register a developer app at **`iusopen.ezviz.com`** (North America), matching the region of the account your cameras are on. (The old `open.ezvizlife.com` is dead.)
- [ ] Confirm your cameras appear in that account (Console → Device Management).
- [ ] Set env: `HIK_APP_KEY`, `HIK_APP_SECRET`, and `HIK_BASE_URL` for your region.
- [ ] Dev (if needed): confirm the NA token host; the code auto-follows the region redirect after the first call.

### 5. AI assistant (Owner)
- [ ] Set `ANTHROPIC_API_KEY` (from console.anthropic.com). Optional `ANTHROPIC_MODEL`.
- [ ] Dev: once a key exists, smoke-test a real conversation (the live LLM loop hasn't been exercised end-to-end yet). Physical actions require the hub (below).

### 6. Home Assistant — alarm / HVAC / doors (Owner + Dev) — the big one
This needs **hardware on-site** (see the Hardware section) plus wiring:
- [ ] Owner: stand up a Home Assistant box on the campus LAN.
- [ ] Owner + Dev: bridge each system to HA — **Napco Gemini** alarm, **Pro1** thermostats, **GV-Access** doors (each needs its own integration or a relay/Z-Wave bridge — see Hardware).
- [ ] Owner: in HA create a Long-Lived Access Token (Profile → Security).
- [ ] Set env: `HA_BASE_URL`, `HA_TOKEN`, optional `HA_ALARM_CODE`.
- [ ] Map the dashboard's door/zone ids to real HA `entity_id`s via `HA_ENTITIES` (JSON) or `DEFAULT_HA_ENTITIES` in `server/config.js`.
- [ ] For cloud control (Vercel → LAN), set up a **Cloudflare Tunnel** (free) and point `HA_BASE_URL` at it. (Or Nabu Casa Cloud, ~$6.50/mo.)

### 7. ProCare — ELC (Owner + Dev)
- [ ] Owner: ask your ProCare rep whether **partner/API access** exists for your account.
- [ ] If yes: set `PROCARE_BASE_URL`, `PROCARE_API_KEY`; Dev maps the real endpoint/fields in `server/providers/procare.js` (currently a placeholder).
- [ ] If no: Dev builds a **CSV/report import** (Owner exports from ProCare → uploads → dashboard parses). Not built yet.

### 8. OKDHS / OKConnectECC — childcare subsidy (Owner + Dev)
- [ ] No public API (Conduent EPPIC; possible move to Tyler Technologies — verify with OKDHS). Scraping is off-limits.
- [ ] Owner: log into OKConnectECC, export an attendance/payment report; tell us the **format (CSV/Excel/PDF) and columns** (redact real PII).
- [ ] Dev: build an "Import OKDHS report" upload into the ELC tab + a parser. Not built yet.
- [ ] Optional: public **OK Child Care Locator** (`ccl.dhs.ok.gov`) licensing feed — automatable, not built yet.

---

## On-site hardware still needed (for Home Assistant)
- [ ] **HA host** — Home Assistant Green / Raspberry Pi 5 + SSD / mini PC.
- [ ] **UPS** for the HA box and network gear.
- [ ] **Z-Wave/Zigbee USB stick** (if the Pro1 thermostats or locks use those radios).
- [ ] **Alarm bridge** for the Napco Gemini panel (IP/serial module or a Konnected-style relay board).
- [ ] **Door bridge** for GV-Access (Geovision ASManager + API, or Shelly/Konnected relays on the strikes).
- [ ] **PoE switch** (if cameras are wired) — cameras themselves already work via the EZVIZ cloud.
- [ ] **Wall tablet/TV + mount** to display the dashboard.

Exact bridge models depend on the panel/thermostat/controller model numbers — share those and we'll pin the parts.

---

## Known limitations / risks
- **Home Assistant is LAN-only** — the cloud app can't reach it without a tunnel.
- **ProCare** has no broadly available public API.
- **OKDHS** has no provider API; integration is manual import only.
- **Possible OKDHS vendor migration** (Conduent → Tyler) — verify before investing.
- The **live AI agent loop** hasn't been run end-to-end (no key in the build env).
- Secrets live only in `.env` (local) / Vercel env vars — never in the repo.

---

## Where things live in the code
- Frontend: `src/` — `SquareOneOps.jsx` (UI), `App.jsx`/`Login.jsx`/`useAuth.js` (auth), `useHub.js` (campus state), `useDashboardData.js` (cloud tabs), `LivePlayer.jsx` (camera HLS), `lib/` (Supabase + authed fetch).
- Backend: `server/` — `app.js` (routes), `auth.js` (JWT + audit), `haService.js` (HA ops), `tokenStore.js` (token cache), `providers/*` (amilia, hik, procare, homeassistant, assistant).
- Deploy: `api/[...path].js` (Vercel function), `vercel.json`, `.github/workflows/ci.yml`.
- Config: `.env.example` (every env var, documented), `supabase/schema.sql` (DB).
