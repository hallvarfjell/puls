
let chart;
let dataPoints = [];

async function connect() {
    try {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: ["heart_rate"] }]
        });

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService("heart_rate");
        const characteristic = await service.getCharacteristic("heart_rate_measurement");

        characteristic.startNotifications();
        characteristic.addEventListener("characteristicvaluechanged", handleHR);

        console.log("Tilkoblet pulsbelte");
    } catch (err) {
        console.error(err);
        alert("Kunne ikke koble til pulsbelte");
    }
}

function handleHR(event) {
    const value = event.target.value;
    const flags = value.getUint8(0);
    const hr16Bits = flags & 0x01;

    let hr;
    if (hr16Bits) {
        hr = value.getUint16(1, true);
    } else {
        hr = value.getUint8(1);
    }

    document.getElementById("pulseValue").textContent = hr;

    const now = Date.now();
    dataPoints.push({ x: now, y: hr });

    const cutoff = now - 10 * 60 * 1000;
    dataPoints = dataPoints.filter(p => p.x >= cutoff);

    chart.data.datasets[0].data = dataPoints;
    chart.update();
}

function setupChart() {
    const ctx = document.getElementById("hrChart").getContext("2d");

    chart = new Chart(ctx, {
        type: "line",
        data: {
            datasets: [{
                label: "Puls (BPM)",
                data: [],
                borderColor: "#00ff90",
                borderWidth: 2,
                tension: 0.25
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: {
                    type: "realtime",
                    realtime: {
                        duration: 600000,  // 10 minutter
                        delay: 0,
                        refresh: 1000
                    }
                },
                y: {
                    suggestedMin: 50,
                    suggestedMax: 190
                }
            }
        }
    });
}

document.getElementById("connectBtn").addEventListener("click", connect);
setupChart();
