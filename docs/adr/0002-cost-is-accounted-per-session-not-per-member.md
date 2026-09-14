# Cost is accounted per session and summed per member

The SDK reports `total_cost_usd` as a running total for one session, and the scene keyed it by
crew id — correct only while each person has one session for life. From phase 2 an implementer
gets a fresh session per ticket, so last-write-wins would silently lose every earlier ticket's
money. `session.cost` therefore carries the session id and the Director keys on it, keeping the
latest running total per session and summing per member for the roster. The alternative — having
the server pre-aggregate and publish a per-member table — was rejected to keep events as facts
about one session rather than a view the scene merely paints.

The team figure is scoped to the UTC day and seeded at boot from that day's event log, so it
survives both a browser reload and a server restart, and means the same thing as the
`daily-budget-usd` it is displayed against. The UTC boundary is inherited from the log's existing
file-per-day naming: changing it would re-cut files already on disk, so the figure rolls over at
07:00 Thai time and the UI says so.

## Consequences

Money from a session whose agent id is not on the roster still counts toward the team total and
appears only in the panel's breakdown; the roster's visible figures are therefore allowed to sum
to less than the total. Aggregation lives in `src/agents/director.js`, which has no three.js
import, so these rules are unit-testable in `tests/director.test.js`.
