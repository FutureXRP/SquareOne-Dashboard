import { Router } from "express";
import { supabaseAdmin, logAudit } from "../auth.js";

export const chatRouter = Router();

/*
  Internal team chat. Every person with dashboard access can message every other
  person, plus one shared whole-team "Group" channel.

  Channels:
    - "group"          — the whole-team channel (everyone with access).
    - "dm:<idA>:<idB>" — a 1:1 channel; the two user ids are sorted so the pair
                         always maps to the same channel regardless of who opens it.

  Messages live in the chat_messages table (service-role only, like our other
  tables). Participation is enforced here: a DM channel is always built from the
  caller's own id, so you can only ever read/write conversations you're part of.
*/

const GROUP = "group";
const dmChannel = (a, b) => "dm:" + [a, b].sort().join(":");
const COLS = "id, channel, sender_id, sender_email, body, created_at";

// A tiny cache so the conversation list / send path don't hit auth.admin on
// every poll. Warm-instance only (serverless resets it), which is all we need.
let rosterCache = { at: 0, people: [] };
async function roster() {
  if (!supabaseAdmin) return [];
  if (Date.now() - rosterCache.at < 30_000 && rosterCache.people.length) return rosterCache.people;
  const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
  const users = list?.users || [];
  const ids = users.map((u) => u.id);
  const [{ data: locs }, { data: profs }] = await Promise.all([
    supabaseAdmin.from("user_locations").select("user_id, role").in("user_id", ids),
    supabaseAdmin.from("profiles").select("id, full_name").in("id", ids),
  ]);
  // A user can hold a grant at more than one location; keep the strongest.
  const roleBy = new Map();
  (locs || []).forEach((r) => { const cur = roleBy.get(r.user_id); if (cur !== "admin") roleBy.set(r.user_id, r.role); });
  const nameBy = new Map((profs || []).map((p) => [p.id, p.full_name]));
  const people = users
    .filter((u) => roleBy.has(u.id)) // only people who actually have access
    .map((u) => ({ id: u.id, email: u.email, name: nameBy.get(u.id) || u.email, role: roleBy.get(u.id) }));
  rosterCache = { at: Date.now(), people };
  return people;
}

// Build the channel for a request. For a DM it's always constructed from the
// caller's own id, so the caller is guaranteed to be a participant.
function channelFor(meId, { channel, withId }) {
  if (channel === GROUP) return GROUP;
  const other = (withId || "").toString().trim();
  if (!other || other === meId) return null;
  return dmChannel(meId, other);
}

// GET /api/chat/contacts — everyone you can message (you excluded) + your own id.
chatRouter.get("/contacts", async (req, res) => {
  if (!req.user) return res.json({ ok: true, data: { me: null, contacts: [] } });
  try {
    const people = await roster();
    const me = people.find((p) => p.id === req.user.id)
      || { id: req.user.id, email: req.user.email, name: req.user.email, role: null };
    res.json({ ok: true, data: { me, contacts: people.filter((p) => p.id !== req.user.id) } });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// GET /api/chat/messages?channel=group | ?with=<userId>[&after=<iso>]
chatRouter.get("/messages", async (req, res) => {
  if (!req.user) return res.json({ ok: true, data: [] });
  try {
    const channel = channelFor(req.user.id, { channel: req.query.channel, withId: req.query.with });
    if (!channel) return res.status(400).json({ ok: false, message: "Specify channel=group or with=<userId>." });
    let q = supabaseAdmin.from("chat_messages").select(COLS)
      .eq("channel", channel).order("created_at", { ascending: true }).limit(300);
    if (req.query.after) q = q.gt("created_at", req.query.after);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, data: data || [] });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// POST /api/chat/messages { channel:'group' | to:<userId>, body }
chatRouter.post("/messages", async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, message: "Sign in to chat." });
  const body = String((req.body && req.body.body) || "").trim();
  if (!body) return res.status(400).json({ ok: false, message: "Message is empty." });
  if (body.length > 4000) return res.status(400).json({ ok: false, message: "Message is too long." });
  try {
    const channel = channelFor(req.user.id, { channel: req.body.channel, withId: req.body.to });
    if (!channel) return res.status(400).json({ ok: false, message: "Specify channel=group or to=<userId>." });
    // The caller must have access; a DM target must be a real person with access.
    const people = await roster();
    if (!people.some((p) => p.id === req.user.id)) return res.status(403).json({ ok: false, message: "No chat access." });
    if (channel !== GROUP) {
      const other = channel.slice(3).split(":").find((id) => id !== req.user.id);
      if (!people.some((p) => p.id === other)) return res.status(400).json({ ok: false, message: "Unknown recipient." });
    }
    const { data, error } = await supabaseAdmin.from("chat_messages")
      .insert({ channel, sender_id: req.user.id, sender_email: req.user.email, body })
      .select(COLS).single();
    if (error) throw error;
    logAudit(req, "chat.send", channel, { len: body.length });
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// GET /api/chat/summary — newest message per channel the caller is in (group +
// their DMs). Powers the conversation-list previews and unread dots.
chatRouter.get("/summary", async (req, res) => {
  if (!req.user) return res.json({ ok: true, data: {} });
  try {
    const me = req.user.id;
    const { data, error } = await supabaseAdmin.from("chat_messages")
      .select("channel, sender_id, body, created_at")
      .or(`channel.eq.${GROUP},channel.ilike.*${me}*`)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    const byChannel = {};
    for (const m of data || []) {
      if (m.channel.startsWith("dm:") && !m.channel.includes(me)) continue; // belt-and-suspenders
      if (!byChannel[m.channel]) byChannel[m.channel] = { lastAt: m.created_at, lastBody: m.body, lastSender: m.sender_id };
    }
    res.json({ ok: true, data: byChannel });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
