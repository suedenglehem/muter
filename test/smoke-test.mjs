// M1 headless smoke test — drives the extension via CDP (no npm deps; Node 20+
// built-in fetch/WebSocket).
//
// Run:  npm test                 (uses $CHROME_PATH, required)
//       CHROME_PATH=/path/chrome.exe node test/smoke-test.mjs
//
// REQUIREMENTS:
// - $CHROME_PATH must point at a Chrome build that honors --load-extension.
//   STABLE Google Chrome IGNORES that flag, so use Chrome for Testing or a
//   dev/beta/canary channel build. (Download: chrome-for-testing JSON endpoint,
//   win64/linux64/mac-arm64 per platform.)
// - A build in ../dist (npm run build).
// - Internet access (opens a real YouTube video).
//
// EXPECTED RESULT (Chrome 153+): several PASS + several SKIP. Chrome requires
// the extension to be user-invoked on the target tab before tab capture — a
// gesture only a real human click produces. Headless therefore verifies the
// whole chain up to that gate (extension loads, popup works, SW opens the
// audio page, capture() is invoked) and SKIPs the capture-dependent checks.
// Exit code 0 = no failures (skips are expected).
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME_PATH;
if (!CHROME) {
  console.error("CHROME_PATH env var is required — point it at a Chrome for Testing (or dev/beta/canary) binary.\nStable Google Chrome ignores --load-extension and cannot run this test.");
  process.exit(2);
}
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PORT = Number(process.env.CDP_PORT || 9333);
const YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const USER_DATA = join(os.tmpdir(), `muter-smoke-${Date.now()}`);

let chromeProc;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}
function skip(name, detail = "") {
  results.push({ name, ok: true, skip: true });
  console.log(`SKIP  ${name}${detail ? `  [${detail}]` : ""}`);
}

async function httpJson(path) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return r.json();
}

class Cdp {
  constructor(wsUrl, label) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.label = label; }
  connect() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error(`${this.label} ws error`)); }); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => this.pending.set(id, res));
  }
  onMessage(fn) {
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m.result ?? {}); this.pending.delete(m.id); }
      fn(m);
    };
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval exception: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result?.value;
  }
}

async function attachTarget(wsUrl, label) {
  const c = new Cdp(wsUrl, label);
  await c.connect();
  c.onMessage(() => {});
  await c.send("Runtime.enable");
  return c;
}

async function findTarget(pred, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const targets = await httpJson("/json/list");
    const hit = targets.find(pred);
    if (hit) return hit;
    await sleep(500);
  }
  throw new Error("target not found: " + pred.toString().slice(0, 60));
}

function cleanup() {
  try { chromeProc && chromeProc.kill(); } catch {}
}
process.on("exit", cleanup);

async function main() {

  console.log("Starting headless Chrome...");
  chromeProc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    "--headless=new",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--enable-features=TabCapture",
    "--window-size=1280,800",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  chromeProc.stdout.on("data", (d) => process.env.VERBOSE && console.log("[chrome]", d.toString().trim()));
  chromeProc.stderr.on("data", (d) => process.env.VERBOSE && console.error("[chrome:err]", d.toString().trim()));

  // Wait for CDP endpoint
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { await httpJson("/json/version"); up = true; break; } catch { await sleep(500); }
  }
  if (!up) throw new Error("CDP endpoint never came up");
  console.log("Chrome CDP is up.");

  // Find the extension service worker target (appears after load).
  // NOTE: must match the HYPHENATED name — component extensions (e.g. Google
  // Network Speech) use "service_worker.js" (underscore) and would shadow ours.
  let swTarget;
  try {
    swTarget = await findTarget((t) => t.type === "service_worker" && t.url.includes("service-worker.js"));
  } catch {
    const all = await httpJson("/json/list");
    console.error("All targets on SW timeout:", JSON.stringify(all.map(t => ({type: t.type, url: t.url.slice(0,90)})), null, 1));
    throw new Error("our service-worker.js target never appeared — extension may not have loaded");
  }
  console.log(`Extension SW: ${swTarget.url}`);
  const sw = await attachTarget(swTarget.webSocketDebuggerUrl, "sw");

  // Verify this is OUR extension, not some other extension with a similar file name.
  const swManifestName = await sw.eval(`chrome.runtime.getManifest().name`).catch(() => "?");
  console.log(`SW manifest name: ${swManifestName}`);
  if (swManifestName !== "Audio Ad Muter") {
    throw new Error(`Wrong service worker attached (manifest name "${swManifestName}")`);
  }

  // Collect SW console logs for diagnostics
  const swLogs = [];
  sw.onMessage((m) => { if (m.method === "Runtime.consoleAPICalled") swLogs.push(m.params.args.map(a => a.value ?? a.description).join(" ")); });

  // Open YouTube in the default tab
  const pageTarget = await findTarget((t) => t.type === "page");
  const ytTargetId = pageTarget.id;
  const page = await attachTarget(pageTarget.webSocketDebuggerUrl, "page");
  await page.send("Page.enable");
  await page.eval(`location.href = ${JSON.stringify(YT_URL)}; true`);

  // Wait for the video element to exist and be playing
  let videoReady = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const st = await page.eval(`(() => {
      const v = document.querySelector("video");
      if (!v) return "no-video";
      return JSON.stringify({ paused: v.paused, t: v.currentTime, w: v.videoWidth });
    })()`).catch(() => "eval-err");
    if (process.env.VERBOSE) console.log(`  [${i}] video state: ${st}`);
    try {
      const s = JSON.parse(st);
      if (s && !s.paused) { videoReady = true; break; }
    } catch {}
  }
  check("YouTube video is playing", videoReady, "video element present and not paused");

  // Open the popup page directly in a fresh tab (committing the tab AT the
  // extension URL). Navigating an about:blank tab to a chrome-extension:// URL
  // is blocked with ERR_BLOCKED_BY_CLIENT, so create the target at the URL.
  const extId = swTarget.url.match(/chrome-extension:\/\/([^/]+)/)[1];
  const popupUrl = `chrome-extension://${extId}/popup/popup.html`;

  const browserWsUrl = (await httpJson("/json/version")).webSocketDebuggerUrl;
  const bw = new Cdp(browserWsUrl, "browser");
  await bw.connect();
  let bwId = 0;
  const bwPending = new Map();
  bw.ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && bwPending.has(m.id)) { bwPending.get(m.id)(m.result ?? {}); bwPending.delete(m.id); }
  };
  const bwSend = (method, params = {}) => new Promise((res) => { const id = ++bwId; bw.ws.send(JSON.stringify({ id, method, params })); bwPending.set(id, res); });

  const { targetId: popupTargetId } = await bwSend("Target.createTarget", { url: popupUrl });
  const popupWsUrl = (await findTarget((t) => t.id === popupTargetId)).webSocketDebuggerUrl;
  const popup = await attachTarget(popupWsUrl, "popup");
  await popup.send("Page.enable");
  await popup.send("Log.enable").catch(() => {});
  const popupLogs = [];
  popup.onMessage((m) => {
    if (m.method === "Log.entryAdded") popupLogs.push(m.params.entry.level + ": " + m.params.entry.text.slice(0, 200));
  });

  // Wait for popup to be interactive (buttons present)
  let popupReady = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const st = await popup.eval(`JSON.stringify({ url: location.href, btn: !!document.getElementById("btn-start"), body: (document.body ? document.body.innerText : "").slice(0, 120) })`).catch((e) => "eval-err:" + e.message.slice(0, 80));
    if (process.env.VERBOSE) console.log(`  popup[${i}]: ${st}`);
    if (st && st.includes('"btn":true')) { popupReady = true; break; }
  }
  if (!popupReady) { console.log("popup logs:", JSON.stringify(popupLogs.slice(-15), null, 1)); }
  check("Popup page loaded", popupReady, "buttons present");

  // ── Click Start Monitoring ────────────────────────────────────────────────
  // The popup's btn-start uses tabs.query({active:true, currentWindow:true}).
  // In real use the action popup anchors to the YT tab, so it's active. Here
  // the popup is its own tab and is currently active, so activate the YT tab.
  await bwSend("Target.activateTarget", { targetId: ytTargetId }).catch((e) => console.log("activateTarget:", e.message));
  await sleep(500);
  await popup.eval(`document.getElementById("btn-start").click(); true`);
  console.log("Clicked Start Monitoring...");

  // ── Verify the audio page (hidden extension page) opened ──────────────────
  // Capture + audio graph live in a hidden extension page
  // (chrome-extension://…/audio/audio.html), not an offscreen document
  // (chrome.tabCapture does not exist there). Headless can verify this.
  let audioPageTarget = null;
  try { audioPageTarget = await findTarget((t) => /audio\/audio\.html/.test(t.url), 8000); } catch {}
  check("Audio page (hidden tab) opened", !!audioPageTarget, audioPageTarget ? audioPageTarget.url : "no audio/audio.html target");

  let status = null;
  let errorText = "";
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const badge = await popup.eval(`document.getElementById("status-badge").textContent`).catch(() => "?");
    if (badge === "LISTENING") { status = "LISTENING"; break; }
    if (badge === "ERROR") {
      status = "ERROR";
      errorText = await popup.eval(`document.getElementById("error-text").textContent`).catch(() => "");
      break;
    }
  }

  // Chrome requires the extension to be user-invoked on the target tab before
  // tab capture (a deliberate anti-abuse gate tied to a real click). Headless
  // cannot produce that gesture, so this specific error is EXPECTED here and
  // means the plumbing worked up to the human-only gate.
  const isInvocationGate = /not been invoked|invoked for the current page/i.test(errorText);
  if (status === "LISTENING") {
    check("Status reaches LISTENING", true, "badge=LISTENING");
  } else if (status === "ERROR" && isInvocationGate) {
    skip("Status reaches LISTENING", "expected in headless — Chrome requires the extension to be user-invoked on the tab; a human must click the popup. Got: " + errorText.slice(0, 80));
  } else {
    check("Status reaches LISTENING", false, `badge=${status} error="${(errorText || "n/a").slice(0, 80)}"`);
  }

  // Sample the level meter from the actual DOM (popup polls GET_STATUS at 10Hz
  // and renders level-fill width as % of RMS — the true end-to-end signal).
  const sampleLevel = () => popup.eval(`parseFloat(document.getElementById("level-fill").style.width) || 0`).catch(() => 0);
  // Read badge + countdown atomically (one eval) to avoid a 10Hz re-render race.
  const readUI = () => popup.eval(`JSON.stringify({
    badge: document.getElementById("status-badge").textContent,
    countdown: document.getElementById("override-countdown").textContent,
    gain: document.getElementById("gain-value").textContent
  })`).then(s => { try { return JSON.parse(s); } catch { return {}; } }).catch(() => ({}));

  // ── Post-Start flow ────────────────────────────────────────────────────────
  // These checks exercise the capture-dependent M1 behavior. They only make
  // sense once capture is actually LISTENING; in headless the invocation gate
  // blocks that, so we SKIP the block as a unit. (A delayed CAPTURE_ERROR from
  // the failed headless capture can also flip the popup to ERROR, so we don't
  // run the flow on top of an error state either.)
  if (status === "LISTENING") {
    const widths = [];
    for (let i = 0; i < 12; i++) { await sleep(400); widths.push(await sampleLevel()); }
    const maxPct = Math.max(...widths);
    check("Level meter receives non-zero audio", maxPct > 0.5, `maxFill%=${maxPct.toFixed(1)}`);

    await popup.eval(`document.getElementById("btn-mute").click(); true`);
    await sleep(800);
    let ui = await readUI();
    check("Mute -> badge MUTED", ui.badge === "MUTED", `badge=${ui.badge} gain=${ui.gain}`);

    // Analysis taps the source BEFORE the gain node, so the meter keeps moving
    // while output is silent.
    const mutedWidths = [];
    for (let i = 0; i < 8; i++) { await sleep(400); mutedWidths.push(await sampleLevel()); }
    check("Analysis continues while muted", Math.max(...mutedWidths) > 0.5, `muted maxFill%=${Math.max(...mutedWidths).toFixed(1)}`);

    await popup.eval(`document.getElementById("btn-unmute").click(); true`);
    let okOverride = false;
    for (let i = 0; i < 10; i++) { await sleep(300); ui = await readUI(); if (ui.badge === "OVERRIDE" && /\d+s/.test(ui.countdown)) { okOverride = true; break; } }
    check("Hear Audio -> OVERRIDE with countdown", okOverride, `badge=${ui.badge} countdown=${ui.countdown}`);

    await popup.eval(`document.getElementById("btn-cancel-override").click(); true`);
    await sleep(800);
    ui = await readUI();
    check("Cancel override -> MUTED again", ui.badge === "MUTED", `badge=${ui.badge}`);

    await popup.eval(`document.getElementById("btn-stop").click(); true`);
    await sleep(1000);
    const badgeStopped = await popup.eval(`document.getElementById("status-badge").textContent`).catch(() => "?");
    check("Stop -> STOPPED", badgeStopped === "STOPPED", `badge=${badgeStopped}`);
  } else {
    for (const name of [
      "Level meter receives non-zero audio",
      "Mute -> badge MUTED",
      "Analysis continues while muted",
      "Hear Audio -> OVERRIDE with countdown",
      "Cancel override -> MUTED again",
      "Stop -> STOPPED",
    ]) {
      skip(name, "requires LISTENING; headless blocked by the user-invocation gate — verify in a real browser run");
    }
  }

  // ── Diagnostics: SW console logs ───────────────────────────────────────────
  const interesting = swLogs.filter(l => /muter|error|Error/i.test(l));
  if (interesting.length) {
    console.log("\n--- Service worker log (filtered) ---");
    for (const l of interesting.slice(-25)) console.log("  " + l);
  }

  const failed = results.filter(r => !r.ok).length;
  const skipped = results.filter(r => r.skip).length;
  const passed = results.length - failed - skipped;
  console.log(`\n=== ${passed} passed, ${skipped} skipped (human-only), ${failed} failed ===`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error("FATAL:", e.message ?? e); process.exitCode = 2; });
setTimeout(() => { console.log("GLOBAL TIMEOUT"); process.exit(3); }, 180000).unref();
