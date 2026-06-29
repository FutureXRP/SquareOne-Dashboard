import React, { useState, useMemo, useRef, useEffect, useCallback, Suspense, lazy } from "react";
import {
  ShieldCheck, ShieldAlert, Lock, Unlock, Thermometer, ListChecks,
  Clock, Bell, Terminal, ChevronUp, ChevronDown, Send, Power,
  Sun, Moon, Plane, AlertTriangle, CircleCheck, Activity, Droplets,
  Calendar, Users, Video, Baby, Wifi, WifiOff, RefreshCw, UserCheck,
  DoorOpen, Building2, TrendingUp, LogOut,
} from "lucide-react";
import { useDashboardData } from "./useDashboardData.js";
import { apiFetch } from "./lib/api.js";
import { useHub } from "./useHub.js";
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

const C = {
  bg: "#0B0F14", panel: "#131A22", panel2: "#1A232E", panelHi: "#202C39",
  border: "#243140", borderHi: "#33465A",
  text: "#E8EDF2", mid: "#92A2B3", dim: "#5C6B7A",
  go: "#3DBC8A", goBg: "#11251F",
  cyan: "#52BECF", cyanBg: "#0E2329",
  amber: "#E0A33E", amberBg: "#241B0E",
  red: "#E0564B", redBg: "#26110F",
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

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: sans, minHeight: "100%" }}>
      <style>{`
        .so-btn{transition:all .12s ease;cursor:pointer;border:1px solid ${C.border};background:${C.panel2};color:${C.text}}
        .so-btn:hover{border-color:${C.borderHi};background:${C.panelHi}}
        .so-btn:focus-visible{outline:2px solid ${C.cyan};outline-offset:2px}
        .so-tab:focus-visible{outline:2px solid ${C.cyan};outline-offset:-2px}
        .pulse{animation:so-pulse 2.4s ease-in-out infinite}
        @keyframes so-pulse{0%,100%{opacity:1}50%{opacity:.45}}
        @media (prefers-reduced-motion: reduce){.pulse{animation:none}}
        ::placeholder{color:${C.dim}}
      `}</style>

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "0 16px 64px" }}>
        {/* Masthead */}
        <header className="flex items-center justify-between" style={{ padding: "20px 0 14px", borderBottom: `1px solid ${C.border}` }}>
          <div className="flex items-center gap-3">
            <div style={{ width: 30, height: 30, border: `2px solid ${C.cyan}`, borderRadius: 5 }} />
            <div>
              <div style={{ fontSize: 11, letterSpacing: 3, color: C.mid, fontFamily: mono, textTransform: "uppercase" }}>SquareOne</div>
              <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: -0.2 }}>Operations Center</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {authEnabled && user && <AccountChip user={user} role={role} onSignOut={onSignOut} />}
            <ClockReadout />
          </div>
        </header>

        <ConnectionBar connected={{ hub: hubConnected, ...connected }} onReload={() => { reload(); reloadHub(); }} />

        {/* Verdict hero */}
        <Verdict v={verdict} />

        {/* Tabs */}
        <nav className="flex gap-1" style={{ margin: "16px 0", borderBottom: `1px solid ${C.border}`, overflowX: "auto" }}>
          {TABS.map(([id, label, Icon]) => {
            const active = tab === id;
            const alert = id === "alerts" && zones.some((z) => Math.abs(z.now - z.set) > 2);
            return (
              <button key={id} onClick={() => setTab(id)} className="so-tab flex items-center gap-2 whitespace-nowrap"
                style={{ background: "transparent", border: "none", padding: "10px 14px", cursor: "pointer",
                  color: active ? C.text : C.mid, fontSize: 13.5, fontWeight: active ? 600 : 500,
                  borderBottom: active ? `2px solid ${C.cyan}` : "2px solid transparent", marginBottom: -1 }}>
                <Icon size={15} />{label}
                {alert && <span style={{ width: 6, height: 6, borderRadius: 99, background: C.amber }} />}
              </button>
            );
          })}
        </nav>

        {tab === "home" && <Home doors={doors} zones={zones} alarm={alarm} log={log} setTab={setTab} members={members} bookings={bookings} cameras={cameras} elc={elc} />}
        {tab === "security" && <Security doors={doors} alarm={alarm} hub={hub} lockdown={lockdown} />}
        {tab === "hvac" && <Hvac zones={zones} hub={hub} />}
        {tab === "bookings" && <Bookings bookings={bookings} live={!usingMock.amilia} />}
        {tab === "members" && <Members members={members} live={!usingMock.amilia} />}
        {tab === "cameras" && <Cameras cameras={cameras} snapshotUrl={snapshotUrl} liveEnabled={connected.hik} />}
        {tab === "elc" && <Elc elc={elc} live={!usingMock.procare} />}
        {tab === "routines" && <Routines opening={opening} setOpening={setOpening} closing={closing} setClosing={setClosing} />}
        {tab === "automation" && <Automation />}
        {tab === "alerts" && <Alerts zones={zones} doors={doors} cameras={cameras} elc={elc} />}
        {tab === "assistant" && <Assistant hub={hub} doors={doors} zones={zones} alarm={alarm} />}
      </div>
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
          <Stat label="Booked today" value={bookings.length} sub="rooms" icon={Calendar} color={C.cyan} />
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
  const rooms = [...new Set(bookings.map((b) => b.room))];
  const totalPeople = bookings.reduce((n, b) => n + b.party, 0);
  return (
    <div className="grid gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Stat label="Bookings today" value={bookings.length} icon={Calendar} color={C.cyan} />
        <Stat label="Rooms in use" value={rooms.length} icon={Building2} color={C.cyan} />
        <Stat label="Expected guests" value={totalPeople} icon={Users} color={C.cyan} />
      </div>
      <Panel title="Today's Room Schedule" accent={C.cyan}
        right={<SourceTag live={live} name="Amilia" />}>
      {bookings.length === 0 && <Empty text="No bookings for today." />}
        {bookings.map((b) => (
          <div key={b.id} className="flex items-center gap-3" style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
            <span style={{ fontFamily: mono, color: C.cyan, fontSize: 13, minWidth: 96 }}>{b.start}–{b.end}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 600 }}>{b.room}</div>
              <div style={{ fontSize: 12.5, color: C.dim }}>{b.activity}</div>
            </div>
            <span className="flex items-center gap-1.5" style={{ color: C.mid, fontFamily: mono, fontSize: 12.5, minWidth: 56 }}>
              <Users size={13} />{b.party}
            </span>
            <span style={{ fontSize: 11, fontFamily: mono, textTransform: "uppercase", letterSpacing: 1,
              color: b.status === "confirmed" ? C.go : C.amber, minWidth: 76, textAlign: "right" }}>
              {b.status}
            </span>
          </div>
        ))}
      </Panel>
    </div>
  );
}

/* ----------------------------- MEMBERS (Amilia) ----------------------------- */
function Members({ members, live }) {
  const max = Math.max(1, ...members.byType.map((t) => t.count));
  return (
    <div className="grid gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Stat label="Total members" value={members.total} icon={Users} color={C.cyan} />
        <Stat label="Active" value={members.active} sub={`${Math.round((members.active / members.total) * 100)}% of total`} icon={UserCheck} color={C.go} />
        <Stat label="New this month" value={`+${members.newThisMonth}`} sub={`${members.cancelledThisMonth} cancelled`} icon={TrendingUp} color={C.go} />
        <Stat label="Checked in now" value={members.checkedInNow} icon={DoorOpen} color={C.cyan} />
      </div>
      <Panel title="Membership by Type" accent={C.cyan}
        right={<SourceTag live={live} name="Amilia" />}>
        {members.byType.map((t) => (
          <div key={t.type} style={{ padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
            <div className="flex items-center justify-between" style={{ fontSize: 13.5, marginBottom: 6 }}>
              <span>{t.type}</span>
              <span style={{ fontFamily: mono, color: C.mid }}>{t.count}</span>
            </div>
            <div style={{ height: 8, background: C.panel2, borderRadius: 99, overflow: "hidden" }}>
              <div style={{ width: `${(t.count / max) * 100}%`, height: "100%", background: C.cyan, borderRadius: 99 }} />
            </div>
          </div>
        ))}
      </Panel>
    </div>
  );
}

/* ----------------------------- CAMERAS (Hik-Connect) ----------------------------- */
function Cameras({ cameras, snapshotUrl, liveEnabled }) {
  const online = cameras.filter((c) => c.online).length;
  const [liveCam, setLiveCam] = useState(null); // camera currently shown in the HLS modal
  return (
    <div className="grid gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Stat label="Cameras" value={cameras.length} icon={Video} color={C.cyan} />
        <Stat label="Online" value={online} icon={Wifi} color={online === cameras.length ? C.go : C.amber} />
        <Stat label="Recording" value={cameras.filter((c) => c.recording).length} icon={Activity} color={C.go} />
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }}>
        {cameras.map((c) => {
          const snap = c.online ? snapshotUrl(c.id) : null; // null in preview / when offline
          const canLive = liveEnabled && c.online;
          return (
            <Panel key={c.id} title={c.name} accent={c.online ? C.go : C.red}
              right={<span className="flex items-center gap-1.5" style={{ fontFamily: mono, fontSize: 11, color: c.online ? C.go : C.red }}>
                {c.online ? <Wifi size={12} /> : <WifiOff size={12} />}{c.online ? "online" : "offline"}
              </span>}>
              {/* Snapshot tile; click for live HLS when the camera is connected. */}
              <button onClick={() => canLive && setLiveCam(c)} disabled={!canLive}
                style={{ all: "unset", display: "block", width: "100%", cursor: canLive ? "pointer" : "default" }}>
                <div style={{ aspectRatio: "16/9", background: "#05080B", borderRadius: 7, border: `1px solid ${C.border}`,
                  display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative" }}>
                  <Snapshot path={snap} name={c.name} online={c.online} />
                  {c.recording && (
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
              <div className="flex items-center justify-between" style={{ marginTop: 10, fontFamily: mono, fontSize: 12, color: C.mid }}>
                <span className="flex items-center gap-1.5"><Activity size={12} />motion {c.motion}</span>
                {canLive && (
                  <button onClick={() => setLiveCam(c)} className="so-btn flex items-center gap-1.5"
                    style={{ padding: "4px 10px", borderRadius: 6, fontSize: 12, color: C.cyan, borderColor: C.cyan }}>
                    <Video size={12} /> Live
                  </button>
                )}
              </div>
            </Panel>
          );
        })}
      </div>
      {liveCam && (
        <Suspense fallback={null}>
          <LivePlayer camera={liveCam} onClose={() => setLiveCam(null)} />
        </Suspense>
      )}
    </div>
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
function Alerts({ zones, doors, cameras, elc }) {
  const alerts = [];
  zones.forEach((z) => { if (Math.abs(z.now - z.set) > 2) alerts.push({ sev: "warn", msg: `${z.name} is ${z.now}° (set ${z.set}°)` }); });
  doors.forEach((d) => { if (!d.locked) alerts.push({ sev: "warn", msg: `${d.name} is unlocked` }); });
  cameras.forEach((c) => { if (!c.online) alerts.push({ sev: "warn", msg: `Camera offline: ${c.name}` }); });
  if (elc && elc.staffPresent < elc.requiredRatioStaff) alerts.push({ sev: "warn", msg: `ELC staff ratio low (${elc.staffPresent}/${elc.requiredRatioStaff})` });
  const watch = ["HVAC offline", "Alarm comms failure", "Freezer high temp", "Water leak", "Power outage", "Internet down", "Camera offline", "ELC ratio low"];
  return (
    <div className="grid gap-3">
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
function Assistant({ hub, doors, zones, alarm }) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState([
    { role: "sys", text: "Type a command. Try: “lock the campus”, “set fitness to 70”, “is everything secure?”, “open medical”." },
  ]);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [history]);

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

  const submit = () => { if (!input.trim()) return; respond(input); setInput(""); };
  return (
    <Panel title="Assistant" accent={C.cyan}>
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
          placeholder="Lock the campus…"
          style={{ flex: 1, padding: "11px 14px", borderRadius: 8, background: C.panel2, border: `1px solid ${C.border}`, color: C.text, fontSize: 14, outline: "none", fontFamily: sans }} />
        <button onClick={submit} className="so-btn" style={{ padding: "0 16px", borderRadius: 8, color: C.cyan, borderColor: C.cyan }}><Send size={17} /></button>
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

// Camera snapshot loaded through the authed fetch (an <img> can't send the JWT),
// turned into an object URL. Falls back to a placeholder when no path / on error.
function Snapshot({ path, name, online }) {
  const [src, setSrc] = useState(null);
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

  if (src) return <img src={src} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />;
  return (
    <div className="flex flex-col items-center gap-1" style={{ color: C.dim, fontFamily: mono, fontSize: 12 }}>
      <Video size={22} color={online ? C.dim : C.red} />
      {!online ? "camera offline" : failed ? "snapshot unavailable" : path ? "loading…" : "feed via Hik-Connect"}
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
