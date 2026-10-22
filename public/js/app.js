'use strict';

/* ------------------------------------------------------------------ */
/* Constants & helpers                                                */
/* ------------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const MAX_POINTS = 150;
const MAX_TERMINAL_LINES = 400;
const FALLBACK_BOOT_STEPS = [
  { label: 'CPU & Power-On Self-Test', detail: 'ESP32-WROOM-32E · dual-core 240 MHz' },
  { label: 'Flash & SPIFFS Integrity', detail: '4 MB flash · wear-levelling OK' },
  { label: 'I²C Bus & IMU Probe', detail: 'MPU-6050 @ 0x68 · ±16 g range' },
  { label: 'Vital Signs Sensor', detail: 'MAX30102 PPG @ 0x57' },
  { label: 'Environment & Gas Array', detail: 'DHT11 · MQ-2 · flame IR' },
  { label: 'Safety I/O & Alarm', detail: 'GPIO 27 interrupt · buzzer relay armed' },
  { label: 'Telemetry Uplink', detail: 'UART 115200 · 10 Hz framed stream' },
];

const EVENT_META = {
  HIGH_IMPACT_FALL: { label: 'High Impact Fall', tone: '#d94a5c' },
  SOS_PANIC: { label: 'SOS Panic', tone: '#d94a5c' },
  SOS_PANIC_BUTTON: { label: 'SOS Panic', tone: '#d94a5c' },
  FIRE_DETECTED: { label: 'Fire Detected', tone: '#fb923c' },
  GAS_SMOKE_HAZARD: { label: 'Gas / Smoke Hazard', tone: '#c2871f' },
  GAS_LEAK: { label: 'Gas Leak', tone: '#c2871f' },
  HEAT_STRESS: { label: 'Heat Stress', tone: '#c2871f' },
  HIGH_HEAT_STRESS: { label: 'Heat Stress', tone: '#c2871f' },
  VIOLENT_ROTATION: { label: 'Violent Rotation', tone: '#7c6cf0' },
  CARDIAC_STRESS: { label: 'Cardiac Stress', tone: '#e05a6d' },
};

const SAFETY_ICONS = {
  nominal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  critical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
};

const FULLSCREEN_ICONS = {
  enter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/></svg>',
  exit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M16 3v3a2 2 0 0 0 2 2h3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/><path d="M8 21v-3a2 2 0 0 0-2-2H3"/></svg>',
};

const THEME_ICONS = {
  toDark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.1A8.5 8.5 0 0 1 9.9 3.5 8.5 8.5 0 1 0 20.5 14.1z"/></svg>',
  toLight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.9 4.9l1.4 1.4"/><path d="M17.7 17.7l1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.9 19.1l1.4-1.4"/><path d="M17.7 6.3l1.4-1.4"/></svg>',
};

const state = {
  user: null,
  csrf: null,
  socket: null,
  status: { connected: false, simulation: false, port: '---', baud: 115200, buzzer: false, packets: 0, uptime: 0, thresholds: {} },
  statusReady: false,
  lastSafetyLevel: '',
  lastHazardSignature: '',
  thresholds: { impact: 22, gyro: 250, gas: 1800, temp: 42 },
  latest: null,
  lastTelemetryAt: 0,
  uptimeAt: 0,
  uptimeBase: 0,
  boot: { steps: FALLBACK_BOOT_STEPS.map((step, index) => ({ index, ...step, status: 'pending' })), complete: false },
  incidents: [],
  audit: [],
  incidentFilter: 'ALL',
  activeTab: 'incidents',
  charts: {},
  series: { accel: { x: [], y: [], z: [] }, gyro: { r: [], p: [], y: [] } },
  chartsReady: false,
  lastChartUpdate: 0,
  autoscroll: true,
  renderQueued: false,
  loginLockTimer: null,
  loginLockedUntil: 0,
  commandHistory: [],
  historyIndex: -1,
  socketConnected: false,
  spotlightFrame: 0,
  lastDrawerTrigger: null,
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function parseTimestamp(value) {
  if (!value) return null;
  let text = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) text = text.replace(' ', 'T') + 'Z';
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fmtTime(value, withDate = false) {
  const date = parseTimestamp(value);
  if (!date) return '—';
  if (withDate) {
    return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

function fmtClock(value) {
  const date = parseTimestamp(value) || new Date();
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

function fmtUptime(seconds) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const h = String(Math.floor(safe / 3600)).padStart(2, '0');
  const m = String(Math.floor((safe % 3600) / 60)).padStart(2, '0');
  const s = String(safe % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setTextIfChanged(id, value) {
  const el = document.getElementById(id);
  if (el && el.textContent !== value) el.textContent = value;
}

function setChip(id, text, tone) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `state-chip state-${tone}`;
}

function setBar(fill, percent, active = false) {
  if (!fill) return;
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  fill.style.opacity = active ? '1' : '0.85';
}

function setAxisFill(el, value, limit) {
  if (!el) return;
  const magnitude = Math.min(100, (Math.abs(value) / limit) * 100) / 2;
  el.style.width = `${magnitude}%`;
  el.style.left = value >= 0 ? '50%' : `${50 - magnitude}%`;
}

function toast(message, tone = 'info', title = 'SYSTEM') {
  const container = $('#toasts');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.innerHTML = `<span class="toast-icon"></span><div class="min-w-0"><p class="toast-title">${esc(title)}</p><p class="toast-msg">${esc(message)}</p></div><button class="toast-close" type="button" aria-label="Dismiss">×</button>`;
  container.appendChild(el);
  const remove = () => {
    if (el.classList.contains('leaving')) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 320);
  };
  el.querySelector('.toast-close').addEventListener('click', remove);
  setTimeout(remove, 4800);
}

/* ------------------------------------------------------------------ */
/* Auth                                                               */
/* ------------------------------------------------------------------ */
function setLoginBusy(busy) {
  const btn = $('#loginBtn');
  const text = $('#loginBtnText');
  const spinner = $('#loginSpinner');
  if (!btn) return;
  if (busy) {
    btn.disabled = true;
    text.textContent = 'AUTHENTICATING';
    spinner.classList.remove('hidden');
  } else if (Date.now() < state.loginLockedUntil) {
    btn.disabled = true;
    spinner.classList.add('hidden');
  } else {
    btn.disabled = false;
    text.textContent = 'AUTHENTICATE';
    spinner.classList.add('hidden');
  }
}

function setLoginError(message) {
  const box = $('#loginError');
  const text = $('#loginErrorText');
  if (!box || !text) return;
  if (!message) {
    box.classList.add('hidden');
    text.textContent = '';
    return;
  }
  text.textContent = message;
  box.classList.remove('hidden');
  box.style.animation = 'none';
  void box.offsetWidth;
  box.style.animation = '';
}

function lockLogin(seconds) {
  const until = Date.now() + Math.max(1, Number(seconds) || 60) * 1000;
  state.loginLockedUntil = until;
  clearInterval(state.loginLockTimer);
  const tick = () => {
    const remaining = Math.ceil((until - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(state.loginLockTimer);
      state.loginLockedUntil = 0;
      setLoginBusy(false);
      setLoginError('');
      return;
    }
    $('#loginBtn').disabled = true;
    $('#loginBtnText').textContent = `LOCKED · ${remaining}s`;
  };
  tick();
  state.loginLockTimer = setInterval(tick, 1000);
}

function showLogin(message) {
  disconnectSocket();
  state.user = null;
  state.csrf = null;
  state.socketConnected = false;
  const app = $('#app');
  app.classList.add('hidden');
  app.classList.remove('is-ready');
  const drawer = $('#incidentDrawer');
  if (drawer) {
    drawer.hidden = true;
    drawer.classList.remove('is-open');
    $('#drawerBackdrop').hidden = true;
    $('#drawerBackdrop').classList.remove('is-open');
    document.body.classList.remove('drawer-open');
  }
  const screen = $('#loginScreen');
  screen.classList.remove('hidden');
  screen.classList.remove('leaving');
  setLoginBusy(false);
  if (message) setLoginError(message);
  setTimeout(() => $('#loginUser')?.focus(), 120);
}

function enterDashboard(user, csrfToken) {
  clearInterval(state.loginLockTimer);
  state.loginLockedUntil = 0;
  setLoginError('');
  state.user = user;
  state.csrf = csrfToken;
  document.body.dataset.role = user.role;

  $('#userName').textContent = user.displayName || user.username;
  $('#userRole').textContent = user.role === 'admin' ? 'ADMINISTRATOR' : 'READ-ONLY OBSERVER';
  $('#userInitials').textContent = (user.displayName || user.username || '--')
    .split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  $('#readOnlyBadge').classList.toggle('hidden', user.role === 'admin');
  $('#tabAudit').classList.toggle('hidden', user.role !== 'admin');

  const app = $('#app');
  app.classList.remove('hidden');
  app.classList.remove('is-ready');
  void app.offsetWidth;
  app.classList.add('is-ready');
  const screen = $('#loginScreen');
  screen.classList.add('leaving');
  setTimeout(() => {
    screen.classList.add('hidden');
    screen.classList.remove('leaving');
  }, 400);

  resetDashboard();
  initCharts();
  // Chart.js measures the canvas synchronously after the login overlay is
  // dismissed; re-measure on the next frame so the linear time axis binds
  // to real sample timestamps even when the page first loads in a
  // background tab or after a display:none → visible transition.
  requestAnimationFrame(() => {
    if (!state.chartsReady) return;
    state.charts.accel.resize();
    state.charts.gyro.resize();
    state.charts.accel.update('none');
    state.charts.gyro.update('none');
  });
  connectSocket();
  loadIncidents();
  if (user.role === 'admin') loadAudit();
  updateControlAvailability();

  const expiry = parseTimestamp(user.lastLoginAt);
  if (expiry) $('#sessionExpiry').textContent = fmtTime(expiry, true);

  toast(`Signed in as ${user.displayName || user.username} · ${user.role === 'admin' ? 'full control' : 'read-only'}`, 'success', 'AUTHENTICATED');
}

async function checkSession() {
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      enterDashboard(data.user, data.csrfToken);
      return;
    }
  } catch (err) {
    /* login screen will surface failures on submit */
  }
  showLogin();
}

function updateFullscreenButton() {
  const btn = $('#fullscreenBtn');
  if (!btn) return;
  const active = Boolean(document.fullscreenElement);
  btn.innerHTML = active ? FULLSCREEN_ICONS.exit : FULLSCREEN_ICONS.enter;
  btn.setAttribute('aria-pressed', String(active));
  btn.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
  btn.title = active ? 'Exit fullscreen' : 'Enter fullscreen';
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (err) {
    toast('Fullscreen is unavailable in this browser context.', 'warn', 'DISPLAY');
  }
}

function isLightTheme() {
  return document.body.dataset.theme !== 'dark';
}

function updateThemeButton() {
  const btn = $('#themeBtn');
  if (!btn) return;
  const light = isLightTheme();
  btn.innerHTML = light ? THEME_ICONS.toDark : THEME_ICONS.toLight;
  btn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
  btn.title = light ? 'Switch to dark theme' : 'Switch to light theme';
}

function applyTheme(theme, { persist = true } = {}) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.body.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'light' ? '#eef2ed' : '#04060b');
  updateThemeButton();
  applyChartTheme();
  // Repaint telemetry-driven values immediately so JS-painted colours
  // (SOS / flame readouts, hints) do not wait for the next 10 Hz frame.
  try { if (typeof renderTelemetry === 'function' && state && state.latest) renderTelemetry(); } catch (e) { /* no frame yet */ }
  if (persist) {
    try { localStorage.setItem('safety-theme', next); } catch (e) { /* storage unavailable */ }
  }
}

function toggleTheme() {
  applyTheme(isLightTheme() ? 'dark' : 'light');
}

async function handleLogout() {
  const btn = $('#logoutBtn');
  btn.disabled = true;
  try {
    await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': state.csrf || '' },
    });
  } catch (err) {
    /* reload regardless */
  }
  window.location.reload();
}

/* ------------------------------------------------------------------ */
/* Status & role                                                      */
/* ------------------------------------------------------------------ */
function updateControlAvailability() {
  const observer = state.user?.role !== 'admin';
  $$('.admin-only').forEach((el) => {
    el.disabled = observer;
    el.setAttribute('aria-disabled', String(observer));
    if (observer) el.title = 'Administrator privileges required';
  });
  const cmdInput = $('#cmdInput');
  if (cmdInput) {
    cmdInput.disabled = observer;
    cmdInput.placeholder = observer
      ? 'Read-only account — controls disabled'
      : 'Serial command — type HELP for virtual controls';
  }
  $('#readOnlyBadge').classList.toggle('hidden', !observer);
  if (observer && state.activeTab === 'audit') switchTab('incidents');
}

function setStatus(next) {
  if (!next) return;
  state.statusReady = true;
  state.status = { ...state.status, ...next };
  if (next.thresholds) state.thresholds = { ...state.thresholds, ...next.thresholds };
  if (typeof next.uptime === 'number') {
    state.uptimeBase = next.uptime;
    state.uptimeAt = Date.now();
  }

  const simulation = Boolean(state.status.simulation);
  const online = Boolean(state.status.connected);
  const mode = simulation ? 'SIMULATION MODE' : online ? 'ESP32 ONLINE' : 'ESP32 OFFLINE';

  const badge = $('#connBadge');
  badge.className = `status-badge ${simulation ? 'status-sim' : online ? 'status-online' : 'status-offline'}`;
  setText('connText', mode);
  setText(
    'connSub',
    simulation
      ? `${state.status.port} · synthetic stream`
      : online
        ? `${state.status.port} · ${state.status.baud} baud`
        : state.status.lastError
          ? 'serial link lost'
          : 'unplugged · awaiting link'
  );

  $('#offlineBanner').classList.toggle('hidden', simulation || online);
  $('#offlineBanner').classList.toggle('flex', !simulation && !online && Boolean(state.user));
  document.body.classList.toggle('data-offline', !simulation && !online);
  $('#simChip').classList.toggle('hidden', !simulation);

  const simBtn = $('#btnSim');
  if (simBtn) {
    simBtn.classList.toggle('is-active', simulation);
    const label = simBtn.querySelector('.btn-label');
    if (label) label.textContent = simulation ? 'Simulation ON' : 'Simulate Data';
    $('#simLed').classList.toggle('on', simulation);
  }

  const buzzerBtn = $('#btnBuzzer');
  if (buzzerBtn) {
    buzzerBtn.classList.toggle('is-active-buzzer', Boolean(state.status.buzzer));
    const label = $('#buzzerLabel');
    if (label) label.textContent = state.status.buzzer ? 'Buzzer ON' : 'Buzzer OFF';
  }

  setText('portLabel', state.status.port || '---');
  setText('baudLabel', String(state.status.baud || 115200));
  setText('pktCount', String(state.status.packets ?? 0));

  const live = simulation || online;
  [[$('#streamPill'), $('#streamRate'), '10 HZ'], [$('#accelPill'), null, 'LIVE'], [$('#gyroPill'), null, 'LIVE']].forEach(([pill, labelEl, liveText]) => {
    if (!pill) return;
    pill.classList.toggle('is-paused', !live);
    const target = labelEl || pill.querySelector('span:last-child');
    if (target) target.textContent = live ? liveText : (liveText === 'LIVE' ? 'FROZEN' : 'PAUSED');
  });
  updateControlAvailability();
  renderSafetyState();
}

function resetDashboard() {
  state.latest = null;
  state.lastTelemetryAt = 0;
  state.incidents = [];
  state.audit = [];
  state.boot = {
    steps: FALLBACK_BOOT_STEPS.map((step, index) => ({ index, ...step, status: 'pending' })),
    complete: false,
  };
  renderBoot();
  renderIncidents();
  renderAudit();
  renderSafetyState();
  switchTab('incidents');
  if (state.charts.accel) {
    ['x', 'y', 'z'].forEach((key) => { state.series.accel[key].length = 0; });
    ['r', 'p', 'y'].forEach((key) => { state.series.gyro[key].length = 0; });
    state.charts.accel.update('none');
    state.charts.gyro.update('none');
  }
  const terminal = $('#terminal');
  terminal.innerHTML = '';
  appendBios({ ts: new Date().toISOString(), level: 'INFO', line: '[UI] Secure channel established — loading telemetry stream…' });
  setText('termCount', '1 LINE');
}

/* ------------------------------------------------------------------ */
/* Industrial safety state                                            */
/* ------------------------------------------------------------------ */
function computeHazards(d) {
  const t = state.thresholds;
  const hazards = [];
  const add = (key, label, value, severity) => hazards.push({ key, label, value, severity });
  const mag = Number(d.magnitude);
  const gyro = Number(d.gyroMag);
  const temp = Number(d.temp);
  const gas = Number(d.gas);
  const bpm = Number(d.bpm);

  if (Number.isFinite(mag) && mag > Number(t.impact)) add('IMPACT', 'HIGH IMPACT', `${mag.toFixed(1)} m/s²`, 'critical');
  if (Number.isFinite(gas) && gas > Number(t.gas)) add('GAS', 'GAS / SMOKE', `${Math.round(gas)} ADC`, 'critical');
  if (Number(d.flame) === 1) add('FLAME', 'FIRE DETECTED', 'IR ACTIVE', 'critical');
  if (Number(d.sos) === 1) add('SOS', 'SOS PANIC', 'LATCHED', 'critical');
  if (Number.isFinite(temp) && temp > Number(t.temp)) add('HEAT', 'HEAT STRESS', `${temp.toFixed(1)} °C`, 'warning');
  if (Number.isFinite(bpm) && bpm > 0 && (bpm > Number(t.bpmHigh) || bpm < Number(t.bpmLow))) {
    add('CARDIAC', 'CARDIAC STRESS', `${Math.round(bpm)} BPM`, 'warning');
  }
  if (Number.isFinite(gyro) && gyro > Number(t.gyro)) add('ROTATION', 'VIOLENT ROTATION', `${gyro.toFixed(0)} °/s`, 'warning');

  return hazards.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));
}

function renderSafetyState() {
  const bar = $('#safetyBar');
  if (!bar) return;

  const now = Date.now();
  const hasFrame = Boolean(state.lastTelemetryAt && state.latest);
  const age = hasFrame ? Math.floor((now - state.lastTelemetryAt) / 1000) : null;
  const fresh = hasFrame && now - state.lastTelemetryAt < 5000;
  const linkLive = state.statusReady ? Boolean(state.status.simulation || state.status.connected) : fresh;

  let level = 'idle';
  let label = 'STANDBY';
  let summary = 'Secure telemetry channel initialising — safety assessment pending.';
  let hazards = [];
  let countText = '--';

  if (!state.statusReady && !hasFrame) {
    /* initial state */
  } else if (!linkLive) {
    label = 'NO DATA';
    summary = 'Serial uplink offline — values are frozen and must not be treated as current.';
  } else if (!hasFrame) {
    label = 'STANDBY';
    summary = 'Uplink available — awaiting the first sensor frame.';
  } else if (!fresh) {
    label = 'DATA STALE';
    summary = `No sensor frame received for ${age}s — safety state unavailable until the stream resumes.`;
  } else {
    hazards = computeHazards(state.latest);
    const critical = hazards.filter((item) => item.severity === 'critical').length;
    const warning = hazards.length - critical;
    countText = String(hazards.length).padStart(2, '0');
    if (critical > 0) {
      level = 'critical';
      label = 'HAZARD';
      const parts = [`${critical} critical hazard${critical === 1 ? '' : 's'}`];
      if (warning) parts.push(`${warning} advisory condition${warning === 1 ? '' : 's'}`);
      summary = `${parts.join(' · ')} — operator response required.`;
    } else if (warning > 0) {
      level = 'warning';
      label = 'ATTENTION';
      summary = `${warning} advisory condition${warning === 1 ? '' : 's'} outside the nominal range — monitor worker and review trend.`;
    } else {
      level = 'nominal';
      label = 'NOMINAL';
      summary = 'All monitored channels within safe limits. Continuous 10 Hz threshold scan active.';
    }
  }

  const className = `safety-bar is-${level} mb-4`;
  if (bar.className !== className) bar.className = className;
  if (state.lastSafetyLevel !== level) {
    $('#safetyIcon').innerHTML = SAFETY_ICONS[level] || SAFETY_ICONS.idle;
    bar.setAttribute('aria-label', `Safety state: ${label}`);
    state.lastSafetyLevel = level;
  }

  setTextIfChanged('safetyState', label);
  setTextIfChanged('safetySummary', summary);
  setTextIfChanged('hazardCount', countText);

  const signature = hazards.map((item) => `${item.key}:${item.value}`).join('|');
  if (signature !== state.lastHazardSignature) {
    state.lastHazardSignature = signature;
    const box = $('#safetyHazards');
    if (!hazards.length) {
      box.innerHTML = '';
    } else {
      const visible = hazards.slice(0, 4);
      box.innerHTML =
        visible.map((item) => `<span class="hazard-chip ${item.severity === 'critical' ? 'is-critical' : ''}">${esc(item.label)} <b>${esc(item.value)}</b></span>`).join('') +
        (hazards.length > visible.length ? `<span class="hazard-chip">+${hazards.length - visible.length} MORE</span>` : '');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Telemetry rendering                                                */
/* ------------------------------------------------------------------ */
function handleTelemetry(payload) {
  if (!payload) return;
  state.latest = payload;
  state.lastTelemetryAt = Date.now();
  if (typeof payload.seq === 'number') setText('pktCount', String(payload.seq));
  pushChartSample(payload);
  queueRender();
}

function queueRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderTelemetry();
  });
}

function renderTelemetry() {
  const d = state.latest;
  if (!d) return;
  const thresholds = state.thresholds;

  // Accelerometer
  setText('accelTotal', Number(d.magnitude || 0).toFixed(2));
  setText('accelG', (Number(d.magnitude || 0) / 9.80665).toFixed(2));
  setText('accelX', Number(d.x).toFixed(2));
  setText('accelY', Number(d.y).toFixed(2));
  setText('accelZ', Number(d.z).toFixed(2));
  setAxisFill($('#barX'), d.x, 30);
  setAxisFill($('#barY'), d.y, 30);
  setAxisFill($('#barZ'), d.z, 30);
  const impact = d.magnitude > thresholds.impact;
  $('#cardAccel').classList.toggle('alert', impact);
  setChip('accelState', impact ? 'IMPACT' : 'NOMINAL', impact ? 'alert' : 'ok');
  setText('accelHint', impact ? `FALL > ${thresholds.impact.toFixed(1)} m/s²` : 'WITHIN SAFE ENVELOPE');

  // Gyroscope
  setText('gyroMag', Number(d.gyroMag || 0).toFixed(0));
  setText('gyroX', Number(d.gx).toFixed(1));
  setText('gyroY', Number(d.gy).toFixed(1));
  setText('gyroZ', Number(d.gz).toFixed(1));
  setText('gyroFrame', `${Number(d.gx).toFixed(0)} / ${Number(d.gy).toFixed(0)} / ${Number(d.gz).toFixed(0)}`);
  setAxisFill($('#barRoll'), d.gx, 180);
  setAxisFill($('#barPitch'), d.gy, 180);
  setAxisFill($('#barYaw'), d.gz, 180);
  const spin = d.gyroMag > thresholds.gyro;
  setChip('gyroState', spin ? 'HIGH ROT' : 'NOMINAL', spin ? 'warn' : 'ok');
  setText('gyroHint', spin ? 'VIOLENT ROTATION DETECTED' : 'STABLE ORIENTATION');

  // Vitals
  const bpm = Math.round(Number(d.bpm) || 0);
  setText('bpmVal', bpm > 0 ? String(bpm) : '--');
  if (bpm <= 0) {
    setChip('bpmState', 'NO CONTACT', 'idle');
    setText('bpmHint', 'NO FINGER DETECTED');
    $('#cardVitals').classList.remove('alert');
  } else if (bpm > thresholds.bpmHigh) {
    setChip('bpmState', 'TACHYCARDIA', 'alert');
    setText('bpmHint', 'CARDIAC STRESS · ABOVE 140');
    $('#cardVitals').classList.add('alert');
  } else if (bpm < thresholds.bpmLow) {
    setChip('bpmState', 'BRADYCARDIA', 'warn');
    setText('bpmHint', 'BELOW SAFE BAND');
    $('#cardVitals').classList.add('alert');
  } else {
    setChip('bpmState', bpm > 100 ? 'ELEVATED' : 'NORMAL', bpm > 100 ? 'warn' : 'ok');
    setText('bpmHint', bpm > 100 ? 'ELEVATED · MONITOR' : 'WITHIN SAFE BAND');
    $('#cardVitals').classList.remove('alert');
  }

  // SOS
  const sos = Number(d.sos) === 1;
  $('#cardSos').classList.toggle('sos-active', sos);
  setText('sosVal', sos ? 'SOS ACTIVE' : 'STANDBY');
  $('#sosVal').style.color = sos
    ? (isLightTheme() ? '#8f1f33' : '#fff')
    : (isLightTheme() ? '#26382c' : '#cbd5e1');
  setChip('sosState', sos ? 'EMERGENCY' : 'STANDBY', sos ? 'alert' : 'ok');
  setText('sosHint', sos ? 'PANIC LATCH ENGAGED' : 'GPIO 27 · ARMED');
  setText('sosFoot', sos ? '🚨 WORKER DISTRESS — RESPONSE REQUIRED' : 'NO ACTIVE PANIC EVENT');

  // Temperature
  const temp = Number(d.temp);
  setText('tempVal', Number.isFinite(temp) ? temp.toFixed(1) : '--');
  setBar($('#tempBar'), (temp / 60) * 100);
  const tempTone = temp > thresholds.temp ? 'alert' : temp > 38 ? 'warn' : 'ok';
  setChip('tempState', temp > thresholds.temp ? 'HEAT STRESS' : temp > 38 ? 'ELEVATED' : 'NORMAL', tempTone);
  setText('tempHint', temp > thresholds.temp ? 'ABOVE LIMIT' : 'NOMINAL');
  $('#cardTemp').classList.toggle('alert', temp > thresholds.temp);

  // Humidity
  const hum = Math.round(Number(d.hum));
  setText('humVal', Number.isFinite(hum) ? String(hum) : '--');
  setBar($('#humBar'), hum);
  const humTone = hum < 30 ? 'warn' : hum > 70 ? 'warn' : 'ok';
  setChip('humState', hum < 30 ? 'DRY' : hum > 70 ? 'HUMID' : 'NORMAL', humTone);
  setText('humHint', hum < 30 ? 'LOW HUMIDITY' : hum > 70 ? 'HIGH HUMIDITY' : 'COMFORTABLE');

  // Gas
  const gas = Math.round(Number(d.gas));
  setText('gasVal', Number.isFinite(gas) ? String(gas) : '--');
  setBar($('#gasBar'), (gas / 4095) * 100);
  const gasHazard = gas > thresholds.gas;
  $('#cardGas').classList.toggle('alert', gasHazard);
  setChip('gasState', gasHazard ? 'HAZARD' : gas > 1000 ? 'ELEVATED' : 'CLEAN', gasHazard ? 'alert' : gas > 1000 ? 'warn' : 'ok');
  setText('gasHint', gasHazard ? 'SMOKE / GAS DETECTED' : 'AIR QUALITY NOMINAL');

  // Flame
  const fire = Number(d.flame) === 1;
  $('#cardFlame').classList.toggle('fire-active', fire);
  setText('flameVal', fire ? '🔥 FIRE ALERT' : 'CLEAR');
  $('#flameVal').style.color = fire
    ? (isLightTheme() ? '#9a4a08' : '#fdba74')
    : (isLightTheme() ? '#26382c' : '#cbd5e1');
  setChip('flameState', fire ? 'FIRE' : 'CLEAR', fire ? 'alert' : 'ok');
  setText('flameHint', fire ? 'IR EMISSION DETECTED' : 'IR CHANNEL · NO EMISSION');

  renderSafetyState();
}

/* ------------------------------------------------------------------ */
/* Charts                                                             */
/* ------------------------------------------------------------------ */
function thresholdPlugin(value, label) {
  return {
    id: `threshold-${value}`,
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.y) return;
      const y = scales.y.getPixelForValue(value);
      if (y < chartArea.top || y > chartArea.bottom) return;
      const light = isLightTheme();
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = light ? 'rgba(217, 74, 92, 0.5)' : 'rgba(251, 59, 83, 0.55)';
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = light ? 'rgba(184, 61, 78, 0.82)' : 'rgba(251, 113, 133, 0.8)';
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.fillText(`${label} ${Number(value).toFixed(1)}`, chartArea.left + 6, y - 5);
      ctx.restore();
    },
  };
}

const glowPlugin = {
  id: 'neonGlow',
  beforeDatasetDraw(chart, args) {
    const ctx = chart.ctx;
    const dataset = chart.data.datasets[args.index];
    ctx.save();
    ctx.shadowColor = dataset.borderColor;
    ctx.shadowBlur = isLightTheme() ? 0 : 5;
  },
  afterDatasetDraw(chart) {
    chart.ctx.restore();
  },
};

function chartOptions(min, max) {
  const light = isLightTheme();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    parsing: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    layout: { padding: { top: 10, right: 8, bottom: 0, left: 0 } },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: light ? 'rgba(255, 255, 255, 0.97)' : 'rgba(5, 10, 18, 0.96)',
        borderColor: light ? 'rgba(23, 42, 30, 0.12)' : 'rgba(148, 163, 184, 0.2)',
        borderWidth: 1,
        titleColor: light ? '#7b8b81' : '#94a3b8',
        bodyColor: light ? '#1d2c24' : '#e2e8f0',
        titleFont: { family: '"JetBrains Mono", monospace', size: 9 },
        bodyFont: { family: '"JetBrains Mono", monospace', size: 10 },
        padding: 9,
        displayColors: true,
        boxWidth: 6,
        boxHeight: 6,
        callbacks: {
          title: (items) => (items.length ? new Date(items[0].parsed.x).toLocaleTimeString('en-GB', { hour12: false }) : ''),
          label: (item) => `${item.dataset.label}: ${Number(item.parsed.y).toFixed(2)}`,
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        grid: { display: false },
        border: { display: false },
        ticks: {
          maxTicksLimit: 6,
          maxRotation: 0,
          color: light ? '#5f7065' : '#7d8da6',
          font: { family: '"JetBrains Mono", monospace', size: 8 },
          callback: (value) => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
        },
      },
      y: {
        suggestedMin: min,
        suggestedMax: max,
        grid: { color: light ? 'rgba(23, 42, 30, 0.07)' : 'rgba(148, 163, 184, 0.055)', drawTicks: false },
        border: { display: false },
        ticks: {
          maxTicksLimit: 5,
          padding: 6,
          color: light ? '#5f7065' : '#7d8da6',
          font: { family: '"JetBrains Mono", monospace', size: 8 },
          callback: (value) => Number(value).toFixed(0),
        },
      },
    },
    elements: {
      point: { radius: 0, hoverRadius: 3 },
      line: { tension: 0.4, borderWidth: 1.9, capBezierPoints: true },
    },
  };
}

function initCharts() {
  if (state.chartsReady) return;
  if (typeof Chart === 'undefined') {
    console.warn('[UI] Chart.js unavailable');
    return;
  }
  Chart.defaults.font.family = '"JetBrains Mono", monospace';
  Chart.defaults.color = isLightTheme() ? '#5f7065' : '#7d8da6';

  state.charts.accel = new Chart($('#accelChart').getContext('2d'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'X', data: state.series.accel.x, borderColor: '#0f8f83', backgroundColor: 'transparent', spanGaps: true },
        { label: 'Y', data: state.series.accel.y, borderColor: '#2f9e6b', backgroundColor: 'transparent', spanGaps: true },
        { label: 'Z', data: state.series.accel.z, borderColor: '#c2871f', backgroundColor: 'transparent', spanGaps: true },
      ],
    },
    options: chartOptions(-12, 22),
    plugins: [glowPlugin, thresholdPlugin(22, 'IMPACT')],
  });

  state.charts.gyro = new Chart($('#gyroChart').getContext('2d'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'ROLL', data: state.series.gyro.r, borderColor: '#7c6cf0', backgroundColor: 'transparent', spanGaps: true },
        { label: 'PITCH', data: state.series.gyro.p, borderColor: '#0f8f83', backgroundColor: 'transparent', spanGaps: true },
        { label: 'YAW', data: state.series.gyro.y, borderColor: '#d6538e', backgroundColor: 'transparent', spanGaps: true },
      ],
    },
    options: chartOptions(-90, 90),
    plugins: [glowPlugin],
  });

  state.chartsReady = true;
  applyChartTheme();
}

function applyChartTheme() {
  if (!state.chartsReady || typeof Chart === 'undefined') return;
  const light = isLightTheme();
  const tickColor = light ? '#5f7065' : '#7d8da6';
  const gridColor = light ? 'rgba(23, 42, 30, 0.07)' : 'rgba(148, 163, 184, 0.055)';
  Chart.defaults.color = tickColor;
  Object.values(state.charts).forEach((chart) => {
    if (!chart || !chart.options || !chart.options.scales) return;
    chart.options.scales.x.ticks.color = tickColor;
    chart.options.scales.y.ticks.color = tickColor;
    chart.options.scales.y.grid.color = gridColor;
    const tooltip = chart.options.plugins.tooltip;
    tooltip.backgroundColor = light ? 'rgba(255, 255, 255, 0.97)' : 'rgba(5, 10, 18, 0.96)';
    tooltip.borderColor = light ? 'rgba(23, 42, 30, 0.12)' : 'rgba(148, 163, 184, 0.2)';
    tooltip.titleColor = light ? '#7b8b81' : '#94a3b8';
    tooltip.bodyColor = light ? '#1d2c24' : '#e2e8f0';
    chart.update('none');
  });
}

function pushSeries(target, timestamp, value) {
  target.push({ x: timestamp, y: Number(value) || 0 });
  while (target.length > MAX_POINTS) target.shift();
}

function pushChartSample(d) {
  if (!state.chartsReady) return;
  const now = parseTimestamp(d.ts)?.getTime() || Date.now();
  pushSeries(state.series.accel.x, now, d.x);
  pushSeries(state.series.accel.y, now, d.y);
  pushSeries(state.series.accel.z, now, d.z);
  pushSeries(state.series.gyro.r, now, d.gx);
  pushSeries(state.series.gyro.p, now, d.gy);
  pushSeries(state.series.gyro.y, now, d.gz);

  // Preserve every 10 Hz frame in the series; repaint the canvas at ~6 fps
  // so Chart.js never becomes the bottleneck of the telemetry pipeline.
  const stamp = Date.now();
  if (!document.hidden && stamp - state.lastChartUpdate > 160) {
    state.lastChartUpdate = stamp;
    state.charts.accel.update('none');
    state.charts.gyro.update('none');
  }
}

/* ------------------------------------------------------------------ */
/* Terminal & boot sequence                                           */
/* ------------------------------------------------------------------ */
function appendBios(entry) {
  const terminal = $('#terminal');
  if (!terminal) return;
  const level = String(entry.level || 'INFO').toUpperCase();
  const levelClass = {
    OK: 'term-ok',
    WARN: 'term-warn',
    ERR: 'term-err',
    CMD: 'term-cmd',
    BOOT: 'term-boot',
    SIM: 'term-sim',
    INFO: 'term-info',
  }[level] || 'term-info';

  const row = document.createElement('div');
  row.className = 'term-line';
  const time = document.createElement('span');
  time.className = 'term-time';
  time.textContent = fmtClock(entry.ts);
  const text = document.createElement('span');
  text.className = `term-text ${levelClass}`;
  text.textContent = entry.line;
  row.append(time, text);
  terminal.appendChild(row);

  while (terminal.children.length > MAX_TERMINAL_LINES) terminal.removeChild(terminal.firstChild);
  if (state.autoscroll) terminal.scrollTop = terminal.scrollHeight;
  setText('termCount', `${terminal.children.length} LINES`);
}

function renderBios(entries) {
  const terminal = $('#terminal');
  terminal.innerHTML = '';
  if (!entries || !entries.length) {
    appendBios({ ts: new Date().toISOString(), level: 'INFO', line: '[UI] Channel open — awaiting BIOS output…' });
    return;
  }
  entries.forEach((entry) => appendBios(entry));
}

function renderBoot() {
  const list = $('#postSteps');
  if (!list) return;
  list.innerHTML = state.boot.steps.map((step, index) => {
    const status = step.status || 'pending';
    const label = status === 'ok' ? 'OK' : status === 'running' ? 'RUN' : status === 'fail' ? 'FAIL' : 'WAIT';
    return `<li class="boot-step" data-status="${esc(status)}">
      <span class="boot-index">${String(index + 1).padStart(2, '0')}</span>
      <div class="min-w-0">
        <p class="boot-label">${esc(step.label)}</p>
        <p class="boot-detail">${esc(step.detail || '')}</p>
      </div>
      <span class="boot-status">${label}</span>
    </li>`;
  }).join('');

  const done = state.boot.steps.filter((step) => step.status === 'ok').length;
  $('#postProgress').style.width = `${(done / state.boot.steps.length) * 100}%`;
  setText('postCount', `${done}/${state.boot.steps.length}`);
  const footer = $('#postFooter');
  footer.textContent = state.boot.complete ? 'RUNTIME ARMED' : 'POST IN PROGRESS';
  footer.style.color = state.boot.complete ? '#2f9e6b' : '#7d8da6';
}

function applyBoot(boot) {
  if (!boot || !Array.isArray(boot.steps)) return;
  state.boot = { steps: boot.steps, complete: Boolean(boot.complete) };
  renderBoot();
}

function applyBootStep(step) {
  if (!step || typeof step.index !== 'number') return;
  state.boot.steps[step.index] = { ...state.boot.steps[step.index], ...step };
  if (step.status === 'ok') {
    state.boot.complete = state.boot.steps.every((item) => item.status === 'ok');
  }
  renderBoot();
}

/* ------------------------------------------------------------------ */
/* Ledgers                                                            */
/* ------------------------------------------------------------------ */
function switchTab(tab) {
  if (tab === 'audit' && state.user?.role !== 'admin') return;
  state.activeTab = tab;
  $('#tabIncidents').classList.toggle('active', tab === 'incidents');
  $('#tabAudit').classList.toggle('active', tab === 'audit');
  $('#incidentPanel').classList.toggle('hidden', tab !== 'incidents');
  $('#auditPanel').classList.toggle('hidden', tab !== 'audit');
  const panel = tab === 'incidents' ? $('#incidentPanel') : $('#auditPanel');
  panel.classList.remove('fade-switch');
  void panel.offsetWidth;
  panel.classList.add('fade-switch');
}

function incidentRow(row, isNew) {
  const meta = EVENT_META[row.event_type] || { label: String(row.event_type || 'Unknown event').replace(/_/g, ' '), tone: '#94a3b8' };
  const severity = String(row.severity || 'WARNING').toUpperCase();
  const severityClass = severity === 'CRITICAL' ? 'pill-critical' : severity === 'INFO' ? 'pill-info' : 'pill-warning';
  const telemetry = [
    row.temp != null ? `${Number(row.temp).toFixed(1)}°C` : null,
    row.gas != null ? `MQ-2 ${row.gas}` : null,
    row.bpm != null ? `${row.bpm} BPM` : null,
    row.magnitude != null ? `${Number(row.magnitude).toFixed(1)} m/s²` : null,
  ].filter(Boolean).join(' · ');

  return `<tr class="incident-row ${isNew ? 'row-new' : ''}" data-incident-id="${esc(row.id)}" tabindex="0" title="Open incident detail" aria-label="Open details for ${esc(meta.label)} at ${esc(fmtTime(row.timestamp, true))}">
    <td class="mono whitespace-nowrap text-[10.5px] text-slate-400">${esc(fmtTime(row.timestamp, true))}</td>
    <td>
      <div class="flex items-center gap-2">
        <span class="event-dot" style="color:${meta.tone};background:${meta.tone}"></span>
        <div class="min-w-0">
          <p class="font-medium text-slate-200">${esc(meta.label)}</p>
          <p class="mono text-[8px] tracking-[0.06em] text-slate-600">${esc(row.event_type || '—')}</p>
          <p class="mt-1 line-clamp-2 text-[10px] leading-snug text-slate-500 md:hidden">${esc(row.details || '—')}</p>
        </div>
      </div>
    </td>
    <td><span class="pill ${severityClass}">${esc(severity)}</span></td>
    <td class="hidden max-w-[340px] text-[11px] text-slate-400 md:table-cell">${esc(row.details || '—')}</td>
    <td class="mono hidden whitespace-nowrap text-[9.5px] text-slate-500 xl:table-cell">${esc(telemetry || '—')}</td>
    <td class="hidden lg:table-cell"><span class="pill pill-slate">${esc(row.source || 'ESP32')}</span></td>
  </tr>`;
}

function renderIncidents(newId) {
  const body = $('#incidentBody');
  const filter = state.incidentFilter;
  const countFor = (severity) => state.incidents.filter((row) => String(row.severity || '').toUpperCase() === severity).length;
  const criticalCount = countFor('CRITICAL');
  const warningCount = countFor('WARNING');
  const rows = filter === 'ALL' ? state.incidents : state.incidents.filter((row) => String(row.severity || '').toUpperCase() === filter);

  setText('incidentCount', String(state.incidents.length));
  setText('filterAll', String(state.incidents.length));
  setText('filterCritical', String(criticalCount));
  setText('filterWarning', String(warningCount));
  setText('filterSummary', `${rows.length} OF ${state.incidents.length} SHOWN`);
  $$('.ledger-filter').forEach((btn) => {
    const active = btn.dataset.filter === filter;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  if (!state.incidents.length) {
    body.innerHTML = '<tr><td colspan="6"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg><span>No safety incidents recorded in this session.</span><span class="mono text-[9px] text-slate-600">LEDGER READY · INSERT VIA THRESHOLD BREACH</span></div></td></tr>';
    return;
  }
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg><span>No ${esc(filter)} incidents in the loaded ledger window.</span><span class="mono text-[9px] text-slate-600">SELECT ALL TO REVIEW ${state.incidents.length} RECORDED EVENTS</span></div></td></tr>`;
    return;
  }
  body.innerHTML = rows.map((row) => incidentRow(row, row.id === newId)).join('');
}

function drawerStat(label, value, wide = false) {
  return `<div class="drawer-stat${wide ? ' col-span-2' : ''}"><p class="drawer-stat-label">${esc(label)}</p><p class="drawer-stat-value">${esc(value)}</p></div>`;
}

function openIncidentDrawer(id) {
  const row = state.incidents.find((item) => String(item.id) === String(id));
  if (!row) return;

  const meta = EVENT_META[row.event_type] || { label: String(row.event_type || 'Incident').replace(/_/g, ' ') };
  const severity = String(row.severity || 'WARNING').toUpperCase();
  const severityClass = severity === 'CRITICAL' ? 'pill-critical' : severity === 'INFO' ? 'pill-info' : 'pill-warning';
  const accel = [row.accel_x, row.accel_y, row.accel_z]
    .filter((value) => value != null)
    .map((value) => Number(value).toFixed(2))
    .join(' / ');

  state.lastDrawerTrigger = document.activeElement;
  $('#drawerSeverity').className = `pill ${severityClass}`;
  $('#drawerSeverity').textContent = severity;
  $('#drawerTitle').textContent = meta.label;
  $('#drawerSub').textContent = `${fmtTime(row.timestamp, true)} · ${row.event_type || 'EVENT'} · ${row.source || 'ESP32'}`;
  $('#drawerBody').innerHTML = `
    <p class="drawer-detail">${esc(row.details || 'No additional detail recorded.')}</p>
    <div class="drawer-grid">
      ${drawerStat('Impact magnitude', row.magnitude != null ? `${Number(row.magnitude).toFixed(1)} m/s²` : '—')}
      ${drawerStat('Temperature', row.temp != null ? `${Number(row.temp).toFixed(1)} °C` : '—')}
      ${drawerStat('Gas / smoke', row.gas != null ? `${row.gas} ADC` : '—')}
      ${drawerStat('Heart rate', row.bpm != null ? `${row.bpm} BPM` : '—')}
      ${drawerStat('Accelerometer axes', accel || '—', true)}
      ${drawerStat('Recorded source', row.source || 'ESP32', true)}
    </div>
    <p class="drawer-note">INCIDENT #${esc(row.id)} · ${esc(severity)} · SQLITE INCIDENT LEDGER<br>Telemetry snapshot captured at threshold breach. Review the live stream for current conditions.</p>
  `;

  const backdrop = $('#drawerBackdrop');
  const drawer = $('#incidentDrawer');
  backdrop.hidden = false;
  drawer.hidden = false;
  document.body.classList.add('drawer-open');
  requestAnimationFrame(() => {
    backdrop.classList.add('is-open');
    drawer.classList.add('is-open');
  });
  setTimeout(() => $('#drawerClose')?.focus({ preventScroll: true }), 90);
}

function closeIncidentDrawer({ immediate = false } = {}) {
  const backdrop = $('#drawerBackdrop');
  const drawer = $('#incidentDrawer');
  if (!drawer || drawer.hidden) return;
  backdrop.classList.remove('is-open');
  drawer.classList.remove('is-open');
  document.body.classList.remove('drawer-open');
  const finish = () => {
    backdrop.hidden = true;
    drawer.hidden = true;
  };
  const trigger = state.lastDrawerTrigger;
  state.lastDrawerTrigger = null;
  if (immediate) finish();
  else setTimeout(finish, 380);
  if (trigger && trigger.isConnected) {
    setTimeout(() => trigger.focus({ preventScroll: true }), immediate ? 0 : 380);
  }
}

function auditRow(row, isNew) {
  const outcome = String(row.outcome || 'SUCCESS').toUpperCase();
  const outcomeClass = outcome === 'SUCCESS' ? 'pill-success' : outcome === 'DENIED' ? 'pill-warning' : 'pill-critical';
  return `<tr class="${isNew ? 'row-new' : ''}">
    <td class="mono whitespace-nowrap text-[10.5px] text-slate-400">${esc(fmtTime(row.timestamp, true))}</td>
    <td>
      <div class="flex items-center gap-2">
        <span class="grid h-5 w-5 flex-none place-items-center rounded border border-cyan-400/20 bg-cyan-400/[0.06] mono text-[8px] font-bold text-cyan-300">${esc((row.actor || '?').slice(0, 2).toUpperCase())}</span>
        <div class="min-w-0">
          <p class="font-medium text-slate-200">${esc(row.actor || 'SYSTEM')}</p>
          <p class="mono text-[8px] uppercase tracking-[0.06em] text-slate-600">${esc(row.role || 'system')}</p>
        </div>
      </div>
    </td>
    <td><span class="mono text-[9.5px] text-slate-300">${esc(row.action || '—')}</span><br><span class="mono text-[8px] uppercase tracking-[0.06em] text-slate-600">${esc(row.category || 'SYSTEM')}</span>
      <div class="mt-1.5 md:hidden"><span class="pill ${outcomeClass}">${esc(outcome)}</span></div>
      <p class="mt-1 line-clamp-2 max-w-[180px] text-[10px] leading-snug text-slate-500 md:hidden">${esc(row.detail || '—')}</p>
    </td>
    <td class="hidden md:table-cell"><span class="pill ${outcomeClass}">${esc(outcome)}</span></td>
    <td class="hidden max-w-[360px] text-[11px] text-slate-400 md:table-cell">${esc(row.detail || '—')}</td>
    <td class="mono hidden whitespace-nowrap text-[9.5px] text-slate-500 xl:table-cell">${esc(row.ip || '—')}</td>
  </tr>`;
}

function renderAudit(newId) {
  const body = $('#auditBody');
  setText('auditCount', String(state.audit.length));
  if (!state.audit.length) {
    body.innerHTML = '<tr><td colspan="6"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6l7-3z"/></svg><span>Audit ledger empty.</span></div></td></tr>';
    return;
  }
  body.innerHTML = state.audit.map((row) => auditRow(row, row.id === newId)).join('');
}

async function loadIncidents() {
  try {
    const res = await fetch('/api/incidents?limit=80', { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) return showLogin('Your session expired. Sign in again.');
    if (!res.ok) return;
    const data = await res.json();
    state.incidents = Array.isArray(data.incidents) ? data.incidents : [];
    if (data.thresholds) state.thresholds = { ...state.thresholds, ...data.thresholds };
    renderIncidents();
  } catch (err) {
    console.warn('[UI] Incident ledger fetch failed:', err.message);
  }
}

async function loadAudit() {
  if (state.user?.role !== 'admin') return;
  try {
    const res = await fetch('/api/audit?limit=120', { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) return showLogin('Your session expired. Sign in again.');
    if (res.status === 403) {
      $('#tabAudit').classList.add('hidden');
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    state.audit = Array.isArray(data.audit) ? data.audit : [];
    renderAudit();
  } catch (err) {
    console.warn('[UI] Audit fetch failed:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Controls                                                           */
/* ------------------------------------------------------------------ */
async function apiControl(action, value) {
  const res = await fetch('/api/control', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': state.csrf || '',
    },
    body: JSON.stringify({ action, value }),
  });
  if (res.status === 401) {
    showLogin('Your session expired. Sign in again.');
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Control rejected (HTTP ${res.status})`);
  if (data.state) setStatus(data.state);
  if (data.boot) applyBoot(data.boot);
  return data;
}

async function runControl(button, action, value, successTitle) {
  if (!state.user || state.user.role !== 'admin') {
    toast('Administrator privileges are required for this action.', 'alert', 'ACCESS DENIED');
    return;
  }
  if (button) button.classList.add('is-busy');
  try {
    const data = await apiControl(action, value);
    if (data.message) toast(data.message, 'success', successTitle || 'COMMAND ACCEPTED');
    return data;
  } catch (err) {
    toast(err.message, 'alert', 'COMMAND FAILED');
  } finally {
    if (button) button.classList.remove('is-busy');
    updateControlAvailability();
  }
}

async function submitCommand(raw) {
  const command = String(raw || '').trim();
  if (!command) return;
  if (state.user?.role !== 'admin') {
    toast('Administrator privileges are required to send serial commands.', 'alert', 'ACCESS DENIED');
    return;
  }

  try {
    const data = await apiControl('command', command);
    if (data.message) {
      appendBios({ ts: new Date().toISOString(), level: 'INFO', line: `[CONSOLE] ${data.message}` });
    }
    if (Array.isArray(data.lines)) {
      data.lines.forEach((line) => appendBios({ ts: new Date().toISOString(), level: 'INFO', line: `[CONSOLE] ${line}` }));
    }
    toast(data.message || 'Command transmitted.', 'success', 'CONSOLE');
    state.commandHistory.push(command);
    if (state.commandHistory.length > 40) state.commandHistory.shift();
    state.historyIndex = state.commandHistory.length;
    $('#cmdInput').value = '';
  } catch (err) {
    toast(err.message, 'alert', 'CONSOLE');
    appendBios({ ts: new Date().toISOString(), level: 'ERR', line: `[CONSOLE] ${err.message}` });
  }
}

/* ------------------------------------------------------------------ */
/* Socket channel                                                     */
/* ------------------------------------------------------------------ */
function disconnectSocket() {
  if (state.socket) {
    state.socket.removeAllListeners();
    state.socket.disconnect();
    state.socket = null;
  }
  state.socketConnected = false;
}

function connectSocket() {
  if (state.socket) return;
  if (typeof io === 'undefined') {
    toast('Socket.IO client failed to load. Check the server connection.', 'alert', 'LINK ERROR');
    return;
  }

  const socket = io({ transports: ['websocket', 'polling'] });
  state.socket = socket;

  socket.on('connect', () => {
    state.socketConnected = true;
    loadIncidents();
    if (state.user?.role === 'admin') loadAudit();
  });

  socket.on('disconnect', (reason) => {
    state.socketConnected = false;
    if (state.user && reason !== 'io client disconnect') {
      toast('Secure telemetry channel interrupted — reconnecting…', 'warn', 'LINK LOST');
    }
  });

  socket.on('connect_error', (err) => {
    const message = String(err?.message || '');
    if (/unauthorized|auth_failure/i.test(message)) {
      showLogin('Session expired or authorization revoked. Sign in again.');
    }
  });

  socket.on('snapshot', (data) => {
    if (!data) return;
    if (data.status) setStatus(data.status);
    if (data.boot) applyBoot(data.boot);
    if (Array.isArray(data.bios)) renderBios(data.bios);
    if (data.thresholds) state.thresholds = { ...state.thresholds, ...data.thresholds };
  });

  socket.on('telemetry', handleTelemetry);
  socket.on('status', setStatus);
  socket.on('bios', appendBios);
  socket.on('boot_state', applyBoot);
  socket.on('boot_step', applyBootStep);

  socket.on('incident', (incident) => {
    if (!incident) return;
    state.incidents.unshift(incident);
    if (state.incidents.length > 100) state.incidents.pop();
    renderIncidents(incident.id);
    const meta = EVENT_META[incident.event_type];
    toast(`${meta ? meta.label : incident.event_type} · ${incident.details || 'threshold breach'}`, 'alert', 'SAFETY EVENT LOGGED');
    if (state.activeTab !== 'incidents') $('#tabIncidents').classList.add('ring-1', 'ring-rose-400/30');
    setTimeout(() => $('#tabIncidents').classList.remove('ring-1', 'ring-rose-400/30'), 2500);
  });

  socket.on('audit', (row) => {
    if (!row || state.user?.role !== 'admin') return;
    state.audit.unshift(row);
    if (state.audit.length > 200) state.audit.pop();
    renderAudit(row.id);
  });

  socket.on('session_expired', () => showLogin('Your session expired. Sign in again.'));
}

/* ------------------------------------------------------------------ */
/* Clock, uptime & event wiring                                       */
/* ------------------------------------------------------------------ */
function tickMeta() {
  const now = new Date();
  setText('clock', now.toLocaleTimeString('en-GB', { hour12: false }));

  if (state.uptimeAt) {
    const seconds = state.uptimeBase + Math.floor((Date.now() - state.uptimeAt) / 1000);
    setText('uptime', fmtUptime(seconds));
  }

  if (state.lastTelemetryAt) {
    const age = Math.floor((Date.now() - state.lastTelemetryAt) / 1000);
    setText('lastPacket', age <= 0 ? 'JUST NOW' : `${age}s AGO`);
    setText('scanTime', new Date(state.lastTelemetryAt).toLocaleTimeString('en-GB', { hour12: false }));
    if (state.latest) renderSafetyState();
  } else {
    setText('scanTime', '--:--:--');
  }
}

function wireEvents() {
  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (Date.now() < state.loginLockedUntil) return;
    const username = $('#loginUser').value.trim();
    const password = $('#loginPass').value;
    if (!username || !password) {
      setLoginError('Enter both administrator login ID and password.');
      return;
    }

    setLoginError('');
    setLoginBusy(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.retryAfter) {
          lockLogin(data.retryAfter);
          setLoginError(data.error || 'Too many failed attempts.');
        } else {
          setLoginError(data.error || 'Authentication failed.');
          setLoginBusy(false);
        }
        $('#loginPass').value = '';
        return;
      }
      $('#loginPass').value = '';
      enterDashboard(data.user, data.csrfToken);
    } catch (err) {
      setLoginError('Control server unreachable. Verify the Node service is running.');
      setLoginBusy(false);
    }
  });

  $('#togglePass').addEventListener('click', () => {
    const input = $('#loginPass');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    $('#togglePass').textContent = reveal ? 'HIDE' : 'SHOW';
    $('#togglePass').setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    input.focus();
  });

  $('#logoutBtn').addEventListener('click', handleLogout);
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#fullscreenBtn').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', updateFullscreenButton);

  $('#drawerClose').addEventListener('click', () => closeIncidentDrawer());
  $('#drawerBackdrop').addEventListener('click', () => closeIncidentDrawer());
  $('#incidentDrawer').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeIncidentDrawer();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      $('#drawerClose').focus();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#incidentDrawer').hidden) closeIncidentDrawer();
  });

  $('#incidentBody').addEventListener('click', (event) => {
    const row = event.target.closest?.('tr[data-incident-id]');
    if (row) openIncidentDrawer(row.dataset.incidentId);
  });
  $('#incidentBody').addEventListener('keydown', (event) => {
    const row = event.target.closest?.('tr[data-incident-id]');
    if (!row) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openIncidentDrawer(row.dataset.incidentId);
    }
  });

  $('#btnSim').addEventListener('click', () => {
    runControl($('#btnSim'), 'simulate', !state.status.simulation, 'SIMULATION');
  });
  $('#btnBypass').addEventListener('click', () => {
    runControl($('#btnBypass'), 'bypass', null, 'BIOS');
  });
  $('#btnBuzzer').addEventListener('click', () => {
    runControl($('#btnBuzzer'), 'buzzer', !state.status.buzzer, 'ALARM RELAY');
  });
  $('#btnReboot').addEventListener('click', () => {
    runControl($('#btnReboot'), 'reboot', null, 'REBOOT');
  });
  $('#bannerSimBtn').addEventListener('click', () => {
    runControl($('#btnSim'), 'simulate', true, 'SIMULATION');
  });

  $('#cmdForm').addEventListener('submit', (event) => {
    event.preventDefault();
    submitCommand($('#cmdInput').value);
  });

  $('#cmdInput').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!state.commandHistory.length) return;
      state.historyIndex = Math.max(0, Math.min(state.historyIndex, state.commandHistory.length) - 1);
      $('#cmdInput').value = state.commandHistory[state.historyIndex] || '';
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!state.commandHistory.length) return;
      state.historyIndex = Math.min(state.commandHistory.length, state.historyIndex + 1);
      $('#cmdInput').value = state.commandHistory[state.historyIndex] || '';
    }
  });

  $('#tabIncidents').addEventListener('click', () => switchTab('incidents'));
  $('#tabAudit').addEventListener('click', () => switchTab('audit'));

  $$('.ledger-filter').forEach((button) => {
    button.addEventListener('click', () => {
      state.incidentFilter = button.dataset.filter || 'ALL';
      renderIncidents();
    });
  });

  $('#refreshLedger').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.style.opacity = '0.5';
    try {
      await Promise.all([loadIncidents(), state.user?.role === 'admin' ? loadAudit() : Promise.resolve()]);
      toast('Ledger refreshed from SQLite.', 'success', 'LEDGER');
    } finally {
      button.disabled = false;
      button.style.opacity = '';
    }
  });

  $('#clearTerminal').addEventListener('click', () => {
    $('#terminal').innerHTML = '';
    appendBios({ ts: new Date().toISOString(), level: 'INFO', line: '[UI] Terminal buffer cleared by operator.' });
  });

  $('#autoscrollBtn').addEventListener('click', () => {
    state.autoscroll = !state.autoscroll;
    $('#autoscrollLabel').textContent = state.autoscroll ? 'AUTO-SCROLL ON' : 'AUTO-SCROLL OFF';
    $('#autoscrollBtn').classList.toggle('opacity-50', !state.autoscroll);
    if (state.autoscroll) {
      const terminal = $('#terminal');
      terminal.scrollTop = terminal.scrollHeight;
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.chartsReady) {
      state.charts.accel.resize();
      state.charts.gyro.resize();
      state.charts.accel.update('none');
      state.charts.gyro.update('none');
    }
  });
}

function initSpotlight() {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  document.addEventListener('pointermove', (event) => {
    const card = event.target?.closest?.('.sensor-card');
    if (!card || state.spotlightFrame) return;
    const x = event.clientX;
    const y = event.clientY;
    state.spotlightFrame = requestAnimationFrame(() => {
      state.spotlightFrame = 0;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${x - rect.left}px`);
      card.style.setProperty('--my', `${y - rect.top}px`);
    });
  }, { passive: true });
}

renderBoot();
wireEvents();
applyTheme(document.body.dataset.theme || 'light', { persist: false });
initSpotlight();
tickMeta();
setInterval(tickMeta, 1000);
checkSession();
