import { Router } from "express";
import { config, guard, http } from "../config.js";
import { getCachedToken, setCachedToken } from "../tokenStore.js";

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

async function getToken() {
  const cached = await getCachedToken("hik");
  if (cached) return { accessToken: cached.token, areaDomain: cached.meta.areaDomain || config.hik.baseUrl };
  const data = await ezvizPost(
    "/api/lapp/token/get",
    { appKey: config.hik.appKey, appSecret: config.hik.appSecret },
    config.hik.baseUrl // token call uses the base host, not areaDomain
  );
  const areaDomain = data.areaDomain || config.hik.baseUrl;
  const expireAt = data.expireTime || Date.now() + 6.5 * 24 * 3600 * 1000;
  await setCachedToken("hik", "default", data.accessToken, { areaDomain }, expireAt);
  return { accessToken: data.accessToken, areaDomain };
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
