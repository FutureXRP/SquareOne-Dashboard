import { Router } from "express";
import { config, guard, http } from "../config.js";

export const procareRouter = Router();

/*
  ProCare (Early Learning Center).

  IMPORTANT: ProCare does NOT publish a broadly-available public API. There is no
  documented OAuth/REST endpoint a customer can self-serve. Realistic options:
    - Confirm partner / API access for your specific ProCare account (ask your rep).
    - Use a scheduled report export (CSV) that you drop somewhere this proxy reads.

  This handler is written so that IF you obtain an API base URL + key, it will work
  with a conventional Bearer-token REST shape. Adjust the paths/field names to match
  whatever ProCare actually gives you. Until PROCARE_BASE_URL + PROCARE_API_KEY are
  set, the endpoint returns { configured: false } and the UI shows sample data.
*/

procareRouter.get(
  "/elc/today",
  guard("procare", async () => {
    const { baseUrl, apiKey } = config.procare;
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

    // TODO: replace with the real endpoint(s) your ProCare access provides.
    const raw = await http(`${baseUrl}/attendance/today`, { headers });

    // Normalize into the shape the ELC tab expects. Map fields to your data.
    return {
      childrenPresent: raw.children_present ?? raw.present ?? 0,
      childrenEnrolled: raw.children_enrolled ?? raw.enrolled ?? 0,
      staffPresent: raw.staff_present ?? 0,
      requiredRatioStaff: raw.required_staff ?? 0,
      unreadMessages: raw.unread_messages ?? 0,
      rooms: (raw.rooms || []).map((r) => ({
        room: r.name,
        present: r.present ?? 0,
        capacity: r.capacity ?? 0,
        staff: r.staff ?? 0,
      })),
    };
  })
);
