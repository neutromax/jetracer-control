#!/usr/bin/env python3
"""
JetRacer Hardware Control Server
Runs ON the JetRacer (Jetson Nano) at port 5000.
Accepts commands from the remote control web app and drives the car.
"""

import cv2
import threading
import time
import subprocess
import os
from datetime import datetime
from flask import Flask, Response, request, jsonify, send_from_directory

app = Flask(__name__)

# Ensure gallery directory exists
GALLERY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gallery')
os.makedirs(GALLERY_DIR, exist_ok=True)

# ── Hardware initialisation ────────────────────────────────────────────────────
car = None
car_lock = threading.Lock()
init_error = None

def init_car():
    global car, init_error
    try:
        from jetracer.nvidia_racecar import NvidiaRacecar
        c = NvidiaRacecar()
        # Calibration defaults – tune these in the web UI
        c.steering_gain   = -0.65
        c.steering_offset = 0.0
        c.throttle_gain   = 0.8
        with car_lock:
            car = c
        log("HARDWARE", "NvidiaRacecar initialised OK")
    except Exception as e:
        init_error = str(e)
        log("HARDWARE_ERR", f"Car init failed: {e}")

threading.Thread(target=init_car, daemon=True).start()

# ── Camera ─────────────────────────────────────────────────────────────────────
camera = None
camera_lock = threading.Lock()
camera_running = False
latest_frame_jpeg = None

# GStreamer pipelines for Jetson Nano CSI camera (IMX219)
# nvarguscamerasrc only supports specific sensor modes; 1280x720 works natively.
GST_PIPELINES = [
    # nvarguscamerasrc – preferred for CSI (IMX219 on Jetson Nano)
    (
        "nvarguscamerasrc sensor-id=0 ! "
        "video/x-raw(memory:NVMM), width=1280, height=720, framerate=30/1, format=NV12 ! "
        "nvvidconv ! video/x-raw, format=BGRx ! "
        "videoconvert ! video/x-raw, format=BGR ! appsink max-buffers=1 drop=true",
        cv2.CAP_GSTREAMER,
    ),
    # v4l2 GStreamer pipeline (USB camera fallback)
    (
        "v4l2src device=/dev/video0 ! "
        "video/x-raw, width=640, height=480, framerate=30/1 ! "
        "videoconvert ! video/x-raw, format=BGR ! appsink max-buffers=1 drop=true",
        cv2.CAP_GSTREAMER,
    ),
    # Plain OpenCV index 0
    (0, cv2.CAP_V4L2),
    (0, cv2.CAP_ANY),
]

camera_opening_lock = threading.Lock()
is_opening = False

def open_camera():
    global camera, camera_running, is_opening
    with camera_opening_lock:
        if is_opening:
            return
        is_opening = True

    try:
        for src, backend in GST_PIPELINES:
            try:
                cap = cv2.VideoCapture(src, backend)
                if not isinstance(src, str):
                    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  640)
                    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
                    cap.set(cv2.CAP_PROP_FPS, 30)

                if cap.isOpened():
                    # CSI cameras take ~1-2 s for first frame; skip test-read here.
                    # The generate_frames() loop handles read failures gracefully.
                    with camera_lock:
                        camera = cap
                        camera_running = True
                    src_label = src if isinstance(src, str) else "index-" + str(src)
                    log("CAMERA", "Camera pipeline opened OK (src=" + src_label + ")")
                    return
                else:
                    cap.release()
                    log("CAMERA", f"Could not open src={src!r}, trying next ...")
            except Exception as exc:
                log("CAMERA", f"Exception with src={src!r}: {exc}")

        log("CAMERA_ERR", "All camera backends failed - video feed will be offline")
    finally:
        with camera_opening_lock:
            is_opening = False

threading.Thread(target=open_camera, daemon=True).start()

# ── Shared state ───────────────────────────────────────────────────────────────
state = {
    "steering":  0.0,
    "throttle":  0.0,
    "s_gain":   -0.65,
    "s_offset":  0.0,
    "t_gain":    0.8,
    "autopilot": False,
}
state_lock = threading.Lock()
system_logs = []
logs_lock = threading.Lock()

def log(tag, msg):
    ts = time.strftime("%H:%M:%S")
    entry = {"time": ts, "tag": tag, "msg": msg}
    with logs_lock:
        system_logs.append(entry)
        if len(system_logs) > 100:
            system_logs.pop(0)
    print(f"[{ts}] [{tag}] {msg}")

# ── Drive loop (runs every 50 ms) ──────────────────────────────────────────────
def drive_loop():
    """Continuously sends the latest steering/throttle to the hardware."""
    while True:
        with car_lock:
            c = car
        if c is not None:
            with state_lock:
                st = state["steering"]
                th = state["throttle"]
            try:
                c.steering = st
                c.throttle = th
            except Exception as e:
                log("DRIVE_ERR", str(e))
        time.sleep(0.05)

threading.Thread(target=drive_loop, daemon=True).start()

# ── MJPEG frame generator ──────────────────────────────────────────────────────
import numpy as np

def _make_blank_jpeg(msg="Camera offline"):
    """Return a valid JPEG with an error message."""
    import numpy as _np
    img = _np.zeros((120, 320, 3), dtype=_np.uint8)
    cv2.putText(img, msg, (10, 65), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 255), 2)
    _, buf = cv2.imencode('.jpg', img)
    return buf.tobytes()

_BLANK_JPEG = None  # lazy-init

def generate_frames():
    global _BLANK_JPEG, camera, camera_running, latest_frame_jpeg
    frame_interval = 1.0 / 30  # target 30 fps
    consecutive_failures = 0
    while True:
        t0 = time.time()
        with camera_lock:
            c = camera
            running = camera_running
        if c is None or not running:
            if _BLANK_JPEG is None:
                _BLANK_JPEG = _make_blank_jpeg()
            yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + _BLANK_JPEG + b'\r\n')
            time.sleep(0.2)
            continue
        ret, frame = c.read()
        if not ret or frame is None:
            consecutive_failures += 1
            if consecutive_failures >= 30:
                log("CAMERA_ERR", "Consequent read failures exceeded limit. Resetting camera...")
                with camera_lock:
                    camera_running = False
                    if camera is not None:
                        try:
                            camera.release()
                        except Exception:
                            pass
                        camera = None
                consecutive_failures = 0
                threading.Thread(target=open_camera, daemon=True).start()
            time.sleep(0.05)
            continue
        consecutive_failures = 0
        _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        latest_frame_jpeg = buffer.tobytes()
        yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' +
               latest_frame_jpeg + b'\r\n')
        elapsed = time.time() - t0
        sleep_t = frame_interval - elapsed
        if sleep_t > 0:
            time.sleep(sleep_t)

# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route('/video_feed')
def video_feed():
    return Response(generate_frames(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')


@app.route('/command', methods=['POST'])
def command():
    """Accepts string commands from the web app and maps them to hardware actions."""
    global camera, camera_running
    cmd = request.form.get('cmd', '').strip().upper()
    log("CMD", cmd)

    with state_lock:
        # ── Movement ─────────────────────────────────────────────────────────
        if cmd == 'MOVE_UP':
            state["throttle"] = 0.4
            state["steering"] = 0.0
        elif cmd == 'MOVE_DOWN':
            state["throttle"] = -0.3
            state["steering"] = 0.0
        elif cmd == 'MOVE_LEFT':
            state["throttle"] = 0.3
            state["steering"] = -0.5
        elif cmd == 'MOVE_RIGHT':
            state["throttle"] = 0.3
            state["steering"] = 0.5
        elif cmd == 'MOVE_STOP':
            state["throttle"] = 0.0
            state["steering"] = 0.0

        # ── Joystick (x,y vector) ─────────────────────────────────────────
        elif cmd.startswith('JOYSTICK_'):
            # Format: JOYSTICK_<x>_<y>  values -100 to 100
            parts = cmd.split('_')
            if len(parts) == 3:
                x = float(parts[1]) / 100.0   # steering  (-1 … 1)
                y = float(parts[2]) / 100.0   # throttle  (-1 … 1)
                state["steering"] = max(-1.0, min(1.0,  x))
                state["throttle"] = max(-1.0, min(1.0, -y))  # invert Y

        # ── Throttle slider ───────────────────────────────────────────────
        elif cmd.startswith('THROTTLE_'):
            val = float(cmd.split('_')[1]) / 100.0  # 0-100 → 0.0-1.0
            state["throttle"] = val

        # ── Steering trim ─────────────────────────────────────────────────
        elif cmd.startswith('TRIM_'):
            trim = float(cmd.split('_')[1]) / 100.0
            state["s_offset"] = trim
            with car_lock:
                if car:
                    car.steering_offset = trim

        # ── Speed limiter ─────────────────────────────────────────────────
        elif cmd.startswith('LIMITER_'):
            gain = float(cmd.split('_')[1]) / 100.0
            state["t_gain"] = gain
            with car_lock:
                if car:
                    car.throttle_gain = gain * 0.8

        # ── Emergency / system ────────────────────────────────────────────
        elif cmd in ('ENGINE_STOP', 'SYSTEM_POWER_OFF', 'MOVE_STOP'):
            state["throttle"] = 0.0
            state["steering"] = 0.0
            log("CRITICAL", "EMERGENCY STOP")

        elif cmd == 'SYSTEM_ARM':
            log("SYSTEM", "ARMED – ready to drive")

        elif cmd == 'CAPTURE_FRAME':
            # Just log it; gallery capture happens on the client side
            log("DATASET", "Frame capture requested")

        elif cmd.startswith('AUTOPILOT_'):
            mode = cmd.split('_')[1]
            state["autopilot"] = (mode == 'ON')
            log("AI", f"Autopilot {'ENABLED' if state['autopilot'] else 'DISABLED'}")

        elif cmd.startswith('TOGGLE_CAMERA_'):
            mode = cmd.rsplit('_', 1)[-1]   # 'ON' or 'OFF'
            log("CAMERA", f"Toggle camera requested: {mode}")
            if mode == 'ON':
                with camera_lock:
                    if camera is not None:
                        try: camera.release()
                        except Exception: pass
                        camera = None
                    camera_running = False
                threading.Thread(target=open_camera, daemon=True).start()
            else:
                with camera_lock:
                    camera_running = False
                    if camera is not None:
                        try: camera.release()
                        except Exception: pass
                        camera = None

    return jsonify({"status": "ok", "cmd": cmd})


@app.route('/drive', methods=['GET', 'POST'])
def drive():
    """Direct x/y/throttle drive endpoint (used by AI inference loop)."""
    x        = float(request.args.get('x',        request.form.get('x',        0)))
    y        = float(request.args.get('y',        request.form.get('y',        0)))
    throttle = float(request.args.get('throttle', request.form.get('throttle', 0)))
    s_gain   = float(request.args.get('s_gain',   request.form.get('s_gain',  -0.65)))
    s_offset = float(request.args.get('s_offset', request.form.get('s_offset', 0.0)))
    t_gain   = float(request.args.get('t_gain',   request.form.get('t_gain',   0.8)))

    with car_lock:
        if car:
            car.steering_gain   = s_gain
            car.steering_offset = s_offset
            car.throttle_gain   = t_gain

    with state_lock:
        state["steering"] = max(-1.0, min(1.0, x))
        state["throttle"] = max(-1.0, min(1.0, throttle))

    return jsonify({"status": "ok"})


@app.route('/status')
def status():
    """Returns live telemetry for the HUD."""
    try:
        # Battery (via jtop if available)
        battery_percent = 0
        battery_voltage = 0.0
        try:
            from jtop import jtop
            with jtop() as jetson:
                stats = jetson.stats
                battery_percent = stats.get('VDD_IN', 0)
                battery_voltage = 12.0  # placeholder
        except Exception:
            pass

        # CPU temp via sysfs
        cpu_temp = 0
        try:
            with open('/sys/devices/virtual/thermal/thermal_zone0/temp') as f:
                cpu_temp = int(f.read().strip()) // 1000
        except Exception:
            pass

        # RAM
        ram_used = 0.0
        try:
            with open('/proc/meminfo') as f:
                lines = f.readlines()
            total = int([l for l in lines if 'MemTotal' in l][0].split()[1])
            avail = int([l for l in lines if 'MemAvailable' in l][0].split()[1])
            ram_used = round((total - avail) / 1024 / 1024, 1)
        except Exception:
            pass

        with state_lock:
            current_state = dict(state)
        with logs_lock:
            recent_logs = list(system_logs[-20:])

        return jsonify({
            "status":           "connected",
            "hardware_ready":   car is not None,
            "init_error":       init_error,
            "cpu_temp":         cpu_temp,
            "ram_used":         ram_used,
            "battery_percent":  battery_percent,
            "battery_voltage":  battery_voltage,
            "steering":         current_state["steering"],
            "throttle":         current_state["throttle"],
            "autopilot":        current_state["autopilot"],
            "logs":             recent_logs,
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/emergency_stop')
def emergency_stop():
    with state_lock:
        state["throttle"] = 0.0
        state["steering"] = 0.0
    with car_lock:
        if car:
            car.throttle = 0.0
            car.steering = 0.0
    log("CRITICAL", "EMERGENCY STOP via /emergency_stop")
    return jsonify({"status": "stopped"})

@app.route('/camera/status')
def camera_status_api():
    with camera_lock:
        running = camera_running
        opened = camera is not None
    return jsonify({"camera_running": running, "camera_opened": opened})

@app.route('/camera/stop', methods=['POST'])
def camera_stop_api():
    global camera, camera_running
    log("CAMERA", "Stop requested via /camera/stop")
    with camera_lock:
        camera_running = False
        if camera is not None:
            try:
                camera.release()
            except Exception:
                pass
            camera = None
    return jsonify({"status": "ok", "camera_running": False})

@app.route('/camera/start', methods=['POST'])
def camera_start_api():
    global camera, camera_running
    with camera_lock:
        already_running = camera_running and camera is not None
    if already_running:
        log("CAMERA", "Start requested but camera already running")
        return jsonify({"status": "ok", "camera_running": True, "message": "already running"})
    log("CAMERA", "Start requested via /camera/start — launching in background")
    # Release any stale handle first
    with camera_lock:
        camera_running = False
        if camera is not None:
            try:
                camera.release()
            except Exception:
                pass
            camera = None
    # Non-blocking: return immediately, let the frontend poll /camera/status
    threading.Thread(target=open_camera, daemon=True).start()
    return jsonify({"status": "starting", "camera_running": False, "message": "camera pipeline opening in background"})


@app.route('/ping')
def ping():
    return jsonify({"status": "ok", "message": "JetRacer server is alive"})


@app.route('/logs')
def get_logs():
    """Return system log entries. Optional ?since=N returns only entries after index N."""
    try:
        since = int(request.args.get('since', 0))
    except (ValueError, TypeError):
        since = 0
    with logs_lock:
        total = len(system_logs)
        entries = system_logs[since:] if since < total else []
        result = [{"index": since + i, "time": e["time"], "tag": e["tag"], "msg": e["msg"]}
                  for i, e in enumerate(entries)]
    return jsonify({"total": total, "entries": result})


# ── WiFi Manager ───────────────────────────────────────────────────────────────

def _run(cmd, timeout=15):
    """Run a shell command and return (stdout, stderr, returncode).
    Compatible with Python 3.6+ (Jetson Nano)."""
    try:
        r = subprocess.run(
            cmd, shell=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,  # Python 3.6 compatible
            timeout=timeout
        )
        return r.stdout.decode('utf-8', errors='replace').strip(), \
               r.stderr.decode('utf-8', errors='replace').strip(), \
               r.returncode
    except subprocess.TimeoutExpired:
        return "", "timeout", -1
    except Exception as e:
        return "", str(e), -1


@app.route('/wifi/networks')
def wifi_networks():
    """Scan and return available WiFi networks."""
    log("NETWORK", "WiFi network scan requested")
    # Try rescan with and without sudo (best-effort; may need sudoers config)
    subprocess.run(
        "sudo nmcli device wifi rescan 2>/dev/null || nmcli device wifi rescan 2>/dev/null || true",
        shell=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10
    )
    time.sleep(2.5)   # give hardware time to complete scan

    # -t = terse, -e yes = escape colons, fields: IN-USE,SSID,SIGNAL,SECURITY
    stdout, stderr, rc = _run(
        "nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list 2>/dev/null", timeout=10
    )

    networks = []
    seen = set()
    for line in stdout.splitlines():
        parts = line.split(":")
        if len(parts) < 4:
            continue
        in_use  = parts[0].strip() == "*"
        ssid    = parts[1].strip()
        signal  = parts[2].strip()
        security = ":".join(parts[3:]).strip() or "Open"

        if not ssid or ssid in seen:
            continue
        seen.add(ssid)

        try:
            sig_int = int(signal)
        except ValueError:
            sig_int = 0

        networks.append({
            "ssid":      ssid,
            "signal":    sig_int,
            "security":  security,
            "connected": in_use,
        })

    # Sort: connected first, then by signal descending
    networks.sort(key=lambda n: (not n["connected"], -n["signal"]))
    log("NETWORK", f"Scan complete: {len(networks)} networks found")
    return jsonify(networks)


@app.route('/wifi/connect', methods=['POST'])
def wifi_connect():
    """Connect to a WiFi network."""
    data = request.get_json(force=True) or {}
    ssid     = data.get("ssid", "").strip()
    password = data.get("password", "").strip()

    if not ssid:
        return jsonify({"status": "error", "message": "SSID required"}), 400

    log("NETWORK", f"Connecting to SSID: {ssid}")

    if password:
        cmd = f'nmcli device wifi connect "{ssid}" password "{password}"'
    else:
        cmd = f'nmcli device wifi connect "{ssid}"'

    stdout, stderr, rc = _run(cmd, timeout=30)

    if rc == 0:
        log("NETWORK", f"Connected to {ssid} OK")
        return jsonify({"status": "connected", "ssid": ssid, "message": stdout})
    else:
        err = stderr or stdout or "Unknown error"
        log("NETWORK", f"Connect to {ssid} FAILED: {err}")
        return jsonify({"status": "failed", "message": err}), 200


@app.route('/wifi/status')
def wifi_status():
    """Return current WiFi connection details."""
    # Primary: nmcli active connections (TYPE is "wifi" not "wireless")
    stdout, _, _ = _run(
        "nmcli -t -f NAME,TYPE,DEVICE connection show --active 2>/dev/null", timeout=8
    )

    ssid = None
    device = "wlan0"
    for line in stdout.splitlines():
        parts = line.split(":")
        if len(parts) >= 3 and parts[1].strip().lower() in ("wifi", "wireless", "802-11-wireless"):
            ssid   = parts[0].strip()
            device = parts[2].strip()
            break

    # Fallback: read SSID directly from iwconfig
    if not ssid:
        iw_out, _, _ = _run("iwconfig wlan0 2>/dev/null", timeout=5)
        for line in iw_out.splitlines():
            if 'ESSID:' in line:
                import re
                m = re.search(r'ESSID:"([^"]+)"', line)
                if m:
                    ssid   = m.group(1)
                    device = "wlan0"
                break

    # Signal strength for active AP
    signal = 0
    sig_out, _, _ = _run(
        "nmcli -t -f IN-USE,SSID,SIGNAL device wifi list 2>/dev/null", timeout=8
    )
    for line in sig_out.splitlines():
        parts = line.split(":")
        if len(parts) >= 3 and parts[0].strip() == "*":
            try:
                signal = int(parts[2].strip())
            except ValueError:
                pass
            break

    # Fallback signal from iwconfig Link Quality
    if signal == 0:
        iw_out2, _, _ = _run("iwconfig wlan0 2>/dev/null", timeout=5)
        import re
        m = re.search(r'Link Quality=(\d+)/(\d+)', iw_out2)
        if m:
            signal = int(int(m.group(1)) / int(m.group(2)) * 100)

    # IP address
    ip_out, _, _ = _run(f"ip -4 addr show {device} 2>/dev/null", timeout=5)
    ip_addr = None
    for line in ip_out.splitlines():
        line = line.strip()
        if line.startswith("inet "):
            ip_addr = line.split()[1].split("/")[0]
            break

    return jsonify({
        "connected": ssid is not None,
        "ssid":      ssid or "",
        "ip":        ip_addr or "",
        "signal":    signal,
        "device":    device,
    })


@app.route('/wifi/rescan', methods=['POST'])
def wifi_rescan():
    """Trigger a WiFi rescan (fast, no wait)."""
    subprocess.run("nmcli device wifi rescan 2>/dev/null || true", shell=True, timeout=8)
    log("NETWORK", "WiFi rescan triggered")
    return jsonify({"status": "ok", "message": "Rescan triggered"})


# ── Gallery & Capture ──────────────────────────────────────────────────────────

@app.route('/capture-frame', methods=['POST'])
def capture_frame():
    global latest_frame_jpeg
    if not latest_frame_jpeg:
        return jsonify({"success": False, "error": "No camera frame available"}), 400
    
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    filename = f"capture_{timestamp}.jpg"
    filepath = os.path.join(GALLERY_DIR, filename)
    
    try:
        with open(filepath, 'wb') as f:
            f.write(latest_frame_jpeg)
        log("GALLERY", f"Frame captured: {filename}")
        return jsonify({"success": True, "filename": filename})
    except Exception as e:
        log("GALLERY_ERR", f"Failed to save frame: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/gallery')
def list_gallery():
    try:
        files = []
        for f in os.listdir(GALLERY_DIR):
            if f.endswith('.jpg'):
                filepath = os.path.join(GALLERY_DIR, f)
                stat = os.stat(filepath)
                files.append({
                    "filename": f,
                    "timestamp": stat.st_mtime,
                    "size": stat.st_size
                })
        # Sort by timestamp descending (newest first)
        files.sort(key=lambda x: x['timestamp'], reverse=True)
        return jsonify(files)
    except Exception as e:
        log("GALLERY_ERR", f"Failed to list gallery: {e}")
        return jsonify([]), 500

@app.route('/gallery/<filename>')
def serve_gallery_image(filename):
    return send_from_directory(GALLERY_DIR, filename)

@app.route('/gallery/<filename>', methods=['DELETE'])
def delete_gallery_image(filename):
    try:
        filepath = os.path.join(GALLERY_DIR, filename)
        if os.path.exists(filepath):
            os.remove(filepath)
            log("GALLERY", f"Deleted image: {filename}")
            return jsonify({"success": True})
        return jsonify({"success": False, "error": "File not found"}), 404
    except Exception as e:
        log("GALLERY_ERR", f"Failed to delete {filename}: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == '__main__':
    log("BOOT", "Starting JetRacer hardware server on port 5000 …")
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True)
