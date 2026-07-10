import React, { useState, useMemo, useRef, useEffect, useCallback, Suspense, lazy } from "react";
import {
  ShieldCheck, ShieldAlert, Lock, Unlock, Thermometer, ListChecks,
  Clock, Bell, Terminal, ChevronUp, ChevronDown, Send, Power,
  Sun, Moon, Plane, AlertTriangle, CircleCheck, Activity, Droplets,
  Calendar, Users, Video, Baby, Wifi, WifiOff, RefreshCw, UserCheck,
  DoorOpen, Building2, TrendingUp, LogOut, DollarSign, Settings, KeyRound, Loader2, Check, Trash2,
  LayoutGrid, Eye, EyeOff, ArrowLeft, ArrowRight, Pencil, MessageSquare,
} from "lucide-react";
import { usePrefs } from "./usePrefs.js";

// Compact currency, e.g. 1575 -> "$1,575". Non-numbers pass through as "$0".
const fmtMoney = (n) => "$" + (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
import { useDashboardData } from "./useDashboardData.js";
import { apiFetch, authToken } from "./lib/api.js";
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
  ["chat", "Chat", MessageSquare],
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

export default function SquareOneOps({ user, role, roleTabs = {}, authEnabled, onSignOut } = {}) {
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

  // Live GeoVision door list (real names + ids) for the Home cards + status.
  const [gvDoors, setGvDoors] = useState(null); // null = loading, [] = unavailable
  useEffect(() => {
    apiFetch("/api/geovision/doors").then((r) => r.json())
      .then((r) => setGvDoors(r.ok && Array.isArray(r.data?.doors) ? r.data.doors : []))
      .catch(() => setGvDoors([]));
  }, []);
  const gvConnected = Array.isArray(gvDoors) && gvDoors.length > 0;

  // Live Napco alarm status via the iBridge bridge. null = loading; {configured:false}
  // = not wired. Refresh every 60s while visible (bridge read is cheap + cached).
  const [napcoAlarm, setNapcoAlarm] = useState(null);
  useEffect(() => {
    let stop = false;
    const load = () => apiFetch("/api/napco/alarm").then((r) => r.json())
      .then((r) => { if (!stop) setNapcoAlarm(r.ok ? r.data : { configured: false }); })
      .catch(() => { if (!stop) setNapcoAlarm({ configured: false }); });
    load();
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  // Sidebar unread dot for Chat: slow poll of the chat summary vs the local
  // read marks (kept in localStorage, updated by the Chat tab as you read).
  const [chatUnread, setChatUnread] = useState(false);
  useEffect(() => {
    if (!authEnabled || !user?.id) return;
    let stop = false;
    const poll = () => apiFetch("/api/chat/summary").then((r) => r.json())
      .then((r) => { if (!stop && r.ok) setChatUnread(chatHasUnread(r.data, user.id)); }).catch(() => {});
    poll();
    const id = setInterval(() => { if (document.visibilityState === "visible") poll(); }, 20_000);
    return () => { stop = true; clearInterval(id); };
  }, [authEnabled, user]);

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
  // Campus status from the systems that are actually live: camera health, the
  // access-control door count, and the member roster.
  const verdict = useMemo(() => {
    const camsTotal = cameras.length;
    const camsOnline = cameras.filter((c) => c.online).length;
    const doorCount = gvConnected ? gvDoors.length : 0;
    const offline = camsTotal - camsOnline;
    if (camsTotal && offline > 0)
      return { state: "ATTENTION", color: C.amber, note: `${offline} camera${offline > 1 ? "s" : ""} offline${doorCount ? ` · ${doorCount} doors online` : ""}` };
    return {
      state: "ONLINE", color: C.go,
      note: [camsTotal ? `${camsOnline}/${camsTotal} cameras` : null, doorCount ? `${doorCount} doors` : null, `${members.total} members`].filter(Boolean).join(" · "),
    };
  }, [cameras, gvDoors, gvConnected, members.total]);

  const freshSignup = memberSignups[0] && Date.now() - new Date(memberSignups[0].at).getTime() < 24 * 3600 * 1000;
  const pageTitle = (TABS.find(([id]) => id === tab) || [, "Home"])[1];

  // Visible tabs. Home + Settings always show. Admins see everything. For
  // manager/staff, a tab is on unless: the role's bucket turns it off
  // (roleTabs[role]) — or the person's own override does (prefs.tabs, which wins).
  const tabPrefs = prefs.tabs || {};
  const roleBucket = role && role !== "admin" ? (roleTabs[role] || {}) : {};
  const tabVisible = (id) => {
    if (id === "home" || id === "settings") return true;
    if (role === "admin" || !authEnabled) return true;
    if (tabPrefs[id] !== undefined) return tabPrefs[id] !== false; // per-person override wins
    return roleBucket[id] !== false;                                // else the role bucket
  };
  const visibleTabs = TABS.filter(([id]) => tabVisible(id));
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
              const alert = (id === "alerts" && (zones.some((z) => Math.abs(z.now - z.set) > 2) || freshSignup)) || (id === "chat" && chatUnread);
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
            <ConnectionBar connected={{ amilia: connected.amilia, hik: connected.hik, geovision: gvConnected, napco: !!napcoAlarm?.loggedIn, pro1: false, procare: connected.procare }} onReload={() => { reload(); reloadHub(); }} />
            {tab === "home" && <><Verdict v={verdict} /><Home log={log} setTab={setTab} members={members} bookings={bookings} cameras={cameras} gvDoors={gvDoors} napcoAlarm={napcoAlarm} /></>}
            {tab === "security" && <Security doors={doors} alarm={alarm} napcoAlarm={napcoAlarm} hub={hub} lockdown={lockdown} />}
            {tab === "hvac" && <Hvac zones={zones} hub={hub} />}
            {tab === "bookings" && <Bookings bookings={bookings} live={!usingMock.amilia} />}
            {tab === "members" && <Members members={members} live={!usingMock.amilia} />}
            {tab === "cameras" && <Cameras cameras={cameras} snapshotUrl={snapshotUrl} liveEnabled={connected.hik}
              layout={prefs.cameras || {}} onLayout={(cameras) => setPrefs({ cameras })} />}
            {tab === "elc" && <Elc />}
            {tab === "routines" && <Routines opening={opening} setOpening={setOpening} closing={closing} setClosing={setClosing} />}
            {tab === "automation" && <Automation />}
            {tab === "alerts" && <Alerts zones={zones} doors={doors} cameras={cameras} elc={elc} memberSignups={memberSignups} />}
            {tab === "chat" && <Chat user={user} authEnabled={authEnabled} />}
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
  { key: "geovision-shell", label: "GV-Access Find Monitor Module", path: "/api/geovision/shell" },
  { key: "geovision-mobile", label: "GV-Access Mobile API (best)", path: "/api/geovision/mobile" },
  { key: "geovision-tree", label: "GV-Access Door List + Monitor Module", path: "/api/geovision/tree" },
  { key: "geovision-livelog", label: "GV-Access Find Register Call", path: "/api/geovision/livelog" },
  { key: "geovision-serverconn", label: "GV-Access Read Connect Call", path: "/api/geovision/serverconn" },
  { key: "geovision-doorops", label: "GV-Access Door Operations", path: "/api/geovision/door-ops" },
  { key: "geovision-doors", label: "GV-Access Find Door API", path: "/api/geovision/probe-doors" },
  { key: "geovision-monitor", label: "GV-Access Map Doors (ids → names)", path: "/api/geovision/monitor" },
  { key: "geovision-logs", label: "GV-Access Event Log (door names)", path: "/api/geovision/logs" },
  { key: "geovision-unlock", label: "GV-Access Test Unlock (ctrl 1 / door 4)", path: "/api/geovision/test-unlock?ctrl=1&door=4" },
  { key: "napco", label: "Napco Alarm — Login Probe", path: "/api/napco/debug" },
  { key: "napco-probe", label: "Napco Alarm — Crawl Module/Host", path: "/api/napco/probe" },
  { key: "napco-login", label: "Napco Alarm — Log In + Map Commands", path: "/api/napco/login-test" },
  { key: "napco-commands", label: "Napco Alarm — Find Arm/Disarm Codes", path: "/api/napco/commands" },
  { key: "napco-panel", label: "Napco Alarm — Find Panel Page", path: "/api/napco/panel-crawl" },
  { key: "napco-js", label: "Napco Alarm — Read Panel Script", path: "/api/napco/panel-js" },
  { key: "napco-status", label: "Napco Alarm — Read Status (safe)", path: "/api/napco/status" },
  { key: "napco-secsrc", label: "Napco Alarm — Dump Security Page JS", path: "/api/napco/security-src" },
  { key: "napco-keypad", label: "Napco Alarm — Extract Keypad Commands", path: "/api/napco/keypad" },
  { key: "napco-climate", label: "Napco/iBridge — Find Thermostats (Z-Wave)", path: "/api/napco/climate" },
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

// Team — admin: authorize Microsoft accounts (invite by email + role), manage
// active users, and set which tabs each role sees. No passwords: everyone signs
// in with Microsoft, so this is pure authorization.
function TeamPanel() {
  const [data, setData] = useState(null);   // { users, invites, roleTabs }
  const [expanded, setExpanded] = useState(null);
  const [form, setForm] = useState({ email: "", role: "staff" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(() => {
    apiFetch("/api/admin/users").then((r) => r.json()).then((j) => { if (j.ok) setData(j.data); }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const invite = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await apiFetch("/api/admin/invites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }).then((res) => res.json());
      if (!r.ok) throw new Error(r.message || "Could not add");
      setForm({ email: "", role: "staff" });
      setMsg({ ok: true, text: r.data.status === "active" ? `${r.data.email} already had an account — role set to ${r.data.role}.` : `Invited ${r.data.email} as ${r.data.role}. They'll get access next time they sign in with Microsoft.` });
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const cancelInvite = async (email) => { await apiFetch(`/api/admin/invites/${encodeURIComponent(email)}`, { method: "DELETE" }); load(); };
  const setRole = async (id, role) => { await apiFetch(`/api/admin/users/${id}/role`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) }); load(); };
  const setUserTab = async (u, id, on) => {
    const tabs = { ...(u.tabs || {}), [id]: on };
    await apiFetch(`/api/admin/users/${u.id}/tabs`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tabs }) });
    load();
  };
  const remove = async (u) => {
    if (!window.confirm(`Remove ${u.email}? They lose access immediately.`)) return;
    await apiFetch(`/api/admin/users/${u.id}`, { method: "DELETE" }); load();
  };
  const setRoleBucket = async (role, id, on) => {
    const tabs = { ...((data?.roleTabs || {})[role] || {}), [id]: on };
    setData((d) => ({ ...d, roleTabs: { ...(d?.roleTabs || {}), [role]: tabs } })); // optimistic
    await apiFetch("/api/admin/role-tabs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, tabs }) });
    load();
  };

  const users = data?.users, invites = data?.invites || [], roleTabs = data?.roleTabs || {};
  const RolePicker = (value, onChange) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, padding: "6px 8px", cursor: "pointer" }}>
      <option value="staff">Staff</option><option value="manager">Manager</option><option value="admin">Admin</option>
    </select>
  );

  return (
    <Panel title="Team" accent={C.navy} right={<span style={{ fontSize: 11, fontFamily: mono, color: C.mid }}>admin</span>}>
      {/* Add a person — everyone signs in with Microsoft, so this authorizes an email. */}
      <div style={{ padding: "4px 0 14px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 4 }}>Add a person</div>
        <div style={{ fontSize: 12, color: C.mid, marginBottom: 8, lineHeight: 1.5 }}>
          Enter their SquareOne Microsoft email and role. They get access automatically the next time they sign in — no password to set.
        </div>
        <div className="grid gap-2" style={{ gridTemplateColumns: "1.6fr 1fr auto" }}>
          <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@squareonecompassion.com" style={inputStyle} />
          {RolePicker(form.role, (role) => setForm({ ...form, role }))}
          <button onClick={invite} disabled={busy || !form.email}
            style={{ padding: "0 16px", borderRadius: 7, border: "none", cursor: "pointer", background: C.cyan, color: "#fff", fontWeight: 700, fontSize: 13 }}>
            {busy ? <Loader2 size={14} className="spin" /> : "Add"}
          </button>
        </div>
        {msg && <div style={{ marginTop: 8, fontSize: 12, fontFamily: mono, color: msg.ok ? C.go : C.red }}>{msg.text}</div>}
      </div>

      {/* Pending invites */}
      {invites.length > 0 && (
        <div style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, fontFamily: mono, color: C.dim, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Invited · waiting for first sign-in</div>
          {invites.map((iv) => (
            <div key={iv.email} className="flex items-center justify-between" style={{ padding: "7px 0", fontSize: 13.5 }}>
              <span className="flex items-center gap-2"><Loader2 size={12} color={C.amber} /> {iv.email}</span>
              <span className="flex items-center gap-2">
                <span style={{ fontSize: 11, fontFamily: mono, color: C.amber, textTransform: "uppercase" }}>{iv.role}</span>
                <button onClick={() => cancelInvite(iv.email)} className="so-btn" title="Cancel invite" style={{ padding: "5px 9px", borderRadius: 7, color: C.red, borderColor: C.border }}><Trash2 size={12} /></button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Active users */}
      {!data && <div style={{ padding: "10px 0", color: C.dim, fontFamily: mono, fontSize: 12.5 }}>Loading…</div>}
      {users?.length === 0 && invites.length === 0 && <Empty text="No one added yet. Add a person above." />}
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
              {RolePicker(u.role || "staff", (role) => setRole(u.id, role))}
              <button onClick={() => setExpanded(expanded === u.id ? null : u.id)} className="so-btn" style={{ padding: "6px 11px", borderRadius: 7, fontSize: 12, color: C.mid }}>Tabs</button>
              <button onClick={() => remove(u)} className="so-btn" title="Remove" style={{ padding: "6px 9px", borderRadius: 7, color: C.red, borderColor: C.border }}><Trash2 size={13} /></button>
            </div>
          </div>
          {expanded === u.id && (
            <div style={{ marginTop: 10, padding: "10px 12px", background: C.panel2, borderRadius: 8 }}>
              <div style={{ fontSize: 11.5, color: C.mid, marginBottom: 8 }}>Per-person override (leave as-is to use the role's defaults below):</div>
              <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))" }}>
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
            </div>
          )}
        </div>
      ))}

      {/* Role buckets */}
      <div style={{ paddingTop: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 4 }}>What each role can see</div>
        <div style={{ fontSize: 12, color: C.mid, marginBottom: 10, lineHeight: 1.5 }}>
          Turn tabs on or off for everyone with that role. (Admins always see everything. A per-person override above wins over these.)
        </div>
        {["manager", "staff"].map((r) => (
          <div key={r} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontFamily: mono, color: C.dim, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>{r}</div>
            <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))" }}>
              {TOGGLEABLE_TABS.map(([id, label, Icon]) => {
                const on = (roleTabs[r] || {})[id] !== false;
                return (
                  <label key={id} className="flex items-center gap-2" style={{ fontSize: 12.5, cursor: "pointer", color: C.text }}>
                    <input type="checkbox" checked={on} onChange={() => setRoleBucket(r, id, !on)} />
                    <Icon size={13} color={C.mid} />{label}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
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
    ["Members · Amilia", connected.amilia],
    ["Cameras", connected.hik],
    ["Doors · GeoVision", connected.geovision],
    ["Alarm · Napco", connected.napco],
    ["Climate · Pro1", connected.pro1],
    ["ELC · Manual", true],
  ];
  const anyPreview = items.some(([, on]) => !on);
  return (
    <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 12, padding: "8px 12px", background: anyPreview ? C.amberBg : C.goBg, border: `1px solid ${C.border}`, borderLeft: `3px solid ${anyPreview ? C.amber : C.go}`, borderRadius: 6, fontSize: 12.5, fontFamily: mono }}>
      {anyPreview
        ? <AlertTriangle size={14} color={C.amber} />
        : <CircleCheck size={14} color={C.go} />}
      <span style={{ color: C.mid }}>
        {anyPreview ? "Live integrations — grey ones aren't connected yet:" : "All integrations live."}
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
function Home({ log, setTab, members, bookings, cameras, gvDoors, napcoAlarm }) {
  const camsOnline = cameras.filter((c) => c.online).length;
  const doorList = Array.isArray(gvDoors) ? gvDoors : [];
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
      <Panel title="At a Glance" accent={C.cyan}>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Members" value={members.total} sub={`${members.checkedInNow} here now`} icon={Users} color={C.cyan} />
          <Stat label="Upcoming bookings" value={bookings.length} sub="next 14 days" icon={Calendar} color={C.cyan} />
          <Stat label="Cameras" value={`${camsOnline}/${cameras.length}`} sub="online" icon={Video} color={camsOnline === cameras.length ? C.go : C.amber} />
          <Stat label="Access doors" value={doorList.length || "—"} sub={doorList.length ? "GeoVision" : "connecting…"} icon={DoorOpen} color={C.cyan} />
        </div>
      </Panel>

      <Panel title="Doors" accent={C.cyan} right={<button onClick={() => setTab("security")} style={{ background: "none", border: "none", color: C.cyan, fontSize: 12, cursor: "pointer", fontFamily: mono }}>manage →</button>}>
        {gvDoors === null ? (
          <div className="flex items-center gap-2" style={{ color: C.mid, fontSize: 13, padding: "6px 0" }}><Loader2 size={13} className="spin" /> Loading doors…</div>
        ) : doorList.length === 0 ? (
          <Empty text="Door controller unreachable. Check GV-Access is online." />
        ) : (
          <>
            {doorList.slice(0, 5).map((d) => (
              <div key={`${d.ctrl}/${d.door}`} className="flex items-center justify-between" style={{ padding: "7px 0", borderBottom: `1px solid ${C.border}`, fontSize: 14 }}>
                <span className="flex items-center gap-2"><DoorOpen size={13} color={C.cyan} />{d.name}</span>
                <span style={{ color: C.dim, fontFamily: mono, fontSize: 11.5 }}>{d.controller}</span>
              </div>
            ))}
            {doorList.length > 5 && (
              <button onClick={() => setTab("security")} style={{ background: "none", border: "none", color: C.cyan, fontSize: 12.5, cursor: "pointer", fontFamily: mono, paddingTop: 8 }}>
                +{doorList.length - 5} more · unlock / lock →
              </button>
            )}
          </>
        )}
      </Panel>

      <Panel title="Next Bookings" accent={C.cyan} right={<button onClick={() => setTab("bookings")} style={{ background: "none", border: "none", color: C.cyan, fontSize: 12, cursor: "pointer", fontFamily: mono }}>all →</button>}>
        {bookings.length === 0 ? <Empty text="No upcoming bookings." /> : bookings.slice(0, 5).map((b) => (
          <div key={b.id} className="flex items-center gap-3" style={{ padding: "7px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13.5 }}>
            <span style={{ fontFamily: mono, color: C.cyan, fontSize: 12.5, minWidth: 44 }}>{b.start}</span>
            <span style={{ flex: 1 }}>{b.room}</span>
            <span style={{ color: C.dim, fontSize: 12 }}>{b.activity}</span>
          </div>
        ))}
      </Panel>

      <Panel title="Activity" accent={C.dim}>
        {log.length === 0 ? <Empty text="No actions yet. Use Security or the Assistant to drive the campus." />
          : log.slice(0, 8).map((e, i) => (
            <div key={i} className="flex items-center gap-2" style={{ padding: "5px 0", fontSize: 12.5, fontFamily: mono, color: C.mid }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: C[e.kind] || C.dim }} />
              <span style={{ color: C.dim }}>{e.t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>{e.msg}
            </div>
          ))}
      </Panel>

      <AlarmCard alarm={napcoAlarm} onManage={() => setTab("security")} />
      <NotConnectedCard title="Climate" system="Pro1 thermostats" icon={Thermometer}
        blurb="Zone temperatures and setpoints appear here once the Pro1 thermostats are connected." />
    </div>
  );
}

/* ------------------------------- Team Chat --------------------------------
   Whole-group + 1:1 messaging between everyone with dashboard access. Messages
   persist in Supabase (server/providers/chat.js); the client polls for new ones.
   "Read" marks live in localStorage so unread dots work without a server table. */
const CHAT_READ_KEY = "so-chat-read";
const chatReadMap = () => { try { return JSON.parse(localStorage.getItem(CHAT_READ_KEY) || "{}"); } catch { return {}; } };
const chatMarkRead = (channel, at) => {
  const m = chatReadMap(); m[channel] = at || new Date().toISOString();
  try { localStorage.setItem(CHAT_READ_KEY, JSON.stringify(m)); } catch { /* private mode */ }
};
const chatHasUnread = (summary, meId) => {
  const read = chatReadMap();
  return Object.entries(summary || {}).some(([ch, s]) => s && s.lastSender !== meId && (!read[ch] || s.lastAt > read[ch]));
};
const dmChan = (a, b) => "dm:" + [a, b].sort().join(":");
const chatName = (p) => (p?.name && p.name !== p.email ? p.name : (p?.email || "").split("@")[0]) || "Someone";

function Chat({ user, authEnabled }) {
  const meId = user?.id || null;
  const [contacts, setContacts] = useState([]);
  const [summary, setSummary] = useState({});
  const [active, setActive] = useState({ kind: "group" });
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef(null);
  const lastAtRef = useRef(null);

  const channelKey = active.kind === "group" ? "group" : dmChan(meId, active.user.id);
  const query = active.kind === "group" ? "channel=group" : `with=${active.user.id}`;

  // Contacts once; summary on a slow poll (previews + unread dots).
  useEffect(() => {
    if (!authEnabled || !meId) return;
    apiFetch("/api/chat/contacts").then((r) => r.json())
      .then((r) => { if (r.ok) setContacts(r.data.contacts || []); }).catch(() => {});
  }, [authEnabled, meId]);
  useEffect(() => {
    if (!authEnabled || !meId) return;
    let stop = false;
    const poll = () => apiFetch("/api/chat/summary").then((r) => r.json())
      .then((r) => { if (!stop && r.ok) setSummary(r.data || {}); }).catch(() => {});
    poll();
    const id = setInterval(() => { if (document.visibilityState === "visible") poll(); }, 8000);
    return () => { stop = true; clearInterval(id); };
  }, [authEnabled, meId]);

  // Load + poll the active channel's messages (append only the newer ones).
  useEffect(() => {
    if (!authEnabled || !meId) return;
    let stop = false;
    setLoading(true); setMessages([]); lastAtRef.current = null;
    const load = async () => {
      const after = lastAtRef.current;
      const url = `/api/chat/messages?${query}${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const r = await apiFetch(url).then((res) => res.json()).catch(() => null);
      if (stop) return;
      if (r && r.ok && r.data.length) {
        lastAtRef.current = r.data[r.data.length - 1].created_at;
        chatMarkRead(channelKey, lastAtRef.current);
        setMessages((prev) => (after ? [...prev, ...r.data] : r.data));
      } else if (r && r.ok && !after) setMessages([]);
      setLoading(false);
    };
    load();
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 4000);
    return () => { stop = true; clearInterval(id); };
  }, [query, authEnabled, meId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the thread pinned to the newest message.
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const payload = active.kind === "group" ? { channel: "group", body } : { to: active.user.id, body };
    try {
      const r = await apiFetch("/api/chat/messages", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      }).then((res) => res.json());
      if (r.ok) {
        setMessages((prev) => [...prev, r.data]);
        lastAtRef.current = r.data.created_at;
        chatMarkRead(channelKey, r.data.created_at);
        setText("");
      }
    } finally { setSending(false); }
  };

  if (!authEnabled || !meId)
    return <Panel title="Team Chat"><Empty text="Chat is available once you're signed in." /></Panel>;

  const nameById = new Map(contacts.map((c) => [c.id, c]));
  const read = chatReadMap();
  const unreadFor = (key) => { const s = summary[key]; return s && s.lastSender !== meId && (!read[key] || s.lastAt > read[key]); };
  const group = { key: "group", label: "Group Chat", sub: "Everyone", isGroup: true };
  const dms = contacts
    .map((c) => ({ key: dmChan(meId, c.id), label: chatName(c), sub: c.email, user: c }))
    .sort((a, b) => (summary[b.key]?.lastAt || "").localeCompare(summary[a.key]?.lastAt || ""));
  const convos = [group, ...dms];

  return (
    <div style={{ display: "flex", height: "72vh", minHeight: 420, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", background: C.panel }}>
      {/* Conversation list */}
      <div style={{ width: 250, flex: "0 0 auto", borderRight: `1px solid ${C.border}`, overflowY: "auto", background: C.panel2 }}>
        <div style={{ padding: "12px 14px", fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: C.dim, fontFamily: mono }}>Conversations</div>
        {convos.map((c) => {
          const on = c.key === channelKey;
          const unread = unreadFor(c.key);
          const preview = summary[c.key]?.lastBody;
          return (
            <button key={c.key} onClick={() => setActive(c.isGroup ? { kind: "group" } : { kind: "dm", user: c.user })}
              style={{ display: "block", width: "100%", textAlign: "left", border: "none", cursor: "pointer",
                padding: "10px 14px", background: on ? C.cyanBg : "transparent", borderLeft: on ? `3px solid ${C.cyan}` : "3px solid transparent" }}>
              <div className="flex items-center justify-between" style={{ gap: 8 }}>
                <span className="flex items-center gap-2" style={{ minWidth: 0 }}>
                  {c.isGroup
                    ? <span style={{ width: 22, height: 22, borderRadius: 99, background: C.cyan, display: "grid", placeItems: "center", flex: "0 0 auto" }}><Users size={13} color="#fff" /></span>
                    : <span style={{ width: 22, height: 22, borderRadius: 99, background: C.navy, color: "#fff", fontSize: 11, fontWeight: 700, display: "grid", placeItems: "center", flex: "0 0 auto" }}>{(c.label[0] || "?").toUpperCase()}</span>}
                  <span style={{ fontSize: 13.5, fontWeight: on ? 700 : 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
                </span>
                {unread && <span style={{ width: 8, height: 8, borderRadius: 99, background: C.amber, flex: "0 0 auto" }} />}
              </div>
              <div style={{ fontSize: 11.5, color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2, paddingLeft: 30 }}>
                {preview || c.sub}
              </div>
            </button>
          );
        })}
        {contacts.length === 0 && <div style={{ padding: 14 }}><Empty text="No teammates yet." /></div>}
      </div>

      {/* Thread */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, fontWeight: 700, fontSize: 14 }}>
          {active.kind === "group" ? "Group Chat" : chatName(active.user)}
          {active.kind === "group"
            ? <span style={{ fontSize: 12, color: C.dim, fontWeight: 400, marginLeft: 8 }}>everyone with access</span>
            : <span style={{ fontSize: 12, color: C.dim, fontWeight: 400, marginLeft: 8 }}>{active.user.email}</span>}
        </div>
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {loading ? <div className="flex items-center gap-2" style={{ color: C.mid, fontSize: 13 }}><Loader2 size={14} className="spin" /> Loading…</div>
            : messages.length === 0 ? <Empty text="No messages yet. Say hello 👋" />
            : messages.map((m) => {
                const mine = m.sender_id === meId;
                const who = mine ? "You" : chatName(nameById.get(m.sender_id) || { email: m.sender_email });
                return (
                  <div key={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "76%" }}>
                    {!mine && active.kind === "group" && <div style={{ fontSize: 10.5, color: C.dim, marginBottom: 2, marginLeft: 4 }}>{who}</div>}
                    <div style={{ padding: "8px 12px", borderRadius: 12, fontSize: 14, lineHeight: 1.35, whiteSpace: "pre-wrap", wordBreak: "break-word",
                      background: mine ? C.cyan : C.panel2, color: mine ? "#fff" : C.text,
                      borderTopRightRadius: mine ? 3 : 12, borderTopLeftRadius: mine ? 12 : 3 }}>
                      {m.body}
                    </div>
                    <div style={{ fontSize: 10, color: C.dim, marginTop: 2, textAlign: mine ? "right" : "left" }}>
                      {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                );
              })}
        </div>
        <div style={{ borderTop: `1px solid ${C.border}`, padding: 12, display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={`Message ${active.kind === "group" ? "everyone" : chatName(active.user)}…`}
            rows={1} style={{ flex: 1, resize: "none", maxHeight: 120, padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.border}`,
              fontFamily: sans, fontSize: 14, color: C.text, background: C.panel2, outline: "none" }} />
          <button onClick={send} disabled={sending || !text.trim()} className="so-btn"
            style={{ padding: "10px 14px", borderRadius: 10, background: C.cyan, color: "#fff", borderColor: C.cyan,
              display: "flex", alignItems: "center", gap: 6, opacity: sending || !text.trim() ? 0.6 : 1 }}>
            {sending ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}

// Live Napco alarm status card (read via the iBridge bridge). Falls back to the
// "not connected" placeholder until the integration is wired.
function AlarmCard({ alarm, onManage }) {
  if (!alarm || alarm.configured === false)
    return (
      <NotConnectedCard title="Alarm" system="Napco Gemini" icon={ShieldAlert}
        blurb="Arm/disarm and live alarm status appear here once the Napco system is connected." />
    );

  const loading = alarm === null;
  const linking = alarm.loggedIn && !alarm.bridged;
  const armed = alarm.armed === true;
  const disarmed = alarm.armed === false;
  const label = !alarm.loggedIn ? "Sign-in failed"
    : linking ? "Linking…"
    : armed ? "ARMED"
    : disarmed ? "DISARMED"
    : "Unknown";
  const color = !alarm.loggedIn ? C.red : linking ? C.amber : armed ? C.red : disarmed ? C.go : C.dim;
  const Icon = armed ? ShieldCheck : ShieldAlert;
  const sub = armed && alarm.state && alarm.state !== "armed"
    ? alarm.state.replace("armed-", "armed ").replace("-", " ")
    : linking ? "bridge is connecting to the panel"
    : disarmed ? "panel is off — building open"
    : !alarm.loggedIn ? "check Napco credentials in settings"
    : "";

  return (
    <Panel title="Alarm" accent={color}
      right={onManage ? <button onClick={onManage} style={{ background: "none", border: "none", color: C.cyan, fontSize: 12, cursor: "pointer", fontFamily: mono }}>manage →</button> : <span style={{ fontSize: 11, fontFamily: mono, color: C.dim }}>read-only</span>}>
      <div className="flex items-center gap-3" style={{ padding: "8px 0" }}>
        {loading ? <Loader2 size={30} className="spin" color={C.dim} /> : <Icon size={30} color={color} />}
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: mono, letterSpacing: 0.5 }}>
            {loading ? "…" : label}
          </div>
          <div style={{ fontSize: 12, color: C.mid }}>
            {loading ? "reading panel…" : sub}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 11, fontFamily: mono, color: C.dim, paddingTop: 4 }}>
        Napco Gemini · iBridge{alarm.statusRaw !== undefined ? ` · status ${alarm.statusRaw}` : ""}
      </div>
    </Panel>
  );
}

// Honest placeholder for a planned-but-not-yet-connected integration.
function NotConnectedCard({ title, system, icon: Icon, blurb }) {
  return (
    <Panel title={title} accent={C.dim} right={<span style={{ fontSize: 11, fontFamily: mono, color: C.dim }}>not connected</span>}>
      <div className="flex items-center gap-3" style={{ padding: "10px 0" }}>
        <Icon size={30} color={C.dim} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.mid }}>{system}</div>
          <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.5, marginTop: 2 }}>{blurb}</div>
        </div>
      </div>
    </Panel>
  );
}

/* ----------------------------- SECURITY ----------------------------- */
function Security({ napcoAlarm }) {
  return (
    <div className="grid gap-3">
      <AlarmCard alarm={napcoAlarm} />
      <MasterDoorControls />
      <GeoVisionDoors />
    </div>
  );
}

// Campus-wide door controls, driving every real GeoVision door at once.
// Unlock all = hold open, Secure all = return to normal locked access,
// Lockdown = block all entry. Attributed + logged like the per-door actions.
function MasterDoorControls() {
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const run = async (opKey, label, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(opKey); setMsg(null);
    try {
      const r = await apiFetch(`/api/geovision/doors-all/${opKey}`, { method: "POST" }).then((res) => res.json());
      if (r.ok && r.data) setMsg({ ok: r.data.okCount > 0, text: `${label}: ${r.data.okCount} of ${r.data.total} doors` });
      else setMsg({ ok: false, text: r.message || "Command failed" });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(null); }
  };

  return (
    <Panel title="Master Controls">
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <BigBtn icon={Unlock} label="Unlock all doors" color={C.cyan} loading={busy === "force-unlock"}
          onClick={() => run("force-unlock", "Unlock all", "Hold EVERY door open until you press Secure all?\n\nUse this to open the building.")} />
        <BigBtn icon={Lock} label="Secure all doors" color={C.go} loading={busy === "release"}
          onClick={() => run("release", "Secure all")} />
      </div>
      <div style={{ marginTop: 10 }}>
        <button onClick={() => run("lockdown", "Lockdown", "EMERGENCY LOCKDOWN — lock every door and block all card access?")}
          disabled={!!busy} className="so-btn" style={{ width: "100%", padding: "12px", borderRadius: 8, fontWeight: 700, letterSpacing: 1, color: C.red, background: C.redBg, borderColor: C.red }}>
          {busy === "lockdown" ? "Sending…" : "EMERGENCY LOCKDOWN"}
        </button>
      </div>
      {msg && (
        <div style={{ marginTop: 10, fontSize: 12.5, fontFamily: mono, color: msg.ok ? C.go : C.red }}>
          {msg.ok ? "✓ " : "✕ "}{msg.text}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 11.5, color: C.dim, lineHeight: 1.5 }}>
        <strong style={{ color: C.mid }}>Unlock all</strong> holds every door open · <strong style={{ color: C.mid }}>Secure all</strong> returns them to normal locked/card access · <strong style={{ color: C.mid }}>Lockdown</strong> blocks all entry. Alarm arm/disarm returns once the Napco system is connected.
      </div>
    </Panel>
  );
}

// Live GV-Access door control. Reads the configured doors (GV_DOORS) and sends
// real UNLOCK_DOOR / LOCK_DOOR commands to the on-prem GV-ASManager server,
// attributed to the signed-in operator. Momentary unlock is how GeoVision access
// control works, so a door "unlock" pulses the strike open — there's no held
// lock/unlock state to reflect, just the last action.
// The full GeoVision door-operation set, matching the GV-Access phone app's
// door menu. Confirmed operation constants from the app's own code. "unlock" is
// the momentary buzz-open everyone uses; the rest are held states, so the
// forceful ones (force-lock, lockdown) confirm before firing.
const GV_DOOR_ACTIONS = [
  { key: "unlock", label: "Unlock", icon: Unlock, color: C.cyan, blurb: "Buzz open for a moment" },
  { key: "force-unlock", label: "Force Unlock", icon: Unlock, color: C.amber, blurb: "Hold open until released", confirm: true },
  { key: "force-lock", label: "Force Lock", icon: Lock, color: C.amber, blurb: "Hold locked — no card access", confirm: true },
  { key: "release", label: "Release", icon: Check, color: C.go, blurb: "Return to normal schedule" },
  { key: "lockdown", label: "Lock Down", icon: ShieldAlert, color: C.red, blurb: "Emergency lockdown", confirm: true },
];

function GeoVisionDoors() {
  const [doors, setDoors] = useState(null);   // null = loading, [] = couldn't reach controller
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState({});   // door key -> {ok, msg}
  const [openKey, setOpenKey] = useState(null); // which door's extra actions are expanded

  useEffect(() => {
    apiFetch("/api/geovision/doors").then((r) => r.json())
      .then((r) => setDoors(r.ok && Array.isArray(r.data?.doors) ? r.data.doors : []))
      .catch(() => setDoors([]));
  }, []);

  const send = async (d, act) => {
    if (act.confirm && !window.confirm(`${act.label} — ${d.name}?\n\n${act.blurb}. This stays in effect until you Release the door.`)) return;
    const key = `${d.ctrl}/${d.door}`;
    setBusy(`${key}:${act.key}`);
    try {
      const r = await apiFetch(`/api/geovision/doors/${act.key}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ctrl: d.ctrl, door: d.door }),
      }).then((res) => res.json());
      const ok = r.ok && r.data?.ok;
      setResult((s) => ({ ...s, [key]: { ok, msg: ok ? `${act.label} sent just now` : (r.message || r.data?.response || "Command failed") } }));
    } catch (e) {
      setResult((s) => ({ ...s, [key]: { ok: false, msg: e.message } }));
    } finally { setBusy(null); }
  };

  if (doors === null)
    return <Panel title="GV-Access Doors (live)" accent={C.cyan}><div className="flex items-center gap-2" style={{ color: C.mid, fontSize: 13 }}><Loader2 size={14} className="spin" /> Loading doors…</div></Panel>;

  // Group by controller so the two panels' doors are visually separated.
  const groups = doors.reduce((m, d) => {
    const g = d.controller || `Controller ${d.ctrl}`;
    (m[g] = m[g] || []).push(d); return m;
  }, {});

  const primary = GV_DOOR_ACTIONS[0];              // Unlock — the one-tap common action
  const extras = GV_DOOR_ACTIONS.slice(1);         // the held-state actions, behind "More"

  const ActBtn = (d, act, wide) => {
    const key = `${d.ctrl}/${d.door}`;
    const Icon = act.icon;
    return (
      <button key={act.key} onClick={() => send(d, act)} disabled={busy} title={act.blurb}
        className="so-btn flex items-center gap-1.5"
        style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12.5, fontWeight: 600, minWidth: wide ? 92 : 0,
          color: act.color, borderColor: act.key === "unlock" ? act.color : C.border }}>
        {busy === `${key}:${act.key}` ? <Loader2 size={13} className="spin" /> : <Icon size={13} />} {act.label}
      </button>
    );
  };

  const DoorRow = (d) => {
    const key = `${d.ctrl}/${d.door}`;
    const res = result[key];
    const open = openKey === key;
    return (
      <div key={key} style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
        <div className="flex items-center justify-between" style={{ gap: 10 }}>
          <span className="flex items-center gap-2" style={{ fontSize: 14.5 }}>
            <DoorOpen size={15} color={C.cyan} />{d.name}
          </span>
          <div className="flex items-center gap-2">
            {ActBtn(d, primary, true)}
            <button onClick={() => setOpenKey(open ? null : key)} className="so-btn flex items-center gap-1"
              style={{ padding: "6px 10px", borderRadius: 6, fontSize: 12.5, fontWeight: 600, color: C.mid, borderColor: C.border }}>
              More <ChevronDown size={13} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
            </button>
          </div>
        </div>
        {open && (
          <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap", marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${C.border}` }}>
            {extras.map((act) => ActBtn(d, act))}
          </div>
        )}
        {res && (
          <div style={{ marginTop: 6, fontSize: 12, fontFamily: mono, color: res.ok ? C.go : C.red }}>
            {res.ok ? "✓ " : "✕ "}{res.msg}
          </div>
        )}
      </div>
    );
  };

  return (
    <Panel title="GV-Access Doors (live)" accent={C.cyan}
      right={<span style={{ fontSize: 11, fontFamily: mono, color: C.mid }}>real hardware</span>}>
      {doors.length === 0 ? (
        <div style={{ fontSize: 13, color: C.mid, lineHeight: 1.5 }}>
          Couldn't reach the door controller. Check that GV-Access is online, then reload.
          You can also run <strong style={{ color: C.text }}>Settings → Diagnostics → GV-Access Door List</strong> to test the connection.
        </div>
      ) : Object.entries(groups).map(([ctrlName, list]) => (
        <div key={ctrlName} style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: C.dim, fontFamily: mono, padding: "8px 0 2px" }}>{ctrlName}</div>
          {list.map(DoorRow)}
        </div>
      ))}
    </Panel>
  );
}

function BigBtn({ icon: Icon, label, onClick, color, active, loading }) {
  return (
    <button onClick={onClick} disabled={loading} className="so-btn flex flex-col items-center gap-2"
      style={{ padding: "16px 10px", borderRadius: 9, borderColor: active ? color : C.border, background: active ? C.panelHi : C.panel2, opacity: loading ? 0.7 : 1 }}>
      {loading ? <Loader2 size={22} className="spin" color={color} /> : <Icon size={22} color={color} />}
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
// Early Learning Center — manual daily attendance. Staff type each room's
// morning headcount into a box; entries auto-save and are shared across the team
// (server/providers/elc.js). No ProCare API.
function Elc() {
  const [data, setData] = useState(null);      // { date, rooms, totals, lastUpdated }
  const [vals, setVals] = useState({});        // roomId -> input string
  const [status, setStatus] = useState({});    // roomId -> 'saving'|'saved'|'error'
  const dirty = useRef(new Set());             // rooms with unsaved local edits
  const timers = useRef({});                   // per-room debounce timers

  // Merge server data in, but never clobber a box the user is mid-edit on.
  const applyServer = (d) => {
    setData(d);
    setVals((prev) => {
      const next = { ...prev };
      d.rooms.forEach((r) => { if (!dirty.current.has(r.id)) next[r.id] = r.present === null ? "" : String(r.present); });
      return next;
    });
  };
  useEffect(() => {
    let stop = false;
    const load = () => apiFetch("/api/elc/today").then((r) => r.json())
      .then((r) => { if (!stop && r.ok) applyServer(r.data); }).catch(() => {});
    load();
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 30_000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  const save = async (roomId, raw) => {
    setStatus((s) => ({ ...s, [roomId]: "saving" }));
    const present = raw === "" ? null : Number(raw);
    try {
      const r = await apiFetch("/api/elc/counts", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: roomId, present }),
      }).then((res) => res.json());
      if (r.ok) {
        dirty.current.delete(roomId);
        setStatus((s) => ({ ...s, [roomId]: "saved" }));
        setTimeout(() => setStatus((s) => ({ ...s, [roomId]: undefined })), 1600);
      } else setStatus((s) => ({ ...s, [roomId]: "error" }));
    } catch { setStatus((s) => ({ ...s, [roomId]: "error" })); }
  };
  const onType = (roomId, raw) => {
    const clean = raw.replace(/[^0-9]/g, "").slice(0, 3);
    dirty.current.add(roomId);
    setVals((v) => ({ ...v, [roomId]: clean }));
    clearTimeout(timers.current[roomId]);
    timers.current[roomId] = setTimeout(() => save(roomId, clean), 600);
  };
  const step = (roomId, delta) => {
    const nv = String(Math.max(0, Number(vals[roomId] || 0) + delta));
    dirty.current.add(roomId);
    setVals((v) => ({ ...v, [roomId]: nv }));
    clearTimeout(timers.current[roomId]);
    save(roomId, nv);
  };

  if (!data)
    return <Panel title="Early Learning Center"><div className="flex items-center gap-2" style={{ color: C.mid, fontSize: 13, padding: "6px 0" }}><Loader2 size={14} className="spin" /> Loading…</div></Panel>;

  const t = data.totals;
  const dateLabel = new Date(data.date + "T12:00:00").toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  return (
    <div className="grid gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Stat label="Children present" value={t.present} sub={`of ${t.capacity} capacity`} icon={Baby} color={C.cyan} />
        <Stat label="Rooms entered" value={`${t.entered}/${t.roomCount}`} sub="today" icon={CircleCheck} color={t.entered === t.roomCount ? C.go : C.amber} />
        <Stat label="Teachers" value={t.teachers} sub="2 per room" icon={UserCheck} color={C.cyan} />
        <Stat label="Open spots" value={Math.max(0, t.capacity - t.present)} sub="remaining" icon={Users} color={C.go} />
      </div>
      <Panel title={`Daily Attendance — ${dateLabel}`} accent={C.cyan}
        right={<span style={{ fontSize: 11, fontFamily: mono, color: C.dim }}>{data.lastUpdated ? `updated ${new Date(data.lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "no entries yet"}</span>}>
        {data.rooms.map((r) => {
          const val = vals[r.id] ?? "";
          const n = val === "" ? null : Number(val);
          const full = n !== null && n >= r.capacity;
          const over = n !== null && n > r.capacity;
          const pct = n === null ? 0 : Math.min(100, (n / r.capacity) * 100);
          const st = status[r.id];
          return (
            <div key={r.id} className="flex items-center gap-3" style={{ padding: "12px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{r.name}</div>
                <div style={{ fontSize: 12, color: C.dim, fontFamily: mono }}>{r.teachers} teachers · capacity {r.capacity}</div>
                <div style={{ height: 6, background: C.panel2, borderRadius: 99, overflow: "hidden", marginTop: 6, maxWidth: 280 }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: over ? C.red : full ? C.amber : C.go, borderRadius: 99, transition: "width .2s" }} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => step(r.id, -1)} className="so-btn" style={{ width: 34, height: 34, borderRadius: 8, display: "grid", placeItems: "center" }} aria-label={`fewer in ${r.name}`}><ChevronDown size={16} /></button>
                <input value={val} onChange={(e) => onType(r.id, e.target.value)}
                  onBlur={() => { clearTimeout(timers.current[r.id]); if (dirty.current.has(r.id)) save(r.id, val); }}
                  inputMode="numeric" placeholder="—" aria-label={`children present in ${r.name}`}
                  style={{ width: 66, textAlign: "center", fontSize: 20, fontWeight: 700, fontFamily: mono, padding: "6px 4px", borderRadius: 8, border: `1px solid ${over ? C.red : C.border}`, background: C.panel2, color: over ? C.red : C.text, outline: "none" }} />
                <button onClick={() => step(r.id, 1)} className="so-btn" style={{ width: 34, height: 34, borderRadius: 8, display: "grid", placeItems: "center" }} aria-label={`more in ${r.name}`}><ChevronUp size={16} /></button>
                <span style={{ width: 60, fontSize: 11, fontFamily: mono, color: st === "saved" ? C.go : st === "error" ? C.red : st === "saving" ? C.mid : over ? C.red : C.dim }}>
                  {st === "saving" ? "saving…" : st === "saved" ? "saved ✓" : st === "error" ? "retry" : over ? "over!" : full ? "full" : `of ${r.capacity}`}
                </span>
              </div>
            </div>
          );
        })}
      </Panel>
      <div style={{ fontSize: 12, color: C.dim, fontFamily: mono, padding: "0 2px" }}>
        Staff-entered daily counts — everyone with access sees the same numbers. Entries save automatically; each morning starts fresh.
      </div>
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
  // Same-origin HLS proxy (avoids EZVIZ CORS); token in the query for hls.js.
  const tok = await authToken();
  const url = `/api/hik/cameras/${camId}/hls.m3u8${tok ? `?access_token=${encodeURIComponent(tok)}` : ""}`;
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) throw new Error("hls unsupported");
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.autoplay = true;
    // Must be attached to the DOM (offscreen) or many browsers never decode
    // frames from it — which is why the grab silently failed before.
    video.style.cssText = "position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:-10px;top:-10px";
    document.body.appendChild(video);
    const hls = new Hls({ maxBufferLength: 4 });
    let done = false;
    const cleanup = () => { clearTimeout(timer); try { hls.destroy(); } catch { /* ignore */ } try { video.remove(); } catch { /* ignore */ } };
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
    video.addEventListener("canplay", capture);
    video.addEventListener("timeupdate", capture);
    hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal && !done) { done = true; cleanup(); reject(new Error(d.details)); } });
    hls.loadSource(url); hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play?.().catch(() => {}));
    const timer = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error("timeout")); } }, 16000);
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
