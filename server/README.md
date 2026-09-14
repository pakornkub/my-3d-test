# Office Server

The Node process that runs the Claude agent team behind the 3D office. The browser never
talks to Claude; it talks to this server over one WebSocket, and this server runs the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).

```
npm run office          # server only, ws://localhost:5181/office
npm run dev:all         # server + Vite dev server together
```

Auth: the SDK uses `ANTHROPIC_API_KEY` if set, otherwise the credentials of the Claude Code
you are logged into on this machine. The `[manager] session … key=…` line at startup says
which one it picked.

## What is where

| file | job |
| --- | --- |
| `index.mjs` | WebSocket server, message dispatch, snapshot on connect |
| `projects.mjs` / `projects.json` | registry of repos (gitignored, machine-local) |
| `onboard.mjs` | the 8-step checklist a repo passes before the manager takes ideas |
| `office.mjs` | reads/writes `docs/agents/office.md` inside the repo (commands, allowlist, verify level, budget) |
| `flow.mjs` | the manager's state machine: onboard → grill → spec → tickets → implement → done |
| `runner.mjs` | one SDK session; SDK messages → scene events |
| `permissions.mjs` | `canUseTool` per role; anything outside the allowlist asks the human |
| `board.mjs` | `.scratch/<feature>/issues/*.md` → ticket board |
| `team.mjs` + `../team/*.md` | agent definitions (Claude Code subagent frontmatter) |
| `state.mjs` | `state/<project>.json` (session id, phase, feature) and `log/*.jsonl` |

## Runbook

**Start.** `npm run dev:all`, open http://localhost:5180, press **ทีม**. The mode badge
says `เชื่อมต่อ server` when the WebSocket is up; otherwise the scene runs the mock.

**Register a repo.** Panel → โปรเจกต์ → path or clone URL → เพิ่ม. Onboarding runs
automatically; steps 4–6 have a "ให้ผู้จัดการทำ" button that hands them to the manager
(`/init`, `/mattpocock-skills:setup-matt-pocock-skills`, `/wizard`).

**Talk.** Chat tab. A new message while idle starts `/grill-with-docs`. The "→" button
advances the phase (`/to-spec`, `/to-tickets`). Slash commands come from the server, not
the model: those skills are `disable-model-invocation`.

**From a terminal** (no browser): `node scripts/office-client.mjs watch | add <path> | say "…" |
answer <askId> "…" | allow <askId> yes | next spec | recheck 8 | cancel`.

**Stop a runaway turn.** "หยุดผู้จัดการ" in the chat tab, or `office-client cancel`; it calls
`interrupt()` on the session. Ctrl+C on the server closes every session cleanly.

**Resume after a restart.** State is on disk; the manager session id is reused (`resume`).
If the SDK refuses the id (session pruned), delete `state/<project>.json` to start fresh.

**Logs.** `log/<project>-<day>.jsonl` is every event the scene saw; replay it in the browser
with `__ube.mock.start(replayScript(events))` from `src/agents/mock.js`.

**Approvals never time out into "allow".** An unanswered `agent.ask` is denied after 10
minutes; the agent gets the denial message and continues.

**Worktrees.** The rehearsal step creates and removes `.worktrees/onboard-rehearsal`. If a
crash leaves it behind: `git worktree remove --force .worktrees/onboard-rehearsal && git worktree prune`.

**Costs.** `session.cost` events carry the SDK's running total; the panel shows it next to the
mode badge. `daily-budget-usd` in `docs/agents/office.md` becomes `maxBudgetUsd` on every session.
