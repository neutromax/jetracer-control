# Camera Toggle Test Report

**Date:** 2026-06-15  
**Target:** JetRacer @ `10.71.71.189:5000`  
**Test:** 10-cycle CAM_ON / CAM_OFF reliability verification

---

## Backend Changes

### `jetracer_server.py` (runs on Jetson Nano)

| Endpoint | Method | Description |
|---|---|---|
| `POST /camera/stop` | NEW | Releases the OpenCV `VideoCapture` handle and sets `camera_running = False`. Returns immediately. |
| `POST /camera/start` | NEW | **Non-blocking** — fires `open_camera()` in a background thread and returns `{"status": "starting"}`. Caller must poll `/camera/status`. |
| `GET /camera/status` | NEW | Returns `{"camera_running": bool, "camera_opened": bool}` instantly without blocking. |

**Key design decision — non-blocking `/camera/start`:**  
The previous version held the Flask thread for up to 4 seconds (busy-waiting for the GStreamer pipeline to open). This caused concurrent `/camera/status` poll requests to time out, which failed cycle 10 in the first test run. The fix: start returns `{"status": "starting"}` immediately; the frontend polls `/camera/status` every 300ms (up to 6s) to confirm readiness.

### `app.py` (local Flask proxy, runs on Windows PC)

Three new proxy routes added:
- `GET /camera/status` → forwards to `http://{ip}:5000/camera/status`
- `POST /camera/stop` → forwards to `http://{ip}:5000/camera/stop`
- `POST /camera/start` → forwards to `http://{ip}:5000/camera/start`

---

## Frontend Changes

### `static/js/main.js`

Complete rewrite of the camera toggle section:

**State tracking:** `cameraIsOn` boolean (replaces fragile `innerText` comparison) + `cameraToggleBusy` flag (prevents double-clicks during async operations).

**CAM_ON → CAM_OFF (stop flow):**
1. Immediately clears `<img>` `src` → browser drops MJPEG connection
2. Shows `camera-off-overlay` placeholder
3. `POST /camera/stop` → hardware released
4. Button changes to `CAM_OFF` (red)

**CAM_OFF → CAM_ON (start flow):**
1. Shows spinner + `STARTING...` indicator
2. `POST /camera/start` → non-blocking, returns immediately
3. Polls `GET /camera/status` every 300ms (up to 6s / 20 attempts)
4. On `camera_running: true` → sets `<img src="/video_feed?t=<timestamp>">` (cache-bust)
5. Shows overlay hidden, button changes to `CAM_ON` (green)

### `templates/index.html`

Added `id="cameraStream"` to the `<img>` element and a new `camera-off-overlay` `<div>` with:
- Large video-slash icon
- `CAMERA OFF` heading
- `Click CAM_OFF to start stream` hint text

---

## API Endpoints Used

```
GET  /camera/status   → {"camera_running": bool, "camera_opened": bool}
POST /camera/stop     → {"status": "ok", "camera_running": false}
POST /camera/start    → {"status": "starting", "camera_running": false, "message": "..."}
GET  /video_feed      → multipart/x-mixed-replace MJPEG stream
```

---

## Test Results

### 10-Cycle Reliability Test — PASS (10/10)

| Cycle | STOP result | Status after STOP | START response | Status after START | Feed bytes | Result |
|---|---|---|---|---|---|---|
| 1 | `ok` | `running=false` | `starting` | `running=true` | 32768 B | **PASS** |
| 2 | `ok` | `running=false` | `starting` | `running=true` | 32768 B | **PASS** |
| 3 | `ok` | `running=false` | `starting` | `running=true` | 32768 B | **PASS** |
| 4 | `ok` | `running=false` | `starting` | `running=true` | 32768 B | **PASS** |
| 5 | `ok` | `running=false` | `starting` | `running=true` | 32768 B | **PASS** |
| 6 | `ok` | `running=false` | `starting` | `running=true` | 32768 B | **PASS** |
| 7 | `ok` | `running=false` | `starting` | `running=true` | 32768 B | **PASS** |
| 8 | `ok` | `running=false` | `starting` | `running=true` | 32768 B | **PASS** |
| 9 | `ok` | `running=false` | `starting` | `running=true` | 32768 B | **PASS** |
| 10 | `ok` | `running=false` | `starting` | `running=true` | 32768 B | **PASS** |

**No crashes. No frozen UI. No duplicate camera processes. No memory leaks observed.**

### Issues Encountered During Development

| Issue | Root Cause | Fix |
|---|---|---|
| Cycle 10 timeout in first run | `/camera/start` blocked Flask thread for 4s — concurrent `/camera/status` poll timed out | Made `/camera/start` non-blocking; frontend now polls status |
| `e.target` icon click broke toggle | Clicking `<i>` icon inside button gave wrong `innerText` | Use `e.currentTarget` (always the `<button>`) |
| `TOGGLE_CAMERA_OFF`.split('_')[2] → `'CAMERA'` | Wrong index for parsing the mode | Replaced with dedicated `/camera/*` REST endpoints |
| Browser cached MJPEG stream on re-enable | Stale connection prevented new frames | Cache-bust `?t=<timestamp>` on stream re-connect |

---

## Manual Verification Steps

> [!IMPORTANT]
> Restart `app.py` before testing to pick up the proxy route changes (`Ctrl+C` → `python app.py`).

1. Open `http://127.0.0.1:5001` — log in with `10.71.71.189`
2. Confirm live video is visible and button shows **CAM_ON**
3. Click **CAM_ON**:
   - Video disappears → replaced by **CAMERA OFF** placeholder
   - Button changes to **CAM_OFF** (red)
   - FPS box shows **CAM_OFFLINE**
   - System log shows `CAMERA_STOPPED`
4. Click **CAM_OFF**:
   - Button shows spinner + **LOADING...**
   - FPS box shows **STARTING...**  
   - After ~2–3s: live video returns
   - Button changes to **CAM_ON** (green)
   - FPS box shows **FPS_RENDER**
5. Repeat 10 times — no failures expected

---

## Files Modified

| File | Change |
|---|---|
| `jetracer_server.py` | Added `/camera/status`, `/camera/stop`, `/camera/start` (non-blocking) endpoints |
| `app.py` | Added proxy routes for all three camera endpoints, reduced `/camera/start` timeout to 3s |
| `static/js/main.js` | Rewrote camera toggle: async/await with polling, `setCameraUI()` helper, `cameraToggleBusy` guard |
| `templates/index.html` | Added `id="cameraStream"` to img, added `#cameraOffOverlay` placeholder div |
