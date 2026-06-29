import app from "./app.js";
import { config } from "./config.js";
import { authEnabled } from "./auth.js";

// Local dev entry point. On Vercel the app is served via api/[...path].js instead.
app.listen(config.port, () => {
  console.log(`SquareOne proxy listening on http://localhost:${config.port}`);
  console.log("Auth:", authEnabled ? "enabled (Supabase)" : "disabled (open/local)");
  console.log("Configured:", {
    hub: config.homeassistant.configured,
    amilia: config.amilia.configured,
    hik: config.hik.configured,
    procare: config.procare.configured,
  });
});
