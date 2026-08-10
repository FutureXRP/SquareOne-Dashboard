import { Router } from "express";
import { supabaseAdmin } from "../auth.js";
import { haOps } from "../haService.js";

/*
  Member door unlock — called server-to-server by the SquareOne Interactive
  store app when a fitness member presses "Unlock door" on their account page.

  Security model: no dashboard login involved. The Interactive app verifies the
  member's active fitness membership on ITS server, then calls this endpoint
  with the shared secret in the x-door-token header. Set the same value in both
  apps:

    DOOR_SERVICE_TOKEN=<long random string>       (both apps)
    MEMBER_DOOR_ID=fit                            (optional; which door, default fitness)
    MEMBER_DOOR_RELOCK_SECONDS=7                  (optional; one-time entry window)

  The unlock is momentary: the door relocks automatically after the window so a
  press means one entry, not an open building. The relock timer is best-effort
  on serverless deploys — if this backend runs serverless, ALSO configure the
  lock hardware / Home Assistant automation for momentary release.

  Every press writes an audit_log row (user_id null, member name in detail).
*/

export const memberDoorRouter = Router();

const RELOCK_SECONDS = Math.max(3, Number(process.env.MEMBER_DOOR_RELOCK_SECONDS || 7));

memberDoorRouter.post("/unlock", async (req, res) => {
  const secret = process.env.DOOR_SERVICE_TOKEN || "";
  if (!secret) return res.status(501).json({ ok: false, message: "Member door access is not configured (DOOR_SERVICE_TOKEN unset)." });
  if ((req.headers["x-door-token"] || "") !== secret) {
    return res.status(401).json({ ok: false, message: "Bad door token." });
  }

  const doorId = process.env.MEMBER_DOOR_ID || "fit";
  const member = typeof req.body?.member === "string" ? req.body.member.slice(0, 120) : "member";

  try {
    await haOps.unlockDoor(doorId);
  } catch (e) {
    return res.status(502).json({ ok: false, message: `Door hub unreachable: ${e.message}` });
  }

  // One-time entry: relock after the window. Best-effort on serverless (see note above).
  setTimeout(() => {
    haOps.lockDoor(doorId).catch((e) => console.warn("member door relock failed:", e.message));
  }, RELOCK_SECONDS * 1000);

  if (supabaseAdmin) {
    try {
      await supabaseAdmin.from("audit_log").insert({
        user_id: null,
        action: "door.member_unlock",
        target: doorId,
        detail: { member, source: "squareone-interactive", relock_seconds: RELOCK_SECONDS },
      });
    } catch (e) {
      console.warn("member door audit failed:", e.message);
    }
  }

  res.json({ ok: true, doorId, relockSeconds: RELOCK_SECONDS });
});
