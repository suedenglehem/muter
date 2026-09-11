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

let offscreenReady = false;
let overrideTimer: ReturnType<typeof setInterval> | null = null;

// ─── Offscreen Document Management ───────────────────────────────────────────

async function ensureOffscreen(): Promise<void> {
  if (offscreenReady) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as any],
  });

  if (existingContexts.length > 0) {
    offscreenReady = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["AUDIO_PLAYBACK" as any],
    justification: "Audio capture, analysis, and gain control for ad muting",
  });

  offscreenReady = true;
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
        sendToOffscreen({ type: MessageType.SET_GAIN_OFFSCREEN, gain: 0.0 });
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

function sendToOffscreen(msg: object): void {
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
        sendToOffscreen({ type: MessageType.SET_GAIN_OFFSCREEN, gain: msg.gain });
        sendResponse(getStatusResponse());
        return true;
      }

      case MessageType.HEAR_AUDIO_NOW: {
        const msg = message as HearAudioNowMsg;
        const duration = msg.durationMs ?? 60_000;
        state.gain = 1.0;
        sendToOffscreen({ type: MessageType.SET_GAIN_OFFSCREEN, gain: 1.0 });
        startOverrideTimer(duration);
        sendResponse(getStatusResponse());
        return true;
      }

      case MessageType.CANCEL_OVERRIDE: {
        clearOverrideTimer();
        if (state.status === CaptureStatus.MUTED_AD) {
          state.gain = 0.0;
          sendToOffscreen({ type: MessageType.SET_GAIN_OFFSCREEN, gain: 0.0 });
        }
        sendResponse(getStatusResponse());
        return true;
      }

      case MessageType.GET_STATUS: {
        sendResponse(getStatusResponse());
        return false;
      }

      // ── From Offscreen ──────────────────────────────────────────────────
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
        sendToOffscreen({ type: MessageType.SET_GAIN_OFFSCREEN, gain: 1.0 });
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
    await ensureOffscreen();

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
    sendToOffscreen(initMsg);

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
    sendToOffscreen({ type: MessageType.DESTROY_CAPTURE });
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
