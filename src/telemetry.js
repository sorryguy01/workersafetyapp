'use strict';

const { EventEmitter } = require('events');
const db = require('./db');

const THRESHOLDS = {
  impact: 22.0, // m/s²
  gyro: 250.0, // °/s
  gas: 1800, // MQ-2 ADC
  temp: 42.0, // °C
  bpmHigh: 140,
  bpmLow: 45,
};

const BOOT_STEPS = [
  { label: 'CPU & Power-On Self-Test', detail: 'ESP32-WROOM-32E · dual-core 240 MHz' },
  { label: 'Flash & SPIFFS Integrity', detail: '4 MB flash · wear-levelling OK' },
  { label: 'I²C Bus & IMU Probe', detail: 'MPU-6050 @ 0x68 · ±16 g range' },
  { label: 'Vital Signs Sensor', detail: 'MAX30102 PPG @ 0x57' },
  { label: 'Environment & Gas Array', detail: 'DHT11 · MQ-2 · flame IR' },
  { label: 'Safety I/O & Alarm', detail: 'GPIO 27 interrupt · buzzer relay armed' },
  { label: 'Telemetry Uplink', detail: 'UART 115200 · 10 Hz framed stream' },
];

const INCIDENT_COOLDOWN_MS = 12_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clampNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function classifyLine(line) {
  const upper = line.toUpperCase();
  if (/\[?(ERR|ERROR|FAIL|FAULT)\]?/.test(upper)) return 'ERR';
  if (/\[?(WARN|WARNING|CRITICAL|ALERT)\]?/.test(upper)) return 'WARN';
  if (/\[?(OK|PASS|READY|SUCCESS)\]?/.test(upper)) return 'OK';
  if (/\[?(CMD|COMMAND|ADMIN)\]?/.test(upper)) return 'CMD';
  if (/\[?(BOOT|POST|BIOS)\]?/.test(upper)) return 'BOOT';
  if (/\[?(SIM|SIMULATION)\]?/.test(upper)) return 'SIM';
  return 'INFO';
}

class TelemetryHub extends EventEmitter {
  constructor() {
    super();
    this.portPath = process.env.SERIAL_PORT || 'COM6';
    this.baudRate = Number(process.env.SERIAL_BAUD || 115200);
    this.startedAt = Date.now();
    this.connected = false;
    this.streaming = false;
    this.simulation = false;
    this.simulationAuto = false;
    this.buzzer = false;
    this.rebooting = false;
    this.packets = 0;
    this.lastSample = null;
    this.lastSampleAt = 0;
    this.lastError = '';
    this.serialAttempted = false;
    this.serialAttemptedLogged = false;
    this.port = null;
    this.parser = null;
    this.connecting = false;
    this.watchdog = null;
    this.serialRetry = null;
    this.simTimer = null;
    this.simTick = 0;
    this.bootRun = 0;
    this.boot = {
      steps: BOOT_STEPS.map((step, index) => ({ index, ...step, status: 'pending' })),
      startedAt: null,
      complete: false,
    };
    this.biosHistory = [];
    this.cooldowns = new Map();
    this.autoDemo = process.env.SIM_AUTO_DEMO !== 'false';
    this.demoQueue = ['GAS', 'IMPACT', 'FIRE', 'HEAT', 'SOS', 'HR'];
    this.demoCursor = 0;
    this.nextDemoAt = Date.now() + 90_000;
    this.hazards = {
      gasUntil: 0,
      fireUntil: 0,
      sosUntil: 0,
      impactUntil: 0,
      heatUntil: 0,
      bpmUntil: 0,
      bpmValue: 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Logging & snapshots                                                */
  /* ------------------------------------------------------------------ */

  log(line, level = 'INFO') {
    const entry = {
      ts: new Date().toISOString(),
      line: String(line).slice(0, 600),
      level: level || 'INFO',
    };
    this.biosHistory.push(entry);
    if (this.biosHistory.length > 250) this.biosHistory.shift();
    this.emit('bios', entry);
    return entry;
  }

  statusSnapshot() {
    return {
      connected: Boolean(this.connected && this.streaming),
      serialConnected: Boolean(this.connected),
      simulation: this.simulation,
      simulationAuto: this.simulationAuto,
      port: this.portPath,
      baud: this.baudRate,
      buzzer: this.buzzer,
      packets: this.packets,
      rebooting: this.rebooting,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      lastSampleAt: this.lastSampleAt ? new Date(this.lastSampleAt).toISOString() : null,
      lastError: this.lastError || null,
      thresholds: THRESHOLDS,
      serverTime: new Date().toISOString(),
    };
  }

  bootSnapshot() {
    return {
      steps: this.boot.steps.map((step) => ({ ...step })),
      startedAt: this.boot.startedAt,
      complete: this.boot.complete,
    };
  }

  emitStatus() {
    const snapshot = this.statusSnapshot();
    this.emit('status', snapshot);
    return snapshot;
  }

  emitBoot() {
    const snapshot = this.bootSnapshot();
    this.emit('boot_state', snapshot);
    return snapshot;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  async start() {
    this.log(`[SYSTEM] Safety controller service online · PID ${process.pid}`, 'OK');
    this.log(`[SYSTEM] Safety thresholds armed · impact ${THRESHOLDS.impact} m/s² · gas ${THRESHOLDS.gas} ADC · heat ${THRESHOLDS.temp} °C`, 'INFO');

    this.simTimer = setInterval(() => this.tickSimulation(), 100);
    this.simTimer.unref();

    await this.attemptSerial();
    if (!this.connected && !this.simulation) {
      this.setSimulation(true, {
        auto: true,
        reason: `No ESP32 telemetry link on ${this.portPath} — simulation fallback engaged`,
      });
    }

    await this.runBootSequence();
  }

  stop() {
    clearInterval(this.simTimer);
    clearTimeout(this.serialRetry);
    clearTimeout(this.watchdog);
    this.bootRun += 1;
    if (this.port) {
      try {
        this.port.removeAllListeners();
        if (this.port.isOpen) this.port.close(() => {});
      } catch {
        /* ignore */
      }
      this.port = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Serial bridge                                                      */
  /* ------------------------------------------------------------------ */

  async attemptSerial() {
    if (this.connecting || (this.port && this.port.isOpen)) return this.connected;
    this.connecting = true;
    this.serialAttempted = true;

    let SerialPort;
    let ReadlineParser;
    try {
      ({ SerialPort } = require('serialport'));
      ({ ReadlineParser } = require('@serialport/parser-readline'));
    } catch (err) {
      this.lastError = `serialport unavailable: ${err.message}`;
      this.log(`[SERIAL] Driver unavailable — ${err.message}`, 'ERR');
      this.connecting = false;
      return false;
    }

    let opened = false;
    try {
      const port = new SerialPort({
        path: this.portPath,
        baudRate: this.baudRate,
        autoOpen: false,
        hupcl: false,
      });
      const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

      port.on('error', (err) => {
        this.lastError = err.message;
        this.log(`[SERIAL ERROR] ${err.message}`, 'ERR');
      });
      port.on('close', () => {
        this.connected = false;
        this.streaming = false;
        clearTimeout(this.watchdog);
        this.log(`[SERIAL] Uplink closed — ${this.portPath} disconnected`, 'WARN');
        this.emitStatus();
        this.port = null;
        this.scheduleSerialRetry();
      });
      parser.on('data', (line) => this.handleLine(line));

      await new Promise((resolve) => {
        port.open((err) => {
          if (err) {
            this.lastError = err.message;
            if (!this.serialAttemptedLogged) {
              this.log(`[SERIAL] ${this.portPath} not available — ${err.message}`, 'WARN');
              this.serialAttemptedLogged = true;
            }
            try {
              port.removeAllListeners();
            } catch {
              /* ignore */
            }
            this.port = null;
            resolve();
            return;
          }
          opened = true;
          this.port = port;
          this.parser = parser;
          this.connected = true;
          this.lastError = '';
          this.serialAttemptedLogged = false;
          this.log(`[SERIAL] ${this.portPath} @ ${this.baudRate} baud opened — waiting for framed telemetry`, 'OK');
          if (this.simulation) {
            this.simulation = false;
            this.simulationAuto = false;
            this.log('[SIM] Physical ESP32 detected — simulation disabled, switching to live telemetry', 'OK');
          }
          this.emitStatus();
          resolve();
        });
      });
    } catch (err) {
      this.lastError = err.message;
      this.log(`[SERIAL] Link failure — ${err.message}`, 'ERR');
    }

    this.connecting = false;
    if (!opened) {
      this.scheduleSerialRetry();
    }
    return opened;
  }

  scheduleSerialRetry() {
    if (this.serialRetry) return;
    this.serialRetry = setTimeout(async () => {
      this.serialRetry = null;
      if (this.port && this.port.isOpen) return;
      const opened = await this.attemptSerial();
      if (opened) {
        this.log('[SERIAL] Telemetry link restored', 'OK');
        this.emitStatus();
      }
    }, 20_000);
    this.serialRetry.unref?.();
  }

  handleLine(rawLine) {
    const line = String(rawLine).replace(/\r/g, '').trim().slice(0, 600);
    if (!line) return;

    if (this.port && this.port.isOpen) this.armWatchdog();

    let sample = null;
    if (line.startsWith('{')) {
      try {
        const json = JSON.parse(line);
        if (json && typeof json === 'object') sample = json;
      } catch {
        /* fall through to log */
      }
    }

    if (!sample) {
      const parts = line.split(',');
      if ((parts.length === 12 || parts.length === 9) && !Number.isNaN(parseFloat(parts[0]))) {
        sample = this.parseFramedSample(parts);
      }
    }

    if (sample) {
      if (!this.simulation) this.ingest(sample, 'ESP32');
      return;
    }

    this.log(line, classifyLine(line));
  }

  parseFramedSample(parts) {
    if (parts.length === 12) {
      return {
        x: parts[0],
        y: parts[1],
        z: parts[2],
        gx: parts[3],
        gy: parts[4],
        gz: parts[5],
        temp: parts[6],
        hum: parts[7],
        gas: parts[8],
        bpm: parts[9],
        flame: parts[10],
        sos: parts[11],
      };
    }
    return {
      x: parts[0],
      y: parts[1],
      z: parts[2],
      gx: 0,
      gy: 0,
      gz: 0,
      temp: parts[3],
      hum: parts[4],
      gas: parts[5],
      bpm: parts[6],
      flame: parts[7],
      sos: parts[8],
    };
  }

  armWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.streaming && !this.simulation) {
        this.streaming = false;
        this.log('[WATCHDOG] Telemetry stream stalled — check ESP32 UART link', 'WARN');
        this.emitStatus();
      }
    }, 3000);
  }

  async writeSerial(command) {
    if (!this.port || !this.port.isOpen) {
      return { ok: false, error: `ESP32 serial link offline (${this.portPath})` };
    }
    const line = String(command).replace(/[\r\n]+/g, ' ').slice(0, 120);
    return new Promise((resolve) => {
      this.port.write(`${line}\n`, (err) => {
        if (err) return resolve({ ok: false, error: err.message });
        resolve({ ok: true });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Telemetry ingestion & incidents                                    */
  /* ------------------------------------------------------------------ */

  ingest(sample, source) {
    if (this.rebooting) return;
    const x = clampNumber(sample.x ?? sample.ax);
    const y = clampNumber(sample.y ?? sample.ay);
    const z = clampNumber(sample.z ?? sample.az);
    const gx = clampNumber(sample.gx);
    const gy = clampNumber(sample.gy);
    const gz = clampNumber(sample.gz);
    const magnitude = Math.sqrt(x * x + y * y + z * z);
    const gyroMag = Math.sqrt(gx * gx + gy * gy + gz * gz);

    const payload = {
      x,
      y,
      z,
      gx,
      gy,
      gz,
      magnitude,
      gyroMag,
      temp: clampNumber(sample.temp),
      hum: clampNumber(sample.hum),
      gas: Math.round(clampNumber(sample.gas)),
      bpm: Math.round(clampNumber(sample.bpm)),
      flame: clampNumber(sample.flame) >= 1 ? 1 : 0,
      sos: clampNumber(sample.sos) >= 1 ? 1 : 0,
      buzzer: this.buzzer,
      source,
      seq: ++this.packets,
      ts: new Date().toISOString(),
    };

    this.lastSample = payload;
    this.lastSampleAt = Date.now();
    if (this.port && this.port.isOpen && !this.streaming) {
      this.streaming = true;
      this.emitStatus();
    }

    this.emit('telemetry', payload);
    this.evaluate(payload);
  }

  evaluate(sample) {
    const incidents = [];

    if (sample.sos === 1) {
      incidents.push({
        eventType: 'SOS_PANIC',
        severity: 'CRITICAL',
        details: 'Emergency SOS switch pressed by worker',
      });
    }
    if (sample.flame === 1) {
      incidents.push({
        eventType: 'FIRE_DETECTED',
        severity: 'CRITICAL',
        details: 'Infrared flame sensor triggered',
      });
    }
    if (sample.gas > THRESHOLDS.gas) {
      incidents.push({
        eventType: 'GAS_SMOKE_HAZARD',
        severity: 'CRITICAL',
        details: `MQ-2 ADC ${sample.gas} exceeds ${THRESHOLDS.gas} threshold`,
      });
    }
    if (sample.magnitude > THRESHOLDS.impact) {
      incidents.push({
        eventType: 'HIGH_IMPACT_FALL',
        severity: 'CRITICAL',
        details: `Impact ${sample.magnitude.toFixed(1)} m/s² exceeds ${THRESHOLDS.impact} threshold`,
      });
    }
    if (sample.gyroMag > THRESHOLDS.gyro) {
      incidents.push({
        eventType: 'VIOLENT_ROTATION',
        severity: 'WARNING',
        details: `Angular rate ${sample.gyroMag.toFixed(1)} °/s exceeds ${THRESHOLDS.gyro} °/s`,
      });
    }
    if (sample.temp > THRESHOLDS.temp) {
      incidents.push({
        eventType: 'HEAT_STRESS',
        severity: 'WARNING',
        details: `Ambient ${sample.temp.toFixed(1)} °C exceeds ${THRESHOLDS.temp} °C`,
      });
    }
    if (sample.bpm > 0 && (sample.bpm > THRESHOLDS.bpmHigh || sample.bpm < THRESHOLDS.bpmLow)) {
      incidents.push({
        eventType: 'CARDIAC_STRESS',
        severity: 'WARNING',
        details: `Heart rate ${sample.bpm} BPM outside safe band ${THRESHOLDS.bpmLow}-${THRESHOLDS.bpmHigh}`,
      });
    }

    incidents.forEach((incident) => this.raiseIncident(incident, sample));
  }

  async raiseIncident(incident, sample) {
    const now = Date.now();
    if (now - (this.cooldowns.get(incident.eventType) || 0) < INCIDENT_COOLDOWN_MS) return;
    this.cooldowns.set(incident.eventType, now);

    try {
      const row = await db.recordIncident({
        ...incident,
        timestamp: new Date().toISOString(),
        magnitude: sample.magnitude,
        ax: sample.x,
        ay: sample.y,
        az: sample.z,
        temp: sample.temp,
        gas: sample.gas,
        bpm: sample.bpm,
        source: sample.source === 'SIM' ? 'SIMULATION' : 'ESP32',
      });
      this.log(`[ALERT] ${incident.eventType} · ${incident.details}`, 'WARN');
      this.emit('incident', row);
    } catch (err) {
      this.log(`[DB] Failed to persist incident: ${err.message}`, 'ERR');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Simulation                                                         */
  /* ------------------------------------------------------------------ */

  setSimulation(enabled, options = {}) {
    const next = Boolean(enabled);
    if (this.simulation === next && !options.force) return this.statusSnapshot();
    this.simulation = next;
    this.simulationAuto = next ? Boolean(options.auto) : false;
    this.streaming = false;

    if (next) {
      this.log(
        `[SIM] ${options.reason || 'Simulation mode enabled by administrator'} — realistic 6-axis IMU + vitals stream @ 10 Hz`,
        'SIM'
      );
      this.emitStatus();
    } else {
      this.lastError = '';
      this.log('[SIM] Simulation stopped — awaiting physical ESP32 telemetry', 'INFO');
      this.emitStatus();
      this.scheduleSerialRetry();
    }
    return this.statusSnapshot();
  }

  tickSimulation() {
    if (!this.simulation || this.rebooting) return;
    if (!this.boot.complete) return;

    this.simTick += 0.16;
    const t = this.simTick;
    const now = Date.now();
    const random = (amount) => (Math.random() - 0.5) * amount;

    let x = Math.sin(t) * 0.62 + random(0.18);
    let y = Math.cos(t * 0.8) * 0.48 + random(0.18);
    let z = 9.81 + Math.sin(t * 2) * 0.55 + random(0.15);
    let gx = Math.cos(t) * 14.5 + random(1.2);
    let gy = Math.sin(t * 0.8) * 11.2 + random(1.2);
    let gz = Math.sin(t * 0.4) * 6.8 + random(0.8);
    let temp = 31.2 + Math.sin(t * 0.05) * 0.6 + random(0.08);
    let hum = 64 + Math.cos(t * 0.05) * 2;
    let gas = 430 + Math.sin(t * 0.2) * 35 + random(16);
    let bpm = 78 + Math.sin(t * 0.1) * 4 + random(1);
    let flame = 0;
    let sos = 0;

    if (now < this.hazards.gasUntil) {
      gas = 2380 + Math.sin(t * 3) * 90 + random(30);
    }
    if (now < this.hazards.fireUntil) {
      flame = 1;
    }
    if (now < this.hazards.sosUntil) {
      sos = 1;
    }
    if (now < this.hazards.impactUntil) {
      x += 6.5;
      y += 4.2;
      z += 23.5;
      gx += 190;
      gy += 140;
      gz += 80;
    }
    if (now < this.hazards.heatUntil) {
      temp = 47.4 + Math.sin(t * 0.9) * 0.4;
    }
    if (now < this.hazards.bpmUntil) {
      bpm = this.hazards.bpmValue || 152;
    }

    // Occasionally stage a demonstration incident so the simulator exercises
    // the full detection → SQLite → dashboard pipeline.
    if (this.autoDemo && now >= this.nextDemoAt && !this.activeHazard()) {
      // Cycle deterministically through the hazard catalogue instead of
      // repeating one alert type during long unattended demos.
      const choice = this.demoQueue[this.demoCursor % this.demoQueue.length];
      this.demoCursor += 1;
      this.injectHazard(choice);
      this.nextDemoAt = now + 120_000;
    }

    this.ingest(
      {
        x: Number(x.toFixed(3)),
        y: Number(y.toFixed(3)),
        z: Number(z.toFixed(3)),
        gx: Number(gx.toFixed(2)),
        gy: Number(gy.toFixed(2)),
        gz: Number(gz.toFixed(2)),
        temp: Number(temp.toFixed(1)),
        hum: Math.round(hum),
        gas: Math.round(Math.max(0, gas)),
        bpm: Math.round(bpm),
        flame,
        sos,
      },
      'SIM'
    );
  }

  activeHazard() {
    const now = Date.now();
    return Object.entries(this.hazards).some(([key, value]) => key.endsWith('Until') && value > now);
  }

  injectHazard(kind) {
    if (!this.simulation) {
      return { ok: false, error: 'Virtual hazard injection requires simulation mode.' };
    }
    const now = Date.now();
    const label = String(kind || '').toUpperCase();
    switch (label) {
      case 'GAS':
      case 'GAS_LEAK':
        this.hazards.gasUntil = now + 8000;
        this.log('[SIM] Injecting gas leak — MQ-2 ADC ramping above 1800', 'SIM');
        return { ok: true, message: 'Simulated MQ-2 gas leak staged for 8s.' };
      case 'FIRE':
      case 'FLAME':
        this.hazards.fireUntil = now + 7000;
        this.log('[SIM] Injecting flame event — IR sensor triggered', 'SIM');
        return { ok: true, message: 'Simulated flame event staged for 7s.' };
      case 'SOS':
      case 'PANIC':
        this.hazards.sosUntil = now + 8000;
        this.log('[SIM] Injecting SOS panic switch press', 'SIM');
        return { ok: true, message: 'Simulated SOS panic for 8s.' };
      case 'IMPACT':
      case 'FALL':
        this.hazards.impactUntil = now + 1200;
        this.log('[SIM] Injecting high-impact fall — acceleration spike > 22 m/s²', 'SIM');
        return { ok: true, message: 'Simulated fall impact spike injected.' };
      case 'HEAT':
        this.hazards.heatUntil = now + 10_000;
        this.log('[SIM] Injecting heat stress — ambient above 42 °C', 'SIM');
        return { ok: true, message: 'Simulated heat stress staged for 10s.' };
      case 'HR':
      case 'BPM':
        this.hazards.bpmUntil = now + 9000;
        this.hazards.bpmValue = 154;
        this.log('[SIM] Injecting cardiac stress — heart rate 154 BPM', 'SIM');
        return { ok: true, message: 'Simulated tachycardia staged for 9s.' };
      case 'NORMAL':
      case 'CLEAR':
        Object.keys(this.hazards).forEach((key) => {
          if (key.endsWith('Until')) this.hazards[key] = 0;
        });
        this.log('[SIM] All virtual hazards cleared', 'SIM');
        return { ok: true, message: 'Simulated hazards cleared.' };
      case 'AUTO':
        this.autoDemo = !this.autoDemo;
        this.nextDemoAt = Date.now() + 45_000;
        this.log(`[SIM] Automatic demo incidents ${this.autoDemo ? 'enabled' : 'disabled'}`, 'SIM');
        return { ok: true, message: `Automatic demo incidents ${this.autoDemo ? 'enabled' : 'disabled'}.` };
      default:
        return { ok: false, error: 'Unknown simulation event. Use GAS, FIRE, SOS, IMPACT, HEAT, HR, NORMAL or AUTO.' };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Boot / admin controls                                              */
  /* ------------------------------------------------------------------ */

  async runBootSequence() {
    const runId = ++this.bootRun;
    this.boot = {
      steps: BOOT_STEPS.map((step, index) => ({ index, ...step, status: 'pending' })),
      startedAt: new Date().toISOString(),
      complete: false,
    };
    this.emitBoot();
    this.log(
      `[BOOT] ESP32 cold-boot POST initiated (${this.simulation ? 'simulated node' : this.portPath})`,
      'BOOT'
    );

    for (let index = 0; index < this.boot.steps.length; index += 1) {
      if (runId !== this.bootRun) return this.bootSnapshot();
      const step = this.boot.steps[index];
      step.status = 'running';
      this.emit('boot_step', { ...step });
      this.emitBoot();
      await sleep(index === 0 ? 420 : 300);
      if (runId !== this.bootRun) return this.bootSnapshot();
      step.status = 'ok';
      this.emit('boot_step', { ...step });
      this.log(`[POST] ${String(index + 1).padStart(2, '0')}/07 ${step.label} ........ OK`, 'OK');
    }

    if (runId !== this.bootRun) return this.bootSnapshot();
    this.boot.complete = true;
    this.emitBoot();
    this.log('[BOOT] Runtime engaged · safety supervisor armed · telemetry 10 Hz', 'OK');
    this.log('[SYSTEM] Type HELP in the command console for virtual simulator commands', 'INFO');
    this.emitStatus();
    return this.bootSnapshot();
  }

  bypassBios(actor = 'ADMIN') {
    this.bootRun += 1;
    this.boot.steps.forEach((step) => {
      step.status = 'ok';
      this.emit('boot_step', { ...step });
    });
    this.boot.complete = true;
    this.boot.startedAt = this.boot.startedAt || new Date().toISOString();
    this.emitBoot();
    this.log(`[BOOT] POST bypassed by ${actor} — jumping directly to runtime`, 'WARN');
    if (this.port && this.port.isOpen) this.writeSerial('F');
    this.emitStatus();
    return this.bootSnapshot();
  }

  async reboot(actor = 'ADMIN') {
    if (this.rebooting) return { ok: false, error: 'Reboot already in progress.' };
    this.rebooting = true;
    this.emitStatus();
    this.log(`[SYSTEM] Reboot requested by ${actor} — restarting ESP32 node`, 'WARN');
    if (this.port && this.port.isOpen) this.writeSerial('REBOOT');
    await sleep(450);
    await this.runBootSequence();
    this.rebooting = false;
    this.emitStatus();
    return { ok: true };
  }

  setBuzzer(enabled) {
    this.buzzer = Boolean(enabled);
    this.log(`[ALARM] Audible buzzer ${this.buzzer ? 'ENERGISED' : 'silenced'}`, this.buzzer ? 'WARN' : 'OK');
    if (this.port && this.port.isOpen) this.writeSerial(this.buzzer ? 'ALARM_ON' : 'ALARM_OFF');
    this.emitStatus();
    return this.buzzer;
  }

  async handleCommand(rawCommand, actor = 'ADMIN') {
    const allowedCommands = [
      'HELP', 'STATUS', 'SIM GAS', 'SIM FIRE', 'SIM SOS',
      'SIM IMPACT', 'SIM HEAT', 'SIM HR', 'SIM NORMAL', 'SIM AUTO',
      'ALARM_ON', 'ALARM_OFF', 'REBOOT', 'BYPASS'
    ];
    const command = String(rawCommand || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
    if (!command) return { ok: false, error: 'Command is empty.' };
    const upper = command.toUpperCase();
    // Allowlist check: only pre‑approved SIM/admin/UART commands may be forwarded
    const isAllowed = allowedCommands.some((c) => c.toUpperCase() === upper) || upper.startsWith('SIM ');
    if (!isAllowed) {
      this.log(`[ERR] ${actor} → Rejected disallowed command: ${command}`, 'ERR');
      return { ok: false, error: `Disallowed command: ${command}` };
    }
    this.log(`[CMD] ${actor} → ${command}`, 'CMD');

    if (upper === 'HELP' || upper === '?') {
      return {
        ok: true,
        message:
          'Virtual: HELP · STATUS · SIM GAS|FIRE|SOS|IMPACT|HEAT|HR|NORMAL|AUTO · ALARM_ON/OFF · REBOOT · BYPASS. Other input is forwarded to the ESP32 UART.',
        lines: [
          'SIM GAS      stage MQ-2 gas leak for 8s',
          'SIM FIRE     stage IR flame event for 7s',
          'SIM SOS      stage panic switch for 8s',
          'SIM IMPACT   stage >22 m/s² fall spike',
          'SIM HEAT     stage >42 °C heat stress',
          'SIM HR       stage 154 BPM cardiac stress',
          'SIM NORMAL   clear all virtual hazards',
          'ALARM_ON / ALARM_OFF · REBOOT · BYPASS',
        ],
      };
    }

    if (upper === 'STATUS') {
      const status = this.statusSnapshot();
      const message = `Mode=${status.simulation ? 'SIMULATION' : status.connected ? 'ONLINE' : 'OFFLINE'} · packets=${status.packets} · buzzer=${status.buzzer ? 'ON' : 'OFF'} · port=${status.port}`;
      return { ok: true, message };
    }

    if (upper === 'ALARM_ON' || upper === 'BUZZER_ON') {
      this.setBuzzer(true);
      return { ok: true, message: 'Buzzer energised.' };
    }
    if (upper === 'ALARM_OFF' || upper === 'BUZZER_OFF') {
      this.setBuzzer(false);
      return { ok: true, message: 'Buzzer silenced.' };
    }
    if (upper === 'REBOOT' || upper === 'RESET') {
      this.reboot(actor).catch((err) => this.log(`[ERR] Reboot failed: ${err.message}`, 'ERR'));
      return { ok: true, message: 'Reboot sequence initiated.' };
    }
    if (upper === 'BYPASS' || upper === 'F') {
      this.bypassBios(actor);
      return { ok: true, message: 'BIOS POST bypassed.' };
    }
    if (upper.startsWith('SIM ') || upper === 'SIM') {
      if (!this.simulation) {
        return { ok: false, error: 'Simulation mode is off. Enable Simulate Data first.' };
      }
      return this.injectHazard(upper.slice(3).trim());
    }

    const write = await this.writeSerial(command);
    if (!write.ok) {
      this.log(`[ERR] ${write.error}`, 'ERR');
      return { ok: false, error: write.error };
    }
    return { ok: true, message: `Command transmitted to ESP32: ${command}` };
  }
}

module.exports = { TelemetryHub, THRESHOLDS, BOOT_STEPS };
