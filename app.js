
/* app.js - BLE HRM + chart (no streaming plugin) + iOS/Safari guidance */

const HR_WINDOW_MS = 10 * 60 * 1000; // 10 min
const MAX_POINTS = 10 * 60 * 2;      // ~2 Hz in 10 min

let hrChart = null;
let dataPoints = []; // {x: ms, y: bpm}

let device = null;
let characteristic = null;

let lastHrTimestamp = 0;
let lastChartUpdate = 0;

function $(id) { return document.getElementById(id); }

function setStatus(text) {
  $("statusText").textContent = text;
}

function nowMs() {
  return Date.now();
}

function formatSecondsAgo(msAgo) {
  const s = Math.max(0, Math.floor(msAgo / 1000));
  return String(s);
}

/**
 * x is absolute ms timestamp, show "-mm:ss" (time ago)
 */
function formatTickLabel(xValue) {
  const diff = nowMs() - xValue; // ms ago
  const totalSec = Math.max(0, Math.floor(diff / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `-${mm}:${String(ss).padStart(2, "0")}`;
}

function isIOS() {
  // iPadOS 13+ reports as MacIntel with touch points
  return /iP(hone|ad|od)/.test(navigator.userAgent) ||
         (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isSafari() {
  // On iOS all browsers use WebKit; but this helps messaging in normal Safari
  const ua = navigator.userAgent;
  const isAppleWebKit = /AppleWebKit/.test(ua);
  const isChrome = /CriOS/.test(ua);
  const isFirefox = /FxiOS/.test(ua);
  const isEdge = /EdgiOS/.test(ua);
  return isAppleWebKit && !isChrome && !isFirefox && !isEdge;
}

function setupChart() {
  const ctx = $("hrChart").getContext("2d");

  hrChart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [{
        label: "Puls (BPM)",
        data: [],
        parsing: false,          // using {x,y}
        borderColor: "#27f5a4",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.25
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const x = items?.[0]?.raw?.x;
              return x ? `Tid: ${formatTickLabel(x)}` : "";
            }
          }
        }
      },
      scales: {
        x: {
          type: "linear",
          grid: { color: "rgba(255,255,255,0.06)" },
          ticks: {
            color: "rgba(255,255,255,0.7)",
            maxTicksLimit: 6,
            callback: (value) => formatTickLabel(value)
          }
        },
        y: {
          suggestedMin: 50,
          suggestedMax: 190,
          grid: { color: "rgba(255,255,255,0.06)" },
          ticks: { color: "rgba(255,255,255,0.7)" }
        }
      }
    }
  });
}

async function connect() {
  try {
    setStatus("Åpner Bluetooth-dialog…");

    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ["heart_rate"] }],
      optionalServices: ["battery_service"]
    });

    device.addEventListener("gattserverdisconnected", onDisconnected);

    setStatus("Kobler til…");
    const server = await device.gatt.connect();

    const service = await server.getPrimaryService("heart_rate");
    characteristic = await service.getCharacteristic("heart_rate_measurement");

    await characteristic.startNotifications();
    characteristic.addEventListener("characteristicvaluechanged", handleHeartRate);

    setStatus(`Tilkoblet: ${device.name || "pulsbelte"}`);
  } catch (err) {
    console.error(err);
    setStatus("Tilkobling feilet");
    alert("Kunne ikke koble til pulsbelte. Sjekk at Bluetooth er på, og bruk Chrome/Edge på Android.");
  }
}

function onDisconnected() {
  setStatus("Frakoblet – trykk for å koble til igjen");
}

function parseHeartRate(value) {
  const flags = value.getUint8(0);
  const is16Bit = (flags & 0x01) !== 0;
  return is16Bit ? value.getUint16(1, true) : value.getUint8(1);
}

function pruneOldPoints(now) {
  const cutoff = now - HR_WINDOW_MS;

  while (dataPoints.length && dataPoints[0].x < cutoff) {
    dataPoints.shift();
  }
  if (dataPoints.length > MAX_POINTS) {
    dataPoints = dataPoints.slice(dataPoints.length - MAX_POINTS);
  }
}

function updateChartThrottled(now) {
  if (now - lastChartUpdate < 250) return; // ~4 fps max
  lastChartUpdate = now;

  hrChart.data.datasets[0].data = dataPoints;
  hrChart.update("none");
}

function handleHeartRate(event) {
  const hr = parseHeartRate(event.target.value);
  const now = nowMs();

  lastHrTimestamp = now;
  $("pulseValue").textContent = hr;

  dataPoints.push({ x: now, y: hr });
  pruneOldPoints(now);
  updateChartThrottled(now);
}

// Update "seconds since last HR"
setInterval(() => {
  const el = $("lastSeen");
  if (!lastHrTimestamp) el.textContent = "--";
  else el.textContent = formatSecondsAgo(nowMs() - lastHrTimestamp);
}, 500);

function showNoBluetoothGuidance() {
  const btn = $("connectBtn");
  btn.disabled = true;

  // Tailored messaging for iOS Safari
  if (isIOS()) {
    if (isSafari()) {
      setStatus("iOS Safari støtter ikke Bluetooth-pulsbelter i web/PWA. Bruk Android (Chrome/Edge), eller et Android-nettbrett.");
    } else {
      setStatus("iOS støtter normalt ikke Web Bluetooth i vanlige nettlesere. Bruk Android (Chrome/Edge), eller vurder en spesialnettleser med WebBLE-støtte.");
    }
  } else {
    setStatus("Denne nettleseren støtter ikke Web Bluetooth. Prøv Chrome/Edge på Android.");
  }
}

function initCapabilityCheck() {
  // Web Bluetooth capability
  if (!("bluetooth" in navigator)) {
    showNoBluetoothGuidance();
    return;
  }

  // Supported: set normal status and enable button
  $("connectBtn").disabled = false;
  setStatus("Ikke tilkoblet");
}

function init() {
  setupChart();
  $("connectBtn").addEventListener("click", connect);
  initCapabilityCheck();
}

init();
