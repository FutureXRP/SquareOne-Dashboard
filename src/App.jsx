import React from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "./useAuth.js";
import { Login } from "./Login.jsx";
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

  return <SquareOneOps user={auth.user} role={auth.role} authEnabled={auth.enabled} onSignOut={auth.signOut} />;
}
