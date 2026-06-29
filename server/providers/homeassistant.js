import { Router } from "express";
import { guard } from "../config.js";
import { logAudit } from "../auth.js";
import { readState, haOps } from "../haService.js";

export const hubRouter = Router();

/*
  Home Assistant hub routes — thin wrappers over server/haService.js (which is
  shared with the assistant agent). See .env.example for setup (HA_BASE_URL,
  HA_TOKEN, HA_ENTITIES mapping, optional HA_ALARM_CODE).
*/

hubRouter.get("/state", guard("homeassistant", () => readState()));

// Wrap a hub action: run it, then write an audit entry (who did what).
function action(name, run) {
  return guard("homeassistant", async (req) => {
    const body = req.body || {};
    await run(body);
    logAudit(req, `hub.${name}`, body.id || body.zoneId || null, body);
    return { applied: true };
  });
}

hubRouter.post("/lock",      action("lock",      ({ id }) => haOps.lockDoor(id)));
hubRouter.post("/unlock",    action("unlock",    ({ id }) => haOps.unlockDoor(id)));
hubRouter.post("/lockAll",   action("lockAll",   () => haOps.lockAll()));
hubRouter.post("/unlockAll", action("unlockAll", () => haOps.unlockAll()));
hubRouter.post("/arm",       action("arm",       ({ mode }) => haOps.arm(mode)));
hubRouter.post("/disarm",    action("disarm",    () => haOps.disarm()));
hubRouter.post("/setTemp",   action("setTemp",   ({ zoneId, temperature }) => haOps.setTemp(zoneId, temperature)));
hubRouter.post("/lockdown",  action("lockdown",  () => haOps.lockdown()));
