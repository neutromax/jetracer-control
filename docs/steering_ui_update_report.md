# Steering Calibration UI Update — Verification Report

**Date:** 2026-06-17  
**Feature:** Replace `STEERING_TRIM` + `SPEED_LIMITER` with `STEERING_GAIN` + `STEERING_OFFSET`

---

## Summary of Changes

| Component | File | Status |
|---|---|---|
| Laptop Proxy Backend | `app.py` | ✅ Done |
| JetRacer Hardware Server | `jetracer_server.py` | ✅ Done |
| Desktop Template | `templates/index.html` | ✅ Done |
| Desktop Script | `static/js/main.js` | ✅ Done |
| Mobile Template | `templates/mobile.html` | ✅ Done |
| Mobile Script | `static/js/mobile.js` | ✅ Done |
| Persistent Config | `steering_config.json` | ✅ Created |

---

## New Controls Specification

| Control | Default | Min | Max | Step |
|---|---|---|---|---|
| `STEERING_GAIN` | 1.66 | 0.50 | 2.50 | 0.01 |
| `STEERING_OFFSET` | 0.43 | -1.00 | 1.00 | 0.01 |

### Formula Applied
```
final_steering = clamp((raw_steering × steering_gain) + steering_offset, -1.0, 1.0)
```

---

## Persistence Architecture

### Laptop Proxy (`app.py`)
- Reads `steering_config.json` at startup
- Injects `steering_gain` and `steering_offset` into **both** `index.html` and `mobile.html` via Jinja2 template variables
- Intercepts `STEERING_GAIN_<val>` and `STEERING_OFFSET_<val>` commands in `/command` route and saves to `steering_config.json`

### JetRacer Server (`jetracer_server.py`)
- Reads `/home/jetson/steering_config.json` at startup (falls back to defaults if missing)
- Handles `STEERING_GAIN_<val>` and `STEERING_OFFSET_<val>` commands and persists them
- Hardware library `NvidiaRacecar` initialized with `steering_gain=1.0`, `steering_offset=0.0` to avoid double-scaling
- All manual drive commands apply: `final_st = clamp((raw * gain) + offset, -1.0, 1.0)`

---

## Verification Checklist

### HTML Content Verification (Automated — `check_mobile.py`)
```
=== EXPECTED TO FIND ===
  [PASS] STEERING_GAIN
  [PASS] STEERING_OFFSET
  [PASS] settingSteeringGain
  [PASS] settingSteeringOffset
  [PASS] sbSteeringOffset
  [PASS] 1.66
  [PASS] 0.43
=== SHOULD NOT FIND ===
  [PASS] Speed Limit
  [PASS] Steering Trim
  [PASS] settingSpeedLimit
  [PASS] settingTrim
  [PASS] sbLimiter
  [PASS] valSpeedLimit
  [PASS] valTrim
```
**Result: 14/14 checks passed ✅**

### Desktop Dashboard
- ✅ Label `STEERING_GAIN` displayed (was `STEERING_TRIM`)
- ✅ Label `STEERING_OFFSET` displayed (was `SPEED_LIMITER`)  
- ✅ Slider defaults: Gain = 1.66, Offset = 0.43
- ✅ Step precision = 0.01 on both sliders
- ✅ `+/-` buttons on STEERING_GAIN (0.05 increment)
- ✅ Values send `STEERING_GAIN_<val>` and `STEERING_OFFSET_<val>` commands
- ✅ Values persist across page refresh (loaded from `steering_config.json` via Jinja2)

### Mobile Dashboard
- ✅ `STEERING_GAIN` slider visible in DRIVING section
- ✅ `STEERING_OFFSET` slider visible in DRIVING section
- ✅ Status bar shows `OFFSET: 0.43` (was `LIM: 50%`)
- ✅ Drive Mode presets (Precision/Normal/Sport) only adjust Sensitivity — gain/offset preserved
- ✅ Sliders initialize from server-rendered values

---

## Key Design Decisions

1. **No Double-Scaling**: The `NvidiaRacecar` hardware library has its own internal `steering_gain` and `steering_offset` properties. To avoid the calibration being applied twice, these are set to identity values (`gain=1.0, offset=0.0`), and the formula is applied manually in the drive loop.

2. **Client-Side vs Server-Side Calculation**: The gain/offset formula is applied **server-side** (on the JetRacer) rather than client-side. The web UI sliders send commands which update the JetRacer's internal state. Raw joystick X/Y values are transmitted, and the JetRacer applies calibration before sending to hardware.

3. **Dual Persistence**: Config is saved on **both** the laptop (`steering_config.json`) and the JetRacer (`/home/jetson/steering_config.json`) so that either can reload independently after a restart.

---

## Server Status at Time of Report
- Laptop Proxy (`app.py`): **RUNNING** on port 5001
- JetRacer Mock Server (`jetracer_server.py`): **RUNNING** on port 5000

---

*Report generated on 2026-06-17 by Antigravity AI*
