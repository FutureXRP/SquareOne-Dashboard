import React from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { useAuth } from "./useAuth.js";
import { Login } from "./Login.jsx";
import { BrandLogo } from "./BrandLogo.jsx";
import SquareOneOps from "./SquareOneOps.jsx";

/*
  Gate: if Supabase auth is configured and no one is signed in, show Login.
  Otherwise render the dashboard. With auth disabled (local/preview), it just
  renders the dashboard as before.
*/
export default function App() {
  const auth = useAuth();

  if (auth.loading) {
    return (
      <div style={{ background: "#0B0F14", color: "#92A2B3", minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, gap: 8 }}>
        <Loader2 size={16} className="spin" /> loading…
        <style>{`@keyframes so-spin{to{transform:rotate(360deg)}} .spin{animation:so-spin 1s linear infinite}`}</style>
      </div>
    );
  }

  if (auth.enabled && !auth.session) return <Login />;

  // Signed in with Microsoft, but still resolving access — brief spinner so the
  // dashboard doesn't flash before an unauthorized account is bounced.
  if (auth.enabled && auth.session && auth.status === null) {
    return (
      <div style={{ background: "#0B0F14", color: "#92A2B3", minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, gap: 8 }}>
        <Loader2 size={16} className="spin" /> checking access…
        <style>{`@keyframes so-spin{to{transform:rotate(360deg)}} .spin{animation:so-spin 1s linear infinite}`}</style>
      </div>
    );
  }

  // Authenticated but not authorized (no invite) — deny with a clear message.
  if (auth.noAccess) return <NoAccess email={auth.user?.email} onSignOut={auth.signOut} />;

  return <SquareOneOps user={auth.user} role={auth.role} roleTabs={auth.roleTabs} authEnabled={auth.enabled} onSignOut={auth.signOut} />;
}

function NoAccess({ email, onSignOut }) {
  const C = { bg: "#F4F7FB", panel: "#FFFFFF", border: "#E3E9F1", text: "#1B2432", mid: "#5B6675", dim: "#8492A2", amber: "#E8833A", cyan: "#2E7BC4" };
  const mono = "ui-monospace, 'SF Mono', Menlo, monospace";
  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" }}>
      <div style={{ width: "min(420px, 100%)", textAlign: "center" }}>
        <div className="flex items-center justify-center gap-3" style={{ marginBottom: 20 }}>
          <BrandLogo size={30} fallbackColor={C.cyan} />
        </div>
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 26 }}>
          <ShieldAlert size={34} color={C.amber} style={{ marginBottom: 10 }} />
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Access not set up yet</div>
          <div style={{ fontSize: 13.5, color: C.mid, lineHeight: 1.6 }}>
            You're signed in{email ? <> as <span style={{ fontFamily: mono, color: C.text }}>{email}</span></> : ""}, but this account
            hasn't been granted access. Ask a SquareOne admin to add you, then sign in again.
          </div>
          <button onClick={onSignOut} className="so-btn" style={{ marginTop: 20, padding: "10px 18px", borderRadius: 8, border: `1px solid ${C.border}`, background: "#F1F5FA", color: C.text, fontWeight: 600, fontSize: 13.5, cursor: "pointer" }}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
