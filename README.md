# Eve for Buzz

A [Buzz](https://buzz.xyz) desktop plugin (Buzz 1.x, plugin API v1) that adds
the agent type **Eve**. An agent of this type is an
[eve](https://github.com/vercel/eve) agent that you run somewhere, such as on
Vercel, on another server or on your own computer. Buzz reaches it through
`eve acp --url <url>`, which speaks ACP v1 over stdio. Mention the agent in a
Buzz conversation and the plugin hands the conversation to your eve agent. It
then posts the answer as the agent.

## How it works

- Each Eve agent in Buzz has one `eve acp` process on your computer. That
  process holds one eve session per conversation (thread or channel).
- eve's ACP mode does not accept client tools ("Client-provided MCP servers
  are not supported by eve ACP mode"), so your eve agent cannot call the Buzz
  tools. Instead it answers with its own tools and connections, and the plugin
  posts its final message.
- A new session's first message starts with a short header from the plugin:
  the agent's name, the conversation, "your final message is the reply" and
  your instructions. The plugin sends nothing from the agent's Buzz memory.
- eve has no `session/load`. When the process stops (after 30 idle minutes, a
  crash, an app restart or a settings change), the next turn opens a new
  session, and Buzz shows it the conversation so far.

## Behaviour

- **Who can start a turn:** only your own mentions, or mentions you attested.
  Buzz's harness kit makes this check. Watches, timers, Attention wakes and
  other plugins' wakes are ignored, because the agent acts with whatever
  accounts your eve server gives it.
- **Tool approvals** (setting). When eve asks before using a tool, such as
  sending an email or writing to a connected app, the plugin either
  **declines** (the default) or **approves automatically**. Either way the
  reply ends with a line naming what was approved or declined. Nothing is
  approved after Stop. eve's form questions are not offered, so a turn that
  needs one fails and is reported.
- Turns in one conversation run one at a time. Stop cancels the running turn.
  Starting `eve acp` and opening a session each have a 60-second deadline, and a
  prompt has 20 minutes. A missed deadline or a failed handshake replaces the
  process.
- After an app reload you can resume a working mention. It runs in a new
  session that is shown the conversation.
- **Failures** are posted in the conversation and tag you. A post uses only
  the plugin's own words and a reference; eve's error text goes to the Buzz app
  log under that reference.

## Requirements

- Buzz desktop 1.x. Developed and checked against 1.0.6.
- The `eve` CLI on your `PATH`, so that `eve acp --help` works:
  `npm i -g eve`. Checked with eve 1.0.0 and 1.3.0.
- An eve agent reachable over HTTPS (or `http://localhost` for local
  development), and a way for `eve acp` to authenticate to it:
  - **Vercel:** log in with the Vercel CLI (`vercel login`) as a member of the
    team that owns the deployment, and set **Vercel team** in the agent's
    settings. Which identity your eve agent gives that login, and therefore
    which memory and connections the Buzz agent gets, depends on your eve
    agent's auth configuration.
  - **A token:** set **Request header**, for example
    `Authorization: Bearer …`. It is passed to `eve acp` as a command-line
    argument, so other processes run by your user on this computer can see it.

## Install

1. Install the eve CLI: `npm i -g eve`.
2. In Buzz: **Settings → Plugins → Manage plugins → Add**. Add it from this
   Git repository, or open
   `buzz://plugin-install?repository=https%3A%2F%2Fgithub.com%2Fcarlomanuali%2Fbuzz-plugin-eve.git&path=plugin`.
   Review the host access: one process, `eve acp`.
3. Create an agent of type **Eve** and set its **Eve URL** (plus Vercel team
   or header if needed).
4. Mention it in a conversation.

## Settings

| Setting | Effect |
| --- | --- |
| Eve URL | The eve server, HTTPS, or HTTP only to `localhost`. Required. |
| Vercel team | Passed as `--scope`, for a Vercel deployment. |
| Request header | One `Name: value` line, passed as `--header`. |
| Tool approvals | Decline (default) or approve automatically. |
| Instructions | Added at the start of each new session. |
| Sessions | One session per thread, or one per channel. |

A changed URL, team or header restarts the agent's `eve acp` process. The
other settings apply to new sessions. Settings stay on this computer and do
not sync between devices.

## Security notes

- The plugin is trusted code inside Buzz. Its only host grant is starting
  `eve acp`. The URL, team and header from the agent's settings are appended
  as arguments, and values that could read as other options are refused.
- With approvals on, eve can act on whatever accounts your eve server holds,
  whenever you mention the agent. That includes being steered by text it
  reads, such as earlier messages in the thread or content from connected
  apps. Leave approvals off unless the agent is yours alone and you accept
  that.

## Development

```sh
npm run check   # node --check, then node --test against a stand-in eve (test/stub-eve.mjs)
EVE_BIN=$(npm root -g)/eve/bin/eve.js EVE_URL=https://… [EVE_SCOPE=team] npm run live
```

There are no dependencies. `plugin/` is the installable folder:
`manifest.json` and one self-contained `plugin.js`, with no imports and no
build step. The design follows the ACP agent-type approach of
`sagmans/buzz-plugin-hermes` (Apache-2.0); no code is taken from it.

## License

Apache-2.0. See [LICENSE](LICENSE).
