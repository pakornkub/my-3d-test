# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

GitHub Issues is not used for the working queue: the Office Server (`server/board.mjs`) reads
this folder directly and the ticket board in the 3D scene is a rendering of it. Anything filed
on GitHub has to be copied into `.scratch/` before the team can pick it up.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## What the Office Server reads out of a ticket

`server/board.mjs` parses each issue file into the board the scene draws, so these lines are a
contract, not decoration:

| Line | Used for |
| --- | --- |
| `# NN: Title` | ticket title |
| `**Status:** ready-for-agent` | board column, mapped through the table in `triage-labels.md` |
| `**Blocked by:** 01, 02` (or `none`) | a ticket is `blocked` until every blocker is `done`; unblocked + unclaimed tickets are the frontier the team may grab |
| `**Assignee:** eng_m1` | who claimed it — written back by the server when an agent takes the ticket |
| `**Attempt:** 2` | retry count after a failed review or verify |
| `**What to build:** …` | the one-line "delivers" shown on the board card |
| `- [ ] …` checklist items | acceptance criteria QA ticks off one by one |

The folder is watched (`watchBoard`), so editing a ticket by hand updates the board live.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
