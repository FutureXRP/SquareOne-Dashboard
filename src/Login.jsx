import React, { useState } from "react";
import { ShieldCheck, Loader2 } from "lucide-react";
import { supabase } from "./lib/supabase.js";
import { BrandLogo } from "./BrandLogo.jsx";

// Matches the light "Workspace" palette in SquareOneOps.jsx.
const C = {
  bg: "#F4F7FB", panel: "#FFFFFF", panel2: "#F1F5FA", border: "#E3E9F1", borderHi: "#CBD6E3",
  text: "#1B2432", mid: "#5B6675", dim: "#8492A2", cyan: "#2E7BC4", go: "#2F9E6F", red: "#D84B40",
};
const mono = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, monospace";
const sans = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// Microsoft (Entra) is the only sign-in method. Everyone uses their work
// M365 account; email/password and magic-link sign-in are intentionally gone.
export function Login() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const signInMicrosoft = async () => {
    setBusy(true); setMsg(null);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "azure",
        options: {
          scopes: "email openid profile",
          redirectTo: window.location.origin,
          // Always show the account chooser so people pick their WORK account
          // instead of a lingering personal Microsoft session (avoids AADSTS90072).
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) throw error;
      // Redirects to Microsoft; the session returns via onAuthStateChange.
    } catch (err) {
      setMsg(err.message || "Microsoft sign-in is unavailable right now. Try again, or contact your admin.");
      setBusy(false);
    }
  };

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: sans, minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "min(380px, 100%)" }}>
        <div className="flex items-center gap-3" style={{ marginBottom: 22 }}>
          <BrandLogo size={32} fallbackColor={C.cyan} />
          <div>
            <div style={{ fontSize: 11, letterSpacing: 3, color: C.mid, fontFamily: mono, textTransform: "uppercase" }}>SquareOne</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Operations Center</div>
          </div>
        </div>

        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 22 }}>
          <div className="flex items-center gap-2" style={{ marginBottom: 6, color: C.text, fontWeight: 600 }}>
            <ShieldCheck size={18} color={C.cyan} /> Sign in
          </div>
          <div style={{ fontSize: 13, color: C.mid, lineHeight: 1.5, marginBottom: 18 }}>
            Use your SquareOne Microsoft 365 work account.
          </div>

          <button type="button" onClick={signInMicrosoft} disabled={busy} aria-label="Sign in with Microsoft"
            style={{ width: "100%", padding: "12px", borderRadius: 8, border: "none", cursor: "pointer",
              background: C.cyan, color: "#fff", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, opacity: busy ? 0.75 : 1 }}>
            {busy ? <Loader2 size={16} className="spin" /> : <MicrosoftLogo />}
            {busy ? "Redirecting…" : "Sign in with Microsoft"}
          </button>

          {msg && (
            <div style={{ marginTop: 14, padding: "9px 12px", borderRadius: 7, fontSize: 12.5, fontFamily: mono,
              background: C.panel2, border: `1px solid ${C.red}`, color: C.red }}>
              {msg}
            </div>
          )}
        </div>
        <div style={{ marginTop: 14, fontSize: 11.5, color: C.dim, fontFamily: mono, textAlign: "center" }}>
          Access is managed by your admin. Ask them to add your account.
        </div>
      </div>
      <style>{`@keyframes so-spin{to{transform:rotate(360deg)}} .spin{animation:so-spin 1s linear infinite}`}</style>
    </div>
  );
}

function MicrosoftLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#fff" opacity="0.95" />
      <rect x="11" y="1" width="9" height="9" fill="#fff" opacity="0.8" />
      <rect x="1" y="11" width="9" height="9" fill="#fff" opacity="0.8" />
      <rect x="11" y="11" width="9" height="9" fill="#fff" opacity="0.65" />
    </svg>
  );
}
