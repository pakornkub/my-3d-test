# The event schema evolves by optional fields, not by version bumps

`validate()` in `src/agents/events.js` rejects any event whose `v` is not the current
`EVENT_VERSION`, and the server replays `server/log/*.jsonl` straight into the scene — so
bumping the version does not just invalidate the event that changed, it makes every logged
event of every type unreplayable, including the `__ube.mock.start(replayScript(events))`
workflow the server runbook documents. New fields are therefore added as optional: absent
on old events, and read with a fallback (`ev.session ?? ev.agent`). `EVENT_VERSION` is
reserved for a change that genuinely breaks old readers, such as removing or retyping a
required field.

## Consequences

Readers of an event may not assume a newly added field is present, even from a driver that
always sends it, because the same event type arrives from logs written before the field
existed. The schema's required-field lists stay as they were on day one.
