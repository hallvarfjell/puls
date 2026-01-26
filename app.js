
/* app.js - BLE HRM + chart (no streaming plugin) */

const HR_WINDOW_MS = 10 * 60 * 1000; // 10 min
const MAX_POINTS = 10 * 60 * 2;      // f.eks. opptil ~2 Hz i 10 min (1200 punkter)

let hrChart = null;
let dataPoints = []; // {x: ms, y: bpm}

let device = null;
let characteristic = null;

let lastHrTimestamp = 0;
let lastChartUpdate = 0;

function setStatus(text) {
  document.getElementById("statusText").textContent = text;
}

function nowMs() {
  return Date.now();
}

function formatSecondsAgo(msAgo) {
  const s = Math.max(0, Math.floor(msAgo / 1000));
  return String(s);
}

/**
 * Format tick labels for x axis using relative time (mm:ss from "now")
 * x is absolute ms timestamp, but we show "min:sec ago"
 */
function formatTickLabel(xValue) {
  const diff = nowMs() - xValue; // ms ago
  const totalSec = Math.max(0, Math.floor(diff / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  // show time ago as "-mm:ss"
  return `-${mm}:${String(ss).padStart(2, "0")}`;
}

function setupChart() {
  const ctx = document.getElementById("hrChart").getContext("2d");

  hrChart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [{
        label: "Puls (BPM)",
        data: [],             // will be [{x, y}, ...]
        parsing: false,       // important: we're passing x/y objects
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
    alert("Kunne ikke koble til pulsbelte. Sjekk at du bruker Chrome/Edge på Android og at Bluetooth er på.");
  }
}

function onDisconnected() {
  setStatus("Frakoblet – trykk for å koble til igjen");
}

function parseHeartRate(value) {
  // Heart Rate Measurement characteristic spec:
  // byte0 = flags
  // if flags & 0x01 => HR is uint16 at bytes 1-2, else uint8 at byte1
  const flags = value.getUint8(0);
  const is16Bit = (flags & 0x01) !== 0;
  return is16Bit ? value.getUint16(1, true) : value.getUint8(1);
}

function pruneOldPoints(now) {
  const cutoff = now - HR_WINDOW_MS;

  // Remove old points
  while (dataPoints.length && dataPoints[0].x < cutoff) {
    dataPoints.shift();
  }

  // Also cap absolute count for safety
  if (dataPoints.length > MAX_POINTS) {
    dataPoints = dataPoints.slice(dataPoints.length - MAX_POINTS);
  }
}

function updateChartThrottled(now) {
  // Throttle chart updates to reduce CPU (e.g. 4 fps)
  if (now - lastChartUpdate < 250) return;
  lastChartUpdate = now;

  hrChart.data.datasets[0].data = dataPoints;
  hrChart.update("none");
}

function handleHeartRate(event) {
  const value = event.target.value;
  const hr = parseHeartRate(value);

  const now = nowMs();
  lastHrTimestamp = now;

  // UI
  document.getElementById("pulseValue").textContent = hr;

  // Data
  dataPoints.push({ x: now, y: hr });
  pruneOldPoints(now);

  // Chart
  updateChartThrottled(now);
}

// Update "seconds since last HR"
setInterval(() => {
  const el = document.getElementById("lastSeen");
  if (!lastHrTimestamp) {
    el.textContent = "--";
  } else {
    el.textContent = formatSecondsAgo(nowMs() - lastHrTimestamp);
  }
}, 500);

// Init
document.getElementById("connectBtn").addEventListener("click", connect);
setupChart();
setStatus("Ikke tilkoblet");
