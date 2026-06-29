import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logAudit } from "../auth.js";
import { readState, haOps, haConfigured, doorIds, zoneIds } from "../haService.js";

export const assistantRouter = Router();

/*
  Built-in agent. Takes the chat history, runs a Claude tool-use loop, and
  executes campus actions (lock/unlock/arm/disarm/set temperature/lockdown)
  server-side via Home Assistant. Returns the final reply plus the list of
  actions it took so the UI can re-sync hub state.

  Uses claude-opus-4-8 with adaptive thinking. The Anthropic key lives only on
  the server (ANTHROPIC_API_KEY). Every executed action is written to audit_log.
*/

const client = () => new Anthropic({ apiKey: config.anthropic.apiKey });

function tools() {
  const doors = doorIds();
  const zones = zoneIds();
  return [
    { name: "get_campus_status", description: "Read the current state of all doors, the alarm, and climate zones. Use this to answer questions about whether the campus is secure or what the temperatures are.",
      input_schema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "lock_door", description: "Lock a single door.",
      input_schema: { type: "object", properties: { id: { type: "string", enum: doors } }, required: ["id"], additionalProperties: false } },
    { name: "unlock_door", description: "Unlock a single door.",
      input_schema: { type: "object", properties: { id: { type: "string", enum: doors } }, required: ["id"], additionalProperties: false } },
    { name: "lock_all_doors", description: "Lock every door on the campus.",
      input_schema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "unlock_all_doors", description: "Unlock every door on the campus.",
      input_schema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "arm_alarm", description: "Arm the alarm. mode 'armed_away' when nobody is present, 'armed_home' when people remain inside.",
      input_schema: { type: "object", properties: { mode: { type: "string", enum: ["armed_away", "armed_home"] } }, required: ["mode"], additionalProperties: false } },
    { name: "disarm_alarm", description: "Disarm the alarm.",
      input_schema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "set_temperature", description: "Set the target temperature (60-85°F) for a climate zone.",
      input_schema: { type: "object", properties: { zone: { type: "string", enum: zones }, temperature: { type: "integer", minimum: 60, maximum: 85 } }, required: ["zone", "temperature"], additionalProperties: false } },
    { name: "emergency_lockdown", description: "EMERGENCY: immediately lock every door and arm the alarm away. Only use when the user clearly asks for a lockdown or describes an emergency.",
      input_schema: { type: "object", properties: {}, additionalProperties: false } },
  ];
}

const systemPrompt = () =>
  `You are the SquareOne Operations Center assistant. You help campus staff control and check on the facility: doors (${doorIds().join(", ")}), the alarm, and climate zones (${zoneIds().join(", ")}).

Use tools to take real actions and to read current state before answering status questions. Be concise and confirm what you did in one or two sentences. Don't invent doors or zones outside the lists above. For destructive or campus-wide actions (unlock everything, lockdown), do them when asked but state clearly what happened. If a tool reports the hub isn't configured, tell the user the Home Assistant hub isn't connected yet rather than pretending the action succeeded.`;

// Execute one tool call against Home Assistant. Returns a string result.
async function execTool(name, input, req) {
  if (!haConfigured() && name !== "get_campus_status") {
    return { text: "Home Assistant hub is not configured, so I can't perform that action.", isError: true };
  }
  try {
    switch (name) {
      case "get_campus_status": {
        if (!haConfigured()) return { text: "Home Assistant hub is not configured; live status is unavailable.", isError: false };
        return { text: JSON.stringify(await readState()), isError: false };
      }
      case "lock_door": await haOps.lockDoor(input.id); return done(req, "lock", input.id, `Locked ${input.id}.`);
      case "unlock_door": await haOps.unlockDoor(input.id); return done(req, "unlock", input.id, `Unlocked ${input.id}.`);
      case "lock_all_doors": await haOps.lockAll(); return done(req, "lockAll", null, "Locked all doors.");
      case "unlock_all_doors": await haOps.unlockAll(); return done(req, "unlockAll", null, "Unlocked all doors.");
      case "arm_alarm": await haOps.arm(input.mode); return done(req, "arm", input.mode, `Alarm ${input.mode.replace("_", " ")}.`);
      case "disarm_alarm": await haOps.disarm(); return done(req, "disarm", null, "Alarm disarmed.");
      case "set_temperature": await haOps.setTemp(input.zone, input.temperature); return done(req, "setTemp", input.zone, `Set ${input.zone} to ${input.temperature}°.`);
      case "emergency_lockdown": await haOps.lockdown(); return done(req, "lockdown", null, "Emergency lockdown engaged: all doors locked, alarm armed away.");
      default: return { text: `Unknown tool ${name}.`, isError: true };
    }
  } catch (e) {
    return { text: `Action failed: ${e.message}`, isError: true };
  }
}

function done(req, action, target, text) {
  logAudit(req, `assistant.${action}`, target, {});
  return { text, isError: false };
}

assistantRouter.post("/", async (req, res) => {
  if (!config.anthropic.configured) {
    return res.status(200).json({ ok: false, configured: false, message: "Assistant is not configured (set ANTHROPIC_API_KEY)." });
  }
  const history = Array.isArray(req.body?.messages) ? req.body.messages : [];
  // Keep only role/content text turns from the client.
  const messages = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length) return res.status(400).json({ ok: false, message: "No messages provided." });

  try {
    const anthropic = client();
    const actions = [];
    let response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: systemPrompt(),
      tools: tools(),
      messages,
    });

    // Manual agentic loop, bounded.
    for (let i = 0; i < 6 && response.stop_reason === "tool_use"; i++) {
      messages.push({ role: "assistant", content: response.content });
      const results = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const { text, isError } = await execTool(block.name, block.input || {}, req);
        results.push({ type: "tool_result", tool_use_id: block.id, content: text, is_error: isError });
        if (!isError && block.name !== "get_campus_status") actions.push(block.name);
      }
      messages.push({ role: "user", content: results });
      response = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        system: systemPrompt(),
        tools: tools(),
        messages,
      });
    }

    const reply = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ ok: true, configured: true, reply: reply || "Done.", actions });
  } catch (e) {
    console.error("[assistant]", e.message);
    res.status(502).json({ ok: false, configured: true, message: `Assistant error: ${e.message}` });
  }
});
