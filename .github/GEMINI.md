# Bambu MCP — AI Agent Rules

These rules govern any AI agent (Gemini, Claude, Copilot, Cursor, etc.) interacting with `bambu-mcp` tools. They encode protocol-level knowledge of Bambu Lab printers, enforce safety invariants, and define behavioral contracts that complement the server-side enforcement in `safety.ts` and `write-protection.ts`.

> **Scope:** These rules apply to agents _consuming_ the MCP tools to operate printers. For agents _developing_ this codebase, see `CLAUDE.md`.

---

## Table of Contents

1. [Write Guard](#1-write-guard)
2. [Printer State Machine](#2-printer-state-machine)
3. [Pre-Print Confirmation Gate](#3-pre-print-confirmation-gate)
4. [AMS Semantics](#4-ams-semantics)
5. [Thermal Safety](#5-thermal-safety)
6. [G-code Safety](#6-g-code-safety)
7. [HMS Error Taxonomy](#7-hms-error-taxonomy)
8. [Camera & Vision](#8-camera--vision)
9. [MakerWorld Pipeline](#9-makerworld-pipeline)
10. [File Operations](#10-file-operations)
11. [Tool Output Visibility](#11-tool-output-visibility)
12. [Read-Before-Write Protocol](#12-read-before-write-protocol)
13. [Autonomy Boundaries](#13-autonomy-boundaries)
14. [MQTT Protocol Awareness](#14-mqtt-protocol-awareness)
15. [Multi-Tool Orchestration](#15-multi-tool-orchestration)

---

## 1. Write Guard

### Server-Side Enforcement

All 17 state-changing tools require `confirmDangerousAction: true`. The server rejects calls without it. This is non-negotiable and cannot be bypassed.

**Dangerous tools (exhaustive list):**

| Tool                  | Effect                                    | Severity     |
| --------------------- | ----------------------------------------- | ------------ |
| `printer_stop`        | Emergency stop — kills active print       | **Critical** |
| `printer_pause`       | Pauses print mid-layer                    | High         |
| `printer_resume`      | Resumes paused print                      | High         |
| `printer_set_speed`   | Changes speed 1-166%                      | Medium       |
| `printer_send_gcode`  | Raw G-code to printer                     | **Critical** |
| `printer_print_file`  | Starts a print job                        | **Critical** |
| `skip_objects`        | Excludes objects mid-print                | High         |
| `ams_change_filament` | AMS filament swap                         | High         |
| `ams_unload_filament` | Retracts filament                         | Medium       |
| `camera_record`       | Enables/disables recording                | Low          |
| `camera_timelapse`    | Enables/disables timelapse                | Low          |
| `led_control`         | Chamber/work light toggle                 | Low          |
| `set_nozzle`          | Changes nozzle diameter config            | Medium       |
| `set_temperature`     | Heats nozzle or bed                       | **Critical** |
| `ftp_upload_file`     | Uploads file to printer SD                | Medium       |
| `makerworld_print`    | Full download→slice→upload→print pipeline | **Critical** |
| `slice_3mf`           | Runs slicer on local file                 | Medium       |

### Agent-Side Contract

1. **Never set `confirmDangerousAction: true` without explicit user permission** in the _current_ conversation turn.
2. Treat user silence, ambiguity, or implied consent as **denial**.
3. Prior approval does not carry forward — each invocation requires fresh consent.
4. If a user says "print this" without specifying parameters, **gather parameters first** — do not execute.
5. For **Critical** severity tools: state what will happen, including irreversible consequences, before asking for confirmation.

---

## 2. Printer State Machine

### `gcode_state` Values

The `gcode_state` field in MQTT status reports is the canonical printer state. Agents must interpret it correctly:

| State     | Meaning                                | Safe to Command?     | Notes                                                  |
| --------- | -------------------------------------- | -------------------- | ------------------------------------------------------ |
| `IDLE`    | No active job                          | Yes                  | Printer is ready                                       |
| `RUNNING` | Print in progress                      | **Write-restricted** | Only pause/stop/speed/skip/LED allowed                 |
| `PAUSE`   | Print paused by user or system         | Yes (limited)        | Resume, stop, or temperature changes                   |
| `FAILED`  | **Last job** failed                    | Yes                  | Printer is idle — `FAILED` is historical, not blocking |
| `FINISH`  | Last job completed                     | Yes                  | Printer is idle                                        |
| `PREPARE` | Preparing to print (heating, leveling) | **No**               | Wait for transition to `RUNNING`                       |
| `SLICING` | Cloud slicing in progress              | **No**               | Wait for completion                                    |

### Critical Rules

- **`FAILED` ≠ broken.** `FAILED` means the previous print failed. The printer is idle and accepts new commands. Do not tell the user the printer is broken or needs intervention unless HMS errors indicate otherwise.
- **`RUNNING` is sacred.** Never start a new print while `gcode_state` is `RUNNING`. The agent must call `printer_stop` (with user confirmation) first.
- **`PREPARE` is transient.** Do not send commands during `PREPARE` — the printer is auto-leveling, heating, or calibrating. Wait for state change.
- **Check `mc_print_stage` for sub-states.** During `RUNNING`, this field indicates: `1` = idle, `2` = printing, `6` = bed leveling, `7` = calibrating, `14` = cleaning nozzle, etc.

---

## 3. Pre-Print Confirmation Gate

Before calling `printer_print_file` or `makerworld_print`, the agent MUST:

### Step 1: Gather State

```
1. Call printer_get_status → verify gcode_state is IDLE/FAILED/FINISH
2. Call ams_filament_mapping → get current AMS slot contents
3. If file is on SD: verify it exists
```

### Step 2: Present Unified Summary

Present ALL parameters in a single message. Never split across turns:

```
Ready to print:
  File:        benchy.3mf
  Format:      3MF (project_file command, requires Developer Mode)
  Plate:       1
  Bed type:    auto
  Timelapse:   off
  Use AMS:     yes
  AMS mapping: [Slot 0: PLA Black → Color 1, Slot 2: PLA White → Color 2]

  Current printer state: IDLE
  Nozzle: 25°C → will heat to ~210°C
  Bed: 25°C → will heat to ~60°C

  Proceed? (yes/no)
```

### Step 3: Execute Only on Explicit "yes"

Anything other than clear affirmation = do not proceed.

### .3mf vs .gcode Detection

- `.3mf` files use the `project_file` MQTT command — requires **Developer Mode** enabled on the printer.
- `.gcode` files use the `gcode_file` command — works without Developer Mode.
- The server auto-detects format. The agent must inform the user if Developer Mode may be required.

---

## 4. AMS Semantics

### Slot Numbering

- AMS units are numbered 0-3 (up to 4 AMS units)
- Each unit has 4 trays numbered 0-3
- Global tray ID = `(ams_id * 4) + tray_id` (0-15 for standard AMS)
- Tray 254 = external spool (no AMS)
- `tray_now: 255` = no filament loaded

### AMS Mapping for `printer_print_file`

The `ams_mapping` array maps **print file colors to AMS slots**:

```
ams_mapping: [0, 1]  →  Color 0 in file → AMS slot 0
                         Color 1 in file → AMS slot 1
```

**Important:** For the raw MQTT `project_file` command, the mapping uses a **reverse-padded 5-element array** with `-1` for unused slots:

- 1 color: `[-1, -1, -1, -1, 0]`
- 2 colors: `[-1, -1, -1, 0, 1]`

The MCP tool handles this translation — agents should use simple `[0, 1]` format.

### Filament Verification

Before printing, always verify via `ams_filament_mapping`:

- The mapped slot actually contains filament (`remain > 0`)
- The filament type matches what the slicer expects (PLA vs PETG vs ABS)
- Temperature ranges are compatible (`nozzle_temp_min`/`nozzle_temp_max`)

**Warn the user** if:

- A mapped slot is empty
- Filament type doesn't match the print profile
- `tag_uid` is all zeros (filament may not be Bambu-branded — RFID unread)

### Bitfield Parsing

```
ams_exist_bits: "1"     → Binary 0001 → AMS unit 0 present
tray_exist_bits: "e"    → Binary 1110 → Trays 1,2,3 occupied (tray 0 empty)
tray_is_bbl_bits: "e"   → Binary 1110 → Trays 1,2,3 are Bambu-branded
tray_read_done_bits: "e" → Binary 1110 → RFID read complete for trays 1,2,3
```

---

## 5. Thermal Safety

### Server-Enforced Limits

| Component | Max Temperature | G-code         | MCP Tool          |
| --------- | --------------- | -------------- | ----------------- |
| Nozzle    | 300°C           | `M104 S{temp}` | `set_temperature` |
| Bed       | 120°C           | `M140 S{temp}` | `set_temperature` |

### Agent Rules

1. **Never heat without purpose.** Do not set temperatures speculatively — only when preparing for a specific filament or print.
2. **Know your filament ranges:**
   - PLA: nozzle 190-240°C, bed 45-65°C
   - PETG: nozzle 220-260°C, bed 70-85°C
   - ABS/ASA: nozzle 240-270°C, bed 90-110°C
   - TPU: nozzle 200-230°C, bed 40-60°C
   - PA/Nylon: nozzle 260-290°C, bed 80-100°C
3. **Cross-check with AMS data.** The AMS reports `nozzle_temp_min` and `nozzle_temp_max` per tray. Use these values, not generic ranges.
4. **Cooling = set to 0.** To cool down, set target to 0°C — the printer will naturally cool. Never send negative temperatures.
5. **Dual-extruder (H2D) awareness.** H2D printers need `M104 S{temp} T{tool}` — the MCP tool handles this, but agents should confirm which extruder is active.

---

## 6. G-code Safety

### Server-Blocked Commands

These G-codes are rejected by `safety.ts` — the agent cannot send them even with `confirmDangerousAction: true`:

| G-code | Purpose              | Why Blocked                          | Use Instead         |
| ------ | -------------------- | ------------------------------------ | ------------------- |
| `M112` | Emergency stop       | Uncontrolled halt, can corrupt state | `printer_stop` tool |
| `M500` | Save to EEPROM       | Persistent config change             | Not needed via MCP  |
| `M501` | Restore from EEPROM  | Could overwrite runtime config       | Not needed via MCP  |
| `M502` | Factory reset        | Destroys all calibration             | Never               |
| `M997` | Firmware update      | Bricking risk                        | Not supported       |
| `M999` | Restart after E-stop | Requires physical verification       | Manual only         |

### Agent G-code Guidelines

1. **Prefer MCP tools over raw G-code.** Every common operation has a dedicated tool. Only use `printer_send_gcode` when no tool exists.
2. **Never chain multiple G-codes** in a single `printer_send_gcode` call. One command per call — verify the result before sending the next.
3. **Never bypass blocks by encoding.** Don't split `M112` as `M11` + `2`, use hex encoding, or any other bypass attempt.
4. **Temperature G-codes are validated.** `M104 S{temp}` and `M140 S{temp}` are checked against safe limits. Use `set_temperature` instead.
5. **Bambu-specific G-codes exist.** Commands like `M620`, `M621` (AMS branch control), `M973` (camera), `M975` (vibration suppression), `M976` (first layer scan) are internal. Do not send these unless you understand the full sequence.
6. **Know the fan codes:** `M106 P1` = part cooling, `M106 P2` = aux fan, `M106 P3` = chamber fan. Values 0-255.

---

## 7. HMS Error Taxonomy

HMS (Health Management System) errors appear in the `hms` array of status reports. Each entry has an `attr` bitfield and a code.

### Interpretation Rules

1. **Empty `hms: []` = healthy.** No errors.
2. **Active vs Historical:** HMS errors reported during `gcode_state: RUNNING` are active and may require intervention. HMS errors persisting after `FAILED`/`FINISH` are historical.
3. **Do not block on historical HMS.** If the printer is `IDLE` with leftover HMS entries, it is still commandable. Inform the user but do not refuse commands.
4. **Common HMS categories:**
   - Filament errors (runout, tangle, AMS feed failure)
   - Temperature errors (thermal runaway, heating failure)
   - Motion errors (homing failure, endstop trigger)
   - Camera/sensor errors (first layer detection, spaghetti detection)

### Agent Response to HMS

- **Filament errors during print:** Inform user, suggest pause. Do not auto-stop unless spaghetti detection triggered.
- **Temperature errors:** Report immediately. These may indicate hardware issues.
- **First layer inspection warnings:** Informational — the printer may auto-pause. Report to user.
- **Spaghetti detection:** If `xcam.print_halt` is true, the printer will auto-stop. Report what happened.

---

## 8. Camera & Vision

### Camera Protocol

The printer camera uses a proprietary TLS protocol on port 6000:

- 80-byte authentication header (not HTTP)
- Streams raw JPEG frames delimited by `0xFFD8` (start) and `0xFFD9` (end) markers
- The `camera_snapshot` tool handles this protocol transparently

### Camera Tools

| Tool               | Effect                       | Notes                    |
| ------------------ | ---------------------------- | ------------------------ |
| `camera_snapshot`  | Captures single JPEG frame   | Returns base64 image     |
| `camera_record`    | Toggles continuous recording | MQTT: `ipcam_record_set` |
| `camera_timelapse` | Toggles timelapse mode       | MQTT: `ipcam_timelapse`  |

### Vision Monitoring (`monitor_start`)

The AI vision monitor runs a background loop that:

1. Captures camera snapshots at configurable intervals
2. Analyzes frames with an AI vision provider (requires `VISION_PROVIDER` env var)
3. Uses strike-based failure detection (configurable threshold)
4. Sends emergency stop on confirmed failure

**Agent rules for vision monitoring:**

- Do not start monitoring without user awareness — it will auto-stop prints on detected failures.
- The vision prompt distinguishes normal artifacts (glue residue, purge blobs, support debris) from actual failures (spaghetti, detachment, printing into air).
- Monitor respects `min_layer` — no analysis before the configured layer to avoid false positives during first-layer adhesion.
- Report monitor status when asked — use `monitor_status` tool.

---

## 9. MakerWorld Pipeline

`makerworld_print` is a multi-stage pipeline: **download → slice → FTP upload → print**.

### Agent Rules

1. **This is the highest-risk tool.** It chains 4 operations, each of which can fail independently.
2. **Requires Firefox DevTools MCP** for browser-assisted download from MakerWorld (Cloudflare protection).
3. **The slicer step** uses OrcaSlicer/BambuStudio CLI with P1S 0.4mm profiles by default.
4. **Present the full pipeline** to the user before execution:

   ```
   MakerWorld print pipeline:
   1. Download 3MF from MakerWorld (browser-assisted)
   2. Slice with OrcaSlicer (P1S 0.4mm profile)
   3. Upload to printer via FTPS
   4. Start print

   This will heat the printer and begin printing. Proceed?
   ```

5. **If any stage fails,** report which stage failed and do not proceed to subsequent stages.

---

## 10. File Operations

### Upload Safety

- Only `.gcode`, `.3mf`, and `.stl` extensions are allowed (enforced by `safety.ts`).
- Remote paths must be relative — no `..` traversal, no absolute paths.
- Files are uploaded via FTPS to port 990 with the printer's access code.

### Agent Rules

1. Verify the local file exists before uploading.
2. After upload, confirm the file appears on the printer by checking SD contents.
3. Do not delete files from the printer SD unless explicitly asked.
4. File paths on the printer SD are relative to the root — e.g., `model.3mf`, not `/sdcard/model.3mf`.

---

## 11. Tool Output Visibility

Users cannot always see raw MCP tool output. The agent MUST reproduce critical information in response text:

### Always Surface

- **Temperatures:** Current and target for nozzle, bed, chamber
- **Print progress:** Percentage, current layer / total layers, remaining time (`mc_remaining_time` in minutes)
- **Errors:** HMS entries, `fail_reason`, `mc_print_error_code`
- **AMS status:** Which slots have filament, types, colors, remaining percentage
- **File operations:** Upload success/failure, file paths
- **Speed:** Current `spd_lvl` (1=silent, 2=standard, 3=sport, 4=ludicrous) and `spd_mag` percentage

### Format for Status Reports

When reporting printer status, use this structure:

```
Printer Status:
  State:     RUNNING (printing)
  Progress:  47% — Layer 89/190
  Time left: ~42 minutes
  Speed:     Standard (100%)

  Nozzle:    210°C / 210°C (target)
  Bed:       60°C / 60°C (target)
  Chamber:   32°C

  AMS:
    Slot 0: PLA Basic Black — 78% remaining
    Slot 1: (empty)
    Slot 2: PLA Basic White — 45% remaining
    Slot 3: PETG HF Orange — 92% remaining

  Alerts: None
  WiFi:   -45 dBm
```

---

## 12. Read-Before-Write Protocol

Before ANY state-changing operation:

| Operation         | Required Reads                                | Why                                                                   |
| ----------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Start print       | `printer_get_status` + `ams_filament_mapping` | Verify idle state, filament availability                              |
| Set temperature   | `printer_get_status`                          | Check current temps, verify not mid-print with different requirements |
| Send G-code       | `printer_get_status`                          | Verify state allows the command                                       |
| Change filament   | `ams_filament_mapping`                        | Verify target slot, current loaded tray                               |
| Upload file       | `printer_get_status`                          | Verify printer is accessible                                          |
| Stop/pause/resume | `printer_get_status`                          | Verify there IS an active/paused print                                |

**Exception:** `printer_get_cached_status` (no MQTT pushall) is acceptable for rapid checks within the same conversation turn if a full status was recently fetched.

---

## 13. Autonomy Boundaries

### Never Do Automatically

- Retry failed write operations
- Start, stop, or pause prints
- Change temperatures
- Send G-code
- Upload files
- Modify AMS settings

### May Do Automatically

- Read status (but don't poll in tight loops)
- Read AMS mapping
- Check cached status
- Take camera snapshots (read-only)
- List files

### Polling Discipline

- **P1 series:** Do not call `printer_get_status` (pushall) more than once per 5 minutes — it causes lag on P1P hardware.
- **X1 series:** Safe to call more frequently, but still respect a 30-second minimum interval.
- Use `printer_get_cached_status` for rapid checks — it returns the last cached MQTT report without sending pushall.
- Never poll in a loop without user awareness. If monitoring is needed, use `monitor_start`.

---

## 14. MQTT Protocol Awareness

Agents don't interact with MQTT directly — the MCP server handles it. But understanding the protocol helps interpret tool responses correctly.

### Key Fields in Status Reports

| Field                  | Type    | Meaning                                                       |
| ---------------------- | ------- | ------------------------------------------------------------- |
| `gcode_state`          | string  | Printer state — see [State Machine](#2-printer-state-machine) |
| `mc_percent`           | number  | Print progress 0-100                                          |
| `mc_remaining_time`    | number  | Minutes remaining                                             |
| `layer_num`            | number  | Current layer                                                 |
| `total_layer_num`      | number  | Total layers in job                                           |
| `gcode_file`           | string  | Current file being printed                                    |
| `subtask_name`         | string  | Human-readable job name                                       |
| `spd_lvl`              | number  | Speed preset (1-4)                                            |
| `spd_mag`              | number  | Speed percentage                                              |
| `nozzle_temper`        | float   | Current nozzle temp                                           |
| `nozzle_target_temper` | float   | Target nozzle temp                                            |
| `bed_temper`           | float   | Current bed temp                                              |
| `bed_target_temper`    | float   | Target bed temp                                               |
| `chamber_temper`       | float   | Current chamber temp                                          |
| `hms`                  | array   | Active HMS errors                                             |
| `lights_report`        | array   | LED states (`chamber_light`, `work_light`)                    |
| `wifi_signal`          | string  | WiFi strength in dBm                                          |
| `nozzle_diameter`      | string  | Current nozzle size                                           |
| `sdcard`               | boolean | SD card present                                               |
| `xcam`                 | object  | Camera AI feature states                                      |

### P1 vs X1 Differences

- **X1 series:** Every status report contains the full object. Safe to read any field at any time.
- **P1 series:** Status reports only contain **changed fields**. The MCP server caches the full state, but agents should be aware that very recent changes may not yet be reflected.

### Message Signing (Post-January 2025 Firmware)

All MQTT commands are signed with RSA-SHA256 using an X.509 certificate extracted from Bambu Connect. The MCP server handles signing transparently. Agents do not need to manage certificates, but should be aware:

- If signing fails, commands will be rejected by the printer
- The `sign_message` cloud API tool can be used for debugging

---

## 15. Multi-Tool Orchestration

### Common Workflows

**"Print a file from MakerWorld":**

```
1. makerworld_download → get 3MF file locally
2. slice_3mf → generate gcode (if needed)
3. ftp_upload_file → put on printer SD
4. printer_get_status → verify IDLE
5. ams_filament_mapping → verify filament
6. [User confirmation gate]
7. printer_print_file → start print
```

**"Check on my print":**

```
1. printer_get_cached_status → quick status
2. camera_snapshot → visual check (if requested)
3. Report status + image to user
```

**"Change filament":**

```
1. ams_filament_mapping → current state
2. [Show user current slots, ask which to change]
3. ams_change_filament → execute swap
```

**"Something went wrong":**

```
1. printer_get_status → full state refresh
2. Check gcode_state, hms array, fail_reason
3. camera_snapshot → visual assessment
4. Report findings with actionable next steps
```

### Error Handling

- If a tool call fails, report the error message verbatim to the user.
- Do not retry the same call — diagnose first.
- If MQTT is disconnected, `printer_get_status` will fail. Suggest the user check network connectivity.
- If FTP upload fails, the server tries `basic-ftp` first, then falls back to system `curl`. Report which method was attempted.

---

## MCP Resources (Read-Only)

The server exposes these resources for agent context:

| URI                            | Contents                                                               |
| ------------------------------ | ---------------------------------------------------------------------- |
| `bambu://printer/status`       | Live MQTT cache (full printer state)                                   |
| `bambu://printer/capabilities` | Speed profiles, temp limits, AMS slots, nozzle types, bed types        |
| `bambu://knowledge/safety`     | Blocked G-codes, temp limits, allowed extensions, dangerous tools list |
| `bambu://knowledge/protocol`   | MQTT topics, camera protocol, FTP details                              |

Agents should read `bambu://knowledge/safety` at session start to confirm current safety rules.

---

_These rules are derived from the [OpenBambuAPI](https://github.com/schwarztim/OpenBambuAPI) protocol documentation and the bambu-mcp server source. Server-side enforcement (safety.ts, write-protection.ts) is the hard safety net. These agent-side rules are the behavioral guardrails._
