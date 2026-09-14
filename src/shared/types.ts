/**
 * Shared type definitions for Audio Ad Muter extension.
 * Used across service worker, offscreen document, worklet, and popup.
 */

// ─── Message Types ────────────────────────────────────────────────────────────

export enum MessageType {
  // Popup → Service Worker
  START_CAPTURE = "START_CAPTURE",
  STOP_CAPTURE = "STOP_CAPTURE",
  SET_GAIN = "SET_GAIN",
  GET_STATUS = "GET_STATUS",
  HEAR_AUDIO_NOW = "HEAR_AUDIO_NOW",
  CANCEL_OVERRIDE = "CANCEL_OVERRIDE",

  // Service Worker → Audio Page
  INIT_CAPTURE = "INIT_CAPTURE",
  DESTROY_CAPTURE = "DESTROY_CAPTURE",
  SET_GAIN_OFFSCREEN = "SET_GAIN_OFFSCREEN",

  // Audio Page → Service Worker
  // Sent when the audio page has loaded and its message listener is registered.
  // Resent a couple of times so a service worker that (re)starts mid-load still
  // observes it.
  AUDIO_PAGE_READY = "AUDIO_PAGE_READY",

  // Service Worker → Audio Page
  // Round-trip the SW uses after a (re)start to confirm an already-open audio
  // page is still alive and listening. The page answers { ok: true }.
  AUDIO_PAGE_PING = "AUDIO_PAGE_PING",

  // Audio Page → Service Worker (responses / events)
  CAPTURE_STARTED = "CAPTURE_STARTED",
  CAPTURE_STOPPED = "CAPTURE_STOPPED",
  CAPTURE_ERROR = "CAPTURE_ERROR",
  LEVEL_UPDATE = "LEVEL_UPDATE",
  STATUS_RESPONSE = "STATUS_RESPONSE",

  // Worklet → Offscreen (via postMessage)
  WORKLET_LEVEL = "WORKLET_LEVEL",
}

// ─── Message Payloads ─────────────────────────────────────────────────────────

export interface StartCaptureMsg {
  type: MessageType.START_CAPTURE;
  tabId: number;
}

export interface StopCaptureMsg {
  type: MessageType.STOP_CAPTURE;
}

export interface SetGainMsg {
  type: MessageType.SET_GAIN;
  gain: number; // 0.0 to 1.0
}

export interface HearAudioNowMsg {
  type: MessageType.HEAR_AUDIO_NOW;
  durationMs?: number; // default 60_000
}

export interface CancelOverrideMsg {
  type: MessageType.CANCEL_OVERRIDE;
}

export interface GetStatusMsg {
  type: MessageType.GET_STATUS;
}

export interface AudioPageReadyMsg {
  type: MessageType.AUDIO_PAGE_READY;
}

export interface InitCaptureMsg {
  type: MessageType.INIT_CAPTURE;
  tabId: number;
  sessionId: string;
}

export interface DestroyCaptureMsg {
  type: MessageType.DESTROY_CAPTURE;
}

export interface SetGainOffscreenMsg {
  type: MessageType.SET_GAIN_OFFSCREEN;
  gain: number;
}

export interface CaptureStartedMsg {
  type: MessageType.CAPTURE_STARTED;
  sessionId: string;
  sampleRate: number;
  channels: number;
}

export interface CaptureStoppedMsg {
  type: MessageType.CAPTURE_STOPPED;
}

export interface CaptureErrorMsg {
  type: MessageType.CAPTURE_ERROR;
  error: string;
  code?: string;
}

export interface LevelUpdateMsg {
  type: MessageType.LEVEL_UPDATE;
  level: number; // RMS 0..1
  peak: number;  // Peak 0..1
}

export interface StatusResponseMsg {
  type: MessageType.STATUS_RESPONSE;
  status: CaptureStatus;
  sessionId?: string;
  gain: number;
  overrideActive: boolean;
  overrideRemainingMs: number;
  level: number;
  peak: number;
  error?: string;
}

// ─── State ────────────────────────────────────────────────────────────────────

export enum CaptureStatus {
  STOPPED = "STOPPED",
  LISTENING = "LISTENING",
  MUTED_AD = "MUTED_AD",
  ERROR_BYPASS = "ERROR_BYPASS",
}

// ─── Worklet Messages (via postMessage) ──────────────────────────────────────

export interface WorkletLevelData {
  type: MessageType.WORKLET_LEVEL;
  rms: number;
  peak: number;
  sampleRate: number;
  timestamp: number; // AudioContext currentTime
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export function generateSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
