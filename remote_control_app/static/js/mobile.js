/**
 * JETRACER MOBILE COMMAND — JavaScript
 * Real-time mobile controller for JetRacer RC vehicle.
 *
 * Architecture:
 *  - State machine: CONNECT → CONTROLLER
 *  - Joystick: Canvas-based proportional analog control
 *  - Commands: REST API (/command, /drive) via fetch
 *  - Telemetry: Polling /status every 2 s
 *  - Camera: MJPEG stream via <img> proxy (/video_feed)
 *  - Settings: Local state with live send
 */

'use strict';

// Intercept all fetch requests to automatically append target IP query parameter and header
(function() {
    const originalFetch = window.fetch;
    window.fetch = async function(url, options = {}) {
        if (typeof url === 'string' && typeof State !== 'undefined' && State.ip) {
            // Avoid adding header or query param if it's external
            if (url.startsWith('/') || !url.includes('://')) {
                options.headers = options.headers || {};
                if (options.headers instanceof Headers) {
                    options.headers.set('X-Target-IP', State.ip);
                } else {
                    options.headers['X-Target-IP'] = State.ip;
                }
                
                // Add query parameter to the URL
                const separator = url.includes('?') ? '&' : '?';
                if (!url.includes('ip=')) {
                    url = `${url}${separator}ip=${encodeURIComponent(State.ip)}`;
                }
            }
        }
        return originalFetch(url, options);
    };
})();

console.log('[MOBILE.JS] ✓ JetRacer Mobile Command loaded');

/* ══════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════ */
const State = {
    ip: '',
    connected: false,
    connecting: false,
    demoMode: false,          // ← demo mode flag
    cameraOn: false,
    cameraBusy: false,
    autoReconnect: true,
    autoStop: true,
    driveMode: 'Normal',
    steeringGain: 1.66,       // persisted from server
    steeringOffset: 0.43,     // persisted from server
    steeringSensitivity: 100,
    mirrorCamera: false,
    wsUpdateRate: 100,      // ms
    debugMode: false,
    autopilotActive: false,
    lastLatency: 0,
    reconnectAttempts: 0,
    reconnectTimer: null,
    telemetryInterval: null,
    joystickActive: false,
    currentDir: null,
    currentX: 0,
    currentY: 0,
};

/* ══════════════════════════════════════════════════════════
   SCREEN SWITCHING
══════════════════════════════════════════════════════════ */
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => {
        if (s.id === id) {
            s.classList.add('active');
            s.classList.remove('exiting');
        } else if (s.classList.contains('active')) {
            s.classList.add('exiting');
            s.classList.remove('active');
            setTimeout(() => s.classList.remove('exiting'), 400);
        }
    });
}

/* ══════════════════════════════════════════════════════════
   TOAST NOTIFICATIONS
══════════════════════════════════════════════════════════ */
function toast(msg, type = 'info', duration = 2800) {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icons = { success: 'check-circle', error: 'times-circle', info: 'info-circle', warning: 'exclamation-triangle' };
    el.innerHTML = `<i class="fas fa-${icons[type] || 'info-circle'}"></i><span>${msg}</span>`;
    container.appendChild(el);

    const remove = () => {
        el.classList.add('fadeout');
        setTimeout(() => el.remove(), 350);
    };
    const t = setTimeout(remove, duration);
    el.addEventListener('click', () => { clearTimeout(t); remove(); });
}

/* ══════════════════════════════════════════════════════════
   LOG HELPER (bottom status bar)
══════════════════════════════════════════════════════════ */
function mobileLog(msg) {
    const el = document.getElementById('sbLastLog');
    if (el) el.textContent = msg;
    if (State.debugMode) console.log('[LOG]', msg);
}

/* ══════════════════════════════════════════════════════════
   CONNECT SCREEN LOGIC
══════════════════════════════════════════════════════════ */
const connectIpInput   = document.getElementById('connectIpInput');
const connectIndicator = document.getElementById('connectIndicator');
const connectStatusEl  = document.getElementById('connectStatus');
const btnConnect       = document.getElementById('btnConnect');

// Pre-fill from session IP if available
if (connectIpInput && connectIpInput.value) {
    State.ip = connectIpInput.value;
}

connectIpInput.addEventListener('input', () => {
    connectIndicator.className = 'input-indicator';
    connectStatusEl.textContent = '';
    connectStatusEl.className = 'connect-status-msg';
});

async function initiateConnection() {
    const ip = connectIpInput.value.trim();
    if (!ip) {
        connectStatusEl.textContent = '⚠ Enter a valid IP address';
        connectStatusEl.className = 'connect-status-msg error';
        return;
    }

    State.ip = ip;
    State.connecting = true;
    btnConnect.disabled = true;
    connectIndicator.className = 'input-indicator pinging';
    connectStatusEl.textContent = 'Probing uplink…';
    connectStatusEl.className = 'connect-status-msg';

    try {
        // Try to reach the proxy ping endpoint
        const t0 = performance.now();
        const res = await fetch(`/ping_jetracer?ip=${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();

        const elapsed = Math.round(performance.now() - t0);

        if (data.reachable) {
            connectIndicator.className = 'input-indicator ok';
            connectStatusEl.textContent = `✓ Uplink established — ${elapsed} ms`;
            connectStatusEl.className = 'connect-status-msg success';
            State.connected = true;
            State.lastLatency = elapsed;
            State.reconnectAttempts = 0;

            // Save IP to server session — use /set_ip which returns JSON
            // (avoids mobile browser cookie issues with redirect-based /login)
            await fetch('/set_ip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `ip_address=${encodeURIComponent(ip)}`
            });

            // Save IP persistently in localStorage to survive browser/session restarts
            localStorage.setItem('jetracer_ip', ip);

            setTimeout(() => transitionToController(), 500);
        } else {
            throw new Error(data.error || 'No response from vehicle');
        }
    } catch (err) {
        connectIndicator.className = 'input-indicator err';
        connectStatusEl.textContent = `✗ ${err.message}`;
        connectStatusEl.className = 'connect-status-msg error';
        btnConnect.disabled = false;
        State.connecting = false;
    }
}

function transitionToController() {
    showScreen('screenController');
    initCamera();
    startTelemetryPolling();
    updateConnectionUI(true);
    updateHudIp(State.ip);
    document.getElementById('settingIp').value = State.ip;
    mobileLog('UPLINK ESTABLISHED TO ' + State.ip);
    toast('Connected to ' + State.ip, 'success');
    // Init joystick after transition (DOM is visible)
    requestAnimationFrame(() => initJoystick());
}

/* ══════════════════════════════════════════════════════════
   DEMO MODE — explore UI without a real device
══════════════════════════════════════════════════════════ */
window.enterDemoMode = function() {
    State.demoMode = true;
    State.connected = true;   // treat as connected so joystick, settings all work
    State.ip = 'DEMO';

    showScreen('screenController');
    document.getElementById('demoBanner').style.display = 'flex';
    document.getElementById('settingIp').value = 'DEMO MODE';
    updateConnectionUI(true);
    updateHudIp('DEMO MODE');
    mobileLog('DEMO MODE — no vehicle connected');
    toast('Demo mode active — controls are simulated', 'info', 3500);

    // Seed fake telemetry immediately
    _applyDemoTelemetry();
    // Start simulated telemetry loop
    State.telemetryInterval = setInterval(_applyDemoTelemetry, 2000);

    requestAnimationFrame(() => initJoystick());
};

window.exitDemoMode = function() {
    State.demoMode = false;
    State.connected = false;
    stopTelemetryPolling();
    document.getElementById('demoBanner').style.display = 'none';
    updateConnectionUI(false);
    showScreen('screenConnect');
    mobileLog('SYSTEM READY');
};

let _demoLogs = [
    { time: new Date().toLocaleTimeString('en-US', { hour12: false }), tag: 'BOOT', msg: 'Simulating JetRacer Mobile Command...' },
    { time: new Date().toLocaleTimeString('en-US', { hour12: false }), tag: 'HARDWARE', msg: 'Hardware layer: SIMULATED (Demo Mode)' },
    { time: new Date().toLocaleTimeString('en-US', { hour12: false }), tag: 'CAMERA', msg: 'Camera feed offline: DEMO PATTERN ACTIVE' }
];

function _applyDemoTelemetry() {
    // Randomised fake sensor readings
    const bat  = 75 + Math.round((Math.random() - 0.5) * 6);
    const temp = 42 + Math.round((Math.random() - 0.5) * 4);
    const ram  = (2.4 + (Math.random() - 0.5) * 0.4).toFixed(1);
    const wifi = 82 + Math.round((Math.random() - 0.5) * 10);
    const ping = 12 + Math.round(Math.random() * 8);

    setEl('hudBattery', bat + '');
    setEl('hudLatency', ping + '');
    setEl('telemBattery', bat + '%');
    setEl('telemTemp', temp + '°C');
    setEl('telemRam', ram + ' GB');
    setEl('telemWifi', wifi + '%');
    setEl('telemLatency', ping + ' ms');
    setEl('telemSys', 'OK');
    setEl('sbTemp', temp + '°C');
    setEl('sbRam', ram + ' GB');
    setEl('statCpu', temp + '°');
    setEl('statSys', 'OK');
    setEl('sbLastLog', `DEMO  BAT:${bat}%  TEMP:${temp}°  PING:${ping}ms`);
    State.lastLatency = ping;

    const battIcon = document.getElementById('hudBattIcon');
    if (battIcon) battIcon.style.color = 'var(--accent-green)';
    const wifiIcon = document.getElementById('hudWifiIcon');
    if (wifiIcon) wifiIcon.style.color = 'var(--accent-green)';

    // Periodically add new random logs to demo logs
    if (Math.random() > 0.6) {
        const tags = ['DRIVE', 'API', 'NETWORK', 'SYSTEM'];
        const msgs = {
            DRIVE: ['Throttle adjusted to 40%', 'Steering trim updated', 'Speed limit set to 50%'],
            API: ['Uplink package verified', 'GET /status request processed', 'POST /drive acknowledged'],
            NETWORK: ['Latency check: 14ms', 'WiFi signal stable', 'Ping response received'],
            SYSTEM: ['CPU load normal', 'Memory footprint checked', 'System health nominal']
        };
        const tag = tags[Math.floor(Math.random() * tags.length)];
        const list = msgs[tag];
        const msg = list[Math.floor(Math.random() * list.length)];
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        _demoLogs.push({ time, tag, msg });
        if (_demoLogs.length > 25) _demoLogs.shift();
    }

    // Render demo logs
    const logList = document.getElementById('mobileLogList');
    if (logList) {
        logList.innerHTML = _demoLogs.map(entry => {
            const color = LOG_TAG_COLORS[entry.tag] || '#94a3b8';
            return `<div style="margin-bottom: 4px; line-height: 1.4; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 4px;">` +
                   `<span style="color: #555; font-size: 9px;">[${entry.time}]</span> ` +
                   `<span style="color: ${color}; font-weight: bold; font-size: 9px;">[${entry.tag}]</span> ` +
                   `<span style="color: #ccc; font-size: 10px;">${entry.msg}</span>` +
                   `</div>`;
        }).join('');
        logList.scrollTop = logList.scrollHeight;
    }
}

/* ══════════════════════════════════════════════════════════
   CAMERA
══════════════════════════════════════════════════════════ */
const streamImg      = document.getElementById('mobileStream');
const camOffOverlay  = document.getElementById('cameraOffOverlay');
const camToggleIcon  = document.getElementById('camToggleIcon');
const btnCamToggle   = document.getElementById('btnCamToggle');

function initCamera() {
    loadStream();
}

function loadStream() {
    const ipParam = State.ip ? `&ip=${encodeURIComponent(State.ip)}` : '';
    streamImg.src = `/video_feed?t=${Date.now()}${ipParam}`;
    streamImg.style.display = 'block';
    State.cameraOn = true;
    setCameraUI(true);
}

window.handleStreamError = function() {
    if (!State.cameraOn) return;
    setCameraUI(false);
};

function setCameraUI(on, loading = false) {
    if (on) {
        camOffOverlay.classList.remove('visible');
        camToggleIcon.className = 'fas fa-video';
        btnCamToggle.className = 'btn-icon-sm btn-cam-toggle cam-on';
        document.getElementById('camSettingIcon').className = 'fas fa-video';
        document.getElementById('camSettingLabel').textContent = 'CAMERA ON';
    } else if (loading) {
        camToggleIcon.className = 'fas fa-spinner fa-spin';
        btnCamToggle.className = 'btn-icon-sm btn-cam-toggle';
    } else {
        camOffOverlay.classList.add('visible');
        streamImg.src = '';
        streamImg.style.display = 'none';
        camToggleIcon.className = 'fas fa-video-slash';
        btnCamToggle.className = 'btn-icon-sm btn-cam-toggle cam-off';
        document.getElementById('camSettingIcon').className = 'fas fa-video-slash';
        document.getElementById('camSettingLabel').textContent = 'CAMERA OFF';
    }
}

window.toggleCamera = async function() {
    if (State.cameraBusy) return;
    State.cameraBusy = true;

    try {
        if (State.cameraOn) {
            // Stop camera
            setCameraUI(false, true);
            mobileLog('STOPPING CAMERA…');
            streamImg.src = '';
            streamImg.style.display = 'none';
            try {
                await fetch('/camera/stop', { method: 'POST', signal: AbortSignal.timeout(4000) });
            } catch (_) {}
            State.cameraOn = false;
            setCameraUI(false);
            mobileLog('CAMERA OFFLINE');
            toast('Camera offline', 'info');
        } else {
            // Start camera
            setCameraUI(false, true);
            mobileLog('STARTING CAMERA…');
            try {
                await fetch('/camera/start', { method: 'POST', signal: AbortSignal.timeout(4000) });
            } catch (e) {
                setCameraUI(false);
                State.cameraBusy = false;
                toast('Camera start failed', 'error');
                return;
            }
            // Poll for ready
            let started = false;
            for (let i = 0; i < 20; i++) {
                await delay(300);
                try {
                    const sr = await fetch('/camera/status', { signal: AbortSignal.timeout(2000) });
                    const sd = await sr.json();
                    if (sd.camera_running) { started = true; break; }
                } catch (_) {}
            }
            if (started) {
                streamImg.src = `/video_feed?t=${Date.now()}`;
                streamImg.style.display = 'block';
                State.cameraOn = true;
                setCameraUI(true);
                mobileLog('CAMERA UPLINK ESTABLISHED');
                toast('Camera online', 'success');
            } else {
                setCameraUI(false);
                toast('Camera failed to start', 'error');
            }
        }
    } finally {
        State.cameraBusy = false;
    }
};

window.toggleFullscreen = function() {
    const el = document.getElementById('cameraSection');
    if (!document.fullscreenElement) {
        (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen).call(el);
        document.getElementById('btnFullscreen').querySelector('i').className = 'fas fa-compress';
    } else {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        document.getElementById('btnFullscreen').querySelector('i').className = 'fas fa-expand';
    }
};

// Mirror toggle
document.getElementById('settingMirror').addEventListener('change', function() {
    State.mirrorCamera = this.checked;
    streamImg.classList.toggle('mirrored', State.mirrorCamera);
});

/* ══════════════════════════════════════════════════════════
   JOYSTICK (Canvas-based proportional analog)
══════════════════════════════════════════════════════════ */
const joystickCanvas  = document.getElementById('mobileJoystick');
const joystickCtx     = joystickCanvas.getContext('2d');
const joystickCoords  = document.getElementById('joystickCoords');

let jsCenterX = 0, jsCenterY = 0, jsRadius = 0;
let jsStickX = 0, jsStickY = 0;
let jsDragging = false;
let jsSendInterval = null;

function initJoystick() {
    resizeJoystick();
    drawJoystick();
    window.addEventListener('resize', resizeJoystick);
}

function resizeJoystick() {
    // Make canvas fill its CSS size
    const dpr = window.devicePixelRatio || 1;
    const rect = joystickCanvas.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height);
    joystickCanvas.width  = size * dpr;
    joystickCanvas.height = size * dpr;
    joystickCtx.scale(dpr, dpr);
    jsCenterX = size / 2;
    jsCenterY = size / 2;
    jsRadius  = size / 2 - 16;
    jsStickX  = jsCenterX;
    jsStickY  = jsCenterY;
    drawJoystick();
}

function drawJoystick() {
    const ctx = joystickCtx;
    const w   = jsCenterX * 2;
    const h   = jsCenterY * 2;
    ctx.clearRect(0, 0, w, h);

    // Outer ring
    ctx.beginPath();
    ctx.arc(jsCenterX, jsCenterY, jsRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    ctx.fill();

    // Inner dead-zone indicator
    ctx.beginPath();
    ctx.arc(jsCenterX, jsCenterY, jsRadius * 0.18, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Cross hair
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    const half = jsRadius * 0.6;
    ctx.beginPath();
    ctx.moveTo(jsCenterX - half, jsCenterY);
    ctx.lineTo(jsCenterX + half, jsCenterY);
    ctx.moveTo(jsCenterX, jsCenterY - half);
    ctx.lineTo(jsCenterX, jsCenterY + half);
    ctx.stroke();
    ctx.restore();

    // Stick glow
    if (jsDragging) {
        const dist = Math.hypot(jsStickX - jsCenterX, jsStickY - jsCenterY);
        const intensity = Math.min(dist / jsRadius, 1);
        const grad = ctx.createRadialGradient(jsStickX, jsStickY, 0, jsStickX, jsStickY, 36);
        grad.addColorStop(0, `rgba(164,227,38,${0.15 * intensity})`);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(jsStickX, jsStickY, 36, 0, Math.PI * 2);
        ctx.fill();
    }

    // Stick knob
    const knobR = jsDragging ? 24 : 22;
    ctx.save();
    ctx.shadowBlur = jsDragging ? 20 : 10;
    ctx.shadowColor = 'rgba(164,227,38,0.5)';
    ctx.beginPath();
    ctx.arc(jsStickX, jsStickY, knobR, 0, Math.PI * 2);
    ctx.fillStyle = '#a4e326';
    ctx.fill();
    ctx.restore();

    // Knob center dot
    ctx.beginPath();
    ctx.arc(jsStickX, jsStickY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();

    // Knob tick marks
    ctx.save();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    const ticks = [
        [jsStickX - 10, jsStickY, jsStickX - 16, jsStickY],
        [jsStickX + 10, jsStickY, jsStickX + 16, jsStickY],
        [jsStickX, jsStickY - 10, jsStickX, jsStickY - 16],
        [jsStickX, jsStickY + 10, jsStickX, jsStickY + 16],
    ];
    ticks.forEach(([x1,y1,x2,y2]) => {
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    });
    ctx.restore();
}

function getClientXY(e) {
    if (e.touches && e.touches.length > 0) {
        return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
}

function handleJoystickStart(e) {
    e.preventDefault();
    jsDragging = true;
    State.joystickActive = true;
    handleJoystickMove(e);
    // Start rapid-send loop
    if (!jsSendInterval) {
        jsSendInterval = setInterval(sendAnalog, State.wsUpdateRate);
    }
}

function handleJoystickMove(e) {
    if (!jsDragging) return;
    e.preventDefault();
    const rect = joystickCanvas.getBoundingClientRect();
    const { x, y } = getClientXY(e);
    let dx = x - rect.left - jsCenterX;
    let dy = y - rect.top  - jsCenterY;
    const dist = Math.hypot(dx, dy);
    if (dist > jsRadius) {
        dx = dx * (jsRadius / dist);
        dy = dy * (jsRadius / dist);
    }
    jsStickX = jsCenterX + dx;
    jsStickY = jsCenterY + dy;

    // Normalise -1..+1 with deadzone
    const normX = dx / jsRadius;
    const normY = dy / jsRadius;
    const dead  = 0.08;
    const applyDead = v => Math.abs(v) < dead ? 0 : (v - Math.sign(v) * dead) / (1 - dead);
    State.currentX = applyDead(normX);
    State.currentY = applyDead(normY);

    // Coords display
    if (joystickCoords) {
        joystickCoords.textContent =
            `X:${(State.currentX * 100).toFixed(0)} Y:${(State.currentY * 100).toFixed(0)}`;
    }

    drawJoystick();
}

function handleJoystickEnd(e) {
    if (!jsDragging) return;
    jsDragging = false;
    State.joystickActive = false;
    jsStickX = jsCenterX;
    jsStickY = jsCenterY;
    State.currentX = 0;
    State.currentY = 0;
    if (joystickCoords) joystickCoords.textContent = 'X:0 Y:0';
    drawJoystick();

    // Stop send loop and send a final STOP
    if (jsSendInterval) { clearInterval(jsSendInterval); jsSendInterval = null; }
    sendStopCommand();
    document.getElementById('mobileSpeed').classList.remove('moving');
    document.getElementById('mobileSpeed').textContent = '0.0';
}

// Attach listeners
joystickCanvas.addEventListener('touchstart', handleJoystickStart, { passive: false });
joystickCanvas.addEventListener('mousedown',  handleJoystickStart);

window.addEventListener('touchmove', (e) => { if (jsDragging) handleJoystickMove(e); }, { passive: false });
window.addEventListener('mousemove', handleJoystickMove);
window.addEventListener('touchend', handleJoystickEnd);
window.addEventListener('mouseup',  handleJoystickEnd);

/* ══════════════════════════════════════════════════════════
   COMMAND SENDING
══════════════════════════════════════════════════════════ */
async function sendCommand(cmd, value = null) {
    const commandStr = value !== null ? `${cmd}_${value}` : cmd;
    if (State.demoMode) { mobileLog('[DEMO] ' + commandStr); return { status: 'ok' }; }
    try {
        const fd = new FormData();
        fd.append('cmd', commandStr);
        const t0 = performance.now();
        const res = await fetch('/command', {
            method: 'POST',
            body: fd,
            signal: AbortSignal.timeout(1500)
        });
        const elapsed = Math.round(performance.now() - t0);
        updateLatency(elapsed);
        const data = await res.json();
        if (data.status !== 'ok') mobileLog('CMD ERR: ' + commandStr);
        else mobileLog(commandStr);
        return data;
    } catch (err) {
        if (State.debugMode) console.warn('[CMD]', commandStr, err.message);
        return null;
    }
}

// Analog drive via /drive endpoint (lower latency, float precision)
async function sendAnalog() {
    if (!State.connected) return;
    // Map joystick Y → throttle (raw), X → steering (raw * sensitivity only).
    // Gain and offset calibration is applied by the JetRacer library on the vehicle
    // (car.steering_gain / car.steering_offset set by jetracer_server.py drive_loop).
    const throttle = -State.currentY;
    const sensitivity = State.steeringSensitivity / 100;
    const steering = State.currentX * sensitivity;   // raw, no gain/offset here

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const t = clamp(throttle, -1, 1);
    const s = clamp(steering, -1, 1);

    // Update speed display (works in demo mode too)
    const speedVal = Math.abs(t) * 1.2;
    const speedEl = document.getElementById('mobileSpeed');
    if (speedEl) {
        speedEl.textContent = speedVal.toFixed(1);
        speedEl.classList.toggle('moving', speedVal > 0.05);
    }

    if (State.demoMode) return;   // ← skip real network call in demo
    try {
        const fd = new FormData();
        fd.append('x', s.toFixed(3));
        fd.append('steering', s.toFixed(3));
        fd.append('throttle', t.toFixed(3));
        await fetch('/drive', {
            method: 'POST',
            body: fd,
            signal: AbortSignal.timeout(500)
        });
    } catch (_) {}
}

async function sendStopCommand() {
    if (!State.connected || State.demoMode) return;
    try {
        const fd = new FormData();
        fd.append('throttle', '0');
        fd.append('steering', '0');
        await fetch('/drive', { method: 'POST', body: fd, signal: AbortSignal.timeout(1000) });
    } catch (_) {}
    sendCommand('MOVE', 'STOP');
}

/* ══════════════════════════════════════════════════════════
   EMERGENCY STOP
══════════════════════════════════════════════════════════ */
window.emergencyStop = async function() {
    // Visual flash
    const flash = document.getElementById('estopFlash');
    flash.classList.remove('active');
    void flash.offsetWidth; // reflow
    flash.classList.add('active');
    setTimeout(() => flash.classList.remove('active'), 600);

    // Vibration feedback
    if (navigator.vibrate) navigator.vibrate([80, 30, 80]);

    // Stop all movement immediately
    jsStickX = jsCenterX;
    jsStickY = jsCenterY;
    State.currentX = 0;
    State.currentY = 0;
    if (jsSendInterval) { clearInterval(jsSendInterval); jsSendInterval = null; }
    jsDragging = false;
    drawJoystick();

    toast('E-STOP TRIGGERED', 'error', 2000);
    mobileLog('EMERGENCY STOP');

    try {
        const fd = new FormData();
        fd.append('throttle', '0');
        fd.append('steering', '0');
        await fetch('/drive', { method: 'POST', body: fd, signal: AbortSignal.timeout(800) });
    } catch (_) {}
    sendCommand('ENGINE_STOP');
};

/* ══════════════════════════════════════════════════════════
   TELEMETRY POLLING
══════════════════════════════════════════════════════════ */
function startTelemetryPolling() {
    if (State.telemetryInterval) clearInterval(State.telemetryInterval);
    State.telemetryInterval = setInterval(pollTelemetry, 2000);
    pollTelemetry(); // immediate
}

function stopTelemetryPolling() {
    if (State.telemetryInterval) {
        clearInterval(State.telemetryInterval);
        State.telemetryInterval = null;
    }
}

/* ── Auto-Reconnect ─────────────────────────────────────────
   Attempts to re-ping JetRacer and restore the server session.
   Called by the exponential backoff timer or visibilitychange.
──────────────────────────────────────────────────────────── */
let _reconnectBackoffTimer = null;

async function attemptReconnect() {
    if (!State.ip || State.demoMode) return;
    if (State.connected) return;  // already reconnected by another path

    try {
        const res = await fetch(
            `/ping_jetracer?ip=${encodeURIComponent(State.ip)}`,
            { signal: AbortSignal.timeout(5000) }
        );
        const data = await res.json();

        if (data.reachable) {
            // Re-save IP to server session so /command and /drive work again
            await fetch('/set_ip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `ip_address=${encodeURIComponent(State.ip)}`
            });

            // Reset state
            State.connected = true;
            State.reconnectAttempts = 0;
            _reconnectBackoffTimer = null;

            updateConnectionUI(true);
            mobileLog('AUTO-RECONNECTED TO ' + State.ip);
            toast('Reconnected to ' + State.ip + ' ✓', 'success', 3000);

            // Restart telemetry polling
            startTelemetryPolling();
        } else {
            scheduleNextReconnect();
        }
    } catch (err) {
        scheduleNextReconnect();
    }
}

function scheduleNextReconnect() {
    if (!State.autoReconnect || State.demoMode) return;
    if (_reconnectBackoffTimer) return;  // already scheduled

    // Exponential backoff: 2s, 4s, 8s, 15s cap — NEVER gives up
    const attempt = State.reconnectAttempts;
    const delayMs = Math.min(2000 * Math.pow(1.5, attempt), 15000);

    mobileLog(`RECONNECT IN ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1})…`);

    _reconnectBackoffTimer = setTimeout(() => {
        _reconnectBackoffTimer = null;
        State.reconnectAttempts++;
        attemptReconnect();
    }, delayMs);
}

async function pollTelemetry() {
    if (!State.connected) return;
    try {
        const t0 = performance.now();
        const res = await fetch('/status', { signal: AbortSignal.timeout(3000) });
        const elapsed = Math.round(performance.now() - t0);
        updateLatency(elapsed);
        const data = await res.json();

        // Reset reconnect counter on any successful poll
        State.reconnectAttempts = 0;
        applyTelemetry(data);

    } catch (err) {
        if (State.debugMode) console.warn('[TELEM] poll failed:', err.message);
        if (!State.connected) return;

        // Mark as disconnected and start reconnect cycle
        State.connected = false;
        stopTelemetryPolling();
        updateConnectionUI(false, 'reconnecting');
        mobileLog('UPLINK LOST — starting auto-reconnect…');

        if (State.autoStop) sendStopCommand();

        if (State.autoReconnect) {
            State.reconnectAttempts = 0;
            scheduleNextReconnect();
        } else {
            updateConnectionUI(false);
            mobileLog('AUTO-RECONNECT DISABLED — manual reconnect required');
        }
    }
}

/* ── Reconnect on phone unlock / tab becoming visible ──────────
   When the user locks the screen or switches apps, the browser
   suspends JS. On return, fire an immediate reconnect attempt
   instead of waiting for the backoff timer.
────────────────────────────────────────────────────────────── */
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!State.connected && State.ip && State.autoReconnect && !State.demoMode) {
        // Cancel any pending backoff timer and reconnect immediately
        if (_reconnectBackoffTimer) {
            clearTimeout(_reconnectBackoffTimer);
            _reconnectBackoffTimer = null;
        }
        mobileLog('APP RESUMED — attempting immediate reconnect…');
        attemptReconnect();
    }
});

/* ── Reconnect when WiFi comes back online ────────────────── */
window.addEventListener('online', () => {
    if (!State.connected && State.ip && State.autoReconnect && !State.demoMode) {
        if (_reconnectBackoffTimer) {
            clearTimeout(_reconnectBackoffTimer);
            _reconnectBackoffTimer = null;
        }
        mobileLog('NETWORK RESTORED — attempting reconnect…');
        attemptReconnect();
    }
});


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

function applyTelemetry(data) {
    if (!data || data.status === 'disconnected') {
        updateConnectionUI(false);
        return;
    }

    State.reconnectAttempts = 0;
    updateConnectionUI(true);

    // Battery
    const bat = data.battery || data.battery_percent;
    if (bat !== undefined) {
        const b = Math.round(bat);
        setEl('hudBattery', b + '');
        setEl('telemBattery', b + '%');
        setEl('sbLastLog', 'BAT: ' + b + '%  LATENCY: ' + State.lastLatency + 'ms');
        // Icon color
        const icon = document.getElementById('hudBattIcon');
        if (icon) {
            icon.style.color = b > 50 ? 'var(--accent-green)' : b > 20 ? 'var(--accent-orange)' : 'var(--accent-red)';
        }
    }

    // CPU temp
    const temp = data.cpu_temp || data.temperature;
    if (temp !== undefined) {
        setEl('sbTemp', Math.round(temp) + '°C');
        setEl('telemTemp', Math.round(temp) + '°C');
        setEl('statCpu', Math.round(temp) + '°');
    }

    // RAM
    const ram = data.ram_used || data.ram;
    if (ram !== undefined) {
        const r = typeof ram === 'number' ? ram.toFixed(1) + ' GB' : ram;
        setEl('sbRam', r);
        setEl('telemRam', r);
    }

    // WiFi
    const wifi = data.wifi_strength || data.wifi;
    if (wifi !== undefined) {
        setEl('telemWifi', Math.round(wifi) + '%');
        const wi = document.getElementById('hudWifiIcon');
        if (wi) wi.style.color = wifi > 60 ? 'var(--accent-green)' : wifi > 30 ? 'var(--accent-orange)' : 'var(--accent-red)';
    }

    // System status
    const sys = data.system_status || data.status || 'OK';
    setEl('statSys', typeof sys === 'string' ? sys.toUpperCase() : 'OK');
    setEl('telemSys', typeof sys === 'string' ? sys.toUpperCase() : 'OK');

    // Autopilot sync
    if (data.autopilot !== undefined) {
        State.autopilotActive = data.autopilot;
        const checkbox = document.getElementById('settingAutopilot');
        if (checkbox) {
            checkbox.checked = data.autopilot;
        }
    }

    // Update logs inside settings drawer
    if (data.logs && Array.isArray(data.logs)) {
        const logList = document.getElementById('mobileLogList');
        if (logList) {
            logList.innerHTML = data.logs.map(entry => {
                const color = LOG_TAG_COLORS[entry.tag] || '#94a3b8';
                return `<div style="margin-bottom: 4px; line-height: 1.4; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 4px;">` +
                       `<span style="color: #555; font-size: 9px;">[${entry.time}]</span> ` +
                       `<span style="color: ${color}; font-weight: bold; font-size: 9px;">[${entry.tag}]</span> ` +
                       `<span style="color: #ccc; font-size: 10px;">${entry.msg}</span>` +
                       `</div>`;
            }).join('');
            logList.scrollTop = logList.scrollHeight;
        }
    }
}

window.refreshTelemetry = function() {
    pollTelemetry();
    toast('Telemetry refreshed', 'info', 1500);
};

function updateLatency(ms) {
    State.lastLatency = ms;
    setEl('hudLatency', ms + '');
    setEl('telemLatency', ms + ' ms');

    // Color coding
    const pill = document.querySelector('.hud-ping');
    if (pill) {
        pill.style.color = ms < 30 ? 'var(--accent-green)' : ms < 80 ? '' : 'var(--accent-orange)';
    }
}

function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

/* ══════════════════════════════════════════════════════════
   CONNECTION UI STATE
══════════════════════════════════════════════════════════ */
function updateConnectionUI(connected, state = null) {
    const dot    = document.getElementById('hudStatusDot');
    const text   = document.getElementById('hudStatusText');
    const pill   = document.getElementById('hudConnStatus');
    const sText  = document.getElementById('settingConnStatus');

    const actualState = state || (connected ? 'connected' : 'disconnected');

    if (dot) {
        dot.className = 'status-dot ' + actualState;
    }

    if (text) {
        const labels = { connected: 'CONNECTED', disconnected: 'DISCONNECTED', reconnecting: 'RECONNECTING' };
        text.textContent = labels[actualState] || 'UNKNOWN';
    }

    if (pill) {
        pill.className = 'hud-pill hud-conn-' + actualState;
    }

    if (sText) {
        const colors = { connected: 'var(--accent-green)', disconnected: 'var(--accent-red)', reconnecting: 'var(--accent-orange)' };
        sText.textContent = (actualState || 'disconnected').toUpperCase();
        sText.style.color = colors[actualState] || 'var(--text-muted)';
    }

    State.connected = connected;
}

function updateHudIp(ip) {
    const el = document.getElementById('hudIpLabel');
    if (el) el.textContent = 'IP: ' + ip;
}

/* ══════════════════════════════════════════════════════════
   SETTINGS DRAWER
══════════════════════════════════════════════════════════ */
window.openSettings = function() {
    const drawer = document.getElementById('settingsDrawer');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
};

window.closeSettings = function() {
    const drawer = document.getElementById('settingsDrawer');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
};

// Close on Escape
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSettings();
});

/* Toggle accordion sections */
window.toggleSection = function(id) {
    const body  = document.getElementById(id);
    const arrow = document.getElementById('arrow' + id.replace('sec', ''));
    if (!body) return;
    body.classList.toggle('open');
    if (arrow) arrow.classList.toggle('rotated');
};

/* Connection settings actions */
window.reconnectToIp = async function() {
    const ip = document.getElementById('settingIp').value.trim();
    if (!ip) return;
    State.ip = ip;
    connectIpInput.value = ip;
    mobileLog('RECONNECTING TO ' + ip);
    toast('Reconnecting to ' + ip, 'info');

    await fetch('/set_ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `ip_address=${encodeURIComponent(ip)}`
    });

    // Save IP persistently in localStorage
    localStorage.setItem('jetracer_ip', ip);

    pollTelemetry();
    updateHudIp(ip);
    closeSettings();
};

window.disconnectFromVehicle = function() {
    State.connected = false;
    stopTelemetryPolling();
    if (State.autoStop) sendStopCommand();
    updateConnectionUI(false);
    toast('Disconnected', 'warning');
    mobileLog('UPLINK TERMINATED');
};

/* STEERING_GAIN slider */
const settingSteeringGain = document.getElementById('settingSteeringGain');
if (settingSteeringGain) {
    // Init State from rendered default value
    State.steeringGain = parseFloat(settingSteeringGain.value) || 1.66;
    settingSteeringGain.addEventListener('input', function() {
        State.steeringGain = parseFloat(this.value);
        const display = parseFloat(this.value).toFixed(2);
        document.getElementById('valSteeringGain').textContent = display;
        document.getElementById('sbSteeringOffset').textContent = 'OFFSET: ' + State.steeringOffset.toFixed(2);
        sendCommand('STEERING_GAIN', parseFloat(this.value).toFixed(2));
    });
}

/* STEERING_OFFSET slider */
const settingSteeringOffset = document.getElementById('settingSteeringOffset');
if (settingSteeringOffset) {
    // Init State from rendered default value
    State.steeringOffset = parseFloat(settingSteeringOffset.value) || 0.43;
    settingSteeringOffset.addEventListener('input', function() {
        State.steeringOffset = parseFloat(this.value);
        const display = parseFloat(this.value).toFixed(2);
        document.getElementById('valSteeringOffset').textContent = display;
        document.getElementById('sbSteeringOffset').textContent = 'OFFSET: ' + display;
        sendCommand('STEERING_OFFSET', parseFloat(this.value).toFixed(2));
    });
}

/* Steering Sensitivity slider */
const settingSteering = document.getElementById('settingSteering');
if (settingSteering) {
    settingSteering.addEventListener('input', function() {
        State.steeringSensitivity = parseInt(this.value);
        document.getElementById('valSteering').textContent = this.value + '%';
    });
}

/* Drive Mode */
window.setDriveMode = function(btn) {
    const mode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    State.driveMode = mode;

    const badge = document.getElementById('driveModeBadge');
    if (badge) {
        badge.textContent = mode.toUpperCase();
        badge.className = 'drive-mode-badge mode-' + mode.toLowerCase();
    }

    // Apply mode presets (only adjust sensitivity, not gain/offset)
    const presets = {
        Precision: { sensitivity: 60 },
        Normal:    { sensitivity: 100 },
        Sport:     { sensitivity: 160 },
    };
    const p = presets[mode];
    if (p) {
        State.steeringSensitivity = p.sensitivity;
        const settingSteeringEl = document.getElementById('settingSteering');
        const valSteeringEl = document.getElementById('valSteering');
        if (settingSteeringEl) settingSteeringEl.value = p.sensitivity;
        if (valSteeringEl) valSteeringEl.textContent = p.sensitivity + '%';
    }

    toast('Drive mode: ' + mode, 'info', 1800);
};

/* Auto-reconnect toggle */
document.getElementById('settingAutoReconnect').addEventListener('change', function() {
    State.autoReconnect = this.checked;
});

/* Auto-stop toggle */
document.getElementById('settingAutoStop').addEventListener('change', function() {
    State.autoStop = this.checked;
});

/* Debug mode toggle */
document.getElementById('settingDebug').addEventListener('change', function() {
    State.debugMode = this.checked;
    toast('Debug mode ' + (this.checked ? 'ON' : 'OFF'), 'info', 1500);
});

/* WS Update rate */
document.getElementById('settingWsRate').addEventListener('change', function() {
    State.wsUpdateRate = parseInt(this.value);
    if (jsSendInterval) {
        clearInterval(jsSendInterval);
        jsSendInterval = setInterval(sendAnalog, State.wsUpdateRate);
    }
    toast('Update rate: ' + this.value + ' ms', 'info', 1500);
});

/* ── Calibration ── */
window.calibrateJoystick = function() {
    jsStickX = jsCenterX;
    jsStickY = jsCenterY;
    State.currentX = 0;
    State.currentY = 0;
    drawJoystick();
    if (joystickCoords) joystickCoords.textContent = 'X:0 Y:0';
    toast('Joystick calibrated', 'success', 1500);
};

/* ── Diagnostics ── */
window.runDiagnostics = async function() {
    const out = document.getElementById('diagnosticsOutput');
    out.style.display = 'block';
    out.textContent = '> Running diagnostics...\n';

    const checks = [
        { label: 'Network',  fn: async () => { const r = await fetch('/ping_jetracer', { signal: AbortSignal.timeout(3000) }); const d = await r.json(); return d.reachable ? 'OK' : 'FAIL'; } },
        { label: 'Camera',   fn: async () => { const r = await fetch('/camera/status', { signal: AbortSignal.timeout(2000) }); const d = await r.json(); return d.camera_running ? 'RUNNING' : 'OFFLINE'; } },
        { label: 'Status',   fn: async () => { const r = await fetch('/status', { signal: AbortSignal.timeout(2000) }); const d = await r.json(); return d.status || 'OK'; } },
    ];

    for (const check of checks) {
        try {
            const result = await check.fn();
            out.textContent += `> ${check.label}: ${result}\n`;
        } catch (e) {
            out.textContent += `> ${check.label}: ERROR (${e.message})\n`;
        }
        await delay(100);
    }
    out.textContent += '> Done.\n';
};

/* ══════════════════════════════════════════════════════════
   AUTOPILOT
══════════════════════════════════════════════════════════ */
window.toggleAutopilot = function() {
    const checkbox = document.getElementById('settingAutopilot');
    if (checkbox) {
        State.autopilotActive = checkbox.checked;
    } else {
        State.autopilotActive = !State.autopilotActive;
    }
    const cmd = State.autopilotActive ? 'ON' : 'OFF';
    sendCommand('AUTOPILOT', cmd);
    toast('Autopilot ' + cmd, State.autopilotActive ? 'success' : 'info', 1500);
};

/* ══════════════════════════════════════════════════════════
   CAPTURE
══════════════════════════════════════════════════════════ */
window.captureFrameMobile = async function() {
    mobileLog('CAPTURING FRAME…');
    try {
        const res = await fetch('/capture-frame', { method: 'POST', signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        if (data.success) {
            toast('Frame captured: ' + data.filename, 'success');
            mobileLog('FRAME: ' + data.filename);
        } else {
            toast('Capture failed: ' + (data.error || '?'), 'error');
        }
    } catch (e) {
        toast('Capture error', 'error');
    }
};

/* ══════════════════════════════════════════════════════════
   POWER OFF
══════════════════════════════════════════════════════════ */
window.powerOff = function() {
    if (!confirm('SYSTEM_SHUTDOWN — Terminate the uplink?')) return;
    sendCommand('SYSTEM_POWER_OFF');
    stopTelemetryPolling();
    window.location.href = '/login';
};

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

/* ══════════════════════════════════════════════════════════
   BOOT: Pre-connect if session already has IP
══════════════════════════════════════════════════════════ */
(function boot() {
    let ip = connectIpInput ? connectIpInput.value.trim() : '';
    if (!ip) {
        ip = localStorage.getItem('jetracer_ip') || '';
        if (ip && connectIpInput) {
            connectIpInput.value = ip;
        }
    }
    if (ip) {
        // Auto-try connection after short delay so page is rendered
        setTimeout(async () => {
            State.ip = ip;
            try {
                // Ensure the session is updated on the server
                await fetch('/set_ip', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `ip_address=${encodeURIComponent(ip)}`
                });

                const res = await fetch('/ping_jetracer', { signal: AbortSignal.timeout(4000) });
                const data = await res.json();
                if (data.reachable) {
                    State.connected = true;
                    transitionToController();
                }
            } catch (_) {
                // Stay on connect screen — user can retry
            }
        }, 300);
    }
})();

/* ══════════════════════════════════════════════════════════
   PREVENT DEFAULT TOUCH BEHAVIORS on controller screen
══════════════════════════════════════════════════════════ */
// Touch events allowed for interactive dashboard controls

/* ══════════════════════════════════════════════════════════
   WAKE LOCK (keep screen on while driving)
══════════════════════════════════════════════════════════ */
let wakeLock = null;
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
        } catch (_) {}
    }
}
requestWakeLock();
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});

console.log('[MOBILE.JS] ✓ All modules initialized');
