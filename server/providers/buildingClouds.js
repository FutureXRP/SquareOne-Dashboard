import crypto from "node:crypto";
import { Router } from "express";
import { config, guard } from "../config.js";
import { requireAdmin, requireAuth, logAudit } from "../auth.js";
import { credsFor } from "./userCreds.js";
import { getCachedToken, setCachedToken } from "../tokenStore.js";

/*
  GeoVision GV-ASManager (ASWeb) session login — CONFIRMED by probing:
    POST form  username=<u>&password=<p>  to  /asweb/Login/Login.srf
    success -> 302 to /asweb/ with Set-Cookie: GvWebSessionID=...
  We cache the cookie header and attach it to subsequent ASWeb calls.
*/
const gvScope = () => (config.geovision.baseUrl || "default");

// Turn a fetch response's Set-Cookie headers into a "name=value; name=value" jar.
function cookieJar(res) {
  const list = res.headers.getSetCookie?.() || (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  return list.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

async function gvLogin(force = false) {
  const c = config.geovision;
  if (!force) {
    const cached = await getCachedToken("geovision-session", gvScope());
    if (cached) return cached.token;
  }
  const res = await fetch(`${c.baseUrl}/asweb/Login/Login.srf`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "*/*" },
    body: new URLSearchParams({ username: c.username, password: c.password }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(9000),
  });
  // Success is a 302 to /asweb/ that sets GvWebSessionID; a 200 means the login
  // page was returned (bad credentials).
  const jar = cookieJar(res);
  if (res.status !== 302 || !/GvWebSessionID/i.test(jar)) {
    throw new Error("GeoVision login failed — check GV_USERNAME / GV_PASSWORD (and that the server is reachable).");
  }
  // ASWeb sessions are short-lived; cache ~8 min and re-login as needed.
  await setCachedToken("geovision-session", gvScope(), jar, {}, Date.now() + 8 * 60 * 1000);
  return jar;
}

// Authenticated GET against ASWeb, retrying once with a fresh login on 401/302.
async function gvGet(path, cookie) {
  const c = config.geovision;
  return fetch(`${c.baseUrl}${path}`, { headers: { Cookie: cookie, Accept: "*/*" }, redirect: "manual", signal: AbortSignal.timeout(9000) });
}

/*
  ASWeb command endpoint. CONFIRMED from a captured browser request:
    POST /ASWeb/bin/ControllerList.srf  (form-encoded, with the session cookie)
    door open -> action=DOOR_OPERATION&module=monitor&dvg_id=0
                 &ctrl_id=<controller>&dr_id=<door>&operation=UNLOCK_DOOR&client_guid=<guid>
  Everything (door ops, logs, tree) posts to this one handler with a different
  `action`. We re-login and retry once if the session lapsed.
*/
const GV_CLIENT_GUID = crypto.randomUUID().toUpperCase();

// The Monitor page declares WHICH modules it's watching via this cookie. The
// server uses it as the client's monitor subscription — without it, monitor
// actions (long-poll, door ops) come back errcode 4, and GET_LOGS omits the
// access log. Value copied verbatim from the real client (access/alarm/event on).
const GV_MONITOR_LAYOUT = encodeURIComponent(JSON.stringify({
  access: 1, alarm: 1, event: 1, lpr: 1, iobox: 0, system: 0, user_action: 0,
  info: 1, video: 0, map: 0, alarm_map: 1, locate_people: 0, area: 0, parkings: {}, patrols: {},
}));

// The exact cookie header the real Monitor sends: session + version + user + the
// monitor layout subscription.
function gvCookieHeader(sessionJar) {
  const user = config.geovision.username || "Admin";
  return `${sessionJar}; GvServerVersion=6.2.0.0; GvWebUser=${encodeURIComponent(user)}; ASWebMonitorLayout=${GV_MONITOR_LAYOUT}`;
}

async function gvCommand(fields, retry = true) {
  const c = config.geovision;
  const send = (cookie) => fetch(`${c.baseUrl}/ASWeb/bin/ControllerList.srf`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Cookie: gvCookieHeader(cookie),
      Accept: "*/*", "X-Requested-With": "XMLHttpRequest",
      Referer: `${c.baseUrl}/ASWeb/ASWeb.srf`, Origin: c.baseUrl,
    },
    body: new URLSearchParams({ client_guid: GV_CLIENT_GUID, ...fields }).toString(),
    redirect: "manual", signal: AbortSignal.timeout(12000),
  });
  let res = await send(await gvLogin());
  if ((res.status === 302 || res.status === 401 || res.status === 403) && retry) {
    res = await send(await gvLogin(true)); // session expired — re-login once
  }
  return { status: res.status, text: await res.text() };
}

// GV door operations only succeed for a client_guid the server recognizes as a
// live Monitor client. The Monitor page establishes that by starting its
// notification long-poll; the first poll with our guid registers the session.
// wait_time=0 returns immediately (blocking poll uses 60). Fire-and-forget.
async function gvRegister() {
  try { return await gvCommand({ action: "LONG_POLLING_NOTIFICATIONS", module: "monitor", wait_time: 0 }); }
  catch (e) { return { status: 0, text: e.message }; }
}

// Unlock / lock a door by controller id + door id. Registers our monitor session
// first so the door engine accepts the client_guid, then sends the operation.
const gvDoorOp = async (ctrlId, drId, operation) => {
  await gvRegister();
  return gvCommand({ action: "DOOR_OPERATION", module: "monitor", dvg_id: 0, ctrl_id: ctrlId, dr_id: drId, operation });
};

/*
  Building-system cloud providers: Pro1 thermostats, Napco alarm (iBridge/Prima),
  GeoVision GV-Cloud doors. All three vendor apps are cloud-backed, so the server
  can authenticate with the owner's credentials — the same pattern as Amilia.

  Their APIs are PRIVATE (no public docs), so each provider starts as a probe:
  /api/<name>/debug (admin) tries the plausible login routes and reports each
  response's status and shape — sanitized, never echoing credentials. From that
  output the real endpoints get pinned down and the control ops wired in, exactly
  how Amilia's field mapping was confirmed.
*/

// Try one login attempt; classify the response without leaking secrets.
async function attempt(base, path, body, style) {
  const url = `${base}${path}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": style === "form" ? "application/x-www-form-urlencoded" : "application/json",
        Accept: "application/json",
      },
      body: style === "form" ? new URLSearchParams(body).toString() : JSON.stringify(body),
      redirect: "manual", // capture 3xx targets instead of following them
      signal: AbortSignal.timeout(9000),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* HTML or plain text */ }
    const looksJson = parsed !== null;
    // A 3xx with a Set-Cookie is the classic sign of a session login working.
    const setCookie = res.headers.get("set-cookie");
    return {
      path, style, status: res.status, ms: Date.now() - started,
      kind: looksJson ? "json" : text.trim().startsWith("<") ? "html" : "text",
      keys: looksJson && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 20) : undefined,
      location: res.headers.get("location") || undefined,
      sessionCookie: setCookie ? setCookie.split("=")[0] : undefined,
      // Truncated peek, with anything resembling a token shortened.
      peek: (looksJson ? JSON.stringify(parsed) : text).slice(0, 260).replace(/[A-Za-z0-9_-]{28,}/g, "…token…"),
    };
  } catch (e) {
    return { path, style, error: e.message, ms: Date.now() - started };
  }
}

const LOGIN_PATHS = [
  "/api/login", "/api/auth/login", "/api/v1/auth/login", "/api/v1/login",
  "/api/account/login", "/api/user/login", "/api/users/login", "/api/session",
  "/auth/login", "/login",
  // GV-ASManager mobile web service routes (GV-Access app backend).
  "/Login", "/asweb/api/login", "/ASManager/api/login", "/Mobile/Login", "/api/Account/Login",
];

// Probe a vendor cloud: every plausible path × body shape. `login` may be an
// email or a bare username (Napco Gemini uses "Mat4185"), so cover both fields.
async function probeLogin(base, login, password) {
  const results = [];
  for (const path of LOGIN_PATHS) {
    for (const [style, body] of [
      ["json", { username: login, password }],
      ["json", { userName: login, password }],
      ["json", { email: login, password }],
      ["form", { username: login, password }],
    ]) {
      results.push(await attempt(base, path, body, style));
    }
  }
  // Surface the most promising responses first: a login that sets a session
  // cookie or answers 2xx/3xx (not 404) is the real endpoint.
  const score = (r) => (r.sessionCookie ? 0 : 1) * 100
    + (r.status && r.status >= 200 && r.status < 400 ? 0 : 1) * 10
    + (r.kind === "json" ? 0 : 1);
  results.sort((a, b) => score(a) - score(b) || (a.status ?? 999) - (b.status ?? 999));
  return { base, tried: results.length, top: results.slice(0, 12) };
}

function makeProbeRouter(providerKey, extraBases = []) {
  const router = Router();
  router.get(
    "/debug",
    requireAdmin,
    guard(providerKey, async (req) => {
      const c = config[providerKey];
      // Prefer the signed-in operator's own login (so the probe/action is
      // attributed to them); fall back to the shared env credential.
      const { username, secret, source } = await credsFor(req, providerKey).catch(() => ({
        username: c.email, secret: c.password, source: "shared",
      }));
      const bases = [c.baseUrl, ...extraBases].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
      const probes = [];
      for (const base of bases) probes.push(await probeLogin(base, username || c.email, secret || c.password));
      return { provider: providerKey, credentialSource: source, probes };
    })
  );
  return router;
}

// Pro1: the app's cloud host isn't publicly documented — probe the likely ones.
export const pro1Router = makeProbeRouter("pro1", [
  "https://api.pro1iaq.com",
  "https://mobile.pro1iaq.com",
  "https://cloud.pro1iaq.com",
]);

// Napco Gemini commercial app (StarLink Connect). Registration lives on
// NapcoComNet; the app's API host isn't published, so probe the likely ones.
// NAPCO_BASE_URL pins it once the debug output reveals the real host.
export const napcoRouter = makeProbeRouter("napco", [
  "https://api.napcocomnet.com",
  "https://gemini.napcocomnet.com",
  "https://www.napcocomnet.com",
  "https://geminiapp.napcosecurity.com",
  "https://starlinkconnect.napcosecurity.com",
]);

// GeoVision GV-Access → on-prem GV-ASManager server (GV_BASE_URL). No extra
// hosts to guess: the app talks to one server address, which the owner supplies.
export const geovisionRouter = makeProbeRouter("geovision");

// GeoVision-specific deep login test. /asweb/api/login answered 302 (a session
// login), so try it with the credential field names ASManager/ASWeb use, across
// GET+POST and json/form, and report the FULL response shape (all headers,
// redirect target, cookies, body) so the exact handshake can be mapped.
geovisionRouter.get(
  "/login-probe",
  requireAdmin,
  guard("geovision", async () => {
    const c = config.geovision;
    const { username, secret } = await credsFor({ user: { id: "admin" } }, "geovision")
      .catch(() => ({ username: c.username, secret: c.password }));
    const u = username || c.username;
    const p = secret || c.password;

    // GeoVision .srf logins use short field names; cover the common ones.
    const bodies = [
      ["form", { username: u, password: p }],
      ["form", { username: u, passwd: p }],
      ["form", { id: u, pwd: p }],
      ["form", { account: u, pwd: p }],
      ["form", { UserId: u, Passwd: p }],
      ["json", { username: u, password: p }],
    ];
    // Login.srf is the real handler the page pointed us to.
    const paths = ["/asweb/Login/Login.srf", "/asweb/Login/LoginPC.srf", "/asweb/api/login"];

    const attempts = [];
    for (const path of paths) {
      for (const [style, body] of bodies) {
        for (const method of ["POST", "GET"]) {
          const started = Date.now();
          try {
            const url = method === "GET"
              ? `${c.baseUrl}${path}?${new URLSearchParams(body).toString()}`
              : `${c.baseUrl}${path}`;
            const res = await fetch(url, {
              method,
              headers: method === "GET" ? { Accept: "*/*" }
                : { "Content-Type": style === "form" ? "application/x-www-form-urlencoded" : "application/json", Accept: "*/*" },
              body: method === "GET" ? undefined : (style === "form" ? new URLSearchParams(body).toString() : JSON.stringify(body)),
              redirect: "manual",
              signal: AbortSignal.timeout(9000),
            });
            const text = await res.text();
            const headers = {};
            res.headers.forEach((v, k) => { headers[k] = k.toLowerCase() === "set-cookie" ? v.split("=")[0] + "=…" : v; });
            attempts.push({
              path, method, style, fields: Object.keys(body).join("+"),
              status: res.status, ms: Date.now() - started, headers,
              location: res.headers.get("location") || undefined,
              cookie: res.headers.get("set-cookie") ? res.headers.get("set-cookie").split("=")[0] : undefined,
              body: text.slice(0, 300).replace(/[A-Za-z0-9_-]{28,}/g, "…token…"),
            });
          } catch (e) {
            attempts.push({ path, method, style, error: e.message, ms: Date.now() - started });
          }
        }
      }
    }
    // Most promising first: a cookie or 2xx/3xx beats a 404/error.
    attempts.sort((a, b) =>
      (a.cookie ? 0 : 1) - (b.cookie ? 0 : 1) ||
      ((a.status >= 200 && a.status < 400) ? 0 : 1) - ((b.status >= 200 && b.status < 400) ? 0 : 1) ||
      (a.status ?? 999) - (b.status ?? 999));

    // The login redirects to /asweb/Login/ — that's the web login FORM. Fetch it
    // so we can read the real field names, the form action, and any hidden
    // token, then replicate the exact POST. Also grab the ASWeb root.
    const pageOf = async (path) => {
      try {
        const res = await fetch(`${c.baseUrl}${path}`, { headers: { Accept: "text/html,*/*" }, redirect: "manual", signal: AbortSignal.timeout(9000) });
        const html = await res.text();
        // Pull out <form ...> tags and every input's name/id/type so the login
        // shape is visible without dumping the whole page.
        const forms = (html.match(/<form[^>]*>/gi) || []).slice(0, 4);
        const inputs = (html.match(/<input[^>]*>/gi) || [])
          .map((t) => (t.match(/(name|id|type)\s*=\s*"[^"]*"/gi) || []).join(" "))
          .filter(Boolean).slice(0, 25);
        const scripts = (html.match(/(login|auth|api)[A-Za-z0-9_/.]*/gi) || []).slice(0, 20);
        // Raw excerpt (token-redacted) so we can read the JS that builds the
        // login request when there's no server-rendered <form>.
        const raw = html.replace(/[A-Za-z0-9+/=_-]{40,}/g, "…").slice(0, 1600);
        return { path, status: res.status, cookie: res.headers.get("set-cookie") ? res.headers.get("set-cookie").split("=")[0] : undefined, forms, inputs, apiHints: [...new Set(scripts)], raw };
      } catch (e) { return { path, error: e.message }; }
    };
    const pages = [await pageOf("/asweb/Login/"), await pageOf("/asweb/")];

    return { base: c.baseUrl, account: u, attempts: attempts.slice(0, 8), pages };
  })
);

// Authenticated discovery: log in, then crawl the ASWeb main app (ASWeb.srf)
// and its JavaScript bundles to surface the door-list and door-control endpoint
// names (they live in the app's JS, not in server-rendered HTML).
geovisionRouter.get(
  "/discover",
  requireAdmin,
  guard("geovision", async () => {
    const cookie = await gvLogin(true);
    const getText = async (path) => {
      const res = await gvGet(path, cookie);
      return { status: res.status, ctype: res.headers.get("content-type") || "", text: await res.text() };
    };
    const absUnder = (base, s) => {
      if (s.startsWith("http")) return null;               // skip external
      if (s.startsWith("/")) return s;
      return base + s.replace(/^\.?\//, "");                // resolve relative to /asweb/
    };

    // 1. Main app shell. The real Monitor uses the capital /ASWeb/ path (that's
    // the Referer the captured door command sent), so try both casings.
    let shell, shellPath;
    for (const p of ["/ASWeb/ASWeb.srf", "/asweb/ASWeb.srf"]) {
      try { const r = await getText(p); if (r.status < 400 && r.text.length > 200) { shell = r; shellPath = p; break; } shell = shell || r; shellPath = shellPath || p; }
      catch (e) { shell = shell || { status: 0, text: "", err: e.message }; }
    }
    const shellBase = shellPath.replace(/ASWeb\.srf$/, ""); // e.g. /ASWeb/

    // 2. Its <script src> bundles (resolve relative to the shell's directory).
    const scripts = [...new Set([...shell.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
      .map((m) => absUnder(shellBase, m[1])).filter(Boolean))].slice(0, 16);

    // 3. Fetch the JS and mine everything for endpoint + action clues.
    const texts = [shell.text];
    const jsLoaded = [];
    for (const src of scripts) {
      try { const r = await getText(src); jsLoaded.push({ src, status: r.status, len: r.text.length }); texts.push(r.text); }
      catch (e) { jsLoaded.push({ src, error: e.message }); }
    }
    const blob = texts.join("\n");
    const srf = [...new Set(blob.match(/[\w./-]+\.srf/gi) || [])].slice(0, 100);
    const doorEndpoints = [...new Set((blob.match(/["'`][^"'`]*(door|access|open|unlock|controller|output|reader|monitor|getlist|status)[^"'`]*["'`]/gi) || [])
      .map((s) => s.slice(1, -1)).filter((s) => s.length < 90))].slice(0, 100);

    // 4. The action vocabulary: DOOR_OPERATION / LONG_POLLING_NOTIFICATIONS /
    // GET_LOGS are ALL_CAPS_SNAKE constants, so every action verb the app can
    // send looks the same. List them all — the monitor-init and door-tree
    // actions we couldn't guess will be in here.
    const actions = [...new Set(blob.match(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g) || [])]
      .filter((t) => t.length >= 5 && t.length <= 40).sort().slice(0, 200);

    // 5. The code right around the strings we care about, so the request-build
    // sequence (which action registers the client_guid, what precedes a door op)
    // is readable. Token-redacted, a few windows each.
    const contextOf = (needle, span = 260, max = 3) => {
      const out = []; let i = -1;
      while ((i = blob.indexOf(needle, i + 1)) !== -1 && out.length < max) {
        out.push(blob.slice(Math.max(0, i - span), i + needle.length + span).replace(/[A-Za-z0-9+/=_-]{40,}/g, "…"));
      }
      return out;
    };

    return {
      loggedIn: true, base: config.geovision.baseUrl, shellPath,
      shell: { status: shell.status, len: shell.text.length },
      scripts, jsLoaded,
      srf,                 // every .srf endpoint referenced by the app
      doorEndpoints,       // strings mentioning door/access/open/controller/etc.
      actions,             // every ALL_CAPS action constant found in the JS
      doorOpContext: contextOf("DOOR_OPERATION"),
      clientGuidContext: contextOf("client_guid"),
      monitorContext: contextOf("LONG_POLLING_NOTIFICATIONS"),
    };
  })
);

// The ExtJS desktop loads the Monitor module dynamically — its JS isn't in the
// shell's <script> tags. Dump the raw shell + login.js (which name the real
// module/handler paths) and probe likely Monitor-module JS locations; for any
// hit, scan it for DOOR_OPERATION and the surrounding request-build code.
geovisionRouter.get(
  "/shell",
  requireAdmin,
  guard("geovision", async () => {
    const cookie = await gvLogin(true);
    const base = config.geovision.baseUrl;
    const redact = (s) => s.replace(/[A-Za-z0-9+/=_-]{40,}/g, "…");
    const get = async (path) => {
      try {
        const res = await gvGet(path, cookie);
        const text = await res.text();
        return { path, status: res.status, len: text.length, text };
      } catch (e) { return { path, error: e.message }; }
    };

    // 1. Raw shell + login.js — server-rendered, they name the real app paths.
    const shell = await get("/ASWeb/ASWeb.srf");
    const login = await get("/ASWeb/login/login.js");

    // Every .js / .srf path mentioned anywhere in the shell (dynamic loaders
    // often build the module path from a string literal).
    const shellText = shell.text || "";
    const jsRefs = [...new Set(shellText.match(/[\w./-]+\.(?:js|srf)/gi) || [])];

    // 2. Probe likely Monitor-module JS locations (GV puts app modules outside
    // the ext example dir). Anything that 200s with real length gets scanned.
    const candidates = [...new Set([
      ...jsRefs.map((r) => (r.startsWith("/") ? r : `/ASWeb/${r.replace(/^\.?\//, "")}`)),
      "/ASWeb/js/monitor.js", "/ASWeb/js/Monitor.js", "/ASWeb/monitor/monitor.js",
      "/ASWeb/module/monitor.js", "/ASWeb/module/Monitor.js", "/ASWeb/js/module/monitor.js",
      "/ASWeb/js/desktop.js", "/ASWeb/js/asweb.js", "/ASWeb/js/main.js", "/ASWeb/js/app.js",
      "/ASWeb/desktop/monitor.js", "/ASWeb/bin/monitor.js", "/ASWeb/monitor.js",
      "/ASWeb/js/modules/monitor.js", "/ASWeb/js/gvmonitor.js", "/ASWeb/js/ASWeb.js",
    ])].filter((p) => /\.js$/i.test(p) && !/ext-3\.4\.0/.test(p)).slice(0, 40);

    const hits = [];
    for (const p of candidates) {
      const r = await get(p);
      if (r.status === 200 && r.len > 40) {
        const hasDoorOp = /DOOR_OPERATION/.test(r.text);
        const acts = [...new Set(r.text.match(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g) || [])]
          .filter((t) => t.length >= 5 && t.length <= 40 && !/^(NUM_|PAGE_|XML_)/.test(t)).slice(0, 60);
        let doorCtx;
        if (hasDoorOp) {
          const i = r.text.indexOf("DOOR_OPERATION");
          doorCtx = redact(r.text.slice(Math.max(0, i - 600), i + 600));
        }
        hits.push({ path: p, len: r.len, hasDoorOp, actions: acts, doorCtx });
      }
    }
    // DOOR_OPERATION-bearing files first.
    hits.sort((a, b) => (a.hasDoorOp ? 0 : 1) - (b.hasDoorOp ? 0 : 1) || b.len - a.len);

    return {
      base, shell: { status: shell.status, len: shell.len },
      rawShell: redact(shellText).slice(0, 4000),
      loginJs: redact(login.text || login.error || "").slice(0, 2000),
      jsRefs, probed: candidates.length, hits,
    };
  })
);

// The shell redirects phones to /ASMobile/ — a modern SPA that IS the GV-Access
// app's backend, with a clean JSON door API. Crawl its index + JS bundles for
// the door-list / door-open endpoints, and dump main/require.js (the desktop's
// RequireJS module map) to learn the real Monitor module name.
geovisionRouter.get(
  "/mobile",
  requireAdmin,
  guard("geovision", async () => {
    const base = config.geovision.baseUrl;
    const cookie = await gvLogin(true);
    const redact = (s) => s.replace(/[A-Za-z0-9+/=_-]{40,}/g, "…");
    const get = async (path) => {
      try {
        const res = await gvGet(path, cookie);
        const text = await res.text();
        return { path, status: res.status, ctype: res.headers.get("content-type") || "", len: text.length, text };
      } catch (e) { return { path, error: e.message }; }
    };
    const absFrom = (dir, s) => (s.startsWith("http") ? null : s.startsWith("/") ? s : dir + s.replace(/^\.?\//, ""));

    // 1. Mobile SPA index + its JS/CSS bundles. The shell redirects to
    // <shell-dir>/ASMobile/#/ — the shell is /ASWeb/ASWeb.srf, so it's at
    // /ASWeb/ASMobile/ (NOT /ASMobile/, which 404s).
    let idx, idxPath;
    for (const p of ["/ASWeb/ASMobile/", "/ASWeb/ASMobile/index.html", "/ASWeb/asmobile/"]) {
      const r = await get(p); if (r.status === 200 && r.len > 100) { idx = r; idxPath = p; break; } idx = idx || r; idxPath = idxPath || p;
    }
    const mDir = (idxPath || "/ASWeb/ASMobile/").replace(/index\.html$/, "");
    // RequireJS names the app entry in a data-main attr; resolve + follow it.
    const dataMain = (idx?.text?.match(/data-main\s*=\s*["']([^"']+)["']/i) || [])[1];
    const dataMainPath = dataMain ? absFrom(mDir, dataMain.replace(/\.js$/, "") + ".js") : null;
    const assets = idx?.text ? [...new Set([
      dataMainPath,
      ...[...idx.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).map((s) => absFrom(mDir, s)),
      ...[...idx.text.matchAll(/["']([\w./-]+\.js)["']/gi)].map((m) => absFrom(mDir, m[1])),
    ])].filter(Boolean).slice(0, 20) : [];

    // 2. Fetch the bundles and mine them for API endpoints + door verbs.
    const bundles = []; const texts = [];
    for (const a of assets) {
      const r = await get(a);
      bundles.push({ src: a, status: r.status, len: r.len });
      if (r.status === 200) texts.push(r.text);
    }
    const blob = texts.join("\n");
    // API-ish URL literals, and any string mentioning door/open/unlock/access.
    const urls = [...new Set(blob.match(/["'`][/][\w./-]*(?:api|door|access|open|unlock|controller|monitor|login|token)[\w./-]*["'`]/gi) || [])]
      .map((s) => s.slice(1, -1)).filter((s) => s.length < 100).slice(0, 80);
    const doorStr = [...new Set(blob.match(/["'`][^"'`]{0,40}(?:door|unlock|openDoor|access)[^"'`]{0,40}["'`]/gi) || [])]
      .map((s) => s.slice(1, -1)).filter((s) => s.length < 90).slice(0, 60);

    // 3. RequireJS module map — names the real desktop Monitor module.
    const req = await get("/ASWeb/main/require.js");
    const modulePaths = req.status === 200
      ? [...new Set(req.text.match(/["'`][\w./-]*modules?\/[\w./-]+["'`]/gi) || [])].map((s) => s.slice(1, -1)).slice(0, 60)
      : [];

    // 4. The confirmed desktop module. ControllerList.js (behind
    // ControllerList.srf) is where the door list loads and the unlock command is
    // built. Dump it whole (redacted) + its RequireJS define() deps and every
    // action/operation-ish string, so the exact request shape is readable.
    const clPath = "/ASWeb/modules/ControllerList/ControllerList.js";
    const cl = await get(clPath);
    let controllerList;
    if (cl.status === 200) {
      const t = cl.text;
      const deps = (t.match(/define\(\s*\[([^\]]*)\]/) || [])[1];
      const strs = [...new Set(t.match(/["'`][A-Za-z0-9_./?=&-]{2,60}["'`]/g) || [])]
        .map((s) => s.slice(1, -1))
        .filter((s) => /door|open|unlock|lock|operation|action|controller|srf|api|guid|monitor|dvg|ctrl|dr_/i.test(s))
        .slice(0, 80);
      controllerList = {
        path: clPath, len: cl.len,
        depsRaw: deps ? deps.replace(/\s+/g, " ").slice(0, 400) : undefined,
        interestingStrings: strs,
        full: redact(t).slice(0, 14000),   // whole module, token-redacted
      };
    } else {
      controllerList = { path: clPath, status: cl.status };
    }

    return {
      base,
      mobile: { indexPath: idxPath, status: idx?.status, len: idx?.len, dataMain, dataMainPath, assets, bundles, urls, doorStr, indexHead: redact(idx?.text || "").slice(0, 900) },
      requireJs: { status: req.status, len: req.len, modulePaths },
      controllerList,
    };
  })
);

// Directly probe GV-ASManager ASWeb door/controller .srf handlers (Door/GetList
// .srf already returns 500 = exists). Tries GET+POST and reports status + body,
// so the real list + open endpoints (and their params) can be read off.
geovisionRouter.get(
  "/probe-doors",
  requireAdmin,
  guard("geovision", async () => {
    const cookie = await gvLogin(true);
    const base = config.geovision.baseUrl;
    const targets = [
      "Door/GetList.srf", "Door/GetDoorList.srf", "Door/GetStatus.srf", "Door/GetDoorStatus.srf",
      "Door/Open.srf", "Door/ForceOpen.srf", "Door/RemoteOpen.srf", "Door/OpenDoor.srf",
      "Controller/GetList.srf", "Controller/GetControllerList.srf", "Controller/GetStatus.srf",
      "GetDoorList.srf", "GetControllerList.srf", "DoorList.srf", "DoorStatus.srf",
      "Monitor/GetList.srf", "Monitor/GetDoorList.srf", "Device/GetList.srf", "AccessControl/GetDoorList.srf",
    ];
    // ExtJS always sends these; GV .srf handlers often 500 without them.
    const ajax = { Cookie: cookie, Accept: "*/*", "X-Requested-With": "XMLHttpRequest", Referer: `${base}/asweb/ASWeb.srf` };
    const results = [];
    for (const t of targets) {
      // GET with a door id param, and POST form with an id — the shape ASWeb uses.
      const calls = [
        ["GET", `?id=1`, undefined],
        ["POST", "", "id=1"],
        ["POST", "", "DoorId=1&ControllerId=1"],
      ];
      for (const [method, qs, body] of calls) {
        try {
          const res = await fetch(`${base}/asweb/${t}${qs || ""}`, {
            method, headers: { ...ajax, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
            body, redirect: "manual", signal: AbortSignal.timeout(9000),
          });
          const text = await res.text();
          results.push({ path: t, method, sent: qs || body, status: res.status, ctype: res.headers.get("content-type") || "", len: text.length,
            body: text.slice(0, 400).replace(/[A-Za-z0-9+/=_-]{40,}/g, "…") });
        } catch (e) { results.push({ path: t, method, error: e.message }); }
      }
    }
    results.sort((a, b) => ((a.status === 200) ? 0 : 1) - ((b.status === 200) ? 0 : 1) || (a.status ?? 999) - (b.status ?? 999));

    // Also hunt for the mobile web app (the GV-Access phone app's cleaner API).
    const mobile = [];
    for (const mp of ["/asweb/m/", "/asweb/mobile/", "/asweb/M/", "/asweb/Mobile/"]) {
      try {
        const res = await gvGet(mp, cookie);
        const text = await res.text();
        if (res.status !== 404) {
          const scripts = [...new Set([...text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]))].slice(0, 12);
          mobile.push({ path: mp, status: res.status, len: text.length, scripts, raw: text.replace(/[A-Za-z0-9+/=_-]{40,}/g, "…").slice(0, 500) });
        }
      } catch (e) { mobile.push({ path: mp, error: e.message }); }
    }

    return { loggedIn: true, base, results: results.slice(0, 20), mobile };
  })
);

// Discover the real ControllerList.srf action menu. The handler returns an
// empty body for actions it doesn't know and a JSON object for ones it does
// (DOOR_OPERATION, LONG_POLLING_NOTIFICATIONS, GET_LOGS all answer JSON). So we
// brute-force candidate names and surface every one that comes back with JSON —
// that reveals the monitor-init/subscribe action and the controller/door tree.
geovisionRouter.get(
  "/monitor",
  requireAdmin,
  guard("geovision", async () => {
    const actions = [
      // init / subscribe (what registers a monitor client)
      "INIT", "INIT_MONITOR", "MONITOR_INIT", "INIT_DATA", "GET_INIT_DATA", "INIT_MONITOR_DATA",
      "ENTER_MONITOR", "START_MONITOR", "MONITOR_START", "REGISTER", "REGISTER_CLIENT",
      "SUBSCRIBE", "SUBSCRIBE_NOTIFICATIONS", "CONNECT", "OPEN_MONITOR", "LOAD_MONITOR",
      // device / controller / door tree (what maps ids -> names)
      "GET_CONTROLLERS", "GET_CONTROLLER_LIST", "GET_CONTROLLER", "GET_CONTROLLER_STATUS",
      "GET_MONITOR_DATA", "GET_MONITOR_TREE", "GET_DEVICE_LIST", "GET_DEVICE_GROUPS",
      "GET_DEVICE_TREE", "GET_DOORS", "GET_DOOR_LIST", "GET_DOOR_STATUS", "GET_TREE",
      "GET_NODE_LIST", "GET_NODES", "GET_ACCESS_LIST", "GET_STATUS", "GET_ALL_STATUS",
      "GET_DVG", "GET_DVG_LIST", "GET_DEVICE_GROUP_LIST", "GET_MAP_DATA",
      // known-good, as a control (should answer JSON)
      "GET_LOGS",
    ];
    const out = [];
    for (const action of actions) {
      const r = await gvCommand({ action, module: "monitor", wait_time: 0, dvg_id: 0 });
      let parsed = null; try { parsed = JSON.parse(r.text); } catch { /* empty/html */ }
      out.push({
        action, status: r.status, len: r.text.length,
        real: parsed !== null,                         // handler recognized it
        errcode: parsed?.errcode,
        keys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 15) : undefined,
        body: r.text.slice(0, 900).replace(/[A-Za-z0-9+/=_-]{40,}/g, "…"),
      });
    }
    // Real actions first, and among those, the ones that succeeded (errcode 0).
    out.sort((a, b) => (a.real ? 0 : 1) - (b.real ? 0 : 1) || ((a.errcode === 0) ? 0 : 1) - ((b.errcode === 0) ? 0 : 1));
    return { base: config.geovision.baseUrl, hint: "actions with real:true are recognized; errcode:0 = succeeded", actions: out };
  })
);

// Configured doors (GV_DOORS env: [{"name","ctrl","door"}]) for the Security tab.
geovisionRouter.get(
  "/doors",
  requireAuth,
  guard("geovision", async () => ({ doors: config.geovision.doors })),
);

// Unlock / lock a specific door. Body/params: ctrl (controller id), door (dr_id).
// op path segment: "unlock" | "lock". Attributed to the signed-in user.
geovisionRouter.post(
  "/doors/:op",
  requireAuth,
  guard("geovision", async (req) => {
    const op = req.params.op === "lock" ? "LOCK_DOOR" : "UNLOCK_DOOR";
    const ctrl = Number(req.body?.ctrl);
    const door = Number(req.body?.door);
    if (!Number.isFinite(ctrl) || !Number.isFinite(door)) throw new Error("ctrl and door are required.");
    const r = await gvDoorOp(ctrl, door, op);
    logAudit(req, `geovision.${req.params.op}`, `ctrl${ctrl}/door${door}`, { status: r.status });
    return { ok: r.status === 200, status: r.status, response: r.text.slice(0, 200) };
  })
);

// Admin one-off unlock test (GET so it's easy to fire from Diagnostics):
// /api/geovision/test-unlock?ctrl=1&door=4  — ACTUALLY opens that door.
// Reports both steps (register the monitor session, then the door op) so a
// failure is easy to place.
geovisionRouter.get(
  "/test-unlock",
  requireAdmin,
  guard("geovision", async (req) => {
    const ctrl = Number(req.query.ctrl ?? 1);
    const door = Number(req.query.door ?? 4);
    const reg = await gvRegister();
    const op = await gvCommand({ action: "DOOR_OPERATION", module: "monitor", dvg_id: 0, ctrl_id: ctrl, dr_id: door, operation: "UNLOCK_DOOR" });
    let parsed = null; try { parsed = JSON.parse(op.text); } catch { /* not json */ }
    return {
      sent: { ctrl, door, operation: "UNLOCK_DOOR", client_guid: GV_CLIENT_GUID },
      register: { status: reg.status, response: reg.text.slice(0, 200) },
      doorOp: { status: op.status, response: op.text.slice(0, 300) },
      success: parsed?.success === 1 || parsed?.success === true,
    };
  })
);

// Read the Monitor event log — every door open/close/grant records the door's
// controller id, door id, and NAME here, which is how we map ids -> names when
// the controller-list actions come back empty.
geovisionRouter.get(
  "/logs",
  requireAdmin,
  guard("geovision", async (req) => {
    await gvRegister(); // logs are per monitor session
    const max = Number(req.query.max ?? 100);
    const r = await gvCommand({ action: "GET_LOGS", module: "monitor", wait_time: 0, e_logid: 0, max_log: max });
    let parsed = null; try { parsed = JSON.parse(r.text); } catch { /* html/text */ }
    return { status: r.status, count: Array.isArray(parsed?.logs) ? parsed.logs.length : undefined,
      body: parsed || r.text.slice(0, 2000) };
  })
);
