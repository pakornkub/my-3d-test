# Verify: 03 — Today's totals survive a server restart

## Criterion 1 — `npm test` + new server.test.js cases — PASS

Ran `npm test` from the worktree root. Full output: `01-npm-test.txt`.

```
# tests 46
# pass 46
# fail 0
```

Confirmed the four required cases exist in `tests/server.test.js` (not just director.test.js):

```
tests/server.test.js:100: daySeed keys by session id, not by agent: two sessions of one agent stay separate
tests/server.test.js:111: daySeed keeps the latest running total per session key, not a sum
tests/server.test.js:120: daySeed skips malformed entries instead of throwing
tests/server.test.js:135: daySeed of an empty log is an empty map
```

These map onto the four required cases: two sessions of one agent, repeated running totals for
one session (replacement not sum), malformed lines, empty log. All pass.

## Criteria 2, 3, 4, 5, 6 — SKIP (shared Office Server blocker)

These criteria all require a *live* Office Server actually running this worktree's diff:

- Criterion 2/3: `npm run dev:all` → Ctrl+C → restart → figure persists/grows from restored value.
- Criterion 4: browser reload without server restart leaves the figure unchanged.
- Criterion 5: `server/state/<project>.json` gets a per-member map after a turn; a legacy
  single-`costUsd` file still loads.
- Criterion 6: delete today's log, restart, day starts at zero.

Checked the actual server state before attempting anything:

```
$ netstat -ano | grep -E ":5181|:5180|:3101"
TCP    0.0.0.0:5181   LISTENING   6052   <- shared Office Server, active client connections
TCP    [::1]:3101     LISTENING   1968   <- this worktree's Vite dev server (page under test)
```

Port 5181 is already bound by the shared Office Server (pid 6052) with live client sockets
attached — that is the main-branch instance the task brief says not to stop or disturb.

`vite.config.js`'s `/office` proxy target is a hardcoded literal:

```js
proxy: { '/office': { target: 'ws://localhost:5181', ws: true, rewriteWsOrigin: true } },
```

and `npm run dev:all` (`scripts/dev-all.mjs`) always launches the Office Server via
`npm run office`, which binds `PORT = process.env.OFFICE_PORT ?? 5181` — no port argument is
passed, so it targets 5181 too.

Consequences:
- Running `npm run dev:all` (or `npm run office`) in this worktree would try to bind 5181, which
  is already held by the shared server — it would either fail outright or require killing the
  shared server first (forbidden).
- Even if it were run on an alternate `OFFICE_PORT`, the browser's `/office` proxy still points at
  the hardcoded 5181 target, so the page would keep talking to the shared main-branch server, not
  this diff. Fixing that requires editing `vite.config.js`, which is a project file outside
  `.scratch` (forbidden for testing purposes).

Confirmed (read-only, via `git diff main -- server/index.mjs`) that the behavior these criteria
exercise is new in this diff and not present on the branch the shared server is running:
- `activate()` now seeds `st.runningTotals` via `costs.daySeed(state.readLog(p.id))` at boot
  (criteria 2, 3, 6 depend on this).
- `broadcast()` now folds `session.cost` into `st.runningTotals` via `costs.recordCost` and saves
  state on every cost event (criteria 2, 3, 5 depend on this).
- On connection, `st.runningTotals` entries are now unicast to the new client as replayed
  `session.cost` events — new snapshot behavior criterion 4 depends on.

None of this exists on the shared server's running code, and there is no way to exercise it
without either stopping/replacing the shared server or editing a project file outside `.scratch`.
Per the task brief, both are out of bounds, so these five criteria are answered `skip`, not `fail`.

The state-file legacy-load half of criterion 5 was also considered on its own (calling
`server/state.mjs`'s `load()` against a hand-written legacy JSON fixture without going through a
live server). This still requires writing a file into `server/state/` — outside `.scratch` — so it
is skipped for the same file-boundary reason, not attempted.
