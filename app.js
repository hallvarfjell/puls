
/* app.js – HR app: BLE HRM + offline canvas chart + dummy timer + stats */

const HR_WINDOW_MS = 10 * 60 * 1000; // 10 min visible window
const MAX_WINDOW_POINTS = 10 * 60 * 2; // allow up to ~2 Hz
const CHART_FPS_MS = 250; // redraw throttle ~4 fps

// --- DOM helpers
const $ = (id) => document.getElementById(id);

// --- State
let device = null;
let characteristic = null;

let lastHrTimestamp = 0;
let lastChartDraw = 0;

let windowPoints = []; // recent: {x:ts, y:bpm}
let sessionPoints = []; // full session samples (for stats/export): {ts, bpm, src}

// Timer/laps
let timerRunning = false;
let timerT0 = 0;        // session start time
let timerTick = null;
let elapsedSec = 0;

let currentLap = null;  // {index, type, startTs, endTs?}
let laps = [];          // list of laps

// Dummy mode
let simState = {
  bpm: 90,
  drift: 0,
  noiseSeed: 12345
};

// --- Capability detection (iOS/Safari notice)
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

function setStatus(text) {
  $("statusText").textContent = text;
}

function showIOSNotice(message) {
  const el = $("iosNotice");
  el.textContent = message;
  el.classList.remove("hidden");
}

function hideIOSNotice() {
  $("iosNotice").classList.add("hidden");
}

// --- BLE
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
    alert("Kunne ikke koble til pulsbelte. Bruk Chrome/Edge på Android, og sjekk at Bluetooth er på.");
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

// --- Samples pipeline
function onSample(ts, bpm, src) {
  lastHrTimestamp = ts;
  $("pulseValue").textContent = bpm;

  // session log (only when timer running OR BLE is connected? We'll log always; stats use lap bounds)
  sessionPoints.push({ ts, bpm, src });

  // window buffer for chart
  windowPoints.push({ x: ts, y: bpm });

  // prune older than 10 min
  const cutoff = ts - HR_WINDOW_MS;
  while (windowPoints.length && windowPoints[0].x < cutoff) windowPoints.shift();
  if (windowPoints.length > MAX_WINDOW_POINTS) {
    windowPoints = windowPoints.slice(windowPoints.length - MAX_WINDOW_POINTS);
  }

  // redraw chart throttled
  drawChartThrottled();
}

// seconds since last sample UI
setInterval(() => {
  const el = $("lastSeen");
  if (!lastHrTimestamp) el.textContent = "--";
  else el.textContent = String(Math.max(0, Math.floor((Date.now() - lastHrTimestamp) / 1000)));
}, 500);

// --- Offline chart (canvas)
function drawChartThrottled() {
  const now = Date.now();
  if (now - lastChartDraw < CHART_FPS_MS) return;
  lastChartDraw = now;
  drawCanvasChart();
}

function drawCanvasChart() {
  const canvas = $("hrCanvas");
  const ctx = canvas.getContext("2d");

  const w = canvas.width;
  const h = canvas.height;

  // background
  ctx.clearRect(0, 0, w, h);

  // plot area padding
  const padL = 52, padR = 16, padT = 14, padB = 28;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // compute y bounds
  let minY = 50, maxY = 190;
  if (windowPoints.length >= 2) {
    const ys = windowPoints.map(p => p.y);
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    // add a bit of padding
    minY = Math.max(30, Math.floor(lo - 10));
    maxY = Math.min(240, Math.ceil(hi + 10));
    if (maxY - minY < 30) { maxY = minY + 30; }
  }

  const now = Date.now();
  const minX = now - HR_WINDOW_MS;
  const maxX = now;

  const xToPx = (x) => padL + ((x - minX) / (maxX - minX)) * plotW;
  const yToPx = (y) => padT + (1 - (y - minY) / (maxY - minY)) * plotH;

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;

  // horizontal grid lines (5)
  for (let i = 0; i <= 5; i++) {
    const y = padT + (i / 5) * plotH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
  }

  // vertical grid lines (5)
  for (let i = 0; i <= 5; i++) {
    const x = padL + (i / 5) * plotW;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
  }

  // axes labels (y)
  ctx.fillStyle = "rgba(255,255,255,0.70)";
  ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 5; i++) {
    const yVal = Math.round(maxY - (i / 5) * (maxY - minY));
    const y = padT + (i / 5) * plotH;
    ctx.fillText(String(yVal), padL - 10, y);
  }

  // x ticks show minutes ago
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i <= 5; i++) {
    const x = padL + (i / 5) * plotW;
    const minsAgo = Math.round((1 - i / 5) * 10);
    ctx.fillText(`-${minsAgo}m`, x, padT + plotH + 6);
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
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // last value marker
  if (windowPoints.length) {
    const p = windowPoints[windowPoints.length - 1];
    const x = xToPx(p.x);
    const y = yToPx(p.y);

    ctx.fillStyle = "rgba(39,245,164,0.18)";
    ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = "#27f5a4";
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  }
}

// --- Dummy timer
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
  // auto:
  return !("bluetooth" in navigator) || !characteristic;
}

function startTimer() {
  if (timerRunning) return;

  // reset session/laps for a clean run
  timerRunning = true;
  elapsedSec = 0;
  timerT0 = Date.now();

  laps = [];
  currentLap = null;

  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;

  createLap("warmup"); // we start in "work" immediately in tick logic, but use warmup placeholder
  advanceToLap(1, "work");

  setTimerUI();

  timerTick = setInterval(() => {
    tickTimer();
  }, 1000);
}

function stopTimer() {
  if (!timerRunning) return;
  timerRunning = false;

  clearInterval(timerTick);
  timerTick = null;

  // close current lap
  closeCurrentLap();

  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;

  $("timerPhase").textContent = "Stoppet";

  // render stats final
  renderAllStats();
}

function resetTimer() {
  stopTimer();
  elapsedSec = 0;
  $("timerClock").textContent = "00:00";
  $("timerPhase").textContent = "Stoppet";
  laps = [];
  currentLap = null;
  renderAllStats();
}

function clearAllData() {
  windowPoints = [];
  sessionPoints = [];
  laps = [];
  currentLap = null;
  lastHrTimestamp = 0;
  $("pulseValue").textContent = "--";
  $("lastSeen").textContent = "--";
  renderAllStats();
  drawCanvasChart();
}

function createLap(type) {
  const index = laps.length + 1;
  const startTs = Date.now();
  const lap = { index, type, startTs, endTs: null };
  laps.push(lap);
  currentLap = lap;
}

function closeCurrentLap() {
  if (currentLap && !currentLap.endTs) {
    currentLap.endTs = Date.now();
  }
}

function advanceToLap(repIndex, type) {
  closeCurrentLap();
  createLap(type);
  currentLap.repIndex = repIndex; // 1..reps for work/rest
}

function tickTimer() {
  elapsedSec++;
  setTimerUI();

  const work = readInt("workSec");
  const rest = readInt("restSec");
  const reps = readInt("reps");

  const cycle = work + rest;
  const totalPlanned = reps * cycle;

  // Determine current phase based on elapsedSec in planned workout
  // elapsedSec starts at 1 after first tick; we treat elapsedSec-1 as "time since start"
  const t = elapsedSec - 1;

  let phase = "done";
  let rep = reps;

  if (t < totalPlanned) {
    const cycleIndex = Math.floor(t / cycle); // 0..reps-1
    const within = t % cycle;                 // 0..cycle-1
    rep = cycleIndex + 1;
    phase = (within < work) ? "work" : "rest";
  }

  // Manage lap transitions
  if (!currentLap) {
    createLap(phase);
    currentLap.repIndex = rep;
  } else {
    if (phase === "done") {
      // finish workout
      $("timerPhase").textContent = "Ferdig";
      stopTimer();
      return;
    }

    if (currentLap.type !== phase || currentLap.repIndex !== rep) {
      advanceToLap(rep, phase);
    }
  }

  // Show phase
  $("timerPhase").textContent = phase === "work" ? `Arbeid (rep ${rep}/${reps})` : `Pause (rep ${rep}/${reps})`;

  // Generate a sample each second if simulating OR just rely on BLE events
  if (shouldSimulate()) {
    const bpm = simulateHR(phase);
    onSample(Date.now(), bpm, "sim");
  }
}

function setTimerUI() {
  $("timerClock").textContent = mmss(elapsedSec);
}

function lcg(seed) {
  // simple deterministic pseudo-rng
  let x = seed >>> 0;
  return () => {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 4294967296;
  };
}
const rand = lcg(123456789);

function simulateHR(phase) {
  // Very simple physiological-ish model:
  // - during work: rises toward target; during rest: falls toward baseline
  // - add small noise
  const baseline = 85;
  const workTarget = 160;

  let target = baseline;
  let speed = 0.08; // approach rate

  if (phase === "work") { target = workTarget; speed = 0.12; }
  if (phase === "rest") { target = baseline + 10; speed = 0.10; }

  // smooth approach
  simState.bpm = simState.bpm + (target - simState.bpm) * speed;

  // tiny drift + noise
  const noise = (rand() - 0.5) * 3.0; // +/- 1.5
  simState.bpm += noise;

  // clamp
  simState.bpm = Math.max(50, Math.min(210, simState.bpm));

  return Math.round(simState.bpm);
}

// --- Stats
function getSamplesInRange(startTs, endTs) {
  return sessionPoints.filter(p => p.ts >= startTs && p.ts <= endTs);
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a,b)=>a+b,0) / arr.length;
}
function max(arr) {
  if (!arr.length) return null;
  return arr.reduce((m,v)=>v>m?v:m, -Infinity);
}

function computeMax10sAverage(samples) {
  // Expect samples with timestamps. We resample to 1Hz buckets and do rolling 10s average.
  if (!samples.length) return null;

  // bucket by second
  const bySec = new Map(); // sec -> [bpm...]
  for (const s of samples) {
    const sec = Math.floor(s.ts / 1000);
    if (!bySec.has(sec)) bySec.set(sec, []);
    bySec.get(sec).push(s.bpm);
  }

  // build sorted 1Hz series
  const secs = Array.from(bySec.keys()).sort((a,b)=>a-b);
  if (!secs.length) return null;

  const series = secs.map(sec => {
    const vals = bySec.get(sec);
    // use mean within the second
    return vals.reduce((a,b)=>a+b,0) / vals.length;
  });

  if (series.length < 10) return avg(series); // if short, return avg

  // rolling 10-second window
  let best = -Infinity;
  let sum = 0;

  for (let i = 0; i < series.length; i++) {
    sum += series[i];
    if (i >= 10) sum -= series[i - 10];
    if (i >= 9) {
      const v = sum / 10;
      if (v > best) best = v;
    }
  }

  return best;
}

function zoneIndex(bpm, hrMax) {
  // zones by % of HRmax: Z1<60, Z2 60-70, Z3 70-80, Z4 80-90, Z5 90+
  const pct = bpm / hrMax;
  if (pct < 0.60) return 1;
  if (pct < 0.70) return 2;
  if (pct < 0.80) return 3;
  if (pct < 0.90) return 4;
  return 5;
}

function computeZoneTime(samples, hrMax) {
  // Approx: each sample contributes 1 second if ~1Hz; if more frequent, use delta to next sample
  const zoneSec = { 1:0, 2:0, 3:0, 4:0, 5:0 };

  if (samples.length < 2) return zoneSec;

  const sorted = samples.slice().sort((a,b)=>a.ts-b.ts);

  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i];
    const dt = Math.max(0, Math.min(5, (sorted[i+1].ts - s.ts) / 1000)); // cap dt to 5s safety
    const z = zoneIndex(s.bpm, hrMax);
    zoneSec[z] += dt;
  }
  return zoneSec;
}

function formatZoneTime(zoneSec) {
  const parts = [];
  for (const z of [1,2,3,4,5]) {
    const s = Math.round(zoneSec[z] || 0);
    const m = Math.floor(s / 60);
    const r = s % 60;
    parts.push(`Z${z}: ${m}:${String(r).padStart(2,"0")}`);
  }
  return parts.join("  ");
}

function renderAllStats() {
  // Overall stats (only consider samples during timer if you want; we consider whole sessionPoints)
  const hrMax = readInt("hrMax") || 190;
  const all = sessionPoints;

  if (!all.length) {
    $("overallStats").textContent = "—";
    $("lapStats").textContent = "—";
    return;
  }

  const allBpms = all.map(p => p.bpm);
  const overallAvg = avg(allBpms);
  const overallMax = max(allBpms);
  const zones = computeZoneTime(all, hrMax);

  $("overallStats").textContent =
`Samples: ${all.length}
Snitt:   ${overallAvg ? overallAvg.toFixed(1) : "—"} bpm
Maks:    ${overallMax ?? "—"} bpm
Soner:   ${formatZoneTime(zones)}
Kilder:  BLE=${all.filter(p=>p.src==="ble").length}, SIM=${all.filter(p=>p.src==="sim").length}`;

  // Lap stats (work laps)
  const lines = [];
  const workLaps = laps.filter(l => l.type === "work" && l.startTs && l.endTs);

  if (!workLaps.length) {
    $("lapStats").textContent = "—";
    return;
  }

  for (const lap of workLaps) {
    const samples = getSamplesInRange(lap.startTs, lap.endTs);
    const bpms = samples.map(s => s.bpm);

    const a = avg(bpms);
    const m = max(bpms);
    const max10 = computeMax10sAverage(samples);

    const durS = Math.round((lap.endTs - lap.startTs) / 1000);

    lines.push(
      `Rep ${lap.repIndex}: ${durS}s  snitt=${a ? a.toFixed(1) : "—"}  maks=${m ?? "—"}  max10s=${max10 ? max10.toFixed(1) : "—"}`
    );
  }

  $("lapStats").textContent = lines.join("\n");
}

// --- Export
function exportJSON() {
  const payload = {
    exportedAt: new Date().toISOString(),
    config: {
      workSec: readInt("workSec"),
      restSec: readInt("restSec"),
      reps: readInt("reps"),
      hrMax: readInt("hrMax"),
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

// --- Init
function initCapabilityCheck() {
  const btn = $("connectBtn");

  hideIOSNotice();

  if (!("bluetooth" in navigator)) {
    btn.disabled = true;

    // iOS Safari guidance (kept even if you primarily use Android)
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

  $("startBtn").addEventListener("click", () => {
    startTimer();
  });
  $("stopBtn").addEventListener("click", () => {
    stopTimer();
  });
  $("resetBtn").addEventListener("click", () => {
    resetTimer();
  });

  $("exportBtn").addEventListener("click", exportJSON);
  $("clearBtn").addEventListener("click", clearAllData);

  // recompute stats when HRmax changes
  $("hrMax").addEventListener("change", renderAllStats);
}

function loop() {
  // continuous chart refresh not needed; we redraw on samples & throttled.
  requestAnimationFrame(loop);
}

function init() {
  initCapabilityCheck();
  bindUI();
  drawCanvasChart();
  renderAllStats();
  loop();
}

init();

// Keep stats updating occasionally while running
setInterval(() => {
  if (timerRunning) renderAllStats();
}, 2000);

// Lap management helpers called by timer
function advanceToLap(repIndex, type) {
  closeCurrentLap();
  createLap(type);
  currentLap.repIndex = repIndex;
}
function closeCurrentLap() {
  if (currentLap && !currentLap.endTs) currentLap.endTs = Date.now();
}
function createLap(type) {
  const index = laps.length + 1;
  const lap = { index, type, startTs: Date.now(), endTs: null, repIndex: null };
  laps.push(lap);
  currentLap = lap;
}
