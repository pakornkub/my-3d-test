# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

Because the tracker is local markdown (`docs/agents/issue-tracker.md`), a "label" is the value of
the `Status:` line in a ticket file.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## In-flight states the board also understands

`STATUS_MAP` in `server/board.mjs` accepts these beyond the five roles, and anything it does not
recognise falls back to `ready`. Changing a string here means changing that table too.

| `Status:` value | Board column |
| --- | --- |
| `ready-for-agent` | ready |
| `in-progress`, `claimed` | in-progress |
| `review` | review |
| `verify` | verify |
| `done`, `resolved` | done |
| `ready-for-human`, `needs-human` | needs-human |
| `blocked` | blocked |
