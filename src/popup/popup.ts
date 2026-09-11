/**
 * Popup UI — Audio Ad Muter
 * 
 * Controls, status display, level meter, and diagnostics.
 * Polls service worker for status at 10Hz (100ms intervals).
 */

import { MessageType, CaptureStatus, StatusResponseMsg } from "../shared/types";

// ─── DOM References ──────────────────────────────────────────────────────────

const btnStart = document.getElementById("btn-start") as HTMLButtonElement;
const btnStop = document.getElementById("btn-stop") as HTMLButtonElement;
const btnMute = document.getElementById("btn-mute") as HTMLButtonElement;
const btnUnmute = document.getElementById("btn-unmute") as HTMLButtonElement;
const btnCancelOverride = document.getElementById("btn-cancel-override") as HTMLButtonElement;

const statusBadge = document.getElementById("status-badge") as HTMLElement;
const levelFill = document.getElementById("level-fill") as HTMLElement;
const peakMarker = document.getElementById("peak-marker") as HTMLElement;
const levelValue = document.getElementById("level-value") as HTMLElement;
const sessionIdEl = document.getElementById("session-id") as HTMLElement;
const gainValueEl = document.getElementById("gain-value") as HTMLElement;

const muteSection = document.getElementById("mute-section") as HTMLElement;
const overrideSection = document.getElementById("override-section") as HTMLElement;
const overrideCountdown = document.getElementById("override-countdown") as HTMLElement;
const errorSection = document.getElementById("error-section") as HTMLElement;
const errorText = document.getElementById("error-text") as HTMLElement;

// ─── State ────────────────────────────────────────────────────────────────────

let currentStatus: CaptureStatus = CaptureStatus.STOPPED;
let pollInterval: ReturnType<typeof setInterval> | null = null;

// ─── UI Updates ──────────────────────────────────────────────────────────────

function updateUI(status: StatusResponseMsg): void {
  currentStatus = status.status;

  // Badge
  statusBadge.className = "badge";
  switch (status.status) {
    case CaptureStatus.STOPPED:
      statusBadge.classList.add("badge-stopped");
      statusBadge.textContent = "STOPPED";
      break;
    case CaptureStatus.LISTENING:
      statusBadge.classList.add("badge-listening");
      statusBadge.textContent = "LISTENING";
      break;
    case CaptureStatus.MUTED_AD:
      statusBadge.classList.add("badge-muted");
      statusBadge.textContent = status.overrideActive ? "OVERRIDE" : "MUTED";
      break;
    case CaptureStatus.ERROR_BYPASS:
      statusBadge.classList.add("badge-error");
      statusBadge.textContent = "ERROR";
      break;
  }

  // Level meter (convert RMS to percentage and dB)
  const pct = Math.min(status.level * 100, 100);
  levelFill.style.width = `${pct}%`;
  peakMarker.style.left = `${Math.min(status.peak * 100, 100)}%`;

  // Convert to dB for display
  const db = status.level > 0.0001 ? (20 * Math.log10(status.level)).toFixed(1) : "-\u221E";
  levelValue.textContent = `${db} dB`;

  // Session info
  sessionIdEl.textContent = status.sessionId ?? "\u2014";
  gainValueEl.textContent = status.gain.toFixed(1);

  // Button states
  const isRunning = currentStatus !== CaptureStatus.STOPPED;
  btnStart.disabled = isRunning;
  btnStop.disabled = !isRunning;

  // Mute section visibility
  muteSection.style.display = isRunning ? "flex" : "none";
  if (isRunning) {
    const isMuted = status.gain === 0.0 && !status.overrideActive;
    btnMute.disabled = isMuted || status.overrideActive;
    btnUnmute.disabled = !isMuted;
  }

  // Override section
  overrideSection.style.display = status.overrideActive ? "flex" : "none";
  if (status.overrideActive) {
    const secs = Math.ceil(status.overrideRemainingMs / 1000);
    overrideCountdown.textContent = `${secs}s`;
  }

  // Error display
  if (status.error && currentStatus === CaptureStatus.ERROR_BYPASS) {
    errorSection.style.display = "block";
    errorText.textContent = status.error;
  } else {
    errorSection.style.display = "none";
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────────

async function pollStatus(): Promise<void> {
  try {
    const response: StatusResponseMsg = await chrome.runtime.sendMessage({
      type: MessageType.GET_STATUS,
    });
    if (response) {
      updateUI(response);
    }
  } catch {
    // Service worker may be waking up; ignore transient errors
  }
}

function startPolling(): void {
  stopPolling();
  pollStatus();
  pollInterval = setInterval(pollStatus, 100);
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

btnStart.addEventListener("click", async () => {
  btnStart.disabled = true;
  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab found");

    await chrome.runtime.sendMessage({
      type: MessageType.START_CAPTURE,
      tabId: tab.id,
    });
  } catch (err: any) {
    console.error("[muter:popup] Start failed:", err);
  }
});

btnStop.addEventListener("click", async () => {
  btnStop.disabled = true;
  await chrome.runtime.sendMessage({ type: MessageType.STOP_CAPTURE });
});

btnMute.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: MessageType.SET_GAIN, gain: 0.0 });
});

btnUnmute.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: MessageType.HEAR_AUDIO_NOW });
});

btnCancelOverride.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: MessageType.CANCEL_OVERRIDE });
});

// ─── Init ─────────────────────────────────────────────────────────────────────

startPolling();

// Stop polling when popup closes (pagehide)
window.addEventListener("pagehide", stopPolling);
