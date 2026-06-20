# Review: feat/single-model-input-box

Branch: `feat/single-model-input-box` (1 commit: `caa897e`)
Base: `ffafbb2` (merge-base with `main`)
Files changed: `public/index.html`, `public/style.css`, `public/app.js`

## Findings

### 1. Sync points drop the provider, so the input shows a provider-less string that fails its own validation

`applyActiveSessionMetadata`, `handleMirrorSync`, and `fetchModelInfo` all reduce an
object-shaped model to its bare `.id`, discarding `provider`:

```js
// applyActiveSessionMetadata (line 439)
currentModelId = session.model?.id || session.modelLabel || session.modelSpec || '';
// handleMirrorSync (line 1639)
currentModelId = (typeof data.model === 'string' ? data.model : data.model?.id) || ...;
// fetchModelInfo (line 1380)
currentModelId = typeof stateModel === 'string' ? stateModel : (stateModel.id || stateModel.name || '');
```

`bin/tau.js` stores `session.model` as `{ provider, id }` once a `set_model` /
`model_select` / `message_end` event arrives (lines 324, 330, 341, 350), and
`metadata()` (line 174) passes that object straight to the client. So after any
model change, `currentModelId` becomes e.g. `"claude-sonnet-4-20250514"` with no
provider.

`modelDisplayString()` (line 1246) then has no provider to emit, so it returns
`claude-sonnet-4-20250514:off` — no `/`. That string violates the very format the
placeholder advertises (`provider/model:thinking`). Worse, `parseModelSpec`
(line 1283) requires a `/` via `^([^\/:]+)\/([^\/:]+)...`, so the next time the
user focuses the box and blurs (or presses Enter/Escape — see finding 2),
`applyModelInput` parses the current display value, fails with "Use format
provider/model[:thinking]", slaps on `.invalid`, and reverts to the same bad
string — leaving a persistent red border for a session the user never tried to
edit.

Note `modelDisplayString` already has a correct object branch
(`typeof currentModelId === 'object'`); the sync points just never feed it an
object. Either keep the object (`currentModelId = data.model || ...`) or fall
back to `modelLabel` (which `modelLabel()` in `bin/tau.js` already formats as
`provider/id`) before extracting `.id`.

**Location:**
- `public/app.js:439` (`applyActiveSessionMetadata`)
- `public/app.js:1378` (`fetchModelInfo`)
- `public/app.js:1639` (`handleMirrorSync`)

### 2. `blur` always commits, sending RPCs even when the value is unchanged (and on Escape)

The `blur` listener unconditionally calls `applyModelInput()`:

```js
modelInput.addEventListener('blur', () => {
  delete modelInput.dataset.editing;
  applyModelInput();
});
```

`applyModelInput` (line 1296) never checks whether the input's value differs
from the current display; it parses and fires `set_model` (and, when a `:level`
suffix is present, `set_thinking_level`) regardless. So merely clicking into the
box and clicking away — no edit at all — triggers a server round trip and a
"Switching to …" / "Setting thinking…" status flash.

Escape is worse: the `keydown` handler reverts the value to `modelDisplayString()`
and then calls `modelInput.blur()`, which fires `applyModelInput` on the reverted
value. The plan explicitly specifies "Escape while editing → revert + blur" with
no apply; the implementation instead re-commits the current model + thinking
level over the network on every Escape.

Fix: bail early in `applyModelInput` when `modelInput.value.trim() ===
modelDisplayString()` (and skip the blur-driven apply on Escape, e.g. by setting
a transient flag before `.blur()`).

**Location:** `public/app.js:1359-1367` (blur handler), `public/app.js:1296`
(`applyModelInput`), `public/app.js:1351-1357` (Escape branch).

### 3. `.invalid` border stays on the reverted (valid) value

On a parse or RPC error, `applyModelInput` adds `.invalid` and then immediately
reverts `modelInput.value` to the last-good display string:

```js
modelInput.classList.add('invalid');
statusText.textContent = parsed.error;
...
modelInput.value = modelDisplayString();
```

The status text error auto-clears after 3s, but the red border remains on an
otherwise-correct-looking value until the next focus. The error signal and the
field it's attached to are now inconsistent (red border on a valid value with no
status text). Either clear `.invalid` after the revert, or drop the class once
the status message clears.

**Location:** `public/app.js:1304-1309` and `public/app.js:1335-1341`.

## Overall

**Verdict: needs revision.**

**Explanation:** The UI swap itself is clean and the CSS/HTML changes are fine,
but the new display+validation contract assumes `provider/model:thinking` while
the three model-sync sites strip the provider, so any session whose model is
object-shaped ends up with a provider-less input that trips its own validator on
the first interaction. Combined with the blur-always-commits behavior, routine
focus/blur and Escape produce spurious errors and unnecessary RPCs. Fixing
findings 1 and 2 is required; finding 3 is a small polish.

---

## Fix summaries (applied post-review)

All three findings addressed in `public/app.js`; `node --check` passes and the
full `npm test` suite is green (115/115).

### Fix 1 — Preserve the `{provider,id}` object at model sync points

The three sync sites no longer flatten object models to a bare `.id`:

- `applyActiveSessionMetadata` (`public/app.js:438`):
  `currentModelId = session.model || session.modelLabel || session.modelSpec || ''`
  — keeps the full object; `modelLabel` (already `provider/id` shaped) and
  `modelSpec` remain as string fallbacks.
- `fetchModelInfo` (`public/app.js:1378`):
  `currentModelId = (typeof stateModel === 'object' && stateModel) ? stateModel : (typeof stateModel === 'string' ? stateModel : '')`
  — preserves the object form, only flattening when the server sent a string.
- `handleMirrorSync` (`public/app.js:1638`):
  same object-preserving ternary, with `modelLabel`/`modelSpec` as fallbacks.

`modelDisplayString()` already had a correct object branch, so it now renders
`provider/model:level` instead of a provider-less `model:level` that would fail
`parseModelSpec` on the next interaction.

### Fix 2 — Skip apply when unchanged; Escape cancels without committing

- `applyModelInput` (`public/app.js:1300`) now bails early when
  `modelInput.value.trim() === modelDisplayString()` — a focus/blur with no edit
  no longer fires `set_model` / `set_thinking_level` RPCs or a status flash.
- A module-level `suppressBlurApply` flag is set in the Escape `keydown` handler
  before `modelInput.blur()` and consumed/cleared in the blur listener
  (`public/app.js:1369-1389`), so Escape reverts the value and blurs without
  re-committing the current model/thinking over the network — matching the
  plan's "Escape → revert + blur (no apply)".

### Fix 3 — Clear `.invalid` once the status error clears

Both error branches in `applyModelInput` (parse error at `public/app.js:1313`,
RPC failure at `public/app.js:1355`) now schedule
`setTimeout(() => modelInput.classList.remove('invalid'), 3000)` alongside the
existing status-clear timeout, so the red border is removed at the same time
the status message reverts — no lingering `.invalid` on a valid reverted value.
