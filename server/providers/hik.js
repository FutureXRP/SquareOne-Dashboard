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
    throw new Error(`EZVIZ ${path} -> code ${body.code}: ${body.msg}`);
  }
  return body?.data;
}

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
        await setCachedToken("hik", "default", data.accessToken, { areaDomain, host }, expireAt);
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
  const cached = await getCachedToken("hik");
  if (cached) return { accessToken: cached.token, areaDomain: cached.meta.areaDomain || config.hik.baseUrl };
  return fetchToken();
}

// List cameras with online status. status: 1 = online, 0 = offline.
hikRouter.get(
  "/cameras",
  guard("hik", async () => {
    const { accessToken, areaDomain } = await getToken();
    const all = [];
    let pageStart = 0;
    const pageSize = 50;
    for (let i = 0; i < 20; i++) {
      const data = await ezvizPost("/api/lapp/device/list", { accessToken, pageStart, pageSize }, areaDomain);
      const list = Array.isArray(data) ? data : [];
      all.push(...list);
      if (list.length < pageSize) break;
      pageStart += pageSize;
    }
    return all.map((d) => ({
      id: d.deviceSerial,
      name: d.deviceName || d.deviceSerial,
      online: Number(d.status) === 1,
      recording: Number(d.status) === 1,
      motion: "—",
    }));
  })
);

// Snapshot: fetch the temporary picUrl server-side and stream the JPEG back, so it
// works behind auth (an <img> can't send the bearer token) and avoids CORS.
hikRouter.get(
  "/cameras/:id/snapshot.jpg",
  guard("hik", async (req, res) => {
    const { accessToken, areaDomain } = await getToken();
    const data = await ezvizPost(
      "/api/lapp/device/capture",
      { accessToken, deviceSerial: req.params.id, channelNo: 1 },
      areaDomain
    );
    if (!data?.picUrl) throw new Error("no picUrl returned (camera may be offline)");
    const img = await fetch(data.picUrl);
    if (!img.ok) throw new Error(`snapshot fetch failed: ${img.status}`);
    const buf = Buffer.from(await img.arrayBuffer());
    res.setHeader("Content-Type", img.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  })
);

// HLS live stream URL for the browser player.
hikRouter.get(
  "/cameras/:id/live",
  guard("hik", async (req) => {
    const { accessToken, areaDomain } = await getToken();
    const data = await ezvizPost(
      "/api/lapp/live/address/get",
      { accessToken, deviceSerial: req.params.id, channelNo: 1, protocol: 2, quality: 1 },
      areaDomain
    );
    return { url: data?.url, expireTime: data?.expireTime };
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
    return out;
  })
);
