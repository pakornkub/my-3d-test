# UBE Office

An isometric office in the browser where a Claude agent team is watched at work. The room and
its people are one half of the language; the flow the team follows is the other.

## Language

### The room and the people

**Crew member**:
One of the six people who live in the office, identified by a crew id (`manager`, `eng_m1`, …).
A crew member persists for the life of the project.
_Avoid_: agent (means a running session), character (means the glTF model), user

**Role**:
What a crew member is allowed to do: manager, implementer, reviewer or QA. Determines the write
fence and the tool allowlist applied to their sessions.
_Avoid_: job, permission level

**Session**:
One conversation with Claude, from start to close. A crew member owns one session at a time but
many over a project's life — an implementer gets a fresh one per ticket — so a session is never
a stand-in for the person.
_Avoid_: run, conversation, chat

**Driver**:
Whatever produces the event stream the scene consumes: the Office Server, or the mock when no
server answers. The scene has exactly one at a time and cannot tell them apart.
_Avoid_: backend, source, provider

**Event**:
One flat fact published by the driver, validated against the same schema on both sides. Events
describe what happened, never what the scene should draw.
_Avoid_: message, command, action

### Money

**Running total**:
The cost a session has incurred since it began. Every cost event carries a running total, not the
amount added since the last one, so costs are replaced per session and never accumulated per event.
_Avoid_: increment, delta, spend

**Session key**:
What a running total is filed under: a session's id once a `session.cost` event carries one, or its
crew id for a log line written before that field existed. Two events with the same session key
replace each other rather than adding up.
_Avoid_: cost key, agent key

**Member cost**:
What one crew member has cost: the sum of the running totals of all their sessions. The figure the
roster shows next to a person.
_Avoid_: agent cost, session cost (that is one session's share of it)

**Team cost**:
What the whole team has cost today, across every session — including sessions whose id belongs to
nobody on the roster, which are counted but not shown per person. Money is never dropped for being
unattributable.
_Avoid_: total spend, project cost

**Today**:
The UTC day, because the event log is already filed one file per UTC day. In Thailand the figure
therefore rolls over at 07:00, not at midnight.
_Avoid_: this session, since startup

**Budget**:
The daily ceiling from `daily-budget-usd`, which is both what the team cost is displayed against
and what each session is capped at. One number, two uses.
_Avoid_: limit, quota, cap

### The flow

**Feature**:
One idea taken through the whole flow, owning a spec and a set of tickets.
_Avoid_: project (a project is the repo), epic, story

**Ticket**:
One unit of work a single session can finish end to end and demonstrate on its own.
_Avoid_: issue (that is the file it lives in), task, card

**Frontier**:
The tickets that can be started right now: unblocked, unclaimed, ready. Also used for the set of
open questions an interview can ask in one round.
_Avoid_: backlog, queue, next up

**Gate**:
A check the server runs itself — test, typecheck, e2e — whose result is the only evidence that
work passes. An agent's own claim that something works is not a gate.
_Avoid_: CI, check, validation
