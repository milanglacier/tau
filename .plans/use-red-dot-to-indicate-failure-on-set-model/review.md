# Review: fix/use-red-light-to-indicate-wrong-model-field

Branch: `fix/use-red-light-to-indicate-wrong-model-field`
Commit reviewed: `288119e` (`fix: indicate red light on model set failure.`)
Scope: `git diff 2928c67..288119e` — `public/app.js`, `public/style.css` (plus added `plan.md`, deleted `CLAUDE.md`).

## Findings

### 1. Restore step leaves stale `disconnected` class, so the dot can stay red while connected

`flashStatusError` only removes `connected` and `streaming` when entering the
error state, and only removes `error` on restore — it never clears
`disconnected`:

```js
statusIndicator.classList.remove('connected', 'streaming'); // leaves 'disconnected'
statusIndicator.classList.add('error');
// ...
statusIndicator.classList.remove('error');
statusIndicator.classList.add(open ? 'connected' : 'disconnected');
```

If the indicator is `disconnected` (WS down) when an error flashes and the
socket reconnects before the 3s timeout, the restore adds `connected` without
removing `disconnected`, yielding `class="status-indicator disconnected
connected"`. Because `.status-indicator.disconnected` is declared *after*
`.status-indicator.connected` in `public/style.css` (lines 1154 vs. 1166), the
red `disconnected` rule wins on equal specificity, so the dot stays red even
though `wsClient.ws.readyState === OPEN`. `updateUI()` (lines 1964–1970) and the
poll path also only add/remove `connected`/`streaming` and never strip
`disconnected`, so the wrong state persists until the next WS open/close event
calls `updateConnectionStatus` (line 1938), which resets via `className`
assignment. The original code only touched `statusText.textContent` and never
manipulated the class list, so this is newly introduced.

Fix by resetting the class atomically, the way `updateConnectionStatus` does:

```js
statusIndicator.className = 'status-indicator error';
// ...on restore:
statusIndicator.className = `status-indicator ${open ? 'connected' : 'disconnected'}`;
```

**Location:** `public/app.js`, `flashStatusError`, lines 1303–1311.

### 2. Restore clobbers the `streaming` indicator when an error fires mid-stream

`applyModelInput` is reachable while streaming: `modelInput` is never disabled
by `updateUI()` (only `messageInput`/`sendBtn` are, lines 1972–1973), so a user
can edit and blur the model box during an active stream. If `set_model` or
`set_thinking_level` then fails, `flashStatusError` removes `streaming`, adds
`error`, and on restore unconditionally sets `connected` + `'Connected'`
regardless of `state.isStreaming`:

```js
statusIndicator.classList.remove('error');
const open = wsClient.ws?.readyState === WebSocket.OPEN;
statusIndicator.classList.add(open ? 'connected' : 'disconnected');
statusText.textContent = open ? 'Connected' : 'Disconnected';
```

With `state.isStreaming === true`, the dot flips from the orange pulsing
`streaming` state to a solid green `connected` / `'Connected'` and stays that
way until the next `updateUI()` (agent end, snapshot, or the ~10s poll at line
1733) re-adds `streaming`. The original text-only `setTimeout` did not touch the
indicator class, so the streaming dot survived the error flash. At minimum the
restore should fall back to the streaming state when `state.isStreaming` is true
(e.g. re-add `streaming` and set `'Working...'`), or simply delegate to
`updateUI()` instead of hand-rolling the restore.

**Location:** `public/app.js`, `flashStatusError` restore block, lines 1306–1311.

## Minor notes (not blocking)

- `.status-indicator.error` (`public/style.css` lines 1171–1175) duplicates
  `.disconnected` verbatim plus `connectPop`. Fine, but if finding 1 is fixed by
  reusing `disconnected` semantics, a distinct `error` class may no longer be
  necessary. Left to author preference.
- The restore text drops the `'Connected • TS'` suffix and `statusText.title`
  set by `updateConnectionStatus` (line 1942). This is pre-existing behavior
  (the old inline `setTimeout` did the same), so not counted as a finding, but
  the helper is a good place to fix it if desired.

## Verdict

Needs revision.

The helper correctly turns the dot red on errors, but its restore step
manipulates the indicator class list incrementally instead of resetting it
atomically. This both can leave a stale `disconnected` class that keeps the dot
red after reconnection (finding 1) and can overwrite an active `streaming`
state when an error occurs mid-stream (finding 2). Both are fixable in a few
lines by mirroring the `className =` reset pattern already used in
`updateConnectionStatus`.

---

## Fix summaries

Both findings addressed in `public/app.js` `flashStatusError` (lines
1299–1317). The incremental `classList.remove`/`add` calls were replaced with
atomic `className =` resets, matching the pattern used by
`updateConnectionStatus` (line 1938).

### Finding 1 — stale `disconnected` class

Both the error-enter and restore steps now set the full class string via
`statusIndicator.className = 'status-indicator <state>'`, so no prior
`connected` / `disconnected` / `streaming` class can linger alongside the new
one. A reconnection that completes during the 3s flash now produces a clean
`status-indicator connected` class, and the dot correctly turns green.

### Finding 2 — restore clobbers `streaming` mid-stream

The restore branch now checks `state.isStreaming` (the same flag `updateUI`
reads at line 1961). When the socket is open and a stream is in progress, it
restores `status-indicator streaming` + `'Working...'` instead of forcing
`connected` / `'Connected'`, so an error flashed during a stream no longer
overrides the orange pulsing dot.

### Verification

- `node --check public/app.js` passes (no syntax errors).
- No DOM/browser tests exist for `app.js` (the `test/` suite is server-side
  Node only), so no test changes were needed or applicable.
- The `.status-indicator.error` CSS class (`public/style.css` 1171–1175) is
  retained: it is still applied on error-enter via `className =
  'status-indicator error'`, and its `connectPop` animation remains the
  intentional visual cue for the red flash. The minor note about reusing
  `disconnected` semantics was not applied, since the `error` class carries the
  pop animation that `disconnected` lacks.
- The non-blocking minor note about the dropped `'Connected • TS'` suffix was
  intentionally left as-is to keep the change scoped to the two findings and
  preserve the original restore-text behavior.

---

## 2nd-reviewer assessment

Branch: `fix/use-red-light-to-indicate-wrong-model-field`
Commits reviewed: `288119e` and `3f7ea7e` (i.e. `git diff a06faa4..HEAD` on
`public/app.js` and `public/style.css`).

### Confirmation of prior findings

Both findings from the first review are resolved.

- Finding 1 (stale `disconnected` class): the enter and restore steps now use
  atomic `statusIndicator.className = 'status-indicator <state>'` assignments
  (`public/app.js` lines 1305 and 1312/1315), so no prior
  `connected`/`disconnected`/`streaming` class can linger alongside `error`.
  A reconnect during the 3 s flash now yields a clean `connected` class.
- Finding 2 (`streaming` clobbered mid-stream): the restore branch now checks
  `state.isStreaming` (line 1311) and re-applies `status-indicator streaming` +
  `'Working...'` when the socket is open and a stream is in progress, instead of
  forcing `connected`/`'Connected'`. Matches the flag `updateUI` reads.

`node --check public/app.js` passes; the `.status-indicator.error` CSS rule is
retained and is the only place the red flash gets its `connectPop` cue.

### Findings

#### 1. Red dot and status text desync when `set_model` succeeds but `set_thinking_level` fails

`applyModelInput` runs `set_model` and `set_thinking_level` as two separate
`rpcCommand` calls. On `set_model` success, `rpcCommand` sets the text to
`'Done'` and schedules a **2 s** restore to `'Connected'`
(`public/app.js` lines 1202–1203). If the subsequent `set_thinking_level` call
fails, `applyModelInput` calls `flashStatusError(t.error)` (lines 1361–1364),
which turns the dot red and schedules a **3 s** restore. Because the thinking
RPC typically fails well within 2 s of the `set_model` success, the stale
2 s `'Done'` timer fires *during* the 3 s red-dot window and overwrites the
error text with `'Connected'`, leaving a red `error` dot next to the word
`'Connected'` for roughly the last second of the flash.

```js
// rpcCommand, set_model success — 2s timer still pending:
statusText.textContent = 'Done';
setTimeout(() => { statusText.textContent = 'Connected'; }, 2000);
// ...then thinking fails -> flashStatusError keeps the dot red for 3s
```

The text-overwrite race itself is pre-existing (`rpcCommand` has always owned
its own restore timers), but the *visible dot/text mismatch* is introduced by
this change: previously there was no persistent red dot, so the early text
reset was not contradictory. This is the headline path of the feature — a
single `provider/model[thinking]` input where the model is valid but the
thinking level is rejected — so it is readily reachable. A minimal fix is to
make the error flash own the text for its full duration, e.g. have
`applyModelInput` suppress `rpcCommand`'s status messaging on the
`set_thinking_level` failure path (or cancel/ignore `rpcCommand`'s pending
restore when `flashStatusError` runs), rather than letting the two timer
systems race.

**Location:** `public/app.js` — `rpcCommand` lines 1202–1203 (2 s `'Done'`
restore) interacting with `applyModelInput` lines 1361–1364 and
`flashStatusError` lines 1302–1317.

### Minor notes (not blocking)

- **Overlapping flashes can clear the dot early.** Two `applyModelInput`
  failures within 3 s (e.g. user edits to a second invalid spec and blurs
  before the first flash elapses) schedule two independent restore timers; the
  first restore atomically resets the dot to `connected`/`disconnected` while
  the second error is still nominally active, briefly turning the dot green
  before the second error's intended end. The original text-only `setTimeout`
  had the same overlapping-timer problem for the text, but the dot-color
  clobber is new. Narrow trigger; mention only for completeness.
- The restore text still drops the `'Connected • TS'` suffix and
  `statusText.title` that `updateConnectionStatus` sets (line 1949–1950). This
  was already noted as pre-existing by the first reviewer; still applies now
  that the helper is the single restore path for these flows.

### Verdict

Needs revision (minor).

The first reviewer's two findings are correctly addressed: the atomic
`className` reset eliminates the stale-class bug, and the `isStreaming`-aware
restore preserves the streaming dot. One new, reachable desync remains on the
feature's core path — when `set_model` succeeds and `set_thinking_level`
fails, `rpcCommand`'s stale 2 s `'Done'` timer overwrites the error text while
the red dot persists for 3 s, producing a red dot beside `'Connected'`. It is a
small window and rooted in pre-existing `rpcCommand` timer behaviour, but the
visible mismatch is introduced by this change and is worth a one-line fix to
give the error flash ownership of the status text for its full duration.

---

## 2nd-reviewer fix summary

Finding 1 (red dot / status text desync) addressed in `public/app.js`.

### Root cause

`rpcCommand` and `flashStatusError` each scheduled their own independent
`setTimeout` restore of `statusText`, with no shared handle. On the feature's
headline path — `set_model` succeeds (rpcCommand schedules a 2 s
`'Done'` -> `'Connected'` restore) and then `set_thinking_level` fails
(`flashStatusError` turns the dot red for 3 s) — the stale 2 s timer fired
inside the 3 s red-dot window and overwrote the error text with `'Connected'`,
producing a red `error` dot beside the word `'Connected'`.

### Fix

Introduced a single module-level `statusRestoreTimer` plus a
`setStatusMessage(text, restoreText, restoreMs)` helper (`public/app.js`
lines 41–52) that clears any previously scheduled restore before setting a
new one. All transient `statusText` restores now flow through this helper:

- `rpcCommand`: the five inline `setTimeout` restore sites (needs-live-session
  error, `'Done'`, `data.error`, catch `'Error'`) now call `setStatusMessage`
  (lines 1206, 1210, 1218, 1220, 1224).
- `rpcExportHtml`: the 4 s `'Exported: ...'` restore now uses `setStatusMessage`
  (line 1231).
- `flashStatusError`: on entry it calls `clearTimeout(statusRestoreTimer)` and
  schedules its own restore on the same handle (lines 1321–1323), so any
  `rpcCommand` restore pending from an earlier successful step in the same
  flow is cancelled before the red-dot window begins.

Because every new transient message cancels the prior restore, the
`rpcCommand` 2 s `'Done'` timer can no longer fire during the 3 s error flash,
and the error text owns the status bar for the full duration of the red dot.

### Side effect: overlapping flashes (minor note)

The shared-timer approach also resolves the non-blocking "overlapping flashes
can clear the dot early" note. Two `applyModelInput` failures within 3 s now
cancel the first restore when the second `flashStatusError` runs, so the first
restore can no longer atomically reset the dot to `connected`/`disconnected`
while the second error is still active.

### Verification

- `node --check public/app.js` passes.
- No DOM/browser tests exist for `app.js` (the `test/` suite is server-side
  Node only), so no test changes were needed or applicable.
- Left the persistent (non-transient) `statusText.textContent` assignments in
  `updateConnectionStatus` (lines 1966, 1973, 1979) and `updateUI`
  (lines 1990, 1994) untouched: these set durable state and do not schedule
  restores, so routing them through `setStatusMessage` would be incorrect.
- The non-blocking note about the dropped `'Connected • TS'` suffix remains
  unaddressed to keep this change scoped to the desync finding; it is
  pre-existing behavior and out of scope for this fix.
