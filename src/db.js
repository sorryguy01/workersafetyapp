'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'safety_logs.db');
const events = new EventEmitter();

/**
 * Node's built-in SQLite (node:sqlite, Node >= 22.5) is compiled into the
 * Node binary itself, so there is no native module to download or link.
 * This removes the prebuilt-binary GLIBC mismatch that made the `sqlite3`
 * package fail on hosts running newer Node builds.
 */
const db = new DatabaseSync(DB_PATH);

function prepareAndRun(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    const info = params.length ? stmt.run(...params) : stmt.run();
    return {
      lastID: Number(info.lastInsertRowid || 0),
      changes: Number(info.changes || 0),
    };
  } finally {
    stmt.close();
  }
}

function prepareAndAll(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    const rows = params.length ? stmt.all(...params) : stmt.all();
    return rows.map((row) => ({ ...row }));
  } finally {
    stmt.close();
  }
}

function prepareAndGet(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    const row = params.length ? stmt.get(...params) : stmt.get();
    return row ? { ...row } : null;
  } finally {
    stmt.close();
  }
}

/**
 * Statement-less helper for schema/DDL statements that cannot be prepared
 * with bound parameters (multiple statements, PRAGMA ... = value, etc).
 */
function exec(sql) {
  db.exec(sql);
  return { lastID: 0, changes: 0 };
}

function all(sql, params = []) {
  return prepareAndAll(sql, params);
}

function get(sql, params = []) {
  return prepareAndGet(sql, params);
}

function run(sql, params = []) {
  if (!params.length && /^\s*(CREATE|ALTER|DROP|PRAGMA|BEGIN|COMMIT|ROLLBACK|UPDATE|DELETE)\b/i.test(sql)) {
    return exec(sql);
  }
  return prepareAndRun(sql, params);
}

function columnsOf(table) {
  const rows = prepareAndAll(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

function addColumn(table, name, definition) {
  const existing = columnsOf(table);
  if (!existing.has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

async function migrate() {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
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

  db.exec(`
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

  db.exec(`
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

  db.exec(`
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

  // Legacy installations may already have a smaller incident_logs schema.
  addColumn('incident_logs', 'timestamp', 'TEXT');
  addColumn('incident_logs', 'details', 'TEXT');
  addColumn('incident_logs', 'severity', "TEXT NOT NULL DEFAULT 'WARNING'");
  addColumn('incident_logs', 'magnitude', 'REAL');
  addColumn('incident_logs', 'accel_x', 'REAL');
  addColumn('incident_logs', 'accel_y', 'REAL');
  addColumn('incident_logs', 'accel_z', 'REAL');
  addColumn('incident_logs', 'temp', 'REAL');
  addColumn('incident_logs', 'gas', 'INTEGER');
  addColumn('incident_logs', 'bpm', 'INTEGER');
  addColumn('incident_logs', 'source', "TEXT NOT NULL DEFAULT 'ESP32'");

  db.exec("UPDATE incident_logs SET severity = 'WARNING' WHERE severity IS NULL OR severity = ''");
  db.exec("UPDATE incident_logs SET source = 'ESP32' WHERE source IS NULL OR source = ''");

  db.exec('CREATE INDEX IF NOT EXISTS idx_incidents_time ON incident_logs (timestamp DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs (timestamp DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_incidents_event ON incident_logs (event_type)');
}

let migrated = false;

async function init() {
  if (migrated) return;
  migrate();
  migrated = true;
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
    const result = run(
      `INSERT INTO audit_logs (timestamp, actor, role, category, action, outcome, detail, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.timestamp, row.actor, row.role, row.category, row.action, row.outcome, row.detail, row.ip, row.user_agent]
    );
    const stored = result.lastID
      ? get('SELECT * FROM audit_logs WHERE id = ?', [result.lastID])
      : null;
    events.emit('audit', stored);
    return stored;
  } catch (err) {
    console.error('[AUDIT] Failed to persist audit entry:', err.message);
    return null;
  }
}

async function recordIncident(incident) {
  const timestamp = incident.timestamp || new Date().toISOString();
  const result = run(
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
  return result.lastID ? get('SELECT * FROM incident_logs WHERE id = ?', [result.lastID]) : null;
}

function close() {
  try {
    db.close();
  } catch (err) {
    console.error('[DB] Close failed:', err.message);
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
