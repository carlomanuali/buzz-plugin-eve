// Stand-in for `eve acp --url`: ACP v1 JSON lines on stdio, no model.
// The prompt text picks the behaviour: PERMISSION, SLOW, CRASH, TOOL, EMPTY,
// ERROR, ECHOALL, MAXTOKENS.
import { createInterface } from "node:readline";

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sessions = new Map();
const waiting = new Map();
let nextId = 1000;
let newHangs = false;
const closed = [];
const update = (sessionId, update) =>
  out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const chunk = (sessionId, text) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
    return;
  }
  if (m.method === "initialize") {
    if (process.env.STUB_INIT === "hang") return;
    if (process.env.STUB_INIT === "badversion")
      return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 2 } });
    if (process.env.STUB_NEW === "hang") newHangs = true;
    return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
  }
  if (m.method === "session/close") {
    closed.push(m.params.sessionId);
    process.stderr.write(`closed ${m.params.sessionId}\n`);
    return out({ jsonrpc: "2.0", id: m.id, result: {} });
  }
  if (m.method === "session/new") {
    if (newHangs) return;
    if (m.params.mcpServers.length > 0)
      return out({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "mcp not supported" } });
    const id = `s${sessions.size + 1}-${process.pid}`;
    sessions.set(id, { prompts: [] });
    return out({ jsonrpc: "2.0", id: m.id, result: { sessionId: id } });
  }
  if (m.method === "session/cancel") {
    sessions.get(m.params.sessionId)?.cancel?.();
    return;
  }
  if (m.method === "session/prompt") {
    const { sessionId } = m.params;
    const text = m.params.prompt[0].text;
    sessions.get(sessionId).prompts.push(text);
    if (text.includes("CRASH")) process.exit(3);
    if (text.includes("ERROR"))
      return out({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "upstream failed", data: { message: "PRIVATE-DIAGNOSTIC token=abc" } } });
    if (text.includes("ECHOALL")) {
      chunk(sessionId, text);
      return out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
    }
    if (text.includes("MAXTOKENS"))
      return out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "max_tokens" } });
    if (text.includes("ASK_AFTER_CANCEL")) {
      await new Promise((resolve) => { sessions.get(sessionId).cancel = resolve; });
      const rid = ++nextId;
      out({ jsonrpc: "2.0", id: rid, method: "session/request_permission", params: {
        sessionId, toolCall: { toolCallId: "t3", title: "Late action" },
        options: [{ kind: "allow_once", name: "Approve", optionId: "late:approve" }, { kind: "reject_once", name: "Deny", optionId: "late:deny" }] } });
      const answer = await new Promise((resolve) => waiting.set(rid, resolve));
      process.stderr.write(`late-permission ${JSON.stringify(answer.result.outcome)}\n`);
      return out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "cancelled" } });
    }
    if (text.includes("SLOW")) {
      await new Promise((resolve) => { sessions.get(sessionId).cancel = resolve; });
      return out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "cancelled" } });
    }
    if (text.includes("PERMISSION")) {
      const rid = ++nextId;
      out({ jsonrpc: "2.0", id: rid, method: "session/request_permission", params: {
        sessionId, toolCall: { toolCallId: "t1", title: "Send email" },
        options: [{ kind: "allow_once", name: "Approve", optionId: "i:approve" }, { kind: "reject_once", name: "Deny", optionId: "i:deny" }] } });
      const answer = await new Promise((resolve) => waiting.set(rid, resolve));
      chunk(sessionId, `permission:${answer.result.outcome.optionId}`);
      if (text.includes("THEN_WAIT")) {
        await new Promise((resolve) => { sessions.get(sessionId).cancel = resolve; });
        return out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "cancelled" } });
      }
    } else if (text.includes("TOOL")) {
      chunk(sessionId, "before");
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t2", title: "search" });
      chunk(sessionId, "after");
    } else if (!text.includes("EMPTY")) {
      chunk(sessionId, `prompts=${sessions.get(sessionId).prompts.length} system=${text.startsWith("<buzz-context>")} `);
      chunk(sessionId, `last=${text.split("\n").pop()}`);
    }
    // Requests eve does not make must still get an error back.
    return out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  }
  if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } });
});
