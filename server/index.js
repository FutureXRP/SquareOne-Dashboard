import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { amiliaRouter } from "./providers/amilia.js";
import { hikRouter } from "./providers/hik.js";
import { procareRouter } from "./providers/procare.js";

const app = express();
app.use(cors());
app.use(express.json());

// Health + which integrations are actually configured (drives the UI status bar).
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    configured: {
      amilia: config.amilia.configured,
      hik: config.hik.configured,
      procare: config.procare.configured,
    },
  });
});

app.use("/api/amilia", amiliaRouter);
app.use("/api/hik", hikRouter);
app.use("/api/procare", procareRouter);

app.listen(config.port, () => {
  console.log(`SquareOne proxy listening on http://localhost:${config.port}`);
  console.log("Configured:", {
    amilia: config.amilia.configured,
    hik: config.hik.configured,
    procare: config.procare.configured,
  });
});
