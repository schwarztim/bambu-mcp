/**
 * Bambu Lab MQTT Client
 * Based on reverse-engineered protocol from OpenBambuAPI
 * https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md
 */

import * as mqtt from "mqtt";

export interface MQTTConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  deviceId: string;
  useTLS?: boolean;
}

export interface PrinterStatus {
  // Print state
  gcode_state?: string;
  print_type?: string;
  mc_percent?: number;
  mc_remaining_time?: number;
  layer_num?: number;
  total_layer_num?: number;
  subtask_name?: string;

  // Temperatures
  nozzle_temper?: number;
  nozzle_target_temper?: number;
  bed_temper?: number;
  bed_target_temper?: number;
  chamber_temper?: number;

  // Fans
  big_fan1_speed?: string;
  big_fan2_speed?: string;
  cooling_fan_speed?: string;
  heatbreak_fan_speed?: string;

  // Speed
  spd_lvl?: number;
  spd_mag?: number;

  // AMS
  ams?: {
    ams?: Array<{
      id: string;
      humidity: string;
      temp: string;
      tray?: Array<{
        id: string;
        tray_color?: string;
        tray_type?: string;
        remain?: number;
      }>;
    }>;
    ams_exist_bits?: string;
    tray_now?: string;
  };

  // Lights
  lights_report?: Array<{
    node: string;
    mode: string;
  }>;

  // Errors
  print_error?: number;
  hw_switch_state?: number;

  // WiFi
  wifi_signal?: string;

  // Camera
  ipcam?: {
    ipcam_record?: string;
    timelapse?: string;
    resolution?: string;
  };

  // Raw data for anything we don't explicitly type
  [key: string]: any;
}

export class BambuMQTTClient {
  private client: mqtt.MqttClient | null = null;
  private config: MQTTConfig;
  private sequenceId: number = 0;
  private connected: boolean = false;
  private lastStatus: PrinterStatus = {};
  private lastStatusTime: number = 0;

  constructor(config: MQTTConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const options: mqtt.IClientOptions = {
        host: this.config.host,
        port: this.config.port,
        protocol: this.config.useTLS !== false ? "mqtts" : "mqtt",
        username: this.config.username,
        password: this.config.password,
        rejectUnauthorized: false,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
      };

      this.client = mqtt.connect(options);

      this.client.on("connect", () => {
        console.error(
          `Connected to MQTT broker at ${this.config.host}:${this.config.port}`,
        );
        this.connected = true;

        const reportTopic = `device/${this.config.deviceId}/report`;
        this.client!.subscribe(reportTopic, (err) => {
          if (err) {
            console.error(`Failed to subscribe to ${reportTopic}:`, err);
            reject(err);
          } else {
            console.error(`Subscribed to ${reportTopic}`);
            resolve();
          }
        });
      });

      // Cache incoming status reports
      this.client.on("message", (_topic, payload) => {
        try {
          const data = JSON.parse(payload.toString());
          const status = data.print || data.mc_print;
          if (status) {
            this.lastStatus = { ...this.lastStatus, ...status };
            this.lastStatusTime = Date.now();
          }
        } catch {
          // Ignore parse errors on status messages
        }
      });

      this.client.on("error", (err) => {
        console.error("MQTT connection error:", err);
        if (!this.connected) {
          reject(err);
        }
      });

      this.client.on("close", () => {
        this.connected = false;
      });

      this.client.on("reconnect", () => {
        console.error("MQTT reconnecting...");
      });
    });
  }

  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.connected = false;
      this.lastStatus = {};
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  private getNextSequenceId(): string {
    return (this.sequenceId++).toString();
  }

  /**
   * Send a command and optionally wait for a response with matching sequence_id
   */
  private async sendCommand(
    command: string,
    params: any = {},
    waitForResponse = true,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.connected) {
        reject(new Error("MQTT client not connected"));
        return;
      }

      const sequenceId = this.getNextSequenceId();
      const topic = `device/${this.config.deviceId}/request`;
      const [type, cmd] = command.split(".");

      const message = {
        [type]: {
          sequence_id: sequenceId,
          command: cmd,
          ...params,
        },
      };

      if (!waitForResponse) {
        this.client.publish(topic, JSON.stringify(message), (err) => {
          if (err) reject(err);
          else resolve({ sent: true, command });
        });
        return;
      }

      const responseHandler = (_receivedTopic: string, payload: Buffer) => {
        try {
          const response = JSON.parse(payload.toString());
          const responseData = response[type];

          if (responseData && responseData.sequence_id === sequenceId) {
            this.client!.removeListener("message", responseHandler);
            clearTimeout(timer);
            resolve(responseData);
          }
        } catch {
          // Not our response, ignore
        }
      };

      this.client.on("message", responseHandler);

      this.client.publish(topic, JSON.stringify(message), (err) => {
        if (err) {
          this.client!.removeListener("message", responseHandler);
          reject(err);
        }
      });

      const timer = setTimeout(() => {
        this.client!.removeListener("message", responseHandler);
        reject(new Error(`Command '${command}' timed out after 10s`));
      }, 10000);
    });
  }

  // === Status ===

  /**
   * Request full status push from printer, then return cached status.
   * Per OpenBambuAPI: "Refrain from executing pushall at intervals less than
   * 5 minutes on the P1P, as it may cause lag due to hardware limitations."
   */
  async requestStatus(): Promise<PrinterStatus> {
    await this.sendCommand("pushing.pushall", {}, false);
    // Give the printer a moment to send status reports
    await new Promise((r) => setTimeout(r, 2000));
    return this.getCachedStatus();
  }

  /**
   * Return last cached status without sending pushall.
   */
  getCachedStatus(): PrinterStatus {
    return {
      ...this.lastStatus,
      _cached_at: this.lastStatusTime
        ? new Date(this.lastStatusTime).toISOString()
        : null,
      _age_seconds: this.lastStatusTime
        ? Math.round((Date.now() - this.lastStatusTime) / 1000)
        : null,
    };
  }

  /**
   * Get printer version information
   */
  async getVersion(): Promise<any> {
    return this.sendCommand("info.get_version");
  }

  // === Print Control ===

  async stopPrint(): Promise<any> {
    return this.sendCommand("print.stop");
  }

  async pausePrint(): Promise<any> {
    return this.sendCommand("print.pause");
  }

  async resumePrint(): Promise<any> {
    return this.sendCommand("print.resume");
  }

  /**
   * Set print speed (1-166, default 100)
   */
  async setPrintSpeed(speed: number): Promise<any> {
    return this.sendCommand("print.print_speed", { param: speed.toString() });
  }

  /**
   * Execute a single G-code command
   */
  async sendGcode(gcode: string): Promise<any> {
    return this.sendCommand("print.gcode_line", { param: gcode });
  }

  /**
   * Print a .gcode file from local storage
   */
  async printGcodeFile(options: {
    file: string;
    bed_type?: string;
    bed_levelling?: boolean;
    flow_cali?: boolean;
    vibration_cali?: boolean;
    layer_inspect?: boolean;
    timelapse?: boolean;
    use_ams?: boolean;
  }): Promise<any> {
    return this.sendCommand("print.gcode_file", {
      param: options.file,
      subtask_name: options.file,
      bed_type: options.bed_type || "auto",
      bed_levelling: options.bed_levelling !== false,
      flow_cali: options.flow_cali !== false,
      vibration_cali: options.vibration_cali !== false,
      layer_inspect: options.layer_inspect || false,
      timelapse: options.timelapse || false,
      use_ams: options.use_ams !== false,
    });
  }

  /**
   * Print a .3mf file from local storage using project_file command.
   *
   * The 3MF must already be on the printer's SD card (uploaded via FTP).
   * Uses file:///sdcard/ URL format for P1S/P1P/X1/A1 printers.
   *
   * Requires Developer Mode enabled on the printer (Settings → LAN Only → Developer Mode).
   *
   * @param options.file - Filename on SD card (e.g. "model.3mf")
   * @param options.plate - Plate number (1-based, default 1)
   * @param options.ams_mapping - Array mapping print colors to AMS slots.
   *   Index = color in file, value = AMS slot (0-3) or -1 for external spool.
   *   Single color from slot 0: [0]. Two colors: [0, 1].
   */
  async print3mfFile(options: {
    file: string;
    plate?: number;
    ams_mapping?: number[];
    bed_type?: string;
    bed_leveling?: boolean;
    flow_cali?: boolean;
    vibration_cali?: boolean;
    layer_inspect?: boolean;
    timelapse?: boolean;
    use_ams?: boolean;
    subtask_name?: string;
  }): Promise<any> {
    const plate = options.plate || 1;
    const useAms = options.use_ams !== false;
    const amsMapping = options.ams_mapping || [0];

    return this.sendCommand("print.project_file", {
      param: `Metadata/plate_${plate}.gcode`,
      file: options.file,
      url: `file:///sdcard/${options.file}`,
      subtask_name: options.subtask_name || options.file.replace(/\.3mf$/i, ""),
      project_id: "0",
      profile_id: "0",
      task_id: "0",
      subtask_id: "0",
      bed_type: options.bed_type || "auto",
      bed_leveling: options.bed_leveling !== false,
      flow_cali: options.flow_cali !== false,
      vibration_cali: options.vibration_cali !== false,
      layer_inspect: options.layer_inspect || false,
      timelapse: options.timelapse || false,
      use_ams: useAms,
      ams_mapping: amsMapping,
    });
  }

  /**
   * Print a file (auto-detects .3mf vs .gcode)
   */
  async printFile(options: {
    file: string;
    plate?: number;
    ams_mapping?: number[];
    bed_type?: string;
    bed_levelling?: boolean;
    bed_leveling?: boolean;
    flow_cali?: boolean;
    vibration_cali?: boolean;
    layer_inspect?: boolean;
    timelapse?: boolean;
    use_ams?: boolean;
    subtask_name?: string;
  }): Promise<any> {
    if (options.file.toLowerCase().endsWith(".3mf")) {
      return this.print3mfFile({
        ...options,
        bed_leveling: options.bed_leveling ?? options.bed_levelling,
      });
    }
    return this.printGcodeFile({
      ...options,
      bed_levelling: options.bed_levelling ?? options.bed_leveling,
    });
  }

  // === AMS / Filament ===

  async changeFilament(tray: number, targetTemp?: number): Promise<any> {
    const params: any = { target: tray };
    if (targetTemp !== undefined) {
      params.curr_temp = targetTemp;
    }
    return this.sendCommand("print.ams_change_filament", params);
  }

  async unloadFilament(): Promise<any> {
    return this.sendCommand("print.unload_filament");
  }

  // === LED ===

  async setLED(mode: "on" | "off", node?: string): Promise<any> {
    return this.sendCommand("system.ledctrl", {
      led_node: node || "chamber_light",
      led_mode: mode,
    });
  }

  // === Camera ===

  /**
   * Control camera recording
   */
  async setCameraRecording(enabled: boolean): Promise<any> {
    return this.sendCommand("camera.ipcam_record_set", {
      control: enabled ? "enable" : "disable",
    });
  }

  /**
   * Control timelapse recording
   */
  async setTimelapse(enabled: boolean): Promise<any> {
    return this.sendCommand("camera.ipcam_timelapse", {
      control: enabled ? "enable" : "disable",
    });
  }

  // === Hardware Config ===

  async setNozzle(diameter: number): Promise<any> {
    return this.sendCommand("print.set_accessories", {
      accessory_type: "nozzle",
      nozzle_diameter: diameter.toString(),
    });
  }

  /**
   * Skip objects during print (exclude them from being printed)
   */
  async skipObjects(objectIds: number[]): Promise<any> {
    return this.sendCommand("print.skip_objects", {
      obj_list: objectIds,
    });
  }

  // === Firmware ===

  async startUpgrade(
    module: string,
    version: string,
    url: string,
  ): Promise<any> {
    return this.sendCommand("upgrade.start", { module, version, url });
  }
}
