import { useState, useEffect, useCallback } from "react";
import { supabase, supabaseEnabled } from "./lib/supabase.js";

/*
  Auth state. When Supabase is configured, tracks the session + the user's role.
  When it isn't, returns enabled:false so the app renders open (local/preview).
*/
export function useAuth() {
  const [session, setSession] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(supabaseEnabled);

  useEffect(() => {
    if (!supabaseEnabled) { setLoading(false); return; }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Pull the user's role (highest grant across locations). RLS scopes the rows.
  useEffect(() => {
    if (!supabaseEnabled || !session) { setRole(null); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("user_locations").select("role");
      if (cancelled) return;
      const roles = (data || []).map((r) => r.role);
      setRole(roles.includes("admin") ? "admin" : roles.includes("manager") ? "manager" : "staff");
    })();
    return () => { cancelled = true; };
  }, [session]);

  const signOut = useCallback(() => supabase?.auth.signOut(), []);

  return {
    enabled: supabaseEnabled,
    session,
    user: session?.user ?? null,
    role,
    loading,
    signOut,
  };
}
