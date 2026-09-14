/**
 * MV3 Service Worker — Audio Ad Muter
 * 
 * Responsibilities (M1):
 * - Receive user commands from popup
 * - Coordinate offscreen document lifecycle
 * - Track capture state and session identity
 * - Relay gain/status messages between popup and offscreen
 * 
 * No continuous DSP here.
 */

import {
  MessageType,
  CaptureStatus,
  StartCaptureMsg,
  StopCaptureMsg,
  SetGainMsg,
  GetStatusMsg,
  HearAudioNowMsg,
  CancelOverrideMsg,
  InitCaptureMsg,
  DestroyCaptureMsg,
  SetGainOffscreenMsg,
  CaptureStartedMsg,
  CaptureStoppedMsg,
  CaptureErrorMsg,
  LevelUpdateMsg,
  StatusResponseMsg,
  generateSessionId,
} from "./shared/types";

// ─── State ────────────────────────────────────────────────────────────────────

interface MuterState {
  status: CaptureStatus;
  sessionId: string | null;
  tabId: number | null;
  gain: number;
  overrideActive: boolean;
  overrideRemainingMs: number;
  level: number;
  peak: number;
  error: string | null;
}

const state: MuterState = {
  status: CaptureStatus.STOPPED,
  sessionId: null,
  tabId: null,
  gain: 1.0,
  overrideActive: false,
  overrideRemainingMs: 0,
  level: 0,
  peak: 0,
  error: null,
};

// The audio page is a hidden extension page (a background tab) that owns
// chrome.tabCapture + the audio graph. It is the only context where both are
// available (offscreen docs lack chrome.tabCapture; the SW lacks AudioContext).
//
// We deliberately do NOT track the tab id and do NOT require the "tabs"
// permission: the single source of truth for "is a working audio page alive?"
// is the broadcast AUDIO_PAGE_PING below. chrome.tabs.create() works without the
// tabs permission, and the page keeps running independently of the service
// worker (which is stateless across restarts anyway), so a liveness ping is all
// we need — it also self-heals a page the user closed.
const AUDIO_PAGE_URL = "audio/audio.html";

// Broadcast a ping. Resolves true if some audio page answers — i.e. one is open
// and its message listener is registered. Safe across SW restarts: we never
// rely on remembering a tab id, only on the page still being reachable.
function probeAudioPage(): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 2000);
    try {
      chrome.runtime.sendMessage({ type: MessageType.AUDIO_PAGE_PING }, (resp) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) return resolve(false);
        resolve(!!resp && resp.ok === true);
      });
    } catch {
      clearTimeout(timeout);
      resolve(false);
    }
  });
}

async function ensureAudioPage(): Promise<void> {
  // Fast path: a working audio page is already open (from this or a previous
  // SW lifetime, or because the user opened it). No need to open a second one.
  if (await probeAudioPage()) return;

  // Open the hidden page and wait for it to load + register its listener.
  // It broadcasts AUDIO_PAGE_READY on load (repeatedly, so a listener that
  // attaches mid-load still catches it). We resolve as soon as we see that.
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(readyListener);
      resolve();
    };
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(readyListener);
      reject(new Error("Timed out waiting for the audio page to load"));
    }, 8000);

    const readyListener = (message: any) => {
      if (message?.type === MessageType.AUDIO_PAGE_READY) finish();
    };
    chrome.runtime.onMessage.addListener(readyListener);

    chrome.tabs.create({
      url: chrome.runtime.getURL(AUDIO_PAGE_URL),
      active: false,
      pinned: true,
    }).catch((err) => {
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(readyListener);
      reject(err);
    });
  });
}

// ─── Override Timer ──────────────────────────────────────────────────────────

function startOverrideTimer(durationMs: number): void {
  clearOverrideTimer();
  state.overrideActive = true;
  state.overrideRemainingMs = durationMs;

  overrideTimer = setInterval(() => {
    state.overrideRemainingMs -= 1000;
    if (state.overrideRemainingMs <= 0) {
      clearOverrideTimer();
      if (state.status === CaptureStatus.MUTED_AD) {
        sendToAudioPage({ type: MessageType.SET_GAIN_OFFSCREEN, gain: 0.0 });
        state.gain = 0.0;
      }
    }
  }, 1000);
}

function clearOverrideTimer(): void {
  if (overrideTimer) {
    clearInterval(overrideTimer);
    overrideTimer = null;
  }
  state.overrideActive = false;
  state.overrideRemainingMs = 0;
}

// ─── Message Relay ────────────────────────────────────────────────────────────

// Broadcast to the audio page (and any other extension page; only the audio
// page acts on these types). A tab id is not required because
// chrome.runtime.sendMessage reaches all extension contexts by broadcast.
function sendToAudioPage(msg: object): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function getStatusResponse(): StatusResponseMsg {
  return {
    type: MessageType.STATUS_RESPONSE,
    status: state.status,
    sessionId: state.sessionId ?? undefined,
    gain: state.gain,
    overrideActive: state.overrideActive,
    overrideRemainingMs: state.overrideRemainingMs,
    level: state.level,
    peak: state.peak,
    error: state.error ?? undefined,
  };
}
// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: any, _sender, sendResponse) => {
    switch (message.type) {
      case MessageType.START_CAPTURE: {
        const msg = message as StartCaptureMsg;
        handleStartCapture(msg.tabId).then((res) => sendResponse(res));
        return true;
      }

      case MessageType.STOP_CAPTURE: {
        handleStopCapture().then((res) => sendResponse(res));
        return true;
      }

      case MessageType.SET_GAIN: {
        const msg = message as SetGainMsg;
        state.gain = msg.gain;
        if (msg.gain === 0.0) {
          state.status = CaptureStatus.MUTED_AD;
        } else if (state.status === CaptureStatus.MUTED_AD && !state.overrideActive) {
          state.status = CaptureStatus.LISTENING;
        }
        sendToAudioPage({ type: MessageType.SET_GAIN_OFFSCREEN, gain: msg.gain });
        sendResponse(getStatusResponse());
        return true;
      }

      case MessageType.HEAR_AUDIO_NOW: {
        const msg = message as HearAudioNowMsg;
        const duration = msg.durationMs ?? 60_000;
        state.gain = 1.0;
        sendToAudioPage({ type: MessageType.SET_GAIN_OFFSCREEN, gain: 1.0 });
        startOverrideTimer(duration);
        sendResponse(getStatusResponse());
        return true;
      }

      case MessageType.CANCEL_OVERRIDE: {
        clearOverrideTimer();
        if (state.status === CaptureStatus.MUTED_AD) {
          state.gain = 0.0;
          sendToAudioPage({ type: MessageType.SET_GAIN_OFFSCREEN, gain: 0.0 });
        }
        sendResponse(getStatusResponse());
        return true;
      }

      case MessageType.GET_STATUS: {
        sendResponse(getStatusResponse());
        return false;
      }

      // ── From Audio Page (capture / level events) ──────────────────────
      // (AUDIO_PAGE_READY is consumed by the ephemeral listener in
      //  ensureAudioPage; nothing to do here.)
      case MessageType.CAPTURE_STARTED: {
        const msg = message as CaptureStartedMsg;
        state.status = CaptureStatus.LISTENING;
        state.sessionId = msg.sessionId;
        state.error = null;
        sendResponse({ ok: true });
        return false;
      }

      case MessageType.CAPTURE_STOPPED: {
        state.status = CaptureStatus.STOPPED;
        state.sessionId = null;
        state.level = 0;
        state.peak = 0;
        clearOverrideTimer();
        sendResponse({ ok: true });
        return false;
      }

      case MessageType.CAPTURE_ERROR: {
        const msg = message as CaptureErrorMsg;
        state.status = CaptureStatus.ERROR_BYPASS;
        state.error = msg.error;
        state.gain = 1.0;
        sendToAudioPage({ type: MessageType.SET_GAIN_OFFSCREEN, gain: 1.0 });
        sendResponse({ ok: true });
        return false;
      }

      case MessageType.LEVEL_UPDATE: {
        const msg = message as LevelUpdateMsg;
        state.level = msg.level;
        state.peak = msg.peak;
        sendResponse({ ok: true });
        return false;
      }

      default:
        return false;
    }
  }
);

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleStartCapture(tabId: number): Promise<StatusResponseMsg> {
  try {
    state.error = null;
    await ensureAudioPage();

    const sessionId = generateSessionId();
    state.sessionId = sessionId;
    state.tabId = tabId;
    state.gain = 1.0;
    state.level = 0;
    state.peak = 0;

    await new Promise((r) => setTimeout(r, 50));

    const initMsg: InitCaptureMsg = {
      type: MessageType.INIT_CAPTURE,
      tabId,
      sessionId,
    };
    sendToAudioPage(initMsg);

    await waitForStatus(CaptureStatus.LISTENING, 5000);
    return getStatusResponse();
  } catch (err: any) {
    state.status = CaptureStatus.ERROR_BYPASS;
    state.error = err?.message ?? "Failed to start capture";
    return getStatusResponse();
  }
}

async function handleStopCapture(): Promise<StatusResponseMsg> {
  try {
    sendToAudioPage({ type: MessageType.DESTROY_CAPTURE });
    await new Promise((r) => setTimeout(r, 100));

    state.status = CaptureStatus.STOPPED;
    state.sessionId = null;
    state.tabId = null;
    state.level = 0;
    state.peak = 0;
    clearOverrideTimer();
    return getStatusResponse();
  } catch (err: any) {
    state.error = err?.message ?? "Failed to stop capture";
    return getStatusResponse();
  }
}

function waitForStatus(target: CaptureStatus, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (state.status === target) {
        clearInterval(interval);
        resolve();
      } else if (state.status === CaptureStatus.ERROR_BYPASS) {
        clearInterval(interval);
        reject(new Error(state.error ?? "Capture error"));
      }
    };
    const interval = setInterval(check, 50);
    setTimeout(() => {
      clearInterval(interval);
      reject(new Error("Timeout waiting for capture to start"));
    }, timeoutMs);
  });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log("[muter] Extension installed.");
});

// Note: if the user closes the audio page tab, nothing to clean up here — the
// page's own `pagehide` handler tears down its audio graph, and the next Start
// finds no live page (probeAudioPage() → false) and opens a fresh one.
