console.log('[MAIN.JS] ✓ Script loaded and executing');

// Telemetry Elements
const logEntries = document.getElementById('logEntries');
const valLatency = document.getElementById('valLatency');
const valSpeed = document.getElementById('valSpeed');
console.log('[MAIN.JS] Elements found:', {logEntries: !!logEntries, valLatency: !!valLatency, valSpeed: !!valSpeed});

function addLog(msg, type='INFO') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const tagClass = type === 'CMD' || type === 'SYS' ? 'green' : (type === 'ERR' ? 'red' : '');
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `<span class="timestamp">[${time}]</span> <span class="tag ${tagClass}">${type}:</span> ${msg}`;
    logEntries.appendChild(entry);
    logEntries.scrollTop = logEntries.scrollHeight;
}

// Command sending function
async function sendCommand(cmd, value=null) {
    let commandStr = value !== null ? `${cmd}_${value}` : cmd;
    try {
        const formData = new FormData();
        formData.append('cmd', commandStr);
        const response = await fetch('/command', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (data.status === 'ok') {
            addLog(commandStr, 'CMD');
        } else {
            addLog(`FAILED: ${data.message}`, 'ERR');
        }
    } catch(err) {
        addLog(`NETWORK_ERR: ${err.message}`, 'ERR');
    }
}

// Buttons — null-guarded to prevent early crash stopping the whole script
console.log('[MAIN.JS] Attaching button listeners...');
const _btnStop = document.getElementById('btnStopEngine');
const _btnArm = document.getElementById('btnArm');
if (_btnStop) _btnStop.addEventListener('click', () => sendCommand('ENGINE_STOP'));
else console.warn('[MAIN.JS] ⚠ btnStopEngine NOT FOUND');
if (_btnArm) _btnArm.addEventListener('click', () => sendCommand('SYSTEM_ARM'));
else console.warn('[MAIN.JS] ⚠ btnArm NOT FOUND');

// Sliders
const speedLimiter = document.getElementById('speedLimiter');
speedLimiter.addEventListener('change', (e) => sendCommand('LIMITER', e.target.value));

const steeringTrim = document.getElementById('steeringTrim');
steeringTrim.addEventListener('change', (e) => sendCommand('TRIM', e.target.value));

document.getElementById('btnTrimLeft').addEventListener('click', () => {
    steeringTrim.value = Math.max(parseInt(steeringTrim.value) - 5, -100);
    sendCommand('TRIM', steeringTrim.value);
});
document.getElementById('btnTrimRight').addEventListener('click', () => {
    steeringTrim.value = Math.min(parseInt(steeringTrim.value) + 5, 100);
    sendCommand('TRIM', steeringTrim.value);
});

// Joystick
const canvas = document.getElementById('joystickCanvas');
const ctx = canvas.getContext('2d');
let centerX = canvas.width / 2;
let centerY = canvas.height / 2;
let stickX = centerX, stickY = centerY;
let dragging = false;
let currentDirection = null;

function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
    centerX = canvas.width / 2;
    centerY = canvas.height / 2;
    stickX = centerX;
    stickY = centerY;
    drawJoystick();
}
window.addEventListener('resize', resizeCanvas);

function drawJoystick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Base
    ctx.beginPath();
    ctx.arc(centerX, centerY, centerX - 20, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Crosshairs
    ctx.beginPath();
    ctx.moveTo(centerX - 30, centerY);
    ctx.lineTo(centerX + 30, centerY);
    ctx.moveTo(centerX, centerY - 30);
    ctx.lineTo(centerX, centerY + 30);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.stroke();

    // Knob
    ctx.beginPath();
    ctx.roundRect(stickX - 25, stickY - 25, 50, 50, 12);
    ctx.fillStyle = '#a4e326';
    ctx.fill();
    ctx.shadowBlur = 15;
    ctx.shadowColor = 'rgba(164, 227, 38, 0.4)';
    
    // Knob pattern
    ctx.fillStyle = '#000';
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(stickX, stickY, 4, 0, 2*Math.PI);
    ctx.fill();
    ctx.moveTo(stickX - 8, stickY); ctx.lineTo(stickX - 14, stickY);
    ctx.moveTo(stickX + 8, stickY); ctx.lineTo(stickX + 14, stickY);
    ctx.moveTo(stickX, stickY - 8); ctx.lineTo(stickX, stickY - 14);
    ctx.moveTo(stickX, stickY + 8); ctx.lineTo(stickX, stickY + 14);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.stroke();
}

function getDirectionFromVector(dx, dy) {
    if (Math.hypot(dx, dy) < 15) return "STOP";
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    if (angle >= -45 && angle < 45) return "RIGHT";
    if (angle >= 45 && angle < 135) return "DOWN";
    if (angle >= -135 && angle < -45) return "UP";
    return "LEFT";
}

function updateJoystick(e) {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    let clientX = e.touches ? e.touches[0].clientX : e.clientX;
    let clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    let rawX = clientX - rect.left;
    let rawY = clientY - rect.top;
    
    let dx = rawX - centerX;
    let dy = rawY - centerY;
    
    let dist = Math.hypot(dx, dy);
    let maxRadius = centerX - 25;
    
    if (dist > maxRadius) {
        dx = dx * (maxRadius / dist);
        dy = dy * (maxRadius / dist);
    }
    
    stickX = centerX + dx;
    stickY = centerY + dy;
    
    drawJoystick();
    
    const dir = getDirectionFromVector(dx, dy);
    if (dir !== currentDirection) {
        currentDirection = dir;
        sendCommand('MOVE', dir);
        if(dir === 'UP') valSpeed.innerText = (1.2 * (speedLimiter.value/100)).toFixed(1);
        else if(dir === 'DOWN') valSpeed.innerText = (-0.5 * (speedLimiter.value/100)).toFixed(1);
        else valSpeed.innerText = '0.0';
    }
}

function resetJoystick() {
    dragging = false;
    stickX = centerX;
    stickY = centerY;
    drawJoystick();
    if (currentDirection !== "STOP") {
        currentDirection = "STOP";
        sendCommand('MOVE', "STOP");
        valSpeed.innerText = '0.0';
    }
}

canvas.addEventListener('mousedown', (e) => { dragging = true; updateJoystick(e); });
window.addEventListener('mousemove', updateJoystick);
window.addEventListener('mouseup', resetJoystick);

canvas.addEventListener('touchstart', (e) => { e.preventDefault(); dragging = true; updateJoystick(e); }, {passive: false});
window.addEventListener('touchmove', (e) => { if(dragging) e.preventDefault(); updateJoystick(e); }, {passive: false});
window.addEventListener('touchend', resetJoystick);

// Vertical Throttle Track
const throttleTrack = document.getElementById('throttleTrack');
const throttleFill = document.getElementById('throttleFill');
const throttleHandle = document.getElementById('throttleHandle');
const throttleVal = document.getElementById('throttleVal');

let throttleDragging = false;
let currentThrottle = 50;

function updateThrottleDisplay(percent) {
    throttleFill.style.height = `${percent}%`;
    throttleHandle.style.bottom = `${percent}%`;
    throttleVal.innerText = `${Math.round(percent)}%`;
}

function updateThrottle(e) {
    if (!throttleDragging) return;
    const rect = throttleTrack.getBoundingClientRect();
    let clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    let y = clientY - rect.top;
    let percent = 100 - (y / rect.height * 100);
    percent = Math.max(0, Math.min(100, percent));
    
    if (Math.abs(currentThrottle - percent) > 2) {
        currentThrottle = percent;
        updateThrottleDisplay(percent);
        sendCommand('THROTTLE', Math.round(percent));
    }
}

throttleTrack.addEventListener('mousedown', (e) => { throttleDragging = true; updateThrottle(e); });
window.addEventListener('mousemove', updateThrottle);
window.addEventListener('mouseup', () => { throttleDragging = false; });

throttleTrack.addEventListener('touchstart', (e) => { e.preventDefault(); throttleDragging = true; updateThrottle(e); }, {passive: false});
window.addEventListener('touchmove', (e) => { if(throttleDragging) e.preventDefault(); updateThrottle(e); }, {passive: false});
window.addEventListener('touchend', () => { throttleDragging = false; });

// Initial Draws
resizeCanvas();

// --- Sidebar & Top Nav Section Switching ---
const allNavLinks = document.querySelectorAll('#sidebarNav a, #topNav a');
const appSections = document.querySelectorAll('.app-section');

allNavLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetSection = link.getAttribute('data-section');
        if (!targetSection) return;

        // Update active states
        allNavLinks.forEach(l => {
            l.classList.remove('active');
            if(l.querySelector('i')) l.querySelector('i').classList.remove('highlight');
        });
        link.classList.add('active');
        if(link.querySelector('i')) link.querySelector('i').classList.add('highlight');
        
        // Show target section, hide others
        appSections.forEach(section => {
            if (section.id === `section-${targetSection}`) {
                section.style.display = (targetSection === 'drive' || targetSection === 'terminal') ? 'flex' : 'block';
                if (targetSection === 'drive') resizeCanvas();
                if (targetSection === 'terminal') {
                    setTimeout(() => {
                        const tInput = document.getElementById('terminalInput');
                        if (tInput) tInput.focus();
                    }, 50);
                }
            } else {
                section.style.display = 'none';
            }
        });
        
        addLog(`SWITCHED_TO: ${targetSection.toUpperCase()}`, 'SYS');
    });
});

// --- Top Status Icon Handlers ---
document.getElementById('iconSettings').addEventListener('click', () => {
    document.querySelector('[data-section="settings"]').click();
});

document.getElementById('iconPower').addEventListener('click', () => {
    if(confirm("SYSTEM_SHUTDOWN: Are you sure you want to terminate the uplink?")) {
        sendCommand('SYSTEM_POWER_OFF');
        window.location.href = '/login';
    }
});

document.getElementById('iconWifi').addEventListener('click', () => {
    // Navigate to the wifi section
    document.querySelectorAll('.app-section').forEach(s => s.style.display = 'none');
    const wifiSec = document.getElementById('section-wifi');
    wifiSec.style.display = 'flex';
    refreshWifiStatus();
    addLog("WIFI_MANAGER_OPENED", "SYS");
});

document.getElementById('iconSatellite').addEventListener('click', () => {
    addLog("FETCHING_GPS_COORDINATES...", "SYS");
    sendCommand('GET_GPS');
});

// ── System Logs Panel ─────────────────────────────────────────────────────────
const fullLogList = document.getElementById('fullLogList');
let logsNextIndex = 0;      // tracks highest index fetched so far
let logsInterval = null;

const LOG_TAG_COLORS = {
    BOOT:        '#a4e326',
    CAMERA:      '#38bdf8',
    CAMERA_ERR:  '#f87171',
    HARDWARE:    '#fb923c',
    HARDWARE_ERR:'#f87171',
    DRIVE:       '#a78bfa',
    NETWORK:     '#34d399',
    API:         '#fbbf24',
    TERMINAL:    '#e2e8f0',
    CRITICAL:    '#f87171',
};

function renderLogEntry(entry) {
    const div = document.createElement('div');
    const color = LOG_TAG_COLORS[entry.tag] || '#94a3b8';
    div.style.cssText = 'display:flex;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-family:var(--font-mono);font-size:12px;';
    div.innerHTML =
        `<span style="color:#555;flex-shrink:0;">[${entry.time}]</span>` +
        `<span style="color:${color};font-weight:700;min-width:110px;flex-shrink:0;">[${entry.tag}]</span>` +
        `<span style="color:#ccc;">${entry.msg}</span>`;
    return div;
}

async function fetchNewLogs() {
    try {
        // Always fetch from index 0; server returns {total, entries[since..]}
        // But the server buffer is circular (max 100), so 'total' can reset.
        // We ask for entries since our last known total; if total went backwards
        // (buffer wrapped) we clear the list and start fresh.
        const r = await fetch(`/logs?since=${logsNextIndex}`);
        if (!r.ok) return;
        const data = await r.json();
        if (!data || !Array.isArray(data.entries)) return;

        // Detect buffer wrap-around: total decreased → reset display
        if (data.total < logsNextIndex) {
            fullLogList.innerHTML = '';
            logsNextIndex = 0;
        }

        if (data.entries.length > 0) {
            data.entries.forEach(entry => {
                fullLogList.appendChild(renderLogEntry(entry));
            });
            logsNextIndex = data.total;   // advance cursor to end of known entries
            fullLogList.scrollTop = fullLogList.scrollHeight;
        }
    } catch (err) {
        console.warn('[LOGS] Poll failed:', err.message);
    }
}

function startLogPolling() {
    if (logsInterval) return;
    fetchNewLogs();
    logsInterval = setInterval(fetchNewLogs, 2000);
}

function stopLogPolling() {
    if (logsInterval) { clearInterval(logsInterval); logsInterval = null; }
}

// Start polling immediately so logs accumulate in background
startLogPolling();


// ── Autonomous toggle ──────────────────────────────────────────────────────────
// Autonomous toggle
document.getElementById('btnAutopilotToggle').addEventListener('click', (e) => {
    const active = e.target.innerText === 'START_AUTOPILOT';
    e.target.innerText = active ? 'STOP_AUTOPILOT' : 'START_AUTOPILOT';
    e.target.classList.toggle('btn-arm', !active);
    sendCommand('AUTOPILOT', active ? 'ON' : 'OFF');
});

// ── Camera Toggle ─────────────────────────────────────────────────────────────
console.log('[MAIN.JS] Setting up camera toggle...');
let cameraIsOn = true;   // camera starts ON (stream loads on page load)
let cameraToggleBusy = false; // prevent double-clicks while API is in flight

const btnCam = document.getElementById('btnToggleCamera');
const streamImg = document.getElementById('cameraStream');
const camOverlay = document.getElementById('cameraOffOverlay');
console.log('[MAIN.JS] Camera elements:', {btnCam: !!btnCam, streamImg: !!streamImg, camOverlay: !!camOverlay});

function setCameraUI(on, loading) {
    if (on) {
        btnCam.innerHTML = '<i class="fas fa-video"></i> CAM_ON';
        btnCam.classList.add('btn-arm');
        btnCam.classList.remove('btn-cam-off');
        if (camOverlay) camOverlay.style.display = 'none';
        updateCameraStatus(true);
    } else if (loading) {
        btnCam.innerHTML = '<i class="fas fa-spinner fa-spin"></i> LOADING...';
        btnCam.classList.remove('btn-arm');
        btnCam.classList.remove('btn-cam-off');
        updateCameraStatus('connecting');
    } else {
        btnCam.innerHTML = '<i class="fas fa-video-slash"></i> CAM_OFF';
        btnCam.classList.remove('btn-arm');
        btnCam.classList.add('btn-cam-off');
        if (camOverlay) camOverlay.style.display = 'flex';
        updateCameraStatus(false);
    }
}

if (!btnCam) {
    console.error('[MAIN.JS] ✗ FATAL: btnToggleCamera NOT FOUND — camera toggle disabled');
} else {
    console.log('[MAIN.JS] ✓ Attaching click listener to btnToggleCamera');
    btnCam.addEventListener('click', async () => {
        console.log('[CAM BUTTON CLICKED] cameraIsOn=', cameraIsOn, 'busy=', cameraToggleBusy);
        if (cameraToggleBusy) { console.log('[CAM] Busy, ignoring click'); return; }
        cameraToggleBusy = true;

    try {
        if (cameraIsOn) {
            // ── STOP camera ──────────────────────────────────────────
            setCameraUI(false, true);
            addLog("CAMERA_STOPPING...", "SYS");

            // 1. Clear the stream img immediately so the browser drops the connection
            streamImg.src = '';
            streamImg.style.display = 'none';

            // 2. Tell the JetRacer to release camera hardware
            try {
                const r = await fetch('/camera/stop', { method: 'POST' });
                const d = await r.json();
                addLog("CAMERA_STOPPED: " + JSON.stringify(d), "SYS");
            } catch (err) {
                addLog("CAMERA_STOP_ERR: " + err.message, "ERR");
            }

            cameraIsOn = false;
            setCameraUI(false, false);

        } else {
            // ── START camera ─────────────────────────────────────────
            setCameraUI(false, true);
            addLog("CAMERA_STARTING...", "SYS");

            // 1. Tell the JetRacer to open the camera pipeline (non-blocking, returns immediately)
            try {
                const r = await fetch('/camera/start', { method: 'POST' });
                const d = await r.json();
                addLog("CAMERA_START_RESPONSE: " + JSON.stringify(d), "SYS");
            } catch (err) {
                addLog("CAMERA_START_ERR: " + err.message, "ERR");
                setCameraUI(false, false);
                return;
            }

            // 2. Poll /camera/status every 300ms until running (up to 6s)
            let started = false;
            for (let attempt = 0; attempt < 20; attempt++) {
                await new Promise(res => setTimeout(res, 300));
                try {
                    const sr = await fetch('/camera/status');
                    const sd = await sr.json();
                    if (sd.camera_running === true) {
                        started = true;
                        break;
                    }
                } catch (pollErr) {
                    // transient, keep polling
                }
            }

            if (started) {
                // 3. Connect the MJPEG stream (cache-bust to force fresh connection)
                streamImg.src = '/video_feed?t=' + Date.now();
                streamImg.style.display = 'block';
                cameraIsOn = true;
                setCameraUI(true, false);
                addLog("CAMERA_UPLINK_ESTABLISHED", "SYS");
            } else {
                addLog("CAMERA_FAILED_TO_START — timeout", "ERR");
                setCameraUI(false, false);
            }
        }
    } finally {
        cameraToggleBusy = false;
    }
}); // end btnCam.addEventListener
} // end if(btnCam)

// Camera status indicator helper — updates the FPS HUD box
function updateCameraStatus(state) {
    const fpsBox = document.querySelector('.fps-box');
    if (!fpsBox) return;
    const valEl = fpsBox.querySelector('.value');
    const lblEl = fpsBox.querySelector('.label');
    if (state === true) {
        valEl.innerHTML = '30 <span class="unit">HZ</span>';
        lblEl.textContent = 'FPS_RENDER';
        fpsBox.style.borderColor = 'var(--accent-green)';
    } else if (state === 'connecting') {
        valEl.innerHTML = '-- <span class="unit">HZ</span>';
        lblEl.textContent = 'STARTING...';
        fpsBox.style.borderColor = '#ffaa00';
    } else {
        valEl.innerHTML = '0 <span class="unit">HZ</span>';
        lblEl.textContent = 'CAM_OFFLINE';
        fpsBox.style.borderColor = 'var(--accent-red, #ff4444)';
    }
}

// Mock telemetry update loop
setInterval(() => {
    if (document.getElementById('section-drive').style.display !== 'none') {
        let lat = parseInt(valLatency.innerText) + (Math.random() > 0.5 ? 1 : -1);
        if(lat < 10) lat = 10;
        if(lat > 25) lat = 25;
        valLatency.innerHTML = `${lat} <span class="unit">MS</span>`;
    }
}, 2000);

// --- Embedded SSH Terminal Socket.IO Client ---
const terminalSocket = io('/terminal');
const terminalContainer = document.getElementById('terminalContainer');
const terminalOutput = document.getElementById('terminalOutput');
const terminalInput = document.getElementById('terminalInput');
const terminalStatusDot = document.getElementById('terminalStatusDot');
const terminalStatusText = document.getElementById('terminalStatusText');

// Focus input when clicking anywhere inside the terminal container
if (terminalContainer && terminalInput) {
    terminalContainer.addEventListener('click', () => {
        terminalInput.focus();
    });
}

// Socket event: status
terminalSocket.on('status', (data) => {
    if (!terminalStatusDot || !terminalStatusText) return;
    
    // Reset classes
    terminalStatusDot.className = 'status-dot';
    
    if (data.status === 'connected') {
        terminalStatusDot.classList.add('connected');
        terminalStatusText.innerText = 'CONNECTED';
        terminalStatusText.style.color = 'var(--accent-green)';
    } else if (data.status === 'reconnecting') {
        terminalStatusDot.classList.add('reconnecting');
        terminalStatusText.innerText = 'CONNECTING...';
        terminalStatusText.style.color = '#ffaa00';
    } else {
        terminalStatusDot.classList.add('disconnected');
        terminalStatusText.innerText = 'DISCONNECTED';
        terminalStatusText.style.color = 'var(--accent-red)';
    }
});

// Socket event: output (streams live data from SSH to screen)
terminalSocket.on('output', (data) => {
    if (!terminalOutput || !terminalContainer) return;
    terminalOutput.innerText += data.data;
    
    // Keep scrolled to bottom
    terminalContainer.scrollTop = terminalContainer.scrollHeight;
});

// Socket event: log (adds event logs to main system log feed)
terminalSocket.on('log', (data) => {
    const logType = data.type === 'error' ? 'ERR' : 'SYS';
    addLog(`[SSH] ${data.message}`, logType);
});

// Keypress listener: send command on Enter
if (terminalInput) {
    terminalInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const cmd = terminalInput.value;
            terminalSocket.emit('input', { data: cmd + '\n' });
            terminalInput.value = '';
        }
    });
}

// ── WiFi Manager ──────────────────────────────────────────────────────────────
let _wifiNetworks   = [];
let _wifiSelectedSSID = '';
let _wifiConnecting   = false;

function signalBars(pct) {
    const bars = Math.ceil((pct / 100) * 4);
    const color = pct >= 70 ? '#a4e326' : pct >= 40 ? '#fbbf24' : '#f87171';
    let html = '';
    for (let i = 1; i <= 4; i++) {
        const filled = i <= bars;
        html += `<span style="display:inline-block;width:4px;height:${4+i*3}px;border-radius:1px;background:${filled ? color : '#333'};margin-right:2px;vertical-align:bottom;"></span>`;
    }
    return `<span title="${pct}%">${html}</span> <span style="color:${color};font-size:11px;">${pct}%</span>`;
}

function renderNetwork(net) {
    const isConn = net.connected;
    const statusColor = isConn ? '#a4e326' : '#555';
    const statusText  = isConn ? 'CONNECTED' : 'AVAILABLE';
    const rowStyle = isConn
        ? 'background:rgba(164,227,38,0.05); border-left:3px solid #a4e326;'
        : 'border-left:3px solid transparent;';

    const div = document.createElement('div');
    div.style.cssText = `display:grid; grid-template-columns:1fr 80px 110px 120px 120px; gap:8px; padding:12px 16px; border-bottom:1px solid rgba(255,255,255,0.04); align-items:center; ${rowStyle} transition:background 0.15s;`;
    div.innerHTML = `
        <span style="font-family:var(--font-mono);font-size:12px;font-weight:${isConn?'700':'400'};color:${isConn?'#eee':'#ccc'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${net.ssid}">${net.ssid}</span>
        <span>${signalBars(net.signal)}</span>
        <span style="font-family:var(--font-mono);font-size:10px;color:#94a3b8;">${net.security || 'Open'}</span>
        <span style="font-family:var(--font-mono);font-size:10px;font-weight:700;color:${statusColor};">${statusText}</span>
        <span>${isConn
            ? '<span style="font-family:var(--font-mono);font-size:10px;color:#a4e326;"><i class="fas fa-check-circle"></i> LINKED</span>'
            : `<button onclick="openWifiModal('${net.ssid.replace(/'/g,"\\'")}',${net.security==='Open'?'false':'true'})" style="background:#1a2a0a;border:1px solid #a4e326;color:#a4e326;padding:4px 10px;border-radius:4px;font-family:var(--font-mono);font-size:10px;cursor:pointer;font-weight:700;">CONNECT</button>`
        }</span>`;
    return div;
}

function renderWifiList(networks) {
    const list = document.getElementById('wifiNetworkList');
    const search = (document.getElementById('wifiSearch').value || '').toLowerCase();
    const filtered = networks.filter(n => n.ssid.toLowerCase().includes(search));

    list.innerHTML = '';
    if (filtered.length === 0) {
        list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted);font-family:var(--font-mono);font-size:12px;">No networks found</div>';
        return;
    }
    filtered.forEach(n => list.appendChild(renderNetwork(n)));
}

async function refreshWifiStatus() {
    try {
        const r = await fetch('/wifi/status');
        const d = await r.json();
        const dot  = document.getElementById('wifiStatusDot');
        const ssid = document.getElementById('wifiCurrentSSID');
        const ip   = document.getElementById('wifiCurrentIP');
        const sig  = document.getElementById('wifiCurrentSignal');
        if (d.connected) {
            dot.style.background  = '#a4e326';
            dot.style.boxShadow   = '0 0 6px #a4e326';
            ssid.textContent = d.ssid || 'UNKNOWN';
            ssid.style.color = '#eee';
            ip.textContent   = d.ip || '--';
            sig.textContent  = d.signal + '%';
            
            const hudIP = document.getElementById('hudConnectionIP');
            const hudStatus = document.getElementById('hudConnectionStatus');
            if (hudIP) hudIP.textContent = 'IP: ' + (d.ip || '--');
            if (hudStatus) {
                hudStatus.textContent = 'CONNECTED';
                hudStatus.style.color = 'var(--accent-green)';
            }
        } else {
            dot.style.background = '#f87171';
            dot.style.boxShadow  = 'none';
            ssid.textContent = 'DISCONNECTED';
            ssid.style.color = '#f87171';
            ip.textContent   = '--';
            sig.textContent  = '--%';
            
            const hudIP = document.getElementById('hudConnectionIP');
            const hudStatus = document.getElementById('hudConnectionStatus');
            if (hudIP) hudIP.textContent = 'IP: --';
            if (hudStatus) {
                hudStatus.textContent = 'DISCONNECTED';
                hudStatus.style.color = '#f87171';
            }
        }
    } catch (e) {
        console.warn('[WIFI] Status poll failed:', e.message);
    }
}

async function wifiRefreshScan() {
    if (_wifiConnecting) return;
    const btn  = document.getElementById('btnWifiRefresh');
    const icon = document.getElementById('wifiRefreshIcon');
    const list = document.getElementById('wifiNetworkList');

    btn.disabled = true;
    icon.style.animation = 'spin 1s linear infinite';
    list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted);font-family:var(--font-mono);font-size:12px;"><i class="fas fa-circle-notch fa-spin" style="margin-right:8px;"></i>SCANNING...</div>';

    try {
        const r = await fetch('/wifi/networks');
        _wifiNetworks = await r.json();
        renderWifiList(_wifiNetworks);
        addLog(`WIFI_SCAN: ${_wifiNetworks.length} networks found`, 'SYS');
        refreshWifiStatus();
    } catch (e) {
        list.innerHTML = `<div style="padding:32px;text-align:center;color:#f87171;font-family:var(--font-mono);font-size:12px;">SCAN_FAILED: ${e.message}</div>`;
        addLog('WIFI_SCAN_FAILED: ' + e.message, 'ERR');
    } finally {
        btn.disabled = false;
        icon.style.animation = '';
    }
}

// Add CSS for spinner
const _wifiStyle = document.createElement('style');
_wifiStyle.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(_wifiStyle);

// Search filter
document.getElementById('wifiSearch').addEventListener('input', () => renderWifiList(_wifiNetworks));

// Refresh button
document.getElementById('btnWifiRefresh').addEventListener('click', wifiRefreshScan);

// Modal open/close
window.openWifiModal = function(ssid, needsPassword) {
    _wifiSelectedSSID = ssid;
    document.getElementById('wifiModalSSID').textContent = ssid;
    document.getElementById('wifiPassword').value = '';
    document.getElementById('wifiConnectStatus').innerHTML = '';
    document.getElementById('btnWifiConnect').disabled = false;
    const modal = document.getElementById('wifiModal');
    modal.style.display = 'flex';
    if (needsPassword) document.getElementById('wifiPassword').focus();
};

window.closeWifiModal = function() {
    if (_wifiConnecting) return;
    document.getElementById('wifiModal').style.display = 'none';
};

window.doWifiConnect = async function() {
    if (_wifiConnecting) return;
    const ssid     = _wifiSelectedSSID;
    const password = document.getElementById('wifiPassword').value;
    const statusEl = document.getElementById('wifiConnectStatus');
    const btn      = document.getElementById('btnWifiConnect');

    _wifiConnecting = true;
    btn.disabled = true;
    statusEl.innerHTML = '<span style="color:#fbbf24;"><i class="fas fa-circle-notch fa-spin"></i> CONNECTING...</span>';

    try {
        const r = await fetch('/wifi/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ssid, password }),
        });
        const d = await r.json();

        if (d.status === 'connected') {
            statusEl.innerHTML = '<span style="color:#a4e326;"><i class="fas fa-check-circle"></i> CONNECTED ✓</span>';
            addLog(`WIFI_CONNECTED: ${ssid}`, 'SYS');
            setTimeout(() => {
                window.closeWifiModal();
                wifiRefreshScan();
            }, 1500);
        } else {
            const msg = (d.message || 'Connection failed').split('\n')[0].substring(0, 80);
            statusEl.innerHTML = `<span style="color:#f87171;"><i class="fas fa-times-circle"></i> FAILED: ${msg}</span>`;
            addLog(`WIFI_FAILED: ${ssid} — ${msg}`, 'ERR');
            btn.disabled = false;
        }
    } catch (e) {
        statusEl.innerHTML = `<span style="color:#f87171;"><i class="fas fa-times-circle"></i> NETWORK_ERROR: ${e.message}</span>`;
        addLog('WIFI_CONNECT_ERROR: ' + e.message, 'ERR');
        btn.disabled = false;
    } finally {
        _wifiConnecting = false;
    }
};

// Allow Enter key in password field
document.getElementById('wifiPassword').addEventListener('keydown', e => {
    if (e.key === 'Enter') window.doWifiConnect();
});

// ── Gallery & Capture ──────────────────────────────────────────────────────────

async function captureFrame() {
    addLog('Requesting frame capture...', 'SYS');
    try {
        const response = await fetch('/capture-frame', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            addLog(`FRAME_CAPTURED: ${data.filename}`, 'SYS');
            loadGallery();
        } else {
            addLog(`CAPTURE_FAILED: ${data.error}`, 'ERR');
        }
    } catch (err) {
        addLog(`CAPTURE_ERR: ${err.message}`, 'ERR');
    }
}

const btnCapture = document.getElementById('btnCapture');
if (btnCapture) btnCapture.addEventListener('click', captureFrame);

async function loadGallery() {
    const grid = document.getElementById('gallery-grid');
    if (!grid) return;
    try {
        const response = await fetch('/gallery');
        const files = await response.json();
        
        grid.innerHTML = '';
        if (files.length === 0) {
            grid.innerHTML = '<div class="hud-box" style="aspect-ratio: 16/9; background: #000; border: 1px dashed #444; display: flex; align-items: center; justify-content: center; color: #444;">EMPTY_GALLERY</div>';
            return;
        }
        
        files.forEach(file => {
            const div = document.createElement('div');
            div.className = 'hud-box';
            div.style.cssText = 'aspect-ratio: 16/9; padding:0; overflow:hidden; position:relative; cursor:pointer; border:1px solid #333;';
            div.onclick = () => openGalleryModal(file.filename);
            
            const img = document.createElement('img');
            img.src = `/gallery/${file.filename}`;
            img.style.cssText = 'width:100%; height:100%; object-fit:cover; display:block;';
            
            const label = document.createElement('div');
            label.style.cssText = 'position:absolute; bottom:0; left:0; width:100%; background:rgba(0,0,0,0.8); padding:6px; font-family:var(--font-mono); font-size:9px; color:#eee; text-align:center; border-top:1px solid #444;';
            label.textContent = file.filename;
            
            div.appendChild(img);
            div.appendChild(label);
            grid.appendChild(div);
        });
    } catch (err) {
        console.error('Failed to load gallery', err);
    }
}

let _currentGalleryFile = null;

function openGalleryModal(filename) {
    _currentGalleryFile = filename;
    document.getElementById('galleryModalTitle').textContent = filename;
    document.getElementById('galleryModalImage').src = `/gallery/${filename}`;
    document.getElementById('galleryModal').style.display = 'flex';
}

document.getElementById('btnGalleryDownload').addEventListener('click', () => {
    if (!_currentGalleryFile) return;
    const a = document.createElement('a');
    a.href = `/gallery/${_currentGalleryFile}`;
    a.download = _currentGalleryFile;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
});

document.getElementById('btnGalleryDelete').addEventListener('click', async () => {
    if (!_currentGalleryFile) return;
    if (!confirm(`Delete ${_currentGalleryFile}?`)) return;
    
    try {
        const r = await fetch(`/gallery/${_currentGalleryFile}`, { method: 'DELETE' });
        const d = await r.json();
        if (d.success) {
            addLog(`DELETED: ${_currentGalleryFile}`, 'SYS');
            document.getElementById('galleryModal').style.display = 'none';
            loadGallery();
        } else {
            addLog(`DELETE_FAILED: ${d.error}`, 'ERR');
        }
    } catch (e) {
        addLog(`DELETE_ERR: ${e.message}`, 'ERR');
    }
});

// Load gallery when clicking gallery section
const navLinksGallery = document.querySelectorAll('nav a');
navLinksGallery.forEach(link => {
    link.addEventListener('click', (e) => {
        if (link.dataset.section === 'gallery') {
            loadGallery();
        }
    });
});