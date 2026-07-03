import React, { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { X, Loader2 } from "lucide-react";
import { apiFetch } from "./lib/api.js";

const C = { bg: "#0B0F14", panel: "#131A22", border: "#243140", text: "#E8EDF2", mid: "#92A2B3", red: "#E0564B", cyan: "#52BECF" };
const mono = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, monospace";

/*
  Live camera view. Asks the proxy for an HLS URL
  (GET /api/hik/cameras/:id/live -> { url, expireTime }) and plays it:
    - Safari plays HLS natively (video.src = url).
    - Chrome/Firefox use hls.js to attach the m3u8 to the <video>.
  Rendered as a modal overlay; closes on backdrop click or the X.
*/
export function LivePlayer({ camera, onClose }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | playing | error
  const [error, setError] = useState("");

  useEffect(() => {
    let hls;
    let cancelled = false;
    let slowTimer, hardTimer;

    (async () => {
      try {
        const r = await apiFetch(`/api/hik/cameras/${camera.id}/live`).then((res) => res.json());
        const url = r?.data?.url;
        if (!url) throw new Error(r?.message || "No live stream URL returned.");
        if (cancelled) return;

        const video = videoRef.current;
        // Flip to "playing" only when real frames arrive — otherwise the loader
        // hides and the user just sees black while the stream spins up.
        const onPlaying = () => { if (!cancelled) { clearTimeout(slowTimer); clearTimeout(hardTimer); setStatus("playing"); } };
        video.addEventListener("playing", onPlaying);
        video.addEventListener("loadeddata", onPlaying);

        // EZVIZ live streams can take several seconds to start; nudge the user
        // rather than leaving an ambiguous black frame.
        slowTimer = setTimeout(() => {
          if (!cancelled && video.readyState < 2) {
            setError("Still connecting… EZVIZ live can take 10-15s to start. If it stays black, this camera likely has Video Encryption on — turn it off in the app or add its code to HIK_DEVICE_CODES.");
          }
        }, 9000);
        // Hard stop: if no frames after 25s, it isn't going to play (almost
        // always Video Encryption on the device). Fail with the fix instead of
        // spinning forever.
        hardTimer = setTimeout(() => {
          if (!cancelled && videoRef.current?.readyState < 2) {
            setStatus("error");
            setError("Couldn't start this stream. This camera almost certainly has Video Encryption turned on — turn it off on the device in the EZVIZ/Hik-Connect app, or add its verification code to HIK_DEVICE_CODES. (Snapshots still work via the thumbnail.)");
          }
        }, 25000);

        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = url; // native HLS (Safari/iOS)
        } else if (Hls.isSupported()) {
          hls = new Hls({ lowLatencyMode: true });
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) { setStatus("error"); setError(`Stream error: ${data.details}`); }
          });
        } else {
          throw new Error("HLS playback isn't supported in this browser.");
        }
        video.play?.().catch(() => {});
      } catch (e) {
        if (!cancelled) { setStatus("error"); setError(e.message); }
      }
    })();

    return () => { cancelled = true; clearTimeout(slowTimer); clearTimeout(hardTimer); if (hls) hls.destroy(); };
  }, [camera.id]);

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", zIndex: 50,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "min(900px, 100%)", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
        <div className="flex items-center justify-between" style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontWeight: 600, color: C.text }}>{camera.name} · Live</span>
          <button onClick={onClose} className="so-btn" style={{ padding: 6, borderRadius: 6, color: C.mid }}><X size={16} /></button>
        </div>
        <div style={{ aspectRatio: "16/9", background: "#05080B", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
          <video ref={videoRef} controls autoPlay muted playsInline
            style={{ width: "100%", height: "100%", objectFit: "contain", display: status === "error" ? "none" : "block" }} />
          {status === "loading" && (
            <div style={{ position: "absolute", color: C.mid, fontFamily: mono, fontSize: 13, textAlign: "center", padding: 24, maxWidth: 460 }}>
              <div className="flex items-center gap-2" style={{ justifyContent: "center" }}>
                <Loader2 size={16} className="spin" /> connecting to stream…
              </div>
              {error && <div style={{ marginTop: 12, color: C.mid, lineHeight: 1.5 }}>{error}</div>}
            </div>
          )}
          {status === "error" && (
            <div style={{ color: C.red, fontFamily: mono, fontSize: 13, padding: 24, textAlign: "center" }}>
              {error}
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes so-spin{to{transform:rotate(360deg)}} .spin{animation:so-spin 1s linear infinite}`}</style>
    </div>
  );
}
