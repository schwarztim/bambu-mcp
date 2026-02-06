<div align="center">

# Bambu Lab MCP Server

**Model Context Protocol server for Bambu Lab 3D printers**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-green.svg)](https://modelcontextprotocol.io/)
[![Node](https://img.shields.io/badge/Node-18+-success.svg)](https://nodejs.org/)

_Full control of Bambu Lab printers through Claude AI — MQTT, FTP, camera, AMS, and X.509 auth_

[Features](#features) · [Quick Start](#quick-start) · [Tools](#tools) · [Background](#background)

</div>

---

## Overview

Complete MCP server for Bambu Lab 3D printers (P1P, P1S, X1C, A1, A1 Mini). Connects over local MQTT for real-time control and monitoring, with FTPS file upload and X.509 certificate signing to bypass firmware authentication restrictions.

**25 tools** covering print control, status monitoring, camera, AMS filament management, temperature, LED control, and more.

## Background

In January 2025, Bambu Lab pushed firmware updates requiring authentication for local LAN printer control, [breaking all third-party tools](https://hackaday.com/2025/01/19/bambu-connects-authentication-x-509-certificate-and-private-key-extracted/) — OctoPrint, Home Assistant integrations, custom scripts, everything.

Community researchers extracted the X.509 certificate and private key from the Bambu Connect desktop application, restoring third-party access. This MCP server builds on that work to provide comprehensive printer control through Claude.

**Key references:**

- [Hackaday: Bambu Connect's Authentication X.509 Certificate and Private Key Extracted](https://hackaday.com/2025/01/19/bambu-connects-authentication-x-509-certificate-and-private-key-extracted/) — the article that started the workaround
- [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) — reverse-engineered MQTT protocol documentation
- [bambu-node](https://github.com/THE-SIMPLE-MARK/bambu-node) — TypeScript library for Bambu printers

## Features

- **Local MQTT control** — Print, pause, resume, stop, speed profiles, G-code execution
- **Real-time status** — Continuous caching from MQTT reports with cached + fresh status tools
- **Camera control** — Start/stop recording and timelapse
- **AMS management** — Change filament trays, unload filament
- **FTP file upload** — FTPS upload to printer SD card (port 990)
- **X.509 signing** — Bypass firmware auth restrictions with certificate signing
- **Temperature control** — Set nozzle/bed temps with safety limits
- **Object skipping** — Skip failed objects without stopping the print
- **Speed profiles** — Silent, Standard, Sport, Ludicrous (or raw percentage)
- **LED control** — Chamber and work lights
- **Safety validation** — Blocked G-codes, temperature limits, path traversal prevention

## Quick Start

### Prerequisites

- Node.js 18+
- Bambu Lab printer on your local network
- Printer LAN access code (printer screen -> WLAN -> Access Code)
- Printer serial number (Settings -> Device -> Serial Number)

### Install

```bash
git clone https://github.com/schwarztim/bambu-mcp.git
cd bambu-mcp
npm install
npm run build
```

### Configure

```bash
cp .env.example .env
# Edit .env with your printer IP, access code, and serial number
```

### Register with Claude Code

Add to `~/.claude/user-mcps.json`:

```json
{
  "mcpServers": {
    "bambu-lab": {
      "command": "node",
      "args": ["/path/to/bambu-mcp/dist/index.js"],
      "env": {
        "BAMBU_LAB_MQTT_HOST": "192.168.1.100",
        "BAMBU_LAB_MQTT_PASSWORD": "YOUR_ACCESS_CODE",
        "BAMBU_LAB_DEVICE_ID": "YOUR_SERIAL_NUMBER"
      }
    }
  }
}
```

## Tools

### Cloud API (4 tools)

| Tool                 | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| `get_user_profile`   | Get Bambu Lab cloud account profile                          |
| `list_printers`      | List all printers registered to cloud account                |
| `get_printer_status` | Get printer status via cloud API                             |
| `sign_message`       | Sign message with X.509 certificate for firmware auth bypass |

### Print Control (7 tools)

| Tool                 | Description                                                           |
| -------------------- | --------------------------------------------------------------------- |
| `printer_stop`       | Stop the current print immediately                                    |
| `printer_pause`      | Pause the current print                                               |
| `printer_resume`     | Resume a paused print                                                 |
| `printer_set_speed`  | Set speed via profile (silent/standard/sport/ludicrous) or percentage |
| `printer_send_gcode` | Send G-code command (dangerous commands blocked)                      |
| `printer_print_file` | Start printing a file from printer SD card                            |
| `skip_objects`       | Skip specific objects during multi-object prints                      |

### Status & Info (3 tools)

| Tool                        | Description                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| `printer_get_status`        | Request full status push (temps, progress, AMS, fans, etc.)       |
| `printer_get_cached_status` | Return last cached status (no pushall — use for frequent polling) |
| `printer_get_version`       | Get firmware and module version info                              |

### Camera (2 tools)

| Tool               | Description                        |
| ------------------ | ---------------------------------- |
| `camera_record`    | Enable/disable camera recording    |
| `camera_timelapse` | Enable/disable timelapse recording |

### AMS & Filament (2 tools)

| Tool                  | Description                           |
| --------------------- | ------------------------------------- |
| `ams_change_filament` | Change to a different AMS tray (0-3)  |
| `ams_unload_filament` | Unload current filament from extruder |

### Hardware (3 tools)

| Tool              | Description                                        |
| ----------------- | -------------------------------------------------- |
| `set_temperature` | Set nozzle or bed temperature (with safety limits) |
| `set_nozzle`      | Set nozzle diameter for profile selection          |
| `led_control`     | Control chamber/work LED lights                    |

### Connection & Upload (3 tools)

| Tool              | Description                                 |
| ----------------- | ------------------------------------------- |
| `mqtt_connect`    | Connect to printer via local MQTT over TLS  |
| `mqtt_disconnect` | Disconnect from MQTT                        |
| `ftp_upload_file` | Upload .gcode/.3mf/.stl to printer via FTPS |

## Architecture

```
Claude Code / AI
    |
    v
Bambu Lab MCP Server
  |-- Cloud API (bambulab.com)
  |-- MQTT Client (port 8883, TLS)
  |-- FTP Client (port 990, FTPS)
    |
    v
Bambu Lab Printer (P1P/P1S/X1C/A1)
```

### How It Works

1. **MQTT** connects to the printer over TLS on port 8883 using the LAN access code
2. Status reports are **continuously cached** as they arrive on the MQTT report topic
3. Commands are sent on the MQTT request topic with sequence IDs for response matching
4. **FTP** uploads files to the printer SD card over FTPS (port 990)
5. **X.509 signing** uses the extracted Bambu Connect certificate for authenticated commands

## Configuration

### Environment Variables

| Variable                  | Required  | Description                             |
| ------------------------- | --------- | --------------------------------------- |
| `BAMBU_LAB_MQTT_HOST`     | For MQTT  | Printer IP address                      |
| `BAMBU_LAB_MQTT_PASSWORD` | For MQTT  | LAN access code                         |
| `BAMBU_LAB_DEVICE_ID`     | For MQTT  | Printer serial number                   |
| `BAMBU_LAB_MQTT_PORT`     | No        | MQTT port (default: 8883)               |
| `BAMBU_LAB_MQTT_USERNAME` | No        | MQTT username (default: bblp)           |
| `BAMBU_LAB_COOKIES`       | For cloud | Session cookies for cloud API           |
| `BAMBU_LAB_BASE_URL`      | No        | Cloud API base URL                      |
| `BAMBU_APP_PRIVATE_KEY`   | No        | Override the built-in X.509 private key |
| `BAMBU_APP_CERTIFICATE`   | No        | Override the built-in X.509 certificate |

### Finding Your Printer Info

- **IP Address**: Printer screen → WLAN → IP
- **Access Code**: Printer screen → WLAN → Access Code (8-digit)
- **Serial Number**: Settings → Device → Serial Number

## Security

### X.509 Certificate

This server includes the publicly extracted X.509 certificate from the Bambu Connect desktop application. This is not a secret — it was [publicly disclosed in January 2025](https://hackaday.com/2025/01/19/bambu-connects-authentication-x-509-certificate-and-private-key-extracted/) and is embedded in every copy of Bambu Connect.

The certificate can be overridden via `BAMBU_APP_PRIVATE_KEY` and `BAMBU_APP_CERTIFICATE` environment variables if Bambu Lab rotates credentials.

### Safety Features

- **Blocked G-codes**: M112 (emergency stop), M502 (factory reset), M500/M501 (EEPROM), M997 (firmware update), M999 (restart)
- **Temperature limits**: Nozzle max 300C, bed max 120C
- **File validation**: Only .gcode, .3mf, .stl uploads allowed
- **Path traversal prevention**: No `..` or absolute paths in FTP uploads

### Best Practices

1. Keep printers on a separate VLAN
2. Rotate LAN access codes periodically
3. Never commit `.env` files (already in `.gitignore`)

## Acknowledgments

- **Community researchers** who [extracted the X.509 certificate](https://hackaday.com/2025/01/19/bambu-connects-authentication-x-509-certificate-and-private-key-extracted/) — making this possible
- **[OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI)** — reverse-engineered MQTT protocol docs
- **[Shockedrope/bambu-mcp-server](https://github.com/Shockedrope/bambu-mcp-server)** — speed profile concept
- **[DMontgomery40/mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server)** — multi-printer platform inspiration
- **[bambu-node](https://github.com/THE-SIMPLE-MARK/bambu-node)** — TypeScript Bambu library
- **Bambu Lab** — for making excellent printers (even if the auth lockdown was rough)

## License

MIT — see [LICENSE](LICENSE) for details.

## Disclaimer

Not affiliated with or endorsed by Bambu Lab. Use at your own risk.
