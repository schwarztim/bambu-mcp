# Bambu Lab MQTT Protocol Reference

> Captured from Bambu Handy app (v3.x) communicating with a P1S printer  
> Protocol: MQTT over TLS (port 8883)  
> See also: [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI)

## Connection

| Parameter | Value |
|-----------|-------|
| Host | Printer LAN IP |
| Port | 8883 (MQTT over TLS) |
| Username | `bblp` |
| Password | Printer LAN access code (8-digit from printer screen) |
| TLS | Required, self-signed cert (skip verification) |
| Client ID | Arbitrary |
| Keep-alive | 60s |

## Topics

### Report Topic (Printer → App)

```
device/{serialNumber}/report
```

The printer continuously publishes status reports on this topic. Reports include temperature, print progress, AMS filament state, fan speeds, and more.

### Request Topic (App → Printer)

```
device/{serialNumber}/request
```

Commands are sent to the printer on this topic.

## Authentication Flow

Post-January 2025 firmware requires X.509 certificate authentication:

1. App calls `GET /v1/iot-service/api/user/applications/{appToken}/cert?aes256={encrypted}` to get a device certificate
2. Certificate is used to sign MQTT command payloads
3. Signed payloads include RSA_SHA256 signatures in a `header` object

### Signed Message Format

```json
{
  "user_id": "3469901296",
  "print": {
    "command": "push_status",
    "sequence_id": "2039"
  },
  "header": {
    "sign_ver": "v1.0",
    "sign_alg": "RSA_SHA256",
    "sign_string": "<base64-RSA-signature>",
    "cert_id": "<hex-cert-id>CN=<serial>.bambulab.com",
    "payload_len": 225
  }
}
```

### Certificate Exchange

The `cert_id` format is: `{hex_fingerprint}CN={serialNumber}.bambulab.com`

Example:
```
77bcfb6303214f046175eb6681a46d83CN=GLOF3813734089.bambulab.com
```

Multiple certificates can be active simultaneously — the app requests `app_cert_list` to enumerate valid certs.

## Commands (App → Printer)

### Security Commands

#### `app_cert_list`

Request list of valid application certificates.

```json
{
  "security": {
    "sequence_id": "2040",
    "command": "app_cert_list",
    "timestamp": 1772675132281,
    "type": "app"
  }
}
```

**Response:**

```json
{
  "security": {
    "sequence_id": "2040",
    "command": "app_cert_list",
    "timestamp": 1772675132281,
    "type": "app",
    "cert_ids": [
      "9bed8c27b4bf69582d58f11abaaad99fCN=GLOF3813734089.bambulab.com",
      "77bcfb6303214f046175eb6681a46d83CN=GLOF3813734089.bambulab.com"
    ]
  }
}
```

### Print Commands

#### `extrusion_cali_sel`

Select filament for extrusion calibration.

```json
{
  "print": {
    "ams_id": 0,
    "cali_idx": -1,
    "command": "extrusion_cali_sel",
    "filament_id": "GFL99",
    "nozzle_diameter": "0.4",
    "nozzle_volume_type": "normal",
    "sequence_id": "2039",
    "timestamp": 1772675132270,
    "tray_id": 3
  }
}
```

### Media/Connection Commands

The app also uses the **TUTK** (ThroughTek Kalay) protocol for P2P camera streaming and the **MediaStore** service for media management.

#### TUTK Messages

TUTK provides peer-to-peer connectivity for camera streaming:

```json
{
  "json": {
    "cmdtype": 256,
    "sequence": 2376,
    "notify": {
      "topic": "device/01P00C5A1002021/report",
      "size": 243
    }
  },
  "data_length": 243
}
```

## Report Messages (Printer → App)

### Status Report

Printer sends regular status reports containing:

```json
{
  "print": {
    "bed_temper": 60.0,
    "nozzle_temper": 220.0,
    "mc_percent": 45,
    "mc_remaining_time": 120,
    "gcode_state": "RUNNING",
    "layer_num": 42,
    "total_layer_num": 150,
    "fan_gear": 12,
    "wifi_signal": "-55dBm"
  }
}
```

### AMS Report

AMS (Automatic Material System) filament status:

```json
{
  "print": {
    "ams": {
      "ams": [{
        "id": "0",
        "humidity": "3",
        "temp": "25.0",
        "tray": [{
          "id": "0",
          "tray_type": "PLA",
          "tray_color": "FFFFFFFF",
          "tray_info_idx": "GFL99",
          "remain": 85,
          "nozzle_temp_min": 190,
          "nozzle_temp_max": 230
        }]
      }]
    }
  }
}
```

## Filament IDs

| ID | Material |
|-----|----------|
| `GFL99` | Bambu PLA Basic |
| `GFL98` | Bambu PLA Matte |
| `GFB99` | Bambu PETG Basic |
| `GFN99` | Bambu PA6-CF |
| `GFS99` | Bambu Support W |
| `GFU99` | Bambu TPU 95A |

## Sequence IDs

Every command includes a `sequence_id` (string-encoded integer) for request-response correlation. The app increments this monotonically.

## Timestamps

All timestamps are Unix epoch in **milliseconds** (e.g., `1772675132281`).

## Discovery Method

This protocol documentation was captured from the Bambu Handy Flutter app using:
- `adb logcat -s flutter:*` — Flutter Dio interceptor logs all MQTT message contents
- Frida MQTT hooks on the native MQTT client library
- Packet analysis of TLS-encrypted MQTT sessions
