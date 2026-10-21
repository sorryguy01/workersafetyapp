'use strict';

const db = require('./db');
const {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256,
  safeEqual,
  DUMMY_SALT,
  DUMMY_HASH,
} = require('./security');

const COOKIE_NAME = 'wsid';
const SESSION_TTL_MS = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 8)) * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

// ip|username -> { fails, lockedUntil }
const attempts = new Map();

function parseCookies(header = '') {
  const jar = {};
  String(header)
    .split(';')
    .forEach((part) => {
      const index = part.indexOf('=');
      if (index < 0) return;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key) jar[key] = decodeURIComponent(value);
    });
  return jar;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    lastLoginAt: row.last_login_at || null,
  };
}

async function ensureSeeded() {
  const existing = await db.get('SELECT COUNT(*) AS count FROM admins');
  if (existing && existing.count > 0) return;

  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin@ESP32!';
  const observerPassword = process.env.SEED_OBSERVER_PASSWORD || 'Observer@ESP32!';
  const now = new Date().toISOString();

  const admin = await hashPassword(adminPassword);
  const observer = await hashPassword(observerPassword);

  await db.run(
    `INSERT INTO admins (username, display_name, role, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['admin', 'Control Room Administrator', 'admin', admin.hash, admin.salt, now]
  );
  await db.run(
    `INSERT INTO admins (username, display_name, role, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['observer', 'Safety Observer', 'observer', observer.hash, observer.salt, now]
  );

  await db.writeAudit({
    actor: 'SYSTEM',
    role: 'system',
    category: 'SYSTEM',
    action: 'ADMIN_ACCOUNTS_SEEDED',
    outcome: 'SUCCESS',
    detail: 'Default administrator and observer accounts provisioned',
  });

  console.warn('[AUTH] Seeded default accounts. Change the seed passwords before deployment.');
}

function cookieOptions(req) {
  const secure = process.env.COOKIE_SECURE === 'true' || req.secure;
  return {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
  };
}

function serializeCookie(name, value, options, maxAgeSeconds) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`, `SameSite=${options.sameSite}`];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, token, cookieOptions(req), Math.floor(SESSION_TTL_MS / 1000)));
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', cookieOptions(req), 0));
}

async function createSession(req, user) {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const now = Date.now();
  await db.run(
    `INSERT INTO sessions (token_hash, admin_id, csrf_token, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      sha256(token),
      user.id,
      csrfToken,
      new Date(now).toISOString(),
      new Date(now + SESSION_TTL_MS).toISOString(),
      req.ip || null,
      (req.get('user-agent') || '').slice(0, 300),
    ]
  );
  return { token, csrfToken };
}

async function resolveSession(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  const row = await db.get(
    `SELECT s.token_hash, s.csrf_token, s.expires_at, s.ip, s.user_agent,
            a.id, a.username, a.display_name, a.role, a.last_login_at
       FROM sessions s
       JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = ?`,
    [sha256(token)]
  );

  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', [row.token_hash]);
    return null;
  }

  return {
    session: {
      tokenHash: row.token_hash,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      ip: row.ip,
      userAgent: row.user_agent,
    },
    user: publicUser(row),
  };
}

function clientContext(req) {
  return {
    ip: req.ip || req.socket?.remoteAddress || 'unknown',
    userAgent: (req.get('user-agent') || '').slice(0, 300),
  };
}

async function login(req, username, password) {
  const context = clientContext(req);
  const normalized = String(username || '').trim();
  const key = `${context.ip}|${normalized.toLowerCase()}`;
  const now = Date.now();
  const record = attempts.get(key);

  if (record && record.lockedUntil > now) {
    const retryAfter = Math.ceil((record.lockedUntil - now) / 1000);
    await db.writeAudit({
      actor: normalized || 'UNKNOWN',
      category: 'AUTH',
      action: 'LOGIN_LOCKED',
      outcome: 'DENIED',
      detail: `Login blocked by rate limiter (${retryAfter}s remaining)`,
      ...context,
    });
    return {
      ok: false,
      status: 429,
      error: `Too many failed attempts. Try again in ${retryAfter}s.`,
      retryAfter,
    };
  }

  const admin = await db.get('SELECT * FROM admins WHERE username = ? COLLATE NOCASE', [normalized]);
  let valid = false;
  if (admin) {
    valid = await verifyPassword(password, admin.password_salt, admin.password_hash);
  } else {
    // Burn equivalent CPU time so account existence cannot be inferred from latency.
    await verifyPassword(password, DUMMY_SALT, DUMMY_HASH);
  }

  if (!admin || !valid) {
    const nextFails = (record?.fails || 0) + 1;
    const lockedUntil = nextFails >= MAX_FAILED_ATTEMPTS ? now + LOCKOUT_MS : 0;
    attempts.set(key, { fails: nextFails, lockedUntil });
    await db.writeAudit({
      actor: normalized || 'UNKNOWN',
      category: 'AUTH',
      action: 'LOGIN_FAILED',
      outcome: 'FAILED',
      detail: lockedUntil
        ? `Invalid credentials — account locked for ${LOCKOUT_MS / 60000} minutes`
        : `Invalid credentials (attempt ${nextFails}/${MAX_FAILED_ATTEMPTS})`,
      ...context,
    });
    return {
      ok: false,
      status: 401,
      error: 'Invalid login ID or password.',
      retryAfter: lockedUntil ? Math.ceil(LOCKOUT_MS / 1000) : undefined,
    };
  }

  attempts.delete(key);
  const { token, csrfToken } = await createSession(req, admin);
  await db.run('UPDATE admins SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), admin.id]);
  await db.writeAudit({
    actor: admin.username,
    role: admin.role,
    category: 'AUTH',
    action: 'LOGIN_SUCCESS',
    outcome: 'SUCCESS',
    detail: `Secure session established for ${admin.display_name}`,
    ...context,
  });

  return {
    ok: true,
    token,
    csrfToken,
    user: publicUser({ ...admin, last_login_at: new Date().toISOString() }),
  };
}

async function logout(req, res) {
  const resolved = await resolveSession(req.headers.cookie || '');
  if (resolved) {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', [resolved.session.tokenHash]);
    await db.writeAudit({
      actor: resolved.user.username,
      role: resolved.user.role,
      category: 'AUTH',
      action: 'LOGOUT',
      outcome: 'SUCCESS',
      detail: 'Session terminated by operator',
      ...clientContext(req),
    });
  }
  clearSessionCookie(req, res);
}

async function requireAuth(req, res, next) {
  try {
    const resolved = await resolveSession(req.headers.cookie || '');
    if (!resolved) return res.status(401).json({ error: 'Authentication required.' });
    req.session = resolved.session;
    req.user = resolved.user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    db.writeAudit({
      actor: req.user?.username || 'UNKNOWN',
      role: req.user?.role || null,
      category: 'SECURITY',
      action: 'PRIVILEGE_DENIED',
      outcome: 'DENIED',
      detail: `Administrator role required for ${req.method} ${req.originalUrl}`,
      ip: req.ip || req.socket?.remoteAddress || 'unknown',
      userAgent: (req.get('user-agent') || '').slice(0, 300),
    }).catch(() => {});
    return res.status(403).json({ error: 'Administrator privileges required.' });
  }
  next();
}

function requireCsrf(req, res, next) {
  const token = req.get('x-csrf-token') || '';
  if (!req.session || !safeEqual(token, req.session.csrfToken)) {
    db.writeAudit({
      actor: req.user?.username || 'UNKNOWN',
      role: req.user?.role || null,
      category: 'SECURITY',
      action: 'CSRF_REJECTED',
      outcome: 'DENIED',
      detail: `Request rejected: invalid CSRF token on ${req.method} ${req.originalUrl}`,
      ip: req.ip || req.socket?.remoteAddress || 'unknown',
      userAgent: (req.get('user-agent') || '').slice(0, 300),
    }).catch(() => {});
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  }
  next();
}

/** Reject cross-site state-changing requests outright. */
function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const expected = `${req.protocol}://${req.get('host')}`;
    if (origin === expected) return next();
    db.writeAudit({
      actor: req.user?.username || 'UNKNOWN',
      role: req.user?.role || null,
      category: 'SECURITY',
      action: 'CROSS_ORIGIN_BLOCKED',
      outcome: 'DENIED',
      detail: `Blocked cross-origin request from ${origin} on ${req.method} ${req.originalUrl}`,
      ip: req.ip || req.socket?.remoteAddress || 'unknown',
      userAgent: (req.get('user-agent') || '').slice(0, 300),
    }).catch(() => {});
    return res.status(403).json({ error: 'Cross-origin request blocked.' });
  } catch {
    return res.status(403).json({ error: 'Cross-origin request blocked.' });
  }
}

function startSessionCleanup() {
  const timer = setInterval(async () => {
    try {
      await db.run('DELETE FROM sessions WHERE expires_at <= ?', [new Date().toISOString()]);
    } catch (err) {
      console.error('[AUTH] Session cleanup failed:', err.message);
    }
  }, 60 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  ensureSeeded,
  login,
  logout,
  setSessionCookie,
  clearSessionCookie,
  resolveSession,
  requireAuth,
  requireAdmin,
  requireCsrf,
  requireSameOrigin,
  startSessionCleanup,
  parseCookies,
};
