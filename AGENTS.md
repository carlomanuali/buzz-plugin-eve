# AGENTS.md

- `plugin/plugin.js` must stay one ES module with no imports and no work at top
  level (Buzz plugin API v1). React comes from `ctx.react`.
- The manifest host grant is security-relevant. Exactly one process is
  allowed: `eve` with the fixed argument `acp`, pinned by
  `test/plugin.test.mjs`. Settings only append `--url`, `--scope` and
  `--header`, after validation. A change to the grant or to argument handling
  needs a reason in the commit body.
- Do not change the manifest `id` (`carlomanuali.eve`) or the type id (`eve`).
  Saved agents match on them.
- Run `npm run check` before every commit, and keep README.md in step with the
  behaviour.
