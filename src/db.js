'use strict';

/**
 * SQLite access layer built on Node's built-in `node:sqlite` module.
 *
 * `node:sqlite` ships inside the Node binary, so there is no native addon to
 * compile or download. That is what removes the glibc-dependent
 * `node_sqlite3.node` binding that previously crashed on some hosts.
 *
 * The API here mirrors the legacy callback driver (`all`/`get`/`run`) so the
 * rest of the application does not care which driver is underneath.
 *
 * Notes on `node:sqlite` semantics this file depends on:
 *   - `DatabaseSync#exec(sql)` runs statements but returns `undefined`.
 *   - `StatementSync#all(...)` / `#get(...)` / `#run(...)` bind positionally.
 *   - `#run()` returns `{ changes, lastInsertRowid }`; there is no
 *     `lastID`/`changes` property and no `finalize()` method.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

let sqlite;
try {
  sqlite = require('node:sqlite');
} catch (err) {
  throw new Error(
    `This application requires Node.js 24 or newer (built-in "node:sqlite" module is missing). ` +
      `Detected ${process.version}. Set NODE_VERSION=24 on your host. Original error: ${err.message}`
  );
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'safety_logs.db');
const events = new EventEmitter();

// Make sure the parent directory exists; SQLite will not create it.
try {
  fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
} catch {
  /* directory already exists or is not creatable here — open() will report it */
}

const db = new sqlite.DatabaseSync(DB_PATH);

// Prepared statements are reused per unique SQL string (the app issues a small,
// fixed set of queries). This is both faster and avoids re-parsing on 10 Hz
// telemetry writes.
const statements = new Map();

function prepare(sql) {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

/**
 * node:sqlite only accepts null/number/string/bigint/Buffer bindings.
 * Normalise the few JavaScript types the application passes in.
 */
function normalize(params = []) {
  return params.map((value) => {
    if (value === undefined) return null;
    if (value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    return value;
  });
}

function plain(row) {
  return row ? { ...row } : null;
}

function all(sql, params = []) {
  try {
    return prepare(sql).all(...normalize(params)).map((row) => ({ ...row }));
  } catch (err) {
    console.error('[DB] query failed:', err.message, '\n       SQL:', sql.replace(/\s+/g, ' ').trim());
    throw err;
  }
}

function get(sql, params = []) {
  try {
    return plain(prepare(sql).get(...normalize(params)));
  } catch (err) {
    console.error('[DB] query failed:', err.message, '\n       SQL:', sql.replace(/\s+/g, ' ').trim());
    throw err;
  }
}

function run(sql, params = []) {
  try {
    // Statements with no result set (DDL, INSERT, UPDATE, DELETE).
    const result = prepare(sql).run(...normalize(params));
    return {
      lastID: Number(result.lastInsertRowid ?? 0),
      changes: Number(result.changes ?? 0),
    };
  } catch (err) {
    console.error('[DB] statement failed:', err.message, '\n       SQL:', sql.replace(/\s+/g, ' ').trim());
    throw err;
  }
}

async function columns(table) {
  const rows = all(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

async function addColumn(table, name, definition) {
  const existing = await columns(table);
  if (!existing.has(name)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

async function migrate() {
  // WAL keeps readers (dashboard polling) from blocking the 10 Hz writer.
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch (err) {
    console.warn('[DB] WAL mode unavailable, continuing in default journal mode:', err.message);
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  await run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'observer')),
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      actor TEXT NOT NULL,
      role TEXT,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT,
      ip TEXT,
      user_agent TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS incident_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT,
      severity TEXT NOT NULL DEFAULT 'WARNING',
      magnitude REAL,
      accel_x REAL,
      accel_y REAL,
      accel_z REAL,
      temp REAL,
      gas INTEGER,
      bpm INTEGER,
      source TEXT NOT NULL DEFAULT 'ESP32'
    )
  `);

  await addColumn('incident_logs', 'timestamp', 'TEXT');
  await addColumn('incident_logs', 'details', 'TEXT');
  await addColumn('incident_logs', 'severity', "TEXT NOT NULL DEFAULT 'WARNING'");
  await addColumn('incident_logs', 'magnitude', 'REAL');
  await addColumn('incident_logs', 'accel_x', 'REAL');
  await addColumn('incident_logs', 'accel_y', 'REAL');
  await addColumn('incident_logs', 'accel_z', 'REAL');
  await addColumn('incident_logs', 'temp', 'REAL');
  await addColumn('incident_logs', 'gas', 'INTEGER');
  await addColumn('incident_logs', 'bpm', 'INTEGER');
  await addColumn('incident_logs', 'source', "TEXT NOT NULL DEFAULT 'ESP32'");

  await run(`UPDATE incident_logs SET severity = 'WARNING' WHERE severity IS NULL OR severity = ''`);
  await run(`UPDATE incident_logs SET source = 'ESP32' WHERE source IS NULL OR source = ''`);
  await run('CREATE INDEX IF NOT EXISTS idx_incidents_time ON incident_logs (timestamp DESC)');
  await run('CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs (timestamp DESC)');
  await run('CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at)');
  await run('CREATE INDEX IF NOT EXISTS idx_incidents_event ON incident_logs (event_type)');

  await writeAudit({
    actor: 'SYSTEM',
    role: 'system',
    category: 'SYSTEM',
    action: 'SCHEMA_READY',
    outcome: 'SUCCESS',
    detail: `SQLite schema migrated at ${DB_PATH}`,
  });
}

// Migrations are idempotent and must run exactly once per process before any
// query touches the tables. Concurrent callers share the same promise.
let ready = null;

function init() {
  if (!ready) {
    ready = migrate().catch((err) => {
      ready = null; // allow a later retry (e.g. transient disk error)
      throw err;
    });
  }
  return ready;
}

async function writeAudit(entry) {
  const row = {
    timestamp: new Date().toISOString(),
    actor: entry.actor || 'SYSTEM',
    role: entry.role || null,
    category: entry.category || 'SYSTEM',
    action: String(entry.action || 'UNKNOWN').slice(0, 64),
    outcome: entry.outcome || 'SUCCESS',
    detail: entry.detail ? String(entry.detail).slice(0, 500) : null,
    ip: entry.ip || null,
    user_agent: entry.userAgent ? String(entry.userAgent).slice(0, 300) : null,
  };

  try {
    const { lastID } = await run(
      `INSERT INTO audit_logs (timestamp, actor, role, category, action, outcome, detail, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.timestamp, row.actor, row.role, row.category, row.action, row.outcome, row.detail, row.ip, row.user_agent]
    );
    const stored = await get('SELECT * FROM audit_logs WHERE id = ?', [lastID]);
    events.emit('audit', stored);
    return stored;
  } catch (err) {
    console.error('[AUDIT] Failed to persist audit entry:', err.message);
    return null;
  }
}

async function recordIncident(incident) {
  const timestamp = incident.timestamp || new Date().toISOString();
  const { lastID } = await run(
    `INSERT INTO incident_logs
      (timestamp, event_type, details, severity, magnitude, accel_x, accel_y, accel_z, temp, gas, bpm, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      timestamp,
      incident.eventType,
      incident.details || null,
      incident.severity || 'WARNING',
      incident.magnitude ?? null,
      incident.ax ?? null,
      incident.ay ?? null,
      incident.az ?? null,
      incident.temp ?? null,
      incident.gas ?? null,
      incident.bpm ?? null,
      incident.source || 'ESP32',
    ]
  );
  return get('SELECT * FROM incident_logs WHERE id = ?', [lastID]);
}

function close() {
  try {
    statements.clear();
    db.close();
  } catch (err) {
    console.error('[DB] close failed:', err.message);
  }
  return Promise.resolve();
}

module.exports = {
  dbPath: DB_PATH,
  events,
  init,
  all,
  get,
  run,
  writeAudit,
  recordIncident,
  close,
};
