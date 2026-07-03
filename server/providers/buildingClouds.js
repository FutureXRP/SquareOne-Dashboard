import { Router } from "express";
import { config, guard } from "../config.js";
import { requireAdmin } from "../auth.js";
import { credsFor } from "./userCreds.js";

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
