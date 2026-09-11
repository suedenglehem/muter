/**
 * Offscreen Document — Audio Ad Muter
 * 
 * Owns: MediaStream, AudioContext, audio graph, playback gain, watchdog.
 * 
 * Audio path:
 *   Captured tab MediaStream
 *     -> MediaStreamAudioSourceNode
 *        -> analysis AudioWorklet -> silent sink (gain=0)
 *        -> GainNode (playback control) -> AudioContext.destination
 */

import {
  MessageType,
  InitCaptureMsg,
  DestroyCaptureMsg,
  SetGainOffscreenMsg,
} from "../shared/types";

// ─── Audio Graph State ────────────────────────────────────────────────────────

let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let gainNode: GainNode | null = null;
let silentSink: GainNode | null = null;

let currentSessionId: string | null = null;
let isCapturing = false;

// Watchdog: if no level data from worklet for >2s while capturing, fail open
let lastLevelTime = 0;
let watchdogInterval: ReturnType<typeof setInterval> | null = null;

const GAIN_RAMP_TIME = 0.015; // 15ms ramp to reduce clicks (PRD: 5-20ms)

// ─── Audio Graph Setup ────────────────────────────────────────────────────────

async function buildAudioGraph(stream: MediaStream, sessionId: string): Promise<void> {
  audioCtx = new AudioContext({ latencyHint: "playback" });

  // Ensure context is running (may be suspended until user gesture in some cases)
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }

  // Source node from captured stream
  sourceNode = audioCtx.createMediaStreamSource(stream);

  // Load the analysis worklet module (path relative to offscreen.html)
  await audioCtx.audioWorklet.addModule("../worklet/analysis-worklet.js");

  // Analysis branch: Worklet -> silent sink
  workletNode = new AudioWorkletNode(audioCtx, "analysis-worklet", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [stream.getAudioTracks()[0]?.numberOfChannels ?? 2],
  });

  // Silent sink: gain=0 so analysis branch doesn't add to audible output
  silentSink = audioCtx.createGain();
  silentSink.gain.value = 0.0;

  sourceNode.connect(workletNode);
  workletNode.connect(silentSink);
  // Note: silentSink is NOT connected to destination — it's a dead-end sink.
  // The worklet outputs zeros anyway, so even if connected it would be silent.

  // Listen for level data from the worklet
  workletNode.port.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (data.type === MessageType.WORKLET_LEVEL) {
      lastLevelTime = performance.now();
      chrome.runtime.sendMessage({
        type: MessageType.LEVEL_UPDATE,
        level: data.rms,
        peak: data.peak,
      }).catch(() => {});
    }
  };

  // Playback branch: Source -> GainNode -> Destination
  gainNode = audioCtx.createGain();
  gainNode.gain.value = 1.0;

  sourceNode.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  currentSessionId = sessionId;
  isCapturing = true;
  lastLevelTime = performance.now();

  // Start watchdog
  startWatchdog();

  console.log(`[muter:offscreen] Audio graph built. Session: ${sessionId}`);
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

async function teardownAudioGraph(): Promise<void> {
  stopWatchdog();

  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }

  if (gainNode) {
    gainNode.disconnect();
    gainNode = null;
  }

  if (silentSink) {
    silentSink.disconnect();
    silentSink = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  // Stop all tracks in the media stream
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }

  if (audioCtx && audioCtx.state !== "closed") {
    await audioCtx.close();
  }
  audioCtx = null;

  currentSessionId = null;
  isCapturing = false;

  console.log("[muter:offscreen] Audio graph torn down.");
}

// ─── Gain Control ─────────────────────────────────────────────────────────────

function setGain(targetGain: number): void {
  if (!gainNode || !audioCtx) return;

  const now = audioCtx.currentTime;
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  gainNode.gain.linearRampToValueAtTime(targetGain, now + GAIN_RAMP_TIME);

  console.log(`[muter:offscreen] Gain -> ${targetGain}`);
}

// ─── Watchdog (fail open) ─────────────────────────────────────────────────────

function startWatchdog(): void {
  stopWatchdog();
  watchdogInterval = setInterval(() => {
    if (!isCapturing || !audioCtx) return;

    // If AudioContext is suspended, show error state
    if (audioCtx.state === "suspended") {
      chrome.runtime.sendMessage({
        type: MessageType.CAPTURE_ERROR,
        error: "AudioContext suspended — click the page to resume",
        code: "CTX_SUSPENDED",
      }).catch(() => {});
      return;
    }

    // If no level data for >2 seconds, worklet may be stalled
    const elapsed = performance.now() - lastLevelTime;
    if (elapsed > 2000) {
      console.warn(`[muter:offscreen] Watchdog: no level data for ${elapsed}ms`);
      // Fail open: restore gain
      setGain(1.0);
      chrome.runtime.sendMessage({
        type: MessageType.CAPTURE_ERROR,
        error: "Analysis heartbeat lost — audio restored",
        code: "HEARTBEAT_LOST",
      }).catch(() => {});
    }
  }, 500);
}

function stopWatchdog(): void {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
}

// ─── Capture Start/Stop ──────────────────────────────────────────────────────

async function startCapture(tabId: number, sessionId: string): Promise<void> {
  if (isCapturing) {
    await teardownAudioGraph();
  }

  try {
    // Capture audio from the target tab using Chrome's tabCapture API
    mediaStream = await chrome.tabCapture.capture({
      targetTabId: tabId,
      audioConstraints: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    // Verify we got an audio track
    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error("No audio tracks in captured stream — source may be unsupported");
    }

    await buildAudioGraph(mediaStream, sessionId);

    // Notify service worker that capture is ready
    const track = audioTracks[0];
    chrome.runtime.sendMessage({
      type: MessageType.CAPTURE_STARTED,
      sessionId,
      sampleRate: track.sampleRate || 48000,
      channels: track.numberOfChannels || 2,
    }).catch(() => {});

  } catch (err: any) {
    // Clean up partial state
    await teardownAudioGraph();

    const errorMsg = err?.message ?? String(err);
    console.error(`[muter:offscreen] Capture failed: ${errorMsg}`);

    chrome.runtime.sendMessage({
      type: MessageType.CAPTURE_ERROR,
      error: errorMsg,
      code: "CAPTURE_FAILED",
    }).catch(() => {});
  }
}

async function stopCapture(): Promise<void> {
  await teardownAudioGraph();

  chrome.runtime.sendMessage({
    type: MessageType.CAPTURE_STOPPED,
  }).catch(() => {});
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: any, _sender, sendResponse) => {
    switch (message.type) {
      case MessageType.INIT_CAPTURE: {
        const msg = message as InitCaptureMsg;
        startCapture(msg.tabId, msg.sessionId).then(() => {
          sendResponse({ ok: true });
        }).catch((err) => {
          sendResponse({ ok: false, error: err?.message ?? String(err) });
        });
        return true; // async
      }

      case MessageType.DESTROY_CAPTURE: {
        stopCapture().then(() => sendResponse({ ok: true }));
        return true;
      }

      case MessageType.SET_GAIN_OFFSCREEN: {
        const msg = message as SetGainOffscreenMsg;
        setGain(msg.gain);
        sendResponse({ ok: true });
        return false;
      }

      default:
        return false;
    }
  }
);

// ─── Page Visibility / Context Change Handling ────────────────────────────────

// If the offscreen document is being closed, clean up
window.addEventListener("pagehide", () => {
  if (isCapturing) {
    stopCapture();
  }
});

console.log("[muter:offscreen] Offscreen document ready.");

