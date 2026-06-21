# Agent Notes

## Keep model identity canonical and current

Context: tau is multi-client — multiple browsers can share one live Pi session, so model/thinking state must stay correct across all of them and across all the ways it can change. pi does NOT emit runtime stream events for model/thinking changes (`model_change`/`thinking_level_change` are session-file entries, not RPC stream events); the authoritative signals are RPC command responses (`set_model`/`cycle_model`/`get_state` return a full Model object; `cycle_thinking_level` returns the level; `set_thinking_level` returns no data) and tau's own tracked state. `message_end` carries a bare model id that describes which model produced that message, not a selection change — it must not overwrite the selected model. Extensions can change the model mid-session by calling `pi.setModel`/`pi.setThinkingLevel` inside a `prompt`/`steer`/`follow_up` (e.g. the `pi-session-model` `/session-model` command); those acks carry no model data and emit no stream event, so tau refreshes from `get_state` after such acks.

Invariants:
- On the server (`bin/tau.js`), `session.model` is always `null` or a full `{provider, id, ...}` object — never a bare string — and `session.thinkingLevel` is always a known level and kept current (including for `set_thinking_level`, whose pi response omits the level, and for extension-driven changes via post-ack `get_state`).
- On the client (`public/app.js`), `currentModelId` is always `''` or a full `{provider, id}` object — never a bare string — and `currentThinkingLevel` is always a known level. The model input always renders `provider/model:thinking-level` when a model is selected.
- Model identity is updated only from (a) user-input RPC responses (`set_model`/`cycle_model`/`set_thinking_level`/`cycle_thinking_level`) and (b) server broadcasts/snapshots (`live_session_updated`/`mirrorSync`/`get_state`). The assistant message stream never updates it. There is intentionally no "merge" of partial payloads — the server is canonical, so the client assigns directly (`currentModelId = data.model || ''`). Do not reintroduce object-vs-string merge ternaries or `modelLabel`/`modelSpec` string fallbacks; they were removed because the server is now always canonical.
- `live_session_updated` (handled by `applyActiveSessionMetadata`) is the multi-client + extension sync path and must remain; do not remove it to "simplify".

Common regression to avoid: re-adding `this.model = event.message.model` on `message_end`, or re-adding client-side merge logic to "handle partial payloads" — both recreate the old downgrade/stale bugs that this design removes.

## Write commit messages in plain prose, keeping the key outcome explicit

Commit messages in this repo should read like a human explaining the change, not telegraphic shorthand. The maintainer has repeatedly pushed back on terse, abbreviated subject lines that drop the words that carry the actual intent.

Write the subject as a full, clear sentence. It may be long — that is fine — but it must name the real outcome, not a compressed label for it. For example, `fix(ui): canonical model identity, extension-refresh, drop client merges` was rejected as ambiguous jargon; `fix(ui): make server canonical for model/thinking identity across clients and extensions` was rejected as terse; the accepted form was `fix(ui): preserve the full provider/model:thinking-level identity in every browser so it is never downgraded or left stale, including when extensions change the model`. The words "preserve the full ... identity" and "never downgraded or left stale" are the point — keep that kind of language instead of collapsing it to one-word labels like "canonicalize" or "refresh".

In the body, write full sentences that explain why each change was made, not bullet fragments that only describe what changed. Keep the key framing words the user cared about ("preserve", "no downgrade", "stale") visible in the subject or the opening paragraph.

# Writing AGENTS.md notes

When the user asks to add a note to `AGENTS.md`, capture durable project knowledge that will help future agents avoid repeating the same mistake.

Expected content:
- The problem, edge case, or project-specific constraint, with some detail and examples to recognize it later.
- The intended behavior or invariant to preserve, described at the outcome level.
- Relevant context about where the issue appears, if it helps identify the area later.

Avoid turning the note into a step-by-step implementation plan. Do not include granular patch instructions unless the user explicitly asks for them.
