import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "./lib/api.js";

/*
  Per-user UI preferences (camera wall layout, etc.).

  Loads from the server (/api/me/prefs) so a person's layout follows them across
  devices, with a localStorage cache for instant paint and an offline/preview
  fallback. Writes are shallow-merged server-side and debounced.
*/
const LS_KEY = "so-prefs";

export function usePrefs() {
  const [prefs, setPrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
  });
  const timer = useRef(null);

  // Pull the authoritative copy once on mount.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/me/prefs")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j?.ok || !j.data || !Object.keys(j.data).length) return;
        setPrefs(j.data);
        try { localStorage.setItem(LS_KEY, JSON.stringify(j.data)); } catch { /* ignore */ }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Merge a patch, cache locally now, persist to the server (debounced).
  const update = useCallback((patch) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        apiFetch("/api/me/prefs", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }).catch(() => {});
      }, 500);
      return next;
    });
  }, []);

  return [prefs, update];
}
