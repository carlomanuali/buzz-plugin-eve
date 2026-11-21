// node --test test/ — the plugin against a stand-in eve and a fake host.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  apply,
  config,
  configProblem,
  processArgs,
  EveRuntime,
  inject,
  TurnText,
} from "../plugin/plugin.js";

const STUB = fileURLToPath(new URL("./stub-eve.mjs", import.meta.url));

function fakeHost(modes = []) {
  const host = {
    spawned: 0,
    children: [],
    stderr: "",
    args: [],
    fail: false,
    async spawn(id, options = {}) {
      assert.equal(id, "eve");
      host.args.push(options.args);
      if (host.fail) throw new Error("Could not start eve: No such file or directory (os error 2) /secret/path");
      const env = { ...process.env, ...(modes[host.spawned] ?? {}) };
      host.spawned += 1;
      const child = spawn(process.execPath, [STUB], { stdio: ["pipe", "pipe", "pipe"], env });
      child.stderr.on("data", (data) => {
        host.stderr += data;
      });
      host.children.push(child);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data) => options.onStdout?.(data));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data) => options.onStderr?.(data));
      const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
      return {
        write: (data) =>
          new Promise((resolve, reject) =>
            child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
          ),
        end: async () => child.stdin.end(),
        kill: async () => {
          child.kill();
          await exited;
        },
        exited,
      };
    },
  };
  return host;
}

function fakeHarness() {
  const harness = {
    replies: [],
    cursors: [],
    restored: 0,
    async conversation(delivery, scope) {
      if (delivery.trigger.event?.pubkey === "stranger") return undefined;
      const root = delivery.root ?? "r1";
      return {
        key: scope === "channel" ? "c1" : `c1/${root}`,
        channel: "c1",
        root,
        topLevel: false,
        where: "#eve",
      };
    },
    systemPromptCalls: 0,
    // The kit's prompt carries the agent's core memory; the plugin must not
    // send it to remote Eve.
    async systemPrompt() {
      harness.systemPromptCalls += 1;
      return "SYSTEM CORE-MEMORY-MARKER-7f3a";
    },
    gate: undefined,
    async turnPrompt(delivery, _conversation, options) {
      harness.cursors.push(options?.cursor);
      if (harness.gate) await harness.gate;
      return {
        text: delivery.trigger.event.content,
        cursor: `cursor-${harness.cursors.length}`,
        restore: () => {
          harness.restored += 1;
        },
      };
    },
    async reply(_agent, conversation, text, options = {}) {
      harness.replies.push({ conversation: conversation.key, text, ...options });
    },
  };
  return harness;
}

function delivery(content, extra = {}) {
  const d = {
    trigger: { type: "mention", event: { content, pubkey: "owner" } },
    agent: { key: "agent-1" },
    config: { url: "https://eve.example", instructions: "be brief", approvals: "approve" },
    acknowledged() {
      d.acked = true;
    },
    accepted() {
      d.handed = true;
    },
    ignored() {
      d.wasIgnored = true;
    },
    workingUntil(done) {
      d.done = done;
    },
    interruptible(stop) {
      d.stop = stop;
    },
    current: () => true,
    ...extra,
  };
  if (extra.event) d.trigger = { type: "mention", event: extra.event };
  return d;
}

async function setup(modes, limits) {
  const host = fakeHost(modes);
  const harness = fakeHarness();
  const runtime = new EveRuntime(host, harness, limits);
  return { host, harness, runtime };
}

test("first turn heads the prompt with the system prompt; the next reuses the session", async (t) => {
  const { host, harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const first = delivery("hello");
  await runtime.run(first);
  assert.deepEqual(await first.done, { ok: true });
  assert.ok(first.acked && first.handed);
  assert.equal(harness.replies.length, 1);
  assert.equal(harness.replies[0].text, "prompts=1 system=true last=hello");
  assert.equal(harness.replies[0].conversation, "c1/r1");

  const second = delivery("again");
  await runtime.run(second);
  assert.deepEqual(await second.done, { ok: true });
  assert.equal(harness.replies[1].text, "prompts=2 system=false last=again");
  assert.deepEqual(harness.cursors, [undefined, "cursor-1"]);
  assert.equal(host.spawned, 1);
});

test("another thread gets its own session in the same process", async (t) => {
  const { host, harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const a = delivery("one", { root: "r1" });
  const b = delivery("two", { root: "r2" });
  await runtime.run(a);
  await runtime.run(b);
  await Promise.all([a.done, b.done]);
  assert.equal(host.spawned, 1);
  const texts = harness.replies.map((r) => `${r.conversation}:${r.text}`).sort();
  assert.deepEqual(texts, [
    "c1/r1:prompts=1 system=true last=one",
    "c1/r2:prompts=1 system=true last=two",
  ]);
});

test("a mention the kit does not admit is ignored and starts nothing", async (t) => {
  const { host, harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const d = delivery("hi", { event: { content: "hi", pubkey: "stranger" } });
  await runtime.run(d);
  assert.equal(d.wasIgnored, true);
  assert.equal(d.done, undefined);
  assert.equal(host.spawned, 0);
  assert.equal(harness.replies.length, 0);
});

test("only mentions start a turn: watches, timers, attention and plugin wakes are ignored", async (t) => {
  const { host, harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  // Buzz 1.0.6 runner.ts conversationWake rewrites a channel-addressed watch
  // or timer into this shape before calling run.
  const attention = { type: "attention", channel: "c1", root: "r1", text: "watch fired", id: "w1", at: 1 };
  const pluginWake = { type: "plugin", plugin: "x.y", channel: "c1", text: "hi", id: "p1", at: 1 };
  for (const trigger of [{ type: "timer" }, { type: "watch" }, attention, pluginWake]) {
    const d = delivery("x");
    d.trigger = trigger;
    await runtime.run(d);
    assert.equal(d.wasIgnored, true, trigger.type);
    assert.equal(d.done, undefined);
  }
  assert.equal(host.spawned, 0);
  assert.equal(harness.replies.length, 0);
});

test("eve's approval requests are approved and listed under the reply", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const d = delivery("PERMISSION please");
  await runtime.run(d);
  assert.deepEqual(await d.done, { ok: true });
  assert.equal(
    harness.replies[0].text,
    "permission:i:approve\n\n_Approved for Eve: “Send email”_",
  );
});

test("Stop after an approved action still says what was approved", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const d = delivery("PERMISSION THEN_WAIT");
  await runtime.run(d);
  while (!d.handed) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 100));
  await d.stop();
  assert.deepEqual(await d.done, { ok: true, stopped: true });
  assert.equal(harness.replies[0].text, "_Stopped._\n\n_Approved for Eve: “Send email”_");
});

test("an approval request that arrives after Stop is cancelled, not approved", async (t) => {
  const { host, harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const d = delivery("ASK_AFTER_CANCEL");
  await runtime.run(d);
  while (!d.handed) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  await d.stop();
  assert.deepEqual(await d.done, { ok: true, stopped: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.match(host.stderr, /late-permission \{"outcome":"cancelled"\}/);
  assert.equal(harness.replies.length, 0);
});

test("an approval request after the delivery stops being current is cancelled", () => {
  let current = true;
  const text = new TurnText(() => current, "approve");
  const params = { toolCall: { title: "x" }, options: [{ kind: "allow_once", optionId: "a" }] };
  assert.deepEqual(text.permission(params), { outcome: "selected", optionId: "a" });
  current = false;
  assert.deepEqual(text.permission(params), { outcome: "cancelled" });
  assert.equal(text.footer(), "_Approved for Eve: “x”_");
});

test("text around a tool call becomes two paragraphs", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const d = delivery("TOOL");
  await runtime.run(d);
  await d.done;
  assert.equal(harness.replies[0].text, "before\n\nafter");
});

test("Stop cancels the eve turn and posts nothing", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const d = delivery("SLOW");
  await runtime.run(d);
  // Wait until the prompt is with eve.
  while (!d.handed) await new Promise((r) => setTimeout(r, 10));
  await d.stop();
  assert.deepEqual(await d.done, { ok: true, stopped: true });
  assert.equal(harness.replies.length, 0);
});

test("a crashed process is reported to the owner and the next turn starts over", async (t) => {
  const { host, harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const warm = delivery("warm");
  await runtime.run(warm);
  await warm.done;
  const crash = delivery("CRASH");
  await runtime.run(crash);
  const result = await crash.done;
  assert.equal(result.ok, false);
  assert.match(result.error, /^The connection to Eve stopped\. \(ref [0-9a-f]{8}; details in the Buzz app log\)$/);
  const report = harness.replies.at(-1);
  assert.equal(report.notifyOwner, true);
  assert.equal(report.text, result.error);

  const after = delivery("back");
  await runtime.run(after);
  assert.deepEqual(await after.done, { ok: true });
  assert.equal(host.spawned, 2);
  // A new session, shown the conversation again with the system prompt.
  assert.equal(harness.replies.at(-1).text, "prompts=1 system=true last=back");
  assert.equal(harness.cursors.at(-1), undefined);
});

test("an empty end_turn says so instead of staying silent", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const d = delivery("EMPTY");
  await runtime.run(d);
  assert.deepEqual(await d.done, { ok: true });
  assert.equal(harness.replies[0].text, "_Eve finished without a reply._");
});

test("Stop while eve acp hangs at start settles the turn; the next turn times out and respawns", async (t) => {
  const { host, harness, runtime } = await setup(
    [{ STUB_INIT: "hang" }, {}],
    { startMs: 300 },
  );
  t.after(() => runtime.dispose());
  const stuck = delivery("one");
  await runtime.run(stuck);
  await new Promise((r) => setTimeout(r, 50));
  await stuck.stop();
  assert.deepEqual(await stuck.done, { ok: true, stopped: true });
  assert.equal(stuck.handed, undefined);

  // Still the hung process: this turn's own deadline kills it.
  const timedOut = delivery("two");
  await runtime.run(timedOut);
  const result = await timedOut.done;
  assert.equal(result.ok, false);
  assert.match(result.error, /^Eve did not respond \(start\)\. \(ref /);

  const fine = delivery("three");
  await runtime.run(fine);
  assert.deepEqual(await fine.done, { ok: true });
  assert.equal(host.spawned, 2);
  assert.equal(harness.replies.at(-1).text, "prompts=1 system=true last=three");
});

test("a failed handshake retires the process at once", async (t) => {
  const { host, harness, runtime } = await setup([{ STUB_INIT: "badversion" }, {}]);
  t.after(() => runtime.dispose());
  const bad = delivery("one");
  await runtime.run(bad);
  const result = await bad.done;
  assert.equal(result.ok, false);
  assert.match(harness.replies.at(-1).text, /^Eve could not answer\. \(ref /);
  const next = delivery("two");
  await runtime.run(next);
  assert.deepEqual(await next.done, { ok: true });
  assert.equal(host.spawned, 2);
});

test("a hung session/new times out and the process is replaced", async (t) => {
  const { host, runtime } = await setup([{ STUB_NEW: "hang" }, {}], { startMs: 300 });
  t.after(() => runtime.dispose());
  const d = delivery("one");
  await runtime.run(d);
  const result = await d.done;
  assert.match(result.error, /^Eve did not respond \(new session\)\./);
  const next = delivery("two");
  await runtime.run(next);
  assert.deepEqual(await next.done, { ok: true });
  assert.equal(host.spawned, 2);
});

test("Stop before the first prompt reaches eve drops the session and restores notes", async (t) => {
  const { host, harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  let open;
  harness.gate = new Promise((r) => {
    open = r;
  });
  const first = delivery("first");
  await runtime.run(first);
  while (harness.cursors.length === 0) await new Promise((r) => setTimeout(r, 10));
  const stopping = first.stop();
  open();
  harness.gate = undefined;
  await stopping;
  assert.deepEqual(await first.done, { ok: true, stopped: true });
  assert.equal(harness.restored, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.match(host.stderr, /closed s1-/);

  // The next turn is a new session that gets the Buzz head.
  const second = delivery("second");
  await runtime.run(second);
  assert.deepEqual(await second.done, { ok: true });
  assert.equal(harness.replies.at(-1).text, "prompts=1 system=true last=second");
  assert.equal(harness.cursors.at(-1), undefined);
});

test("a turnPrompt failure on a new session drops it", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const turnPrompt = harness.turnPrompt;
  harness.turnPrompt = async () => {
    throw new Error("read failed");
  };
  const bad = delivery("bad");
  await runtime.run(bad);
  assert.equal((await bad.done).ok, false);
  harness.turnPrompt = turnPrompt;
  const good = delivery("good");
  await runtime.run(good);
  await good.done;
  assert.equal(harness.replies.at(-1).text, "prompts=1 system=true last=good");
});

test("a failed prompt gives back the notes it took", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const d = delivery("ERROR");
  await runtime.run(d);
  await d.done;
  assert.equal(harness.restored, 1);
});

test("turns in one conversation run one after another", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const a = delivery("first");
  const b = delivery("second");
  await runtime.run(a);
  await runtime.run(b);
  await Promise.all([a.done, b.done]);
  assert.deepEqual(
    harness.replies.map((r) => r.text),
    ["prompts=1 system=true last=first", "prompts=2 system=false last=second"],
  );
});

test("a turn stopped while queued never reaches eve", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const slow = delivery("SLOW");
  const queued = delivery("queued");
  await runtime.run(slow);
  await runtime.run(queued);
  await queued.stop();
  while (!slow.handed) await new Promise((r) => setTimeout(r, 10));
  await slow.stop();
  assert.deepEqual(await queued.done, { ok: true, stopped: true });
  assert.equal(queued.handed, undefined);
  assert.equal(harness.replies.length, 0);
});

test("the first prompt carries no Buzz core memory, only the plugin's own head", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const d = delivery("ECHOALL trigger-text-91");
  d.agent = { key: "agent-1", name: "Eve Hall" };
  await runtime.run(d);
  assert.deepEqual(await d.done, { ok: true });
  const sent = harness.replies[0].text;
  assert.equal(harness.systemPromptCalls, 0);
  assert.doesNotMatch(sent, /CORE-MEMORY-MARKER/);
  assert.match(sent, /trigger-text-91/);
  assert.match(sent, /^<buzz-context>\nYou are Eve Hall, answering in Buzz, a team chat app, in #eve\./);
  assert.match(sent, /<owner-instructions>\nbe brief\n<\/owner-instructions>/);
});

test("Eve's error text stays out of the conversation", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const logged = [];
  const warn = console.warn;
  console.warn = (...args) => logged.push(args.join(" "));
  t.after(() => {
    console.warn = warn;
  });
  const d = delivery("ERROR");
  await runtime.run(d);
  const result = await d.done;
  assert.equal(result.ok, false);
  const report = harness.replies.at(-1);
  assert.match(report.text, /^Eve could not answer\. \(ref ([0-9a-f]{8}); details in the Buzz app log\)$/);
  assert.doesNotMatch(report.text, /PRIVATE-DIAGNOSTIC|upstream/);
  const ref = report.text.match(/ref ([0-9a-f]{8})/)[1];
  assert.ok(logged.some((line) => line.includes(ref) && line.includes("PRIVATE-DIAGNOSTIC")));
});

test("a stop reason without text is reported in the plugin's words", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const d = delivery("MAXTOKENS");
  await runtime.run(d);
  await d.done;
  assert.match(harness.replies.at(-1).text, /^Eve stopped without an answer \(max_tokens\)\. \(ref /);
});

test("config reads any saved shape", () => {
  const empty = { url: "", vercelScope: "", approvals: "decline", instructions: "", scope: "thread" };
  assert.deepEqual(config(undefined), empty);
  assert.deepEqual(config({ instructions: 3, scope: "community", approvals: "yes", url: 5 }), empty);
  assert.deepEqual(
    config({ url: " https://a.example ", vercelScope: " team_1 ", header: " X-Key: v ", approvals: "approve", instructions: "x", scope: "channel" }),
    { url: "https://a.example", vercelScope: "team_1", approvals: "approve", instructions: "x", scope: "channel" },
  );
});

test("configProblem accepts HTTPS and local HTTP only, and checks the team", () => {
  const ok = (over) => configProblem(config({ url: "https://a.example", ...over }));
  assert.equal(ok({}), "");
  assert.equal(ok({ url: "http://localhost:3000" }), "");
  assert.equal(ok({ url: "http://127.0.0.1:8000" }), "");
  assert.match(ok({ url: "" }), /Set the eve agent's URL/);
  assert.match(ok({ url: "http://a.example" }), /Set the eve agent's URL/);
  assert.match(ok({ url: "https://user:pw@a.example" }), /Set the eve agent's URL/);
  assert.match(ok({ url: "file:///etc/passwd" }), /Set the eve agent's URL/);
  assert.equal(ok({ vercelScope: "team_abc-1" }), "");
  assert.match(ok({ vercelScope: "a b" }), /Vercel team/);
  assert.match(ok({ vercelScope: "--header" }), /Vercel team/);
});

test("processArgs passes only URL and team after the manifest's acp", () => {
  assert.deepEqual(processArgs(config({ url: "https://a.example" })), ["--url", "https://a.example"]);
  assert.deepEqual(processArgs(config({ url: "https://a.example", vercelScope: "t" })), [
    "--url", "https://a.example", "--scope", "t",
  ]);
});

test("a turn without a usable URL says how to set it up and starts nothing", async (t) => {
  const { host, harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const d = delivery("hi");
  d.config = {};
  await runtime.run(d);
  const result = await d.done;
  assert.equal(result.ok, false);
  assert.match(harness.replies[0].text, /^Set the eve agent's URL \(https:\/\/…\) in this agent's Settings\. \(ref /);
  assert.equal(host.spawned, 0);
});

test("the eve process gets the URL and team, and never a saved credential", async (t) => {
  const { host, runtime } = await setup();
  t.after(() => runtime.dispose());
  // An older build or a hand-edited config may hold a header; it must not
  // reach argv, nor follow the agent to another URL.
  const token = "SYNTHETIC-TOKEN-4d1c";
  const first = delivery("one");
  first.config = { url: "https://a.example", vercelScope: "team_x", header: `Authorization: Bearer ${token}` };
  await runtime.run(first);
  assert.deepEqual(await first.done, { ok: true });
  const second = delivery("two");
  second.config = { url: "https://b.example", header: `Authorization: Bearer ${token}` };
  await runtime.run(second);
  assert.deepEqual(await second.done, { ok: true });
  assert.deepEqual(host.args, [
    ["--url", "https://a.example", "--scope", "team_x"],
    ["--url", "https://b.example"],
  ]);
  assert.doesNotMatch(JSON.stringify(host.args), new RegExp(token));
});

test("Settings saves only this type's fields, dropping a stale header", async () => {
  let registered;
  const states = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (v) => {
      states.push(v);
      return [v, () => {}];
    },
    useEffect: () => {},
  };
  apply({
    react: React,
    reflect: { get: () => undefined },
    effect: () => {},
    host: fakeHost(),
    agents: { harness: fakeHarness(), register: (type) => (registered = type) },
  });
  const Settings = registered.tabs[0].component;
  let saved;
  const agent = { config: { url: "https://a.example", header: "Authorization: Bearer SYNTHETIC", approvals: "approve" } };
  const form = Settings({ agent, save: async (value) => (saved = value) });
  await form.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saved, { url: "https://a.example", vercelScope: "", approvals: "approve", instructions: "", scope: "thread" });
  assert.doesNotMatch(JSON.stringify(saved), /SYNTHETIC/);
});

test("a changed URL replaces the process and its sessions", async (t) => {
  const { host, harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const a = delivery("one");
  await runtime.run(a);
  await a.done;
  const b = delivery("two");
  b.config = { url: "https://other.example" };
  await runtime.run(b);
  assert.deepEqual(await b.done, { ok: true });
  assert.equal(host.spawned, 2);
  assert.equal(harness.replies.at(-1).text, "prompts=1 system=true last=two");
});

test("a missing eve CLI is reported with the install hint, without the host's error text", async (t) => {
  const { host, harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  host.fail = true;
  const d = delivery("hi");
  await runtime.run(d);
  assert.equal((await d.done).ok, false);
  assert.match(harness.replies[0].text, /^Could not start the `eve` CLI\. Install it \(`npm i -g eve`\)/);
  assert.doesNotMatch(harness.replies[0].text, /secret/);
});

test("with approvals off, eve's requests are declined and named", async (t) => {
  const { harness, runtime } = await setup();
  t.after(() => runtime.dispose());
  const d = delivery("PERMISSION please");
  d.config = { url: "https://eve.example" };
  await runtime.run(d);
  assert.deepEqual(await d.done, { ok: true });
  assert.equal(
    harness.replies[0].text,
    "permission:i:deny\n\n_Declined: “Send email”. Tool approvals are off in this agent's Settings._",
  );
});

test("TurnText cuts very long replies", () => {
  const text = new TurnText();
  text.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a".repeat(70_000) } });
  assert.ok(text.text().length < 61_000);
  assert.match(text.text(), /reply cut at 60000 characters/);
});

test("apply registers the Eve type with the plugin contract's pieces", async () => {
  assert.deepEqual(inject, ["react", "agents", "host"]);
  let registered;
  const cleanups = [];
  apply({
    react: { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => cleanups.push(fn()),
    host: fakeHost(),
    agents: { harness: fakeHarness(), register: (type) => (registered = type) },
  });
  assert.equal(registered.id, "eve");
  assert.equal(registered.title, "Eve");
  assert.deepEqual(registered.defaults(), {
    config: { url: "", vercelScope: "", approvals: "decline", instructions: "", scope: "thread" },
  });
  assert.equal(registered.summary({ config: { url: "https://a.example/x" } }), "a.example");
  assert.equal(registered.summary({ config: {} }), "eve · not set up");
  assert.deepEqual(registered.carry({ instructions: "hi", scope: "channel" }), {
    instructions: "hi",
    sessionScope: "channel",
  });
  assert.deepEqual(registered.adopt({ instructions: "old" }, registered.defaults().config), {
    url: "", vercelScope: "", approvals: "decline", instructions: "old", scope: "thread",
  });
  assert.equal(typeof registered.run, "function");
  assert.equal(registered.resumes, true);
  assert.ok(registered.timeoutMs <= 30 * 60_000);
  for (const cleanup of cleanups) cleanup?.();
});

test("apply does nothing without process support", () => {
  let registered = false;
  apply({
    react: {},
    reflect: { get: () => undefined },
    effect: () => {},
    host: {},
    agents: { harness: {}, register: () => (registered = true) },
  });
  assert.equal(registered, false);
});

test("manifest grants exactly the one eve process", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../plugin/manifest.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest).sort(), [
    "apiVersion", "description", "discovery", "host", "id", "name",
  ]);
  assert.match(manifest.id, /^[a-z][a-z0-9.-]*$/);
  assert.deepEqual(Object.keys(manifest.host), ["processes"]);
  assert.deepEqual(manifest.host.processes, [
    { id: "eve", program: "eve", args: ["acp"] },
  ]);
  assert.ok(Buffer.byteLength(manifest.description) <= 280);
});

test("plugin.js has no imports and no top-level work", async () => {
  const source = await readFile(new URL("../plugin/plugin.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\brequire\s*\(/);
});
