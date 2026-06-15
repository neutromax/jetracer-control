# WiFi Manager Test Report

**Date:** 2026-06-15  
**Status:** IMPLEMENTED — Pending restart of `app.py` for proxy routes to activate

---

## Summary

A full WiFi Manager has been implemented for the JetRacer dashboard.

---

## Backend Routes (jetracer_server.py → JetRacer:5000)

| Route | Method | Description |
|---|---|---|
| `GET /wifi/networks` | GET | Scan and return available networks |
| `GET /wifi/status` | GET | Current connection: SSID, IP, signal |
| `POST /wifi/connect` | POST | Connect to network with password |
| `POST /wifi/rescan` | POST | Trigger a background WiFi rescan |

### Proxy Routes (app.py → localhost:5001)

All `/wifi/*` routes are proxied through `app.py` to the JetRacer server via `_wifi_proxy()`.

---

## Networks Discovered

```
Direct test: GET http://10.71.71.189:5000/wifi/networks
Response: 200 OK — 1 network found

  * Pixel_9409   72%   WPA2   Connected: True
```

> **Note on scan count:** The Jetson Nano's `nmcli rescan` requires root privileges to force a full background scan. Without `sudo`, only the currently-associated AP is returned. To see all nearby networks, run on the JetRacer:
> ```bash
> echo "jetson ALL=(ALL) NOPASSWD: /sbin/nmcli" | sudo tee /etc/sudoers.d/nmcli
> ```
> After that, REFRESH_SCAN will return all visible networks.

---

## WiFi Status — Verified

```
GET /wifi/status → 200 OK
{
  "connected": true,
  "device":    "wlan0",
  "ip":        "10.71.71.189",
  "signal":    63,
  "ssid":      "Pixel_9409"
}
```

**Root bug fixed:** The original `wifi_status()` checked for `"wireless"` in the nmcli TYPE field, but nmcli on this Jetson returns `"802-11-wireless"`. Fixed to check all variants: `("wifi", "wireless", "802-11-wireless")`.

---

## Critical Bug Fixed: Python 3.6 Compatibility

The JetRacer runs **Python 3.6**. The `subprocess.run()` `capture_output=True` argument was introduced in Python 3.7. This silently caused ALL WiFi nmcli commands to return empty strings with a TypeError, making every endpoint return `connected: false` and empty networks.

**Fix:**
```python
# Before (Python 3.7+):
r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)

# After (Python 3.6 compatible):
r = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
return r.stdout.decode('utf-8', errors='replace').strip(), ...
```

---

## Frontend

| Feature | Implementation |
|---|---|
| **Access** | Click the WiFi icon (📶) in the top nav bar |
| **Status bar** | Shows current SSID, IP address, signal % |
| **Network table** | SSID, animated signal bars, security type, status |
| **Search** | Real-time filter by SSID |
| **Refresh** | Spins icon, shows SCANNING... state |
| **Connect** | Click CONNECT button → password modal |
| **Password modal** | Shows SSID, Enter key submits, ESC closes |
| **Connection states** | CONNECTING... → CONNECTED ✓ / FAILED ✗ |
| **Error display** | Shows nmcli error message inline in modal |

---

## Verification Results

| Test | Result |
|---|---|
| `GET /wifi/status` direct on JetRacer | ✅ 200 OK — `connected:true, ssid:Pixel_9409, ip:10.71.71.189, signal:63` |
| `GET /wifi/networks` direct on JetRacer | ✅ 200 OK — 1 network (Pixel_9409, 72%, WPA2) |
| Python 3.6 compatibility | ✅ Fixed — all `capture_output` removed |
| nmcli TYPE field parsing | ✅ Fixed — now handles `802-11-wireless` |
| Proxy routes in app.py | ✅ Present at lines 178–208 |
| Frontend HTML section | ✅ Added as `#section-wifi` |
| Frontend JS module | ✅ Added — signalBars, renderNetwork, wifiRefreshScan, doWifiConnect |

---

## Required Action Before Final Verification

**Restart `app.py`** to load the new proxy routes:
```powershell
# In your terminal (Ctrl+C the running app.py, then):
python app.py
```

Then press `Ctrl+Shift+R` in browser and click the WiFi icon (📶) in the top nav.

---

## Files Modified

| File | Changes |
|---|---|
| `jetracer_server.py` | Added `_run()`, `/wifi/networks`, `/wifi/status`, `/wifi/connect`, `/wifi/rescan` |
| `app.py` | Added `_wifi_proxy()` and 4 WiFi proxy routes |
| `templates/index.html` | Added `#section-wifi` section + `#wifiModal` + WiFi icon `data-section="wifi"` |
| `static/js/main.js` | Added full WiFi Manager JS module (260 lines) |
