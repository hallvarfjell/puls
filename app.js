/* ------------------------------------------------------------
   HR-APP — FULL VERSION
   app.js — PART 1 / 4
   ------------------------------------------------------------
   This file is split into 4 chunks due to message size limits.
   Do NOT modify until you have all four parts.
   ------------------------------------------------------------ */

const APP_VERSION = "v1.5.0 — " + new Date().toLocaleString("no-NO");

// Update version tag
document.getElementById("versionTag").textContent = APP_VERSION;

// ============================================================
//  GLOBAL STATE & CONSTANTS
// ============================================================

// Chart timing
const HR_WINDOW_MS = 15 * 60 * 1000; // 15 min in ms
const MAX_WINDOW_POINTS = 15 * 60 * 3; // up to 3 Hz
const CHART_FPS_MS = 250;

// DOM helper
const $ = (id) => document.getElementById(id);

// Wake Lock (prevent screen from sleeping)
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        console.log("WakeLock released!");
      });
      console.log("WakeLock acquired");
    }
  } catch (err) {
    console.warn("WakeLock error:", err);
  }
}

async function releaseWakeLock() {
  try {
    if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (err) {
    console.warn("WakeLock release error:", err);
  }
}

// Data stores
let lastHrTimestamp = 0;
let lastChartDraw = 0;

let windowPoints = []; // HR window chart points
let hrSamples = []; // Full-session HR samples

// Speed
let speedNow = 0.0;
let lastFtmsEffectiveSpeed = 0.0;
let lastFtmsRawSpeed = 0.0;
let speedSamples = []; // all speed samples

// BLE devices
let hrDevice = null;
let hrChar = null;

let tmDevice = null;
let tmChar = null;

// Timer / laps
let timerRunning = false;
let timerTick = null;
let elapsedSec = 0;

let laps = [];       // each lap: type, repIndex, startTs, endTs, speedKmh, max30bpm...
let currentLap = null;

// Canvas scaling
let canvasDpr = 1, canvasW = 0, canvasH = 0;

// Zones
let zoneThresholds = {
  z1: 110,
  z2: 130,
  z3: 150,
  z4: 165,
  z5: 180
};

// Helpers
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

// ============================================================
//  SERVICE WORKER — UPDATE BANNER FLOW
// ============================================================
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
        registration.waiting.postMessage({ type:"SKIP_WAITING" });
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

  setInterval(() => reg.update().catch(()=>{}), 60000);
}

// ============================================================
//  iOS NOTICE
// ============================================================
function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isSafari() {
  const ua = navigator.userAgent;
  const isWK = /AppleWebKit/.test(ua);
  const isChrome = /CriOS/.test(ua);
  const isFirefox = /FxiOS/.test(ua);
  const isEdge = /EdgiOS/.test(ua);
  return isWK && !isChrome && !isFirefox && !isEdge;
}
function showIOSNotice(msg) {
  const el = $("iosNotice");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function hideIOSNotice() {
  $("iosNotice").classList.add("hidden");
}

// ============================================================
//  STATUS TEXT
// ============================================================
function setStatus(text) {
  $("statusText").textContent = text;
}

// ============================================================
//  BLE — HEART RATE
// ============================================================

function setHRButtonConnected(connected) {
  const btn = $("connectBtn");
  if (connected) {
    btn.classList.add("connected");
    btn.textContent = "HR ✓";
  } else {
    btn.classList.remove("connected");
    btn.textContent = "Koble til pulsbelte";
  }
}

async function connectHR() {
  try {
    setStatus("Åpner HR‑dialog…");

    hrDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services:["heart_rate"] }],
      optionalServices:["battery_service"]
    });

    hrDevice.addEventListener("gattserverdisconnected", () => {
      hrChar = null;
      setHRButtonConnected(false);
      setStatus("HR frakoblet");
    });

    setStatus("Kobler til HR…");
    const server = await hrDevice.gatt.connect();
    const service = await server.getPrimaryService("heart_rate");
    hrChar = await service.getCharacteristic("heart_rate_measurement");

    hrChar.addEventListener("characteristicvaluechanged", onHRNotify);
    await hrChar.startNotifications();

    setHRButtonConnected(true);
    setStatus("HR tilkoblet");
  }
  catch (e) {
    console.error(e);
    setStatus("HR-tilkobling feilet");
    alert("Klarte ikke koble til pulsbelte. Sjekk BT og bruk Chrome/Edge på Android.");
  }
}

function parseHeartRate(value) {
  const flags = value.getUint8(0);
  const is16 = (flags & 0x01) !== 0;
  return is16 ? value.getUint16(1,true) : value.getUint8(1);
}

function onHRNotify(event) {
  const hr = parseHeartRate(event.target.value);
  onHrSample(Date.now(), hr, "ble");
}

// ============================================================
//  BLE — FTMS TREADMILL
// ============================================================

function setTreadmillButtonConnected(connected) {
  const btn = $("treadmillBtn");
  if (connected) {
    btn.classList.add("connected");
    btn.textContent = "Mølle ✓";
  } else {
    btn.classList.remove("connected");
    btn.textContent = "Mølle: Koble til";
  }
}

async function connectTreadmill() {
  try {
    const FTMS = "00001826-0000-1000-8000-00805f9b34fb";
    const TREAD = "00002acd-0000-1000-8000-00805f9b34fb";

    setStatus("Åpner mølledialog…");

    tmDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services:[FTMS] }]
    });

    tmDevice.addEventListener("gattserverdisconnected", () => {
      tmChar = null;
      setTreadmillButtonConnected(false);
      setStatus("Mølle frakoblet");
    });

    setStatus("Kobler mølle…");
    const server = await tmDevice.gatt.connect();
    const service = await server.getPrimaryService(FTMS);
    tmChar = await service.getCharacteristic(TREAD);

    tmChar.addEventListener("characteristicvaluechanged", onTreadNotify);
    await tmChar.startNotifications();

    setTreadmillButtonConnected(true);
    setStatus("Mølle tilkoblet");
  }
  catch (e) {
    console.error(e);
    setStatus("Møllefeil");
    alert("Klarte ikke koble til mølle. Mange møller bruker FTMS, men ikke alle.");
  }
}

function onTreadNotify(event) {
  const dv = event.target.value;

  // Common FTMS treadmill pattern:
  // bytes [2..3] = instantaneous speed * 100 (km/h)
  let raw = 0;
  try { raw = dv.getUint16(2,true); }
  catch { raw = 0; }

  const kmh = raw / 100.0;
  lastFtmsRawSpeed = kmh;

  // effective speed = 0 during rest laps
  const effective = (currentLap && currentLap.type === "rest") ? 0 : kmh;

  onSpeedSample(Date.now(), kmh, effective, "ftms");
}
/* ------------------------------------------------------------
   HR-APP — PART 2 / 4  (append directly after Part 1)
------------------------------------------------------------- */

// ============================================================
//  SAMPLE INGESTION — HR + SPEED
// ============================================================

function onHrSample(ts, bpm, src) {
  lastHrTimestamp = ts;

  // display current HR
  $("pulseValue").textContent = bpm;

  // store full session
  hrSamples.push({ ts, bpm, src });

  // update 15-min window
  windowPoints.push({ x: ts, y: bpm });
  const cutoff = ts - HR_WINDOW_MS;

  while (windowPoints.length && windowPoints[0].x < cutoff)
    windowPoints.shift();

  if (windowPoints.length > MAX_WINDOW_POINTS)
    windowPoints = windowPoints.slice(windowPoints.length - MAX_WINDOW_POINTS);

  drawChartThrottled();
}

// seconds since last HR sample
setInterval(() => {
  if (!lastHrTimestamp) {
    $("lastSeen").textContent = "--";
    return;
  }
  const sec = Math.max(0, Math.floor((Date.now() - lastHrTimestamp) / 1000));
  $("lastSeen").textContent = sec;
}, 500);

function onSpeedSample(ts, kmh, effectiveKmh, src) {
  speedNow = effectiveKmh;
  $("speedNow").textContent = speedNow.toFixed(1);

  speedSamples.push({ ts, kmh, effectiveKmh, src });
  lastFtmsEffectiveSpeed = effectiveKmh;

  if (currentLap && currentLap.type === "work" && !Number.isFinite(currentLap.speedManualKmh)) {
    // this becomes the default "sluttfart"
    currentLap.speedCandidateKmh = effectiveKmh;
  }
}

// ============================================================
//  CHART DRAW (LIVE PULS-GRAF)
// ============================================================

function resizeCanvasToDisplaySize() {
  const canvas = $("hrCanvas");
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w === 0 || h === 0) return;

  if (canvasW !== w || canvasH !== h || canvasDpr !== dpr) {
    canvasW = w;
    canvasH = h;
    canvasDpr = dpr;
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

  // Y-scale: min/max ±10 bpm
  let minY = 60, maxY = 180;
  if (windowPoints.length >= 2) {
    let lo = Infinity, hi = -Infinity;
    for (const p of windowPoints) {
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
    minY = Math.max(30, Math.floor(lo - 10));
    maxY = Math.min(240, Math.ceil(hi + 10));
    if (maxY - minY < 20) maxY = minY + 20;
  }

  const xToPx = x => padL + ((x - minX) / (maxX - minX)) * plotW;
  const yToPx = y => padT + (1 - (y - minY) / (maxY - minY)) * plotH;

  // Grid + Y labels
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "16px system-ui";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= 5; i++) {
    const y = padT + (i / 5) * plotH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();

    const val = Math.round(maxY - (i / 5) * (maxY - minY));
    ctx.fillText(val, padL - 10, y);
  }

  // X grid
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i <= 5; i++) {
    const x = padL + (i / 5) * plotW;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    const minsAgo = Math.round((1 - i / 5) * 15);
    ctx.fillText(`-${minsAgo}m`, x, padT + plotH + 10);
  }

  // Pulse line
  if (windowPoints.length >= 2) {
    ctx.strokeStyle = "#27f5a4";
    ctx.lineWidth = 3;
    ctx.beginPath();
    let started = false;
    for (const p of windowPoints) {
      const x = xToPx(p.x);
      const y = yToPx(p.y);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
}

// ============================================================
//  TIMER & INTERVALL-LOGIKK
// ============================================================

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

  // Acquire wakelock
  requestWakeLock();

  const warm = readInt("warmupSec");
  if (warm > 0) {
    startLap("warmup", 0);
  } else {
    startLap("work", 1);
  }

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

  releaseWakeLock();

  finalizeLapStats();
  renderLapStatsText();
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
      const cycleIdx = Math.floor(t2 / cycle);
      const within = t2 % cycle;
      rep = cycleIdx + 1;
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

  if (!currentLap || currentLap.type !== phase || currentLap.repIndex !== rep) {
    endLap();
    startLap(phase, rep);
  }

  if (phase === "warmup") $("timerPhase").textContent = "Oppvarming";
  else if (phase === "cooldown") $("timerPhase").textContent = "Nedjogg";
  else if (phase === "work") $("timerPhase").textContent = `Arbeid (Drag ${rep}/${reps})`;
  else $("timerPhase").textContent = `Pause (Drag ${rep}/${reps})`;

  if (currentLap.type === "rest") {
    $("speedNow").textContent = "0.0";
  }

  if (shouldSimulate()) {
    const bpm = simulateHR(phase);
    onHrSample(Date.now(), bpm, "sim");
  }

  if (elapsedSec % 2 === 0) {
    renderLapStatsText();
  }
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
  simBpm += (Math.random() - 0.5) * 3.0;
  simBpm = Math.max(50, Math.min(210, simBpm));
  return Math.round(simBpm);
}

// ============================================================
//  LAP START/END + MANUAL SPEED OVERRIDE
// ============================================================

function applyManualDragSpeed() {
  const val = Math.max(0, Math.round(readFloat("dragSpeedInput") * 10) / 10);

  if (!currentLap || currentLap.type !== "work") {
    alert("Du kan bare endre dragfart når du er i et arbeid-drag.");
    return;
  }

  currentLap.speedManualKmh = val;
  currentLap.speedKmh = val;
  currentLap.speedSource = "manual";

  $("dragSpeedInput").value = val.toFixed(1);

  renderLapStatsText();
}

function startLap(type, repIndex) {
  currentLap = {
    type,
    repIndex,
    startTs: Date.now(),
    endTs: null,
    max30bpm: null,
    speedKmh: (type === "rest") ? 0 : null,
    speedManualKmh: NaN,
    speedCandidateKmh: null,
    speedSource: null
  };
  laps.push(currentLap);

  if (type === "work") {
    const prefill = Number.isFinite(lastFtmsRawSpeed) ? lastFtmsRawSpeed : 0;
    $("dragSpeedInput").value = prefill.toFixed(1);
  } else {
    $("dragSpeedInput").value = "0.0";
  }
}

function endLap() {
  if (!currentLap || currentLap.endTs) return;

  currentLap.endTs = Date.now();

  if (currentLap.type === "rest") {
    currentLap.speedKmh = 0;
    currentLap.speedSource = "forced_rest";
    currentLap = null;
    return;
  }

  if (currentLap.type === "work") {
    if (Number.isFinite(currentLap.speedManualKmh)) {
      currentLap.speedKmh = currentLap.speedManualKmh;
      currentLap.speedSource = "manual";
    } else if (Number.isFinite(currentLap.speedCandidateKmh) && currentLap.speedCandidateKmh > 0) {
      currentLap.speedKmh = Math.round(currentLap.speedCandidateKmh * 10) / 10;
      currentLap.speedSource = "ftms_end";
    } else {
      currentLap.speedKmh = Math.round((lastFtmsRawSpeed || 0) * 10) / 10;
      currentLap.speedSource = currentLap.speedKmh > 0 ? "ftms_last" : "unknown";
    }
  } else {
    currentLap.speedKmh = Math.round((lastFtmsEffectiveSpeed || 0) * 10) / 10;
    currentLap.speedSource = "info";
  }

  currentLap = null;
}

// ============================================================
//  30s MAX AVERAGE BPM (time-weighted)
// ============================================================

function samplesInRange(startTs, endTs) {
  return hrSamples
    .filter(p => p.ts >= startTs && p.ts <= endTs)
    .sort((a,b) => a.ts - b.ts);
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

    const avg = area / 30;
    if (avg > best) best = avg;
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
    const sp = Number.isFinite(lap.speedKmh)
      ? lap.speedKmh.toFixed(1)
      : "—";
    const src = lap.speedSource ? ` (${lap.speedSource})` : "";
    const m30 = lap.max30bpm ? Math.round(lap.max30bpm) : "—";
    lines.push(`Drag ${lap.repIndex}: max30s = ${m30} bpm · fart = ${sp} km/t${src}`);
  }

  $("lapStats").textContent = lines.join("\n");
}
/* ------------------------------------------------------------
   HR-APP — PART 3 / 4  (append directly after Part 2)
------------------------------------------------------------- */

// ============================================================
//  ZONES — COMPUTATION FOR SESSION (ONLY INSIDE WORKOUT)
// ============================================================

// We only want zone time inside the workout:
// i.e. between first lap.startTs and last lap.endTs

function computeZoneSecondsSessionOnly() {
  if (!laps.length) return [0,0,0,0,0,0];

  const firstLap = laps[0];
  const lastLap  = laps[laps.length - 1];
  if (!firstLap.startTs || !lastLap.endTs) return [0,0,0,0,0,0];

  const start = firstLap.startTs;
  const end   = lastLap.endTs;

  const samples = hrSamples
    .filter(p => p.ts >= start && p.ts <= end)
    .sort((a,b)=>a.ts - b.ts);

  const zoneSec = [0,0,0,0,0,0];
  if (samples.length < 2) return zoneSec;

  const { z1,z2,z3,z4,z5 } = zoneThresholds;
  const zoneOf = bpm => {
    if (bpm < z1) return 0;
    if (bpm < z2) return 1;
    if (bpm < z3) return 2;
    if (bpm < z4) return 3;
    if (bpm < z5) return 4;
    return 5;
  };

  for (let i=0;i<samples.length - 1;i++) {
    const s = samples[i];
    const dt = Math.max(0, Math.min(5, (samples[i+1].ts - s.ts) / 1000));
    zoneSec[zoneOf(s.bpm)] += dt;
  }

  return zoneSec;
}

function renderZones() {
  const zs = computeZoneSecondsSessionOnly();
  const maxSec = Math.max(...zs, 1);

  for (let z=0;z<=5;z++) {
    $(`barS${z}`).style.width =
      `${((zs[z]/maxSec)*100).toFixed(1)}%`;
    $(`timeS${z}`).textContent = fmtTime(zs[z]);
  }
}

function renderZonesToResults(zs) {
  const maxSec = Math.max(...zs, 1);
  for (let z=0;z<=5;z++) {
    $(`rbarS${z}`).style.width =
      `${((zs[z]/maxSec)*100).toFixed(1)}%`;
    $(`rtimeS${z}`).textContent = fmtTime(zs[z]);
  }
}

// ============================================================
//  RESULTS MODAL + PNG EXPORT
// ============================================================

function showResultsModal() {
  const modal = $("resultsModal");
  modal.classList.remove("hidden");

  const nowStr = new Date().toLocaleString("no-NO");
  const note = $("note").value.trim();
  $("resultsSub").textContent =
    note ? `${nowStr} · ${note}` : nowStr;

  const warm = readInt("warmupSec");
  const work = readInt("workSec");
  const rest = readInt("restSec");
  const reps = readInt("reps");
  const cool = readInt("cooldownSec");

  const totalPlanned =
    warm + reps*(work+rest) + cool;

  // actual time = last lap end - first lap start
  let totalActual = 0;
  if (laps.length) {
    const first = laps[0];
    const last  = laps[laps.length - 1];
    if (first.startTs && last.endTs)
      totalActual = Math.round((last.endTs - first.startTs)/1000);
  }

  // compute warm, work, cool, rest time exactly:
  let warmTime=0, workTime=0, restTime=0, coolTime=0;
  for (const lap of laps) {
    if (!lap.endTs) continue;
    const dur = (lap.endTs - lap.startTs)/1000;
    if      (lap.type==="warmup")   warmTime+=dur;
    else if (lap.type==="work")     workTime+=dur;
    else if (lap.type==="rest")     restTime+=dur;
    else if (lap.type==="cooldown") coolTime+=dur;
  }

  // compute zone secs
  const zoneSecs = computeZoneSecondsSessionOnly();
  renderZonesToResults(zoneSecs);

  // compute average HR (rounded)
  let sumHR = 0, cntHR = 0;
  if (laps.length) {
    const first = laps[0].startTs;
    const last  = laps[laps.length - 1].endTs;
    for (const p of hrSamples) {
      if (p.ts>=first && p.ts<=last) {
        sumHR += p.bpm;
        cntHR++;
      }
    }
  }
  const avgHR = cntHR>0? Math.round(sumHR/cntHR) : 0;

  // total distance = sum over (effective speed * dt)
  let dist = 0;
  if (laps.length) {
    const first = laps[0].startTs;
    const last  = laps[laps.length - 1].endTs;
    const ss = speedSamples
      .filter(p => p.ts>=first && p.ts<=last)
      .sort((a,b)=>a.ts-b.ts);

    for (let i=0;i<ss.length-1;i++) {
      const dt = (ss[i+1].ts - ss[i].ts)/1000;
      dist += ss[i].effectiveKmh * (dt/3600.0);
    }
  }

  // Build summary text
  $("summaryText").textContent =
`Totaltid:        ${fmtTime(totalActual)}
Planlagt tid:    ${fmtTime(totalPlanned)}
Oppvarming:       ${fmtTime(warmTime)}
Dragtid (sum):   ${fmtTime(workTime)}
Pausetid:        ${fmtTime(restTime)}
Nedjogg:         ${fmtTime(coolTime)}

Snittpuls:       ${avgHR} bpm
Distanse:        ${dist.toFixed(2)} km`;

  renderSpeedEditor();
  drawResultsChart();

  $("closeResultsBtn").onclick = () =>
    modal.classList.add("hidden");

  $("exportPngBtn").onclick = exportResultsPNG;
  $("sharePngBtn").onclick  = shareResultsPNG;
  $("exportJsonBtn2").onclick = exportJSON;
  $("saveEditsBtn").onclick  = saveEditsAndRefresh;
}

// ============================================================
//  SPEED EDITOR
// ============================================================

function renderSpeedEditor() {
  const wrap = $("speedEditor");
  const workLaps = laps
    .filter(l => l.type==="work" && l.endTs);

  if (!workLaps.length) {
    wrap.textContent = "—";
    return;
  }

  wrap.innerHTML = "";
  for (const lap of workLaps) {
    const row = document.createElement("div");
    row.className = "speedRow";

    const lbl = document.createElement("div");
    lbl.className = "speedRowLabel";
    lbl.textContent = `Drag ${lap.repIndex}`;
    row.appendChild(lbl);

    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "0.1";
    inp.min = "0";
    inp.value = Number.isFinite(lap.speedKmh)
      ? lap.speedKmh.toFixed(1)
      : "0.0";
    inp.dataset.rep = lap.repIndex;
    row.appendChild(inp);

    wrap.appendChild(row);
  }
}

function saveEditsAndRefresh() {
  const inputs = $("speedEditor")
    .querySelectorAll("input");

  const map = new Map();
  for (const i of inputs) {
    const n = parseInt(i.dataset.rep,10);
    const v = Math.max(0, parseFloat(i.value));
    map.set(n, v);
  }

  for (const lap of laps) {
    if (lap.type==="work" && map.has(lap.repIndex)) {
      lap.speedKmh = Math.round(map.get(lap.repIndex)*10)/10;
      lap.speedSource = "manual_edit";
    }
    if (lap.type==="rest") {
      lap.speedKmh = 0;
      lap.speedSource = "forced_rest";
    }
  }

  finalizeLapStats();
  renderLapStatsText();
  drawResultsChart();
  saveCurrentSession();
  alert("Endringer lagret.");
}

// ============================================================
//  RESULTS CANVAS (PULS STOLPE + FART LINJE + DUAL Y)
// ============================================================

function drawResultsChart() {
  const canvas = $("resultsCanvas");
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio||1));

  // LANDSCAPE PNG LAYOUT (1800×1200)
  const PNG_W = 1800;
  const PNG_H = 1200;

  canvas.width  = PNG_W * dpr;
  canvas.height = PNG_H * dpr;

  canvas.style.width  = PNG_W + "px";
  canvas.style.height = PNG_H + "px";

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);

  // Background
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0,0,PNG_W,PNG_H);

  const workLaps = laps.filter(l => l.type==="work" && l.endTs);
  const values = workLaps.map(l => l.max30bpm ? Math.round(l.max30bpm) : 0);
  const speeds = workLaps.map(l => Number.isFinite(l.speedKmh)? l.speedKmh : 0);

  const padL = 80, padR = 80, padT = 80, padB = 140;
  const plotW = PNG_W - padL - padR;
  const plotH = PNG_H - padT - padB;

  // Y-scale: unified BPM/kmh scale
  // 160 bpm ↔ 16.0 kmh → scale factor = 10
  let minVal = 999, maxVal = -999;
  for (let i=0;i<values.length;i++) {
    const v = values[i];
    const s = speeds[i]*10;  // convert kmh to bpm-scale
    minVal = Math.min(minVal, v, s);
    maxVal = Math.max(maxVal, v, s);
  }
  if (minVal === 999) { minVal = 0; maxVal=200; }

  if (maxVal - minVal < 20) maxVal = minVal + 20;

  const yToPx = y =>
    padT + (1 - (y - minVal)/(maxVal-minVal)) * plotH;

  // Grid
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.font = "22px system-ui";
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i=0;i<=6;i++) {
    const yVal = maxVal - i*((maxVal-minVal)/6);
    const y = yToPx(yVal);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();

    ctx.fillText(
      Math.round(yVal),
      padL - 10,
      y
    );

    // Right axis kmh = bpm/10
    const kmh = (Math.round(yVal)/10).toFixed(1);
    ctx.fillText(
      kmh,
      padL + plotW + 50,
      y
    );
  }

  // X axis labels (drag numbers)
  const n = workLaps.length;
  const gap = 14;
  const barW = Math.max(20, (plotW - gap*(n-1))/n);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (let i=0;i<n;i++) {
    const x = padL + i*(barW + gap) + barW/2;
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillText(String(workLaps[i].repIndex), x, padT + plotH + 10);
  }

  // Bars (pulse)
  ctx.fillStyle = "#27f5a4";
  for (let i=0;i<n;i++) {
    const v = values[i];
    const x = padL + i*(barW + gap);
    const y = yToPx(v);
    const y0 = yToPx(minVal);
    ctx.fillRect(x, y, barW, y0 - y);
  }

  // Speed line (white)
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 4;
  ctx.beginPath();
  let started = false;

  for (let i=0;i<n;i++) {
    const s = speeds[i]*10;  // scale
    const x = padL + i*(barW + gap) + barW/2;
    const y = yToPx(s);
    if (!started) {
      ctx.moveTo(x,y);
      started = true;
    } else ctx.lineTo(x,y);
  }
  ctx.stroke();

  // Title
  ctx.fillStyle = "white";
  ctx.font = "32px system-ui";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("Puls (stolper) og Fart (linje)", padL, 20);

  // Summary box at bottom
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(padL, PNG_H - 120, plotW, 100);

  ctx.fillStyle = "white";
  ctx.font = "20px system-ui";
  ctx.textBaseline = "middle";

  const summaryText = $("summaryText").textContent;
  const lines = summaryText.split("\n");
  let yOff = PNG_H - 100;
  for (const line of lines) {
    ctx.fillText(line, padL + 10, yOff);
    yOff += 24;
  }
}

// PNG EXPORT
function exportResultsPNG() {
  const canvas = $("resultsCanvas");
  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = `hr-result-${Date.now()}.png`;
  a.click();
}

// SHARE SHEET (Android)
async function shareResultsPNG() {
  const canvas = $("resultsCanvas");
  if (!navigator.canShare) {
    alert("Deling ikke støttet her");
    return;
  }

  const blob = await new Promise(res => canvas.toBlob(res,"image/png"));
  const file = new File([blob], `hr-result-${Date.now()}.png`, {
    type:"image/png"
  });

  if (navigator.canShare({ files:[file] })) {
    await navigator.share({
      title:"HR Resultat",
      files:[file]
    });
  }
}

// ============================================================
//  EXPORT JSON (SESSION)
// ============================================================

function exportJSON() {
  const p = buildSessionPayload();
  const blob = new Blob(
    [JSON.stringify(p, null, 2)],
    { type:"application/json" }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hr-session-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
/* ------------------------------------------------------------
   HR-APP — PART 4 / 4  (append directly after Part 3)
------------------------------------------------------------- */

// ============================================================
//  INDEXEDDB — SESSION STORAGE
// ============================================================

const DB_NAME  = "hr_app_db";
const DB_VER   = 1;
const STORE    = "sessions";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("createdAt", "createdAt");
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbPut(session) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(session);
    tx.oncomplete = () => resolve(true);
    tx.onerror   = () => reject(tx.error);
  });
}

async function dbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror   = () => reject(tx.error);
  });
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() :
    `id-${Date.now()}-${Math.floor(Math.random()*1e9)}`;
}

// ------------------------------------------------------------
//  BUILD SESSION PAYLOAD
// ------------------------------------------------------------

let lastSavedSessionId = null;

function buildSessionPayload(existingId = null) {
  return {
    id: existingId || uuid(),
    createdAt: new Date().toISOString(),
    note: $("note").value.trim(),

    config: {
      warmupSec: readInt("warmupSec"),
      workSec: readInt("workSec"),
      restSec: readInt("restSec"),
      cooldownSec: readInt("cooldownSec"),
      reps: readInt("reps"),
      simMode: $("simMode").value
    },

    zones: zoneThresholds,

    laps: laps,
    hrSamples: hrSamples,
    speedSamples: speedSamples
  };
}

async function saveCurrentSession() {
  const payload = buildSessionPayload(lastSavedSessionId);
  lastSavedSessionId = payload.id;
  await dbPut(payload);
  await refreshSessionList();
}

// ------------------------------------------------------------
//  LOAD SESSION
// ------------------------------------------------------------

async function loadSelectedSession() {
  const id = $("sessionSelect").value;
  if (!id) return;

  const sess = await dbGet(id);
  if (!sess) return;

  lastSavedSessionId = sess.id;

  // Load config
  $("warmupSec").value   = sess.config.warmupSec;
  $("workSec").value     = sess.config.workSec;
  $("restSec").value     = sess.config.restSec;
  $("cooldownSec").value = sess.config.cooldownSec;
  $("reps").value        = sess.config.reps;
  $("simMode").value     = sess.config.simMode;

  $("note").value        = sess.note || "";

  zoneThresholds = sess.zones;

  // Data
  laps         = sess.laps || [];
  hrSamples    = sess.hrSamples || [];
  speedSamples = sess.speedSamples || [];

  // Rebuild window
  const now = Date.now();
  windowPoints = hrSamples
    .filter(p => p.ts >= now - HR_WINDOW_MS)
    .map(p => ({ x:p.ts, y:p.bpm }));

  const last = hrSamples[hrSamples.length-1];
  $("pulseValue").textContent = last ? last.bpm : "--";

  const ls = speedSamples[speedSamples.length-1];
  speedNow = ls ? ls.effectiveKmh : 0;
  $("speedNow").textContent = speedNow.toFixed(1);

  finalizeLapStats();
  renderLapStatsText();
  renderZones();
  drawCanvasChart();

  // Open results modal for loaded session
  $("resultsModal").classList.remove("hidden");
  $("resultsSub").textContent = `Lastet økt: ${sess.createdAt.replace("T"," ").slice(0,16)}`;

  renderSpeedEditor();
  drawResultsChart();
  $("summaryText").textContent = "(Lastet økt)";
  renderZonesToResults(computeZoneSecondsSessionOnly());
}

// ------------------------------------------------------------
//  DELETE SESSION
// ------------------------------------------------------------

async function deleteSelectedSession() {
  const id = $("sessionSelect").value;
  if (!id) return;
  await dbDelete(id);
  await refreshSessionList();
  alert("Økt slettet.");
}

// ------------------------------------------------------------
//  SESSION LIST REFRESH
// ------------------------------------------------------------

async function refreshSessionList() {
  const list = await dbGetAll();
  list.sort((a,b)=> (b.createdAt||"").localeCompare(a.createdAt||""));

  const sel = $("sessionSelect");
  sel.innerHTML = "";

  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = list.length ? "Velg økt…" : "Ingen lagrede økter";
  sel.appendChild(opt0);

  for (const s of list) {
    const o = document.createElement("option");
    o.value = s.id;
    const d = s.createdAt.replace("T"," ").slice(0,16);
    o.textContent = `${d}${s.note? " · "+s.note : ""}`;
    sel.appendChild(o);
  }
}

// ============================================================
//  UI: ADD / REMOVE REPS
// ============================================================

$("addRepBtn").addEventListener("click", () => {
  const r = readInt("reps");
  $("reps").value = r + 1;
  if (timerRunning) setStatus("La til et drag");
});

$("removeRepBtn").addEventListener("click", () => {
  const r = readInt("reps");
  if (r > 1) $("reps").value = r - 1;
  if (timerRunning) setStatus("Fjernet et drag");
});

// ============================================================
//  CAPABILITY CHECK — BLE + iOS
// ============================================================

function initCapabilityCheck() {
  hideIOSNotice();

  if (!("bluetooth" in navigator)) {
    $("connectBtn").disabled = true;
    $("treadmillBtn").disabled = true;

    if (isIOS()) {
      showIOSNotice(
        isSafari()
          ? "iOS Safari støtter ikke Web Bluetooth."
          : "iOS støtter normalt ikke Web Bluetooth."
      );
    }

    setStatus("Bluetooth ikke støttet");
    return;
  }

  $("connectBtn").disabled = false;
  $("treadmillBtn").disabled = false;
  setStatus("Klar");
}

// ============================================================
//  BIND UI EVENTS
// ============================================================

function bindUI() {
  $("connectBtn").onclick     = connectHR;
  $("treadmillBtn").onclick   = connectTreadmill;

  $("startBtn").onclick       = startTimer;
  $("stopBtn").onclick        = stopTimer;
  $("resetBtn").onclick       = resetTimer;

  $("applyZonesBtn").onclick  = () => {
    zoneThresholds = {
      z1: readInt("z1"),
      z2: readInt("z2"),
      z3: readInt("z3"),
      z4: readInt("z4"),
      z5: readInt("z5")
    };
    renderZones();
    drawResultsChart();
  };

  $("applyDragSpeedBtn").onclick = applyManualDragSpeed;

  $("loadSessionBtn").onclick   = loadSelectedSession;
  $("deleteSessionBtn").onclick = deleteSelectedSession;
}

// ============================================================
//  INIT
// ============================================================

async function init() {
  await setupUpdateBanner();
  initCapabilityCheck();
  bindUI();

  // Pre-fill zones into UI
  $("z1").value = zoneThresholds.z1;
  $("z2").value = zoneThresholds.z2;
  $("z3").value = zoneThresholds.z3;
  $("z4").value = zoneThresholds.z4;
  $("z5").value = zoneThresholds.z5;

  // Build session list
  await refreshSessionList();

  renderZones();
  drawCanvasChart();
  renderLapStatsText();
}

init().catch(console.warn);

/* ---------------- END OF FULL APP.JS --------------------- */
