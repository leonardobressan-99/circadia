(() => {
  'use strict';

  // Deep red lights only the red subpixel (≈ 625 nm on a typical display); amber mixes in a little green.
  // Morning sun is a bright, warm daylight white (≈ 5500 K) for waking up, not for the evening.
  // 'ember' is no longer offered but still labels old sessions in Stats.
  const TONES = {
    // accent: UI colour (buttons, glows) for this tone; light: lighter tint; on: text on a solid accent.
    deep:  { name: 'Deep red',    hex: '#ff0000', spec: '≈ 625 nm', period: 'Evening light',
             accent: '255, 68, 51',  light: '#ff8a6e', on: '#ffffff' },
    amber: { name: 'Amber',       hex: '#ff5200', spec: '≈ 600 nm', period: 'Evening light',
             accent: '255, 122, 26', light: '#ffab6b', on: '#ffffff' },
    sun:   { name: 'Morning sun', hex: '#fff3df', spec: '≈ 5500 K', period: 'Morning light',
             accent: '245, 185, 66', light: '#ffd98a', on: '#2a1a0c' },
    ember: { name: 'Ember',       hex: '#ff2a00', spec: '≈ 612 nm', period: 'Evening light',
             accent: '255, 68, 51',  light: '#ff8a6e', on: '#ffffff' },
  };
  const TONE_ORDER = ['deep', 'amber', 'sun'];
  // Both modes fill the whole screen. 'glow' is no longer offered but still labels old sessions in Stats.
  const MODES = { solid: 'Solid', breathe: 'Breathe', glow: 'Glow' };
  const MODE_ORDER = ['solid', 'breathe'];
  const TIMER_ORDER = [0, 10, 15, 20, 25, 30];
  const MIN_INTENSITY = 3, MAX_INTENSITY = 100;

  const FADE_MS = 60 * 1000;      // the sleep timer fades out over its final minute
  const MIN_SESSION_S = 10;       // shorter sessions aren't recorded
  const IDLE_MS = 3000;           // session controls dim after this long without a touch
  const HEARTBEAT_MS = 15 * 1000; // how often a running session is checkpointed

  const KEYS = {
    settings: 'redlight.settings.v1',
    ack: 'redlight.ack.v1',
    sessions: 'redlight.sessions.v1',
    active: 'redlight.active.v1',
  };
  const DEFAULT_THEME = '#0b0b0c';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const root = document.documentElement;
  const themeMeta = $('meta[name="theme-color"]');

  // ---------- storage (best effort; the app still works without it) ----------
  function read(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
  function remove(key) {
    try { localStorage.removeItem(key); } catch {}
  }

  const settings = Object.assign({ intensity: 60, tone: 'deep', mode: 'solid', timer: 0 }, read(KEYS.settings, {}));
  if (!TONE_ORDER.includes(settings.tone)) settings.tone = 'deep';
  if (!MODE_ORDER.includes(settings.mode)) settings.mode = 'solid';
  if (!TIMER_ORDER.includes(settings.timer)) settings.timer = 0;
  const saveSettings = () => write(KEYS.settings, settings);

  // ---------- colour helpers ----------
  function scaleHex(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const c = (v) => Math.round(v * k).toString(16).padStart(2, '0');
    return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
  }
  // Mix a toward b; k = 1 gives a, k = 0 gives b.
  function mixHex(a, b, k) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ch = (sh) => Math.round(((pa >> sh) & 255) * k + ((pb >> sh) & 255) * (1 - k)).toString(16).padStart(2, '0');
    return `#${ch(16)}${ch(8)}${ch(0)}`;
  }
  // True when a colour is light enough that white text on it would be hard to read.
  function isBright(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.4;
  }

  // Session colour at a given level (0–1). The light, the session layer, the page background and the
  // browser bars all use this same solid colour, so Safari tints its status bar and toolbar to match.
  function setSessionLevel(level) {
    const c = scaleHex(TONES[session ? session.tone : settings.tone].hex, Math.max(0, Math.min(1, level)));
    root.style.setProperty('--session-bg', c);
    root.classList.toggle('session-bright', isBright(c));
    setThemeColor(c);
  }

  // =====================================================================
  // Light view
  // =====================================================================
  const dial = $('#dial');
  const dialSvg = dial.querySelector('svg');
  const arcFill = $('#arcFillPath');
  const arcKnob = $('#arcKnob');
  // Regulator geometry, in SVG units (viewBox 0 0 320 190): a half-circle arc from left (0%) to right (100%).
  const CX = 160, CY = 160, R = 134;
  const A_START = Math.PI;
  const A_SPAN = Math.PI;
  const polar = (r, a) => [CX + r * Math.cos(a), CY - r * Math.sin(a)];

  // A word for the current level, shown under the number like a readiness score.
  const LEVEL_WORDS = [[15, 'Night light'], [35, 'Soft glow'], [60, 'Warm'], [85, 'Bright'], [101, 'Full']];
  const levelWord = (v) => LEVEL_WORDS.find(([max]) => v < max)[1];

  const fmtTimer = (m) => (m ? `${m} min` : 'Off');

  function renderSettings() {
    const tone = TONES[settings.tone];
    root.style.setProperty('--tone', tone.hex);
    root.style.setProperty('--accent-rgb', tone.accent);
    root.style.setProperty('--accent-light', tone.light);
    root.style.setProperty('--on-accent', tone.on);
    root.style.setProperty('--level', String(settings.intensity / 100));
    document.body.classList.toggle('mode-breathe', settings.mode === 'breathe');

    // Regulator: a glowing fill along the arc ending in a bright dot.
    // The arc spans 0–100%; values below the 3% floor are never reached.
    const p = settings.intensity / 100;
    arcFill.style.strokeDasharray = `${(p * 100).toFixed(2)} 100`;
    const [kx, ky] = polar(R, A_START - p * A_SPAN);
    arcKnob.setAttribute('transform', `translate(${kx.toFixed(2)} ${ky.toFixed(2)})`);
    // Stretch the fill gradient so it is brightest exactly at the dot.
    $('#arcFill').setAttribute('x2', Math.max(kx, 30).toFixed(2));
    $('#levelWord').textContent = levelWord(settings.intensity);
    dial.setAttribute('aria-valuenow', String(settings.intensity));
    dial.setAttribute('aria-valuetext', `${settings.intensity}%`);
    $('#intensityOut').textContent = settings.intensity;
    $('#nmChip').textContent = tone.spec;

    $('#toneName').textContent = `${tone.name} · ${tone.spec}`;
    $('#heroEyebrow').textContent = tone.period;
    updateChrome();
    $$('[data-tone]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tone === settings.tone)));
    $('#modeOut').textContent = MODES[settings.mode];
    $('#timerOut').textContent = fmtTimer(settings.timer);
    $$('#optionsSheet [data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode)));
    $$('#optionsSheet [data-timer]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.timer) === settings.timer)));
  }

  function setIntensity(v) {
    const next = Math.round(Math.min(MAX_INTENSITY, Math.max(MIN_INTENSITY, v)));
    if (next === settings.intensity) return;
    settings.intensity = next;
    renderSettings();
  }

  // Dragging anywhere on the dial moves the knob to the pointer's angle.
  function intensityFromPointer(e) {
    const r = dialSvg.getBoundingClientRect();
    const vb = dialSvg.viewBox.baseVal;
    const x = (e.clientX - r.left) * (vb.width / r.width);
    const y = (e.clientY - r.top) * (vb.height / r.height);
    let a = Math.atan2(CY - y, x - CX);
    if (a < 0) a = x < CX ? Math.PI : 0; // below the arc: snap to the nearest end
    return (1 - a / Math.PI) * 100;
  }
  let dragging = false;
  dial.addEventListener('pointerdown', (e) => {
    dragging = true;
    dial.setPointerCapture(e.pointerId);
    setIntensity(intensityFromPointer(e));
  });
  dial.addEventListener('pointermove', (e) => { if (dragging) setIntensity(intensityFromPointer(e)); });
  const endDrag = () => { if (dragging) { dragging = false; saveSettings(); } };
  dial.addEventListener('pointerup', endDrag);
  dial.addEventListener('pointercancel', endDrag);
  dial.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (e.key === 'Home') setIntensity(MIN_INTENSITY);
    else if (e.key === 'End') setIntensity(MAX_INTENSITY);
    else if (step) setIntensity(settings.intensity + step);
    else return;
    e.preventDefault();
    saveSettings();
  });

  $$('[data-tone]').forEach((b) => b.addEventListener('click', () => { settings.tone = b.dataset.tone; saveSettings(); renderSettings(); }));

  // ---------- Mode & timer sheet (slides up from the bottom) ----------
  const sheet = $('#optionsSheet');
  let sheetOpener = null;

  function openSheet(opener) {
    sheetOpener = opener;
    sheet.inert = false;
    sheet.setAttribute('aria-hidden', 'false');
    sheet.style.removeProperty('--drag');
    document.body.classList.add('sheet-open');
    fadeChrome();
    // Focus the sheet itself (not a button) so screen readers land in it without a focus ring on a choice.
    setTimeout(() => sheet.focus({ preventScroll: true }), 50);
  }
  // Animate the top colour only when the sheet opens/closes (not while dragging the regulator).
  let fadeTimer = 0;
  function fadeChrome() {
    root.classList.add('chrome-fade');
    updateChrome();
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => root.classList.remove('chrome-fade'), 450);
  }
  function closeSheet() {
    if (!document.body.classList.contains('sheet-open') || desktopMQ.matches) return;
    document.body.classList.remove('sheet-open');
    fadeChrome();
    sheet.style.removeProperty('--drag');
    sheet.setAttribute('aria-hidden', 'true');
    sheet.inert = true;
    if (sheetOpener) sheetOpener.focus({ preventScroll: true });
  }

  $('#modeBtn').addEventListener('click', (e) => openSheet(e.currentTarget));
  $('#timerBtn').addEventListener('click', (e) => openSheet(e.currentTarget));
  $('#sheetBackdrop').addEventListener('click', closeSheet);
  $('.top-light').addEventListener('click', closeSheet); // it sits above the backdrop while the sheet is open
  $('#sheetDone').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  sheet.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    settings.mode = b.dataset.mode; saveSettings(); renderSettings();
  }));
  sheet.querySelectorAll('[data-timer]').forEach((b) => b.addEventListener('click', () => {
    settings.timer = Number(b.dataset.timer); saveSettings(); renderSettings();
  }));

  // On desktop the sheet is docked as a permanent side panel instead of a modal.
  const desktopMQ = window.matchMedia('(min-width: 1024px)');
  function applyLayout() {
    if (desktopMQ.matches) {
      document.body.classList.remove('sheet-open');
      sheet.inert = false;
      sheet.setAttribute('aria-hidden', 'false');
      sheet.setAttribute('role', 'region');
      sheet.removeAttribute('aria-modal');
    } else {
      const open = document.body.classList.contains('sheet-open');
      sheet.inert = !open;
      sheet.setAttribute('aria-hidden', String(!open));
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
    }
    sheet.style.removeProperty('--drag');
    updateChrome();
  }
  desktopMQ.addEventListener('change', applyLayout);

  // Drag the handle down to dismiss.
  const grab = $('#sheetGrab');
  let dragStartY = null;
  grab.addEventListener('pointerdown', (e) => {
    if (desktopMQ.matches) return;
    dragStartY = e.clientY;
    grab.setPointerCapture(e.pointerId);
    sheet.classList.add('dragging');
  });
  grab.addEventListener('pointermove', (e) => {
    if (dragStartY === null) return;
    sheet.style.setProperty('--drag', `${Math.max(0, e.clientY - dragStartY)}px`);
  });
  const endSheetDrag = (e) => {
    if (dragStartY === null) return;
    const dy = e.clientY - dragStartY;
    dragStartY = null;
    sheet.classList.remove('dragging');
    if (dy > 90) closeSheet();
    else sheet.style.removeProperty('--drag');
  };
  grab.addEventListener('pointerup', endSheetDrag);
  grab.addEventListener('pointercancel', endSheetDrag);

  // The fixed top layer is exactly as tall as the solid part of the Light screen.
  const hero = $('.hero');
  const syncHeroHeight = () => root.style.setProperty('--hero-h', `${Math.ceil(hero.getBoundingClientRect().height)}px`);
  if ('ResizeObserver' in window) new ResizeObserver(syncHeroHeight).observe(hero);
  window.addEventListener('resize', syncHeroHeight);

  // =====================================================================
  // Tabs
  // =====================================================================
  function showView(name) {
    document.body.dataset.view = name;
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
    $$('.tab').forEach((t) => {
      const on = t.dataset.view === name;
      t.classList.toggle('is-active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    if (name === 'stats') renderStats();
    updateChrome();
    window.scrollTo(0, 0);
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

  // =====================================================================
  // Session
  // =====================================================================
  const sessionEl = $('#session');
  const light = $('#light');
  const sessionUi = $('#sessionUi');
  const sessionTime = $('#sessionTime');
  const done = $('#done');

  let session = null; // { start, end (timer end or 0), tone, mode, intensity }
  let tickId = 0, idleId = 0, beatId = 0;
  let wakeLock = null;

  function setThemeColor(c) {
    if (themeMeta) themeMeta.setAttribute('content', c);
  }
  // Browser chrome / status bar colour: the light colour on the home screen, charcoal elsewhere.
  function updateChrome() {
    if (session) return;
    const onLight = document.body.dataset.view === 'light';
    const lit = mixHex(TONES[settings.tone].hex, DEFAULT_THEME, settings.intensity / 100);
    // With the sheet open the screen is dimmed by its backdrop (black at 45%), so dim the top layer to match.
    const top = document.body.classList.contains('sheet-open') ? scaleHex(lit, 0.55) : lit;
    root.style.setProperty('--lit-hex', lit);
    root.classList.toggle('hero-bright', isBright(lit));
    root.style.setProperty('--top-light', top);
    setThemeColor(onLight ? top : DEFAULT_THEME);
  }

  // ---------- start/end transition: the light grows out of (and back into) the play button ----------
  // Uses a CSS transition on clip-path (Safari animates this reliably; Web Animations clip-path it does not).
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const DUR_IN = 750, DUR_OUT = 600;
  let animTimer = 0;
  function revealShapes() {
    const b = $('#startBtn').getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    // Radius that covers the whole screen from the button's centre.
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 40;
    return { small: `circle(${b.width / 2}px at ${x}px ${y}px)`, big: `circle(${r}px at ${x}px ${y}px)` };
  }
  function setClip(v) {
    sessionEl.style.clipPath = v;
    sessionEl.style.webkitClipPath = v;
  }
  function animateSession(direction, done) {
    clearTimeout(animTimer);
    const inward = direction === 'in';
    const duration = inward ? DUR_IN : DUR_OUT;
    const { small, big } = revealShapes();
    sessionEl.style.transition = 'none';
    if (reduceMotion.matches) {
      setClip('none');
      sessionEl.style.opacity = inward ? '0' : '1';
    } else {
      setClip(inward ? small : big);
    }
    void sessionEl.offsetWidth; // commit the start state before transitioning
    const ease = inward ? 'cubic-bezier(0.22, 1, 0.36, 1)' : 'cubic-bezier(0.55, 0, 0.75, 0.2)';
    sessionEl.style.transition = `clip-path ${duration}ms ${ease}, -webkit-clip-path ${duration}ms ${ease}, opacity ${duration}ms ${ease}`;
    if (!reduceMotion.matches) setClip(inward ? big : small);
    else sessionEl.style.opacity = inward ? '1' : '0';
    animTimer = setTimeout(() => {
      sessionEl.style.transition = '';
      if (inward) { setClip(''); sessionEl.style.opacity = ''; }
      if (done) done();
      if (!inward) { setClip(''); sessionEl.style.opacity = ''; }
    }, duration + 60);
  }

  function startSession() {
    if (session) return;
    session = {
      start: Date.now(),
      end: settings.timer ? Date.now() + settings.timer * 60 * 1000 : 0,
      tone: settings.tone,
      mode: settings.mode,
      intensity: settings.intensity,
    };

    light.className = `light${settings.mode === 'solid' ? '' : ' ' + settings.mode}`;
    setSessionLevel(settings.intensity / 100);
    done.hidden = true;
    sessionUi.hidden = false;
    sessionEl.hidden = false;
    // Keep the home screen intact around the growing circle; switch the page to session mode once covered.
    animateSession('in', () => { if (session) root.classList.add('in-session'); });

    enterFullscreen();
    requestWakeLock();
    tick();
    tickId = setInterval(tick, 1000);
    beatId = setInterval(checkpoint, HEARTBEAT_MS);
    checkpoint();
    wake();
  }

  function tick() {
    if (!session) return;
    const now = Date.now();
    if (session.end) {
      const left = session.end - now;
      sessionTime.textContent = fmtClock(left);
      if (left <= 0) return finishByTimer();
      if (left < FADE_MS) setSessionLevel((session.intensity / 100) * (left / FADE_MS));
    } else {
      sessionTime.textContent = fmtClock(now - session.start);
    }
  }

  function checkpoint() {
    if (session) write(KEYS.active, { ...session, last: Date.now() });
  }

  function recordSession(endAt) {
    if (!session) return 0;
    const d = Math.round((endAt - session.start) / 1000);
    if (d >= MIN_SESSION_S) {
      const list = read(KEYS.sessions, []);
      list.push({ s: session.start, d, t: session.tone, m: session.mode, i: session.intensity });
      write(KEYS.sessions, list.slice(-1000));
    }
    remove(KEYS.active);
    return d;
  }

  function teardownSession() {
    clearInterval(tickId);
    clearInterval(beatId);
    clearTimeout(idleId);
    session = null;
  }

  function finishByTimer() {
    const d = recordSession(session.end);
    setSessionLevel(0);
    teardownSession();
    releaseWakeLock();
    $('#doneSub').textContent = `${fmtDuration(d)} session saved`;
    done.hidden = false;
    sessionUi.classList.remove('idle');
    sessionUi.hidden = true;
  }

  let closing = false;
  function closeSession() {
    if (closing) return;
    closing = true;
    if (session) recordSession(Date.now());
    teardownSession();
    releaseWakeLock();
    exitFullscreen();
    renderStats();
    // Restore the home screen underneath, then shrink the light back into the play button.
    root.classList.remove('in-session');
    updateChrome();
    animateSession('out', () => {
      sessionEl.hidden = true;
      done.hidden = true;
      closing = false;
    });
  }

  // Session controls fade after a few seconds and come back on any touch.
  function wake() {
    sessionUi.classList.remove('idle');
    clearTimeout(idleId);
    idleId = setTimeout(() => sessionUi.classList.add('idle'), IDLE_MS);
  }

  $('#startBtn').addEventListener('click', startSession);
  $('#closeBtn').addEventListener('click', (e) => { e.stopPropagation(); closeSession(); });
  $('#doneBtn').addEventListener('click', closeSession);
  sessionEl.addEventListener('pointerdown', () => { if (session) wake(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sessionEl.hidden) closeSession(); });

  // A session cut short by closing the app is recovered from its last checkpoint.
  function recoverActiveSession() {
    const a = read(KEYS.active, null);
    if (!a || !a.start) return;
    session = a;
    recordSession(Math.min(a.last || a.start, a.end || Infinity));
    session = null;
  }

  // ---------- full screen (Android / desktop; iPhone uses Add to Home Screen instead) ----------
  function enterFullscreen() {
    const fn = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!fn) return;
    try {
      const p = fn.call(root, { navigationUI: 'hide' });
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }
  function exitFullscreen() {
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (isFs && fn) {
      try {
        const p = fn.call(document);
        if (p && p.catch) p.catch(() => {});
      } catch {}
    }
  }

  // ---------- keep the screen on during a session ----------
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || !session) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* unsupported or denied: the light still works, the screen may just sleep */ }
  }
  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (session && !wakeLock) requestWakeLock();
      tick();
    } else {
      checkpoint();
    }
  });

  // =====================================================================
  // Statistics
  // =====================================================================
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  // Calendar-day arithmetic (safe across daylight-saving changes).
  const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return startOfDay(d); };

  function fmtClock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }
  function fmtDuration(sec) {
    if (sec < 60) return `${Math.round(sec)}s`;
    const m = Math.round(sec / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  function fmtDay(t) {
    const today = startOfDay(Date.now());
    const day = startOfDay(t);
    if (day === today) return 'Today';
    if (day === addDays(today, -1)) return 'Yesterday';
    return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const fmtShortDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  function mostFrequent(list, key) {
    const counts = {};
    list.forEach((x) => { counts[x[key]] = (counts[x[key]] || 0) + 1; });
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }

  function streak(list) {
    const days = new Set(list.map((x) => startOfDay(x.s)));
    let day = startOfDay(Date.now());
    if (!days.has(day)) day = addDays(day, -1); // a streak still counts if today's session hasn't happened yet
    let n = 0;
    while (days.has(day)) { n++; day = addDays(day, -1); }
    return n;
  }

  const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9"/></svg>';

  // Monday-to-Sunday circles for the current week.
  function renderWeekDots(list) {
    const today = startOfDay(Date.now());
    const monday = addDays(today, -((new Date(today).getDay() + 6) % 7));
    const days = new Set(list.map((x) => startOfDay(x.s)));
    const wrap = $('#weekDots');
    wrap.textContent = '';
    for (let i = 0; i < 7; i++) {
      const day = addDays(monday, i);
      const has = days.has(day);
      const state = day === today ? 'today' : day > today ? 'future' : 'past';
      const el = document.createElement('div');
      el.className = `wd ${state} ${has ? 'is-done' : 'is-missed'}`;
      el.innerHTML = `<div class="wd-c">${has ? CHECK_SVG : ''}</div><span></span>`;
      el.querySelector('span').textContent = new Date(day).toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2);
      el.setAttribute('aria-label', `${new Date(day).toLocaleDateString(undefined, { weekday: 'long' })}: ${has ? 'light used' : 'no session'}`);
      wrap.appendChild(el);
    }
    $('#weekRange').textContent = `${fmtShortDate(monday)} – ${fmtShortDate(addDays(monday, 6))}`;
  }

  function renderStats() {
    const list = read(KEYS.sessions, []);
    const total = list.reduce((a, x) => a + x.d, 0);

    renderWeekDots(list);
    $('#stTotal').textContent = total ? fmtDuration(total) : '0m';
    $('#stCount').textContent = String(list.length);
    $('#stAvg').textContent = list.length ? fmtDuration(total / list.length) : '0m';
    $('#stStreak').textContent = String(streak(list));

    const favTone = mostFrequent(list, 't');
    const favMode = mostFrequent(list, 'm');
    $('#stFavTone').textContent = favTone && TONES[favTone] ? TONES[favTone].name : '–';
    $('#stFavMode').textContent = favMode && MODES[favMode] ? MODES[favMode] : '–';
    $('#stLongest').textContent = list.length ? fmtDuration(Math.max(...list.map((x) => x.d))) : '–';

    renderWeek(list);

    const ul = $('#sessionList');
    ul.textContent = '';
    list.slice(-20).reverse().forEach((x) => {
      const tone = TONES[x.t] || TONES.deep;
      const li = document.createElement('li');
      li.innerHTML = `
        <i class="sw" style="--c:${tone.hex}"></i>
        <span class="s-main">
          <span class="s-date"></span>
          <span class="s-meta"></span>
        </span>
        <span class="s-dur"></span>`;
      li.querySelector('.s-date').textContent = `${fmtDay(x.s)}, ${fmtTime(x.s)}`;
      li.querySelector('.s-meta').textContent = `${tone.name} · ${MODES[x.m] || ''} · ${x.i}%`;
      li.querySelector('.s-dur').textContent = fmtDuration(x.d);
      ul.appendChild(li);
    });
    $('#emptyState').hidden = list.length > 0;
    $('#clearBtn').hidden = list.length === 0;
  }

  function renderWeek(list) {
    const chart = $('#weekChart');
    const today = startOfDay(Date.now());
    const days = [];
    for (let i = 6; i >= 0; i--) days.push({ day: addDays(today, -i), sec: 0, n: 0 });
    list.forEach((x) => {
      const d = days.find((b) => b.day === startOfDay(x.s));
      if (d) { d.sec += x.d; d.n++; }
    });
    $('#stWeek').textContent = fmtDuration(days.reduce((a, d) => a + d.sec, 0));

    // Round the scale up to a friendly number of minutes.
    const maxMin = Math.max(10, ...days.map((d) => d.sec / 60));
    const steps = [10, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480];
    const scale = steps.find((s) => s >= maxMin) || Math.ceil(maxMin / 60) * 60;
    chart.dataset.max = fmtDuration(scale * 60);

    chart.textContent = '';
    days.forEach((d) => {
      const el = document.createElement('div');
      el.className = `day${d.day === today ? ' today' : ''}`;
      const pct = Math.min(100, (d.sec / 60 / scale) * 100);
      el.innerHTML = `<div class="bar-hit"><div class="bar" style="height:0%"></div></div><span class="day-label"></span>`;
      el.querySelector('.day-label').textContent = new Date(d.day).toLocaleDateString(undefined, { weekday: 'narrow' });
      el.dataset.tip = `${new Date(d.day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}|${d.sec ? fmtDuration(d.sec) : '0m'}|${d.n}`;
      chart.appendChild(el);
      requestAnimationFrame(() => { el.querySelector('.bar').style.height = `${pct}%`; });
    });
  }

  // Tooltip: hover on desktop, tap/drag on touch.
  const tip = $('#chartTip');
  function showTip(dayEl) {
    $$('.week .day').forEach((d) => d.classList.toggle('is-hover', d === dayEl));
    if (!dayEl) { tip.hidden = true; return; }
    const [date, dur, n] = dayEl.dataset.tip.split('|');
    tip.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = dur;
    tip.append(b, ` · ${n} session${n === '1' ? '' : 's'} · ${date}`);
    const card = tip.parentElement.getBoundingClientRect();
    const bar = dayEl.querySelector('.bar').getBoundingClientRect();
    const x = Math.min(Math.max(bar.left + bar.width / 2 - card.left, 100), card.width - 100);
    tip.style.left = `${x}px`;
    tip.style.top = `${bar.top - card.top - 8}px`;
    tip.hidden = false;
  }
  const weekChart = $('#weekChart');
  weekChart.addEventListener('pointermove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    showTip(el && el.closest('.day'));
  });
  weekChart.addEventListener('pointerdown', (e) => showTip(e.target.closest('.day')));
  weekChart.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') showTip(null); });

  $('#clearBtn').addEventListener('click', () => {
    if (confirm('Delete all session history on this device?')) {
      remove(KEYS.sessions);
      renderStats();
    }
  });

  // =====================================================================
  // Start-up
  // =====================================================================
  recoverActiveSession();
  applyLayout();
  renderSettings();
  syncHeroHeight();
  renderStats();

  const about = $('#about');
  if (read(KEYS.ack, null) !== 1) about.showModal();
  about.addEventListener('close', () => write(KEYS.ack, 1));

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
