# Audio Ad Muter

Local-first Chrome extension that detects known audio advertisements in a user-selected tab, suppresses their audible playback, and restores playback after supported ad intervals.

**Current milestone:** M1 — Audio Pipeline (capture, passthrough, manual gain mute, level meter, stop/restart, failure UI)

## Prerequisites

- **Node.js LTS** (v20+)
- **npm** (bundled with Node)
- **Chrome 120+** (for unpacked extension development)
- No Visual Studio, Windows SDK, or GPU required

## Setup

```bash
# Install dependencies
npm install

# Build the extension
npm run build
```

The built extension will be in `dist/`.

## Load Unpacked Extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `dist/` folder of this project
5. Pin the "Audio Ad Muter" icon from the extension manager

## Usage

1. Open a tab with audio content (e.g., YouTube, podcast player)
2. Click the **Muter** extension icon
3. Click **Start Monitoring** — Chrome will prompt for capture permission
4. The level meter shows live input levels
5. Use **Mute** / **Hear Audio** to manually control playback gain
6. Click **Stop** when done

## Development

```bash
# Watch mode (rebuilds on file changes)
npm run watch
```

Then reload the extension at `chrome://extensions` after each rebuild.

## Project Structure

```
src/
├── manifest.json              # Chrome MV3 manifest
├── service-worker.ts          # Background: commands, audio-page lifecycle, state
├── audio/
│   ├── audio.html             # Hidden extension page (background tab)
│   └── audio.ts               # tabCapture, audio graph, gain control, watchdog
├── worklet/
│   └── analysis-worklet.ts    # AudioWorklet: level metering, silent output
├── popup/
│   ├── popup.html             # Popup UI
│   ├── popup.css              # Styles
│   └── popup.ts               # Controls and status polling
└── shared/
    └── types.ts               # Shared message types and enums
```

## Architecture (M1)

```
Captured tab MediaStream
  → MediaStreamAudioSourceNode
     ├→ AudioWorklet (analysis) → silent sink [gain=0] → destination
     └→ GainNode (playback control) → AudioContext.destination
```
(The silent sink **must** reach the destination: the render thread only pulls
nodes reachable from it, so a dead-end analysis chain would never run.)

- **Service Worker**: user commands, audio-page lifecycle, session identity. No DSP.
- **Audio Page** (a hidden extension page opened as a background tab): owns
  `tabCapture`, the MediaStream, AudioContext, audio graph, gain, and watchdog.
  This is required because `chrome.tabCapture` is not exposed in offscreen
  documents or the service worker, and the SW has no `AudioContext` — the
  extension page is the only context with both.
- **AudioWorklet**: bounded PCM level computation; emits silence to avoid duplicate playback.
- **Popup UI**: controls, status badge, level meter, error display.

## Key Design Decisions (M1)

| Decision | Rationale |
|----------|-----------|
| GainNode for mute (not Windows master) | PRD: extension-controlled gain only |
| 15ms linear ramp on gain changes | Reduces clicks; within PRD's 5–20ms range |
| Worklet outputs zeros to silent sink | Avoids duplicate playback on analysis branch |
| Watchdog checks every 500ms, fails open at 2s | Restores audibility if worklet stalls |
| Audio lives in a hidden **extension page**, not an offscreen document | `chrome.tabCapture` doesn't exist in offscreen docs / SW; the extension page is the only context with both `tabCapture` and `AudioContext` (verified on Chrome 153) |
| `tabCapture.capture({audio:true}, cb)` (callback form, no `targetTabId`) | Current Chrome signature: `capture()` takes a callback and captures the active tab; `targetTabId` only exists on `getMediaStreamId` |
| Audio page kept alive between start/stop | Faster restart; liveness checked by a broadcast `AUDIO_PAGE_PING` (survives SW restarts, no `tabs` permission needed) |
| esbuild as bundler | Minimal config, fast, handles TS natively |

## Permissions

| Permission | Purpose |
|------------|---------|
| `tabCapture` | Capture audio from the active tab |
| `storage` | Persist settings (M2+) |

No microphone permission, no broad host access, no `tabs` permission (the audio
page is a normal extension page the SW opens via `chrome.tabs.create`).

> **Note:** Chrome requires the extension to be *invoked* on a tab before tab
> capture is allowed (an anti-abuse gate tied to a real user click). Opening the
> Muter popup on the tab satisfies this — so Start only works after the user has
> opened the popup on the tab they want captured.

## Testing Checklist (Manual — M1)

- [ ] Start capture on a YouTube tab → audio plays through normally
- [ ] Level meter responds to audio input
- [ ] Click Mute → audio stops within ~50ms, analysis continues (level still updates)
- [ ] Click Hear Audio → audio resumes, 60s countdown visible
- [ ] Cancel Override during countdown → mute restores immediately
- [ ] Stop → tab returns to normal playback, no residual silence or double audio
- [ ] Start again quickly → works without errors
- [ ] Close the captured tab while monitoring → error state shown, gain restored
- [ ] Navigate away in captured tab → capture handles gracefully
- [ ] No duplicate audio (hear it once, not twice)

## Build Output

The `dist/` folder contains a ready-to-load unpacked extension:

```
dist/
├── manifest.json
├── service-worker.js
├── audio/
│   ├── audio.html
│   └── audio.js
├── worklet/
│   └── analysis-worklet.js
└── popup/
    ├── popup.html
    ├── popup.css
    └── popup.js
```

## License

MIT (pending)
