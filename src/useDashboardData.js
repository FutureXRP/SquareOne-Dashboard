import { useState, useEffect, useCallback } from "react";
import { apiJson as getJson } from "./lib/api.js";

/*
  One hook that feeds the cloud tabs (Bookings/Members/Cameras/ELC).

  It asks the backend proxy (/api/health) which integrations are configured, then
  fetches live data for the ones that are. Anything not configured — or any failed
  fetch — falls back to the sample data passed in, so the UI always renders.

  Requests carry the Supabase JWT (via apiJson) so the backend can enforce roles.
  Live wiring happens entirely server-side (server/*). The browser never sees a key.
*/

// Proxy responses are { ok, configured, provider, data }. Unwrap to data or null.
function unwrap(envelope) {
  if (envelope && envelope.ok && envelope.configured) return envelope.data;
  return null;
}

export function useDashboardData(mock) {
  const [connected, setConnected] = useState({ amilia: false, hik: false, procare: false });
  const [data, setData] = useState({
    bookings: mock.bookings,
    members: mock.members,
    cameras: mock.cameras,
    elc: mock.elc,
  });
  const [loading, setLoading] = useState(true);
  const [usingMock, setUsingMock] = useState({ amilia: true, hik: true, procare: true });

  const load = useCallback(async () => {
    setLoading(true);
    let health;
    try {
      health = await getJson("/api/health");
    } catch {
      // No backend running at all → pure preview mode with sample data.
      setConnected({ amilia: false, hik: false, procare: false });
      setUsingMock({ amilia: true, hik: true, procare: true });
      setLoading(false);
      return;
    }
    const cfg = health.configured || {};
    setConnected(cfg);

    const next = { ...data };
    const mockFlags = { amilia: true, hik: true, procare: true };

    const tasks = [];
    if (cfg.amilia) {
      tasks.push(
        getJson("/api/amilia/bookings").then((r) => { const d = unwrap(r); if (d) { next.bookings = d; mockFlags.amilia = false; } }).catch(() => {}),
        getJson("/api/amilia/members/summary").then((r) => { const d = unwrap(r); if (d) { next.members = d; mockFlags.amilia = false; } }).catch(() => {})
      );
    }
    if (cfg.hik) {
      tasks.push(
        getJson("/api/hik/cameras").then((r) => { const d = unwrap(r); if (d) { next.cameras = d; mockFlags.hik = false; } }).catch(() => {})
      );
    }
    if (cfg.procare) {
      tasks.push(
        getJson("/api/procare/elc/today").then((r) => { const d = unwrap(r); if (d) { next.elc = d; mockFlags.procare = false; } }).catch(() => {})
      );
    }
    await Promise.all(tasks);

    setData(next);
    setUsingMock(mockFlags);
    setLoading(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  // Keep the numbers fresh without a manual refresh: re-fetch every 2 minutes
  // while the tab is visible, and immediately when the user comes back to it.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") load(); };
    const id = setInterval(tick, 120_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [load]);

  // Snapshot URL only resolves to the proxy when Hik is live; else null (preview tile).
  const snapshotUrl = useCallback(
    (id) => (connected.hik ? `/api/hik/cameras/${id}/snapshot.jpg` : null),
    [connected.hik]
  );

  return { ...data, connected, usingMock, loading, reload: load, snapshotUrl };
}
