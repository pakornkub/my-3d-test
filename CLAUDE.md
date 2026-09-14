# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev            # Vite only (mock-driven scene). .claude/launch.json uses --port 5180 --strictPort
npm run office         # Office Server only, ws://localhost:5181/office
npm run dev:all        # both, Vite pinned to 5180 -- what vite.config.js's /office proxy assumes
npm test               # node --test "tests/**/*.test.js" (node's runner, no framework)
npm run build          # -> dist/
npm run deploy         # build + force-push dist/ to gh-pages
```

Single test file: `node --test tests/director.test.js`. Single case: `node --test --test-name-pattern "frontier"`.

Blender pipeline (order matters — step 1 exports an unrigged mesh and would throw away the armature):

```bash
blender -b --python blender/normalize_character.py -- --stage all   # scale / origin / facing
blender -b --python blender/rig_character.py                        # armature + Idle/Walk/Sit/SitIdle
```

Drive the server without a browser: `node scripts/office-client.mjs watch | add <path> | say "…" | answer <askId> "…" | allow <askId> yes | next spec | cancel`.

## Architecture

Three layers that meet at exactly two contracts. Respect the seams; most bugs come from crossing them.

**1. Blender → `export/`.** `vite.config.js` sets `publicDir: 'export'`, so the pipeline's output *is* the site root: `/ube_office.glb`, `/seats.json` (16 seats: position, facing, approach spot), `/obstacles.json` (58 boxes), `/characters/*.glb` + `characters.json`. Nothing is copied and the runtime places nothing by hand — it reads those files. Moving `export/` changes every URL the app fetches. Runtime fetches must go through `import.meta.env.BASE_URL` (`/` in dev, `/my-3d-test/` on Pages).

**2. The event stream (`src/agents/events.js`) — the only contract between the scene and whatever drives it.** Flat JSON, every event carries `v`/`t`/`type`, and the `SCHEMA` table is validated on *both* sides: the server refuses to emit a malformed event (`broadcast()` in `server/index.mjs`), the browser drops a malformed one (`src/agents/bridge.js`). A new event type starts by adding a row to `SCHEMA`, then a branch in `director.js`; a field renamed on one side fails loudly instead of silently doing nothing. `MockDriver` (`src/agents/mock.js`) and `Bridge` expose the same `{ start, stop, send }`, so `main.js` swaps them freely — the scene falls back to the mock when no server answers, which is what GitHub Pages runs.

**3. The Office Server (`server/`).** Node + the Claude Agent SDK behind one WebSocket. The browser never talks to Claude. See `server/README.md` for the runbook (auth, approvals, replay, worktree cleanup).

### Browser side (`src/`)

`main.js` wires everything; `scene.js` (renderer/cameras), `characters.js` + `character.js` (loading, clip playback, walk/turn/sit state machine), `crew.js` (selection, seat claims, body separation), `nav.js` (occupancy grid, A*, smoothing), `hotspots.js` (glTF node name → label/actions), `ui.js` (HUD).

`src/agents/director.js` is the interesting one: it turns each event into who walks where, what the bubble says and what the panel shows. It imports no three.js, so `tests/director.test.js` drives it against a fake crew. Everything physical goes through the injected `crew` / `bubbles` / `panel` / `places` — keep it that way.

`window.__ube` exposes the scene for the console: `__ube.crew.sendTo(5, -2)`, `__ube.emit('agent.say', {...})`, `__ube.step(60)` (hand-advances the simulation — the only way to test inside an embedded preview pane, which parks `requestAnimationFrame`).

### Server side (`server/`)

- `flow.mjs` — the manager's state machine `onboard → grill → spec → tickets → implement → done`. The manager is **one long-lived session across all phases** (grill, spec and tickets must share a context). The human drives phase changes; the *server* sends the slash commands, because those skills are `disable-model-invocation` and must arrive from the user side. `skill()` falls back to inlining the plugin's `SKILL.md` body when the CLI has not registered the command.
- `runner.mjs` — one SDK `query()` in streaming-input mode, turned into events (`tool_use` → `agent.tool`, text → `agent.say`, result → `session.cost`). `flow.mjs` never touches SDK types.
- `permissions.mjs` — `canUseTool` per role. Writes are fenced (manager: docs/`.scratch` only; reviewer: `.md`; QA: `.scratch`), Bash matches the repo's allowlist by prefix with chained commands split apart, anything else becomes an `agent.ask` on the scene. **No answer is a deny, never a silent allow.**
- `board.mjs` — `.scratch/<feature>/issues/NN-slug.md` parsed into the ticket board (`Status:`, `Blocked by:`, `Assignee:`, `- [ ]` criteria) and claims written back. The board is markdown on disk; there is no database.
- `onboard.mjs` — the 8-step checklist a repo passes before the manager takes ideas. AFK steps run here; steps 4–6 are handed to the manager session. Step 8 rehearses in a throwaway worktree (`.worktrees/onboard-rehearsal`).
- `state.mjs` → `server/state/<project>.json` (session id, phase, feature, today's running totals by session key — a live mirror of the log, not its source of truth) and `server/log/<project>-<day>.jsonl` (every event, replayable). Both gitignored, along with `server/projects.json`.

### Configuration that is really code

- **`docs/agents/office.md`** — per-repo commands, worktree ports, and policy (bash allowlist, verify level, budget, stall/turn limits). Re-read at the start of every job; `office.mjs` owns parse/render/defaults.
- **`team/<id>.md`** — agent definitions in Claude Code subagent frontmatter (`name, description, tools, model, skills`) + system prompt, converted to SDK `agents` by `team.mjs`. The same folder could be dropped into `.claude/agents/`. Only the manager is not a subagent.
- The crew ids are **one vocabulary everywhere** — `team/<id>.md`, `ROLE`/`HOME_SEAT` in `src/agents/team.js`, `CREW` in `main.js`, and the `agent` field on events. No mapping tables: `manager`, `eng_m1`/`eng_f1`/`eng_m2` (impl), `eng_f2` (review), `eng_m3` (QA).

## Agent skills

### Issue tracker

Issues and specs are local markdown under `.scratch/<feature>/` — the same folder `server/board.mjs` renders as the ticket board. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, unchanged, written as the `Status:` line of a ticket file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root (neither exists yet; `/domain-modeling` creates them lazily). See `docs/agents/domain.md`.

## Things that bite

- **glTF node names are not Blender names.** `GLTFLoader` strips dots: `Picture.001` → `Picture001`. `hotspots.js` uses the loaded spelling. Some nodes (e.g. `TV`) wrap children, so a raycast hit is walked up to the child of the loaded scene.
- **Four of the sixteen `approach` points in `seats.json` are inside furniture** (the generator used `seat − forward × 0.75` even into walls). `NavGrid.repairApproaches()` re-derives them at load and logs what it changed — fix the generator, not the runtime, if you regenerate.
- **The sit contract:** the `Sit` clip ends with hips at `sit_hip_y` (per character in `characters.json`), and the runtime places the root at `seat.y − sit_hip_y`. One clip serves all 16 seats because a chibi's feet dangle.
- **Nav grid cell is 0.10 m, not 0.20.** At 0.20 the quantisation walls off the manager's alcove, whose tightest legal spot has 0.30 m clearance.
- **Bodies do not path around each other** — the A* grid is static; a separation pass pushes overlapping people apart afterwards.
- **Stack is deliberately thin:** `three` + `vite` in the browser, `ws` + `@anthropic-ai/claude-agent-sdk` on the server. The pathfinder is ~80 lines rather than a dependency.

Pipeline details and how to add the rest of the cast: [CHARACTERS.md](CHARACTERS.md). Server runbook: [server/README.md](server/README.md).
