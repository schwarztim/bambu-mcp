# Bambu MCP — AI Agent Safety Rules

These rules apply to any AI agent (Gemini, Claude, Copilot, etc.) interacting with `bambu-mcp` tools. They complement the server-side safety enforcement already built into the MCP server.

## 1. Write Guard — Confirm Before Acting

All state-changing tools require `confirmDangerousAction: true`. The server enforces this, but agents MUST also:

- **Never set `confirmDangerousAction: true` without explicit user permission** in the current conversation turn.
- Treat user silence, ambiguity, or implied consent as **denial**.
- If the user says "print this" without specifying parameters, gather parameters first — do not execute.

### Dangerous tools (server-enforced list):

`printer_stop`, `printer_pause`, `printer_resume`, `printer_set_speed`, `printer_send_gcode`, `printer_print_file`, `skip_objects`, `ams_change_filament`, `ams_unload_filament`, `camera_record`, `camera_timelapse`, `led_control`, `set_nozzle`, `set_temperature`, `ftp_upload_file`, `makerworld_print`

## 2. Pre-Print Confirmation Gate

Before calling `printer_print_file` or `makerworld_print`, present a unified summary for user approval:

```
File: [filename]
Bed type: [type]
AMS mapping: [slot assignments]
Timelapse: [on/off]
Use AMS: [yes/no]
Plate: [number]
```

Do not split this across multiple messages. One summary, one approval.

## 3. Semantic State Awareness

- `FAILED` state means the **last job** failed — the printer is idle and safe to command.
- Distinguish **active** HMS errors (blocking) from **historical** HMS entries (informational).
- `RUNNING` state means a print is active — do not start a new print without stopping/confirming first.
- Always call `printer_status` before any write operation to verify current state.

## 4. G-code Safety

The server blocks dangerous G-codes (`M112`, `M502`, `M500`, `M501`, `M997`, `M999`) and enforces temperature limits (nozzle: 300C, bed: 120C). Agents should:

- Never attempt to bypass these limits by splitting commands.
- Use the dedicated MCP tools (`set_temperature`, `printer_stop`) instead of raw G-code equivalents.
- Explain blocked commands to the user rather than retrying.

## 5. Tool Output Visibility

Always reproduce critical values from tool responses in your reply text:

- Temperatures, print progress, error messages, HMS alerts
- File upload success/failure and paths
- AMS filament status when relevant to the user's request

Users may not see raw tool output — surface what matters.

## 6. Read Before Write

Before any write operation:

1. Call `printer_status` to confirm printer state
2. For prints: call `ams_filament_mapping` to verify filament availability
3. For file operations: call `ftp_list_files` to confirm file exists
4. Present findings to user before proceeding

## 7. No Autonomous Loops

- Do not retry failed write operations automatically.
- Do not poll printer status in a loop without user awareness.
- If a command fails, report the error and wait for user direction.
