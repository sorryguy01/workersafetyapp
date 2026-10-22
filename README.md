# AI Worker Safety & Telemetry System

A secure, full-stack control room for an ESP32-based worker safety node. It combines live 6-axis IMU telemetry, vitals, environmental sensors, fire/gas detection, an SOS panic channel, SQLite incident forensics, and an administrator audit trail.

The frontend is a single-page industrial dashboard (Tailwind CSS via CDN, Chart.js, Socket.IO) served by a Node.js/Express backend. **All privileged actions are enforced server-side**, not merely hidden in the UI.

---

## Quick start

```bash
cd WorkerSafetyApp
npm install
npm start
```

Open **http://localhost:3000**.

> The server ignores `PORT=0` or non-numeric values and falls back to `3000`, so `npm start` works even when the host environment exports `PORT=0`. Set `PORT` explicitly to use another valid port.

### Seeded accounts (demo)

| Login ID | Role | Default password | Capabilities |
|---|---|---|---|
| `admin` | Administrator | `Admin@ESP32!` | Full control, serial console, simulation, reboot, audit trail |
| `observer` | Observer | `Observer@ESP32!` | Read-only telemetry, incidents; no control APIs or audit table |

**Rotate both passwords before any real deployment:**

```bash
npm run set-password -- admin "A-long-new-password"
npm run set-password -- observer "Another-long-password"
```

Password rotation revokes that account's active sessions and writes a `PASSWORD_ROTATED` audit entry. Passwords are stored as salted scrypt hashes, never in plaintext.

---

## Features

### Security & access control
- Login gate protects the dashboard; unauthenticated API and Socket.IO access is rejected (`401`).
- **RBAC enforced in middleware:** observer accounts receive `403` on `/api/control` even if they forge a request; every denial is audited as `PRIVILEGE_DENIED`.
- Salted **scrypt** password hashing with constant-time verification and dummy-hash timing defense for unknown users.
- Server-side sessions stored in SQLite; only a SHA-256 token hash is persisted. HttpOnly + SameSite=Lax cookie.
- Login lockout after 5 failed attempts for 5 minutes, per IP + login ID.
- **CSRF tokens** required on all state-changing routes; mutation requests are also same-origin checked.
- Login attempts, logouts, commands, buzzer changes, simulation toggles, BIOS bypasses, reboots, CSRF rejections, cross-origin blocks, and privilege denials are written to `audit_logs`.
- Security headers: CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, COOP.
- Socket channel authenticates the session cookie on handshake and revalidates expiry every 30 s.

### Operations
- Live status badge for **ESP32 Online**, **ESP32 Offline / unplugged**, and **Simulation Mode**.
- Admin controls: Simulate Data, Bypass BIOS, Buzzer ON/OFF, Reboot ESP, custom serial command input.
- Sensor cards: accelerometer (3-axis + resultant + G-force, red pulse over 22 m/s²), gyroscope (roll/pitch/yaw + angular magnitude), MAX30102 heart rate, SOS panic with flashing alarm state, DHT11 temperature/humidity, MQ-2 gas/smoke (>1800 hazard), flame sensor.
- Persistent safety-state banner derived from live readings: **NOMINAL**, **ATTENTION**, or **HAZARD**, with the active hazard chips and count. It shows **NO DATA** when the uplink drops and **DATA STALE** after five seconds without a frame, so frozen values are never presented as safe.
- Dual 10 Hz Chart.js streams with a 15-second rolling window, neon glow rendering, and impact threshold line.
- ESP32 7-step POST checklist with live status, plus a scrolling monospace BIOS/serial monitor.
- SQLite incident history with **ALL / CRITICAL / WARNING** severity filters and counts, plus a separate admin audit trail tab with telemetry snapshot, source, IP and outcome.
- Control-room affordances: fullscreen wall-display toggle, visible keyboard focus rings, padded touch targets on coarse-pointer devices, and a mobile layout that releases the sticky header.
- Responsive layout for desktop, tablet and phone.

### Simulation
If no ESP32 is found on the configured serial port, the server automatically falls back to a realistic simulator so the dashboard is usable immediately (status badge clearly shows **Simulation Mode**). If hardware is later detected, the simulator stops and live telemetry takes over.

Virtual console commands (simulation must be ON):

```
HELP                     list commands
STATUS                   report link, mode and packet count
SIM GAS                  stage MQ-2 gas hazard for 8 s
SIM FIRE                 stage IR flame event for 7 s
SIM SOS                  stage panic switch for 8 s
SIM IMPACT               stage >22 m/s² fall spike
SIM HEAT                 stage >42 °C heat stress
SIM HR                   stage 154 BPM cardiac stress
SIM NORMAL               clear staged hazards
SIM AUTO                 toggle periodic demo incidents
ALARM_ON / ALARM_OFF     control buzzer relay
REBOOT                   restart node + replay POST
BYPASS                   force runtime, skip POST checks
```

Any other command is forwarded to the ESP32 UART as-is (admin only, max 120 chars, CR/LF stripped).

---

## Architecture

```
WorkerSafetyApp/
├── server.js               Express app, authenticated REST + Socket.IO fan-out
├── src/
│   ├── db.js               SQLite schema/migrations, incident + audit persistence
│   ├── auth.js             Scrypt login, sessions, CSRF, RBAC middleware, lockout
│   ├── security.js         Crypto primitives (scrypt, random tokens, timing-safe eq)
│   └── telemetry.js        Serial bridge, simulator, POST sequence, incident detection
├── public/index.html       Single-page dashboard shell + styles (strict-CSP, no inline JS)
├── public/js/app.js        Dashboard client: login, Socket.IO, charts, REST calls
├── public/js/theme-boot.js Pre-paint theme bootstrap
├── public/js/tailwind.config.js  Tailwind Play CDN theme tokens
├── scripts/set-password.js Credential rotation CLI
├── safety_logs.db          SQLite database (created on first boot)
└── package.json
```

### SQLite tables
- `admins` — username, display name, role, password hash/salt, timestamps.
- `sessions` — token hash, CSRF token, admin id, expiry, IP, user agent.
- `incident_logs` — timestamp, event type, details, severity, magnitude, axes, temp, gas, BPM, source.
- `audit_logs` — timestamp, actor, role, category, action, outcome, detail, IP, user agent.

Foreign key cascade deletes sessions when an account is removed. Indexes cover timestamps, event type and expiry.

### REST API

| Method | Route | Access | Purpose |
|---|---|---|---|
| POST | `/api/login` | Public + same-origin | Authenticate, set HttpOnly session cookie |
| POST | `/api/logout` | Session + CSRF | Revoke session, write audit entry |
| GET | `/api/session` | Session | Restore user + CSRF token |
| GET | `/api/incidents?limit=` | Session | Incident ledger (max 200) |
| GET | `/api/audit?limit=` | **Admin** | Audit ledger (max 500) |
| POST | `/api/control` | **Admin** + CSRF | `simulate`, `bypass`, `buzzer`, `reboot`, `command` |
| GET | `/api/health` | Public | Liveness probe |

### Socket.IO events
`snapshot`, `telemetry`, `status`, `bios`, `boot_state`, `boot_step`, `incident` → authenticated clients; `audit` → admin room only; `session_expired` forces re-authentication.

---

## ESP32 integration

Configure the serial device:

```bash
SERIAL_PORT=COM6 npm start          # Windows
SERIAL_PORT=/dev/ttyUSB0 npm start  # Linux
SERIAL_BAUD=115200 npm start
```

Accepted telemetry line formats (newline terminated, 115200 baud default):

```
# 12 channels
ax,ay,az,gx,gy,gz,temp,hum,gas,bpm,flame,sos

# 9 channels (gyro omitted; defaults to 0)
ax,ay,az,temp,hum,gas,bpm,flame,sos

# JSON line
{"x":0.1,"y":0.2,"z":9.8,"gx":3,"gy":4,"gz":5,"temp":31,"hum":60,"gas":420,"bpm":78,"flame":0,"sos":0}
```

Non-numeric lines are treated as BIOS/serial log output and streamed to the terminal. Startup POST messages printed by the firmware appear in the same console. A 3-second watchdog marks the stream offline if data stops; reconnect attempts continue every 20 seconds.

### Thresholds
| Rule | Trigger | Incident | Severity |
|---|---|---|---|
| Impact | magnitude > 22 m/s² | `HIGH_IMPACT_FALL` | CRITICAL |
| Rotation | angular rate > 250 °/s | `VIOLENT_ROTATION` | WARNING |
| Gas | MQ-2 ADC > 1800 | `GAS_SMOKE_HAZARD` | CRITICAL |
| Heat | temp > 42 °C | `HEAT_STRESS` | WARNING |
| Flame | digital 1 | `FIRE_DETECTED` | CRITICAL |
| SOS | digital 1 | `SOS_PANIC` | CRITICAL |
| Heart rate | >140 or <45 BPM | `CARDIAC_STRESS` | WARNING |

Incidents are de-duplicated per event type for 12 seconds.

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `SERIAL_PORT` | `COM6` | ESP32 serial device; set to your port |
| `SERIAL_BAUD` | `115200` | UART baud rate |
| `SESSION_TTL_HOURS` | `8` | Session lifetime |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS |
| `TRUST_PROXY` | `false` | Set `true` if behind one trusted reverse proxy |
| `SEED_ADMIN_PASSWORD` | `Admin@ESP32!` | Only used when the DB has no accounts |
| `SEED_OBSERVER_PASSWORD` | `Observer@ESP32!` | Only used on initial seed |
| `SIM_AUTO_DEMO` | `true` | Periodic demo incidents in simulation |
| `DB_PATH` | `./safety_logs.db` | Override database location |

---

## Deploying to Render

The repo ships a `render.yaml` Blueprint, so a deploy is one click:

1. Open `https://render.com/deploy?repo=https://github.com/sorryguy01/workersafetyapp`
2. Approve the Blueprint, then type values for `SEED_ADMIN_PASSWORD` and `SEED_OBSERVER_PASSWORD` when prompted.
3. Render builds with `npm ci --omit=dev --omit=optional`, starts with `node server.js`, and health-checks `/api/health`. `--omit=optional` skips `serialport`, so the build host never runs `node-gyp`; the app falls back to simulator mode on its own.

The Blueprint pins `NODE_VERSION=24`. The app stores data through Node's built-in `node:sqlite`
module, which is compiled into the Node binary itself — there is **no** native npm package to build,
so hosts with newer glibc no longer fail with `GLIBC_2.38 not found`.

> Render's filesystem is ephemeral: `safety_logs.db` resets on every deploy or restart. That is fine
> for a demo (accounts reseed automatically), but move to a managed database before keeping
> production audit history.

---

## Production checklist

1. Serve over HTTPS (`COOKIE_SECURE=true`, TLS at a reverse proxy).
2. Rotate both seeded passwords with `npm run set-password`.
3. Replace the Tailwind CDN with a compiled build; the CDN is intended for development and is flagged by its own console warning.
4. Tighten the CSP `script-src` once inline scripts/CDN are removed.
5. Back up `safety_logs.db` (and its `-wal` file) on a schedule; restrict filesystem permissions.
6. Set `TRUST_PROXY=true` only when running behind a trusted single proxy, or rate limiting becomes IP-spoofable.
7. Put a reverse proxy / WAF in front of the Node process for TLS termination and volumetric protection.
8. Review audit logs regularly; forward them to a remote log sink if required by policy.
9. The serial console executes arbitrary text on the UART by design. Keep the administrator account strictly controlled.

## Notes

- This project is a safety-awareness demonstrator, not a certified life-safety system. Do not rely on it as the sole alarm path for hazardous work.
- The bundled `safety_logs.db` may contain simulated incidents and audit records produced during validation. To start with a clean ledger, stop the server and remove `safety_logs.db`; accounts are reseeded on next boot.
- The simulator auto-fallback is deliberate so the dashboard can be evaluated without an ESP32. The status badge never claims a hardware link when one does not exist.
- Persistence uses Node's built-in `node:sqlite` (Node 24+). `serialport` is an optional dependency: if it is missing or fails to build, the app logs `serialport unavailable` in the status panel and stays in simulator mode instead of crashing.
