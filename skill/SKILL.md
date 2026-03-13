---
name: bambu
description: "Bambu Lab 3D printer control via bambu-mcp MCP server: printer status, print jobs, camera snapshots, AI vision monitoring, AMS filament management, MakerWorld downloads, G-code, temperature control. Use when the user asks about 3D printing, Bambu Lab, filament, AMS, print jobs, slicer, MakerWorld, nozzle, bed temperature, or print monitoring."
argument-hint: "[status|snapshot|monitor|stop]"
homepage: "https://github.com/schwarztim/bambu-mcp"
license: MIT
metadata:
  {
    "openclaw":
      {
        "emoji": "🖨️",
        "tags": ["3d-printer", "bambu-lab", "mqtt", "camera", "ams", "filament", "makerworld", "mcp"],
        "requires": { "bins": ["node"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "shell",
              "command": "npm install -g bambu-mcp",
              "bins": ["bambu-mcp"],
              "label": "Install bambu-mcp MCP server",
            },
          ],
      },
  }
---

# Bambu Lab 3D Printer

Control and monitor Bambu Lab 3D printers via the `bambu-mcp` MCP server. Provides local MQTT control, camera snapshots, AI vision monitoring, AMS filament management, MakerWorld integration, and more.

**Requires**: The `bambu-mcp` MCP server must be running and configured. All tools below are MCP tools.

## When to Use

- User asks about 3D printer status, temperatures, or progress
- User wants to start, pause, stop, or monitor a print
- User asks about filament, AMS trays, or spool changes
- User wants a camera snapshot or to enable timelapse
- User asks about MakerWorld models or wants to download/print one
- User mentions Bambu Lab, P1S, P1P, X1C, A1, or any Bambu printer
- User asks about G-code, nozzle temp, bed temp, or print speed
- User wants AI vision monitoring for print failure detection

## When NOT to Use

- General 3D modeling or CAD questions (not printer control)
- Non-Bambu printers (Prusa, Ender, Voron, etc.)
- Slicer profile tuning beyond what OrcaSlicer CLI supports

## Safety Rules

**CRITICAL — always follow these:**

1. **Never stop or pause a print without explicit user confirmation.** A stopped print cannot be resumed and wastes filament/time.
2. **Never send G-code without understanding what it does.** Blocked commands: `M112` (emergency stop), `M502` (factory reset), `M500`/`M501` (EEPROM), `M997` (firmware update), `M999` (restart).
3. **Temperature limits are enforced** — nozzle max 300°C, bed max 120°C.
4. **Use `printer_get_cached_status` for frequent checks.** Only call `printer_get_status` (full push) at most once every 5 minutes — it can overload the printer.
5. **MQTT connection is exclusive** — only one client at a time. If connection fails, suggest closing BambuStudio, OrcaSlicer, or Home Assistant first.
6. **Confirm before starting prints** — verify filament type/color matches, bed type is correct, and the user is ready.

## Quick Commands

### `/bambu status`
Check printer status: get connection state, print progress, temperatures, AMS filament, and errors.

**Steps:**
1. Call `printer_get_cached_status` (fast) or `printer_get_status` (full refresh)
2. Report: print state, progress %, current/target temps, active filament, errors
3. If not connected, prompt user for IP, access code, and serial number to call `mqtt_connect`

### `/bambu snapshot`
Capture a live camera image from the printer.

**Steps:**
1. Call `camera_snapshot` (uses MQTT-connected printer by default)
2. Display the saved JPEG path to the user
3. Read the image file to show it

### `/bambu monitor`
Start AI vision monitoring to detect print failures automatically.

**Steps:**
1. Confirm MQTT is connected and a print is running
2. Call `monitor_start` with reasonable defaults (60s interval, 3 strikes, min layer 2)
3. Report monitor config to user
4. Periodically check `monitor_status` when asked

### `/bambu stop`
Stop the current print (requires confirmation).

**Steps:**
1. Call `printer_get_cached_status` to show current print state and progress
2. **Ask user to confirm** — warn that stopping is irreversible
3. Only after explicit confirmation, call `printer_stop`

## MCP Tools Reference

### Connection (must do first)

| Tool | Purpose |
|------|---------|
| `mqtt_connect` | Connect to printer via local MQTT. Requires: host (IP), password (LAN access code), device_id (serial). |
| `mqtt_disconnect` | Disconnect from printer. |

### Status & Info

| Tool | Purpose |
|------|---------|
| `printer_get_cached_status` | Fast — returns last cached status. Use for frequent polling. Includes `_age_seconds`. |
| `printer_get_status` | Full refresh — requests new data push. Rate limit: once per 5 min. |
| `printer_get_version` | Get firmware and module versions. |
| `ams_filament_mapping` | Show what filament is in each AMS slot (type, color, remaining %). |

### Print Control

| Tool | Purpose |
|------|---------|
| `printer_print_file` | Start printing a file on the SD card. Supports .3mf and .gcode. Use `ams_mapping` for color-to-slot assignment. 3MF requires Developer Mode. |
| `printer_pause` | Pause current print. |
| `printer_resume` | Resume a paused print. |
| `printer_stop` | Stop current print. **Irreversible — always confirm first.** |
| `printer_set_speed` | Set speed: profiles (`silent`=50%, `standard`=100%, `sport`=125%, `ludicrous`=166%) or manual 1-166%. |
| `printer_send_gcode` | Send raw G-code. Dangerous commands blocked. Temp limits enforced. |
| `skip_objects` | Skip specific objects in a multi-object print by ID. |

### Filament / AMS

| Tool | Purpose |
|------|---------|
| `ams_change_filament` | Switch to AMS tray 0-3. Optionally set target nozzle temp. |
| `ams_unload_filament` | Unload filament from extruder. |

### Camera

| Tool | Purpose |
|------|---------|
| `camera_snapshot` | Capture JPEG from chamber camera via TLS on port 6000. |
| `camera_record` | Enable/disable camera recording. |
| `camera_timelapse` | Enable/disable timelapse for current print. |

### Vision Monitoring

| Tool | Purpose |
|------|---------|
| `monitor_start` | Start AI print monitoring. Captures snapshots + runs vision analysis on interval. 3-strike system before emergency stop. |
| `monitor_status` | Check monitor state: cycle count, last verdict, strike count, failure status. |
| `monitor_stop` | Stop monitoring (does NOT stop the print). |

Requires one of: `AZURE_OPENAI_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`.

### File Transfer & Slicing

| Tool | Purpose |
|------|---------|
| `ftp_upload_file` | Upload .gcode/.3mf/.stl to printer SD card via FTPS (port 990). |
| `slice_3mf` | Slice a 3MF with OrcaSlicer CLI. Auto-detects if already sliced. |

### MakerWorld

| Tool | Purpose |
|------|---------|
| `makerworld_download` | Download 3MF from makerworld.com. Handles Cloudflare blocks with browser-assisted fallback. |
| `makerworld_print` | Download from MakerWorld → slice → upload → print in one step. |

### Hardware & Misc

| Tool | Purpose |
|------|---------|
| `set_temperature` | Set nozzle or bed temp safely (enforces limits). |
| `set_nozzle` | Set nozzle diameter (0.2, 0.4, 0.6, 0.8 mm). |
| `led_control` | Control chamber or logo LED (`on`/`off`). Nodes: `chamber_light`, `work_light`. |

### Cloud API (optional, requires `BAMBU_LAB_COOKIES`)

| Tool | Purpose |
|------|---------|
| `get_user_profile` | Get Bambu Lab cloud account info. |
| `list_printers` | List printers registered to cloud account. |
| `get_printer_status` | Cloud-based status (prefer local MQTT instead). |
| `sign_message` | Sign message with X.509 cert for authenticated communication. |

## Common Workflows

### Check Printer Status
```
1. printer_get_cached_status  (or printer_get_status for fresh data)
2. Report: gcode_state, print progress, temps, AMS, errors
3. If IDLE → "Printer is idle and ready"
   If RUNNING → "Printing [file] — X% complete, ~Y min remaining"
   If PAUSE → "Print is paused at X%"
   If FAILED → "Print failed — [error details]"
```

### Start a Print from Local File
```
1. ftp_upload_file  — upload .gcode or .3mf to printer
2. ams_filament_mapping  — check what filament is loaded
3. Confirm with user: file, filament, bed type
4. printer_print_file  — start the print
5. Optionally: monitor_start  — enable AI monitoring
```

### Print from MakerWorld
```
1. makerworld_download  — download 3MF (may need browser assist for Cloudflare)
2. slice_3mf  — slice if not already sliced
3. ftp_upload_file  — upload to printer
4. printer_print_file  — start printing
   OR use makerworld_print to do all steps at once
```

### Monitor a Running Print
```
1. monitor_start  — begin AI vision monitoring (default: 60s interval, 3 strikes)
2. monitor_status  — check latest verdict and strike count
3. camera_snapshot  — take a manual snapshot to inspect visually
4. monitor_stop  — stop monitoring when print finishes or user requests
```

### Manage Filament
```
1. ams_filament_mapping  — see what's loaded in each tray (type, color, remaining %)
2. ams_change_filament  — switch to a different tray (0-3)
3. ams_unload_filament  — unload current filament
```

## Status Interpretation

### `gcode_state` Values
- `IDLE` — Printer is idle, ready for new jobs
- `RUNNING` — Actively printing
- `PAUSE` — Print is paused (can resume)
- `FINISH` — Print completed successfully
- `FAILED` — Print failed (check `print_error`)
- `PREPARE` — Preparing to print (heating, leveling)

### Temperatures
- **Nozzle**: PLA ~200-220°C, PETG ~230-250°C, ABS ~240-260°C
- **Bed**: PLA ~55-60°C, PETG ~70-80°C, ABS ~90-110°C
- **Chamber**: Relevant for ABS/ASA (enclosed chamber helps)

### AMS Tray Data
- `tray_type`: Filament type (PLA, PETG, ABS, TPU, etc.)
- `tray_color`: Hex color `#RRGGBB`
- `remain`: Remaining filament percentage (0-100)
- `tray_now`: Currently active tray number

### Speed Levels
- `spd_lvl`: 1=silent, 2=standard, 3=sport, 4=ludicrous
- `spd_mag`: Actual speed percentage (50-166)

## Troubleshooting

### "MQTT connection failed"
- Check printer IP is correct and reachable (`ping <ip>`)
- Verify LAN access code from printer touchscreen (Network → LAN Access Code)
- Close competing clients: BambuStudio, OrcaSlicer, Home Assistant
- Only one MQTT connection allowed per printer

### "Cloudflare blocked" (MakerWorld)
- Use browser-assisted download: `makerworld_download` returns step-by-step instructions
- Or manually download in browser and provide the file path via `download_path` parameter

### "Developer Mode required" (3MF printing)
- Enable on printer: Settings → LAN Only → Developer Mode
- Only needed for .3mf files; .gcode works without it

### Stale cached status
- `_age_seconds` in cached status shows data freshness
- If age > 60s, consider calling `printer_get_status` for a fresh push
- If age > 300s, printer may have disconnected
