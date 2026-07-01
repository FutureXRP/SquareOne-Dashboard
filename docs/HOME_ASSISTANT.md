# Home Assistant setup — campus control (alarm, thermostats, doors)

Home Assistant (HA) is the on-site hub that lets the dashboard control the three
LAN-bound systems: the **Napco Gemini alarm**, the **Pro1 thermostats**, and the
**GV-Access doors**. None of them has a usable cloud API, so HA runs on your
building network, adapts all three, and the dashboard talks to HA through one
clean token. The dashboard code for this is already built (`server/haService.js`,
`server/providers/homeassistant.js`, `src/useHub.js`) — this guide is the
on-site + config work.

> Do this in phases. Prove the pipeline (Phases 1–2) before the hard device
> bridges (Phase 3). Share this file with your IT guy / alarm installer.

---

## Phase 1 — Get Home Assistant running (~1 evening)

**Pick a box (choose one):**
- **Home Assistant Green** (~$99) — plug-and-play, easiest. *Recommended.*
- **Raspberry Pi 5 + SSD** — cheap, flexible.
- **Mini PC / Intel NUC** running HA OS — most headroom (good if you'll add lots).

**Also get:** a small **UPS** for the HA box + network gear (so security survives a blip).

**Install:**
1. Flash Home Assistant OS (HA Green comes with it; for Pi/mini-PC use the HA OS image + Raspberry Pi Imager / Balena Etcher).
2. Plug it into your network by **Ethernet** (wired is more reliable for security gear).
3. Open `http://homeassistant.local:8123` from a computer on the same network, create the owner account, and finish onboarding.
4. Note its address — `http://homeassistant.local:8123` or `http://<device-IP>:8123`.

---

## Phase 2 — Connect HA to the dashboard (~30 min)

### 2a. Long-lived access token
In HA: **Profile → Security → Long-lived access tokens → Create Token**. Copy it
(shown once).

### 2b. Make HA reachable from the cloud (Cloudflare Tunnel — free)
Vercel can't reach your LAN, so expose HA securely:
1. Install `cloudflared` on a machine on the HA network (or the HA "Cloudflared" add-on).
2. `cloudflared tunnel login`, then `cloudflared tunnel create squareone-ha`.
3. Route a hostname to HA: point the tunnel's ingress at `http://homeassistant.local:8123`
   and map a DNS hostname (e.g. `ha.yourdomain.com`).
4. Run it (`cloudflared tunnel run squareone-ha`, or install as a service so it's always on).
   - *Alternative:* **Home Assistant Cloud (Nabu Casa)** gives a hosted HTTPS URL for ~$6.50/mo with no tunnel to manage.

### 2c. Tell the dashboard about HA (Vercel env vars)
In Vercel → Settings → Environment Variables (Production):
- `HA_BASE_URL` = your tunnel/Nabu Casa URL (e.g. `https://ha.yourdomain.com`)
- `HA_TOKEN` = the long-lived token
- `HA_ALARM_CODE` = only if your alarm panel needs a code to arm/disarm

Redeploy. `/api/health` should then show `"hub":true`.

### 2d. Prove the pipeline before wiring real devices
Add a **test** entity in HA (e.g. a Helper toggle, or the demo integration) named
like a lock, map it (below), and confirm the dashboard's **Security/Climate** tabs
reflect and control it. Once the cloud→tunnel→HA loop works end-to-end, move on to
real devices.

### 2e. Map your entity_ids
The dashboard's door/zone ids must point to real HA `entity_id`s. Find them in HA
under **Developer Tools → States**. Then set `HA_ENTITIES` in Vercel to a JSON
object (or edit `DEFAULT_HA_ENTITIES` in `server/config.js`):

```json
{
  "alarm": "alarm_control_panel.<yours>",
  "doors": {
    "main": {"name": "Main Entrance", "entity": "lock.<yours>"},
    "med":  {"name": "Medical",        "entity": "lock.<yours>"},
    "fit":  {"name": "Fitness",         "entity": "lock.<yours>"},
    "elc":  {"name": "Early Learning",  "entity": "lock.<yours>"}
  },
  "zones": {
    "med": {"name": "Medical",        "entity": "climate.<yours>"},
    "elc": {"name": "Early Learning", "entity": "climate.<yours>"},
    "fit": {"name": "Fitness",         "entity": "climate.<yours>"},
    "off": {"name": "Offices",         "entity": "climate.<yours>"}
  }
}
```

---

## Phase 3 — Bridge the three systems into HA (the real work)

Each system needs its own bridge. **Model numbers determine the exact hardware** —
send them over and we'll pin the parts. General shape:

### Thermostats — Pro1 (Climate tab)
Pro1 has **no official API**; HA options (in order of preference):
- **Local API** — community integrations control Pro1 over the LAN (undocumented but
  works for many WiFi models). Once added, each thermostat appears as a `climate.*`
  entity.
- **Google Home bridge** — Pro1 Connect app → Google Home, then HA via a Google
  integration. More moving parts.
- If neither is reliable for your model, a **Z-Wave thermostat swap** integrates
  cleanly (last resort).
- *Need:* the Pro1 **model number(s)** to confirm the local-API path.

### Alarm — Napco Gemini (Security tab)
Napco panels don't talk to HA natively. Bridge via:
- A Napco **IP/serial communicator** the panel supports, **or**
- A **relay/zone interface board** (e.g. Konnected) wired to the panel to read
  armed/zone state and trigger arm/disarm.
- *Need:* the **panel model** (and keypad model). This one usually wants your **alarm
  installer** — don't rewire a live alarm yourself.

### Doors — GV-Access / Geovision (Security tab)
Options:
- **Geovision ASManager + API** running on a PC on the LAN, **or**
- Smart relays (**Shelly / Konnected**) wired to the door strikes for lock/unlock.
- *Need:* the **GV-Access controller model** and whether your IT guy runs ASManager.

---

## Verify
- `/api/health` → `"hub": true`
- `/api/hub/state` (as an admin, or locally) returns your doors/alarm/zones
- The **Security** and **Climate** tabs reflect real state and their buttons control
  the real devices; actions appear in the audit log.

## Rollout order (recommended)
1. HA box up (Phase 1)
2. Tunnel + token + one test entity, confirm the dashboard controls it (Phase 2)
3. **Pro1 thermostats** first (software-only bridge, lowest risk) →
4. **GV-Access doors** (with your IT guy) →
5. **Napco alarm** last (with your alarm installer — highest stakes)

---

## What to send me to move fast
- The **Pro1 thermostat model number(s)**
- The **Napco Gemini panel model** (and keypad)
- The **GV-Access controller model**, and whether your IT guy runs Geovision ASManager

With those I'll spec the exact bridge for each and tell you which need an installer.
