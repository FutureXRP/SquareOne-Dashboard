import { useState, useEffect, useCallback } from "react";
import { supabase, supabaseEnabled } from "./lib/supabase.js";
import { apiFetch } from "./lib/api.js";

const recordActivity = (event) =>
  apiFetch("/api/me/activity", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
  }).catch(() => {});

/*
  Auth state. When Supabase is configured, tracks the session + the user's role.
  When it isn't, returns enabled:false so the app renders open (local/preview).
*/
export function useAuth() {
  const [session, setSession] = useState(null);
  const [role, setRole] = useState(null);
  const [status, setStatus] = useState(null);   // "active" | "no-access" | "open"
  const [roleTabs, setRoleTabs] = useState({}); // role-based tab buckets
  const [loading, setLoading] = useState(supabaseEnabled);

  useEffect(() => {
    if (!supabaseEnabled) { setLoading(false); return; }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((evt, s) => {
      setSession(s);
      // Log one sign-in per browser session (SIGNED_IN also fires on refresh).
      if (evt === "SIGNED_IN" && s?.user) {
        const key = `so-signin-${s.user.id}`;
        if (!sessionStorage.getItem(key)) { sessionStorage.setItem(key, "1"); recordActivity("signin"); }
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Resolve access on sign-in. The server claims any invite for this email,
  // applies the owner bootstrap, and returns the role + status + role buckets.
  // Invite-only: an uninvited Microsoft account comes back status "no-access".
  useEffect(() => {
    if (!supabaseEnabled || !session) { setRole(null); setStatus(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch("/api/me/provision", { method: "POST" }).then((res) => res.json());
        if (cancelled) return;
        setRole(r?.data?.role ?? null);
        setStatus(r?.data?.status ?? "no-access");
        setRoleTabs(r?.data?.roleTabs ?? {});
      } catch {
        if (!cancelled) { setRole(null); setStatus("no-access"); }
      }
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Record the sign-out while the session is still valid, then sign out.
  const signOut = useCallback(async () => {
    if (session?.user) {
      sessionStorage.removeItem(`so-signin-${session.user.id}`);
      await recordActivity("signout");
    }
    return supabase?.auth.signOut();
  }, [session]);

  return {
    enabled: supabaseEnabled,
    session,
    user: session?.user ?? null,
    role,
    status,
    roleTabs,
    // Authenticated with Microsoft but not authorized (no invite / no role).
    noAccess: supabaseEnabled && Boolean(session) && status === "no-access",
    loading,
    signOut,
  };
}
