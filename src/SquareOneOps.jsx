import React, { useState, useMemo, useRef, useEffect, useCallback, Suspense, lazy } from "react";
import {
  ShieldCheck, ShieldAlert, Lock, Unlock, Thermometer, ListChecks,
  Clock, Bell, Terminal, ChevronUp, ChevronDown, Send, Power,
  Sun, Moon, Plane, AlertTriangle, CircleCheck, Activity, Droplets,
  Calendar, Users, Video, Baby, Wifi, WifiOff, RefreshCw, UserCheck,
  DoorOpen, Building2, TrendingUp, LogOut, DollarSign, Settings, KeyRound, Loader2, Check, Trash2,
  LayoutGrid, Eye, EyeOff, ArrowLeft, ArrowRight, Pencil,
} from "lucide-react";
import { usePrefs } from "./usePrefs.js";

// Compact currency, e.g. 1575 -> "$1,575". Non-numbers pass through as "$0".
const fmtMoney = (n) => "$" + (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
import { useDashboardData } from "./useDashboardData.js";
import { apiFetch } from "./lib/api.js";
import { useHub } from "./useHub.js";
import { BrandLogo } from "./BrandLogo.jsx";
// Lazy so hls.js (the bulk of the bundle) only loads when a live view is opened.
const LivePlayer = lazy(() => import("./LivePlayer.jsx").then((m) => ({ default: m.LivePlayer })));

/*
  SquareOne Operations Center
  ---------------------------
  One screen for "is the campus secure & ready, and let me change it" —
  plus the business side: who's booked which room, how many members we have,
  the camera system, and the Early Learning Center.

  ARCHITECTURE — read before wiring to live systems:

  Two very different classes of system feed this dashboard:

  1) ON-SITE / LAN devices — Gemini alarm, Pro1 HVAC, GV-Access doors.
     None has a clean public cloud API. They are adapted by ONE on-site hub
     (Home Assistant) that exposes a single clean REST API. Every real device
     action flows through the `hub` object below.

  2) CLOUD SaaS — Amilia (members + room bookings), Hik-Connect (cameras),
     ProCare (ELC). These are internet services with SECRET API keys. The
     browser must NOT hold those keys, and the vendors block direct browser
     calls (CORS). So every cloud read flows through the `api` object below,
     which in production calls YOUR backend proxy (e.g. /api/amilia/...),
     and the proxy adds the secret key and talks to the vendor.

  Today both `hub` and `api` run in PREVIEW MODE — they return/mutate local
  mock data so you can see and approve the UI. Each method documents the exact
  production call it should make. Flip CONNECTED.* to true as each goes live.
*/

// "Workspace" palette — a light admin surface with a navy sidebar and SquareOne
// brand accents (squareonecompassion.com). Keys are unchanged so every component
// adapts automatically; only the values shifted from the old dark scheme.
// `cyan` carries SquareOne blue, `amber` the brand orange, `navy` the sidebar.
const C = {
  bg: "#F4F7FB", panel: "#FFFFFF", panel2: "#F1F5FA", panelHi: "#E8EEF6",
  border: "#E3E9F1", borderHi: "#CBD6E3",
  text: "#1B2432", mid: "#5B6675", dim: "#8492A2",
  go: "#2F9E6F", goBg: "#E8F5EE",
  cyan: "#2E7BC4", cyanBg: "#E9F1FB",       // SquareOne brand blue
  amber: "#E8833A", amberBg: "#FBEEE1",     // SquareOne brand orange
  red: "#D84B40", redBg: "#FBEAE8",
  navy: "#16345F",                          // sidebar / deep brand navy
};
const mono = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, monospace";
const sans = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";


const TABS = [
  ["home", "Home", Activity],
  ["security", "Security", ShieldCheck],
  ["hvac", "Climate", Thermometer],
  ["bookings", "Bookings", Calendar],
  ["members", "Members", Users],
  ["cameras", "Cameras", Video],
  ["elc", "ELC", Baby],
  ["routines", "Routines", ListChecks],
  ["automation", "Automation", Clock],
  ["alerts", "Alerts", Bell],
  ["assistant", "Assistant", Terminal],
  ["settings", "Settings", Settings],
];

/* ------------------------- preview mock data (cloud) ------------------------- */
// Amilia — rooms booked today + membership summary.
const MOCK_BOOKINGS = [
  { id: 1, room: "Court A",      activity: "Adult Basketball", start: "08:00", end: "09:30", party: 14, status: "confirmed" },
  { id: 2, room: "Studio 1",     activity: "Morning Yoga",     start: "09:00", end: "10:00", party: 9,  status: "confirmed" },
  { id: 3, room: "Court B",      activity: "Pickleball Open",  start: "10:00", end: "12:00", party: 8,  status: "confirmed" },
  { id: 4, room: "Party Room",   activity: "Birthday — Nguyen",start: "13:00", end: "15:00", party: 22, status: "confirmed" },
  { id: 5, room: "Studio 2",     activity: "Spin Class",       start: "17:30", end: "18:15", party: 16, status: "confirmed" },
  { id: 6, room: "Golf Sim Bay", activity: "Private Lesson",   start: "18:30", end: "19:30", party: 2,  status: "pending" },
];
const MOCK_MEMBERS = {
  total: 1284, active: 1147, newThisMonth: 38, cancelledThisMonth: 11,
  byType: [
    { type: "Family",     count: 412 },
    { type: "Individual", count: 506 },
    { type: "Senior",     count: 188 },
    { type: "Student",    count: 178 },
  ],
  checkedInNow: 73,
};
// Hik-Connect — cameras.
const MOCK_CAMERAS = [
  { id: "cam-lobby",   name: "Main Lobby",      online: true,  motion: "2m ago",  recording: true },
  { id: "cam-court",   name: "Courts",          online: true,  motion: "just now", recording: true },
  { id: "cam-elc",     name: "ELC Hallway",     online: true,  motion: "11m ago", recording: true },
  { id: "cam-park-n",  name: "Parking North",   online: true,  motion: "1m ago",  recording: true },
  { id: "cam-park-s",  name: "Parking South",   online: false, motion: "—",       recording: false },
  { id: "cam-back",    name: "Back Entrance",   online: true,  motion: "34m ago", recording: true },
];
// ProCare — Early Learning Center.
const MOCK_ELC = {
  childrenPresent: 41, childrenEnrolled: 58, staffPresent: 9, requiredRatioStaff: 8,
  rooms: [
    { room: "Infants",     present: 6,  capacity: 8,  staff: 3 },
    { room: "Toddlers",    present: 11, capacity: 12, staff: 3 },
    { room: "Preschool",   present: 14, capacity: 18, staff: 2 },
    { room: "Pre-K",       present: 10, capacity: 20, staff: 1 },
  ],
  unreadMessages: 4,
};

export default function SquareOneOps({ user, role, authEnabled, onSignOut } = {}) {
  const [tab, setTab] = useState("home");
  const [prefs, setPrefs] = usePrefs(); // per-user UI prefs (camera wall layout, …)

  const [log, setLog] = useState([]);
  const pushLog = useCallback(
    (msg, kind = "info") => setLog((l) => [{ t: new Date(), msg, kind }, ...l].slice(0, 40)),
    []
  );

  /* ---- SEAM 1: the on-site hub (alarm / HVAC / doors) ----
     Live via Home Assistant when configured, local preview otherwise.
     See src/useHub.js and server/providers/homeassistant.js.                     */
  const { doors, alarm, zones, lockdown, hub, connected: hubConnected, reloadHub } = useHub(pushLog);

  /* ---- SEAM 2: cloud reads (Amilia / Hik-Connect / ProCare) ----
     Fetched server-side by the backend proxy (server/*) and delivered here by
     useDashboardData(). The proxy holds the API keys; the browser only ever
     calls /api/*.                                                                */
  const { bookings, members, cameras, elc, connected, usingMock, reload, snapshotUrl } =
    useDashboardData({ bookings: MOCK_BOOKINGS, members: MOCK_MEMBERS, cameras: MOCK_CAMERAS, elc: MOCK_ELC });

  /* ---- New-member sign-up feed ----
     Polls the rate-limited /api/alerts/check every 90s while the tab is
     visible: the server diffs the Amilia roster (at most ~once a minute
     globally) and returns the recent sign-up feed. New arrivals land in the
     activity log and the Alerts tab.                                          */
  const [memberSignups, setMemberSignups] = useState([]);
  const lastSignupRef = useRef(undefined); // undefined = first poll (seed silently)
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await apiFetch("/api/alerts/check", { method: "POST" }).then((res) => res.json());
        if (stop || !r?.ok) return;
        const recent = r.data?.recent || [];
        setMemberSignups(recent);
        const newest = recent[0]?.at ?? null;
        if (lastSignupRef.current !== undefined && newest && newest !== lastSignupRef.current) {
          pushLog(`🎉 ${recent[0].count === 1 ? "New member" : `${recent[0].count} new members`}: ${recent[0].members.join(", ")}`, "ok");
        }
        lastSignupRef.current = newest;
      } catch { /* offline/preview — feed just stays empty */ }
    };
    poll();
    const id = setInterval(() => { if (document.visibilityState === "visible") poll(); }, 90_000);
    return () => { stop = true; clearInterval(id); };
  }, [pushLog]);

  // The bell's notification list. Member sign-ups for now — future alert kinds
  // (camera offline, HVAC drift, low ELC ratio...) just append here.
  const notifications = useMemo(
    () =>
      memberSignups.map((s) => ({
        at: s.at,
        kind: "member",
        icon: UserCheck,
        color: C.go,
        text: `${s.count === 1 ? "New member" : `${s.count} new members`}: ${s.members.join(", ")}${s.more ? ` +${s.more} more` : ""}`,
      })),
    [memberSignups]
  );

  // Celebration popup on the Members tab: fires once per sign-up event (marker
  // kept in localStorage), only for events fresh within the last 24 hours.
  const [celebrate, setCelebrate] = useState(null);
  useEffect(() => {
    const newest = memberSignups[0];
    if (!newest || tab !== "members") return;
    const celebrated = localStorage.getItem("so-celebrated") || "";
    const fresh = Date.now() - new Date(newest.at).getTime() < 24 * 3600 * 1000;
    if (fresh && newest.at > celebrated) {
      localStorage.setItem("so-celebrated", newest.at);
      setCelebrate(newest);
    }
  }, [memberSignups, tab]);

  const [opening, setOpening] = useState(
    ["Unlock doors", "Disarm alarm", "HVAC to day mode", "Coffee started", "TVs on", "Golf sim ready", "Music playing"].map((l, i) => ({ id: i, label: l, done: false }))
  );
  const [closing, setClosing] = useState(
    ["Lock doors", "Arm alarm", "HVAC night mode", "Lights off", "Golf sim shutdown", "Arcade shutdown", "Medical closed"].map((l, i) => ({ id: i, label: l, done: false }))
  );

  // Campus verdict
  const verdict = useMemo(() => {
    const openDoors = doors.filter((d) => !d.locked);
    const hotZones = zones.filter((z) => Math.abs(z.now - z.set) > 2);
    if (lockdown) return { state: "LOCKDOWN", color: C.red, note: "Emergency lockdown engaged" };
    if (alarm !== "disarmed" && openDoors.length === 0)
      return { state: "SECURE", color: C.go, note: hotZones.length ? `Secure · ${hotZones.length} zone(s) off-target` : "All doors locked · alarm armed" };
    if (openDoors.length && alarm === "disarmed")
      return { state: "OPEN", color: C.cyan, note: `${openDoors.length} door(s) open · alarm off · operating` };
    return { state: "ATTENTION", color: C.amber, note: `${openDoors.length} door open with alarm set — verify` };
  }, [doors, zones, alarm, lockdown]);

  const freshSignup = memberSignups[0] && Date.now() - new Date(memberSignups[0].at).getTime() < 24 * 3600 * 1000;
  const pageTitle = (TABS.find(([id]) => id === tab) || [, "Home"])[1];

  // Visible tabs: Home and Settings are always available; the rest can be turned
  // off per user (by the person or by an admin) via prefs.tabs.
  const tabPrefs = prefs.tabs || {};
  const visibleTabs = TABS.filter(([id]) => id === "home" || id === "settings" || tabPrefs[id] !== false);
  useEffect(() => {
    if (!visibleTabs.some(([id]) => id === tab)) setTab("home");
  }, [tabPrefs]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: sans, minHeight: "100%" }}>
      <style>{`
        .so-btn{transition:all .12s ease;cursor:pointer;border:1px solid ${C.border};background:${C.panel2};color:${C.text}}
        .so-btn:hover{border-color:${C.borderHi};background:${C.panelHi}}
        .so-btn:focus-visible{outline:2px solid ${C.cyan};outline-offset:2px}
        .pulse{animation:so-pulse 2.4s ease-in-out infinite}
        @keyframes so-pulse{0%,100%{opacity:1}50%{opacity:.45}}
        .spin{animation:so-spin 1s linear infinite}
        @keyframes so-spin{to{transform:rotate(360deg)}}
        @media (prefers-reduced-motion: reduce){.pulse{animation:none}}
        ::placeholder{color:${C.dim}}
        /* Workspace shell */
        .so-shell{display:flex;min-height:100vh}
        .so-side{width:214px;flex:0 0 auto;display:flex;flex-direction:column;gap:5px;
          position:sticky;top:0;height:100vh;padding:15px 12px;background:${C.navy};color:#DCE6F2}
        .so-brand{display:flex;align-items:center;gap:10px;padding:6px 8px 15px}
        .so-nav{display:flex;flex-direction:column;gap:3px;overflow-y:auto}
        .so-navitem{display:flex;align-items:center;gap:11px;width:100%;text-align:left;border:none;
          cursor:pointer;padding:9px 11px;border-radius:9px;font-size:13.5px;font-family:inherit;color:#B7C7DC;background:transparent}
        .so-navitem:hover{background:rgba(255,255,255,.09)}
        .so-navitem:focus-visible{outline:2px solid #7FB2E6;outline-offset:-2px}
        .so-foot{margin-top:auto;display:flex;align-items:center;gap:8px;padding:11px 8px 3px;border-top:1px solid rgba(255,255,255,.12)}
        .so-signout{margin-left:auto;background:rgba(255,255,255,.09);border:none;color:#CFE0F2;cursor:pointer;padding:7px 9px;border-radius:7px;display:flex}
        .so-signout:hover{background:rgba(255,255,255,.18)}
        .so-main{flex:1;min-width:0;display:flex;flex-direction:column}
        .so-topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;
          padding:13px 24px;background:${C.panel};border-bottom:1px solid ${C.border};box-shadow:0 1px 0 0 ${C.amber}}
        .so-content{padding:20px 24px 64px;display:flex;flex-direction:column;gap:14px}
        @media (max-width:820px){
          .so-shell{flex-direction:column}
          .so-side{width:auto;height:auto;position:static;flex-direction:column;gap:8px}
          .so-nav{flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:2px}
          .so-navitem{flex:0 0 auto;padding:8px 10px}
          .so-navlabel{display:none}
          .so-foot{display:none}
          .so-brand{padding-bottom:2px}
        }
      `}</style>

      <div className="so-shell">
        {/* Sidebar */}
        <aside className="so-side">
          <div className="so-brand">
            <BrandLogo size={30} fallbackColor="#3B9BE8" />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fff", lineHeight: 1.1 }}>SquareOne</div>
              <div style={{ fontSize: 9, letterSpacing: 2, color: "#9FB4CF", fontFamily: mono, textTransform: "uppercase" }}>Operations</div>
            </div>
          </div>
          <nav className="so-nav">
            {visibleTabs.map(([id, label, Icon]) => {
              const active = tab === id;
              const alert = id === "alerts" && (zones.some((z) => Math.abs(z.now - z.set) > 2) || freshSignup);
              return (
                <button key={id} onClick={() => setTab(id)} className="so-navitem"
                  style={active ? { background: "rgba(255,255,255,.15)", color: "#fff", fontWeight: 600 } : undefined}>
                  <Icon size={16} /><span className="so-navlabel">{label}</span>
                  {alert && <span style={{ marginLeft: "auto", width: 7, height: 7, borderRadius: 99, background: C.amber }} />}
                </button>
              );
            })}
          </nav>
          {authEnabled && user && (
            <div className="so-foot">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "#EAF0F8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 130 }}>{user.email}</div>
                {role && <div style={{ fontSize: 9, color: "#8FA5C2", fontFamily: mono, textTransform: "uppercase", letterSpacing: 1 }}>{role}</div>}
              </div>
              <button onClick={onSignOut} className="so-signout" title="Sign out"><LogOut size={15} /></button>
            </div>
          )}
        </aside>

        {/* Main */}
        <main className="so-main">
          <header className="so-topbar">
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: -0.2 }}>{pageTitle}</h1>
            <div className="flex items-center gap-3">
              <NotificationBell notifications={notifications} />
              <ClockReadout />
            </div>
          </header>
          <div className="so-content">
            <ConnectionBar connected={{ hub: hubConnected, ...connected }} onReload={() => { reload(); reloadHub(); }} />
            {tab === "home" && <><Verdict v={verdict} /><Home doors={doors} zones={zones} alarm={alarm} log={log} setTab={setTab} members={members} bookings={bookings} cameras={cameras} elc={elc} /></>}
            {tab === "security" && <Security doors={doors} alarm={alarm} hub={hub} lockdown={lockdown} />}
            {tab === "hvac" && <Hvac zones={zones} hub={hub} />}
            {tab === "bookings" && <Bookings bookings={bookings} live={!usingMock.amilia} />}
            {tab === "members" && <Members members={members} live={!usingMock.amilia} />}
            {tab === "cameras" && <Cameras cameras={cameras} snapshotUrl={snapshotUrl} liveEnabled={connected.hik}
              layout={prefs.cameras || {}} onLayout={(cameras) => setPrefs({ cameras })} />}
            {tab === "elc" && <Elc elc={elc} live={!usingMock.procare} />}
            {tab === "routines" && <Routines opening={opening} setOpening={setOpening} closing={closing} setClosing={setClosing} />}
            {tab === "automation" && <Automation />}
            {tab === "alerts" && <Alerts zones={zones} doors={doors} cameras={cameras} elc={elc} memberSignups={memberSignups} />}
            {tab === "assistant" && <Assistant hub={hub} doors={doors} zones={zones} alarm={alarm} aiEnabled={connected.assistant} reloadHub={reloadHub} />}
            {tab === "settings" && <SettingsPage user={user} authEnabled={authEnabled} role={role}
              tabPrefs={tabPrefs} onTabPrefs={(tabs) => setPrefs({ tabs })} />}
          </div>
        </main>
      </div>
      {celebrate && <Celebration signup={celebrate} onClose={() => setCelebrate(null)} />}
    </div>
  );
}

/* ------------------------------ SETTINGS (per-user credentials) ------------------------------ */
// Each operator stores their OWN vendor logins so alarm/door/camera actions are
// attributed to them in the vendor's logs — not a shared account. Secrets are
// encrypted server-side and never sent back to the browser. Pro1 is shared
// (single login) and intentionally not here.
const CRED_PROVIDERS = [
  { key: "napco", label: "Gemini Alarm", hint: "Your Napco Gemini app username & password", user: "Username", hasSecret: true },
  { key: "geovision", label: "GV-Access Doors", hint: "Your GV-Access username & password", user: "Username", hasSecret: true },
  { key: "hik", label: "Hik Cameras", hint: "Your Hik-Connect user ID (for attribution in the camera log)", user: "Hik user ID", hasSecret: false },
];

// Tabs a user can turn off for themselves (Home and Settings always stay).
const TOGGLEABLE_TABS = TABS.filter(([id]) => id !== "home" && id !== "settings");

function SettingsPage({ user, authEnabled, role, tabPrefs = {}, onTabPrefs }) {
  const [state, setState] = useState(null); // { cryptoReady, providers }
  const load = useCallback(() => {
    apiFetch("/api/me/credentials").then((r) => r.json())
      .then((j) => { if (j.ok) setState(j.data); }).catch(() => setState({ error: true }));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (authEnabled && !user) return <Empty text="Sign in to manage your settings." />;
  return (
    <div className="grid gap-3">
      <MyTabsPanel tabPrefs={tabPrefs} onTabPrefs={onTabPrefs} />
      {role === "admin" && <TeamPanel />}
      {role === "admin" && <ActivityPanel />}
      <Panel title="My Credentials" accent={C.cyan}
        right={<span style={{ fontSize: 11, fontFamily: mono, color: C.mid }}>{user?.email}</span>}>
        <div style={{ fontSize: 13, color: C.mid, paddingBottom: 10, lineHeight: 1.5 }}>
          Enter your own logins for each system. When you arm the alarm or unlock a door from this
          dashboard, the action runs as <strong style={{ color: C.text }}>you</strong> — so the vendor's log shows who did it,
          not a shared account. Passwords are encrypted and never shown again.
        </div>
        {!authEnabled && (
          <div style={{ ...noteStyle(C.amber) }}>Sign-in isn't enabled yet, so credentials can't be saved per user. Ask your admin to turn on Supabase auth.</div>
        )}
        {state && !state.cryptoReady && (
          <div style={{ ...noteStyle(C.amber) }}>Server encryption key (CREDENTIAL_KEY) isn't set — passwords can't be stored until an admin adds it in Vercel.</div>
        )}
        {state?.providers && CRED_PROVIDERS.map((p) => (
          <CredRow key={p.key} def={p} current={state.providers[p.key]} disabled={!authEnabled} onSaved={load} />
        ))}
        {!state && <div style={{ padding: "10px 0", color: C.dim, fontFamily: mono, fontSize: 12.5 }}>Loading…</div>}
      </Panel>
      <Panel title="Pro1 Thermostats" accent={C.dim}>
        <div style={{ fontSize: 13, color: C.mid, lineHeight: 1.5 }}>
          Pro1 allows only one login, so it uses a single shared account for everyone — individual
          attribution isn't possible there. Dashboard actions are still logged against your dashboard sign-in.
        </div>
      </Panel>
      <Diagnostics />
    </div>
  );
}

// Admin diagnostics: runs each provider's connection probe through the signed-in
// session (so it carries your auth — pasting the /api/*/debug URL in the browser
// address bar doesn't). Shows the raw JSON to copy back for endpoint mapping.
const PROBES = [
  { key: "geovision", label: "GV-Access Doors", path: "/api/geovision/debug" },
  { key: "geovision-login", label: "GV-Access Login Test (deep)", path: "/api/geovision/login-probe" },
  { key: "geovision-discover", label: "GV-Access Discover Doors", path: "/api/geovision/discover" },
  { key: "geovision-doors", label: "GV-Access Find Door API", path: "/api/geovision/probe-doors" },
  { key: "napco", label: "Gemini Alarm", path: "/api/napco/debug" },
  { key: "pro1", label: "Pro1 Thermostats", path: "/api/pro1/debug" },
  { key: "hik", label: "Hik Cameras", path: "/api/hik/debug" },
  { key: "hik-camera", label: "Hik Camera Test (capture + live)", path: "/api/hik/debug/camera" },
  { key: "amilia", label: "Amilia", path: "/api/amilia/debug/raw" },
  { key: "auth-check", label: "Microsoft Login Check", path: "/api/admin/auth-check" },
];
function Diagnostics() {
  const [busy, setBusy] = useState(null);
  const [out, setOut] = useState({});
  const run = async (p) => {
    setBusy(p.key);
    try {
      const r = await apiFetch(p.path).then((res) => res.json());
      setOut((o) => ({ ...o, [p.key]: JSON.stringify(r, null, 2) }));
    } catch (e) {
      setOut((o) => ({ ...o, [p.key]: `Error: ${e.message}` }));
    } finally { setBusy(null); }
  };
  const copy = (text) => { try { navigator.clipboard?.writeText(text); } catch { /* ignore */ } };
  return (
    <Panel title="Connection Diagnostics" accent={C.amber}
      right={<span style={{ fontSize: 11, fontFamily: mono, color: C.mid }}>admin</span>}>
      <div style={{ fontSize: 13, color: C.mid, paddingBottom: 10, lineHeight: 1.5 }}>
        Test each integration's connection from your signed-in session. Run one, then use
        <strong style={{ color: C.text }}> Copy</strong> and paste the result back to finish wiring it up.
      </div>
      {PROBES.map((p) => (
        <div key={p.key} style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
          <div className="flex items-center justify-between" style={{ gap: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{p.label}</span>
            <div className="flex items-center gap-2">
              {out[p.key] && (
                <button onClick={() => copy(out[p.key])} className="so-btn" style={{ padding: "5px 12px", borderRadius: 7, fontSize: 12, color: C.mid }}>Copy</button>
              )}
              <button onClick={() => run(p)} disabled={busy === p.key} className="so-btn flex items-center gap-1.5"
                style={{ padding: "5px 14px", borderRadius: 7, fontSize: 12.5, fontWeight: 600, color: C.cyan, borderColor: C.cyan }}>
                {busy === p.key ? <Loader2 size={13} className="spin" /> : "Run test"}
              </button>
            </div>
          </div>
          {out[p.key] && (
            <pre style={{ marginTop: 9, padding: "10px 12px", background: C.panel2, border: `1px solid ${C.border}`,
              borderRadius: 7, fontSize: 11, fontFamily: mono, color: C.text, maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {out[p.key]}
            </pre>
          )}
        </div>
      ))}
    </Panel>
  );
}

function noteStyle(color) {
  return { margin: "6px 0 12px", padding: "9px 12px", borderRadius: 7, fontSize: 12.5,
    background: C.panel2, border: `1px solid ${color}`, color };
}

// A small on/off switch.
function Toggle({ on, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} role="switch" aria-checked={on}
      style={{ width: 40, height: 23, borderRadius: 99, border: "none", cursor: disabled ? "default" : "pointer",
        background: on ? C.go : C.borderHi, position: "relative", transition: "background .15s", opacity: disabled ? 0.5 : 1, flexShrink: 0 }}>
      <span style={{ position: "absolute", top: 2, left: on ? 19 : 2, width: 19, height: 19, borderRadius: 99,
        background: "#fff", transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,.3)" }} />
    </button>
  );
}

// My Tabs — each person shows/hides their own nav tabs.
function MyTabsPanel({ tabPrefs, onTabPrefs }) {
  const set = (id, on) => onTabPrefs?.({ ...tabPrefs, [id]: on });
  return (
    <Panel title="My Tabs" accent={C.cyan}>
      <div style={{ fontSize: 13, color: C.mid, paddingBottom: 6, lineHeight: 1.5 }}>
        Choose which sections appear in your sidebar. Home and Settings always stay.
      </div>
      {TOGGLEABLE_TABS.map(([id, label, Icon]) => (
        <div key={id} className="flex items-center justify-between" style={{ padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
          <span className="flex items-center gap-2" style={{ fontSize: 14 }}><Icon size={15} color={C.mid} />{label}</span>
          <Toggle on={tabPrefs[id] !== false} onClick={() => set(id, tabPrefs[id] === false)} />
        </div>
      ))}
    </Panel>
  );
}

// Team — admin: create logins, set role, control each user's visible tabs.
function TeamPanel() {
  const [users, setUsers] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [form, setForm] = useState({ email: "", password: "", role: "staff" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(() => {
    apiFetch("/api/admin/users").then((r) => r.json()).then((j) => { if (j.ok) setUsers(j.data); }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await apiFetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }).then((res) => res.json());
      if (!r.ok) throw new Error(r.message || "Could not create user");
      setForm({ email: "", password: "", role: "staff" }); setMsg({ ok: true, text: `Created ${r.data.email}` }); load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const setRole = async (id, role) => { await apiFetch(`/api/admin/users/${id}/role`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) }); load(); };
  const setUserTab = async (u, id, on) => {
    const tabs = { ...(u.tabs || {}), [id]: on };
    await apiFetch(`/api/admin/users/${u.id}/tabs`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tabs }) });
    load();
  };
  const remove = async (u) => {
    if (!window.confirm(`Remove ${u.email}? This deletes their login.`)) return;
    await apiFetch(`/api/admin/users/${u.id}`, { method: "DELETE" }); load();
  };

  return (
    <Panel title="Team" accent={C.navy} right={<span style={{ fontSize: 11, fontFamily: mono, color: C.mid }}>admin</span>}>
      {/* Create login */}
      <div style={{ padding: "4px 0 14px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Create a login</div>
        <div className="grid gap-2" style={{ gridTemplateColumns: "1.4fr 1fr auto auto" }}>
          <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="email@squareonecompassion.com" style={inputStyle} />
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Temp password (8+ chars)" style={inputStyle} />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={{ ...inputStyle, cursor: "pointer" }}>
            <option value="staff">Staff</option><option value="manager">Manager</option><option value="admin">Admin</option>
          </select>
          <button onClick={create} disabled={busy || !form.email || form.password.length < 8}
            style={{ padding: "0 16px", borderRadius: 7, border: "none", cursor: "pointer", background: C.cyan, color: "#fff", fontWeight: 700, fontSize: 13 }}>
            {busy ? <Loader2 size={14} className="spin" /> : "Create"}
          </button>
        </div>
        {msg && <div style={{ marginTop: 8, fontSize: 12, fontFamily: mono, color: msg.ok ? C.go : C.red }}>{msg.text}</div>}
      </div>

      {/* User list */}
      {!users && <div style={{ padding: "10px 0", color: C.dim, fontFamily: mono, fontSize: 12.5 }}>Loading…</div>}
      {users?.map((u) => (
        <div key={u.id} style={{ padding: "11px 0", borderBottom: `1px solid ${C.border}` }}>
          <div className="flex items-center justify-between gap-3">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
              <div style={{ fontSize: 11, color: C.dim, fontFamily: mono }}>
                {u.lastSignIn ? `last in ${new Date(u.lastSignIn).toLocaleDateString([], { month: "short", day: "numeric" })}` : "never signed in"}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select value={u.role || "staff"} onChange={(e) => setRole(u.id, e.target.value)} style={{ ...inputStyle, padding: "6px 8px", cursor: "pointer" }}>
                <option value="staff">Staff</option><option value="manager">Manager</option><option value="admin">Admin</option>
              </select>
              <button onClick={() => setExpanded(expanded === u.id ? null : u.id)} className="so-btn" style={{ padding: "6px 11px", borderRadius: 7, fontSize: 12, color: C.mid }}>Tabs</button>
              <button onClick={() => remove(u)} className="so-btn" title="Remove" style={{ padding: "6px 9px", borderRadius: 7, color: C.red, borderColor: C.border }}><Trash2 size={13} /></button>
            </div>
          </div>
          {expanded === u.id && (
            <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", marginTop: 10, padding: "10px 12px", background: C.panel2, borderRadius: 8 }}>
              {TOGGLEABLE_TABS.map(([id, label, Icon]) => {
                const on = (u.tabs || {})[id] !== false;
                return (
                  <label key={id} className="flex items-center gap-2" style={{ fontSize: 12.5, cursor: "pointer", color: C.text }}>
                    <input type="checkbox" checked={on} onChange={() => setUserTab(u, id, !on)} />
                    <Icon size={13} color={C.mid} />{label}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </Panel>
  );
}

// Activity — admin: recent sign-ins/outs and actions, newest first.
function ActivityPanel() {
  const [rows, setRows] = useState(null);
  const [authOnly, setAuthOnly] = useState(true);
  const load = useCallback((auth) => {
    apiFetch(`/api/admin/activity${auth ? "?kind=auth" : ""}`).then((r) => r.json()).then((j) => { if (j.ok) setRows(j.data); }).catch(() => {});
  }, []);
  useEffect(() => { load(authOnly); }, [authOnly, load]);
  const nice = (a) => ({ "auth.signin": "Signed in", "auth.signout": "Signed out" }[a] || a);
  const isAuth = (a) => a?.startsWith("auth.");
  return (
    <Panel title="Activity Log" accent={C.amber}
      right={
        <button onClick={() => setAuthOnly((v) => !v)} className="so-btn" style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11.5, color: C.mid }}>
          {authOnly ? "Sign-ins only" : "All activity"}
        </button>}>
      {!rows && <div style={{ padding: "10px 0", color: C.dim, fontFamily: mono, fontSize: 12.5 }}>Loading…</div>}
      {rows && rows.length === 0 && <Empty text="No activity yet." />}
      {rows?.map((r, i) => (
        <div key={i} className="flex items-center gap-3" style={{ padding: "8px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
          <span style={{ fontFamily: mono, fontSize: 11.5, color: C.dim, minWidth: 128 }}>
            {new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
          <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, color: isAuth(r.action) ? C.go : C.cyan, minWidth: 78 }}>{nice(r.action)}</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.email}</span>
        </div>
      ))}
    </Panel>
  );
}

function CredRow({ def, current, disabled, onSaved }) {
  const [username, setUsername] = useState(current?.username || "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    try {
      const r = await apiFetch(`/api/me/credentials/${def.key}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, secret }),
      }).then((res) => res.json());
      if (!r.ok) throw new Error(r.message || "Save failed");
      setSecret(""); setSaved(true); onSaved?.();
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setErr(null);
    try {
      await apiFetch(`/api/me/credentials/${def.key}`, { method: "DELETE" });
      setUsername(""); setSecret(""); onSaved?.();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div style={{ padding: "12px 0", borderBottom: `1px solid ${C.border}` }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        <div className="flex items-center gap-2">
          <KeyRound size={15} color={C.cyan} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>{def.label}</span>
          {current?.username && <span style={{ fontSize: 11, fontFamily: mono, color: C.go }}>· set</span>}
        </div>
        {current?.username && (
          <button onClick={remove} disabled={busy} title="Remove"
            style={{ background: "none", border: "none", cursor: "pointer", color: C.dim, display: "flex" }}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 8 }}>{def.hint}</div>
      <div className="grid gap-2" style={{ gridTemplateColumns: def.hasSecret ? "1fr 1fr auto" : "1fr auto" }}>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={def.user} disabled={disabled || busy}
          style={inputStyle} />
        {def.hasSecret && (
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
            placeholder={current?.hasSecret ? "Password (leave blank to keep)" : "Password"} disabled={disabled || busy} style={inputStyle} />
        )}
        <button onClick={save} disabled={disabled || busy || (!username && !secret)}
          style={{ padding: "0 16px", borderRadius: 7, border: "none", cursor: "pointer", background: C.cyan, color: C.bg, fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          {busy ? <Loader2 size={14} className="spin" /> : saved ? <Check size={14} /> : "Save"}
        </button>
      </div>
      {err && <div style={{ marginTop: 8, fontSize: 12, color: C.red, fontFamily: mono }}>{err}</div>}
    </div>
  );
}
const inputStyle = { padding: "9px 11px", background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, fontSize: 13.5, outline: "none", fontFamily: sans, minWidth: 0 };

/* ------------------------- notifications & celebration ------------------------- */

// Masthead bell: unread badge + dropdown. Opening it marks everything read
// (marker in localStorage so it survives refreshes).
function NotificationBell({ notifications }) {
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState(() => localStorage.getItem("so-notif-seen") || "");
  const unread = notifications.filter((n) => n.at > seenAt).length;
  const toggle = () => {
    setOpen((o) => !o);
    if (!open && notifications[0]) {
      localStorage.setItem("so-notif-seen", notifications[0].at);
      setSeenAt(notifications[0].at);
    }
  };
  return (
    <div style={{ position: "relative" }}>
      <button onClick={toggle} aria-label="Notifications"
        style={{ background: "transparent", border: `1px solid ${open ? C.borderHi : C.border}`, borderRadius: 8,
          padding: "7px 9px", cursor: "pointer", color: unread ? C.text : C.mid, position: "relative", display: "flex" }}>
        <Bell size={16} />
        {unread > 0 && (
          <span style={{ position: "absolute", top: -5, right: -5, minWidth: 16, height: 16, borderRadius: 99,
            background: C.amber, color: "#1A1108", fontSize: 10, fontWeight: 800, display: "flex",
            alignItems: "center", justifyContent: "center", padding: "0 4px", fontFamily: mono }}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
          <div style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 330, maxHeight: 380, overflowY: "auto",
            background: C.panel, border: `1px solid ${C.borderHi}`, borderRadius: 10, zIndex: 61,
            boxShadow: "0 12px 32px rgba(0,0,0,.45)" }}>
            <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 12, fontFamily: mono,
              letterSpacing: 1.5, textTransform: "uppercase", color: C.mid }}>
              Notifications
            </div>
            {notifications.length === 0 ? (
              <div style={{ padding: "18px 14px", fontSize: 13, color: C.dim }}>Nothing yet — new member sign-ups will show here.</div>
            ) : notifications.map((n, i) => (
              <div key={n.at + i} className="flex gap-2" style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                <n.icon size={15} color={n.color} style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ minWidth: 0 }}>
                  <div>{n.text}</div>
                  <div style={{ fontSize: 11, color: C.dim, fontFamily: mono, marginTop: 2 }}>
                    {new Date(n.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Full-screen celebration when a new member signs up (Members tab).
function Celebration({ signup, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 12000);
    return () => clearTimeout(t);
  }, [onClose]);
  const confetti = ["🎉", "🎊", "✨", "🎈", "⭐", "🎉", "✨", "🎊", "🎈", "⭐", "🎉", "✨"];
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(4,8,14,.65)", display: "flex", alignItems: "center",
        justifyContent: "center", zIndex: 100, backdropFilter: "blur(2px)" }}>
      {confetti.map((c, i) => (
        <span key={i} style={{ position: "absolute", top: -30, left: `${(i * 8.3 + 4) % 100}%`, fontSize: 22 + (i % 3) * 6,
          animation: `so-confetti ${2.6 + (i % 5) * 0.7}s linear ${(i % 6) * 0.45}s infinite` }}>{c}</span>
      ))}
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: C.panel, border: `1px solid ${C.borderHi}`, borderTop: `3px solid ${C.amber}`, borderRadius: 16,
          padding: "36px 44px 30px", textAlign: "center", maxWidth: 440, margin: 20, boxShadow: "0 24px 64px rgba(0,0,0,.5)" }}>
        <div style={{ fontSize: 48, lineHeight: 1 }}>🎉</div>
        <div style={{ fontSize: 22, fontWeight: 800, marginTop: 12 }}>Congratulations!</div>
        <div style={{ fontSize: 15, color: C.mid, marginTop: 6 }}>
          {signup.count === 1 ? "A new member has signed up!" : `${signup.count} new members have signed up!`}
        </div>
        <div style={{ fontSize: 15, color: C.cyan, fontWeight: 600, marginTop: 10 }}>
          {signup.members.join(", ")}{signup.more ? ` +${signup.more} more` : ""}
        </div>
        <button onClick={onClose}
          style={{ marginTop: 20, padding: "9px 26px", borderRadius: 8, border: "none", cursor: "pointer",
            background: C.cyan, color: C.bg, fontWeight: 700, fontSize: 13.5 }}>
          Awesome!
        </button>
      </div>
      <style>{`@keyframes so-confetti { 0% { transform: translateY(-4vh) rotate(0deg); opacity: 1 }
        100% { transform: translateY(106vh) rotate(340deg); opacity: .85 } }`}</style>
    </div>
  );
}

/* ----------------------------- shared bits ----------------------------- */
function Panel({ title, right, children, accent }) {
  return (
    <section style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
      {title && (
        <div className="flex items-center justify-between" style={{ padding: "11px 14px", borderBottom: `1px solid ${C.border}`, borderLeft: accent ? `3px solid ${accent}` : "none" }}>
          <span style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: C.mid, fontFamily: mono }}>{title}</span>
          {right}
        </div>
      )}
      <div style={{ padding: 14 }}>{children}</div>
    </section>
  );
}

// Shows which integrations are live vs preview. Honest at a glance.
function ConnectionBar({ connected, onReload }) {
  const items = [
    ["Hub", connected.hub],
    ["Amilia", connected.amilia],
    ["Hik-Connect", connected.hik],
    ["ProCare", connected.procare],
  ];
  const anyPreview = items.some(([, on]) => !on);
  return (
    <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 12, padding: "8px 12px", background: anyPreview ? C.amberBg : C.goBg, border: `1px solid ${C.border}`, borderLeft: `3px solid ${anyPreview ? C.amber : C.go}`, borderRadius: 6, fontSize: 12.5, fontFamily: mono }}>
      {anyPreview
        ? <AlertTriangle size={14} color={C.amber} />
        : <CircleCheck size={14} color={C.go} />}
      <span style={{ color: C.mid }}>
        {anyPreview ? "Preview — sample data until each is configured:" : "All integrations live."}
      </span>
      {items.map(([name, on]) => (
        <span key={name} className="flex items-center gap-1.5" style={{ color: on ? C.go : C.dim }}>
          {on ? <Wifi size={12} /> : <WifiOff size={12} />}{name}
        </span>
      ))}
      {onReload && (
        <button onClick={onReload} className="so-btn flex items-center gap-1.5"
          style={{ marginLeft: "auto", padding: "4px 10px", borderRadius: 6, fontSize: 12, fontFamily: mono, color: C.cyan }}>
          <RefreshCw size={12} /> refresh
        </button>
      )}
    </div>
  );
}

function ClockReadout() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const i = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(i); }, []);
  return (
    <div style={{ textAlign: "right", fontFamily: mono }}>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
      <div style={{ fontSize: 11, color: C.dim }}>{now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</div>
    </div>
  );
}

function Verdict({ v }) {
  return (
    <div className="flex items-center gap-4 flex-wrap" style={{ marginTop: 12, padding: "20px 22px", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, borderLeft: `4px solid ${v.color}` }}>
      <div className="flex items-center gap-3">
        <span className="pulse" style={{ width: 13, height: 13, borderRadius: 99, background: v.color, boxShadow: `0 0 14px ${v.color}` }} />
        <div>
          <div style={{ fontSize: 11, letterSpacing: 3, color: C.mid, fontFamily: mono, textTransform: "uppercase" }}>Campus Status</div>
          <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: -1, color: v.color, lineHeight: 1.05 }}>{v.state}</div>
        </div>
      </div>
      <div style={{ fontSize: 13.5, color: C.mid, fontFamily: mono, marginLeft: "auto", textAlign: "right" }}>{v.note}</div>
    </div>
  );
}

// Small reusable stat tile for the business tabs.
function Stat({ label, value, sub, color = C.text, icon: Icon }) {
  return (
    <div style={{ padding: "12px 14px", background: C.panel2, borderRadius: 8, border: `1px solid ${C.border}` }}>
      <div className="flex items-center gap-1.5" style={{ fontSize: 11, color: C.mid, fontFamily: mono, textTransform: "uppercase", letterSpacing: 1 }}>
        {Icon && <Icon size={12} />}{label}
      </div>
      <div style={{ fontSize: 30, fontWeight: 800, fontFamily: mono, letterSpacing: -1, color, lineHeight: 1.1, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: C.dim, fontFamily: mono }}>{sub}</div>}
    </div>
  );
}

/* ------------------------------- HOME ------------------------------- */
function Home({ doors, zones, alarm, log, setTab, members, bookings, cameras, elc }) {
  const locked = doors.filter((d) => d.locked).length;
  const camsOnline = cameras.filter((c) => c.online).length;
  const schedule = [["8:00", "Medical opens"], ["8:30", "Early Learning"], ["17:00", "Fitness"], ["21:00", "Lock campus"]];
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
      <Panel title="At a Glance" accent={C.cyan}>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Members" value={members.total} sub={`${members.checkedInNow} here now`} icon={Users} color={C.cyan} />
          <Stat label="Upcoming bookings" value={bookings.length} sub="next 14 days" icon={Calendar} color={C.cyan} />
          <Stat label="Cameras" value={`${camsOnline}/${cameras.length}`} sub="online" icon={Video} color={camsOnline === cameras.length ? C.go : C.amber} />
          <Stat label="ELC present" value={elc.childrenPresent} sub={`of ${elc.childrenEnrolled} enrolled`} icon={Baby} color={C.cyan} />
        </div>
      </Panel>

      <Panel title="Doors" accent={locked === doors.length ? C.go : C.amber} right={<button onClick={() => setTab("security")} style={{ background: "none", border: "none", color: C.cyan, fontSize: 12, cursor: "pointer", fontFamily: mono }}>manage →</button>}>
        {doors.map((d) => (
          <div key={d.id} className="flex items-center justify-between" style={{ padding: "7px 0", borderBottom: `1px solid ${C.border}`, fontSize: 14 }}>
            <span>{d.name}</span>
            <span className="flex items-center gap-1.5" style={{ color: d.locked ? C.go : C.amber, fontFamily: mono, fontSize: 12.5 }}>
              {d.locked ? <Lock size={13} /> : <Unlock size={13} />}{d.locked ? "Locked" : "Open"}
            </span>
          </div>
        ))}
      </Panel>

      <Panel title="Alarm" accent={alarm !== "disarmed" ? C.go : C.amber}>
        <div className="flex items-center gap-3" style={{ padding: "10px 0" }}>
          {alarm !== "disarmed" ? <ShieldCheck size={32} color={C.go} /> : <ShieldAlert size={32} color={C.amber} />}
          <div>
            <div style={{ fontSize: 19, fontWeight: 700, textTransform: "capitalize" }}>{alarm.replace("_", " ")}</div>
            <div style={{ fontSize: 12, color: C.dim, fontFamily: mono }}>Gemini · last sync 2m ago</div>
          </div>
        </div>
      </Panel>

      <Panel title="Next Bookings" accent={C.cyan} right={<button onClick={() => setTab("bookings")} style={{ background: "none", border: "none", color: C.cyan, fontSize: 12, cursor: "pointer", fontFamily: mono }}>all →</button>}>
        {bookings.slice(0, 4).map((b) => (
          <div key={b.id} className="flex items-center gap-3" style={{ padding: "7px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13.5 }}>
            <span style={{ fontFamily: mono, color: C.cyan, fontSize: 12.5, minWidth: 44 }}>{b.start}</span>
            <span style={{ flex: 1 }}>{b.room}</span>
            <span style={{ color: C.dim, fontSize: 12 }}>{b.activity}</span>
          </div>
        ))}
      </Panel>

      <Panel title="Climate" accent={zones.some((z) => Math.abs(z.now - z.set) > 2) ? C.amber : C.go} right={<button onClick={() => setTab("hvac")} style={{ background: "none", border: "none", color: C.cyan, fontSize: 12, cursor: "pointer", fontFamily: mono }}>adjust →</button>}>
        <div className="grid grid-cols-2 gap-2">
          {zones.map((z) => {
            const off = Math.abs(z.now - z.set) > 2;
            return (
              <div key={z.id} style={{ padding: "8px 10px", background: C.panel2, borderRadius: 7, border: `1px solid ${off ? C.amber : C.border}` }}>
                <div style={{ fontSize: 11, color: C.mid }}>{z.name}</div>
                <div style={{ fontSize: 22, fontWeight: 700, fontFamily: mono, color: off ? C.amber : C.text }}>{z.now}°</div>
                <div style={{ fontSize: 11, color: C.dim, fontFamily: mono }}>set {z.set}°</div>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel title="Today" accent={C.cyan}>
        {schedule.map(([t, label]) => (
          <div key={t} className="flex items-center gap-3" style={{ padding: "7px 0", borderBottom: `1px solid ${C.border}`, fontSize: 14 }}>
            <span style={{ fontFamily: mono, color: C.cyan, fontSize: 13, minWidth: 46 }}>{t}</span>{label}
          </div>
        ))}
      </Panel>

      <Panel title="Activity" accent={C.dim}>
        {log.length === 0 ? <Empty text="No actions yet. Use Security, Climate, or the Assistant to drive the campus." />
          : log.slice(0, 6).map((e, i) => (
            <div key={i} className="flex items-center gap-2" style={{ padding: "5px 0", fontSize: 12.5, fontFamily: mono, color: C.mid }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: C[e.kind] || C.dim }} />
              <span style={{ color: C.dim }}>{e.t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>{e.msg}
            </div>
          ))}
      </Panel>
    </div>
  );
}

/* ----------------------------- SECURITY ----------------------------- */
function Security({ doors, alarm, hub, lockdown }) {
  return (
    <div className="grid gap-3">
      <Panel title="Master Controls">
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
          <BigBtn icon={Lock} label="Lock campus" onClick={hub.lockAll} color={C.go} />
          <BigBtn icon={Unlock} label="Unlock campus" onClick={hub.unlockAll} color={C.cyan} />
          <BigBtn icon={ShieldCheck} label="Arm away" onClick={() => hub.arm("armed_away")} color={C.go} active={alarm === "armed_away"} />
          <BigBtn icon={ShieldAlert} label="Disarm" onClick={hub.disarm} color={C.amber} active={alarm === "disarmed"} />
        </div>
        <div style={{ marginTop: 10 }}>
          {!lockdown ? (
            <button onClick={hub.lockdown} className="so-btn" style={{ width: "100%", padding: "12px", borderRadius: 8, fontWeight: 700, letterSpacing: 1, color: C.red, background: C.redBg, borderColor: C.red }}>
              EMERGENCY LOCKDOWN
            </button>
          ) : (
            <button onClick={hub.clearLockdown} className="so-btn" style={{ width: "100%", padding: "12px", borderRadius: 8, fontWeight: 700, color: C.go, background: C.goBg, borderColor: C.go }}>
              Clear lockdown
            </button>
          )}
        </div>
      </Panel>

      <Panel title="Doors" accent={doors.every((d) => d.locked) ? C.go : C.amber}>
        {doors.map((d) => (
          <div key={d.id} className="flex items-center justify-between" style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
            <span className="flex items-center gap-2" style={{ fontSize: 14.5 }}>
              {d.locked ? <Lock size={15} color={C.go} /> : <Unlock size={15} color={C.amber} />}{d.name}
            </span>
            <button onClick={() => d.locked ? hub.unlockDoor(d.id) : hub.lockDoor(d.id)} className="so-btn"
              style={{ padding: "6px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, minWidth: 92,
                color: d.locked ? C.cyan : C.go, borderColor: d.locked ? C.border : C.go }}>
              {d.locked ? "Unlock" : "Lock"}
            </button>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function BigBtn({ icon: Icon, label, onClick, color, active }) {
  return (
    <button onClick={onClick} className="so-btn flex flex-col items-center gap-2"
      style={{ padding: "16px 10px", borderRadius: 9, borderColor: active ? color : C.border, background: active ? C.panelHi : C.panel2 }}>
      <Icon size={22} color={color} />
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
    </button>
  );
}

/* ------------------------------- HVAC ------------------------------- */
function Hvac({ zones, hub }) {
  return (
    <div className="grid gap-3">
      <Panel title="Climate Presets" accent={C.cyan}>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}>
          <Preset icon={Sun} label="Morning" onClick={() => hub.applyPreset("Morning")} />
          <Preset icon={Moon} label="Night" onClick={() => hub.applyPreset("Night")} />
          <Preset icon={Plane} label="Vacation" onClick={() => hub.applyPreset("Vacation")} />
        </div>
      </Panel>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }}>
        {zones.map((z) => {
          const off = Math.abs(z.now - z.set) > 2;
          return (
            <Panel key={z.id} title={z.name} accent={off ? C.amber : C.go}>
              <div className="flex items-center justify-between">
                <div>
                  <div style={{ fontSize: 11, color: C.dim, fontFamily: mono }}>SETPOINT</div>
                  <div style={{ fontSize: 44, fontWeight: 800, fontFamily: mono, letterSpacing: -1, lineHeight: 1 }}>{z.set}°</div>
                </div>
                <div className="flex flex-col gap-2">
                  <button onClick={() => hub.setTemp(z.id, z.set + 1)} className="so-btn" style={{ padding: 8, borderRadius: 6 }}><ChevronUp size={18} /></button>
                  <button onClick={() => hub.setTemp(z.id, z.set - 1)} className="so-btn" style={{ padding: 8, borderRadius: 6 }}><ChevronDown size={18} /></button>
                </div>
              </div>
              <div className="flex gap-4" style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}`, fontFamily: mono, fontSize: 12.5 }}>
                <span className="flex items-center gap-1.5" style={{ color: off ? C.amber : C.mid }}><Thermometer size={13} />{z.now}° now</span>
                <span className="flex items-center gap-1.5" style={{ color: C.mid }}><Droplets size={13} />{z.hum}%</span>
                <span style={{ color: C.cyan, marginLeft: "auto" }}>{z.mode}</span>
              </div>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}
function Preset({ icon: Icon, label, onClick }) {
  return (
    <button onClick={onClick} className="so-btn flex items-center justify-center gap-2" style={{ padding: "14px", borderRadius: 8 }}>
      <Icon size={17} color={C.cyan} /><span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
    </button>
  );
}

/* ----------------------------- BOOKINGS (Amilia) ----------------------------- */
function Bookings({ bookings, live }) {
  const [facilities, setFacilities] = useState([]);
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/amilia/facilities")
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j.ok && Array.isArray(j.data)) setFacilities(j.data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const roomCount = facilities.length || new Set(bookings.map((b) => b.room)).size;
  return (
    <div className="grid gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Stat label="Upcoming bookings" value={bookings.length} sub="next 90 days" icon={Calendar} color={C.cyan} />
        <Stat label="Facilities" value={roomCount} icon={Building2} color={C.cyan} />
      </div>
      <Panel title="Upcoming Bookings" accent={C.cyan}
        right={<SourceTag live={live} name="Amilia" />}>
      {bookings.length === 0 && <Empty text="No reservations in the next 90 days." />}
        {bookings.map((b) => (
          <div key={b.id} className="flex items-center gap-3" style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
            {b.color && <span style={{ width: 8, height: 8, borderRadius: 99, background: b.color, flexShrink: 0 }} />}
            {b.date && <span style={{ fontFamily: mono, color: C.mid, fontSize: 12.5, minWidth: 92 }}>{b.date}</span>}
            <span style={{ fontFamily: mono, color: C.cyan, fontSize: 13, minWidth: 96 }}>{b.start}{b.end ? `–${b.end}` : ""}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 600 }}>{b.room}</div>
              <div style={{ fontSize: 12.5, color: C.dim }}>{b.activity}{b.who ? ` · ${b.who}` : ""}</div>
            </div>
            <span style={{ fontSize: 11, fontFamily: mono, textTransform: "uppercase", letterSpacing: 1,
              color: b.status === "cancelled" ? C.red : C.go, minWidth: 76, textAlign: "right" }}>
              {b.status}
            </span>
          </div>
        ))}
      </Panel>
      <BookingAutomation />
      {facilities.length > 0 && (
        <Panel title={`Facilities · ${facilities.length}`} accent={C.dim} right={<SourceTag live={live} name="Amilia" />}>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }}>
            {facilities.map((f) => (
              <div key={f.id} style={{ padding: "8px 10px", background: C.panel2, borderRadius: 7, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
                <div style={{ fontSize: 12, color: C.mid, fontFamily: mono }}>{f.hours}</div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

// Booking-driven automation: each reservation unlocks its room's door ahead of
// start / relocks after end, and pre-conditions the room's HVAC to the event
// setpoint / sets back after (server/providers/doorSchedule.js).
function BookingAutomation() {
  const [sched, setSched] = useState(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/doors/schedule")
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j.ok && j.data) setSched(j.data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (!sched) return null;
  const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (ms) => new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const liveTag = (
    <span style={{ fontSize: 11, fontFamily: mono, color: sched.hubLive ? C.go : C.amber }}>
      {sched.hubLive ? "AUTO · Home Assistant" : "PLANNED · goes live with Home Assistant"}
    </span>
  );
  const Row = ({ from, to, room, sub, activity, chip: c, k }) => (
    <div key={k} className="flex items-center gap-3" style={{ padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
      <span style={{ fontFamily: mono, color: C.mid, fontSize: 12.5, minWidth: 92 }}>{day(from)}</span>
      <span style={{ fontFamily: mono, color: C.cyan, fontSize: 13, minWidth: 118 }}>{t(from)} → {t(to)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {room}{sub ? <span style={{ color: C.mid, fontWeight: 400 }}> · {sub}</span> : ""}
        </div>
        <div style={{ fontSize: 12.5, color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activity}</div>
      </div>
      <span style={{ fontSize: 11, fontFamily: mono, textTransform: "uppercase", letterSpacing: 1, color: c.color, flexShrink: 0 }}>
        {c.text}
      </span>
    </div>
  );
  const doorChip = (w) =>
    !w.doorId ? { text: "no door mapped", color: C.amber } :
    w.status === "open" ? { text: "OPEN NOW", color: C.go } :
    w.status === "done" ? { text: "done", color: C.dim } :
    { text: "scheduled", color: C.cyan };
  const climChip = (w) =>
    !w.zoneId ? { text: "no zone mapped", color: C.amber } :
    w.status === "conditioning" ? { text: "CONDITIONING", color: C.go } :
    w.status === "done" ? { text: "done", color: C.dim } :
    { text: "scheduled", color: C.cyan };
  return (
    <>
      {sched.windows?.length > 0 && (
        <Panel title="Door Schedule" accent={C.go} right={liveTag}>
          <div style={{ fontSize: 12, color: C.dim, fontFamily: mono, paddingBottom: 8 }}>
            unlock {sched.leadMin} min before · relock {sched.lagMin} min after each booking
          </div>
          {sched.windows.map((w) => (
            <Row key={w.id} k={w.id} from={w.unlockAt} to={w.relockAt} room={w.room}
              sub={w.doorName ? `${w.doorName} door` : ""} activity={w.activity} chip={doorChip(w)} />
          ))}
        </Panel>
      )}
      {sched.climate?.windows?.length > 0 && (
        <Panel title="Climate Schedule" accent={C.amber} right={liveTag}>
          <div style={{ fontSize: 12, color: C.dim, fontFamily: mono, paddingBottom: 8 }}>
            {sched.climate.eventTemp}° from {sched.climate.preMin} min before · back to {sched.climate.idleTemp}° {sched.climate.postMin} min after
            {" · overlapping events hold the event setpoint"}
          </div>
          {sched.climate.windows.map((w) => (
            <Row key={`c-${w.id}`} k={`c-${w.id}`} from={w.preAt} to={w.postAt} room={w.room}
              sub={w.zoneName ? `${w.zoneName} zone · ${w.eventTemp}°→${w.idleTemp}°` : ""} activity={w.activity} chip={climChip(w)} />
          ))}
        </Panel>
      )}
    </>
  );
}

/* ----------------------------- MEMBERS (Amilia) ----------------------------- */
function Members({ members, live }) {
  // Only plans people are actually on — offered-but-empty plans (e.g. a $1,200
  // plan with 0 members) are noise here, so they're summarized in the footer.
  const activePlans = members.byType.filter((t) => t.count > 0);
  const emptyPlans = members.byType.length - activePlans.length;
  const max = Math.max(1, ...activePlans.map((t) => t.count));
  const revenue = members.projectedRevenue ?? members.byType.reduce((s, t) => s + (t.revenue || 0), 0);
  const activePct = members.total ? Math.round((members.active / members.total) * 100) : 0;
  return (
    <div className="grid gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Stat label="Total members" value={members.total} icon={Users} color={C.cyan} />
        <Stat label="Active" value={members.active} sub={`${activePct}% of total`} icon={UserCheck} color={C.go} />
        <Stat label="Projected revenue" value={fmtMoney(revenue)} sub="list price × fees billed" icon={DollarSign} color={C.go} />
        <Stat label="Live plans" value={activePlans.length} sub={emptyPlans ? `of ${members.byType.length} offered` : undefined} icon={Building2} color={C.cyan} />
      </div>
      <Panel title="Membership by Type" accent={C.cyan}
        right={<SourceTag live={live} name="Amilia" />}>
        {activePlans.map((t) => (
          <div key={t.type} style={{ padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
            <div className="flex items-center justify-between gap-3" style={{ fontSize: 13.5, marginBottom: 6 }}>
              <span className="flex items-center gap-2" style={{ minWidth: 0, overflow: "hidden" }}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.type}</span>
                {/* Discontinued plan kept alive by grandfathered members. */}
                {t.legacy && <span style={{ fontSize: 10, fontFamily: mono, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 5px", flexShrink: 0 }}>LEGACY</span>}
              </span>
              <span className="flex items-center gap-3" style={{ fontFamily: mono, flexShrink: 0 }}>
                {t.price != null && <span style={{ color: C.dim, fontSize: 12 }}>{fmtMoney(t.price)} ea</span>}
                {/* When a plan bills once per family, show fees × people so the math is clear. */}
                {t.fees != null && t.fees !== t.count && (
                  <span style={{ color: C.amber, fontSize: 12 }}>{t.fees} {t.fees === 1 ? "fee" : "fees"}</span>
                )}
                {t.revenue != null && <span style={{ color: C.go }}>{fmtMoney(t.revenue)}</span>}
                <span style={{ color: C.mid, minWidth: 32, textAlign: "right" }}>{t.count}</span>
              </span>
            </div>
            <div style={{ height: 8, background: C.panel2, borderRadius: 99, overflow: "hidden" }}>
              <div style={{ width: `${(t.count / max) * 100}%`, height: "100%", background: C.cyan, borderRadius: 99 }} />
            </div>
          </div>
        ))}
        {emptyPlans > 0 && (
          <div style={{ paddingTop: 10, fontSize: 11.5, color: C.dim, fontFamily: mono }}>
            + {emptyPlans} offered {emptyPlans === 1 ? "plan" : "plans"} with no members yet
            {" — "}{members.byType.filter((t) => t.count === 0).map((t) => t.type).join(", ")}
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ----------------------------- CAMERAS (Hik-Connect) ----------------------------- */
// Grid presets: how many cameras per screen -> column count for the wall.
const CAM_SIZES = [
  { n: 4, cols: 2 }, { n: 8, cols: 4 }, { n: 16, cols: 4 }, { n: 24, cols: 6 },
];
function Cameras({ cameras, snapshotUrl, liveEnabled, layout = {}, onLayout }) {
  const online = cameras.filter((c) => c.online).length;
  const [liveCam, setLiveCam] = useState(null);
  const [arranging, setArranging] = useState(false);
  const [page, setPage] = useState(0);

  const size = layout.size ?? 8;              // number, or "all"
  const hidden = new Set(layout.hidden || []);
  const savedOrder = layout.order || [];

  // Effective order: saved order first (that still exist), then any new cameras
  // in API order. This is the full ordered id list we persist on reorder.
  const byId = new Map(cameras.map((c) => [c.id, c]));
  const orderedIds = [
    ...savedOrder.filter((id) => byId.has(id)),
    ...cameras.filter((c) => !savedOrder.includes(c.id)).map((c) => c.id),
  ];
  const orderedCams = orderedIds.map((id) => byId.get(id));
  const shown = arranging ? orderedCams : orderedCams.filter((c) => !hidden.has(c.id));

  const perPage = size === "all" ? Math.max(shown.length, 1) : size;
  const pages = Math.max(1, Math.ceil(shown.length / perPage));
  const curPage = Math.min(page, pages - 1);
  const pageCams = shown.slice(curPage * perPage, curPage * perPage + perPage);
  const cols = size === "all" ? 4 : (CAM_SIZES.find((s) => s.n === size)?.cols || 4);

  // Persist a change (merged onto the current layout).
  const save = (patch) => onLayout?.({ size, order: orderedIds, hidden: layout.hidden || [], ...patch });
  const setSize = (n) => { save({ size: n }); setPage(0); };
  const move = (id, dir) => {
    const arr = [...orderedIds];
    const i = arr.indexOf(id), j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    save({ order: arr });
  };
  const toggleHide = (id) => {
    const h = new Set(hidden);
    h.has(id) ? h.delete(id) : h.add(id);
    save({ hidden: [...h] });
  };
  const reset = () => onLayout?.({ size: 8, order: [], hidden: [] });
  const encryptedCount = cameras.filter((c) => c.encrypted && c.online).length;

  return (
    <div className="grid gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Stat label="Cameras" value={cameras.length} icon={Video} color={C.cyan} />
        <Stat label="Online" value={online} icon={Wifi} color={online === cameras.length ? C.go : C.amber} />
        {encryptedCount > 0
          ? <Stat label="Encrypted" value={encryptedCount} sub="need codes" icon={Lock} color={C.amber} />
          : <Stat label="Recording" value={cameras.filter((c) => c.recording).length} icon={Activity} color={C.go} />}
      </div>

      {/* Wall toolbar: grid size, arrange toggle, paging */}
      <div className="flex items-center gap-3" style={{ flexWrap: "wrap", justifyContent: "space-between" }}>
        <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
          <span style={{ fontFamily: mono, fontSize: 11, color: C.dim, textTransform: "uppercase", letterSpacing: 1 }}>
            <LayoutGrid size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />per screen
          </span>
          {CAM_SIZES.map((s) => (
            <SizeBtn key={s.n} label={s.n} active={size === s.n} onClick={() => setSize(s.n)} />
          ))}
          <SizeBtn label="All" active={size === "all"} onClick={() => setSize("all")} />
        </div>
        <div className="flex items-center gap-2">
          {arranging && <button onClick={reset} className="so-btn" style={{ padding: "5px 12px", borderRadius: 7, fontSize: 12, color: C.mid }}>Reset</button>}
          <button onClick={() => setArranging((a) => !a)} className="so-btn flex items-center gap-1.5"
            style={{ padding: "5px 12px", borderRadius: 7, fontSize: 12.5, fontWeight: 600,
              color: arranging ? C.bg : C.cyan, background: arranging ? C.cyan : C.panel2, borderColor: C.cyan }}>
            {arranging ? <><Check size={13} /> Done</> : <><Pencil size={13} /> Arrange</>}
          </button>
        </div>
      </div>
      {arranging && (
        <div style={{ fontSize: 12, color: C.dim, fontFamily: mono }}>
          Use ◀ ▶ to reorder and the eye to show/hide a camera. Your layout is saved to your account.
        </div>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
        {pageCams.map((c) => (
          <CameraTile key={c.id} c={c} snapshotUrl={snapshotUrl} liveEnabled={liveEnabled}
            arranging={arranging} isHidden={hidden.has(c.id)}
            onLive={() => setLiveCam(c)} onMove={(dir) => move(c.id, dir)} onToggleHide={() => toggleHide(c.id)} />
        ))}
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3" style={{ fontFamily: mono, fontSize: 12.5, color: C.mid }}>
          <button onClick={() => setPage(Math.max(0, curPage - 1))} disabled={curPage === 0} className="so-btn"
            style={{ padding: "5px 12px", borderRadius: 7, opacity: curPage === 0 ? 0.5 : 1 }}>Prev</button>
          <span>Screen {curPage + 1} / {pages}</span>
          <button onClick={() => setPage(Math.min(pages - 1, curPage + 1))} disabled={curPage >= pages - 1} className="so-btn"
            style={{ padding: "5px 12px", borderRadius: 7, opacity: curPage >= pages - 1 ? 0.5 : 1 }}>Next</button>
        </div>
      )}

      {liveCam && (
        <Suspense fallback={null}>
          <LivePlayer camera={liveCam} onClose={() => setLiveCam(null)} />
        </Suspense>
      )}
    </div>
  );
}

function SizeBtn({ label, active, onClick }) {
  return (
    <button onClick={onClick} className="so-btn"
      style={{ padding: "5px 12px", borderRadius: 7, fontSize: 12.5, fontWeight: 700, fontFamily: mono,
        color: active ? C.bg : C.mid, background: active ? C.cyan : C.panel2, borderColor: active ? C.cyan : C.border }}>
      {label}
    </button>
  );
}

function CameraTile({ c, snapshotUrl, liveEnabled, arranging, isHidden, onLive, onMove, onToggleHide }) {
  const snap = c.online ? snapshotUrl(c.id) : null;
  const canLive = liveEnabled && c.online && !arranging;
  return (
    <Panel title={c.name} accent={c.online ? C.go : C.red}
      right={<span className="flex items-center gap-1.5" style={{ fontFamily: mono, fontSize: 11, color: c.online ? C.go : C.red }}>
        {c.online ? <Wifi size={12} /> : <WifiOff size={12} />}{c.online ? "online" : "offline"}
      </span>}>
      <button onClick={() => canLive && onLive()} disabled={!canLive}
        style={{ all: "unset", display: "block", width: "100%", cursor: canLive ? "pointer" : "default", opacity: arranging && isHidden ? 0.4 : 1 }}>
        <div style={{ aspectRatio: "16/9", background: "#05080B", borderRadius: 7, border: `1px solid ${C.border}`,
          display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative" }}>
          <Snapshot path={snap} name={c.name} online={c.online} encrypted={c.encrypted} camId={c.id} liveEnabled={liveEnabled} />
          {c.recording && !arranging && (
            <span className="pulse" style={{ position: "absolute", top: 8, left: 8, display: "flex", alignItems: "center", gap: 5, fontSize: 10, fontFamily: mono, color: C.red }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: C.red }} />REC
            </span>
          )}
          {canLive && (
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.25)", opacity: 0, transition: "opacity .15s" }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = 1)} onMouseLeave={(e) => (e.currentTarget.style.opacity = 0)}>
              <span className="flex items-center gap-1.5" style={{ fontFamily: mono, fontSize: 12, color: C.text, background: "rgba(0,0,0,.6)", padding: "6px 12px", borderRadius: 99 }}>
                <Video size={13} color={C.cyan} /> Live
              </span>
            </span>
          )}
        </div>
      </button>
      {arranging ? (
        <div className="flex items-center justify-between" style={{ marginTop: 10 }}>
          <div className="flex items-center gap-1.5">
            <button onClick={() => onMove(-1)} className="so-btn" title="Move earlier" style={{ padding: "5px 9px", borderRadius: 6, color: C.mid }}><ArrowLeft size={13} /></button>
            <button onClick={() => onMove(1)} className="so-btn" title="Move later" style={{ padding: "5px 9px", borderRadius: 6, color: C.mid }}><ArrowRight size={13} /></button>
          </div>
          <button onClick={onToggleHide} className="so-btn flex items-center gap-1.5"
            style={{ padding: "5px 10px", borderRadius: 6, fontSize: 12, color: isHidden ? C.dim : C.cyan, borderColor: isHidden ? C.border : C.cyan }}>
            {isHidden ? <><EyeOff size={12} /> Hidden</> : <><Eye size={12} /> Shown</>}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between" style={{ marginTop: 10, fontFamily: mono, fontSize: 12, color: C.mid }}>
          <span className="flex items-center gap-1.5"><Activity size={12} />motion {c.motion}</span>
          {canLive && (
            <button onClick={onLive} className="so-btn flex items-center gap-1.5"
              style={{ padding: "4px 10px", borderRadius: 6, fontSize: 12, color: C.cyan, borderColor: C.cyan }}>
              <Video size={12} /> Live
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ----------------------------- ELC (ProCare) ----------------------------- */
function Elc({ elc, live }) {
  const ratioOk = elc.staffPresent >= elc.requiredRatioStaff;
  return (
    <div className="grid gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Stat label="Children present" value={elc.childrenPresent} sub={`of ${elc.childrenEnrolled} enrolled`} icon={Baby} color={C.cyan} />
        <Stat label="Staff present" value={elc.staffPresent} sub={`need ${elc.requiredRatioStaff}`} icon={UserCheck} color={ratioOk ? C.go : C.red} />
        <Stat label="Ratio" value={ratioOk ? "OK" : "LOW"} icon={ShieldCheck} color={ratioOk ? C.go : C.red} />
        <Stat label="Parent messages" value={elc.unreadMessages} sub="unread" icon={Bell} color={elc.unreadMessages ? C.amber : C.dim} />
      </div>
      <Panel title="Rooms" accent={ratioOk ? C.go : C.red}
        right={<SourceTag live={live} name="ProCare" />}>
        {elc.rooms.map((r) => {
          const full = r.present >= r.capacity;
          return (
            <div key={r.room} className="flex items-center gap-3" style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14.5, fontWeight: 600 }}>{r.room}</div>
                <div style={{ fontSize: 12, color: C.dim, fontFamily: mono }}>{r.staff} staff</div>
              </div>
              <div style={{ width: 120 }}>
                <div className="flex items-center justify-between" style={{ fontFamily: mono, fontSize: 12, color: full ? C.amber : C.mid, marginBottom: 5 }}>
                  <span>{r.present}/{r.capacity}</span>{full && <span style={{ color: C.amber }}>FULL</span>}
                </div>
                <div style={{ height: 8, background: C.panel2, borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ width: `${(r.present / r.capacity) * 100}%`, height: "100%", background: full ? C.amber : C.go, borderRadius: 99 }} />
                </div>
              </div>
            </div>
          );
        })}
      </Panel>
      {!live && (
        <div style={{ fontSize: 12, color: C.dim, fontFamily: mono, padding: "0 2px" }}>
          Note: ProCare does not publish a broadly-available public API. Confirm partner/API
          access for your account before wiring this tab to live data.
        </div>
      )}
    </div>
  );
}

/* ----------------------------- ROUTINES ----------------------------- */
function Routines({ opening, setOpening, closing, setClosing }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))" }}>
      <Checklist title="Opening" items={opening} setItems={setOpening} doneLabel="Campus ready" color={C.cyan} />
      <Checklist title="Closing" items={closing} setItems={setClosing} doneLabel="Campus secure" color={C.go} />
    </div>
  );
}
function Checklist({ title, items, setItems, doneLabel, color }) {
  const done = items.filter((i) => i.done).length;
  const all = done === items.length;
  const toggle = (id) => setItems((it) => it.map((x) => x.id === id ? { ...x, done: !x.done } : x));
  const reset = () => setItems((it) => it.map((x) => ({ ...x, done: false })));
  return (
    <Panel title={`${title} · ${done}/${items.length}`} accent={all ? color : C.border}
      right={<button onClick={reset} style={{ background: "none", border: "none", color: C.dim, fontSize: 12, cursor: "pointer", fontFamily: mono }}>reset</button>}>
      {items.map((i) => (
        <button key={i.id} onClick={() => toggle(i.id)} className="flex items-center gap-3" style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ width: 20, height: 20, borderRadius: 5, border: `1.5px solid ${i.done ? color : C.borderHi}`, background: i.done ? color : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {i.done && <CircleCheck size={14} color={C.bg} />}
          </span>
          <span style={{ fontSize: 14, color: i.done ? C.dim : C.text, textDecoration: i.done ? "line-through" : "none" }}>{i.label}</span>
        </button>
      ))}
      <div style={{ marginTop: 12, padding: "10px", textAlign: "center", borderRadius: 8, fontWeight: 700, letterSpacing: 1,
        background: all ? color : C.panel2, color: all ? C.bg : C.dim, transition: "all .2s" }}>
        {all ? doneLabel.toUpperCase() : `${items.length - done} remaining`}
      </div>
    </Panel>
  );
}

/* ---------------------------- AUTOMATION ---------------------------- */
function Automation() {
  const flows = [
    { time: "7:30 AM", name: "Open campus", on: true, steps: ["Unlock doors", "Disarm alarm", "HVAC → day mode", "Confirm “Campus ready”"], color: C.cyan },
    { time: "9:15 PM", name: "Secure campus", on: true, steps: ["Lock doors", "Arm alarm", "HVAC → night mode", "Verify all doors", "Confirm “Campus secured”"], color: C.go },
  ];
  return (
    <div className="grid gap-3">
      <div style={{ fontSize: 13, color: C.mid, fontFamily: mono, padding: "0 2px" }}>
        Scheduled flows run on the on-site hub so they fire even if no one opens this dashboard.
      </div>
      {flows.map((f) => (
        <Panel key={f.name} accent={f.color} title={`${f.time} · ${f.name}`}
          right={<span className="flex items-center gap-2" style={{ fontFamily: mono, fontSize: 12, color: f.on ? C.go : C.dim }}><Power size={13} />{f.on ? "ENABLED" : "OFF"}</span>}>
          <div className="flex flex-col gap-0">
            {f.steps.map((s, i) => (
              <div key={i} className="flex items-center gap-3" style={{ fontSize: 14, color: C.mid }}>
                <div className="flex flex-col items-center" style={{ width: 16 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: f.color }} />
                  {i < f.steps.length - 1 && <span style={{ width: 2, height: 20, background: C.border }} />}
                </div>
                <span style={{ paddingBottom: i < f.steps.length - 1 ? 12 : 0 }}>{s}</span>
              </div>
            ))}
          </div>
        </Panel>
      ))}
    </div>
  );
}

/* ------------------------------ ALERTS ------------------------------ */
function Alerts({ zones, doors, cameras, elc, memberSignups = [] }) {
  const alerts = [];
  zones.forEach((z) => { if (Math.abs(z.now - z.set) > 2) alerts.push({ sev: "warn", msg: `${z.name} is ${z.now}° (set ${z.set}°)` }); });
  doors.forEach((d) => { if (!d.locked) alerts.push({ sev: "warn", msg: `${d.name} is unlocked` }); });
  cameras.forEach((c) => { if (!c.online) alerts.push({ sev: "warn", msg: `Camera offline: ${c.name}` }); });
  if (elc && elc.staffPresent < elc.requiredRatioStaff) alerts.push({ sev: "warn", msg: `ELC staff ratio low (${elc.staffPresent}/${elc.requiredRatioStaff})` });
  const watch = ["HVAC offline", "Alarm comms failure", "Freezer high temp", "Water leak", "Power outage", "Internet down", "Camera offline", "ELC ratio low"];
  return (
    <div className="grid gap-3">
      {memberSignups.length > 0 && (
        <Panel title="Member Sign-ups" accent={C.go}>
          {memberSignups.map((s, i) => (
            <div key={s.at + i} className="flex items-center gap-3" style={{ padding: "9px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13.5 }}>
              <span style={{ fontFamily: mono, color: C.mid, fontSize: 12, minWidth: 130 }}>
                {new Date(s.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
              <UserCheck size={15} color={C.go} style={{ flexShrink: 0 }} />
              <span style={{ minWidth: 0 }}>
                {s.count === 1 ? "New member: " : `${s.count} new members: `}
                {s.members.join(", ")}{s.more ? ` +${s.more} more` : ""}
              </span>
            </div>
          ))}
        </Panel>
      )}
      <Panel title={`Active · ${alerts.length}`} accent={alerts.length ? C.amber : C.go}>
        {alerts.length === 0 ? (
          <div className="flex items-center gap-2" style={{ color: C.go, padding: "8px 0", fontSize: 14 }}><CircleCheck size={17} /> All clear — nothing needs attention.</div>
        ) : alerts.map((a, i) => (
          <div key={i} className="flex items-center gap-2" style={{ padding: "9px 0", borderBottom: `1px solid ${C.border}`, fontSize: 14 }}>
            <AlertTriangle size={16} color={C.amber} />{a.msg}
          </div>
        ))}
      </Panel>
      <Panel title="Monitored Conditions" accent={C.dim}>
        <div className="grid grid-cols-2 gap-2">
          {watch.map((w) => (
            <div key={w} className="flex items-center gap-2" style={{ fontSize: 13, color: C.mid, fontFamily: mono, padding: "5px 0" }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: C.go }} />{w}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: C.dim, fontFamily: mono }}>Only conditions that need you trigger a notification. Everything green stays silent.</div>
      </Panel>
    </div>
  );
}

/* ----------------------------- ASSISTANT ----------------------------- */
function Assistant({ hub, doors, zones, alarm, aiEnabled, reloadHub }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([
    { role: "sys", text: aiEnabled
      ? "AI assistant ready. Ask in plain English: “lock up for the night”, “set the early learning room to 70”, “is the campus secure?”, “unlock the medical door”."
      : "Type a command. Try: “lock the campus”, “set fitness to 70”, “is everything secure?”, “open medical”." },
  ]);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [history]);

  // AI mode: send the conversation to the backend agent, which executes real
  // campus actions via Home Assistant and returns a reply + the actions taken.
  const sendToAgent = async (text) => {
    const convo = [...history, { role: "you", text }]
      .filter((m) => m.role === "you" || m.role === "bot")
      .map((m) => ({ role: m.role === "you" ? "user" : "assistant", content: m.text }));
    setHistory((h) => [...h, { role: "you", text }]);
    setBusy(true);
    try {
      const r = await apiFetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: convo }),
      }).then((res) => res.json());
      if (r.ok) {
        setHistory((h) => [...h, { role: "bot", text: r.reply }]);
        if (r.actions?.length) reloadHub?.(); // re-sync hub state after any actions
      } else {
        setHistory((h) => [...h, { role: "bot", text: r.message || "Assistant unavailable." }]);
      }
    } catch (e) {
      setHistory((h) => [...h, { role: "bot", text: `Error reaching the assistant: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const respond = (text) => {
    const q = text.toLowerCase().trim();
    const say = (t) => setHistory((h) => [...h, { role: "you", text }, { role: "bot", text: t }]);

    // In production, an unrecognized command would be sent to the Anthropic API
    // for intent parsing, then mapped to the same hub.* calls used below.
    if (/lock\s?down|emergency/.test(q)) { hub.lockdown(); return say("Emergency lockdown engaged. All doors locked, alarm armed away."); }
    if (/(lock|secure|close).*(campus|everything|up|all)|^lock up/.test(q)) { hub.lockAll(); hub.arm("armed_away"); return say("Done. All doors locked and alarm armed away."); }
    if (/(unlock|open).*(campus|everything|all)/.test(q)) { hub.unlockAll(); hub.disarm(); return say("Done. Campus unlocked and alarm disarmed."); }
    if (/disarm/.test(q)) { hub.disarm(); return say("Alarm disarmed."); }
    if (/\barm\b/.test(q)) { hub.arm("armed_away"); return say("Alarm armed away."); }

    const setMatch = q.match(/set\s+(?:the\s+)?([a-z ]+?)\s+to\s+(\d{2})/);
    if (setMatch) {
      const z = zones.find((x) => setMatch[1].includes(x.name.toLowerCase().split(" ")[0]));
      if (z) { hub.setTemp(z.id, +setMatch[2]); return say(`${z.name} set to ${setMatch[2]}°.`); }
      return say(`I couldn't match a zone in “${setMatch[1].trim()}”. Zones: ${zones.map((x) => x.name).join(", ")}.`);
    }
    const doorMatch = q.match(/(open|unlock|lock)\s+(?:the\s+)?([a-z ]+)/);
    if (doorMatch) {
      const d = doors.find((x) => doorMatch[2].includes(x.name.toLowerCase().split(" ")[0]));
      if (d) { doorMatch[1] === "lock" ? hub.lockDoor(d.id) : hub.unlockDoor(d.id); return say(`${d.name} ${doorMatch[1] === "lock" ? "locked" : "unlocked"}.`); }
    }
    if (/secure|status|safe|everything ok|all good/.test(q)) {
      const open = doors.filter((d) => !d.locked);
      const hot = zones.filter((z) => Math.abs(z.now - z.set) > 2);
      let r = open.length === 0 && alarm !== "disarmed" ? "Everything is secure. All doors locked and the alarm is armed." : "";
      if (open.length) r += `${open.length} door(s) open: ${open.map((d) => d.name).join(", ")}. `;
      if (alarm === "disarmed") r += "Alarm is disarmed. ";
      if (hot.length) r += `${hot.length} zone(s) off-target: ${hot.map((z) => z.name).join(", ")}.`;
      return say(r.trim() || "Everything is secure.");
    }
    if (/open door|what.?s open|show.*open/.test(q)) {
      const open = doors.filter((d) => !d.locked);
      return say(open.length ? `Open: ${open.map((d) => d.name).join(", ")}.` : "All doors are locked.");
    }
    return say("I didn't catch that. Try: “lock the campus”, “set fitness to 70”, “is everything secure?”, or “open medical”.");
  };

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    if (aiEnabled) sendToAgent(text);
    else respond(text);
  };
  return (
    <Panel title={aiEnabled ? "Assistant · AI" : "Assistant"} accent={C.cyan}>
      <div style={{ maxHeight: 380, overflowY: "auto", marginBottom: 12 }}>
        {history.map((m, i) => (
          <div key={i} style={{ margin: "8px 0", display: "flex", justifyContent: m.role === "you" ? "flex-end" : "flex-start" }}>
            <div style={{ maxWidth: "85%", padding: "9px 13px", borderRadius: 10, fontSize: 13.5,
              fontFamily: m.role === "sys" ? mono : sans,
              background: m.role === "you" ? C.cyanBg : C.panel2,
              border: `1px solid ${m.role === "you" ? C.cyan : C.border}`,
              color: m.role === "sys" ? C.dim : C.text }}>
              {m.text}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={busy ? "Thinking…" : "Lock the campus…"} disabled={busy}
          style={{ flex: 1, padding: "11px 14px", borderRadius: 8, background: C.panel2, border: `1px solid ${C.border}`, color: C.text, fontSize: 14, outline: "none", fontFamily: sans, opacity: busy ? 0.6 : 1 }} />
        <button onClick={submit} disabled={busy} className="so-btn" style={{ padding: "0 16px", borderRadius: 8, color: C.cyan, borderColor: C.cyan, opacity: busy ? 0.6 : 1 }}><Send size={17} /></button>
      </div>
    </Panel>
  );
}

function Empty({ text }) {
  return <div style={{ color: C.dim, fontSize: 13, fontStyle: "italic", padding: "6px 0" }}>{text}</div>;
}

// Signed-in user + role + sign out, shown in the masthead when auth is on.
function AccountChip({ user, role, onSignOut }) {
  return (
    <div className="flex items-center gap-2">
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 12.5, color: C.text, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>
        {role && <div style={{ fontSize: 10.5, color: C.dim, fontFamily: mono, textTransform: "uppercase", letterSpacing: 1 }}>{role}</div>}
      </div>
      <button onClick={onSignOut} className="so-btn flex items-center gap-1.5" title="Sign out"
        style={{ padding: "6px 10px", borderRadius: 6, fontSize: 12, color: C.mid }}>
        <LogOut size={13} />
      </button>
    </div>
  );
}

// Limit concurrent live-frame grabs so we don't spin up many HLS streams at once.
let posterActive = 0;
const posterQueue = [];
function runPoster(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      posterActive++;
      task().then(resolve, reject).finally(() => { posterActive--; const n = posterQueue.shift(); if (n) n(); });
    };
    if (posterActive < 3) start(); else posterQueue.push(start);
  });
}

// Grab a single frame from a camera's live HLS stream as a JPEG data URL. Uses
// hls.js (MSE) rather than native HLS so the canvas isn't cross-origin tainted.
async function grabLiveFrame(camId) {
  const r = await apiFetch(`/api/hik/cameras/${camId}/live`).then((res) => res.json());
  const url = r?.data?.url;
  if (!url) throw new Error("no live url");
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) throw new Error("hls unsupported");
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true;
    const hls = new Hls({ maxBufferLength: 4 });
    let done = false;
    const cleanup = () => { clearTimeout(timer); try { hls.destroy(); } catch { /* ignore */ } };
    const capture = () => {
      if (done || !video.videoWidth) return;
      done = true;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        const data = canvas.toDataURL("image/jpeg", 0.7);
        cleanup(); resolve(data);
      } catch (e) { cleanup(); reject(e); }
    };
    video.addEventListener("loadeddata", capture);
    video.addEventListener("timeupdate", capture);
    hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal && !done) { done = true; cleanup(); reject(new Error(d.details)); } });
    hls.loadSource(url); hls.attachMedia(video);
    video.play?.().catch(() => {});
    const timer = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error("timeout")); } }, 18000);
  });
}

// Camera snapshot loaded through the authed fetch (an <img> can't send the JWT),
// turned into an object URL. When the still-image capture fails but the camera
// streams (common for NVR channels), fall back to a frame grabbed from live.
function Snapshot({ path, name, online, encrypted, camId, liveEnabled }) {
  const [src, setSrc] = useState(null);
  const [poster, setPoster] = useState(null);
  const [posterFailed, setPosterFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!path) return;
    let url, cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(path);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      } catch { if (!cancelled) setFailed(true); }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [path]);

  // Poster-from-live fallback: snapshot failed but the camera is live-capable.
  const tryPoster = (online && liveEnabled && camId) && (failed || !path);
  useEffect(() => {
    if (!tryPoster || src || poster || posterFailed) return;
    let cancelled = false;
    runPoster(() => grabLiveFrame(camId))
      .then((d) => { if (!cancelled) setPoster(d); })
      .catch(() => { if (!cancelled) setPosterFailed(true); }); // don't spin forever
    return () => { cancelled = true; };
  }, [tryPoster, src, poster, posterFailed, camId]);

  if (src) return <img src={src} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />;
  if (poster) return <img src={poster} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />;
  // The tile behind this is a dark video surface, so use light-on-dark colors
  // regardless of the (light) app theme.
  // Encrypted cameras can't be shown until their verification code is provided,
  // so label them clearly instead of a generic "unavailable".
  const encLocked = online && failed && encrypted;
  return (
    <div className="flex flex-col items-center gap-1" style={{ color: encLocked ? "#E8A33E" : "#7C8A9C", fontFamily: mono, fontSize: 12, textAlign: "center", padding: 8 }}>
      {encLocked ? <Lock size={20} color="#E8A33E" /> : <Video size={22} color={online ? "#7C8A9C" : C.red} />}
      {!online ? "camera offline"
        : encLocked ? "encrypted — needs code"
        : tryPoster && !poster && !posterFailed ? "loading…"
        : failed || posterFailed ? "snapshot unavailable"
        : path ? "loading…" : "feed via Hik-Connect"}
    </div>
  );
}

// "Amilia · live" / "Amilia · sample" tag for a panel header.
function SourceTag({ live, name }) {
  return (
    <span className="flex items-center gap-1.5" style={{ fontFamily: mono, fontSize: 11, color: live ? C.go : C.dim }}>
      {live ? <Wifi size={11} /> : <WifiOff size={11} />}{name} · {live ? "live" : "sample"}
    </span>
  );
}
