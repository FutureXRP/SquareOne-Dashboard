import { useState, useEffect, useMemo, useCallback } from "react";

/*
  The on-site hub (alarm / HVAC / doors).

  When Home Assistant is configured (server detects HA_BASE_URL + HA_TOKEN), this
  reads real state from /api/hub/state and every action POSTs to the proxy, which
  calls Home Assistant. When it's not configured, the same actions just mutate
  local state — identical UI, preview mode.

  Actions update local state optimistically for snappy UI, then (if live) re-sync
  from Home Assistant so the screen reflects what actually happened.
*/

const DEFAULT_DOORS = [
  { id: "main", name: "Main Entrance", locked: true },
  { id: "med", name: "Medical", locked: true },
  { id: "fit", name: "Fitness", locked: true },
  { id: "elc", name: "Early Learning", locked: true },
];
const DEFAULT_ZONES = [
  { id: "med", name: "Medical", set: 72, now: 73, hum: 47, mode: "Cool" },
  { id: "elc", name: "Early Learning", set: 72, now: 75, hum: 52, mode: "Cool" },
  { id: "fit", name: "Fitness", set: 71, now: 71, hum: 44, mode: "Cool" },
  { id: "off", name: "Offices", set: 73, now: 73, hum: 46, mode: "Cool" },
];
const PRESETS = {
  Morning: { Medical: 72, "Early Learning": 72, Fitness: 71, Offices: 73 },
  Night:   { Medical: 77, "Early Learning": 78, Fitness: 78, Offices: 78 },
  Vacation:{ Medical: 82, "Early Learning": 82, Fitness: 82, Offices: 82 },
};

export function useHub(pushLog) {
  const [connected, setConnected] = useState(false);
  const [doors, setDoors] = useState(DEFAULT_DOORS);
  const [alarm, setAlarm] = useState("armed_away");
  const [zones, setZones] = useState(DEFAULT_ZONES);
  const [lockdown, setLockdown] = useState(false);

  // Pull live state from Home Assistant (only if configured).
  const sync = useCallback(async () => {
    let on = false;
    try {
      const health = await fetch("/api/health").then((r) => r.json());
      on = Boolean(health.configured?.hub);
    } catch { on = false; }
    setConnected(on);
    if (!on) return;
    try {
      const r = await fetch("/api/hub/state").then((res) => res.json());
      if (r.ok && r.data) {
        if (r.data.doors?.length) setDoors(r.data.doors);
        if (r.data.alarm) setAlarm(r.data.alarm);
        if (r.data.zones?.length) setZones(r.data.zones);
        if (typeof r.data.lockdown === "boolean") setLockdown(r.data.lockdown);
      }
    } catch (e) {
      pushLog?.(`Hub state read failed: ${e.message}`, "red");
    }
  }, [pushLog]);

  useEffect(() => { sync(); }, [sync]);

  // POST an action to the proxy (when live), then re-sync. No-op in preview.
  const send = useCallback(async (path, body) => {
    if (!connected) return;
    try {
      const r = await fetch(`/api/hub/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then((res) => res.json());
      if (r.ok === false) throw new Error(r.message || "action failed");
      sync();
    } catch (e) {
      pushLog?.(`Hub action failed (${path}): ${e.message}`, "red");
      sync(); // re-read truth even on failure
    }
  }, [connected, sync, pushLog]);

  const hub = useMemo(() => ({
    lockDoor: (id) => {
      setDoors((d) => d.map((x) => (x.id === id ? { ...x, locked: true } : x)));
      pushLog(`Locked ${id}`, "go"); send("lock", { id });
    },
    unlockDoor: (id) => {
      setDoors((d) => d.map((x) => (x.id === id ? { ...x, locked: false } : x)));
      pushLog(`Unlocked ${id}`, "amber"); send("unlock", { id });
    },
    lockAll: () => {
      setDoors((d) => d.map((x) => ({ ...x, locked: true })));
      pushLog("Locked all doors", "go"); send("lockAll");
    },
    unlockAll: () => {
      setDoors((d) => d.map((x) => ({ ...x, locked: false })));
      pushLog("Unlocked all doors", "amber"); send("unlockAll");
    },
    arm: (mode = "armed_away") => {
      setAlarm(mode); pushLog(`Alarm ${mode.replace("_", " ")}`, "go"); send("arm", { mode });
    },
    disarm: () => {
      setAlarm("disarmed"); pushLog("Alarm disarmed", "amber"); send("disarm");
    },
    setTemp: (zoneId, val) => {
      const temperature = Math.max(60, Math.min(85, val));
      setZones((z) => z.map((x) => (x.id === zoneId ? { ...x, set: temperature } : x)));
      pushLog(`Set ${zoneId} to ${temperature}°`, "cyan"); send("setTemp", { zoneId, temperature });
    },
    applyPreset: (name) => {
      const p = PRESETS[name];
      setZones((z) => z.map((x) => (p[x.name] != null ? { ...x, set: p[x.name] } : x)));
      pushLog(`Applied ${name} climate preset`, "cyan");
      // Live: push each zone's new setpoint individually.
      zones.forEach((x) => { if (p[x.name] != null) send("setTemp", { zoneId: x.id, temperature: p[x.name] }); });
    },
    lockdown: () => {
      setDoors((d) => d.map((x) => ({ ...x, locked: true })));
      setAlarm("armed_away"); setLockdown(true);
      pushLog("EMERGENCY LOCKDOWN engaged", "red"); send("lockdown");
    },
    clearLockdown: () => { setLockdown(false); pushLog("Lockdown cleared", "go"); sync(); },
  }), [send, sync, pushLog, zones]);

  return { doors, alarm, zones, lockdown, hub, connected, reloadHub: sync };
}
