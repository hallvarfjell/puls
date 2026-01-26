
/* app.js – HR: offline-first dashboard + update banner + sessions + results */

const APP_VERSION = "v1.4.0 (2026-01-26)";
document.getElementById("versionTag").textContent = APP_VERSION;

// ----- Time windows / chart
const HR_WINDOW_MS = 15 * 60 * 1000;
const MAX_WINDOW_POINTS = 15 * 60 * 3;
const CHART_FPS_MS = 250;

// ----- DOM helpers
const $ = (id) => document.getElementById(id);

// ----- BLE HR
let hrDevice = null;
let hrChar = null;

// ----- BLE treadmill (FTMS)
let tmDevice = null;
let tmChar = null;

// ----- Data
let lastHrTimestamp = 0;
let lastChartDraw = 0;
let sampleCount = 0;

let windowPoints = [];   // HR last 15 min {x:ts,y:bpm}
let hrSamples = [];      // full session {ts,bpm,src}

let speedNow = 0.0;
let speedSamples = [];   // {ts, kmh, src, effectiveKmh}

// ----- Timer/Laps
let timerRunning = false;
let timerTick = null;
let elapsedSec = 0;
let workoutStartTs = 0;
let workoutEndTs = 0;

let laps = [];           // {type, repIndex, startTs, endTs, max30bpm, speedKmh}
let currentLap = null;

// Zones thresholds (custom BPM)
let zoneThresholds = { z1: 110, z2: 130, z3: 150, z4: 165, z5: 180 };

// Simulation
const rand = (() => { let x = 123456789 >>> 0; return () => ((x = (1664525 * x + 1013904223) >>> 0) / 4294967296); })();
let simBpm = 92;

// Canvas scaling
let canvasDpr = 1, canvasW = 0, canvasH = 0;

// ----- IndexedDB (sessions)
const DB_NAME = "hr_app_db";
const DB_VER = 1;
const STORE = "sessions";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(session) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(session);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

function uid() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : `id-${Date.now()}-${Math.floor(Math.random()*1e9)}`;
}

function fmtTime(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2,"0")}`;
}

function mmss(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function readInt(id) {
  const v = parseInt($(id).value, 10);
  return Number.isFinite(v) ? v : 0;
}

// ----- Service Worker update banner flow
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

      // Tell the waiting SW to activate immediately
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
    };

    btnLater.onclick = () => {
      banner.classList.add("hidden");
    };
  }

  // If there's already a waiting worker, show banner
  if (reg.waiting) showUpdate(reg);

  // Listen for new SW
  reg.addEventListener("updatefound", () => {
    const newWorker = reg.installing;
    if (!newWorker) return;

    newWorker.addEventListener("statechange", () => {
      // installed means "waiting" if there is an existing controller
      if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
        showUpdate(reg);
      }
    });
  });

  // Periodic update check (nice on kiosk-ish tablets)
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

// ----- HR BLE
async function connectHR() {
  try {
    setStatus("Åpner Bluetooth-dialog…");
    hrDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: ["heart_rate"] }],
      optionalServices: ["battery_service"]
    });

    hrDevice.addEventListener("gattserverdisconnected", () => {
      setStatus("HR frakoblet");
      hrChar = null;
      setHRButtonConnected(false);
    });

    setStatus("Kobler HR…");
    const server = await hrDevice.gatt.connect();
    const service = await server.getPrimaryService("heart_rate");
    hrChar = await service.getCharacteristic("heart_rate_measurement");

    hrChar.addEventListener("characteristicvaluechanged", onHRNotify);
    await hrChar.startNotifications();

    setStatus("HR tilkoblet");
    setHRButtonConnected(true);
  } catch (e) {
    console.error(e);
    setStatus("HR-tilkobling feilet");
    alert("Kunne ikke koble til pulsbelte. Bruk Chrome/Edge på Android.");
  }
}

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

function parseHeartRate(value) {
  const flags = value.getUint8(0);
  const is16Bit = (flags & 0x01) !== 0;
  return is16Bit ? value.getUint16(1, true) : value.getUint8(1);
}

function onHRNotify(event) {
  const hr = parseHeartRate(event.target.value);
  onHrSample(Date.now(), hr, "ble");
}

// ----- Treadmill BLE (FTMS treadmill data 0x2ACD: speed often in n/100 km/h per observed FTMS devices) [3](https://nv1t.github.io/blog/treadmill-telemetry/)
async function connectTreadmill() {
  try {
    const FTMS = "00001826-0000-1000-8000-00805f9b34fb";
    const TREADMILL_DATA = "00002acd-0000-1000-8000-00805f9b34fb";

    setStatus("Åpner Bluetooth (mølle)…");
    tmDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS] }],
      optionalServices: []
    });

    tmDevice.addEventListener("gattserverdisconnected", () => {
      setStatus("Mølle frakoblet");
      tmChar = null;
      setTreadmillButtonConnected(false);
    });

    setStatus("Kobler mølle…");
    const server = await tmDevice.gatt.connect();
    const service = await server.getPrimaryService(FTMS);
    tmChar = await service.getCharacteristic(TREADMILL_DATA);

    tmChar.addEventListener("characteristicvaluechanged", onTreadmillNotify);
    await tmChar.startNotifications();

    setStatus("Mølle tilkoblet");
    setTreadmillButtonConnected(true);
  } catch (e) {
    console.error(e);
    setStatus("Mølle-tilkobling feilet");
    alert("Kunne ikke koble til mølle via Bluetooth. Mange møller bruker ikke FTMS eller krever annen app.");
  }
}

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

function onTreadmillNotify(event) {
  const dv = event.target.value;

  // Common FTMS layout: flags (2 bytes), then instantaneous speed at bytes 2..3
  // Observed in practice: speed raw = n/100 km/h [3](https://nv1t.github.io/blog/treadmill-telemetry/)
  let speedRaw = 0;
  try {
    speedRaw = dv.getUint16(2, true);
  } catch {
    speedRaw = 0;
  }
  const kmh = speedRaw / 100.0;

  // Effective speed: if in rest phase, force 0 (you jump off) as requested
  const effective = (currentLap && currentLap.type === "rest") ? 0 : kmh;

  onSpeedSample(Date.now(), kmh, effective, "ftms");
}

// ----- Pipelines
function onHrSample(ts, bpm, src) {
  sampleCount++;
  lastHrTimestamp = ts;
  $("pulseValue").textContent = bpm;

  hrSamples.push({ ts, bpm, src });

  // window points (last 15 min)
  windowPoints.push({ x: ts, y: bpm });
  const cutoff = ts - HR_WINDOW_MS;
  while (windowPoints.length && windowPoints[0].x < cutoff) windowPoints.shift();
  if (windowPoints.length > MAX_WINDOW_POINTS) {
    windowPoints = windowPoints.slice(windowPoints.length - MAX_WINDOW_POINTS);
  }

  drawChartThrottled();
}

function onSpeedSample(ts, kmh, effectiveKmh, src) {
  speedNow = effectiveKmh;
  $("speedNow").textContent = speedNow.toFixed(1);

  speedSamples.push({ ts, kmh, effectiveKmh, src });

  // If currently in rest lap, keep showing 0 by design
}

// seconds since last sample
setInterval(() => {
  const el = $("lastSeen");
  if (!lastHrTimestamp) el.textContent = "--";
  else el.textContent = String(Math.max(0, Math.floor((Date.now() - lastHrTimestamp) / 1000)));
}, 500);

// ----- HR Canvas chart (15 min, y = min/max ±10)
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

  // line
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

// ----- Timer phases: warmup -> (work/rest)*reps -> cooldown
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
  workoutStartTs = Date.now();
  workoutEndTs = 0;

  laps = [];
  currentLap = null;

  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;

  // Create initial lap based on warmup
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

function stopTimer(manual = true) {
  if (!timerRunning) return;

  timerRunning = false;
  clearInterval(timerTick);
  timerTick = null;

  endLap();

  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  $("timerPhase").textContent = "Stoppet";

  workoutEndTs = Date.now();

  // Finalize per-lap stats and show result modal if workout completed (or even manual)
  finalizeLapStats();
  renderZones();
  renderLapStatsText();
  showResultsModal();
}

function resetTimer() {
  if (timerRunning) stopTimer(true);
  elapsedSec = 0;
  $("timerClock").textContent = "00:00";
  $("timerPhase").textContent = "Stoppet";
  laps = [];
  currentLap = null;
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
      rep = 0;
    } else if (t < warm + totalMain) {
      const t2 = t - warm;
      const cycleIndex = Math.floor(t2 / cycle);
      const within = t2 % cycle;
      rep = cycleIndex + 1;
      phase = (within < work) ? "work" : "rest";
    } else {
      phase = "cooldown";
      rep = 0;
    }
  }

  if (phase === "done") {
    $("timerPhase").textContent = "Ferdig";
    stopTimer(false);
    return;
  }

  // ensure lap matches current phase
  if (!currentLap || currentLap.type !== phase || currentLap.repIndex !== rep) {
    endLap();
    startLap(phase, rep);
  }

  // UI text
  if (phase === "warmup") $("timerPhase").textContent = "Oppvarming";
  else if (phase === "cooldown") $("timerPhase").textContent = "Nedjogg";
  else if (phase === "work") $("timerPhase").textContent = `Arbeid (Drag ${rep}/${reps})`;
  else $("timerPhase").textContent = `Pause (Drag ${rep}/${reps})`;

  // Generate samples if simulating
  if (shouldSimulate()) {
    const bpm = simulateHR(phase);
    onHrSample(Date.now(), bpm, "sim");
  }

  // If treadmill is connected but we are in rest -> effective speed forced 0; also show as 0
  if (currentLap && currentLap.type === "rest") {
    speedNow = 0;
    $("speedNow").textContent = "0.0";
  }

  // lightweight periodic refresh
  if (elapsedSec % 2 === 0) {
    renderZones();
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
  simBpm += (rand() - 0.5) * 3.0;
  simBpm = Math.max(50, Math.min(210, simBpm));
  return Math.round(simBpm);
}

// ----- Laps
function startLap(type, repIndex) {
  currentLap = {
    type, repIndex,
    startTs: Date.now(),
    endTs: null,
    max30bpm: null,
    speedKmh: (type === "rest") ? 0 : null
  };
  laps.push(currentLap);
}

function endLap() {
  if (currentLap && !currentLap.endTs) {
    currentLap.endTs = Date.now();
    // capture "effective speed" average during this lap if we have treadmill samples
    if (currentLap.type === "rest") {
      currentLap.speedKmh = 0;
    } else {
      const s = speedSamples.filter(p => p.ts >= currentLap.startTs && p.ts <= currentLap.endTs);
      if (s.length) {
        // avg of effective speed
        const avg = s.reduce((a,b)=>a+b.effectiveKmh, 0) / s.length;
        currentLap.speedKmh = Math.round(avg * 10) / 10;
      }
    }
  }
  currentLap = null;
}

// ----- Max 30s avg per work lap (time-weighted)
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

    const avg30 = area / 30;
    if (avg30 > best) best = avg30;
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
    const max30 = lap.max30bpm;
    lines.push(`Drag nr ${lap.repIndex}: max30s = ${max30 ? max30.toFixed(1) : "—"} bpm  ·  fart = ${lap.speedKmh ?? "—"} km/t`);
  }
  $("lapStats").textContent = lines.join("\n");
}

// ----- Zones
function readZonesFromUI() {
  const z1 = readInt("z1"), z2 = readInt("z2"), z3 = readInt("z3"), z4 = readInt("z4"), z5 = readInt("z5");
  const arr = [z1,z2,z3,z4,z5].map(v => Math.max(0,v));
  for (let i=1;i<arr.length;i++) if (arr[i] < arr[i-1]) arr[i] = arr[i-1];
  zoneThresholds = { z1: arr[0], z2: arr[1], z3: arr[2], z4: arr[3], z5: arr[4] };
  $("z1").value = zoneThresholds.z1; $("z2").value = zoneThresholds.z2; $("z3").value = zoneThresholds.z3; $("z4").value = zoneThresholds.z4; $("z5").value = zoneThresholds.z5;
}

function zoneOfBpm(bpm) {
  const { z1,z2,z3,z4,z5 } = zoneThresholds;
  if (bpm < z1) return 0;
  if (bpm < z2) return 1;
  if (bpm < z3) return 2;
  if (bpm < z4) return 3;
  if (bpm < z5) return 4;
  return 5;
}

function computeZoneSeconds(samples) {
  const zoneSec = [0,0,0,0,0,0];
  if (samples.length < 2) return zoneSec;
  const sorted = samples.slice().sort((a,b)=>a.ts-b.ts);
  for (let i=0;i<sorted.length-1;i++) {
    const s = sorted[i];
    const dt = Math.max(0, Math.min(5, (sorted[i+1].ts - s.ts) / 1000));
    zoneSec[zoneOfBpm(s.bpm)] += dt;
  }
  return zoneSec;
}

function renderZones() {
  if (hrSamples.length < 2) {
    for (let z=0;z<=5;z++) { $(`barS${z}`).style.width="0%"; $(`timeS${z}`).textContent="—"; }
    return;
  }
  const zoneSec = computeZoneSeconds(hrSamples);
  const maxSec = Math.max(...zoneSec, 1);
  for (let z=0;z<=5;z++) {
    $(`barS${z}`).style.width = `${((zoneSec[z]/maxSec)*100).toFixed(1)}%`;
    $(`timeS${z}`).textContent = fmtTime(zoneSec[z]);
  }
}

// ----- Results modal + charts
function showResultsModal() {
  // Persist automatically
  saveCurrentSession().catch(console.warn);

  const modal = $("resultsModal");
  modal.classList.remove("hidden");

  // Subtitle
  const when = new Date().toLocaleString("no-NO");
  $("resultsSub").textContent = `${when}${$("note").value ? " · " + $("note").value : ""}`;

  // Summary numbers
  const warm = readInt("warmupSec");
  const work = readInt("workSec");
  const rest = readInt("restSec");
  const reps = readInt("reps");
  const cool = readInt("cooldownSec");

  const totalPlanned = warm + reps*(work+rest) + cool;
  const totalActual = elapsedSec;

  const workTime = laps.filter(l=>l.type==="work" && l.endTs).reduce((a,l)=>a + (l.endTs-l.startTs)/1000, 0);
  const warmTime = laps.filter(l=>l.type==="warmup" && l.endTs).reduce((a,l)=>a + (l.endTs-l.startTs)/1000, 0);
  const coolTime = laps.filter(l=>l.type==="cooldown" && l.endTs).reduce((a,l)=>a + (l.endTs-l.startTs)/1000, 0);

  const zoneSec = computeZoneSeconds(hrSamples);
  renderZonesToResults(zoneSec);

  $("summaryText").textContent =
`Totaltid:      ${fmtTime(totalActual)} (plan: ${fmtTime(totalPlanned)})
Dragtid (sum):  ${fmtTime(workTime)}
Oppvarming:    ${fmtTime(warmTime)}
Nedjogg:       ${fmtTime(coolTime)}
Reps:          ${reps}
Fart i pauser: 0 (tvunget)`;

  // Speed editor UI
  renderSpeedEditor();

  // Draw results bar chart
  drawResultsChart();

  // Bind buttons
  $("closeResultsBtn").onclick = () => modal.classList.add("hidden");
  $("exportJsonBtn2").onclick = exportJSON;
  $("exportPngBtn").onclick = exportResultsPNG;
  $("sharePngBtn").onclick = shareResultsPNG;
  $("saveEditsBtn").onclick = async () => {
    applySpeedEditsFromUI();
    finalizeLapStats();
    renderLapStatsText();
    drawResultsChart();
    await saveCurrentSession();
    alert("Lagret.");
  };
}

function renderZonesToResults(zoneSec) {
  const maxSec = Math.max(...zoneSec, 1);
  for (let z=0;z<=5;z++) {
    $(`rbarS${z}`).style.width = `${((zoneSec[z]/maxSec)*100).toFixed(1)}%`;
    $(`rtimeS${z}`).textContent = fmtTime(zoneSec[z]);
  }
}

function renderSpeedEditor() {
  const wrap = $("speedEditor");
  const workLaps = laps.filter(l => l.type === "work" && l.endTs);

  if (!workLaps.length) {
    wrap.textContent = "—";
    return;
  }

  wrap.innerHTML = "";
  for (const lap of workLaps) {
    const row = document.createElement("div");
    row.className = "speedRow";

    const label = document.createElement("div");
    label.className = "speedRowLabel";
    label.textContent = `Drag nr ${lap.repIndex}`;

    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.1";
    input.min = "0";
    input.value = (lap.speedKmh ?? 0).toFixed(1);
    input.dataset.rep = String(lap.repIndex);

    row.appendChild(label);
    row.appendChild(input);
    wrap.appendChild(row);
  }
}

function applySpeedEditsFromUI() {
  const inputs = Array.from($("speedEditor").querySelectorAll("input"));
  const map = new Map(inputs.map(i => [parseInt(i.dataset.rep,10), parseFloat(i.value)]));
  for (const lap of laps) {
    if (lap.type === "work" && map.has(lap.repIndex)) {
      lap.speedKmh = Math.max(0, Math.round(map.get(lap.repIndex)*10)/10);
    }
    if (lap.type === "rest") lap.speedKmh = 0; // force 0
  }
}

function drawResultsChart() {
  const canvas = $("resultsCanvas");
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = rect.width;
  const h = rect.height;

  ctx.clearRect(0, 0, w, h);

  const workLaps = laps.filter(l => l.type === "work" && l.endTs);
  const values = workLaps.map(l => l.max30bpm || 0);

  const padL = 56, padR = 14, padT = 14, padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // y scale: based on values and zones
  let minY = 60, maxY = 200;
  if (values.length) {
    const lo = Math.min(...values.filter(v=>v>0), 999);
    const hi = Math.max(...values, 0);
    if (isFinite(lo) && lo !== 999) minY = Math.max(30, Math.floor(lo - 10));
    maxY = Math.min(240, Math.ceil(hi + 10));
    if (maxY - minY < 40) maxY = minY + 40;
  }

  const yToPx = (y) => padT + (1 - (y - minY) / (maxY - minY)) * plotH;

  // Zone background bands (dus)
  const bands = [
    { from: -Infinity, to: zoneThresholds.z1, color: "rgba(255,255,255,0.06)" }, // S0
    { from: zoneThresholds.z1, to: zoneThresholds.z2, color: "rgba(47,132,255,0.10)" }, // S1
    { from: zoneThresholds.z2, to: zoneThresholds.z3, color: "rgba(39,245,164,0.08)" }, // S2
    { from: zoneThresholds.z3, to: zoneThresholds.z4, color: "rgba(255,213,0,0.10)" }, // S3
    { from: zoneThresholds.z4, to: zoneThresholds.z5, color: "rgba(255,159,26,0.10)" }, // S4
    { from: zoneThresholds.z5, to: Infinity, color: "rgba(255,59,48,0.10)" }, // S5
  ];

  for (const b of bands) {
    const yTop = yToPx(Math.min(maxY, b.to === Infinity ? maxY : b.to));
    const yBot = yToPx(Math.max(minY, b.from === -Infinity ? minY : b.from));
    const top = Math.min(yTop, yBot);
    const height = Math.abs(yBot - yTop);
    ctx.fillStyle = b.color;
    ctx.fillRect(padL, top, plotW, height);
  }

  // Grid + y labels
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i=0;i<=5;i++) {
    const y = padT + (i/5)*plotH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    const yVal = Math.round(maxY - (i/5)*(maxY-minY));
    ctx.fillText(String(yVal), padL-8, y);
  }

  // Bars
  const n = Math.max(1, workLaps.length);
  const gap = 10;
  const barW = Math.max(10, (plotW - gap*(n-1)) / n);

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(255,255,255,0.80)";

  for (let i=0;i<workLaps.length;i++) {
    const v = values[i];
    const x = padL + i*(barW + gap);
    const y = yToPx(v || minY);
    const y0 = yToPx(minY);

    // bar fill
    ctx.fillStyle = "rgba(39,245,164,0.85)";
    ctx.fillRect(x, y, barW, y0 - y);

    // drag label
    ctx.fillStyle = "rgba(255,255,255,0.80)";
    ctx.fillText(String(workLaps[i].repIndex), x + barW/2, padT + plotH + 8);
  }

  // x axis label
  ctx.fillStyle = "rgba(255,255,255,0.70)";
  ctx.fillText("Drag nr", padL + plotW/2, h - 18);
}

function exportResultsPNG() {
  const canvas = $("resultsCanvas");
  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = `hr-resultat-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function shareResultsPNG() {
  const canvas = $("resultsCanvas");
  if (!navigator.canShare) {
    alert("Deling støttes ikke på denne enheten.");
    return;
  }
  const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
  const file = new File([blob], `hr-resultat-${Date.now()}.png`, { type: "image/png" });

  if (navigator.canShare({ files: [file] })) {
    await navigator.share({ title: "HR resultat", files: [file] });
  } else {
    alert("Deling av filer støttes ikke her.");
  }
}

// ----- Export JSON (session)
function exportJSON() {
  const payload = buildSessionPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hr-session-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildSessionPayload(existingId = null) {
  return {
    id: existingId || uid(),
    createdAt: new Date().toISOString(),
    note: $("note").value || "",
    config: {
      warmupSec: readInt("warmupSec"),
      workSec: readInt("workSec"),
      restSec: readInt("restSec"),
      cooldownSec: readInt("cooldownSec"),
      reps: readInt("reps"),
      simMode: $("simMode").value
    },
    zones: zoneThresholds,
    laps,
    hrSamples,
    speedSamples
  };
}

let lastSavedSessionId = null;

async function saveCurrentSession() {
  const payload = buildSessionPayload(lastSavedSessionId);
  lastSavedSessionId = payload.id;
  await dbPut(payload);
  await refreshSessionList();
}

// ----- Clear
function clearAllData() {
  windowPoints = [];
  hrSamples = [];
  speedSamples = [];
  laps = [];
  currentLap = null;
  lastHrTimestamp = 0;
  sampleCount = 0;
  elapsedSec = 0;
  lastSavedSessionId = null;

  $("pulseValue").textContent = "--";
  $("speedNow").textContent = "0.0";
  $("lastSeen").textContent = "--";
  $("timerClock").textContent = "00:00";
  $("timerPhase").textContent = "Stoppet";

  renderZones();
  renderLapStatsText();
  drawCanvasChart();

  setStatus("Tømte data");
}

// ----- Sessions UI
async function refreshSessionList() {
  const list = await dbGetAll();
  list.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const sel = $("sessionSelect");
  sel.innerHTML = "";

  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = list.length ? "Velg økt…" : "Ingen lagrede økter";
  sel.appendChild(opt0);

  for (const s of list) {
    const o = document.createElement("option");
    o.value = s.id;
    const date = (s.createdAt || "").replace("T"," ").slice(0,16);
    o.textContent = `${date}${s.note ? " · " + s.note : ""}`;
    sel.appendChild(o);
  }
}

async function loadSelectedSession() {
  const id = $("sessionSelect").value;
  if (!id) return;

  const sess = await dbGet(id);
  if (!sess) return;

  // Load into state
  lastSavedSessionId = sess.id;
  zoneThresholds = sess.zones || zoneThresholds;

  $("z1").value = zoneThresholds.z1;
  $("z2").value = zoneThresholds.z2;
  $("z3").value = zoneThresholds.z3;
  $("z4").value = zoneThresholds.z4;
  $("z5").value = zoneThresholds.z5;

  $("note").value = sess.note || "";

  const cfg = sess.config || {};
  $("warmupSec").value = cfg.warmupSec ?? 0;
  $("workSec").value = cfg.workSec ?? 60;
  $("restSec").value = cfg.restSec ?? 30;
  $("cooldownSec").value = cfg.cooldownSec ?? 0;
  $("reps").value = cfg.reps ?? 6;
  $("simMode").value = cfg.simMode ?? "auto";

  laps = sess.laps || [];
  hrSamples = sess.hrSamples || [];
  speedSamples = sess.speedSamples || [];

  // rebuild windowPoints from last 15 min
  const now = Date.now();
  windowPoints = hrSamples
    .filter(p => p.ts >= now - HR_WINDOW_MS)
    .map(p => ({ x: p.ts, y: p.bpm }));

  // set current display
  const last = hrSamples[hrSamples.length-1];
  $("pulseValue").textContent = last ? last.bpm : "--";

  // speed now
  const ls = speedSamples[speedSamples.length-1];
  speedNow = ls ? ls.effectiveKmh : 0.0;
  $("speedNow").textContent = speedNow.toFixed(1);

  finalizeLapStats();
  renderZones();
  renderLapStatsText();
  drawCanvasChart();

  // Show results modal for loaded session
  $("resultsModal").classList.remove("hidden");
  $("resultsSub").textContent = `Lastet økt: ${sess.createdAt?.replace("T"," ").slice(0,16) || ""}`;
  renderSpeedEditor();
  drawResultsChart();
  $("summaryText").textContent = "— (lastet økt)";
  renderZonesToResults(computeZoneSeconds(hrSamples));
}

async function deleteSelectedSession() {
  const id = $("sessionSelect").value;
  if (!id) return;
  await dbDelete(id);
  await refreshSessionList();
  alert("Slettet.");
}

// ----- Capability check
function initCapabilityCheck() {
  hideIOSNotice();

  if (!("bluetooth" in navigator)) {
    $("connectBtn").disabled = true;
    $("treadmillBtn").disabled = true;

    if (isIOS()) {
      showIOSNotice(isSafari()
        ? "iOS Safari støtter ikke Web Bluetooth for pulsbelter. Bruk Android (Chrome/Edge)."
        : "iOS støtter normalt ikke Web Bluetooth i vanlige nettlesere. Bruk Android.");
    }
    setStatus("Web Bluetooth ikke støttet i denne nettleseren.");
    return;
  }

  $("connectBtn").disabled = false;
  $("treadmillBtn").disabled = false;
  setStatus("Klar");
}

// ----- Bind UI
function bindUI() {
  $("connectBtn").addEventListener("click", connectHR);
  $("treadmillBtn").addEventListener("click", connectTreadmill);

  $("startBtn").addEventListener("click", startTimer);
  $("stopBtn").addEventListener("click", () => stopTimer(true));
  $("resetBtn").addEventListener("click", resetTimer);

  $("applyZonesBtn").addEventListener("click", () => { readZonesFromUI(); renderZones(); drawResultsChart(); });
  ["z1","z2","z3","z4","z5"].forEach(id => $(id).addEventListener("change", () => { readZonesFromUI(); renderZones(); }));

  $("exportBtn").addEventListener("click", exportJSON);
  $("clearBtn").addEventListener("click", clearAllData);

  $("loadSessionBtn").addEventListener("click", loadSelectedSession);
  $("deleteSessionBtn").addEventListener("click", deleteSelectedSession);
}

// ----- Init
async function init() {
  await setupUpdateBanner(); // update banner at top [2](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/updatefound_event)[1](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/skipWaiting)
  initCapabilityCheck();
  bindUI();
  readZonesFromUI();
  drawCanvasChart();
  renderZones();
  renderLapStatsText();
  await refreshSessionList();
}

// first paint
init().catch(console.warn);
