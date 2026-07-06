import { Router } from "express";
import { config, guard, http } from "../config.js";
import { getCachedToken, setCachedToken } from "../tokenStore.js";
import { requireAdmin } from "../auth.js";

export const hikRouter = Router();

/*
  Hik-Connect cameras via the EZVIZ Open Platform (open.ys7.com / open.ezvizlife.com).
  See .env.example for setup. All endpoints are POST, form-encoded, and take
  accessToken as a form param. The 7-day token (and its areaDomain) is cached via
  tokenStore so it survives serverless invocations.
*/

function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v != null) p.append(k, String(v));
  return p.toString();
}

// base must be the areaDomain for everything except the token call.
async function ezvizPost(path, params, base) {
  const body = await http(`${base || config.hik.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form(params),
  });
  if (body && body.code && body.code !== "200") {
    // 60019: the camera has "video encryption" on and wants its verification code.
    if (String(body.code) === "60019") {
      throw new Error(
        "this camera's Video Encryption is on — either turn it off in the EZVIZ/Hik-Connect app " +
        "(device Settings → Privacy → Video Encryption) or add its 6-letter verification code to the " +
        'HIK_DEVICE_CODES env var, e.g. {"SERIAL":"ABCDEF"}'
      );
    }
    throw new Error(`EZVIZ ${path} -> code ${body.code}: ${body.msg}`);
  }
  return body?.data;
}

// The device verification code, when configured (needed for encrypted cameras).
const codeFor = (serial) => config.hik.deviceCodes[serial] || undefined;

// EZVIZ is region-partitioned. The account may live on any of these hosts; the
// token/get call only succeeds on the right one, and its response tells us the
// areaDomain to use for every later call. We try each host until one issues a
// token, so the operator doesn't have to know their region up front.
const TOKEN_HOSTS = () =>
  [
    config.hik.baseUrl,
    "https://open.ezvizlife.com",
    "https://isgpopen.ezvizlife.com",
    "https://iusopen.ezviz.com",
    "https://open.ys7.com",
  ].filter((v, i, a) => v && a.indexOf(v) === i);

// Cache scope includes the appKey, so swapping to different keys in Vercel
// immediately invalidates the old account's cached token instead of serving
// its (possibly empty) device list for up to 7 days.
const tokenScope = () => `k-${(config.hik.appKey || "none").slice(-10)}`;

// Force a fresh token by trying each regional host. Returns { accessToken, areaDomain, host }.
async function fetchToken() {
  const attempts = [];
  for (const host of TOKEN_HOSTS()) {
    try {
      const data = await ezvizPost(
        "/api/lapp/token/get",
        { appKey: config.hik.appKey, appSecret: config.hik.appSecret },
        host
      );
      if (data?.accessToken) {
        const areaDomain = data.areaDomain || host;
        const expireAt = data.expireTime || Date.now() + 6.5 * 24 * 3600 * 1000;
        await setCachedToken("hik", tokenScope(), data.accessToken, { areaDomain, host }, expireAt);
        return { accessToken: data.accessToken, areaDomain, host };
      }
      attempts.push(`${host}: no accessToken`);
    } catch (e) {
      attempts.push(`${host}: ${e.message}`);
    }
  }
  throw new Error(`token/get failed on all hosts — ${attempts.join(" | ")}`);
}

async function getToken() {
  const cached = await getCachedToken("hik", tokenScope());
  if (cached) return { accessToken: cached.token, areaDomain: cached.meta.areaDomain || config.hik.baseUrl };
  return fetchToken();
}

// Fetch every page of an EZVIZ list endpoint (they page at pageStart/pageSize).
async function listAll(path, accessToken, areaDomain, pageSize = 50) {
  const all = [];
  for (let pageStart = 0, i = 0; i < 40; i++, pageStart += pageSize) {
    const data = await ezvizPost(path, { accessToken, pageStart, pageSize }, areaDomain);
    const list = Array.isArray(data) ? data : [];
    all.push(...list);
    if (list.length < pageSize) break;
  }
  return all;
}

// A camera id is "deviceSerial" for standalone cameras, or "deviceSerial_chN"
// for a channel behind an NVR/DVR. Parse it back for snapshot/live calls.
function parseCamId(id) {
  const i = String(id).lastIndexOf("_");
  if (i > 0) {
    const ch = Number(id.slice(i + 1));
    if (Number.isFinite(ch)) return { deviceSerial: id.slice(0, i), channelNo: ch };
  }
  return { deviceSerial: id, channelNo: 1 };
}

const camId = (deviceSerial, channelNo) => {
  const ch = Number(channelNo);
  // Suffix only real sub-channels (NVR); a standalone camera is channel 1.
  return ch && ch !== 1 ? `${deviceSerial}_${ch}` : deviceSerial;
};

// EZVIZ populates each camera with a recent thumbnail (picUrl). We cache the
// id -> picUrl map (kv, ~2 min) when listing so the snapshot endpoint can fall
// back to it whenever a live capture fails (e.g. encrypted NVR channels).
async function cachePicUrls(cams) {
  const map = {};
  for (const c of cams) if (c.picUrl) map[camId(c.deviceSerial, c.channelNo)] = c.picUrl;
  await setCachedToken("hik-pics", tokenScope(), JSON.stringify(map), {}, Date.now() + 150_000);
  return map;
}
async function picUrlFor(id) {
  const cached = await getCachedToken("hik-pics", tokenScope());
  if (cached) { try { return JSON.parse(cached.token)[id] || null; } catch { /* refill below */ } }
  const { accessToken, areaDomain } = await getToken();
  const map = await cachePicUrls(await listAll("/api/lapp/camera/list", accessToken, areaDomain));
  return map[id] || null;
}

// List cameras. An NVR/DVR is ONE device but many cameras, so we enumerate
// CHANNELS via /camera/list (each channel = one camera) rather than /device/list.
// Falls back to the device list if the account exposes no channel data.
hikRouter.get(
  "/cameras",
  guard("hik", async () => {
    const { accessToken, areaDomain } = await getToken();
    const cams = await listAll("/api/lapp/camera/list", accessToken, areaDomain);
    if (cams.length) {
      await cachePicUrls(cams);
      return cams.map((c) => ({
        id: camId(c.deviceSerial, c.channelNo),
        name: c.channelName || c.deviceName || c.deviceSerial,
        online: Number(c.status) === 1,
        recording: Number(c.status) === 1,
        encrypted: Number(c.isEncrypt) === 1,
        motion: "—",
      }));
    }
    // Fallback: device-level list.
    const devices = await listAll("/api/lapp/device/list", accessToken, areaDomain);
    return devices.map((d) => ({
      id: d.deviceSerial,
      name: d.deviceName || d.deviceSerial,
      online: Number(d.status) === 1,
      recording: Number(d.status) === 1,
      motion: "—",
    }));
  })
);

// Stream an EZVIZ-hosted image URL back to the browser as JPEG.
async function streamImage(url, res) {
  const img = await fetch(url);
  if (!img.ok) throw new Error(`image fetch failed: ${img.status}`);
  const buf = Buffer.from(await img.arrayBuffer());
  res.setHeader("Content-Type", img.headers.get("content-type") || "image/jpeg");
  res.setHeader("Cache-Control", "no-store");
  res.send(buf);
}

// Snapshot: fetch the temporary picUrl server-side and stream the JPEG back, so it
// works behind auth (an <img> can't send the bearer token) and avoids CORS.
hikRouter.get(
  "/cameras/:id/snapshot.jpg",
  guard("hik", async (req, res) => {
    const { accessToken, areaDomain } = await getToken();
    const { deviceSerial, channelNo } = parseCamId(req.params.id);
    // Try a fresh live capture first; if it fails (offline, or an encrypted NVR
    // channel without a code), fall back to EZVIZ's cached thumbnail so the tile
    // still shows the most recent frame instead of "unavailable".
    try {
      const data = await ezvizPost(
        "/api/lapp/device/capture",
        { accessToken, deviceSerial, channelNo, code: codeFor(deviceSerial) },
        areaDomain
      );
      if (data?.picUrl) return await streamImage(data.picUrl, res);
    } catch { /* fall back to cached thumbnail */ }
    const pic = await picUrlFor(req.params.id);
    if (!pic) throw new Error("no snapshot available (camera may be offline or encrypted — add its code to HIK_DEVICE_CODES)");
    await streamImage(pic, res);
  })
);

// HLS live stream URL for the browser player.
hikRouter.get(
  "/cameras/:id/live",
  guard("hik", async (req) => {
    const { accessToken, areaDomain } = await getToken();
    const { deviceSerial, channelNo } = parseCamId(req.params.id);
    const data = await ezvizPost(
      "/api/lapp/live/address/get",
      { accessToken, deviceSerial, channelNo, protocol: 2, quality: 1, code: codeFor(deviceSerial) },
      areaDomain
    );
    return { url: data?.url, expireTime: data?.expireTime };
  })
);

/*
  ---- Same-origin HLS proxy ----
  EZVIZ's HLS video servers don't send CORS headers, so the browser blocks
  hls.js from fetching their .m3u8/.ts directly from the dashboard domain
  (that's the "Access-Control-Allow-Origin ... Status code: 0" errors). We
  proxy the whole stream through this server: the browser talks only to our
  origin, and we fetch from EZVIZ server-to-server (where CORS doesn't apply),
  rewriting the playlist so every child URL loops back through the proxy.
*/
const HLS_HOST_OK = (u) => {
  try { return /(^|\.)(ezvizlife\.com|ezviz\.com|ys7\.com)$/i.test(new URL(u).hostname); }
  catch { return false; }
};

// Rewrite an m3u8 so nested playlists and segments route back through us. The
// session token rides along in the query, since hls.js/<video> can't set headers.
function rewriteM3u8(text, baseUrl, token) {
  const self = "/api/hik/hls";
  const tok = token ? `&access_token=${encodeURIComponent(token)}` : "";
  const abs = (uri) => { try { return new URL(uri, baseUrl).toString(); } catch { return uri; } };
  const proxy = (uri) => `${self}/${/\.m3u8/i.test(uri) ? "play" : "seg"}?u=${encodeURIComponent(abs(uri))}${tok}`;
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (/^#EXT-X-(KEY|MEDIA|STREAM-INF|I-FRAME-STREAM-INF)/i.test(t))
      return line.replace(/URI="([^"]+)"/i, (_m, uri) => `URI="${proxy(uri)}"`);
    if (t.startsWith("#")) return line;      // other tags pass through
    return proxy(t);                          // a segment or nested-playlist URI
  }).join("\n");
}

// Binary-safe fetch restricted to EZVIZ hosts (so this can't be an open proxy).
async function hlsFetch(url) {
  if (!HLS_HOST_OK(url)) throw new Error("blocked host");
  return fetch(url, { signal: AbortSignal.timeout(15000) });
}

// Entry point the player/poster load. Mints the current live URL, then redirects
// to the stable playlist proxy so hls.js's live reloads hit the same URL (rather
// than re-minting a new session each refresh).
hikRouter.get(
  "/cameras/:id/hls.m3u8",
  guard("hik", async (req, res) => {
    const { accessToken, areaDomain } = await getToken();
    const { deviceSerial, channelNo } = parseCamId(req.params.id);
    const data = await ezvizPost(
      "/api/lapp/live/address/get",
      { accessToken, deviceSerial, channelNo, protocol: 2, quality: 1, code: codeFor(deviceSerial) },
      areaDomain
    );
    if (!data?.url) throw new Error("EZVIZ returned no live URL for this camera.");
    const tok = req.query.access_token ? `&access_token=${encodeURIComponent(req.query.access_token)}` : "";
    res.redirect(302, `/api/hik/hls/play?u=${encodeURIComponent(data.url)}${tok}`);
  })
);

// Proxy + rewrite a playlist.
hikRouter.get(
  "/hls/play",
  guard("hik", async (req, res) => {
    const url = String(req.query.u || "");
    const upstream = await hlsFetch(url);
    const text = await upstream.text();
    // EZVIZ hands back an "error playlist" (segments named ErrCode/NNNN_*.ts) when
    // the stream can't start. Fail once here instead of letting hls.js chase a
    // dozen doomed segment fetches (which is the wall of 502s in the console).
    if (!upstream.ok || /ErrCode/i.test(text) || !/#EXTINF/i.test(text)) {
      const code = (text.match(/ErrCode\/(\d+)/i) || [])[1];
      res.setHeader("Cache-Control", "no-store");
      return res.status(502).type("text/plain").send(`stream not available${code ? ` (EZVIZ ${code})` : ""}`);
    }
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewriteM3u8(text, url, req.query.access_token));
  })
);

// Proxy a media segment / key (binary) straight through.
hikRouter.get(
  "/hls/seg",
  guard("hik", async (req, res) => {
    const url = String(req.query.u || "");
    const upstream = await hlsFetch(url);
    if (!upstream.ok) { res.setHeader("Cache-Control", "no-store"); return res.status(502).end(); }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp2t");
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  })
);

// Per-camera diagnostics: for the first few cameras (or ?id=serial_ch), report
// exactly what capture and live-address return, so we can see why NVR-channel
// thumbnails fail and whether live works. Admin-only.
hikRouter.get(
  "/debug/camera",
  requireAdmin,
  guard("hik", async (req) => {
    const { accessToken, areaDomain } = await getToken();
    const call = async (path, params) => {
      try {
        const body = await http(`${areaDomain}${path}`, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form(params),
        });
        return { code: body?.code, msg: body?.msg, data: body?.data };
      } catch (e) { return { error: e.message }; }
    };
    let ids = req.query.id ? [req.query.id] : null;
    if (!ids) {
      // Default: sample a few cameras from the list (mix of any NVR channels).
      const cams = await listAll("/api/lapp/camera/list", accessToken, areaDomain);
      ids = cams.slice(0, 4).map((c) => camId(c.deviceSerial, c.channelNo));
    }
    const results = [];
    for (const id of ids) {
      const { deviceSerial, channelNo } = parseCamId(id);
      const capture = await call("/api/lapp/device/capture", { accessToken, deviceSerial, channelNo, code: codeFor(deviceSerial) });
      const live = await call("/api/lapp/live/address/get", { accessToken, deviceSerial, channelNo, protocol: 2, quality: 1, code: codeFor(deviceSerial) });
      // Actually pull the HLS playlist EZVIZ minted, to see whether it's a real
      // stream or an error playlist (and surface the ErrCode, e.g. 6106).
      let playlist = null;
      if (live.data?.url) {
        try {
          const pl = await fetch(live.data.url, { signal: AbortSignal.timeout(9000) });
          const body = await pl.text();
          playlist = {
            status: pl.status,
            isError: /ErrCode/i.test(body),
            errCode: (body.match(/ErrCode\/(\d+)/i) || [])[1] || null,
            segments: (body.match(/#EXTINF/gi) || []).length,
            head: body.replace(/[A-Za-z0-9%_-]{40,}/g, "…").slice(0, 300),
          };
        } catch (e) { playlist = { error: e.message }; }
      }
      results.push({
        id, deviceSerial, channelNo,
        capture: { code: capture.code, msg: capture.msg, hasPic: Boolean(capture.data?.picUrl), error: capture.error },
        live: { code: live.code, msg: live.msg, hasUrl: Boolean(live.data?.url), error: live.error },
        playlist,
      });
    }
    return { results };
  })
);

/*
  Admin-only diagnostics. Forces a fresh token (reports which regional host and
  areaDomain worked) and lists devices. Never returns appKey/appSecret. Use this
  to confirm the keys + region and see the exact device shape.
*/
hikRouter.get(
  "/debug",
  requireAdmin,
  guard("hik", async () => {
    const out = { hostsTried: TOKEN_HOSTS(), token: null, devices: null };
    let areaDomain, accessToken;
    try {
      const t = await fetchToken();
      accessToken = t.accessToken;
      areaDomain = t.areaDomain;
      out.token = { ok: true, host: t.host, areaDomain: t.areaDomain };
    } catch (e) {
      out.token = { ok: false, error: e.message };
      return out;
    }
    try {
      const data = await ezvizPost("/api/lapp/device/list", { accessToken, pageStart: 0, pageSize: 50 }, areaDomain);
      const list = Array.isArray(data) ? data : [];
      out.devices = {
        count: list.length,
        itemKeys: list[0] ? Object.keys(list[0]) : [],
        list: list.map((d) => ({ deviceSerial: d.deviceSerial, deviceName: d.deviceName, status: d.status })),
      };
    } catch (e) {
      out.devices = { ok: false, error: e.message };
    }
    // Channel-level list — this is where the NVR/DVR cameras show up.
    try {
      const cams = await ezvizPost("/api/lapp/camera/list", { accessToken, pageStart: 0, pageSize: 50 }, areaDomain);
      const list = Array.isArray(cams) ? cams : [];
      out.cameras = {
        count: list.length,
        itemKeys: list[0] ? Object.keys(list[0]) : [],
        list: list.map((c) => ({ deviceSerial: c.deviceSerial, channelNo: c.channelNo, channelName: c.channelName, status: c.status, isEncrypt: c.isEncrypt })),
      };
    } catch (e) {
      out.cameras = { ok: false, error: e.message };
    }
    return out;
  })
);
