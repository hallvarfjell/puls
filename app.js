/* =====================================================================
   HR-APP — ENKEL, ROBUST, VANILLA JS (ÉN FIL)
   Bygget for: Android nettbrett (landskap), FTMS + HR BLE, offline
   Versjon: v2.0.0 — generert: " + new Date().toLocaleString("no-NO") + "
   ===================================================================== */

/* =========================
   0) KONSTANTER & VERSJON
   ========================= */

const APP_VERSION = "v2.0.0 — " + new Date().toLocaleString("no-NO");
const $ = (id) => document.getElementById(id);

// FTMS (Bluetooth SIG UUIDs)
const FTMS_SERVICE     = "00001826-0000-1000-8000-00805f9b34fb";
const TREADMILL_DATA   = "00002acd-0000-1000-8000-00805f9b34fb";
const HR_SERVICE       = "heart_rate";
const HR_CHAR          = "heart_rate_measurement";

// Vinduer / tegning
const HR_WINDOW_MS     = 15 * 60 * 1000;
const MAX_WINDOW_PTS   = 15 * 60 * 3;
const CHART_FPS_MS     = 250;

// PNG-resultat layout
const PNG_W = 1800;
const PNG_H = 1200;

// Farger
const COLOR_PULSE = "#27f5a4";
const COLOR_SPEED = "#ffffff"; // fartslinje (din preferanse)

/* =========================
   1) GLOBAL STATE
   ========================= */

const STATE = {
  // BLE-håndtak
  hrDevice: null,
  hrChar: null,
  tmDevice: null,
  tmChar: null,

  // Strømmer
  hrSamples: [],        // {ts,bpm,src}
  speedSamples: [],     // {ts,kmh,effectiveKmh,src}
  inclineSamples: [],   // {ts,percent,src}

  // Siste verdier
  currentHR: null,
  lastHrTs: 0,
  currentSpeed: 0,
  currentIncline: 0,

  // Vindusgraf
  windowPoints: [],     // {x,y} (HR siste 15 min)
  lastChartDraw: 0,

  // Laps
  laps: [],             // {type,rep,startTs,endTs,max30bpm,speedKmh,inclinePct, speedSrc, inclSrc}
  currentLap: null,

  // Timer
  timerRunning: false,
  elapsedSec: 0,
  tickTimer: null,

  // WakeLock
  wakeLock: null,

  // Zoner (S0..S5)
  zones: { z1:110, z2:130, z3:150, z4:165, z5:180 },

  // Manuell defaults (når FTMS mangler)
  defaultManualInclinePct: 0.0,

  // Cache for sluttfart/-incline kandidater i pågående drag
  candidateSpeed: null,
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
  const s = Math.round(sec); const m = Math.floor(s/60); const r = s%60;
  return `${m}:${String(r).padStart(2,"0")}`;
}
function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function roundHR(v){ return Math.round(v); }     // puls = hele tall
function round1(v){ return Math.round(v*10)/10;} // fart/incline = 1 desimal
function toBpmScaleFromSpeed(kmh){ return kmh*10; } // unified y-akse: 160 bpm ↔ 16.0 km/t

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
   5) BLE — HEART RATE
   ========================= */

function setHRButtonConnected(ok){
  const b=$("connectBtn");
  if(ok){ b.classList.add("connected"); b.textContent="HR ✓"; }
  else { b.classList.remove("connected"); b.textContent="Koble til pulsbelte"; }
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
   6) BLE — FTMS (FART + INCLINE)
   ========================= */

function setTreadmillButtonConnected(ok){
  const b=$("treadmillBtn");
  if(ok){ b.classList.add("connected"); b.textContent="Mølle ✓"; }
  else { b.classList.remove("connected"); b.textContent="Mølle: Koble til"; }
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

// Enkel FTMS‑parser (robust forsøkslogikk for incline):
// - speed: ofte bytes [2..3] = n/100 km/t
// - incline: forsøker [6..7] som n/10 %, ellers beholder forrige
function parseFTMSPayload(dv){
  let kmh = 0, inclinePct = STATE.currentIncline;

  try {
    const rawSpeed = dv.getUint16(2,true); // n/100 km/t
    kmh = rawSpeed/100.0;
  } catch {}

  // Prøv [6..7] som n/10 %
  try {
    const rawIncl = dv.getInt16(6,true);   // n/10 %
    const pct = rawIncl/10.0;
    // Skulle helst sanity-checke: -20% .. +40% (romslig)
    if (pct > -30 && pct < 40) inclinePct = pct;
  } catch {}

  return { kmh, inclinePct };
}

function onTreadmillNotify(e){
  const dv = e.target.value;
  const {kmh, inclinePct} = parseFTMSPayload(dv);

  const effSpeed = (STATE.currentLap && STATE.currentLap.type==="rest") ? 0 : kmh;
  ingestSpeed(Date.now(), kmh, effSpeed, "ftms");

  STATE.currentIncline = (STATE.currentLap && STATE.currentLap.type==="rest") ? STATE.currentIncline : round1(inclinePct);
  ingestIncline(Date.now(), STATE.currentIncline, "ftms");

  // Kandidater for sluttverdi i arbeid
  if(STATE.currentLap && STATE.currentLap.type==="work"){
    STATE.candidateSpeed   = effSpeed;
    STATE.candidateIncline = STATE.currentIncline;
  }
}

/* =========================
   7) SIMULERING (HR og incline)
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

// Simulert incline: bruk STATE.defaultManualInclinePct (konstant), endres av bruker
function simulateIncline(){
  return round1(STATE.defaultManualInclinePct);
}

/* =========================
   8) INGESTION (HR / SPEED / INCLINE)
   ========================= */

function ingestHR(ts, bpm, src){
  STATE.currentHR = bpm; STATE.lastHrTs = ts;
  $("pulseValue").textContent = bpm;

  STATE.hrSamples.push({ts, bpm, src});
  // Vindusbuffer
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
}

/* =========================
   9) LIVE PULS-GRAF
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

  // bakgrunn
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

  // grid (svak, men ren bakgrunn gir mest fokus)
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

// Oppdater "siden sist"
setInterval(()=>{
  $("lastSeen").textContent = STATE.lastHrTs ? Math.max(0, Math.floor((Date.now()-STATE.lastHrTs)/1000)) : "--";
}, 500);

/* =========================
   10) INTERVALLMOTOR
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
  STATE.timerRunning=true; STATE.elapsedSec=0; STATE.laps=[]; STATE.currentLap=null;

  $("startBtn").disabled=true; $("stopBtn").disabled=false;
  acquireWakeLock();

  const cfg=getCfg();
  if(cfg.warm>0) startLap("warmup",0); else startLap("work",1);

  $("timerPhase").textContent="Starter…"; $("timerClock").textContent="00:00";
  STATE.tickTimer = setInterval(tick,1000);
}

function stopTimer(){
  if(!STATE.timerRunning) return;
  STATE.timerRunning=false; clearInterval(STATE.tickTimer); STATE.tickTimer=null;

  endLap();
  $("startBtn").disabled=false; $("stopBtn").disabled=true;
  releaseWakeLock();

  finalizeLaps(); renderLapStatsText(); renderZones();
  showResultsModal();
}

function resetTimer(){
  if(STATE.timerRunning) stopTimer();
  STATE.elapsedSec=0; $("timerClock").textContent="00:00"; $("timerPhase").textContent="Stoppet";
  STATE.laps=[]; STATE.currentLap=null; STATE.windowPoints=[];
  renderLapStatsText(); renderZones(); drawLiveChart();
}

function tick(){
  STATE.elapsedSec++; $("timerClock").textContent = mmss(STATE.elapsedSec);
  const cfg=getCfg(); const cycle=cfg.work+cfg.rest; const totalMain=cfg.reps*cycle; const total=cfg.warm+totalMain+cfg.cooldown;
  const t=STATE.elapsedSec-1;

  let phase="done", rep=0;
  if(t<total){
    if(t<cfg.warm){ phase="warmup"; }
    else if(t<cfg.warm+totalMain){
      const t2=t-cfg.warm; const idx=Math.floor(t2/cycle); const within=t2%cycle; rep=idx+1;
      phase = within<cfg.work ? "work" : "rest";
    } else phase="cooldown";
  }

  if(phase==="done"){ $("timerPhase").textContent="Ferdig"; stopTimer(); return; }

  if(!STATE.currentLap || STATE.currentLap.type!==phase || STATE.currentLap.rep!==rep){
    endLap(); startLap(phase,rep);
  }

  // UI tekst
  if(phase==="warmup") $("timerPhase").textContent="Oppvarming";
  else if(phase==="cooldown") $("timerPhase").textContent="Nedjogg";
  else if(phase==="work") $("timerPhase").textContent=`Arbeid (Drag ${rep}/${cfg.reps})`;
  else $("timerPhase").textContent=`Pause (Drag ${rep}/${cfg.reps})`;

  // I pause: 0 fart
  if(phase==="rest"){ $("speedNow").textContent="0.0"; }

  // Simulering hvis HR ikke tilkoblet
  if(shouldSimHR()){
    const bpm = simulateHR(phase);
    ingestHR(Date.now(), bpm, "sim");
  }

  // Simulert incline hvis ingen FTMS (eller bare for stabil display)
  if(!STATE.tmChar && (phase==="work"||phase==="warmup"||phase==="cooldown")){
    const incl = simulateIncline();
    STATE.currentIncline = incl;
    ingestIncline(Date.now(), incl, "sim");
    if(STATE.currentLap && STATE.currentLap.type==="work") STATE.candidateIncline = incl;
  }

  // Oppdater sone/dragtekst løpende (lett)
  if(STATE.elapsedSec%2===0){ renderZones(); renderLapStatsText(); }
}

function startLap(type, rep){
  STATE.currentLap = {
    type, rep, startTs: Date.now(), endTs:null,
    max30bpm:null, speedKmh: (type==="rest"?0:null), inclinePct: null,
    speedSrc:null, inclSrc:null
  };
  STATE.laps.push(STATE.currentLap);

  // Prefill input for manuell dragfart/dragincline
  if(type==="work"){
    $("dragSpeedInput").value   = round1(STATE.currentSpeed||0).toFixed(1);
    $("dragInclineInput").value = round1(STATE.currentIncline||STATE.defaultManualInclinePct).toFixed(1);
  }else{
    $("dragSpeedInput").value="0.0"; $("dragInclineInput").value = STATE.defaultManualInclinePct.toFixed(1);
  }

  STATE.candidateSpeed=null; STATE.candidateIncline=null;
}

function endLap(){
  if(!STATE.currentLap || STATE.currentLap.endTs) return;
  STATE.currentLap.endTs = Date.now();

  const L=STATE.currentLap;
  if(L.type==="rest"){
    L.speedKmh=0; L.speedSrc="forced_rest";
    L.inclinePct = STATE.currentIncline; L.inclSrc = "carry";
  }else if(L.type==="work"){
    // speed: manuelt > kandidat > siste
    const manualSpeed = parseFloat($("dragSpeedInput").value);
    if(Number.isFinite(manualSpeed) && manualSpeed>0){
      L.speedKmh=round1(manualSpeed); L.speedSrc="manual";
    }else if(Number.isFinite(STATE.candidateSpeed) && STATE.candidateSpeed>0){
      L.speedKmh=round1(STATE.candidateSpeed); L.speedSrc="ftms_end";
    }else{
      L.speedKmh=round1(STATE.currentSpeed||0); L.speedSrc=L.speedKmh>0?"ftms_last":"unknown";
    }

    // incline: manuelt > kandidat > siste
    const manualIncl = parseFloat($("dragInclineInput").value);
    if(Number.isFinite(manualIncl)){
      L.inclinePct=round1(manualIncl); L.inclSrc="manual";
    }else if(Number.isFinite(STATE.candidateIncline)){
      L.inclinePct=round1(STATE.candidateIncline); L.inclSrc="ftms_end";
    }else{
      L.inclinePct=round1(STATE.currentIncline||STATE.defaultManualInclinePct); L.inclSrc="carry";
    }
  }else{
    // warmup/cooldown: lagre siste kjente
    L.speedKmh = round1(STATE.currentSpeed||0); L.speedSrc="info";
    L.inclinePct= round1(STATE.currentIncline||STATE.defaultManualInclinePct); L.inclSrc="info";
  }

  STATE.currentLap=null;
}

function finalizeLaps(){
  for(const L of STATE.laps){
    if(!L.endTs) continue;
    if(L.type!=="work") continue;
    const s = samplesInRange(L.startTs, L.endTs);
    L.max30bpm = computeMax30sAvg(s);
  }
}

/* =========================
   11) STATISTIKK
   ========================= */

function samplesInRange(startTs,endTs){
  return STATE.hrSamples.filter(p=>p.ts>=startTs && p.ts<=endTs).sort((a,b)=>a.ts-b.ts);
}

// Tidsvektet max 30s gjennomsnitt
function computeMax30sAvg(samples){
  if(!samples || samples.length<2) return null;
  let best=-Infinity;
  for(let i=0;i<samples.length-1;i++){
    const startT=samples[i].ts, endT=startT+30000;
    let area=0, t=startT, k=i;
    while(k<samples.length-1 && samples[k+1].ts<=t) k++;
    while(t<endT && k<samples.length-1){
      const tNext=Math.min(endT, samples[k+1].ts);
      const dt = Math.max(0,(tNext-t)/1000);
      area += samples[k].bpm * dt;
      t=tNext; if(t>=samples[k+1].ts) k++;
    }
    if(t<endT){
      const dt=(endT-t)/1000;
      area += samples[samples.length-1].bpm * dt;
    }
    const avg=area/30; if(avg>best) best=avg;
  }
  return best===-Infinity? null : best;
}

// Sonetid KUN i økta (første start → siste slutt, levende slutt hvis pågår)
function computeZoneSecondsSessionOnly(){
  if(!STATE.laps.length) return [0,0,0,0,0,0];
  const first=STATE.laps[0], last=STATE.laps[STATE.laps.length-1];
  const start=first.startTs||0, end=last.endTs||Date.now();
  if(end<=start) return [0,0,0,0,0,0];

  const samples = STATE.hrSamples.filter(p=>p.ts>=start && p.ts<=end).sort((a,b)=>a.ts-b.ts);
  const z = [0,0,0,0,0,0]; if(samples.length<2) return z;

  const {z1,z2,z3,z4,z5} = STATE.zones;
  function zoneOf(bpm){ if(bpm<z1) return 0; if(bpm<z2) return 1; if(bpm<z3) return 2; if(bpm<z4) return 3; if(bpm<z5) return 4; return 5; }

  for(let i=0;i<samples.length-1;i++){
    const s=samples[i]; const dt=Math.max(0,Math.min(5,(samples[i+1].ts-s.ts)/1000));
    z[zoneOf(s.bpm)] += dt;
  }
  return z;
}

function renderZones(){
  const zs=computeZoneSecondsSessionOnly(); const maxSec=Math.max(...zs,1);
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
   12) RESULTATMODAL + PNG
   ========================= */

function showResultsModal(){
  const modal=$("resultsModal"); modal.classList.remove("hidden");

  const note=$("note").value.trim(); const when=new Date().toLocaleString("no-NO");
  $("resultsSub").textContent = note? `${when} · ${note}` : when;

  // summer tider
  let warmT=0, workT=0, restT=0, coolT=0;
  for(const L of STATE.laps){
    if(!L.endTs) continue; const dur=(L.endTs-L.startTs)/1000;
    if(L.type==="warmup") warmT+=dur; else if(L.type==="work") workT+=dur;
    else if(L.type==="rest") restT+=dur; else if(L.type==="cooldown") coolT+=dur;
  }
  let totalActual=0;
  if(STATE.laps.length && STATE.laps[0].startTs && STATE.laps.at(-1).endTs){
    totalActual=Math.round((STATE.laps.at(-1).endTs-STATE.laps[0].startTs)/1000);
  }

  // sone
  const zoneSecs = computeZoneSecondsSessionOnly();
  renderZonesToResults(zoneSecs);

  // snittpuls total
  let sumHR=0, cntHR=0;
  if(STATE.laps.length){
    const start=STATE.laps[0].startTs, end=STATE.laps.at(-1).endTs||Date.now();
    for(const p of STATE.hrSamples){ if(p.ts>=start && p.ts<=end){ sumHR+=p.bpm; cntHR++; } }
  }
  const avgHR = cntHR? roundHR(sumHR/cntHR) : 0;

  // distanse (km) fra effective speed
  let dist=0;
  if(STATE.laps.length){
    const start=STATE.laps[0].startTs, end=STATE.laps.at(-1).endTs||Date.now();
    const s=STATE.speedSamples.filter(p=>p.ts>=start && p.ts<=end).sort((a,b)=>a.ts-b.ts);
    for(let i=0;i<s.length-1;i++){
      const dt=(s[i+1].ts - s[i].ts)/1000; dist += s[i].effectiveKmh*(dt/3600);
    }
  }

  // incline stats (snitt & maks per økt)
  let sumInc=0, cntInc=0, maxInc=0;
  if(STATE.laps.length){
    const start=STATE.laps[0].startTs, end=STATE.laps.at(-1).endTs||Date.now();
    for(const p of STATE.inclineSamples){
      if(p.ts>=start && p.ts<=end){ sumInc+=p.percent; cntInc++; if(p.percent>maxInc) maxInc=p.percent; }
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
  $("exportPngBtn").onclick = exportResultsPNG;
  $("sharePngBtn").onclick  = shareResultsPNG;
  $("exportJsonBtn2").onclick= exportJSON;
  $("saveEditsBtn").onclick  = saveEditsAndRefresh;
}

function renderZonesToResults(zs){
  const mx=Math.max(...zs,1);
  for(let i=0;i<=5;i++){
    $(`rbarS${i}`).style.width=`${((zs[i]/mx)*100).toFixed(1)}%`;
    $(`rtimeS${i}`).textContent=fmtTime(zs[i]);
  }
}

function renderSpeedInclineEditor(){
  const wrap=$("speedEditor"); const work=STATE.laps.filter(l=>l.type==="work"&&l.endTs);
  if(!work.length){ wrap.textContent="—"; return; }
  wrap.innerHTML="";

  for(const L of work){
    const row=document.createElement("div"); row.className="speedRow";

    const lbl=document.createElement("div"); lbl.className="speedRowLabel";
    lbl.textContent=`Drag ${L.rep}`;
    row.appendChild(lbl);

    const inpSpeed=document.createElement("input");
    inpSpeed.type="number"; inpSpeed.step="0.1"; inpSpeed.min="0";
    inpSpeed.value=(Number.isFinite(L.speedKmh)?L.speedKmh:0).toFixed(1);
    inpSpeed.dataset.rep=String(L.rep);
    inpSpeed.dataset.kind="speed";
    row.appendChild(inpSpeed);

    // Incline input (prosent)
    const inpInc=document.createElement("input");
    inpInc.type="number"; inpInc.step="0.1"; inpInc.min="-5"; // romslig
    inpInc.value=(Number.isFinite(L.inclinePct)?L.inclinePct:STATE.defaultManualInclinePct).toFixed(1);
    inpInc.dataset.rep=String(L.rep);
    inpInc.dataset.kind="incline";
    row.appendChild(inpInc);

    wrap.appendChild(row);
  }
}

function saveEditsAndRefresh(){
  const inputs = $("speedEditor").querySelectorAll("input");
  const patch = new Map(); // rep -> {speed?,incline?}
  for(const i of inputs){
    const rep=parseInt(i.dataset.rep,10), kind=i.dataset.kind, val=parseFloat(i.value);
    if(!patch.has(rep)) patch.set(rep,{});
    patch.get(rep)[kind]=val;
  }
  for(const L of STATE.laps){
    if(L.type!=="work") continue;
    const p=patch.get(L.rep); if(!p) continue;
    if(Number.isFinite(p.speed)){ L.speedKmh=round1(p.speed); L.speedSrc="manual_edit"; }
    if(Number.isFinite(p.incline)){ L.inclinePct=round1(p.incline); L.inclSrc="manual_edit"; }
  }
  finalizeLaps(); renderLapStatsText(); drawResultsChart(); saveCurrentSession(); alert("Endringer lagret.");
}

// Tegn pulsstolper + fartslinje (unified y)
function drawResultsChart(){
  const canvas=$("resultsCanvas"); const dpr=Math.max(1,Math.min(3,window.devicePixelRatio||1));
  canvas.width=PNG_W*dpr; canvas.height=PNG_H*dpr; canvas.style.width=PNG_W+"px"; canvas.style.height=PNG_H+"px";
  const ctx=canvas.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);

  // bakgrunn
  ctx.fillStyle="#0b0f14"; ctx.fillRect(0,0,PNG_W,PNG_H);

  const work=STATE.laps.filter(l=>l.type==="work"&&l.endTs);
  const valPulse = work.map(l=> l.max30bpm? roundHR(l.max30bpm) : 0);
  const valSpeed = work.map(l=> Number.isFinite(l.speedKmh)? l.speedKmh : 0);

  const padL=80, padR=80, padT=80, padB=140;
  const plotW=PNG_W-padL-padR, plotH=PNG_H-padT-padB;

  // skala
  let minVal=999, maxVal=-999;
  for(let i=0;i<work.length;i++){
    const v=valPulse[i], s=toBpmScaleFromSpeed(valSpeed[i]);
    minVal=Math.min(minVal,v,s); maxVal=Math.max(maxVal,v,s);
  }
  if(minVal===999){ minVal=0; maxVal=200; }
  if(maxVal-minVal<20) maxVal=minVal+20;

  const yToPx=(y)=> padT + (1-(y-minVal)/(maxVal-minVal))*plotH;

  // grid (diskré)
  ctx.strokeStyle="rgba(255,255,255,0.12)"; ctx.lineWidth=1; ctx.font="22px system-ui"; ctx.fillStyle="rgba(255,255,255,0.8)";
  ctx.textAlign="right"; ctx.textBaseline="middle";
  for(let i=0;i<=6;i++){
    const yVal= maxVal - i*((maxVal-minVal)/6);
    const y=yToPx(yVal);
    ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(padL+plotW,y); ctx.stroke();
    ctx.fillText(Math.round(yVal), padL-10, y);               // venstre (bpm)
    ctx.fillText((Math.round(yVal)/10).toFixed(1), padL+plotW+50, y); // høyre (km/t)
  }

  // x labels (drag)
  const n=work.length; const gap=14; const barW=Math.max(20,(plotW - gap*(n-1))/n);
  ctx.textAlign="center"; ctx.textBaseline="top"; ctx.fillStyle="rgba(255,255,255,0.8)";
  for(let i=0;i<n;i++){
    const x=padL + i*(barW+gap) + barW/2;
    ctx.fillText(String(work[i].rep), x, padT+plotH+10);
  }

  // puls-stolper
  ctx.fillStyle = COLOR_PULSE;
  for(let i=0;i<n;i++){
    const v=valPulse[i]; const x=padL + i*(barW+gap); const y=yToPx(v), y0=yToPx(minVal);
    ctx.fillRect(x,y,barW,y0-y);
  }

  // fartslinje (hvit)
  ctx.strokeStyle = COLOR_SPEED; ctx.lineWidth=4; ctx.beginPath();
  let started=false;
  for(let i=0;i<n;i++){
    const s=toBpmScaleFromSpeed(valSpeed[i]); const x=padL + i*(barW+gap) + barW/2; const y=yToPx(s);
    if(!started){ ctx.moveTo(x,y); started=true; } else ctx.lineTo(x,y);
  }
  ctx.stroke();

  // Tittel
  ctx.fillStyle="white"; ctx.font="32px system-ui"; ctx.textAlign="left"; ctx.textBaseline="top";
  ctx.fillText("Puls (stolper) og Fart (linje)", padL, 20);

  // Summary‑boks nederst
  ctx.fillStyle="rgba(255,255,255,0.12)"; ctx.fillRect(padL, PNG_H-120, plotW, 100);
  ctx.fillStyle="white"; ctx.font="20px system-ui"; ctx.textBaseline="middle";
  const lines = $("summaryText").textContent.split("\n"); let yOff=PNG_H-100;
  for(const line of lines){ ctx.fillText(line, padL+10, yOff); yOff+=24; }
}

function exportResultsPNG(){
  const canvas=$("resultsCanvas"); const url=canvas.toDataURL("image/png");
  const a=document.createElement("a"); a.href=url; a.download=`hr-result-${Date.now()}.png`; a.click();
}
async function shareResultsPNG(){
  if(!navigator.canShare){ alert("Deling støttes ikke her."); return; }
  const canvas=$("resultsCanvas"); const blob=await new Promise(res=>canvas.toBlob(res,"image/png"));
  const file=new File([blob],`hr-result-${Date.now()}.png`,{type:"image/png"});
  if(navigator.canShare({files:[file]})) await navigator.share({title:"HR Resultat", files:[file]});
}

/* =========================
   13) EXPORT JSON (SESSION)
   ========================= */

function buildSessionPayload(existingId=null){
  return {
    id: existingId || crypto.randomUUID?.() || `id-${Date.now()}`,
    createdAt: new Date().toISOString(),
    note: $("note").value.trim(),
    config: {
      warmupSec: parseInt($("warmupSec").value,10)||0,
      workSec: parseInt($("workSec").value,10)||0,
      restSec: parseInt($("restSec").value,10)||0,
      cooldownSec: parseInt($("cooldownSec").value,10)||0,
      reps: parseInt($("reps").value,10)||0,
      simMode: $("simMode").value
    },
    zones: STATE.zones,
    laps: STATE.laps,
    hrSamples: STATE.hrSamples,
    speedSamples: STATE.speedSamples,
    inclineSamples: STATE.inclineSamples
  };
}
function exportJSON(){
  const p=buildSessionPayload(STATE.lastSavedSessionId);
  const blob=new Blob([JSON.stringify(p,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob); const a=document.createElement("a");
  a.href=url; a.download=`hr-session-${Date.now()}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),500);
}

/* =========================
   14) INDEXEDDB (SESSIONS)
   ========================= */

const DB_NAME="hr_app_db_v2", DB_VER=1, STORE="sessions";
function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VER);
    req.onupgradeneeded=()=>{ const db=req.result; if(!db.objectStoreNames.contains(STORE)){ const os=db.createObjectStore(STORE,{keyPath:"id"}); os.createIndex("createdAt","createdAt"); } };
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
async function dbPut(s){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).put(s); tx.oncomplete=()=>res(true); tx.onerror=()=>rej(tx.error); }); }
async function dbGet(id){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readonly"); const r=tx.objectStore(STORE).get(id); r.onsuccess=()=>res(r.result||null); r.onerror=()=>rej(r.error); }); }
async function dbGetAll(){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readonly"); const r=tx.objectStore(STORE).getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); }); }
async function dbDelete(id){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).delete(id); tx.oncomplete=()=>res(true); tx.onerror=()=>rej(tx.error); }); }

async function saveCurrentSession(){
  const payload = buildSessionPayload(STATE.lastSavedSessionId);
  STATE.lastSavedSessionId = payload.id;
  await dbPut(payload); await refreshSessionList();
}

async function refreshSessionList(){
  const list=await dbGetAll(); list.sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""));
  const sel=$("sessionSelect"); sel.innerHTML="";
  const opt0=document.createElement("option"); opt0.value=""; opt0.textContent=list.length? "Velg økt…" : "Ingen lagrede økter"; sel.appendChild(opt0);
  for(const s of list){
    const o=document.createElement("option"); o.value=s.id;
    const d=(s.createdAt||"").replace("T"," ").slice(0,16);
    o.textContent = `${d}${s.note? " · "+s.note:""}`; sel.appendChild(o);
  }
}

async function loadSelectedSession(){
  const id=$("sessionSelect").value; if(!id) return;
  const sess=await dbGet(id); if(!sess) return;
  STATE.lastSavedSessionId = sess.id;

  // config
  $("warmupSec").value   = sess.config.warmupSec;
  $("workSec").value     = sess.config.workSec;
  $("restSec").value     = sess.config.restSec;
  $("cooldownSec").value = sess.config.cooldownSec;
  $("reps").value        = sess.config.reps;
  $("simMode").value     = sess.config.simMode;
  $("note").value        = sess.note||"";
  STATE.zones            = sess.zones || STATE.zones;

  // data
  STATE.laps            = sess.laps || [];
  STATE.hrSamples       = sess.hrSamples || [];
  STATE.speedSamples    = sess.speedSamples || [];
  STATE.inclineSamples  = sess.inclineSamples || [];

  // rebuild window HR
  const now=Date.now();
  STATE.windowPoints = STATE.hrSamples.filter(p=>p.ts>=now-HR_WINDOW_MS).map(p=>({x:p.ts,y:p.bpm}));
  $("pulseValue").textContent = STATE.hrSamples.at(-1)?.bpm ?? "--";
  $("speedNow").textContent   = round1(STATE.speedSamples.at(-1)?.effectiveKmh ?? 0).toFixed(1);

  finalizeLaps(); renderLapStatsText(); renderZones(); drawLiveChart();
  $("resultsModal").classList.remove("hidden");
  $("resultsSub").textContent = `Lastet økt: ${sess.createdAt?.replace("T"," ").slice(0,16) || ""}`;
  renderSpeedInclineEditor(); drawResultsChart();
  $("summaryText").textContent="(Lastet økt)";
  renderZonesToResults(computeZoneSecondsSessionOnly());
}

async function deleteSelectedSession(){
  const id=$("sessionSelect").value; if(!id) return; await dbDelete(id); await refreshSessionList(); alert("Økt slettet.");
}

/* =========================
   15) CLEAR / EXPORT KNAPPER
   ========================= */

function clearAllData(){
  STATE.windowPoints=[]; STATE.hrSamples=[]; STATE.speedSamples=[]; STATE.inclineSamples=[];
  STATE.laps=[]; STATE.currentLap=null; STATE.currentHR=null; STATE.currentSpeed=0; STATE.currentIncline=0;
  STATE.lastHrTs=0; $("pulseValue").textContent="--"; $("speedNow").textContent="0.0"; $("lastSeen").textContent="--";
  $("timerClock").textContent="00:00"; $("timerPhase").textContent="Stoppet";
  renderLapStatsText(); renderZones(); drawLiveChart(); setStatus("Tømte data");
}

/* =========================
   16) UI-BINDINGS + DYNAMISK INCLINE-FELT
   ========================= */

function addManualInclineRow(){
  // Legg til i timerpanelet (uten å endre HTML): en grid2 rad med input + knapp
  const panel = document.querySelector(".timerInputs");
  const row   = document.createElement("div"); row.className="grid2";

  const field1 = document.createElement("label"); field1.className="field";
  const sp1 = document.createElement("span"); sp1.textContent="Drag‑stigning (%)";
  const inp = document.createElement("input"); inp.type="number"; inp.step="0.1"; inp.value=STATE.defaultManualInclinePct.toFixed(1); inp.id="dragInclineInput";
  field1.appendChild(sp1); field1.appendChild(inp);

  const field2 = document.createElement("div"); field2.className="field";
  const sp2 = document.createElement("span"); sp2.innerHTML="&nbsp;";
  const btn = document.createElement("button"); btn.className="secondaryBtn"; btn.id="applyDragInclineBtn"; btn.textContent="Sett stigning";
  field2.appendChild(sp2); field2.appendChild(btn);

  row.appendChild(field1); row.appendChild(field2);
  panel.insertBefore(row, panel.querySelector(".btnRow")); // før Start/Stopp-knapper

  btn.onclick = ()=>{
    const v=parseFloat($("dragInclineInput").value);
    if(Number.isFinite(v)){ STATE.defaultManualInclinePct=round1(v); setStatus(`Standard stigning satt: ${STATE.defaultManualInclinePct.toFixed(1)} %`); }
  };
}

function bindUI(){
  $("connectBtn").onclick     = connectHR;
  $("treadmillBtn").onclick   = connectTreadmill;

  $("startBtn").onclick       = startTimer;
  $("stopBtn").onclick        = stopTimer;
  $("resetBtn").onclick       = resetTimer;

  $("applyZonesBtn").onclick  = ()=>{
    STATE.zones = {
      z1: parseInt($("z1").value,10)||110,
      z2: parseInt($("z2").value,10)||130,
      z3: parseInt($("z3").value,10)||150,
      z4: parseInt($("z4").value,10)||165,
      z5: parseInt($("z5").value,10)||180
    };
    renderZones(); drawResultsChart();
  };

  $("applyDragSpeedBtn").onclick = ()=>{
    if(!STATE.currentLap || STATE.currentLap.type!=="work"){ alert("Endre dragfart når du er i arbeid‑drag."); return; }
    const v=parseFloat($("dragSpeedInput").value);
    if(Number.isFinite(v) && v>=0){
      STATE.currentLap.speedKmh = round1(v);
      STATE.currentLap.speedSrc = "manual";
      setStatus(`Dragfart satt manuelt: ${STATE.currentLap.speedKmh.toFixed(1)} km/t`);
    }
  };

  $("addRepBtn").onclick = ()=>{ const r=parseInt($("reps").value,10)||0; $("reps").value=r+1; if(STATE.timerRunning) setStatus("La til drag"); };
  $("removeRepBtn").onclick = ()=>{ const r=parseInt($("reps").value,10)||0; if(r>1) $("reps").value=r-1; if(STATE.timerRunning) setStatus("Fjernet drag"); };

  $("exportBtn").onclick = exportJSON;
  $("clearBtn").onclick  = clearAllData;

  $("loadSessionBtn").onclick   = loadSelectedSession;
  $("deleteSessionBtn").onclick = deleteSelectedSession;

  // Resultatmodal‑delknapper settes i showResultsModal()
}

/* =========================
   17) CAPABILITY & INIT
   ========================= */

function initCapabilityCheck(){
  if(!("bluetooth" in navigator)){
    $("connectBtn").disabled=true; $("treadmillBtn").disabled=true;
    if(isIOS()) showIOSNotice(isSafari()? "iOS Safari støtter ikke Web Bluetooth.":"iOS støtter normalt ikke Web Bluetooth.");
    setStatus("Bluetooth ikke støttet"); return;
  }
  $("connectBtn").disabled=false; $("treadmillBtn").disabled=false; setStatus("Klar");
}
function showIOSNotice(msg){ const el=$("iosNotice"); el.textContent=msg; el.classList.remove("hidden"); }
function hideIOSNotice(){ $("iosNotice").classList.add("hidden"); }

async function refreshVersionTag(){ $("versionTag").textContent = APP_VERSION; }

async function init(){
  await refreshVersionTag();
  await setupUpdateBanner();
  initCapabilityCheck();
  bindUI();
  addManualInclineRow(); // Dynamisk felt for stigning i timerpanelet

  // Init zoner i feltene
  $("z1").value=STATE.zones.z1; $("z2").value=STATE.zones.z2; $("z3").value=STATE.zones.z3; $("z4").value=STATE.zones.z4; $("z5").value=STATE.zones.z5;

  await refreshSessionList();
  renderZones(); renderLapStatsText(); drawLiveChart();
}

init().catch(console.warn);
