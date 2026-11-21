// Live check against a real eve server, outside Buzz: the plugin's runtime,
// a real `eve acp` process and a stand-in harness.
//   EVE_BIN=/path/to/eve.js EVE_URL=https://… [EVE_SCOPE=team] node test/live.mjs
import { spawn } from "node:child_process";
import { EveRuntime, processArgs, config } from "../plugin/plugin.js";

const bin = process.env.EVE_BIN;
const url = process.env.EVE_URL;
if (!bin || !url) throw new Error("set EVE_BIN and EVE_URL");

const host = {
  async spawn(id, options = {}) {
    const child = spawn(process.execPath, [bin, "acp", ...(options.args ?? [])], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => options.onStdout?.(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => options.onStderr?.(d));
    const exited = new Promise((r) => child.on("exit", (c) => r(c)));
    return {
      write: (d) => new Promise((res, rej) => child.stdin.write(d, (e) => (e ? rej(e) : res()))),
      end: async () => child.stdin.end(),
      kill: async () => { child.kill(); await exited; },
      exited,
    };
  },
};
const replies = [];
const harness = {
  async conversation() { return { key: "live", channel: "c", root: "r", topLevel: false, where: "#live-test" }; },
  async turnPrompt(d, _c, o) { return { text: d.trigger.event.content, cursor: `c${(o?.cursor ?? "").length + 1}`, restore() {} }; },
  async reply(_a, _c, text) { replies.push(text); },
};
const saved = { url, vercelScope: process.env.EVE_SCOPE ?? "", approvals: "decline" };
console.log("args:", processArgs(config(saved)).join(" "));
const runtime = new EveRuntime(host, harness);
for (const content of [
  "Live plugin test. Reply with exactly: first-ok",
  "Second turn in the same session. Reply with exactly: second-ok",
]) {
  const d = {
    trigger: { type: "mention", event: { content } },
    agent: { key: "live-agent", name: "Eve" },
    config: saved,
    workingUntil(p) { d.done = p; },
    current: () => true,
  };
  const t0 = Date.now();
  await runtime.run(d);
  const result = await d.done;
  console.log(JSON.stringify(result), `${Date.now() - t0}ms`, "→", JSON.stringify(replies.at(-1)));
}
runtime.dispose();
