# Agent Notes

## Preserve full model identity in the UI

Problem: server RPC payloads for the selected model are inconsistent — sometimes
`provider/model`, sometimes bare model id. E.g., a model-change response may
omit the provider even though the UI already has the full `provider/model` from
the user's selection. If the UI takes that partial payload as authoritative, it
can downgrade the displayed model (e.g. `opencode-go/deepseek-v4-pro:off` →
`deepseek-v4-pro:off`).

Intended behavior: whenever the full model identity is known, the UI should
preserve and display it, including provider and thinking level. Avoid
regressions where partial server payloads erase known model identity.

# Writing AGENTS.md notes

When the user asks to add a note to `AGENTS.md`, capture durable project knowledge that will help future agents avoid repeating the same mistake.

Expected content:
- The problem, edge case, or project-specific constraint, with some detail and examples to recognize it later.
- The intended behavior or invariant to preserve, described at the outcome level.
- Relevant context about where the issue appears, if it helps identify the area later.

Avoid turning the note into a step-by-step implementation plan. Do not include granular patch instructions unless the user explicitly asks for them.
