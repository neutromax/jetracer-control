# Progress Log

## Responsive UI
- [x] Make the Jetracer dashboard fully responsive.
  - [x] Resolved controls panel vertical overflow overlapping telemetry panel (by introducing `max-height: 100%; overflow-y: auto; scrollbar-width: thin;` on `.controls-panel`).
  - [x] Resolved HUD bottom container horizontal overflow and controls collision at 1024px (by introducing `flex-wrap: wrap` and reducing paddings/max-widths dynamically).
  - [x] Collapsed sidebar gracefully to icon-only view on medium screens (992px) and hid completely on mobile screens (768px).
  - [x] Telemetry panel wrap configured automatically.
  - [x] Joystick remains square at all widths.
  - [x] Verified zero horizontal scrolling and zero component overlaps.

### Screenshots Verified
- **1920x1080 Viewport:** [screenshot_fixed_1920_1781499709909.png](file:///C:/Users/LENOVO/.gemini/antigravity-ide/brain/a45aaa29-6c12-4ca7-9a29-3ff757f9b2d0/screenshot_fixed_1920_1781499709909.png)
- **1366x768 Viewport:** [screenshot_fixed_1366_1781499725729.png](file:///C:/Users/LENOVO/.gemini/antigravity-ide/brain/a45aaa29-6c12-4ca7-9a29-3ff757f9b2d0/screenshot_fixed_1366_1781499725729.png)
- **1024x768 Viewport:** [screenshot_fixed_1024_1781499735998.png](file:///C:/Users/LENOVO/.gemini/antigravity-ide/brain/a45aaa29-6c12-4ca7-9a29-3ff757f9b2d0/screenshot_fixed_1024_1781499735998.png)
- **768x1024 Viewport:** [screenshot_fixed_768_1781499750340.png](file:///C:/Users/LENOVO/.gemini/antigravity-ide/brain/a45aaa29-6c12-4ca7-9a29-3ff757f9b2d0/screenshot_fixed_768_1781499750340.png)

## Embedded SSH Terminal
- [x] Add TERMINAL tab to header navigation in index.html.
- [x] Configure backend WebSocket namespace `/terminal` in app.py.
- [x] Implement background green thread maintaining interactive Paramiko SSH connection.
- [x] Resolve eventlet monkey-patch synchronization issue to support non-blocking standard libraries.
- [x] Address local scoping issue in jetracer_server.py causing 500 error on video feed.
- [x] Verify hostname, pwd, and ls outputs stream live on UI console.

## Camera Control
- [x] Fix frontend `e.target` → `e.currentTarget` to prevent icon-click from breaking button toggle.
- [x] Track camera state with explicit `cameraIsOn` boolean instead of fragile text matching.
- [x] Add cache-busting `?t=<timestamp>` to `/video_feed` URL so re-enabling forces a fresh MJPEG connection.
- [x] Add 1.5s delay before re-connecting stream after ON command (allows GStreamer pipeline to open on Jetson Nano).
- [x] Fix `jetracer_server.py`: `cmd.split('_')[2]` returned `'CAMERA'` not `'ON'`/`'OFF'` — changed to `cmd.rsplit('_', 1)[-1]`.
- [x] Add `global camera, camera_running` in `generate_frames()` and `command()` to fix `UnboundLocalError`.
- [x] Add `/camera_status` endpoint on JetRacer server + proxy on local Flask app.
- [x] Add `updateCameraStatus()` helper updating FPS_RENDER box border color and label (green=ON, yellow=CONNECTING, red=OFFLINE).
- [x] Button text toggles dynamically: `CAM_ON` ↔ `CAM_OFF` with matching icon (`fa-video` / `fa-video-slash`).

### Verification (5-Cycle Reliability Test)
All 5 ON/OFF cycles passed against `10.71.71.189`:
```
Cycle 1: OFF→running=False ✓  ON→running=True, feed=20480B ✓
Cycle 2: OFF→running=False ✓  ON→running=True, feed=20480B ✓
Cycle 3: OFF→running=False ✓  ON→running=True, feed=20480B ✓
Cycle 4: OFF→running=False ✓  ON→running=True, feed=20480B ✓
Cycle 5: OFF→running=False ✓  ON→running=True, feed=20480B ✓
```

## WiFi Manager
- [x] Add `WIFI_MANAGER` HTML structure to `index.html`.
- [x] Create proxy routes (`/wifi/networks`, `/wifi/status`, `/wifi/connect`, `/wifi/rescan`) in `app.py`.
- [x] Add backend execution of `nmcli` in `jetracer_server.py`.
- [x] Fix Python 3.6 compatibility on JetRacer by replacing `capture_output=True` with `stdout=PIPE`.
- [x] Fix `nmcli` parsing on JetRacer to accept `802-11-wireless` as a valid type.
- [x] Implemented UI logic in `main.js` to parse JSON, populate the `WIFI_MANAGER` UI, and show network states dynamically.
- [x] Tested endpoint response parsing and API functionality using `test_proxy.py`.
- [x] Visual UI verification completed using browser agent to ensure correct UI updating.

## Capture Frame and Gallery
- [x] Removed fake GPS display (`COORD_X_Y_Z`) from `index.html`.
- [x] Replaced GPS display with dynamic `CONNECTION_STATUS` and `IP` readouts driven by Jetson WiFi status.
- [x] Created server-side `latest_frame_jpeg` tracker in `generate_frames()` to hold raw MJPEG bytes.
- [x] Implemented `POST /capture-frame` API in `jetracer_server.py` and proxied it in `app.py`.
- [x] Implemented `GET /gallery`, `GET /gallery/<filename>`, and `DELETE /gallery/<filename>` in `jetracer_server.py`.
- [x] Proxied all Gallery routes in `app.py`.
- [x] Added `galleryModal` HTML to overlay captured images.
- [x] Handled frontend JS capture event, grid rendering, and full-resolution popup clicks.
- [x] Wired up `DOWNLOAD` (HTML trigger) and `DELETE` (API trigger) controls on the image modal.
- [x] Conducted automated end-to-end browser verification of 5 capture clicks, live rendering, modal expansion, and deletion logic.
