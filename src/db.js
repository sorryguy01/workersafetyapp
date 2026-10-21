'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { EventEmitter } = require('events');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'safety_logs.db');
const events = new EventEmitter();
const db = new sqlite3.Database(DB_PATH);

let ready;
const opened = new Promise((resolve, reject) => {
  db.once('open', resolve);
  db.once('error', reject);
});
ready = opened;

function all(sql, params = []) {
  return ready.then(
    () =>
      new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
      })
  );
}

function get(sql, params = []) {
  return ready.then(
    () =>
      new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
      })
  );
}

function run(sql, params = []) {
  return ready.then(
    () =>
      new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
          if (err) return reject(err);
          resolve({ lastID: this.lastID, changes: this.changes });
        });
      })
  );
}

async function columns(table) {
  const rows = await all(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

async function addColumn(table, name, definition) {
  const existing = await columns(table);
  if (!existing.has(name)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

async function migrate() {
  await run('PRAGMA journal_mode = WAL');
  await run('PRAGMA foreign_keys = ON');

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

  // Legacy installations may already have incident_logs with a smaller schema.
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
}

async function init() {
  await opened;
  db.configure('busyTimeout', 5000);
  await migrate();
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
    const result = await run(
      `INSERT INTO audit_logs (timestamp, actor, role, category, action, outcome, detail, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.timestamp, row.actor, row.role, row.category, row.action, row.outcome, row.detail, row.ip, row.user_agent]
    );
    const stored = await get('SELECT * FROM audit_logs WHERE id = ?', [result.lastID]);
    events.emit('audit', stored);
    return stored;
  } catch (err) {
    console.error('[AUDIT] Failed to persist audit entry:', err.message);
    return null;
  }
}

async function recordIncident(incident) {
  const timestamp = incident.timestamp || new Date().toISOString();
  const result = await run(
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
  return get('SELECT * FROM incident_logs WHERE id = ?', [result.lastID]);
}

function close() {
  return new Promise((resolve) => db.close(() => resolve()));
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
