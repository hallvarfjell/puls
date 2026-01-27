
/* app.js – HR: update banner + HR BLE + FTMS speed + manual per-drag speed */

const APP_VERSION = "v1.4.1 (2026-01-26)";
document.getElementById("versionTag").textContent = APP_VERSION;

// ----- Chart constants
const HR_WINDOW_MS = 15 * 60 * 1000;
const MAX_WINDOW_POINTS = 15 * 60 * 3;
const CHART_FPS_MS = 250;

// ----- DOM helper
const $ = (id) => document.getElementById(id);

// ----- Service Worker update banner flow (top)
async function setupUpdateBanner() {
  if (!("serviceWorker" in navigator)) return;

  const banner = $("updateBanner");
  const btnNow = $("updateNowBtn");
  const btnLater = $("updateLaterBtn");

  let refreshing = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  const reg = await navigator.serviceWorker.register("./sw.js");

  function showUpdate(registration) {
    banner.classList.remove("hidden");

    btnNow.onclick = () => {
      btnNow.textContent = "Oppdaterer…";
      btnNow.disabled = true;
      btnLater.disabled = true;
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
    };

    btnLater.onclick = () => banner.classList.add("hidden");
  }

  if (reg.waiting) showUpdate(reg);

  reg.addEventListener("updatefound", () => {
    const nw = reg.installing;
    if (!nw) return;
    nw.addEventListener("statechange", () => {
      if (nw.state === "installed" && navigator.serviceWorker.controller) {
        showUpdate(reg);
      }
    });
  });

  // periodic update check
  setInterval(() => reg.update().catch(()=>{}), 60 * 1000);
}

// ----- iOS notice (kept)
function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) ||
         (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isSafari() {
  const ua = navigator.userAgent;
  const isAppleWebKit = /AppleWebKit/.test(ua);
  const isChrome = /CriOS/.test(ua);
  const isFirefox = /FxiOS/.test(ua);
  const isEdge = /EdgiOS/.test(ua);
  return isAppleWebKit && !isChrome && !isFirefox && !isEdge;
}
function showIOSNotice(message) { const el = $("iosNotice"); el.textContent = message; el.classList.remove("hidden"); }
function hideIOSNotice() { $("iosNotice").classList.add("hidden"); }

// ----- Status
function setStatus(text) { $("statusText").textContent = text; }

// ----- BLE HR
let hrDevice = null;
let hrChar = null;

// ----- BLE treadmill FTMS
let tmDevice = null;
let tmChar = null;

// ----- Data
let lastHrTimestamp = 0;
let lastChartDraw = 0;

let windowPoints = [];   // {x,y} last 15min
let hrSamples = [];      // full session {ts,bpm,src}

// Speed
let speedNow = 0.0;
let lastFtmsEffectiveSpeed = 0.0;  // latest effective speed (rest forced 0)
let lastFtmsRawSpeed = 0.0;        // latest raw from treadmill
let speedSamples = [];             // {ts, kmh, effectiveKmh, src}

// Timer / laps
let timerRunning = false;
let timerTick = null;
let elapsedSec = 0;

let laps = [];           // {type, repIndex, startTs, endTs, max30bpm, speedKmh, speedManualKmh, speedSource}
let currentLap = null;

// Simulation
const rand = (() => { let x = 123456789 >>> 0; return () => ((x = (1664525 * x + 1013904223) >>> 0) / 4294967296); })();
let simBpm = 92;

// Canvas scaling
let canvasDpr = 1, canvasW = 0, canvasH = 0;

// Zones thresholds (custom BPM)
let zoneThresholds = { z1: 110, z2: 130, z3: 150, z4: 165, z5: 180 };

function readInt(id) {
  const v = parseInt($(id).value, 10);
  return Number.isFinite(v) ? v : 0;
}
function readFloat(id) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : 0;
}
function mmss(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function fmtTime(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2,"0")}`;
}

// ----- HR connect UI (discreet when connected)
function setHRButtonConnected(connected) {
  const btn = $("connectBtn");
  if (connected) {
    btn.classList.add("connected");
    btn.textContent = "HR ✅";
  } else {
    btn.classList.remove("connected");
    btn.textContent = "Koble til pulsbelte";
  }
}

// ----- Treadmill button UI
function setTreadmillButtonConnected(connected) {
  const btn = $("treadmillBtn");
  if (connected) {
    btn.classList.add("connected");
    btn.textContent = "Mølle ✅";
  } else {
    btn.classList.remove("connected");
    btn.textContent = "Mølle: Koble til";
  }
}

// ----- HR BLE
async function connectHR() {
  try {
    setStatus("Åpner HR-dialog…");
    hrDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: ["heart_rate"] }],
      optionalServices: ["battery_service"]
    });

    hrDevice.addEventListener("gattserverdisconnected", () => {
      hrChar = null;
      setHRButtonConnected(false);
      setStatus("HR frakoblet");
    });

    setStatus("Kobler HR…");
    const server = await hrDevice.gatt.connect();
    const service = await server.getPrimaryService("heart_rate");
    hrChar = await service.getCharacteristic("heart_rate_measurement");

    hrChar.addEventListener("characteristicvaluechanged", onHRNotify);
    await hrChar.startNotifications();

    setHRButtonConnected(true);
    setStatus("HR tilkoblet");
  } catch (e) {
    console.error(e);
    setStatus("HR-tilkobling feilet");
    alert("Kunne ikke koble til pulsbelte.");
  }
}

function parseHeartRate(value) {
  const flags = value.getUint8(0);
  const is16Bit = (flags & 0x01) !== 0;
  return is16Bit ? value.getUint16(1, true) : value.getUint8(1);
}

function onHRNotify(event) {
  const hr = parseHeartRate(event.target.value);
  onHrSample(Date.now(), hr, "ble");
}

// ----- FTMS treadmill connect
async function connectTreadmill() {
  try {
    const FTMS = "00001826-0000-1000-8000-00805f9b34fb";
    const TREADMILL_DATA = "00002acd-0000-1000-8000-00805f9b34fb";

    setStatus("Åpner mølle-dialog…");
    tmDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS] }]
    });

    tmDevice.addEventListener("gattserverdisconnected", () => {
      tmChar = null;
      setTreadmillButtonConnected(false);
      setStatus("Mølle frakoblet");
    });

    setStatus("Kobler mølle…");
    const server = await tmDevice.gatt.connect();
    const service = await server.getPrimaryService(FTMS);
    tmChar = await service.getCharacteristic(TREADMILL_DATA);

    tmChar.addEventListener("characteristicvaluechanged", onTreadmillNotify);
    await tmChar.startNotifications();

    setTreadmillButtonConnected(true);
    setStatus("Mølle tilkoblet");
  } catch (e) {
    console.error(e);
    setStatus("Mølle-tilkobling feilet");
    alert("Kunne ikke koble til mølle. FTMS varierer mellom modeller.");
  }
}

function onTreadmillNotify(event) {
  const dv = event.target.value;

  // Common FTMS observation: flags (2 bytes), instantaneous speed at bytes [2..3], in n/100 km/h. [1](https://www.codestudy.net/blog/can-ios-safari-access-bluetooth-device/)
  let speedRaw = 0;
  try {
    speedRaw = dv.getUint16(2, true);
  } catch {
    speedRaw = 0;
  }
  const kmh = speedRaw / 100.0;
  lastFtmsRawSpeed = kmh;

  // Effective speed: force 0 in rest (you hop off)
  const effective = (currentLap && currentLap.type === "rest") ? 0 : kmh;

  onSpeedSample(Date.now(), kmh, effective, "ftms");
}

function onSpeedSample(ts, kmh, effectiveKmh, src) {
  speedNow = effectiveKmh;
  $("speedNow").textContent = speedNow.toFixed(1);

  speedSamples.push({ ts, kmh, effectiveKmh, src });

  lastFtmsEffectiveSpeed = effectiveKmh;

  // If we are in a work lap and user hasn't manually set speed, keep updating candidate speed.
  if (currentLap && currentLap.type === "work" && !Number.isFinite(currentLap.speedManualKmh)) {
    currentLap.speedCandidateKmh = effectiveKmh; // “sluttfart” candidate
  }
}

// ----- HR sample pipeline
function onHrSample(ts, bpm, src) {
  lastHrTimestamp = ts;
  $("pulseValue").textContent = bpm;

  hrSamples.push({ ts, bpm, src });

  // Window points
  windowPoints.push({ x: ts, y: bpm });
  const cutoff = ts - HR_WINDOW_MS;
  while (windowPoints.length && windowPoints[0].x < cutoff) windowPoints.shift();
  if (windowPoints.length > MAX_WINDOW_POINTS) {
    windowPoints = windowPoints.slice(windowPoints.length - MAX_WINDOW_POINTS);
  }

  drawChartThrottled();
}

// seconds since last HR sample
setInterval(() => {
  const el = $("lastSeen");
  if (!lastHrTimestamp) el.textContent = "--";
  else el.textContent = String(Math.max(0, Math.floor((Date.now() - lastHrTimestamp) / 1000)));
}, 500);

// ----- Chart rendering (same as before)
function resizeCanvasToDisplaySize() {
  const canvas = $("hrCanvas");
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w === 0 || h === 0) return;

  if (canvasW !== w || canvasH !== h || canvasDpr !== dpr) {
    canvasW = w; canvasH = h; canvasDpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function drawChartThrottled() {
  const now = Date.now();
  if (now - lastChartDraw < CHART_FPS_MS) return;
  lastChartDraw = now;
  drawCanvasChart();
}

function drawCanvasChart() {
  resizeCanvasToDisplaySize();
  const canvas = $("hrCanvas");
  const ctx = canvas.getContext("2d");
  const w = canvasW, h = canvasH;
  if (!w || !h) return;

  ctx.clearRect(0, 0, w, h);

  const padL = 70, padR = 18, padT = 16, padB = 36;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const now = Date.now();
  const minX = now - HR_WINDOW_MS;
  const maxX = now;

  // Y: min/max ±10 in last 15 minutes
  let minY = 60, maxY = 180;
  if (windowPoints.length >= 2) {
    let lo = Infinity, hi = -Infinity;
    for (const p of windowPoints) { if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; }
    minY = Math.max(30, Math.floor(lo - 10));
    maxY = Math.min(240, Math.ceil(hi + 10));
    if (maxY - minY < 20) maxY = minY + 20;
  }

  const xToPx = (x) => padL + ((x - minX) / (maxX - minX)) * plotW;
  const yToPx = (y) => padT + (1 - (y - minY) / (maxY - minY)) * plotH;

  // grid + labels
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= 5; i++) {
    const y = padT + (i / 5) * plotH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    const yVal = Math.round(maxY - (i / 5) * (maxY - minY));
    ctx.fillText(String(yVal), padL - 10, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i <= 5; i++) {
    const x = padL + (i / 5) * plotW;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    const minsAgo = Math.round((1 - i / 5) * 15);
    ctx.fillText(`-${minsAgo}m`, x, padT + plotH + 10);
  }

  if (windowPoints.length >= 2) {
    ctx.strokeStyle = "#27f5a4";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    let started = false;
    for (const p of windowPoints) {
      const x = xToPx(p.x);
      const y = yToPx(p.y);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// ----- Timer logic
function shouldSimulate() {
  const mode = $("simMode").value;
  if (mode === "force") return true;
  if (mode === "off") return false;
  return !("bluetooth" in navigator) || !hrChar;
}

function startTimer() {
  if (timerRunning) return;

  timerRunning = true;
  elapsedSec = 0;

  laps = [];
  currentLap = null;

  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;

  const warm = readInt("warmupSec");
  if (warm > 0) startLap("warmup", 0);
  else startLap("work", 1);

  $("timerPhase").textContent = "Starter…";
  $("timerClock").textContent = "00:00";

  timerTick = setInterval(tickTimer, 1000);
}

function stopTimer() {
  if (!timerRunning) return;
  timerRunning = false;

  clearInterval(timerTick);
  timerTick = null;

  endLap();

  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;

  $("timerPhase").textContent = "Stoppet";

  finalizeLapStats();
  renderLapStatsText();
  setStatus("Økt stoppet");
}

function resetTimer() {
  if (timerRunning) stopTimer();

  elapsedSec = 0;
  $("timerClock").textContent = "00:00";
  $("timerPhase").textContent = "Stoppet";
  laps = [];
  currentLap = null;

  $("dragSpeedInput").value = "0.0";

  renderLapStatsText();
}

function tickTimer() {
  elapsedSec++;
  $("timerClock").textContent = mmss(elapsedSec);

  const warm = readInt("warmupSec");
  const work = readInt("workSec");
  const rest = readInt("restSec");
  const reps = readInt("reps");
  const cool = readInt("cooldownSec");

  const cycle = work + rest;
  const totalMain = reps * cycle;
  const total = warm + totalMain + cool;

  const t = elapsedSec - 1;

  let phase = "done";
  let rep = 0;

  if (t < total) {
    if (t < warm) {
      phase = "warmup";
    } else if (t < warm + totalMain) {
      const t2 = t - warm;
      const cycleIndex = Math.floor(t2 / cycle);
      const within = t2 % cycle;
      rep = cycleIndex + 1;
      phase = (within < work) ? "work" : "rest";
    } else {
      phase = "cooldown";
    }
  }

  if (phase === "done") {
    $("timerPhase").textContent = "Ferdig";
    stopTimer();
    return;
  }

  // ensure lap matches
  if (!currentLap || currentLap.type !== phase || currentLap.repIndex !== rep) {
    endLap();
    startLap(phase, rep);
  }

  // UI
  if (phase === "warmup") $("timerPhase").textContent = "Oppvarming";
  else if (phase === "cooldown") $("timerPhase").textContent = "Nedjogg";
  else if (phase === "work") $("timerPhase").textContent = `Arbeid (Drag ${rep}/${reps})`;
  else $("timerPhase").textContent = `Pause (Drag ${rep}/${reps})`;

  // enforce speed 0 during rest
  if (currentLap.type === "rest") {
    $("speedNow").textContent = "0.0";
  }

  // simulate HR if needed
  if (shouldSimulate()) {
    const bpm = simulateHR(phase);
    onHrSample(Date.now(), bpm, "sim");
  }

  // update stats occasionally
  if (elapsedSec % 2 === 0) renderLapStatsText();
}

function simulateHR(phase) {
  const baseline = 88;
  const warmTarget = 120;
  const workTarget = 168;
  const restTarget = 105;
  const coolTarget = 110;

  let target = baseline;
  let speed = 0.10;

  if (phase === "warmup") { target = warmTarget; speed = 0.10; }
  if (phase === "work")   { target = workTarget; speed = 0.13; }
  if (phase === "rest")   { target = restTarget; speed = 0.12; }
  if (phase === "cooldown"){ target = coolTarget; speed = 0.10; }

  simBpm = simBpm + (target - simBpm) * speed;
  simBpm += (rand() - 0.5) * 3.0;
  simBpm = Math.max(50, Math.min(210, simBpm));
  return Math.round(simBpm);
}

// ----- Manual per-drag speed input
function applyManualDragSpeed() {
  const val = Math.max(0, Math.round(readFloat("dragSpeedInput") * 10) / 10);

  if (!currentLap || currentLap.type !== "work") {
    alert("Dragfart kan settes når du er i arbeidsfase (drag).");
    return;
  }

  currentLap.speedManualKmh = val;
  currentLap.speedKmh = val;
  currentLap.speedSource = "manual";
  $("dragSpeedInput").value = val.toFixed(1);

  renderLapStatsText();
}

// ----- Laps: set speed at lap end
function startLap(type, repIndex) {
  currentLap = {
    type,
    repIndex,
    startTs: Date.now(),
    endTs: null,
    max30bpm: null,

    // speed fields
    speedKmh: (type === "rest") ? 0 : null,
    speedManualKmh: NaN,
    speedCandidateKmh: null,
    speedSource: null
  };
  laps.push(currentLap);

  // prefill drag speed input for work laps:
  if (type === "work") {
    const prefill = Number.isFinite(currentLap.speedKmh) ? currentLap.speedKmh
                  : (Number.isFinite(lastFtmsRawSpeed) && lastFtmsRawSpeed > 0 ? lastFtmsRawSpeed
                  : 0);
    $("dragSpeedInput").value = (Math.round(prefill * 10) / 10).toFixed(1);
  } else {
    $("dragSpeedInput").value = "0.0";
  }
}

function endLap() {
  if (!currentLap || currentLap.endTs) return;

  currentLap.endTs = Date.now();

  // force rest speed to 0
  if (currentLap.type === "rest") {
    currentLap.speedKmh = 0;
    currentLap.speedSource = "forced_rest";
    currentLap = null;
    return;
  }

  // work/warmup/cooldown: choose speed
  if (currentLap.type === "work") {
    if (Number.isFinite(currentLap.speedManualKmh)) {
      currentLap.speedKmh = currentLap.speedManualKmh;
      currentLap.speedSource = "manual";
    } else if (Number.isFinite(currentLap.speedCandidateKmh) && currentLap.speedCandidateKmh > 0) {
      // Set drag speed to the speed we ended with (candidate updated during lap)
      currentLap.speedKmh = Math.round(currentLap.speedCandidateKmh * 10) / 10;
      currentLap.speedSource = "ftms_end";
    } else {
      // fallback: last raw speed or 0
      currentLap.speedKmh = Math.round((lastFtmsRawSpeed || 0) * 10) / 10;
      currentLap.speedSource = currentLap.speedKmh > 0 ? "ftms_last" : "unknown";
    }
  } else {
    // warmup/cooldown: we can store last effective speed just as info (optional)
    currentLap.speedKmh = Math.round((lastFtmsEffectiveSpeed || 0) * 10) / 10;
    currentLap.speedSource = "info";
  }

  currentLap = null;
}

// ----- Max 30s avg per work lap (time-weighted: highest contiguous 30s period)
function samplesInRange(startTs, endTs) {
  return hrSamples.filter(p => p.ts >= startTs && p.ts <= endTs).sort((a,b) => a.ts - b.ts);
}

function computeMax30sAvg(samples) {
  if (!samples || samples.length < 2) return null;

  let best = -Infinity;
  for (let i = 0; i < samples.length - 1; i++) {
    const startT = samples[i].ts;
    const endT = startT + 30000;

    let area = 0;
    let t = startT;

    let k = i;
    while (k < samples.length - 1 && samples[k+1].ts <= t) k++;

    while (t < endT && k < samples.length - 1) {
      const tNext = Math.min(endT, samples[k+1].ts);
      const dt = Math.max(0, (tNext - t) / 1000);
      area += samples[k].bpm * dt;
      t = tNext;
      if (t >= samples[k+1].ts) k++;
    }

    if (t < endT) {
      const dt = (endT - t) / 1000;
      area += samples[samples.length - 1].bpm * dt;
    }

    best = Math.max(best, area / 30);
  }

  return best === -Infinity ? null : best;
}

function finalizeLapStats() {
  for (const lap of laps) {
    if (!lap.endTs) continue;
    if (lap.type !== "work") continue;
    const s = samplesInRange(lap.startTs, lap.endTs);
    lap.max30bpm = computeMax30sAvg(s);
  }
}

function renderLapStatsText() {
  const workLaps = laps.filter(l => l.type === "work" && l.endTs);
  if (!workLaps.length) {
    $("lapStats").textContent = "—";
    return;
  }

  const lines = [];
  for (const lap of workLaps) {
    const sp = Number.isFinite(lap.speedKmh) ? lap.speedKmh.toFixed(1) : "—";
    const src = lap.speedSource ? ` (${lap.speedSource})` : "";
    lines.push(`Drag nr ${lap.repIndex}: max30s = ${lap.max30bpm ? lap.max30bpm.toFixed(1) : "—"} bpm  ·  fart = ${sp} km/t${src}`);
  }
  $("lapStats").textContent = lines.join("\n");
}

// ----- Zones (kept minimal for now; you already have full zone rendering elsewhere)
function readZonesFromUI() {
  const z1 = readInt("z1"), z2 = readInt("z2"), z3 = readInt("z3"), z4 = readInt("z4"), z5 = readInt("z5");
  const arr = [z1,z2,z3,z4,z5].map(v => Math.max(0,v));
  for (let i=1;i<arr.length;i++) if (arr[i] < arr[i-1]) arr[i] = arr[i-1];
  zoneThresholds = { z1: arr[0], z2: arr[1], z3: arr[2], z4: arr[3], z5: arr[4] };
}

function initCapabilityCheck() {
  hideIOSNotice();

  if (!("bluetooth" in navigator)) {
    $("connectBtn").disabled = true;
    $("treadmillBtn").disabled = true;
    if (isIOS()) showIOSNotice(isSafari()
      ? "iOS Safari støtter ikke Web Bluetooth. Bruk Android (Chrome/Edge)."
      : "iOS støtter normalt ikke Web Bluetooth i vanlige nettlesere.");
    setStatus("Web Bluetooth ikke støttet");
    return;
  }

  $("connectBtn").disabled = false;
  $("treadmillBtn").disabled = false;
  setStatus("Klar");
}

function bindUI() {
  $("connectBtn").addEventListener("click", connectHR);
  $("treadmillBtn").addEventListener("click", connectTreadmill);

  $("startBtn").addEventListener("click", startTimer);
  $("stopBtn").addEventListener("click", stopTimer);
  $("resetBtn").addEventListener("click", resetTimer);

  $("applyZonesBtn").addEventListener("click", () => { readZonesFromUI(); });

  $("applyDragSpeedBtn").addEventListener("click", applyManualDragSpeed);
}

async function init() {
  await setupUpdateBanner();
  initCapabilityCheck();
  bindUI();
  readZonesFromUI();
  setHRButtonConnected(false);
  setTreadmillButtonConnected(false);
  drawCanvasChart();
}

init().catch(console.warn);
