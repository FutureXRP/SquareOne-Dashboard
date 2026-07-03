import { Router } from "express";
import { config, guard } from "../config.js";
import { requireAdmin } from "../auth.js";

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
      signal: AbortSignal.timeout(9000),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* HTML or plain text */ }
    const looksJson = parsed !== null;
    return {
      path, style, status: res.status, ms: Date.now() - started,
      kind: looksJson ? "json" : text.trim().startsWith("<") ? "html" : "text",
      keys: looksJson && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 20) : undefined,
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
  // Surface interesting responses first: JSON beats HTML, non-404 beats 404.
  results.sort((a, b) => (a.kind === "json" ? 0 : 1) - (b.kind === "json" ? 0 : 1) || (a.status ?? 999) - (b.status ?? 999));
  return { base, tried: results.length, top: results.slice(0, 12) };
}

function makeProbeRouter(providerKey, extraBases = []) {
  const router = Router();
  router.get(
    "/debug",
    requireAdmin,
    guard(providerKey, async () => {
      const c = config[providerKey];
      const bases = [c.baseUrl, ...extraBases].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
      const probes = [];
      for (const base of bases) probes.push(await probeLogin(base, c.email, c.password));
      return { provider: providerKey, probes };
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
