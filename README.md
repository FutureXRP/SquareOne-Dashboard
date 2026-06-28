# SquareOne Operations Center

One dashboard for the whole campus: security & climate (on-site systems) plus the
business side — room bookings, membership, cameras, and the Early Learning Center.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build into dist/
```

## Tabs

| Tab | Source | Status |
|-----|--------|--------|
| Home | all systems (summary) | preview |
| Security | Home Assistant hub (Gemini alarm, GV doors) | preview |
| Climate | Home Assistant hub (Pro1 HVAC) | preview |
| **Bookings** | **Amilia** (rooms booked today) | preview |
| **Members** | **Amilia** (counts, types, check-ins) | preview |
| **Cameras** | **Hik-Connect** (status, snapshots, live view) | preview |
| **ELC** | **ProCare** (attendance, staff ratios) | preview |
| Routines / Automation / Alerts / Assistant | derived | preview |

Everything currently runs in **preview mode** — it shows realistic sample data so
the UI can be reviewed before any live system is touched.

## Architecture: two kinds of system, two seams

`src/SquareOneOps.jsx` has exactly two places where live data is wired:

1. **`hub`** — on-site/LAN devices (alarm, HVAC, doors). These have no clean cloud
   API, so an on-site Home Assistant instance adapts all three and exposes one REST
   API. Every device *action* flows through `hub`.

2. **`api`** — cloud SaaS reads (Amilia, Hik-Connect, ProCare). These have secret API
   keys and block direct browser calls (CORS), so they **must** go through your own
   backend proxy. The browser calls `/api/...`; the proxy adds the secret key and
   talks to the vendor. Every cloud *read* flows through `api`.

Flip the flags in `CONNECTED` (top of `SquareOneOps.jsx`) as each integration goes live.

## Wiring live data (recommended order)

You need a small backend proxy (Node/Express, a serverless function, etc.) that holds
the keys. Uncomment the `/api` proxy in `vite.config.js` to point at it in dev.

### 1. Amilia (members + bookings) — easiest
- SmartRec has a documented REST API with OAuth2 (client credentials).
- Proxy endpoints to build: `GET /api/amilia/bookings?date=` and
  `GET /api/amilia/members/summary`.
- Then point `api.getBookings` / `api.getMembers` at them and set `CONNECTED.amilia = true`.

### 2. Hik-Connect (cameras)
- Status + snapshots are straightforward via the Hikvision Open Platform / partner API
  (or local HikCentral ISAPI on the LAN).
- **Live video** needs a streaming bridge (RTSP → HLS or WebRTC) running on the proxy;
  it cannot be embedded directly from the camera in a browser.
- Proxy endpoints: `GET /api/hik/cameras`, `GET /api/hik/cameras/{id}/snapshot.jpg`.

### 3. ProCare (ELC) — confirm access first
- ProCare does **not** publish a broadly-available public API. Before building this
  integration, confirm partner/API access for your account. A reports export may be
  the only option otherwise.
- Proxy endpoint: `GET /api/procare/elc/today`.

## Security notes
- No vendor API keys live in this repo or the browser bundle. Keep them server-side.
- `.env` files are gitignored. The proxy reads keys from its own environment.
