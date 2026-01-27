/* =====================================================================
   HR-APP — ENKEL, ROBUST, VANILLA JS (ÉN FIL)  —  DEL 1 / 3
   Bygget for: Android nettbrett (landskap), FTMS + HR BLE, offline
   ===================================================================== */

/* =========================
   0) KONSTANTER & VERSJON
   ========================= */

const APP_VERSION = "v2.1.0 — " + new Date().toLocaleString("no-NO");
const $ = (id) => document.getElementById(id);

// FTMS (Bluetooth SIG UUIDs)
const FTMS_SERVICE   = "00001826-0000-1000-8000-00805f9b34fb";
const TREADMILL_DATA = "00002acd-0000-1000-8000-00805f9b34fb";
const HR_SERVICE     = "heart_rate";
const HR_CHAR        = "heart_rate_measurement";

// Vinduer / tegning
const HR_WINDOW_MS   = 15 * 60 * 1000;
const MAX_WINDOW_PTS = 15 * 60 * 3;
const CHART_FPS_MS   = 250;

// PNG-resultat layout
const PNG_W = 1800;
const PNG_H = 1200;

// Farger
const COLOR_PULSE = "#27f5a4";
const COLOR_SPEED = "#ffffff"; // fartslinje i hvitt

/* =========================
   1) GLOBAL STATE
   ========================= */

const STATE = {
  // BLE-håndtak
  hrDevice: null,
  hrChar:   null,
  tmDevice: null,
  tmChar:   null,

  // Strømmer
  hrSamples:      [],   // {ts,bpm,src}
  speedSamples:   [],   // {ts,kmh,effectiveKmh,src}
  inclineSamples: [],   // {ts,percent,src}

  // Siste verdier
  currentHR:      null,
  lastHrTs:       0,
  currentSpeed:   0,
  currentIncline: 0,

  // Vindusgraf (live HR)
  windowPoints:   [],   // {x,y} (HR siste 15 min)
  lastChartDraw:  0,

  // Laps
  laps:        [],      // {type,rep,startTs,endTs,max30bpm,speedKmh,inclinePct,speedSrc,inclSrc}
  currentLap:  null,

  // Timer
  timerRunning: false,
  elapsedSec:   0,
  tickTimer:    null,

  // WakeLock
  wakeLock: null,

  // Zoner
  zones: { z1:110, z2:130, z3:150, z4:165, z5:180 },

  // Manuell default incline (når FTMS ikke gir verdi)
  defaultManualInclinePct: 0.0,

  // Sluttverdi-kandidater for pågående drag
  candidateSpeed:   null,
  candidateIncline: null,

  // IndexedDB
  lastSavedSessionId: null
};

/* =========================
   2) HELPERS
   ========================= */

function mmss(s) {
  const m = Math.floor(s/60); const r = s%60;
  return `${String(m).padStart(2,"0")}:${String(r).padStart(2,"0")}`;
}
function fmtTime(sec) {
  const s = Math.round(sec); const m = Math.floor(s/60); const r=s%60;
  return `${m}:${String(r).padStart(2,"0")}`;
}
function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function roundHR(v){ return Math.round(v); }       // puls = hele tall
function round1(v){ return Math.round(v*10)/10; }  // fart/stigning = 1 desimal
function toBpmScaleFromSpeed(kmh){ return kmh*10; } // 160 bpm ↔ 16.0 km/t (samme skala)

function setStatus(t){ $("statusText").textContent = t; }
function isIOS(){
  return /iP(hone|ad|od)/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints>1);
}
function isSafari(){
  const ua = navigator.userAgent;
  const wk = /AppleWebKit/.test(ua);
  return wk && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

/* =========================
   3) WAKE LOCK
   ========================= */

async function acquireWakeLock(){
  try{
    if("wakeLock" in navigator){
      STATE.wakeLock = await navigator.wakeLock.request("screen");
      STATE.wakeLock.addEventListener("release",()=>console.log("WakeLock released"));
    }
  }catch(e){ console.warn("WakeLock:",e); }
}
async function releaseWakeLock(){
  try{ if(STATE.wakeLock){ await STATE.wakeLock.release(); STATE.wakeLock=null; } }
  catch(e){ console.warn("WakeLock release:",e); }
}

/* =========================
   4) UPDATE BANNER (SW)
   ========================= */

async function setupUpdateBanner(){
  if(!("serviceWorker" in navigator)) return;
  const banner = $("updateBanner");
  const btnNow = $("updateNowBtn");
  const btnLater = $("updateLaterBtn");
  let refreshing = false;

  navigator.serviceWorker.addEventListener("controllerchange",()=>{
    if(refreshing) return; refreshing = true; location.reload();
  });

  const reg = await navigator.serviceWorker.register("./sw.js");

  function showUpdate(r){
    banner.classList.remove("hidden");
    btnNow.onclick=()=>{
      btnNow.textContent="Oppdaterer…"; btnNow.disabled=true; btnLater.disabled=true;
      r.waiting?.postMessage({type:"SKIP_WAITING"});
    };
    btnLater.onclick=()=>banner.classList.add("hidden");
  }

  if(reg.waiting) showUpdate(reg);
  reg.addEventListener("updatefound",()=>{
    const nw=reg.installing; if(!nw) return;
    nw.addEventListener("statechange",()=>{
      if(nw.state==="installed" && navigator.serviceWorker.controller) showUpdate(reg);
    });
  });

  setInterval(()=>reg.update().catch(()=>{}), 60000);
}

/* =========================
   5) iOS NOTICE (for BT-støtte)
   ========================= */

function showIOSNotice(msg){ const el=$("iosNotice"); el.textContent=msg; el.classList.remove("hidden"); }
function hideIOSNotice(){ $("iosNotice").classList.add("hidden"); }

/* =========================
   6) BLE — HEART RATE
   ========================= */

function setHRButtonConnected(ok){
  const b=$("connectBtn");
  if(ok){ b.classList.add("connected"); b.textContent="Pulsbelte"; } // tekst skjules av CSS i connected-modus
  else  { b.classList.remove("connected"); b.textContent="Pulsbelte"; }
}

async function connectHR(){
  try{
    setStatus("Åpner HR‑dialog…");
    STATE.hrDevice = await navigator.bluetooth.requestDevice({
      filters:[{services:[HR_SERVICE]}], optionalServices:["battery_service"]
    });
    STATE.hrDevice.addEventListener("gattserverdisconnected",()=>{
      STATE.hrChar=null; setHRButtonConnected(false); setStatus("HR frakoblet");
    });

    setStatus("Kobler HR…");
    const server = await STATE.hrDevice.gatt.connect();
    const svc    = await server.getPrimaryService(HR_SERVICE);
    STATE.hrChar = await svc.getCharacteristic(HR_CHAR);
    STATE.hrChar.addEventListener("characteristicvaluechanged", onHRNotify);
    await STATE.hrChar.startNotifications();
    setHRButtonConnected(true);
    setStatus("HR tilkoblet");
  }catch(e){ console.error(e); setStatus("HR-tilkobling feilet"); alert("Klarte ikke koble til pulsbelte."); }
}

function parseHR(dv){
  const flags = dv.getUint8(0); const is16 = (flags & 0x01)!==0;
  return is16 ? dv.getUint16(1,true) : dv.getUint8(1);
}

function onHRNotify(e){
  const hr = parseHR(e.target.value);
  ingestHR(Date.now(), hr, "ble");
}

/* =========================
   7) BLE — FTMS (FART + STIGNING)
   ========================= */

function setTreadmillButtonConnected(ok){
  const b=$("treadmillBtn");
  if(ok){ b.classList.add("connected"); b.textContent="Mølle"; }
  else  { b.classList.remove("connected"); b.textContent="Mølle"; }
}

async function connectTreadmill(){
  try{
    setStatus("Åpner mølle‑dialog…");
    STATE.tmDevice = await navigator.bluetooth.requestDevice({
      filters:[{services:[FTMS_SERVICE]}]
    });
    STATE.tmDevice.addEventListener("gattserverdisconnected",()=>{
      STATE.tmChar=null; setTreadmillButtonConnected(false); setStatus("Mølle frakoblet");
    });

    setStatus("Kobler mølle…");
    const server = await STATE.tmDevice.gatt.connect();
    const svc    = await server.getPrimaryService(FTMS_SERVICE);
    STATE.tmChar = await svc.getCharacteristic(TREADMILL_DATA);

    STATE.tmChar.addEventListener("characteristicvaluechanged", onTreadmillNotify);
    await STATE.tmChar.startNotifications();
    setTreadmillButtonConnected(true);
    setStatus("Mølle tilkoblet");
  }catch(e){ console.error(e); setStatus("Mølle-tilkobling feilet"); alert("Klarte ikke koble til mølle via BLE."); }
}

// Robust/konservativ FTMS‑parser:
// - Speed: ofte bytes [2..3] = n/100 km/t
// - Incline: prøv [6..7] = n/10 %
function parseFTMSPayload(dv){
  let kmh = 0, inclinePct = STATE.currentIncline;

  try {
    const rawSpeed = dv.getUint16(2,true);
    kmh = rawSpeed/100.0;
  } catch {}

  try {
    const rawIncl = dv.getInt16(6,true);  // n/10 %
    const pct = rawIncl/10.0;
    if (pct > -30 && pct < 40) inclinePct = pct;
  } catch {}

  return { kmh, inclinePct };
}

function onTreadmillNotify(e){
  const dv = e.target.value;
  const {kmh, inclinePct} = parseFTMSPayload(dv);

  const effSpeed = (STATE.currentLap && STATE.currentLap.type==="rest") ? 0 : kmh;
  ingestSpeed(Date.now(), kmh, effSpeed, "ftms");

  // Stigning oppdateres ikke i pause (men behold siste)
  if (!(STATE.currentLap && STATE.currentLap.type==="rest")) {
    STATE.currentIncline = round1(inclinePct);
    ingestIncline(Date.now(), STATE.currentIncline, "ftms");
  }

  // Kandidater for sluttverdi i arbeid
  if(STATE.currentLap && STATE.currentLap.type==="work"){
    STATE.candidateSpeed   = effSpeed;
    STATE.candidateIncline = STATE.currentIncline;
  }
}

/* =========================
   8) SIMULERING (HR + INCLINE)
   ========================= */

let simBpm = 92;
function shouldSimHR(){
  const mode = $("simMode").value;
  if(mode==="force") return true;
  if(mode==="off")   return false;
  return !("bluetooth" in navigator) || !STATE.hrChar;
}
function simulateHR(phase){
  const baseline=88, warm=120, work=168, rest=105, cool=110;
  let target=baseline, speed=0.10;
  if(phase==="warmup")  { target=warm; speed=0.10; }
  if(phase==="work")    { target=work; speed=0.13; }
  if(phase==="rest")    { target=rest; speed=0.12; }
  if(phase==="cooldown"){ target=cool; speed=0.10; }
  simBpm += (target - simBpm)*speed + (Math.random()-0.5)*3.0;
  simBpm = clamp(simBpm, 50, 210);
  return Math.round(simBpm);
}
// Simulert incline: fast verdi (kan justeres i UI)
function simulateIncline(){ return round1(STATE.defaultManualInclinePct); }

/* =========================
   9) INGESTION (HR / SPEED / INCLINE)
   ========================= */

function ingestHR(ts, bpm, src){
  STATE.currentHR = bpm; STATE.lastHrTs = ts;
  $("pulseValue").textContent = bpm;

  STATE.hrSamples.push({ts, bpm, src});

  // Vindusbuffer for livegraf
  STATE.windowPoints.push({x:ts, y:bpm});
  const cutoff = ts - HR_WINDOW_MS;
  while(STATE.windowPoints.length && STATE.windowPoints[0].x < cutoff) STATE.windowPoints.shift();
  if(STATE.windowPoints.length > MAX_WINDOW_PTS) STATE.windowPoints = STATE.windowPoints.slice(-MAX_WINDOW_PTS);

  drawLiveChartThrottled();
}

function ingestSpeed(ts, kmh, effKmh, src){
  STATE.currentSpeed = effKmh;
  $("speedNow").textContent = round1(effKmh).toFixed(1);
  STATE.speedSamples.push({ts, kmh, effectiveKmh: effKmh, src});
}

function ingestIncline(ts, pct, src){
  STATE.currentIncline = pct;
  STATE.inclineSamples.push({ts, percent: pct, src});
  // Live UI for stigning
  const el = $("inclineNow");
  if (el) el.textContent = STATE.currentIncline.toFixed(1);
}

/* =========================
   10) LIVE PULS-GRAF
   ========================= */

let canvasW=0, canvasH=0, canvasDpr=1;
function resizeCanvas(){
  const canvas = $("hrCanvas"); const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio||1));
  const w = Math.round(rect.width), h = Math.round(rect.height);
  if(!w||!h) return;
  if(canvasW!==w || canvasH!==h || canvasDpr!==dpr){
    canvasW=w; canvasH=h; canvasDpr=dpr;
    canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr);
    const ctx = canvas.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);
  }
}

function drawLiveChartThrottled(){
  const now=Date.now();
  if(now - STATE.lastChartDraw < CHART_FPS_MS) return;
  STATE.lastChartDraw = now;
  drawLiveChart();
}

function drawLiveChart(){
  resizeCanvas();
  const canvas=$("hrCanvas"); const ctx=canvas.getContext("2d");
  const w=canvasW, h=canvasH; if(!w||!h) return;

  ctx.clearRect(0,0,w,h);

  const padL=70, padR=18, padT=16, padB=36;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const now = Date.now();
  const minX = now - HR_WINDOW_MS, maxX=now;

  let minY=60, maxY=180;
  if(STATE.windowPoints.length>=2){
    let lo=Infinity, hi=-Infinity;
    for(const p of STATE.windowPoints){ if(p.y<lo) lo=p.y; if(p.y>hi) hi=p.y; }
    minY = Math.max(30, Math.floor(lo - 10));
    maxY = Math.min(240, Math.ceil(hi + 10));
    if(maxY - minY < 20) maxY = minY + 20;
  }
  const xToPx = (x)=> padL + ((x-minX)/(maxX-minX))*plotW;
  const yToPx = (y)=> padT + (1 - (y-minY)/(maxY-minY))*plotH;

  // grid (diskré linjer)
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth=1; ctx.font="16px system-ui";
  ctx.fillStyle="rgba(255,255,255,0.75)"; ctx.textAlign="right"; ctx.textBaseline="middle";
  for(let i=0;i<=5;i++){
    const y=padT + (i/5)*plotH;
    ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(padL+plotW,y); ctx.stroke();
    ctx.fillText(Math.round(maxY - (i/5)*(maxY-minY)), padL-10, y);
  }
  ctx.textAlign="center"; ctx.textBaseline="top";
  for(let i=0;i<=5;i++){
    const x = padL + (i/5)*plotW;
    ctx.beginPath(); ctx.moveTo(x,padT); ctx.lineTo(x,padT+plotH); ctx.stroke();
    const minsAgo = Math.round((1 - i/5)*15);
    ctx.fillText(`-${minsAgo}m`, x, padT+plotH+10);
  }

  // puls-linje
  if(STATE.windowPoints.length>=2){
    ctx.strokeStyle = COLOR_PULSE; ctx.lineWidth=3; ctx.beginPath();
    let started=false;
    for(const p of STATE.windowPoints){
      const x=xToPx(p.x), y=yToPx(p.y);
      if(!started){ ctx.moveTo(x,y); started=true; } else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }
}

// Oppdater «siden sist»
setInterval(()=>{
  $("lastSeen").textContent = STATE.lastHrTs ? Math.max(0, Math.floor((Date.now()-STATE.lastHrTs)/1000)) : "--";
}, 500);

/* ====== SLUTT PÅ DEL 1 / 3 ====== *//* =====================================================================
   HR-APP — ENKEL, ROBUST, VANILLA JS (ÉN FIL)  —  DEL 2 / 3
   ===================================================================== */

/* =========================
   11) INTERVALLMOTOR
   ========================= */

function getCfg(){
  return {
    warm:     parseInt($("warmupSec").value,10)||0,
    work:     parseInt($("workSec").value,10)||0,
    rest:     parseInt($("restSec").value,10)||0,
    reps:     parseInt($("reps").value,10)||0,
    cooldown: parseInt($("cooldownSec").value,10)||0
  };
}

function startTimer(){
  if(STATE.timerRunning) return;
  STATE.timerRunning=true;
  STATE.elapsedSec=0;
  STATE.laps=[];
  STATE.currentLap=null;

  $("startBtn").disabled=true;
  $("stopBtn").disabled=false;

  acquireWakeLock();

  const cfg=getCfg();
  if(cfg.warm>0) startLap("warmup",0);
  else           startLap("work",1);

  $("timerPhase").textContent="Starter…";
  $("dragRemainClock").textContent="00:00";
  $("totalTimeClock").textContent="00:00";

  STATE.tickTimer = setInterval(tick,1000);
}

function stopTimer(){
  if(!STATE.timerRunning) return;
  STATE.timerRunning=false;
  clearInterval(STATE.tickTimer);
  STATE.tickTimer=null;

  endLap();

  $("startBtn").disabled=false;
  $("stopBtn").disabled=true;

  releaseWakeLock();

  finalizeLaps();
  renderLapStatsText();
  renderZones();

  // Vis resultat direkte
  showResultsModal();
}

function resetTimer(){
  if(STATE.timerRunning) stopTimer();

  STATE.elapsedSec=0;
  $("dragRemainClock").textContent="00:00";
  $("totalTimeClock").textContent="00:00";
  $("timerPhase").textContent="Stoppet";

  STATE.laps=[];
  STATE.currentLap=null;
  STATE.windowPoints=[];

  renderLapStatsText();
  renderZones();
  drawLiveChart();
}

function startLap(type, rep){
  STATE.currentLap = {
    type,
    rep,
    startTs: Date.now(),
    endTs: null,
    max30bpm: null,
    speedKmh: (type==="rest") ? 0 : null,
    inclinePct: (type==="rest") ? STATE.currentIncline : null,
    speedSrc: null,
    inclSrc: null
  };
  STATE.laps.push(STATE.currentLap);

  // Prefyll dragfart-felt for work
  if(type==="work"){
    const pre = Number.isFinite(STATE.currentSpeed) ? STATE.currentSpeed : 0;
    $("dragSpeedInput").value = round1(pre).toFixed(1);
  }else{
    $("dragSpeedInput").value = "0.0";
  }
}

function endLap(){
  const L = STATE.currentLap;
  if(!L || L.endTs) return;

  L.endTs = Date.now();

  if(L.type==="rest"){
    L.speedKmh   = 0;
    L.speedSrc   = "forced_rest";
    L.inclinePct = Number.isFinite(STATE.currentIncline) ? round1(STATE.currentIncline) : round1(STATE.defaultManualInclinePct);
    L.inclSrc    = "carry";
    STATE.currentLap = null;
    return;
  }

  if(L.type==="work"){
    // speed: manual > candidate > last
    const manualSpeed = parseFloat($("dragSpeedInput").value);
    if(Number.isFinite(manualSpeed) && manualSpeed>=0){
      L.speedKmh = round1(manualSpeed);
      L.speedSrc = "manual";
    }else if(Number.isFinite(STATE.candidateSpeed) && STATE.candidateSpeed>0){
      L.speedKmh = round1(STATE.candidateSpeed);
      L.speedSrc = "ftms_end";
    }else{
      L.speedKmh = round1(STATE.currentSpeed||0);
      L.speedSrc = L.speedKmh>0 ? "ftms_last" : "unknown";
    }

    // incline: manual field (from dynamic UI) > candidate > last/current/default
    const incInp = $("dragInclineInput");
    const manualInc = incInp ? parseFloat(incInp.value) : NaN;
    if(Number.isFinite(manualInc)){
      L.inclinePct = round1(manualInc);
      L.inclSrc    = "manual";
    }else if(Number.isFinite(STATE.candidateIncline)){
      L.inclinePct = round1(STATE.candidateIncline);
      L.inclSrc    = "ftms_end";
    }else{
      L.inclinePct = round1(STATE.currentIncline||STATE.defaultManualInclinePct);
      L.inclSrc    = "carry";
    }
  }else{
    // warmup/cooldown: logg siste kjente
    L.speedKmh   = round1(STATE.currentSpeed||0);
    L.speedSrc   = "info";
    L.inclinePct = round1(STATE.currentIncline||STATE.defaultManualInclinePct);
    L.inclSrc    = "info";
  }

  STATE.currentLap = null;
}

// Tick med gjenstående dragtid (stor) + total tid (liten)
function tick(){
  STATE.elapsedSec++;
  const totalEl = $("totalTimeClock");
  if(totalEl) totalEl.textContent = mmss(STATE.elapsedSec);

  const cfg=getCfg();
  const cycle=cfg.work+cfg.rest;
  const totalMain=cfg.reps*cycle;
  const total=cfg.warm+totalMain+cfg.cooldown;

  const t=STATE.elapsedSec-1;

  let phase="done", rep=0, phaseRemain=0;
  if(t < total){
    if(t < cfg.warm){
      phase="warmup";
      phaseRemain = cfg.warm - t;
    } else if (t < cfg.warm + totalMain){
      const t2 = t - cfg.warm;
      const cycleIdx = Math.floor(t2/cycle);
      const within   = t2 % cycle;
      rep = cycleIdx + 1;
      if (within < cfg.work){
        phase="work";
        phaseRemain = cfg.work - within;
      } else {
        phase="rest";
        phaseRemain = cycle - within;
      }
    } else {
      const t3 = t - (cfg.warm+totalMain);
      phase="cooldown";
      phaseRemain = cfg.cooldown - t3;
    }
  }

  // Ferdig?
  if(phase==="done"){
    const phaseEl = $("timerPhase");
    if(phaseEl) phaseEl.textContent="Ferdig";
    const remainEl = $("dragRemainClock");
    if(remainEl) remainEl.textContent="00:00";
    stopTimer();
    return;
  }

  // Bytt lap ved fase/rep-skifte
  if(!STATE.currentLap || STATE.currentLap.type!==phase || STATE.currentLap.rep!==rep){
    endLap();
    startLap(phase,rep);
  }

  // Oppdater gjenstående dragtid (stor)
  const remainEl = $("dragRemainClock");
  if(remainEl) remainEl.textContent = mmss(Math.max(0, phaseRemain));

  // Fase‑tekst
  const phaseEl = $("timerPhase");
  if(phaseEl){
    if(phase==="warmup") phaseEl.textContent="Oppvarming";
    else if(phase==="cooldown") phaseEl.textContent="Nedjogg";
    else if(phase==="work") phaseEl.textContent=`Arbeid (Drag ${rep}/${cfg.reps})`;
    else phaseEl.textContent=`Pause (Drag ${rep}/${cfg.reps})`;
  }

  // Simuler HR (og incline) ved behov
  if(shouldSimHR()){
    const bpm = simulateHR(phase);
    ingestHR(Date.now(), bpm, "sim");
    if(!STATE.tmChar) ingestIncline(Date.now(), simulateIncline(), "sim");
  }

  // Håndhev 0 fart i pause
  if(STATE.currentLap && STATE.currentLap.type==="rest"){
    const speedEl = $("speedNow");
    if(speedEl) speedEl.textContent = "0.0";
  }

  // Lett periodisk oppdatering
  if(STATE.elapsedSec%2===0){
    renderLapStatsText();
    renderZones();
  }
}

/* =========================
   12) STATISTIKK
   ========================= */

function samplesInRange(startTs,endTs){
  return STATE.hrSamples
    .filter(p=>p.ts>=startTs && p.ts<=endTs)
    .sort((a,b)=>a.ts-b.ts);
}

// Tidsvektet 30s-maks
function computeMax30sAvg(samples){
  if(!samples || samples.length<2) return null;
  let best=-Infinity;
  for(let i=0;i<samples.length-1;i++){
    const startT=samples[i].ts, endT=startT+30000;
    let area=0, t=startT, k=i;
    while(k<samples.length-1 && samples[k+1].ts<=t) k++;
    while(t<endT && k<samples.length-1){
      const tNext=Math.min(endT, samples[k+1].ts);
      const dt=Math.max(0,(tNext-t)/1000);
      area += samples[k].bpm*dt;
      t=tNext;
      if(t>=samples[k+1].ts) k++;
    }
    if(t<endT){
      const dt=(endT-t)/1000;
      area += samples[samples.length-1].bpm*dt;
    }
    const avg=area/30;
    if(avg>best) best=avg;
  }
  return (best===-Infinity)? null : best;
}

function finalizeLaps(){
  for(const L of STATE.laps){
    if(!L.endTs) continue;
    if(L.type!=="work") continue;
    const s = samplesInRange(L.startTs, L.endTs);
    L.max30bpm = computeMax30sAvg(s);
  }
}

// Soner: kun i økta (fra første start til siste slutt; hvis pågår → «nå»)
function computeZoneSecondsSessionOnly(){
  if(!STATE.laps.length) return [0,0,0,0,0,0];
  const first=STATE.laps[0], last=STATE.laps.at(-1);
  const start=first.startTs||0, end=last.endTs||Date.now();
  if(!start || end<=start) return [0,0,0,0,0,0];

  const samples = STATE.hrSamples.filter(p=>p.ts>=start && p.ts<=end).sort((a,b)=>a.ts-b.ts);
  const z=[0,0,0,0,0,0]; if(samples.length<2) return z;
  const {z1,z2,z3,z4,z5}=STATE.zones;
  const zoneOf = (bpm)=>{
    if(bpm<z1) return 0;
    if(bpm<z2) return 1;
    if(bpm<z3) return 2;
    if(bpm<z4) return 3;
    if(bpm<z5) return 4;
    return 5;
  };
  for(let i=0;i<samples.length-1;i++){
    const s=samples[i];
    const dt=Math.max(0,Math.min(5,(samples[i+1].ts - s.ts)/1000));
    z[zoneOf(s.bpm)] += dt;
  }
  return z;
}

function renderZones(){
  const zs = computeZoneSecondsSessionOnly();
  const maxSec = Math.max(...zs,1);
  for(let i=0;i<=5;i++){
    $(`barS${i}`).style.width = `${((zs[i]/maxSec)*100).toFixed(1)}%`;
    $(`timeS${i}`).textContent = fmtTime(zs[i]);
  }
}

function renderLapStatsText(){
  const work = STATE.laps.filter(l=>l.type==="work" && l.endTs);
  if(!work.length){ $("lapStats").textContent="—"; return; }
  const lines=[];
  for(const L of work){
    const m30 = L.max30bpm? roundHR(L.max30bpm) : "—";
    const sp  = Number.isFinite(L.speedKmh)? L.speedKmh.toFixed(1) : "—";
    const inc = Number.isFinite(L.inclinePct)? L.inclinePct.toFixed(1) : "—";
    lines.push(`Drag ${L.rep}: max30s=${m30} bpm · fart=${sp} km/t · stigning=${inc}%`);
  }
  $("lapStats").textContent = lines.join("\n");
}

/* =========================
   13) RESULTATMODAL + PNG
   ========================= */

function showResultsModal(){
  const modal=$("resultsModal");
  modal.classList.remove("hidden");

  const note=$("note").value.trim(); const when=new Date().toLocaleString("no-NO");
  $("resultsSub").textContent = note? `${when} · ${note}` : when;

  // Sum tider
  let warmT=0, workT=0, restT=0, coolT=0;
  for(const L of STATE.laps){
    if(!L.endTs) continue;
    const dur=(L.endTs-L.startTs)/1000;
    if(L.type==="warmup") warmT+=dur;
    else if(L.type==="work") workT+=dur;
    else if(L.type==="rest") restT+=dur;
    else if(L.type==="cooldown") coolT+=dur;
  }

  // Total faktisk tid
  let totalActual=0;
  if(STATE.laps.length && STATE.laps[0].startTs && STATE.laps.at(-1).endTs){
    totalActual=Math.round((STATE.laps.at(-1).endTs-STATE.laps[0].startTs)/1000);
  }

  // Soner
  const zoneSecs = computeZoneSecondsSessionOnly();
  renderZonesToResults(zoneSecs);

  // Snittpuls total
  let sumHR=0, cntHR=0;
  if(STATE.laps.length){
    const start=STATE.laps[0].startTs, end=STATE.laps.at(-1).endTs||Date.now();
    for(const p of STATE.hrSamples){ if(p.ts>=start && p.ts<=end){ sumHR+=p.bpm; cntHR++; } }
  }
  const avgHR = cntHR? roundHR(sumHR/cntHR) : 0;

  // Distanse (km) fra effective speed
  let dist=0;
  if(STATE.laps.length){
    const start=STATE.laps[0].startTs, end=STATE.laps.at(-1).endTs||Date.now();
    const s=STATE.speedSamples.filter(p=>p.ts>=start && p.ts<=end).sort((a,b)=>a.ts-b.ts);
    for(let i=0;i<s.length-1;i++){
      const dt=(s[i+1].ts - s[i].ts)/1000;
      dist += s[i].effectiveKmh*(dt/3600);
    }
  }

  // Stigning (snitt & maks)
  let sumInc=0, cntInc=0, maxInc=0;
  if(STATE.laps.length){
    const start=STATE.laps[0].startTs, end=STATE.laps.at(-1).endTs||Date.now();
    for(const p of STATE.inclineSamples){
      if(p.ts>=start && p.ts<=end){
        sumInc += p.percent; cntInc++;
        if(p.percent>maxInc) maxInc=p.percent;
      }
    }
  }
  const avgInc = cntInc? round1(sumInc/cntInc) : 0;

  $("summaryText").textContent =
`Totaltid:       ${fmtTime(totalActual)}
Oppvarming:      ${fmtTime(warmT)}
Dragtid:         ${fmtTime(workT)}
Pausetid:        ${fmtTime(restT)}
Nedjogg:         ${fmtTime(coolT)}

Snittpuls:       ${avgHR} bpm
Distanse:        ${dist.toFixed(2)} km
Snitt stigning:  ${avgInc.toFixed(1)} %
Maks stigning:   ${maxInc.toFixed(1)} %`;

  renderSpeedInclineEditor();
  drawResultsChart();

  $("closeResultsBtn").onclick=()=>modal.classList.add("hidden");
  $("exportPngBtn").onclick   = exportResultsPNG;
  $("sharePngBtn").onclick    = shareResultsPNG;
  $("exportJsonBtn2").onclick = exportJSON;       // defineres i DEL 3
  $("saveEditsBtn").onclick   = saveEditsAndRefresh;
}

function renderZonesToResults(zs){
  const mx=Math.max(...zs,1);
  for(let i=0;i<=5;i++){
    $(`rbarS${i}`).style.width=`${((zs[i]/mx)*100).toFixed(1)}%`;
    $(`rtimeS${i}`).textContent=fmtTime(zs[i]);
  }
}

// Redigerbar fart/stigning pr drag (i resultatmodalen)
function renderSpeedInclineEditor(){
  const wrap=$("speedEditor");
  const work=STATE.laps.filter(l=>l.type==="work"&&l.endTs);
  if(!work.length){ wrap.textContent="—"; return; }
  wrap.innerHTML="";

  for(const L of work){
    const row=document.createElement("div"); row.className="speedRow";

    const lbl=document.createElement("div"); lbl.className="speedRowLabel";
    lbl.textContent=`Drag ${L.rep}`;
    row.appendChild(lbl);

    // SPEED
    const inpSpeed=document.createElement("input");
    inpSpeed.type="number"; inpSpeed.step="0.1"; inpSpeed.min="0";
    inpSpeed.value=(Number.isFinite(L.speedKmh)?L.speedKmh:0).toFixed(1);
    inpSpeed.dataset.rep=String(L.rep);
    inpSpeed.dataset.kind="speed";
    row.appendChild(inpSpeed);

    // INCLINE
    const inpInc=document.createElement("input");
    inpInc.type="number"; inpInc.step="0.1"; inpInc.min="-5";
    inpInc.value=(Number.isFinite(L.inclinePct)?L.inclinePct:STATE.defaultManualInclinePct).toFixed(1);
    inpInc.dataset.rep=String(L.rep);
    inpInc.dataset.kind="incline";
    row.appendChild(inpInc);

    wrap.appendChild(row);
  }
}

function saveEditsAndRefresh(){
  const inputs = $("speedEditor").querySelectorAll("input");
  const patch = new Map(); // rep -> {speed?, incline?}
  for(const i of inputs){
    const rep=parseInt(i.dataset.rep,10);
    const kind=i.dataset.kind;
    const val=parseFloat(i.value);
    if(!patch.has(rep)) patch.set(rep,{});
    patch.get(rep)[kind]=val;
  }

  for(const L of STATE.laps){
    if(L.type!=="work") continue;
    const p=patch.get(L.rep); if(!p) continue;
    if(Number.isFinite(p.speed)){   L.speedKmh   = round1(p.speed);   L.speedSrc="manual_edit"; }
    if(Number.isFinite(p.incline)){ L.inclinePct = round1(p.incline); L.inclSrc ="manual_edit"; }
  }

  finalizeLaps();
  renderLapStatsText();
  drawResultsChart();
  saveCurrentSession(); // DEL 3
  alert("Endringer lagret.");
}

// Puls‑stolper + hvit fartslinje (dobbelt y, unified skala)
function drawResultsChart(){
  const canvas=$("resultsCanvas");
  const dpr=Math.max(1,Math.min(3,window.devicePixelRatio||1));
  canvas.width=PNG_W*dpr; canvas.height=PNG_H*dpr;
  canvas.style.width=PNG_W+"px"; canvas.style.height=PNG_H+"px";
  const ctx=canvas.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);

  // bakgrunn
  ctx.fillStyle="#0b0f14"; ctx.fillRect(0,0,PNG_W,PNG_H);

  const work=STATE.laps.filter(l=>l.type==="work"&&l.endTs);
  const valPulse = work.map(l=> l.max30bpm? roundHR(l.max30bpm) : 0);
  const valSpeed = work.map(l=> Number.isFinite(l.speedKmh)? l.speedKmh : 0);

  const padL=80, padR=80, padT=80, padB=140;
  const plotW=PNG_W-padL-padR, plotH=PNG_H-padT-padB;

  let minVal=999, maxVal=-999;
  for(let i=0;i<work.length;i++){
    const v=valPulse[i];
    const s=toBpmScaleFromSpeed(valSpeed[i]);
    minVal=Math.min(minVal, v, s);
    maxVal=Math.max(maxVal, v, s);
  }
  if(minVal===999){ minVal=0; maxVal=200; }
  if(maxVal-minVal<20) maxVal=minVal+20;

  const yToPx=(y)=> padT + (1-(y-minVal)/(maxVal-minVal))*plotH;

  // Grid med venstre/høyre akse
  ctx.strokeStyle="rgba(255,255,255,0.12)";
  ctx.lineWidth=1;
  ctx.font="22px system-ui";
  ctx.fillStyle="rgba(255,255,255,0.8)";
  ctx.textAlign="right";
  ctx.textBaseline="middle";
  for(let i=0;i<=6;i++){
    const yVal= maxVal - i*((maxVal-minVal)/6);
    const y=yToPx(yVal);
    ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(padL+plotW,y); ctx.stroke();
    ctx.fillText(Math.round(yVal), padL-10, y);                // venstre akse (bpm)
    ctx.fillText((Math.round(yVal)/10).toFixed(1), padL+plotW+50, y); // høyre akse (km/t)
  }

  // X‑etiketter (drag)
  const n=work.length, gap=14, barW=Math.max(20,(plotW - gap*(n-1))/n);
  ctx.textAlign="center"; ctx.textBaseline="top"; ctx.fillStyle="rgba(255,255,255,0.8)";
  for(let i=0;i<n;i++){
    const x=padL + i*(barW+gap) + barW/2;
    ctx.fillText(String(work[i].rep), x, padT+plotH+10);
  }

  // Puls-stolper
  ctx.fillStyle = COLOR_PULSE;
  for(let i=0;i<n;i++){
    const v=valPulse[i];
    const x=padL + i*(barW+gap);
    const y=yToPx(v), y0=yToPx(minVal);
    ctx.fillRect(x,y,barW,y0-y);
  }

  // Fart-linje
  ctx.strokeStyle = COLOR_SPEED;
  ctx.lineWidth=4;
  ctx.beginPath();
  let started=false;
  for(let i=0;i<n;i++){
    const s=toBpmScaleFromSpeed(valSpeed[i]);
    const x=padL + i*(barW+gap) + barW/2;
    const y=yToPx(s);
    if(!started){ ctx.moveTo(x,y); started=true; }
    else ctx.lineTo(x,y);
  }
  ctx.stroke();

  // Tittel
  ctx.fillStyle="white";
  ctx.font="32px system-ui";
  ctx.textAlign="left";
  ctx.textBaseline="top";
  ctx.fillText("Puls (stolper) og Fart (linje)", padL, 20);

  // Summary-boks nederst
  ctx.fillStyle="rgba(255,255,255,0.12)";
  ctx.fillRect(padL, PNG_H-120, plotW, 100);

  ctx.fillStyle="white";
  ctx.font="20px system-ui";
  ctx.textBaseline="middle";
  const lines = $("summaryText").textContent.split("\n");
  let yOff=PNG_H-100;
  for(const line of lines){
    ctx.fillText(line, padL+10, yOff);
    yOff += 24;
  }
}

function exportResultsPNG(){
  const canvas=$("resultsCanvas");
  const url=canvas.toDataURL("image/png");
  const a=document.createElement("a");
  a.href=url; a.download=`hr-result-${Date.now()}.png`; a.click();
}

async function shareResultsPNG(){
  if(!navigator.canShare){ alert("Deling ikke støttet her."); return; }
  const canvas=$("resultsCanvas");
  const blob=await new Promise(res=>canvas.toBlob(res,"image/png"));
  const file=new File([blob],`hr-result-${Date.now()}.png`,{type:"image/png"});
  if(navigator.canShare({files:[file]})) await navigator.share({title:"HR Resultat", files:[file]});
}

/* ====== SLUTT PÅ DEL 2 / 3 ====== *//* =====================================================================
   HR-APP — ENKEL, ROBUST, VANILLA JS (ÉN FIL)  —  DEL 3 / 3
   ===================================================================== */

/* =========================
   14) EXPORT JSON (SESSION)
   ========================= */

function buildSessionPayload(existingId=null){
  return {
    id: existingId || (crypto.randomUUID?.() || `id-${Date.now()}`),
    createdAt: new Date().toISOString(),
    note: $("note").value.trim(),
    config: {
      warmupSec:  parseInt($("warmupSec").value,10)||0,
      workSec:    parseInt($("workSec").value,10)||0,
      restSec:    parseInt($("restSec").value,10)||0,
      cooldownSec:parseInt($("cooldownSec").value,10)||0,
      reps:       parseInt($("reps").value,10)||0,
      simMode:    $("simMode").value
    },
    zones: STATE.zones,
    laps: STATE.laps,
    hrSamples: STATE.hrSamples,
    speedSamples: STATE.speedSamples,
    inclineSamples: STATE.inclineSamples
  };
}

function exportJSON(){
  const p = buildSessionPayload(STATE.lastSavedSessionId);
  const blob = new Blob([JSON.stringify(p,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `hr-session-${Date.now()}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 400);
}

/* =========================
   15) INDEXEDDB (SESSIONS)
   ========================= */

const DB_NAME="hr_app_db_v2";
const DB_VER = 1;
const STORE  = "sessions";

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db=req.result;
      if(!db.objectStoreNames.contains(STORE)){
        const os=db.createObjectStore(STORE,{ keyPath:"id" });
        os.createIndex("createdAt","createdAt");
      }
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror   = ()=>reject(req.error);
  });
}

async function dbPut(session){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction(STORE,"readwrite");
    tx.objectStore(STORE).put(session);
    tx.oncomplete=()=>res(true);
    tx.onerror  =()=>rej(tx.error);
  });
}
async function dbGet(id){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction(STORE,"readonly");
    const r=tx.objectStore(STORE).get(id);
    r.onsuccess=()=>res(r.result || null);
    r.onerror  =()=>rej(r.error);
  });
}
async function dbGetAll(){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction(STORE,"readonly");
    const r=tx.objectStore(STORE).getAll();
    r.onsuccess=()=>res(r.result || []);
    r.onerror  =()=>rej(r.error);
  });
}
async function dbDelete(id){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction(STORE,"readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete=()=>res(true);
    tx.onerror  =()=>rej(tx.error);
  });
}

async function saveCurrentSession(){
  const payload = buildSessionPayload(STATE.lastSavedSessionId);
  STATE.lastSavedSessionId = payload.id;
  await dbPut(payload);
  await refreshSessionList();
}

async function refreshSessionList(){
  const list = await dbGetAll();
  list.sort((a,b)=> (b.createdAt||"").localeCompare(a.createdAt||""));
  const sel = $("sessionSelect");
  sel.innerHTML = "";
  const opt0=document.createElement("option");
  opt0.value=""; opt0.textContent = list.length? "Velg økt…" : "Ingen lagrede økter";
  sel.appendChild(opt0);
  for(const s of list){
    const d=(s.createdAt||"").replace("T"," ").slice(0,16);
    const o=document.createElement("option");
    o.value=s.id; o.textContent=`${d}${s.note? " · "+s.note:""}`;
    sel.appendChild(o);
  }
}

async function loadSelectedSession(){
  const id = $("sessionSelect").value;
  if(!id) return;
  const sess = await dbGet(id);
  if(!sess) return;

  STATE.lastSavedSessionId = sess.id;

  // config
  $("warmupSec").value   = sess.config.warmupSec;
  $("workSec").value     = sess.config.workSec;
  $("restSec").value     = sess.config.restSec;
  $("cooldownSec").value = sess.config.cooldownSec;
  $("reps").value        = sess.config.reps;
  $("simMode").value     = sess.config.simMode;
  $("note").value        = sess.note || "";
  STATE.zones            = sess.zones || STATE.zones;

  // data
  STATE.laps            = sess.laps || [];
  STATE.hrSamples       = sess.hrSamples || [];
  STATE.speedSamples    = sess.speedSamples || [];
  STATE.inclineSamples  = sess.inclineSamples || [];

  // rebuild live window
  const now=Date.now();
  STATE.windowPoints = STATE.hrSamples
    .filter(p=>p.ts>=now-HR_WINDOW_MS)
    .map(p=>({x:p.ts, y:p.bpm}));

  $("pulseValue").textContent = STATE.hrSamples.at(-1)?.bpm ?? "--";
  $("speedNow").textContent   = (STATE.speedSamples.at(-1)?.effectiveKmh ?? 0).toFixed(1);
  $("inclineNow").textContent = (STATE.inclineSamples.at(-1)?.percent ?? STATE.defaultManualInclinePct).toFixed(1);

  finalizeLaps();
  renderLapStatsText();
  renderZones();
  drawLiveChart();

  // Åpne resultatmodal
  $("resultsModal").classList.remove("hidden");
  $("resultsSub").textContent = `Lastet økt: ${sess.createdAt?.replace("T"," ").slice(0,16) || ""}`;
  renderSpeedInclineEditor();
  drawResultsChart();
  $("summaryText").textContent="(Lastet økt)";
  renderZonesToResults(computeZoneSecondsSessionOnly());
}

async function deleteSelectedSession(){
  const id = $("sessionSelect").value;
  if(!id) return;
  await dbDelete(id);
  await refreshSessionList();
  alert("Økt slettet.");
}

/* =========================
   16) CLEAR / DYNAMISK FELT
   ========================= */

function clearAllData(){
  STATE.windowPoints=[];
  STATE.hrSamples=[];
  STATE.speedSamples=[];
  STATE.inclineSamples=[];

  STATE.laps=[];
  STATE.currentLap=null;
  STATE.currentHR=null;
  STATE.currentSpeed=0;
  STATE.currentIncline=0;
  STATE.lastHrTs=0;

  $("pulseValue").textContent="--";
  $("speedNow").textContent="0.0";
  $("inclineNow").textContent=STATE.defaultManualInclinePct.toFixed(1);
  $("lastSeen").textContent="--";
  $("dragRemainClock").textContent="00:00";
  $("totalTimeClock").textContent="00:00";
  $("timerPhase").textContent="Stoppet";

  renderLapStatsText();
  renderZones();
  drawLiveChart();
  setStatus("Tømte data");
}

// Legger til «Drag‑stigning (%)» i timerpanelet uten å endre HTML
function addManualInclineRow(){
  const panel = document.querySelector(".timerInputs.compact") || document.querySelector(".timerInputs");
  if(!panel) return;

  // Unngå dobbel
  if (document.getElementById("dragInclineInput")) return;

  const row = document.createElement("div");
  row.className = "btnRow tight";

  const group = document.createElement("div");
  group.style.display = "flex";
  group.style.gap = "8px";
  group.style.alignItems = "center";

  const label = document.createElement("label");
  label.className = "field";
  label.style.minWidth = "220px";
  const span = document.createElement("span");
  span.textContent = "Drag‑stigning (%)";
  const inp = document.createElement("input");
  inp.id = "dragInclineInput";
  inp.type = "number";
  inp.step = "0.1";
  inp.value = STATE.defaultManualInclinePct.toFixed(1);
  label.appendChild(span);
  label.appendChild(inp);

  const btn = document.createElement("button");
  btn.className = "secondaryBtn";
  btn.textContent = "Sett stigning";
  btn.onclick = ()=>{
    const v = parseFloat(inp.value);
    if(Number.isFinite(v)){
      STATE.defaultManualInclinePct = round1(v);
      setStatus(`Standard stigning satt: ${STATE.defaultManualInclinePct.toFixed(1)} %`);
      $("inclineNow").textContent = STATE.defaultManualInclinePct.toFixed(1);
    }
  };

  group.appendChild(label);
  group.appendChild(btn);
  row.appendChild(group);

  // Plasser før Start/Stopp-raden dersom mulig
  const allRows = panel.querySelectorAll(".btnRow");
  if (allRows.length) {
    panel.insertBefore(row, allRows[0]);
  } else {
    panel.appendChild(row);
  }
}

/* =========================
   17) UI-BINDINGS
   ========================= */

function bindUI(){
  // BLE‑kobling
  $("connectBtn").onclick   = connectHR;
  $("treadmillBtn").onclick = connectTreadmill;

  // Timerkontroller
  $("startBtn").onclick     = startTimer;
  $("stopBtn").onclick      = stopTimer;
  $("resetBtn").onclick     = resetTimer;

  // Zoner
  $("applyZonesBtn").onclick = ()=>{
    STATE.zones = {
      z1: parseInt($("z1").value,10)||110,
      z2: parseInt($("z2").value,10)||130,
      z3: parseInt($("z3").value,10)||150,
      z4: parseInt($("z4").value,10)||165,
      z5: parseInt($("z5").value,10)||180
    };
    renderZones();
    drawResultsChart();
  };

  // Dragfart
  $("applyDragSpeedBtn").onclick = ()=>{
    if(!STATE.currentLap || STATE.currentLap.type!=="work"){
      alert("Endre dragfart når du er i arbeid‑drag.");
      return;
    }
    const v = parseFloat($("dragSpeedInput").value);
    if(Number.isFinite(v) && v>=0){
      STATE.currentLap.speedKmh = round1(v);
      STATE.currentLap.speedSrc = "manual";
      setStatus(`Dragfart satt manuelt: ${STATE.currentLap.speedKmh.toFixed(1)} km/t`);
    }
  };

  // Legg til/fjern drag
  $("addRepBtn").onclick    = ()=>{ const r=parseInt($("reps").value,10)||0; $("reps").value=r+1; if(STATE.timerRunning) setStatus("La til drag"); };
  $("removeRepBtn").onclick = ()=>{ const r=parseInt($("reps").value,10)||0; if(r>1) $("reps").value=r-1; if(STATE.timerRunning) setStatus("Fjernet drag"); };

  // Export & clear
  $("exportBtn").onclick = exportJSON;
  $("clearBtn").onclick  = clearAllData;

  // Sessions
  $("loadSessionBtn").onclick   = loadSelectedSession;
  $("deleteSessionBtn").onclick = deleteSelectedSession;

  // Resultatmodalens knapper bindes i showResultsModal()
}

/* =========================
   18) CAPABILITY & INIT
   ========================= */

function initCapabilityCheck(){
  hideIOSNotice();
  if(!("bluetooth" in navigator)){
    $("connectBtn").disabled = true;
    $("treadmillBtn").disabled = true;

    if(isIOS()){
      showIOSNotice(isSafari()
        ? "iOS Safari støtter ikke Web Bluetooth."
        : "iOS støtter normalt ikke Web Bluetooth.");
    }
    setStatus("Bluetooth ikke støttet");
    return;
  }
  $("connectBtn").disabled=false;
  $("treadmillBtn").disabled=false;
  setStatus("Klar");
}

function setVersionTag(){
  const v = $("versionTag");
  if (v) v.textContent = APP_VERSION;
}

async function init(){
  setVersionTag();
  await setupUpdateBanner();
  initCapabilityCheck();
  bindUI();
  addManualInclineRow();

  // Init z-linjer i felter
  $("z1").value = STATE.zones.z1;
  $("z2").value = STATE.zones.z2;
  $("z3").value = STATE.zones.z3;
  $("z4").value = STATE.zones.z4;
  $("z5").value = STATE.zones.z5;

  await refreshSessionList();
  renderZones();
  renderLapStatsText();
  drawLiveChart();
}

init().catch(console.warn);

/* =========================
   SLUTT PÅ DEL 3 / 3 — HELE app.js ER NÅ KOMPLETT
   ========================= */
