
/* app.js – HR app: BLE + offline canvas chart + dummy timer + drag stats + zone bars */

const HR_WINDOW_MS = 15 * 60 * 1000;           // 15 min window (requested)
const MAX_WINDOW_POINTS = 15 * 60 * 3;         // allow up to ~3 Hz
const CHART_FPS_MS = 250;

const $ = (id) => document.getElementById(id);

// BLE
let device = null;
let characteristic = null;

// Data
let lastHrTimestamp = 0;
let lastChartDraw = 0;

let windowPoints = [];   // {x:ts, y:bpm} for last 15 min
let sessionPoints = [];  // full session {ts, bpm, src}

// Timer/Laps
let timerRunning = false;
let timerTick = null;
let elapsedSec = 0;

let laps = [];           // {index, type, repIndex, startTs, endTs}
let currentLap = null;

// Simulation
const rand = (() => {
  let x = 123456789 >>> 0;
  return () => ((x = (1664525 * x + 1013904223) >>> 0) / 4294967296);
})();
let simBpm = 92;

// Canvas scaling
let canvasDpr = 1;
let canvasW = 0;
let canvasH = 0;

// Zones (custom)
let zoneThresholds = { z1: 110, z2: 130, z3: 150, z4: 165, z5: 180 };

// ---------- Capability / iOS notice ----------
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
function setStatus(text) { $("statusText").textContent = text; }

function showIOSNotice(message) {
  const el = $("iosNotice");
  el.textContent = message;
  el.classList.remove("hidden");
}
function hideIOSNotice() { $("iosNotice").classList.add("hidden"); }

// ---------- BLE ----------
async function connectBLE() {
  try {
    setStatus("Åpner Bluetooth-dialog…");

    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ["heart_rate"] }],
      optionalServices: ["battery_service"]
    });

    device.addEventListener("gattserverdisconnected", () => {
      setStatus("Frakoblet – trykk for å koble til igjen");
    });

    setStatus("Kobler til…");
    const server = await device.gatt.connect();

    const service = await server.getPrimaryService("heart_rate");
    characteristic = await service.getCharacteristic("heart_rate_measurement");

    await characteristic.startNotifications();
    characteristic.addEventListener("characteristicvaluechanged", handleHR);

    setStatus(`Tilkoblet: ${device.name || "pulsbelte"}`);
  } catch (err) {
    console.error(err);
    setStatus("Tilkobling feilet");
    alert("Kunne ikke koble til pulsbelte. Sjekk at Bluetooth er på, og bruk Chrome/Edge på Android.");
  }
}

function parseHeartRate(value) {
  const flags = value.getUint8(0);
  const is16Bit = (flags & 0x01) !== 0;
  return is16Bit ? value.getUint16(1, true) : value.getUint8(1);
}
function handleHR(event) {
  const hr = parseHeartRate(event.target.value);
  onSample(Date.now(), hr, "ble");
}

// ---------- Sample pipeline ----------
function onSample(ts, bpm, src) {
  lastHrTimestamp = ts;
  $("pulseValue").textContent = bpm;

  sessionPoints.push({ ts, bpm, src });

  windowPoints.push({ x: ts, y: bpm });

  // prune to last 15 min
  const cutoff = ts - HR_WINDOW_MS;
  while (windowPoints.length && windowPoints[0].x < cutoff) windowPoints.shift();
  if (windowPoints.length > MAX_WINDOW_POINTS) {
    windowPoints = windowPoints.slice(windowPoints.length - MAX_WINDOW_POINTS);
  }

  drawChartThrottled();
}

// seconds since last sample UI
setInterval(() => {
  const el = $("lastSeen");
  if (!lastHrTimestamp) el.textContent = "--";
  else el.textContent = String(Math.max(0, Math.floor((Date.now() - lastHrTimestamp) / 1000)));
}, 500);

// ---------- Canvas chart ----------
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

  const w = canvasW;
  const h = canvasH;
  if (!w || !h) return;

  // background
  ctx.clearRect(0, 0, w, h);

  // plot area padding
  const padL = 62, padR = 18, padT = 16, padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const now = Date.now();
  const minX = now - HR_WINDOW_MS;
  const maxX = now;

  // Y scale: based on last 15 min values +/-10 bpm (requested)
  let minY = 60, maxY = 180;
  if (windowPoints.length >= 2) {
    const ys = windowPoints.map(p => p.y);
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    minY = Math.max(30, Math.floor(lo - 10));
    maxY = Math.min(240, Math.ceil(hi + 10));
    if (maxY - minY < 20) maxY = minY + 20;
  }

  const xToPx = (x) => padL + ((x - minX) / (maxX - minX)) * plotW;
  const yToPx = (y) => padT + (1 - (y - minY) / (maxY - minY)) * plotH;

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;

  // horizontal grid + y labels
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= 5; i++) {
    const y = padT + (i / 5) * plotH;

    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();

    const yVal = Math.round(maxY - (i / 5) * (maxY - minY));
    ctx.fillText(String(yVal), padL - 10, y);
  }

  // vertical grid + x labels
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i <= 5; i++) {
    const x = padL + (i / 5) * plotW;

    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();

    const minsAgo = Math.round((1 - i / 5) * 15);
    ctx.fillText(`-${minsAgo}m`, x, padT + plotH + 8);
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

  // last marker
  if (windowPoints.length) {
    const p = windowPoints[windowPoints.length - 1];
    const x = xToPx(p.x);
    const y = yToPx(p.y);

    ctx.fillStyle = "rgba(39,245,164,0.20)";
    ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = "#27f5a4";
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  }
}

window.addEventListener("resize", () => drawCanvasChart());

// ---------- Timer / Laps ----------
function mmss(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function readInt(id) {
  const v = parseInt($(id).value, 10);
  return Number.isFinite(v) ? v : 0;
}

function shouldSimulate() {
  const mode = $("simMode").value;
  if (mode === "force") return true;
  if (mode === "off") return false;
  return !("bluetooth" in navigator) || !characteristic;
}

function startTimer() {
  if (timerRunning) return;

  timerRunning = true;
  elapsedSec = 0;

  // new session run: clear laps only (keep sessionPoints if you want; we keep them for now)
  laps = [];
  currentLap = null;

  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;

  // Begin with work rep 1
  advanceToLap(1, "work");
  updateTimerUI();

  timerTick = setInterval(() => tickTimer(), 1000);
}

function stopTimer() {
  if (!timerRunning) return;
  timerRunning = false;

  clearInterval(timerTick);
  timerTick = null;

  closeCurrentLap();

  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;

  $("timerPhase").textContent = "Stoppet";

  renderDragStats();
  renderZones();
}

function resetTimer() {
  stopTimer();
  elapsedSec = 0;
  $("timerClock").textContent = "00:00";
  $("timerPhase").textContent = "Stoppet";
  laps = [];
  currentLap = null;
  renderDragStats();
}

function tickTimer() {
  elapsedSec++;
  updateTimerUI();

  const work = readInt("workSec");
  const rest = readInt("restSec");
  const reps = readInt("reps");

  const cycle = work + rest;
  const totalPlanned = reps * cycle;

  const t = elapsedSec - 1; // time since start

  let phase = "done";
  let rep = reps;

  if (t < totalPlanned) {
    const cycleIndex = Math.floor(t / cycle);
    const within = t % cycle;
    rep = cycleIndex + 1;
    phase = (within < work) ? "work" : "rest";
  }

  if (phase === "done") {
    $("timerPhase").textContent = "Ferdig";
    stopTimer();
    return;
  }

  if (!currentLap || currentLap.type !== phase || currentLap.repIndex !== rep) {
    advanceToLap(rep, phase);
  }

  $("timerPhase").textContent = phase === "work"
    ? `Arbeid (Drag ${rep}/${reps})`
    : `Pause (Drag ${rep}/${reps})`;

  if (shouldSimulate()) {
    const bpm = simulateHR(phase);
    onSample(Date.now(), bpm, "sim");
  }

  // update stats periodically
  if (elapsedSec % 2 === 0) {
    renderDragStats();
    renderZones();
  }
}

function updateTimerUI() {
  $("timerClock").textContent = mmss(elapsedSec);
}

function simulateHR(phase) {
  // Simple "rise/fall" model
  const baseline = 88;
  const workTarget = 162;
  let target = baseline;
  let speed = 0.10;

  if (phase === "work") { target = workTarget; speed = 0.13; }
  if (phase === "rest") { target = baseline + 12; speed = 0.12; }

  simBpm = simBpm + (target - simBpm) * speed;
  simBpm += (rand() - 0.5) * 3.0;
  simBpm = Math.max(50, Math.min(210, simBpm));
  return Math.round(simBpm);
}

function advanceToLap(repIndex, type) {
  closeCurrentLap();
  const lap = {
    index: laps.length + 1,
    type,
    repIndex,
    startTs: Date.now(),
    endTs: null
  };
  laps.push(lap);
  currentLap = lap;
}
function closeCurrentLap() {
  if (currentLap && !currentLap.endTs) currentLap.endTs = Date.now();
}

// ---------- Drag stats: max 30s average ----------
function getSamplesInRange(startTs, endTs) {
  return sessionPoints.filter(p => p.ts >= startTs && p.ts <= endTs);
}

function computeMax30sAverage(samples) {
  // Resample to 1Hz mean per second, then rolling 30-second average, take max.
  if (!samples.length) return null;

  const bySec = new Map(); // sec -> array bpm
  for (const s of samples) {
    const sec = Math.floor(s.ts / 1000);
    if (!bySec.has(sec)) bySec.set(sec, []);
    bySec.get(sec).push(s.bpm);
  }

  const secs = Array.from(bySec.keys()).sort((a,b)=>a-b);
  if (secs.length === 0) return null;

  const series = secs.map(sec => {
    const vals = bySec.get(sec);
    return vals.reduce((a,b)=>a+b,0) / vals.length;
  });

  if (series.length < 30) {
    // if shorter than 30s, return avg of available
    const a = series.reduce((a,b)=>a+b,0) / series.length;
    return a;
  }

  let best = -Infinity;
  let sum = 0;

  for (let i = 0; i < series.length; i++) {
    sum += series[i];
    if (i >= 30) sum -= series[i - 30];
    if (i >= 29) {
      const avg30 = sum / 30;
      if (avg30 > best) best = avg30;
    }
  }
  return best;
}

function renderDragStats() {
  const workLaps = laps.filter(l => l.type === "work" && l.startTs && l.endTs);

  if (!workLaps.length) {
    $("lapStats").textContent = "—";
    return;
  }

  const lines = [];
  for (const lap of workLaps) {
    const samples = getSamplesInRange(lap.startTs, lap.endTs);
    const max30 = computeMax30sAverage(samples);

    lines.push(
      `Drag nr ${lap.repIndex}: makspuls (max 30s snitt) = ${max30 ? max30.toFixed(1) : "—"} bpm`
    );
  }

  $("lapStats").textContent = lines.join("\n");
}

// ---------- Zones: custom thresholds + horizontal bar chart ----------
function readZonesFromUI() {
  const z1 = readInt("z1");
  const z2 = readInt("z2");
  const z3 = readInt("z3");
  const z4 = readInt("z4");
  const z5 = readInt("z5");

  // Ensure monotonic increasing
  const arr = [z1, z2, z3, z4, z5].map(v => Math.max(0, v));
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < arr[i-1]) arr[i] = arr[i-1];
  }
  zoneThresholds = { z1: arr[0], z2: arr[1], z3: arr[2], z4: arr[3], z5: arr[4] };

  // write back normalized values
  $("z1").value = zoneThresholds.z1;
  $("z2").value = zoneThresholds.z2;
  $("z3").value = zoneThresholds.z3;
  $("z4").value = zoneThresholds.z4;
  $("z5").value = zoneThresholds.z5;
}

function zoneOfBpm(bpm) {
  const { z1, z2, z3, z4, z5 } = zoneThresholds;
  if (bpm < z1) return 0;  // S0
  if (bpm < z2) return 1;  // S1
  if (bpm < z3) return 2;  // S2
  if (bpm < z4) return 3;  // S3
  if (bpm < z5) return 4;  // S4
  return 5;                // S5
}

function computeZoneSeconds(samples) {
  const zoneSec = [0,0,0,0,0,0];
  if (samples.length < 2) return zoneSec;

  const sorted = samples.slice().sort((a,b)=>a.ts-b.ts);

  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i];
    const dt = Math.max(0, Math.min(5, (sorted[i+1].ts - s.ts) / 1000)); // cap to 5s
    const z = zoneOfBpm(s.bpm);
    zoneSec[z] += dt;
  }
  return zoneSec;
}

function fmtTime(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2,"0")}`;
}

function renderZones() {
  const samples = sessionPoints;
  if (samples.length < 2) {
    for (let z = 0; z <= 5; z++) {
      $(`barS${z}`).style.width = "0%";
      $(`timeS${z}`).textContent = "—";
    }
    return;
  }

  const zoneSec = computeZoneSeconds(samples);
  const maxSec = Math.max(...zoneSec, 1);

  // scale each bar to max zone time
  for (let z = 0; z <= 5; z++) {
    const pct = (zoneSec[z] / maxSec) * 100;
    $(`barS${z}`).style.width = `${pct.toFixed(1)}%`;
    $(`timeS${z}`).textContent = fmtTime(zoneSec[z]);
  }
}

// ---------- Export / clear ----------
function exportJSON() {
  const payload = {
    exportedAt: new Date().toISOString(),
    note: $("note").value || "",
    config: {
      workSec: readInt("workSec"),
      restSec: readInt("restSec"),
      reps: readInt("reps"),
      zones: zoneThresholds,
      simMode: $("simMode").value
    },
    laps,
    samples: sessionPoints
  };

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

function clearAllData() {
  windowPoints = [];
  sessionPoints = [];
  laps = [];
  currentLap = null;
  lastHrTimestamp = 0;

  $("pulseValue").textContent = "--";
  $("lastSeen").textContent = "--";

  renderDragStats();
  renderZones();
  drawCanvasChart();
}

// ---------- Init ----------
function initCapabilityCheck() {
  hideIOSNotice();

  const btn = $("connectBtn");

  if (!("bluetooth" in navigator)) {
    btn.disabled = true;
    if (isIOS()) {
      if (isSafari()) {
        showIOSNotice("iOS Safari støtter ikke Web Bluetooth for pulsbelter. Bruk Android (Chrome/Edge) for BLE i nettleser.");
      } else {
        showIOSNotice("iOS støtter normalt ikke Web Bluetooth i vanlige nettlesere. Bruk Android for enklest BLE-støtte i web.");
      }
    }
    setStatus("Web Bluetooth ikke støttet i denne nettleseren.");
    return;
  }

  btn.disabled = false;
  setStatus("Ikke tilkoblet");
}

function bindUI() {
  $("connectBtn").addEventListener("click", connectBLE);
  $("startBtn").addEventListener("click", startTimer);
  $("stopBtn").addEventListener("click", stopTimer);
  $("resetBtn").addEventListener("click", resetTimer);

  $("exportBtn").addEventListener("click", exportJSON);
  $("clearBtn").addEventListener("click", clearAllData);

  $("applyZonesBtn").addEventListener("click", () => {
    readZonesFromUI();
    renderZones();
  });

  // live update zones when input changes (optional)
  ["z1","z2","z3","z4","z5"].forEach(id => {
    $(id).addEventListener("change", () => {
      readZonesFromUI();
      renderZones();
    });
  });
}

function init() {
  // zones initial
  readZonesFromUI();

  initCapabilityCheck();
  bindUI();

  // chart initial
  drawCanvasChart();

  // baseline stats
  renderDragStats();
  renderZones();
}

init();

// Update stats while running
setInterval(() => {
  if (timerRunning) {
    renderDragStats();
    renderZones();
  }
}, 2000);
``
