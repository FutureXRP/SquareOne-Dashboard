import { Router } from "express";
import { config } from "../config.js";
import { supabaseAdmin } from "../auth.js";
import { gvDoorOp, gvDoorTree } from "./buildingClouds.js";
import { haOps } from "../haService.js";

/*
  Member door unlock — called server-to-server by the SquareOne Interactive
  store app when a fitness member presses "Unlock door" on their account page.

  Security model: no dashboard login involved. The Interactive app verifies the
  member's active fitness membership on ITS server, then calls this endpoint
  with the shared secret in the x-door-token header. Set the same value in both
  apps:

    DOOR_SERVICE_TOKEN=<long random string>   (both apps)
    MEMBER_DOOR_NAME=fitness                  (optional; name match, default "fit")
    MEMBER_DOOR_RELOCK_SECONDS=7              (only used on the Home Assistant path)

  Door control paths, same order the Security tab works today:
  1. GeoVision GV-Cloud (GV_BASE_URL/GV_USERNAME/GV_PASSWORD) — the LIVE path.
     The fitness door is found by name in the controller's own door tree
     (first door whose name contains MEMBER_DOOR_NAME, case-insensitive).
     UNLOCK_DOOR is a momentary buzz-open pulse: the controller relocks
     itself, so one press = one entry by hardware design.
  2. Home Assistant (HA_BASE_URL/HA_TOKEN) — fallback for when doors move to
     the on-site hub; unlocks MEMBER_DOOR_ID (default 'fit') and relocks after
     MEMBER_DOOR_RELOCK_SECONDS.

  Every press writes an audit_log row (user_id null, member name in detail).
*/

export const memberDoorRouter = Router();

const RELOCK_SECONDS = Math.max(3, Number(process.env.MEMBER_DOOR_RELOCK_SECONDS || 7));
const DOOR_NAME = (process.env.MEMBER_DOOR_NAME || "fit").toLowerCase();

const gvConfigured = () =>
  Boolean(config.geovision?.baseUrl && config.geovision?.username && config.geovision?.password);

// The fitness door in GeoVision: live controller tree first (real names),
// GV_DOORS env override as fallback.
async function findGvDoor() {
  let doors = null;
  try { doors = await gvDoorTree(); } catch { /* fall through to config */ }
  if (!doors || !doors.length) doors = config.geovision.doors || [];
  return doors.find((d) => (d.name || "").toLowerCase().includes(DOOR_NAME)) || null;
}

memberDoorRouter.post("/unlock", async (req, res) => {
  const secret = process.env.DOOR_SERVICE_TOKEN || "";
  if (!secret) return res.status(501).json({ ok: false, message: "Member door access is not configured (DOOR_SERVICE_TOKEN unset)." });
  if ((req.headers["x-door-token"] || "") !== secret) {
    return res.status(401).json({ ok: false, message: "Bad door token." });
  }

  const member = typeof req.body?.member === "string" ? req.body.member.slice(0, 120) : "member";
  let doorLabel = DOOR_NAME;
  let mode = "geovision";
  let relockSeconds = 6; // GV buzz-open is a momentary pulse; ~6s is typical

  try {
    if (gvConfigured()) {
      const door = await findGvDoor();
      if (!door) {
        return res.status(502).json({ ok: false, message: `No door matching "${DOOR_NAME}" found on the controller. Set MEMBER_DOOR_NAME to part of the door's name in GV-Access.` });
      }
      doorLabel = door.name;
      const r = await gvDoorOp(door.ctrl, door.door, "UNLOCK_DOOR");
      let p = null; try { p = JSON.parse(r.text); } catch { /* not json */ }
      if (!(p?.success === 1 || p?.success === true)) {
        return res.status(502).json({ ok: false, message: `Door controller refused the unlock (status ${r.status}).` });
      }
    } else {
      // Home Assistant fallback (relock ourselves — HA locks aren't momentary).
      mode = "homeassistant";
      relockSeconds = RELOCK_SECONDS;
      const doorId = process.env.MEMBER_DOOR_ID || "fit";
      doorLabel = doorId;
      await haOps.unlockDoor(doorId);
      setTimeout(() => {
        haOps.lockDoor(doorId).catch((e) => console.warn("member door relock failed:", e.message));
      }, RELOCK_SECONDS * 1000);
    }
  } catch (e) {
    return res.status(502).json({ ok: false, message: `Door system unreachable: ${e.message}` });
  }

  if (supabaseAdmin) {
    try {
      await supabaseAdmin.from("audit_log").insert({
        user_id: null,
        action: "door.member_unlock",
        target: doorLabel,
        detail: { member, source: "squareone-interactive", mode, relock_seconds: relockSeconds },
      });
    } catch (e) {
      console.warn("member door audit failed:", e.message);
    }
  }

  res.json({ ok: true, door: doorLabel, mode, relockSeconds });
});
