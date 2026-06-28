import { Router } from "express";
import { config, guard, http } from "../config.js";

export const hikRouter = Router();

/*
  Hik-Connect cameras via the EZVIZ Open Platform (open.ys7.com / open.ezvizlife.com).
  Hik-Connect and EZVIZ share Hikvision's cloud; the EZVIZ Open Platform is the
  developer API that serves Hik-Connect end-user accounts.

  SETUP (one-time):
    1. Register a developer account at open.ezvizlife.com (international) or
       open.ys7.com — MATCH THE REGION/COUNTRY of the account that owns the cameras.
    2. Create an application -> it gives you an appKey + appSecret.
    3. Put them in .env as HIK_APP_KEY / HIK_APP_SECRET.

  Notes baked into the code below:
    - All endpoints are POST, form-encoded, and take accessToken as a form param.
    - Token lives 7 days; we cache it.
    - token/get returns an `areaDomain` — we MUST use that domain for every later
      call (region redirection), else device lists come back empty.
*/

let tokenCache = { accessToken: "", areaDomain: "", expireAt: 0 };

function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v != null) p.append(k, String(v));
  return p.toString();
}

async function ezvizPost(path, params, useAreaDomain = true) {
  const base = useAreaDomain && tokenCache.areaDomain ? tokenCache.areaDomain : config.hik.baseUrl;
  const body = await http(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form(params),
  });
  // EZVIZ wraps everything: { code: "200", msg, data }. code !== "200" is an error.
  if (body && body.code && body.code !== "200") {
    throw new Error(`EZVIZ ${path} -> code ${body.code}: ${body.msg}`);
  }
  return body?.data;
}

async function getToken() {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expireAt - 60_000) return tokenCache;
  const data = await ezvizPost(
    "/api/lapp/token/get",
    { appKey: config.hik.appKey, appSecret: config.hik.appSecret },
    false // token call uses the base host, not areaDomain
  );
  tokenCache = {
    accessToken: data.accessToken,
    areaDomain: data.areaDomain || config.hik.baseUrl,
    // expireTime is an absolute epoch-ms; fall back to ~6.5 days if missing.
    expireAt: data.expireTime || now + 6.5 * 24 * 3600 * 1000,
  };
  return tokenCache;
}

// List cameras with online status. status: 1 = online, 0 = offline.
hikRouter.get(
  "/cameras",
  guard("hik", async () => {
    const { accessToken } = await getToken();
    const all = [];
    let pageStart = 0;
    const pageSize = 50;
    // Paginate device/list. Response.data is an array of devices.
    for (let i = 0; i < 20; i++) {
      const data = await ezvizPost("/api/lapp/device/list", { accessToken, pageStart, pageSize });
      const list = Array.isArray(data) ? data : [];
      all.push(...list);
      if (list.length < pageSize) break;
      pageStart += pageSize;
    }
    return all.map((d) => ({
      id: d.deviceSerial,
      name: d.deviceName || d.deviceSerial,
      online: Number(d.status) === 1,
      recording: Number(d.status) === 1, // EZVIZ doesn't expose a simple "recording" flag here
      motion: "—", // motion/last-event needs the alarm API; left out of the basic list
    }));
  })
);

// Snapshot: returns a temporary picUrl from EZVIZ; we redirect the browser to it.
hikRouter.get(
  "/cameras/:id/snapshot.jpg",
  guard("hik", async (req, res) => {
    const { accessToken } = await getToken();
    const data = await ezvizPost("/api/lapp/device/capture", {
      accessToken,
      deviceSerial: req.params.id,
      channelNo: 1,
    });
    if (!data?.picUrl) throw new Error("no picUrl returned (camera may be offline)");
    res.redirect(data.picUrl); // picUrl is a temporary signed JPEG URL
  })
);

// Bonus: HLS live stream URL for embedding in a browser (<video> + hls.js).
hikRouter.get(
  "/cameras/:id/live",
  guard("hik", async () => {
    const { accessToken } = await getToken();
    const data = await ezvizPost("/api/lapp/live/address/get", {
      accessToken,
      deviceSerial: req.params.id,
      channelNo: 1,
      protocol: 2, // 2 = HLS (verify enum against your console docs)
      quality: 1,
    });
    return { url: data?.url, expireTime: data?.expireTime };
  })
);
