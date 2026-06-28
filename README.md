# SquareOne Operations Center

One dashboard for the whole campus: security & climate (on-site systems) plus the
business side — room bookings, membership, cameras, and the Early Learning Center.

## Run it

```bash
npm install
cp .env.example .env     # then fill in any credentials you have (optional)
npm run dev:all          # frontend (http://localhost:5173) + backend proxy together
```

Or run the two pieces separately:

```bash
npm run dev        # frontend only  -> http://localhost:5173
npm run server     # backend proxy  -> http://localhost:8787
npm run build      # production build of the frontend into dist/
```

**You don't need any credentials to run it.** With an empty `.env`, every tab shows
realistic sample data and the status bar marks each integration "sample". As you add
keys, those tabs flip to live automatically — no code change.

## Tabs

| Tab | Source | Live wiring |
|-----|--------|-------------|
| Home | all systems (summary) | — |
| Security | Home Assistant hub (Gemini alarm, GV doors) | ✅ built |
| Climate | Home Assistant hub (Pro1 HVAC) | ✅ built |
| **Bookings** | **Amilia** — rooms booked today | ✅ built |
| **Members** | **Amilia** — counts, types, check-ins | ✅ built |
| **Cameras** | **Hik-Connect** (EZVIZ Open Platform) | ✅ built |
| **ELC** | **ProCare** — attendance, staff ratios | ⚠️ needs API access |
| Routines / Automation / Alerts / Assistant | derived | — |

## Architecture: two kinds of system, two seams

`src/SquareOneOps.jsx` keeps a clean separation between the two integration styles:

1. **`hub`** — on-site/LAN devices (alarm, HVAC, doors). No clean cloud API, so an
   on-site Home Assistant instance adapts all three and exposes one REST API.
   `src/useHub.js` reads live state from `/api/hub/state` and routes every device
   *action* through the proxy to Home Assistant (`server/providers/homeassistant.js`).
   Optimistic locally; re-syncs from HA after each action. Falls back to preview
   when HA isn't configured.

2. **The backend proxy (`server/`)** — cloud SaaS reads (Amilia, Hik-Connect,
   ProCare). These have secret keys and block direct browser calls (CORS), so the
   browser only ever calls `/api/*`; the proxy adds the key and talks to the vendor.
   `src/useDashboardData.js` calls the proxy, detects what's configured via
   `/api/health`, and falls back to sample data for anything not set up.

```
browser ──/api/amilia/...──▶ server/ (holds keys) ──▶ app.amilia.com
        ──/api/hik/...─────▶                       ──▶ open.ezvizlife.com
        ──/api/procare/...─▶                       ──▶ (your ProCare access)
```

## Connecting each integration

Fill in the relevant section of `.env` (copied from `.env.example`) and restart the
proxy. The matching tab flips from "sample" to "live" on the next refresh.

### Home Assistant (alarm + HVAC + doors) — ready
- In Home Assistant: Profile → Security → **Long-lived access tokens** → create one.
- Set `HA_BASE_URL` (e.g. `http://homeassistant.local:8123`) and `HA_TOKEN`.
- Map the dashboard's door/zone ids to your real HA `entity_id`s — either edit
  `DEFAULT_HA_ENTITIES` in `server/config.js` or set `HA_ENTITIES` as a JSON string.
- If your alarm panel needs a code to arm/disarm, set `HA_ALARM_CODE`.
- Endpoints used: `GET /api/states/{id}` for state; `POST /api/services/{domain}/
  {service}` for `lock.lock`/`unlock`, `alarm_control_panel.alarm_arm_away`/
  `alarm_disarm`, `climate.set_temperature`. See `server/providers/homeassistant.js`.
- The Security/Climate tabs then control real devices and reflect real state.

### Amilia (members + bookings) — ready
- Make a dedicated service account in your Amilia org (its own email + password,
  in an "Integrations" permission group).
- Set `AMILIA_EMAIL`, `AMILIA_PASSWORD`, `AMILIA_ORG_ID` (numeric id or URL slug).
- Auth flow: `GET /api/V3/authenticate` (Basic auth) → JWT (cached ~1yr) → Bearer.
- Endpoints used: `/memberships` (+ each `/persons` count) and `/events` for the
  day's schedule. See `server/providers/amilia.js`.

### Hik-Connect cameras — ready
- Hik-Connect accounts are served by the **EZVIZ Open Platform**. Register a
  developer app at `open.ezvizlife.com` (or `open.ys7.com`), **matching the region**
  of the account that owns the cameras, to get an `appKey` + `appSecret`.
- Set `HIK_APP_KEY`, `HIK_APP_SECRET` (and `HIK_BASE_URL` for your region).
- Endpoints used: `token/get` (7-day token, cached, honors `areaDomain`),
  `device/list` (status), `device/capture` (snapshot), `live/address/get` (HLS).
  See `server/providers/hik.js`.
- Live video: camera tiles show snapshots; clicking a tile (or its "Live" button)
  opens an HLS player (`src/LivePlayer.jsx`, lazy-loaded) backed by
  `/api/hik/cameras/:id/live`. Works once Hik is configured and the camera is online.

### ProCare (ELC) — needs access confirmation first
- ProCare does **not** publish a broadly-available public API. Ask your ProCare rep
  whether partner/API access is available for your account.
- If you get it: set `PROCARE_BASE_URL`, `PROCARE_API_KEY`, then adjust the endpoint
  path/field mapping in `server/providers/procare.js` to match what they give you.
- Until then this tab stays on sample data and the UI says so.

## Security notes
- No vendor keys live in this repo or the browser bundle. They stay server-side.
- `.env` is git-ignored. The proxy reads keys from its own environment.
- Don't paste credentials into chat or commits — only into your local `.env`.
