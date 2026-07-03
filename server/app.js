import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { requireAuth, authEnabled } from "./auth.js";
import { amiliaRouter } from "./providers/amilia.js";
import { hikRouter } from "./providers/hik.js";
import { procareRouter } from "./providers/procare.js";
import { hubRouter } from "./providers/homeassistant.js";
import { assistantRouter } from "./providers/assistant.js";
import { doorsRouter } from "./providers/doorSchedule.js";
import { alertsRouter } from "./providers/memberAlerts.js";
import { pro1Router, napcoRouter, geovisionRouter } from "./providers/buildingClouds.js";

/*
  The Express app, shared by local dev (server/index.js -> listen) and Vercel
  (api/[...path].js -> exported as the serverless handler).
*/
const app = express();
app.use(cors());
app.use(express.json());

// Health + which integrations are configured (drives the UI status bar). Open.
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    authEnabled,
    configured: {
      hub: config.homeassistant.configured,
      amilia: config.amilia.configured,
      hik: config.hik.configured,
      procare: config.procare.configured,
      assistant: config.anthropic.configured,
      alerts: config.alerts.configured,
      pro1: config.pro1.configured,
      napco: config.napco.configured,
      geovision: config.geovision.configured,
    },
  });
});

// Everything below requires a signed-in user when Supabase auth is enabled.
app.use("/api/amilia", requireAuth, amiliaRouter);
app.use("/api/hik", requireAuth, hikRouter);
app.use("/api/procare", requireAuth, procareRouter);
app.use("/api/hub", requireAuth, hubRouter);
app.use("/api/assistant", requireAuth, assistantRouter);
// Door schedule handles its own auth per-route: /schedule wants a signed-in
// user, /run wants the cron secret (a scheduler can't sign in).
app.use("/api/doors", doorsRouter);
app.use("/api/alerts", alertsRouter);
// Building-system clouds — start as admin-only login probes (see buildingClouds.js).
app.use("/api/pro1", requireAuth, pro1Router);
app.use("/api/napco", requireAuth, napcoRouter);
app.use("/api/geovision", requireAuth, geovisionRouter);

export default app;
