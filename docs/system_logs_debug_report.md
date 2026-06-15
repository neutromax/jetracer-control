# System Logs Debug Report

**Date:** 2026-06-15  
**Status:** FIXED ✓

---

## Root Cause

Two separate issues caused the SYSTEM_LOGS panel to be empty:

### Issue 1 — Backend: No `/logs` endpoint existed
`jetracer_server.py` already maintained a `system_logs` list and a `log()` function (lines 118–128) that appended timestamped entries during boot, camera init, and hardware init. However, **no Flask route exposed this buffer** to the network. The data was generated but never accessible.

### Issue 2 — Frontend: No fetch code existed
`main.js` had zero references to `fullLogList`, `/logs`, or any log-polling logic. The `#fullLogList` `<div>` in `index.html` (line 195) was an empty placeholder with no JavaScript to populate it.

---

## Backend Fix

### `jetracer_server.py` — New `GET /logs` endpoint

```python
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
```

**Design:** Supports `?since=N` incremental polling — the frontend only fetches new entries since its last known index, making polls lightweight.

### `app.py` — Proxy route

```python
@app.route('/logs')
def get_logs():
    target_ip = session.get('ip_address')
    since = request.args.get('since', '0')
    r = http_session.get(f"http://{target_ip}:5000/logs?since={since}", timeout=3)
    return Response(r.content, content_type='application/json')
```

---

## Frontend Fix

### `static/js/main.js` — Log polling system

```javascript
let logsNextIndex = 0;   // cursor tracking last fetched index
let logsInterval = null;

async function fetchNewLogs() {
    const r = await fetch(`/logs?since=${logsNextIndex}`);
    const data = await r.json();
    if (data.entries && data.entries.length > 0) {
        data.entries.forEach(entry => {
            fullLogList.appendChild(renderLogEntry(entry));
        });
        logsNextIndex = data.total;        // advance cursor
        fullLogList.scrollTop = fullLogList.scrollHeight;
    }
}

function startLogPolling() {
    if (logsInterval) return;
    fetchNewLogs();                        // immediate first load
    logsInterval = setInterval(fetchNewLogs, 2000);
}

startLogPolling();                         // starts on page load
```

**Features:**
- Polls every **2 seconds** automatically
- **Incremental** — only fetches new entries, not full history each time
- Auto-scrolls to newest entry
- Color-coded source tags (BOOT=green, CAMERA=blue, HARDWARE=orange, DRIVE=purple, etc.)
- Starts in background immediately, so logs accumulate before user opens the tab

---

## API Response Format

```
GET /logs?since=0
→ {
    "total": 3,
    "entries": [
      {"index": 0, "time": "01:14:23", "tag": "BOOT",     "msg": "Starting JetRacer hardware server..."},
      {"index": 1, "time": "01:14:24", "tag": "CAMERA",   "msg": "Camera pipeline opened OK (src=nvarguscamerasrc...)"},
      {"index": 2, "time": "01:14:44", "tag": "HARDWARE", "msg": "NvidiaRacecar initialised OK"}
    ]
  }
```

---

## Log Sources

| Tag | Color | Events |
|---|---|---|
| `BOOT` | 🟢 Green | Server startup |
| `CAMERA` | 🔵 Blue | Camera open/stop/start |
| `CAMERA_ERR` | 🔴 Red | Camera failures |
| `HARDWARE` | 🟠 Orange | Car hardware init |
| `HARDWARE_ERR` | 🔴 Red | Hardware failures |
| `DRIVE` | 🟣 Purple | Throttle/steering commands |
| `NETWORK` | 🟩 Teal | WiFi/network events |
| `API` | 🟡 Amber | API calls |
| `CRITICAL` | 🔴 Red | Emergency stop, critical errors |

---

## Verification

### Live logs fetched from JetRacer (verified 2026-06-15):

```
Total: 3
  01:14:23  BOOT      Starting JetRacer hardware server on port 5000
  01:14:24  CAMERA    Camera pipeline opened OK (src=nvarguscamerasrc ...)
  01:14:44  HARDWARE  NvidiaRacecar initialised OK
```

### To verify in browser:
1. Open `http://127.0.0.1:5001` → hard refresh `Ctrl+Shift+R`
2. Click **SYSTEM_LOGS** tab
3. Should immediately show BOOT, CAMERA, HARDWARE entries
4. Toggle CAM_ON → wait 2s → new CAMERA log appears
5. Send a drive command → DRIVE log appears
6. Refresh browser → logs remain (they live on the JetRacer, not in browser memory)

---

## Files Modified

| File | Change |
|---|---|
| `jetracer_server.py` | Added `GET /logs` endpoint with `?since=N` incremental support |
| `app.py` | Added `/logs` proxy route forwarding to JetRacer:5000 |
| `static/js/main.js` | Added `fetchNewLogs()`, `renderLogEntry()`, 2s polling, color-coded display |
