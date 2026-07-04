import React, { useState } from "react";
import { ShieldCheck, Mail, Lock, Loader2 } from "lucide-react";
import { supabase } from "./lib/supabase.js";
import { BrandLogo } from "./BrandLogo.jsx";

// Matches the light "Workspace" palette in SquareOneOps.jsx.
const C = {
  bg: "#F4F7FB", panel: "#FFFFFF", panel2: "#F1F5FA", border: "#E3E9F1", borderHi: "#CBD6E3",
  text: "#1B2432", mid: "#5B6675", dim: "#8492A2", cyan: "#2E7BC4", go: "#2F9E6F", red: "#D84B40",
};
const mono = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, monospace";
const sans = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { kind: 'err'|'ok', text }
  const [magic, setMagic] = useState(false);

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
      setMsg({ kind: "err", text: err.message || "Microsoft sign-in unavailable — is it enabled in Supabase?" });
      setBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      if (magic) {
        const { error } = await supabase.auth.signInWithOtp({ email });
        if (error) throw error;
        setMsg({ kind: "ok", text: "Check your email for a sign-in link." });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // onAuthStateChange in useAuth swaps to the app automatically.
      }
    } catch (err) {
      setMsg({ kind: "err", text: err.message || "Sign-in failed." });
    } finally {
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

        <form onSubmit={submit} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 22 }}>
          <div className="flex items-center gap-2" style={{ marginBottom: 16, color: C.text, fontWeight: 600 }}>
            <ShieldCheck size={18} color={C.cyan} /> Sign in
          </div>

          <Field icon={Mail} type="email" placeholder="you@company.com" value={email} onChange={setEmail} autoFocus />
          {!magic && <Field icon={Lock} type="password" placeholder="Password" value={password} onChange={setPassword} />}

          <button type="submit" disabled={busy || !email || (!magic && !password)}
            style={{ width: "100%", marginTop: 6, padding: "11px", borderRadius: 8, border: "none", cursor: "pointer",
              background: C.cyan, color: C.bg, fontWeight: 700, fontSize: 14, opacity: busy ? 0.7 : 1 }}>
            {busy ? <Loader2 size={15} className="spin" /> : magic ? "Send magic link" : "Sign in"}
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 12px", color: C.dim, fontSize: 11.5, fontFamily: mono }}>
            <div style={{ flex: 1, height: 1, background: C.border }} /> OR <div style={{ flex: 1, height: 1, background: C.border }} />
          </div>

          <button type="button" onClick={signInMicrosoft} disabled={busy}
            style={{ width: "100%", padding: "11px", borderRadius: 8, border: `1px solid ${C.borderHi}`, cursor: "pointer",
              background: C.panel2, color: C.text, fontWeight: 600, fontSize: 13.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}>
            <MicrosoftLogo /> Sign in with Microsoft
          </button>

          <button type="button" onClick={() => { setMagic((m) => !m); setMsg(null); }}
            style={{ width: "100%", marginTop: 10, background: "none", border: "none", color: C.mid, fontSize: 12.5, cursor: "pointer", fontFamily: mono }}>
            {magic ? "← use password instead" : "email me a magic link instead"}
          </button>

          {msg && (
            <div style={{ marginTop: 14, padding: "9px 12px", borderRadius: 7, fontSize: 12.5, fontFamily: mono,
              background: C.panel2, border: `1px solid ${msg.kind === "err" ? C.red : C.go}`, color: msg.kind === "err" ? C.red : C.go }}>
              {msg.text}
            </div>
          )}
        </form>
        <div style={{ marginTop: 14, fontSize: 11.5, color: C.dim, fontFamily: mono, textAlign: "center" }}>
          Accounts are managed by your admin. Ask them for an invite.
        </div>
      </div>
      <style>{`@keyframes so-spin{to{transform:rotate(360deg)}} .spin{animation:so-spin 1s linear infinite}`}</style>
    </div>
  );
}

function MicrosoftLogo() {
  return (
    <svg width="15" height="15" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

function Field({ icon: Icon, type, placeholder, value, onChange, autoFocus }) {
  return (
    <div className="flex items-center gap-2" style={{ marginBottom: 12, padding: "0 12px", background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <Icon size={15} color={C.dim} />
      <input type={type} placeholder={placeholder} value={value} autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        style={{ flex: 1, padding: "11px 0", background: "transparent", border: "none", color: C.text, fontSize: 14, outline: "none", fontFamily: sans }} />
    </div>
  );
}
