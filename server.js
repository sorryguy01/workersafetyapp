'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const db = require('./src/db');
const auth = require('./src/auth');
const { TelemetryHub, THRESHOLDS } = require('./src/telemetry');

const requestedPort = Number(process.env.PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

/* --- Rate limiter: 100 requests per 15 min per IP --- */
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });

const hub = new TelemetryHub();

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

/* --- Rate limiter: 100 requests per 15 min per IP --- */
app.use(limiter);

/* -------------------------------------------------------------------------- */
/* Security headers                                                           */
/* -------------------------------------------------------------------------- */

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss: https://cdn.tailwindcss.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ')
  );
  next();
});

app.use(express.json({ limit: '500kb' }));
app.use(helmet());
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
    },
  })
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function requestContext(req) {
  return {
    ip: req.ip || req.socket?.remoteAddress || 'unknown',
    userAgent: (req.get('user-agent') || '').slice(0, 300),
  };
}

function auditAction(req, action, outcome, detail, extra = {}) {
  return db.writeAudit({
    actor: req.user?.username || 'UNKNOWN',
    role: req.user?.role || null,
    category: 'CONTROL',
    action,
    outcome,
    detail,
    ...requestContext(req),
    ...extra,
  });
}

function respondControl(res, message, state, extra = {}) {
  res.json({ ok: true, message, state: state || hub.statusSnapshot(), ...extra });
}

/* -------------------------------------------------------------------------- */
/* Auth routes                                                                */
/* -------------------------------------------------------------------------- */

app.post('/api/login', auth.requireSameOrigin, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ error: 'Login ID and password are required.' });
    }
    if (username.length > 64 || password.length > 256) {
      return res.status(400).json({ error: 'Credential length out of range.' });
    }

    const result = await auth.login(req, username, password);
    if (!result.ok) {
      if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter));
      return res.status(result.status).json({ error: result.error, retryAfter: result.retryAfter || null });
    }

    auth.setSessionCookie(req, res, result.token);
    res.json({ user: result.user, csrfToken: result.csrfToken });
  } catch (err) {
    next(err);
  }
});

app.post('/api/logout', auth.requireAuth, auth.requireSameOrigin, auth.requireCsrf, async (req, res, next) => {
  try {
    await auth.logout(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/session', auth.requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    user: req.user,
    csrfToken: req.session.csrfToken,
    expiresAt: req.session.expiresAt,
  });
});

/* -------------------------------------------------------------------------- */
/* Data routes                                                                */
/* -------------------------------------------------------------------------- */

app.get('/api/incidents', auth.requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await db.all('SELECT * FROM incident_logs ORDER BY id DESC LIMIT ?', [limit]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ incidents: rows, thresholds: THRESHOLDS });
  } catch (err) {
    next(err);
  }
});

app.get('/api/audit', auth.requireAuth, auth.requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const rows = await db.all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?', [limit]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ audit: rows });
  } catch (err) {
    next(err);
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'worker-safety-telemetry', serverTime: new Date().toISOString() });
});

/* -------------------------------------------------------------------------- */
/* Administrator control endpoint (role + CSRF enforced)                      */
/* -------------------------------------------------------------------------- */

app.post(
  '/api/control',
  auth.requireAuth,
  auth.requireAdmin,
  auth.requireSameOrigin,
  auth.requireCsrf,
  async (req, res, next) => {
    try {
      const { action, value } = req.body || {};
      const actor = req.user.username;

      switch (action) {
        case 'simulate': {
          const enable = typeof value === 'boolean' ? value : !hub.simulation;
          hub.setSimulation(enable, { reason: `Simulation ${enable ? 'enabled' : 'disabled'} by ${actor}` });
          await auditAction(req, 'SIMULATION_TOGGLE', 'SUCCESS', `Simulation ${enable ? 'enabled' : 'disabled'}`);
          return respondControl(
            res,
            enable ? 'Simulation mode engaged — synthetic telemetry streaming.' : 'Simulation stopped — awaiting hardware.',
            hub.statusSnapshot()
          );
        }

        case 'bypass': {
          const boot = hub.bypassBios(actor);
          await auditAction(req, 'BIOS_BYPASS', 'SUCCESS', 'BIOS POST checks bypassed; runtime forced');
          return respondControl(res, 'BIOS POST bypassed — runtime engaged.', hub.statusSnapshot(), { boot });
        }

        case 'buzzer': {
          const enable =
            value === undefined || value === 'toggle'
              ? !hub.buzzer
              : value === true || value === 'on' || value === 1;
          hub.setBuzzer(enable);
          await auditAction(req, 'ALARM_RELAY', 'SUCCESS', `Audible buzzer ${enable ? 'energised' : 'silenced'}`);
          return respondControl(res, enable ? 'Buzzer energised.' : 'Buzzer silenced.', hub.statusSnapshot());
        }

        case 'reboot': {
          await auditAction(req, 'ESP_REBOOT', 'SUCCESS', 'ESP32 reboot requested; POST cycle started');
          hub.reboot(actor).catch((err) => hub.log(`[ERR] Reboot failed: ${err.message}`, 'ERR'));
          return respondControl(res, 'Reboot sequence initiated — POST checks running.', hub.statusSnapshot());
        }

        case 'command': {
          if (typeof value !== 'string' || !value.trim()) {
            await auditAction(req, 'SERIAL_COMMAND', 'DENIED', 'Rejected empty command');
            return res.status(400).json({ error: 'Command cannot be empty.' });
          }
          const command = value.trim().slice(0, 120);
          const result = await hub.handleCommand(command, actor);
          await auditAction(
            req,
            'SERIAL_COMMAND',
            result.ok ? 'SUCCESS' : 'FAILED',
            `Command "${command}" — ${result.message || result.error}`
          );
          return res.status(result.ok ? 200 : 409).json({
            ok: Boolean(result.ok),
            message: result.message || null,
            error: result.error || null,
            state: hub.statusSnapshot(),
          });
        }

        default: {
          await auditAction(req, 'INVALID_CONTROL', 'DENIED', `Unknown control action "${String(action).slice(0, 40)}"`);
          return res.status(400).json({ error: 'Unknown control action.' });
        }
      }
    } catch (err) {
      next(err);
    }
  }
);

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed JSON payload.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request payload too large.' });
  }
  console.error('[HTTP] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

/* -------------------------------------------------------------------------- */
/* Socket.io: authenticated telemetry channel                                 */
/* -------------------------------------------------------------------------- */

io.use(async (socket, next) => {
  try {
    const resolved = await auth.resolveSession(socket.request.headers.cookie || '');
    if (!resolved) return next(new Error('unauthorized'));
    socket.data.auth = resolved;
    next();
  } catch (err) {
    console.error('[SOCKET] Auth failure:', err.message);
    next(new Error('auth_failure'));
  }
});

io.on('connection', (socket) => {
  const { user, session } = socket.data.auth;
  if (user.role === 'admin') socket.join('admins');

  socket.emit('snapshot', {
    status: hub.statusSnapshot(),
    boot: hub.bootSnapshot(),
    bios: hub.biosHistory.slice(-120),
    thresholds: THRESHOLDS,
    user,
  });

  const expiry = setInterval(async () => {
    try {
      const resolved = await auth.resolveSession(socket.request.headers.cookie || '');
      if (!resolved || resolved.session.tokenHash !== session.tokenHash) {
        socket.emit('session_expired');
        socket.disconnect(true);
      }
    } catch {
      /* transient DB error — retry next tick */
    }
  }, 30_000);
  expiry.unref?.();

  socket.on('disconnect', () => clearInterval(expiry));

  socket.emit('bios', {
    ts: new Date().toISOString(),
    level: 'OK',
    line: `[AUTH] Secure session verified for ${user.username} (${user.role})`,
  });
});

/* -------------------------------------------------------------------------- */
/* Event fan-out                                                              */
/* -------------------------------------------------------------------------- */

hub.on('telemetry', (payload) => io.emit('telemetry', payload));
hub.on('status', (status) => io.emit('status', status));
hub.on('bios', (entry) => io.emit('bios', entry));
hub.on('boot_step', (step) => io.emit('boot_step', step));
hub.on('boot_state', (state) => io.emit('boot_state', state));
hub.on('incident', (incident) => io.emit('incident', incident));
db.events.on('audit', (row) => io.to('admins').emit('audit', row));

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  await db.init();
  await auth.ensureSeeded();
  auth.startSessionCleanup();

  server.listen(PORT, () => {
    console.log(`[SERVER] Worker Safety control room → http://localhost:${PORT}`);
    console.log(`[SECURITY] RBAC active · session TTL ${auth.SESSION_TTL_MS / 3600000}h · audit logging enabled`);
  });

  await db.writeAudit({
    actor: 'SYSTEM',
    role: 'system',
    category: 'SYSTEM',
    action: 'SYSTEM_START',
    outcome: 'SUCCESS',
    detail: `Telemetry service started on port ${PORT}`,
  });

  hub.start().catch((err) => console.error('[TELEMETRY] Startup failure:', err));
}

async function shutdown(signal) {
  console.log(`\n[SYSTEM] ${signal} received — shutting down`);
  hub.stop();
  io.close();
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[FATAL] Failed to start server:', err);
  process.exit(1);
});
