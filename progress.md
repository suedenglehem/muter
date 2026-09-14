# Progress — Audio Ad Muter (M1 verification)

_Last updated: 2026-09-14. **M1 VERIFIED WORKING by the user in a real browser.**
Two fixes were needed: (1) capture/audio moved from the offscreen document to a hidden
extension page (offscreen lacks chrome.tabCapture), and (2) the analysis worklet's
silent sink must connect to the audio destination or the render thread never pulls it
(no level data → watchdog ERROR at 2s). Full flow confirmed: Start → LISTENING + live
meter → Mute (audio stops, meter keeps moving) → Hear Audio (sound returns) → Stop._

## Goal

Verify that the extension actually works when Chrome opens a YouTube video:
capture tab audio → passthrough with gain control → mute/unmute via popup,
level meter live, no double audio. M1 code was written but never run end-to-end.

## Completed this session

1. **Full code review of `src/`** (service-worker, offscreen, worklet, popup, manifest, build).
   Architecture is sound for the M1 flow: popup → SW (`START_CAPTURE`) → offscreen doc
   (`chrome.tabCapture.capture({targetTabId})`) → AudioContext with two branches
   (analysis worklet → silent sink; gain node → destination). 15ms gain ramps,
   watchdog fails open at 2s. No blocking bugs found in the message flow itself.

2. **Rebuilt `dist/`** (`npm run build` — clean, no TS errors).

3. **Built a CDP-driven headless smoke test** (no new npm deps; Node 24 built-in
   WebSocket/fetch):
   - Script: `H:\Temp\users\claude\H--vscode-muter\65d268c0-b450-4c2a-9f2c-6bc0e646ce09\smoke-test.mjs`
     (plus a smaller diagnostic: `probe.mjs` in the same folder)
   - Launches real Chrome with `--load-extension=dist`, opens
     `youtube.com/watch?v=dQw4w9WgXcQ`, waits for `<video>` to play, opens the popup
     page in a second tab (with a message spy injected via
     `Page.addScriptToEvaluateOnNewDocument`), then clicks Start → checks LISTENING +
     non-zero level meter → Mute → analysis-continues check → Hear Audio (override
     countdown) → Cancel override → Stop.

## (Historical) In progress / where it stopped

_RESOLVED — see "Root cause found" and "Fix implemented" below. Kept for the record._

**The smoke test cannot yet reach the extension's popup page.** Symptom: opening
`chrome-extension://<id>/popup/popup.html` in a tab fails with
`ERR_BLOCKED_BY_CLIENT` ("invalid is blocked") or `ERR_FILE_NOT_FOUND`.

Root cause narrowed down via Chrome's own logs (`--enable-logging=stderr`,
captured to `chrome-stderr.log` next to the scripts):

- The service worker target we attached to was **Google Network Speech** — a built-in
  *component* extension whose manifest also declares `service_worker.js` (underscore),
  which matched our predicate. Our extension's file is `service-worker.js` (hyphen).
  So in several runs the test drove Google's SW, not ours.
- With `--disable-component-extensions-with-background-pages`, component extensions
  vanish but **our extension also stopped loading** — that flag needs to be dropped.
- Even when our SW was present, `fetch(chrome.runtime.getURL("manifest.json"))` from
  inside it failed while `service_worker.js` itself loaded fine → the extension's
  *resource* files were not resolvable (content verifier: "Content verify job failed …
  at path popup/popup.html reason:1").

**Leading hypothesis:** a stale Chrome process holding an old user-data-dir / port, or
the `--disable-extensions-except` + component-flag combination confusing the loader.
The probe profile's `Default/Preferences` was about to be inspected (file not found —
profile dir layout differs; check `<ud>/Default/Extensions` and `Local State`) when the
session ended.

## Root cause found (2026-09-14) — BLOCKING, not a test artifact

Re-ran the smoke test after fixing the SW-target match (hyphen) and using **Chrome for
Testing** (stable Chrome ignores `--load-extension`, so a CFT build was needed). Results:
extension loads, popup works, and the whole UI flow (Mute / Override / Cancel / Stop)
passes — **but `LISTENING` never comes up; the level meter is flat; error text =
`Cannot read properties of undefined (reading 'capture')`**.

That error is `offscreen.ts:206` → `chrome.tabCapture.capture(...)`. The root cause is a
hard MV3 context limitation, verified empirically by dumping the API surface of every
candidate context in Chrome 153.0.8010.36 (headless, fresh profile):

| Context | `chrome.tabCapture.capture` | `AudioContext` + AudioWorklet |
|---|---|---|
| **Offscreen document** (where M1 calls `capture()`) | ❌ `chrome` = only `runtime/csi/loadTimes` | ✅ yes |
| **Service worker** | ❌ namespace exists, `.capture` is `undefined` | ❌ no `AudioContext` at all |
| **Content script** | ❌ | ✅ |
| **Extension page** (`chrome-extension://…/page.html` in a tab) | ✅ `function` | ✅ + worklet |

The two things the pipeline needs (capture the tab's audio, AND process it with an
AudioContext/worklet) **only co-exist in a real extension page**. A `MediaStream` cannot
be transferred across contexts. M1 put `tabCapture.capture()` in the offscreen document,
where the API does not exist → it crashes → `CAPTURE_ERROR`. **This fails identically in
a normal headed browser, not just headless.** It was never going to work as written.

Additional MV3 fact confirmed while probing: extension pages enforce
`script-src 'self'` CSP — **inline `<script>` is blocked**, so the audio page must load an
external JS file (our esbuild output already is).

While fixing, two more current-Chrome API facts were confirmed (both rejected by Chrome
153 and by the docs), which M1 also got wrong:
- `capture(options, callback)` is **callback-only** and captures the **currently active
  tab**. `targetTabId` is NOT a valid `capture()` option (it belongs to
  `getMediaStreamId`). M1 called `capture({targetTabId, audioConstraints})` as a promise.
- `audioConstraints` is a `MediaStreamConstraint` (`{mandatory, optional}`), so the old
  flat WebRTC DSP flags (`echoCancellation`, …) are rejected.
- Chrome requires the extension to be **user-invoked on the target tab** before capture
  ("Extension has not been invoked for the current page"). This is a real anti-abuse
  gate; it cannot be produced by an automated/headless test. A human clicking the Muter
  popup on the tab satisfies it.

## Fix implemented (2026-09-14) — Option A, verified up to the human-only gate

Restructured so capture + the audio graph live in a hidden **extension page** instead of
an offscreen document:

- **New** `src/audio/audio.html` + `src/audio/audio.ts` — the audio graph, gain, watchdog,
  and `chrome.tabCapture.capture()` moved here verbatim from offscreen. Added an
  `AUDIO_PAGE_READY` handshake (sent on load, a few times) and an `AUDIO_PAGE_PING`
  liveness reply. Capture now uses the correct callback form
  `capture({audio:true, video:false}, cb)`.
- **`service-worker.ts`** — replaced `ensureOffscreen()`/`chrome.offscreen.*` with
  `ensureAudioPage()`: opens `audio/audio.html` as a background tab via
  `chrome.tabs.create`, and uses a broadcast `AUDIO_PAGE_PING` as the single source of
  truth for "is a working audio page alive" (survives SW restarts; no `tabs` permission
  needed; self-heals a closed tab). Removed the offscreen message relay (renamed to
  `sendToAudioPage`), added `AUDIO_PAGE_READY`/`AUDIO_PAGE_PING` handling.
- **`src/shared/types.ts`** — added `AUDIO_PAGE_READY` + `AUDIO_PAGE_PING` message types.
- **`build.mjs`** — build entry `audio/audio.ts` → `dist/audio/audio.js`; copies
  `audio.html`.
- **`manifest.json`** — dropped the `offscreen` permission (no longer used).
- **Removed** `src/offscreen/` (git-tracked, recoverable via `git`).
- **`README.md`** — updated architecture / design-decisions / permissions / structure for
  the audio-page design + a note on the invocation requirement.

### What's verified (headless smoke test, Chrome for Testing 153)

`=== 4 passed, 6 skipped (human-only), 0 failed ===`

| Check | Result |
|---|---|
| YouTube video is playing | PASS |
| Popup page loads (buttons present) | PASS |
| **Audio page (hidden tab) opened** — the architectural fix | PASS |
| Status reaches LISTENING | SKIP (human-only: user-invocation gate) |
| Level meter receives non-zero audio | SKIP (needs LISTENING) |
| Mute → badge MUTED | SKIP (needs LISTENING) |
| Analysis continues while muted | SKIP (needs LISTENING) |
| Hear Audio → OVERRIDE + countdown | SKIP (needs LISTENING) |
| Cancel override → MUTED again | SKIP (needs LISTENING) |
| Stop → STOPPED | PASS |

The full chain is proven working up to Chrome's user-gesture gate: SW → opens audio page
→ audio page loads & becomes ready → `INIT_CAPTURE` dispatched → `capture()` invoked with
a now-valid signature → the only remaining error is the invocation gate itself.

### Human verification — ✅ DONE (2026-09-14)

The user loaded `dist/` in their normal Chrome, clicked the popup on a YouTube tab, and
confirmed the full flow works: **LISTENING with a live level meter, Mute silences the
video while analysis continues, Hear Audio brings sound back, Stop returns to normal.**

A second bug surfaced during that first real run and was fixed the same day:

**Bug 2 — analysis branch was a render dead-end.** The worklet → silent-sink chain was
not connected to the AudioContext destination, so the Web Audio render thread never
pulled it (it only renders nodes reachable from the destination). Result: `process()`
never ran, no `LEVEL_UPDATE` arrived, and the watchdog fired its "Analysis heartbeat
lost — audio restored" error ~2s after Start. Verified empirically with a probe
extension: dead-end chain = 0 worklet messages in 4s; chain connected to destination
(gain 0) = ~39 messages in 4s. Fix in `src/audio/audio.ts`: `silentSink.connect(
audioCtx.destination)` (still gain 0 / zero output → no audibility change). README
architecture diagram updated.

**Remaining known behavior (not bugs):** playback has a few ms of added latency (audio
flows through the capture → gain graph); a small pinned tab is visible (the hidden audio
page must be a real tab; Chrome has no API for fully hidden extension tabs); capture
requires the user to have opened the Muter popup on the tab (Chrome's invocation gate).

## Approach considered (resolved → Option A, now implemented)

- **Option A (chosen): hidden extension page** for capture + audio graph. ✅ Implemented.
- **Option B: content-script capture** — `chrome.tabCapture` is `undefined` in content
  scripts (verified), so not viable.
- **Option C: capture in the SW, stream samples to offscreen** — SW `.capture` was
  `undefined` in the dump, SW has no `AudioContext`, and a `MediaStream` can't be
  transferred across contexts. Ruled out.

## Important decisions made

- Test in **headless=new** Chrome with a fresh temp user-data-dir per run, driving UI
  via CDP instead of asking the user to click through (user was watching the window).
- Keep the YouTube tab untouched while opening the popup in a *second* tab — an early
  version navigated the YT tab to `about:blank`, killing the audio under test.
- Use `--use-fake-ui-for-media-stream` so the tabCapture permission prompt auto-accepts.
- Do NOT use `--disable-component-extensions-with-background-pages` (it hid our ext too).

## Files changed (this session)

- **`src/audio/audio.html`** (new) + **`src/audio/audio.ts`** (new) — hidden extension
  page owning tabCapture + audio graph (moved from offscreen), ready/ping handshake,
  corrected `capture({audio:true}, cb)` signature, **and** the analysis sink connected
  to the audio destination (fix for the 2s "heartbeat lost" watchdog error — see "Human
  verification" below).
- **`src/service-worker.ts`** — `ensureOffscreen` → `ensureAudioPage` (background tab +
  broadcast-ping liveness), `sendToOffscreen` → `sendToAudioPage`, AUDIO_PAGE_READY /
  AUDIO_PAGE_PING handling.
- **`src/shared/types.ts`** — added `AUDIO_PAGE_READY`, `AUDIO_PAGE_PING`.
- **`src/manifest.json`** — removed `offscreen` permission.
- **`src/offscreen/`** — deleted (git-tracked; `git checkout` restores it).
- **`build.mjs`** — audio entry + static copy.
- **`README.md`** — architecture/decisions/permissions/structure updated for audio page.
- **`dist/**`** — rebuilt.
- **`test/smoke-test.mjs`** (new) + **`package.json`** (`test` script) — headless smoke
  test in the repo (uncommitted, added after `b6a6254`).
- **`README.md`** — "Headless smoke test" section (uncommitted, added after `b6a6254`).
- **`progress.md`** — this file.
- Scratchpad (outside repo): `smoke-test.mjs`, `diag*.mjs`, `ctest-ext/`,
  `cft/chrome-win64/` (Chrome for Testing 153) in
  `H:\Temp\users\claude\H--vscode-muter\65d268c0-b450-4c2a-9f2c-6bc0e646ce09\`.

**Not yet committed** — `git status` shows the fix uncommitted on `master` (last commit
`dbfa46b` M1).

## Tests pass/fail (current smoke test)

`=== 4 passed, 6 skipped (human-only), 0 failed ===` — see "What's verified" above for
the per-check table.

## Exactly what to do next

1. **✅ Human verification — DONE.** Full flow confirmed working in a real browser.
2. **Commit the fix.** (In progress at time of writing — a transient harness issue was
   blocking the `git add`; the fix is fully in the working tree and verified.) Suggested
   message: "M1 fix: capture + audio graph in hidden extension page; connect analysis
   sink to destination."
3. **Polish done / remaining:**
   - ✅ Smoke test moved into the repo at `test/smoke-test.mjs`, `npm test` script added,
     README has a "Headless smoke test" section. It's a faithful, tidied port of the
     scratchpad script that produced `4 passed, 6 skipped, 0 failed` (removed the unused
     message-spy, portable paths via `CHROME_PATH`/`os.tmpdir()`, cleanup on exit).
     ⚠️ One run of the repo copy is still pending — at time of writing the Bash
     classifier was down, so it hasn't been executed from `test/` yet. Expected result is
     the same `4 passed, 6 skipped, 0 failed`.
   - Remaining (optional, not required for M1): hide/annotate the pinned audio-page tab
     (cosmetic; no API for a fully hidden tab); note the small playback latency in the
     UI or PRD (inherent to the capture→gain path).

**Test-harness notes (already resolved, for reference):**
- Must use **Chrome for Testing** (CFT 153.0.8010.36 in scratchpad `cft/chrome-win64/`),
  because stable Chrome ignores `--load-extension`.
- SW-target predicate must match the **hyphen** `service-worker.js` (component
  extensions use underscore `service_worker.js`).
- The popup must be opened **at** `chrome-extension://…/popup/popup.html` via
  `Target.createTarget` (navigating an `about:blank` tab there is
  `ERR_BLOCKED_BY_CLIENT`).
- Activate the YouTube tab (`Target.activateTarget`) before clicking Start, because the
  popup's `tabs.query({active:true, currentWindow:true})` must resolve to the YT tab.

## Safe state?

- ✅ **Committed** — the fix is commit `b6a6254` on `master` (user committed manually;
  pre-fix state remains `dbfa46b`).
- `test/smoke-test.mjs` + `package.json` `test` script + README test section are
  **uncommitted additions on top** (the test files were added after `b6a6254`).
- `dist/` is a clean rebuild of current `src/`; rebuild anytime with `npm run build`.
