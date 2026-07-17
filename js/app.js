/*
 * WC26 Transit — app bootstrap & interactions
 * Panels, tooltips, journey playback, pan/zoom, theming, polling.
 */

import { loadModel, ROUND_LABEL } from './data.js';
import { render, scoreText, visibleColor, textOn, L } from './metro.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const SVGNS = 'http://www.w3.org/2000/svg';
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOBILE_MQ = window.matchMedia('(max-width: 900px)');
const isMobile = () => MOBILE_MQ.matches;

function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
}

const state = {
  model: null,
  source: 'live',
  geo: null,
  svg: null,
  routes: null,
  stationEls: null,
  selected: null,      // teamId
  focusTeams: new Set(),
  vb: { x: 0, y: 0, w: 1000, h: 700 },
  pollTimer: null,
  booted: false,
};

/* ------------------------------------------------------------ boot */

boot();

async function boot() {
  try {
    const { model, source } = await loadModel();
    state.model = model;
    state.source = source;
    mount();
    schedulePoll();
  } catch (err) {
    $('#mapwrap').innerHTML = `<div class="fatal">⚠ ${err.message}</div>`;
  }
}

function mount() {
  destroyPlayLayer();
  const wrap = $('#mapwrap');
  wrap.innerHTML = '';
  const { svg, geo, teamAnchors, routes, stationEls } = render(state.model);
  state.svg = svg;
  state.geo = geo;
  state.teamAnchors = teamAnchors;
  state.routes = routes;
  state.stationEls = stationEls;
  wrap.appendChild(svg);

  // first mount picks the entry view; later remounts (theme, poll) keep the user's camera
  if (!state.booted) {
    initialView();
    state.booted = true;
  } else {
    applyVb();
  }
  buildRoundStrip();
  buildDirectory();
  buildBoard();
  bindMapInteractions();
  updatePlaque();
  if (state.selected) selectTeam(state.selected, { fly: false });
}

/* entry view: desktop fits the whole network; phones open readable,
   zoomed into the group districts */
function initialView() {
  if (!isMobile()) return fitMap(false);
  const r = $('#mapwrap').getBoundingClientRect();
  const w = Math.min(900, Math.max(400, r.width / 0.92));
  state.vb = { x: -14, y: 26, w, h: w / aspect() };
  applyVb();
}

function updatePlaque() {
  const m = state.model;
  const when = new Date(m.fetchedAt);
  $('#datasource').textContent =
    `${state.source === 'live' ? '● LIVE' : state.source === 'snapshot' ? '◐ SNAPSHOT' : '◌ CACHED'} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('#datasource').className = `ds ds-${state.source}`;
}

/* ------------------------------------------------------------ theme */

function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#theme-toggle').textContent = dark ? 'Day' : 'Night';
  $('#m-theme').textContent = dark ? '☀' : '☾';
}
updateThemeButton();

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('wc26-theme', next); } catch { /* private mode */ }
  updateThemeButton();
  if (state.model) mount(); // re-render: line colors are theme-adjusted
}
$('#theme-toggle').addEventListener('click', toggleTheme);
$('#m-theme').addEventListener('click', toggleTheme);

/* ------------------------------------------------------ round strip */

const ROUND_STOPS = [
  ['GROUPS', 190],
  ['YARD', L.YARD_X0 + 16 * L.TRACK_PITCH],
  ['R32', L.R32_X],
  ['R16', L.R16_X],
  ['QF', L.QF_X],
  ['SF', L.SF_X],
  ['FINAL', L.FINAL_X],
];
let stripActive = -1;

function buildRoundStrip() {
  const strip = $('#roundstrip');
  if (!strip.childElementCount) {
    for (const [label, x] of ROUND_STOPS) {
      const b = document.createElement('button');
      b.className = 'rs-stop';
      b.textContent = label;
      b.addEventListener('click', () => {
        play.follow = false;
        animateVb({ x: x - state.vb.w / 2, y: state.vb.y, w: state.vb.w, h: state.vb.h });
      });
      strip.appendChild(b);
    }
  }
  stripActive = -1;
  updateRoundStrip();
}

function updateRoundStrip() {
  const strip = $('#roundstrip');
  if (!strip || !strip.childElementCount) return;
  const cx = state.vb.x + state.vb.w / 2;
  let best = 0, bd = Infinity;
  ROUND_STOPS.forEach(([, x], i) => {
    const d = Math.abs(x - cx);
    if (d < bd) { bd = d; best = i; }
  });
  if (best === stripActive) return;
  stripActive = best;
  [...strip.children].forEach((el2, i) => el2.classList.toggle('active', i === best));
}

/* -------------------------------------------------------- directory */

function buildDirectory() {
  const dir = $('#teamlist');
  dir.innerHTML = '';
  const { groups, letters } = state.geo;
  for (const g of letters) {
    const h = document.createElement('div');
    h.className = 'dir-group';
    h.textContent = `GROUP ${g}`;
    dir.appendChild(h);
    for (const t of groups[g]) {
      const row = document.createElement('button');
      row.className = 'dir-team';
      row.dataset.team = t.id;
      row.dataset.search = `${t.name} ${t.abbr}`.toLowerCase();
      const inBronze = !t.champion && t.journey.some((j) => j.round === 'm3p' && j.result === 'sched');
      const status = t.champion ? ['CHAMPION', 'st-champ']
        : inBronze ? ['BRONZE', 'st-bronze']
        : t.eliminatedRound ? [`OUT · ${ROUND_LABEL[t.eliminatedRound].toUpperCase()}`, 'st-out']
        : t.alive ? ['IN SERVICE', 'st-alive'] : ['—', 'st-out'];
      row.innerHTML = `
        <span class="dt-swatch" style="background:${visibleColor(t.color)}"></span>
        ${t.logo ? `<img class="dt-flag" src="${t.logo}" alt="" loading="lazy">` : ''}
        <span class="dt-name">${t.name}</span>
        <span class="dt-status ${status[1]}">${status[0]}</span>`;
      row.addEventListener('click', () => selectTeam(t.id, { fly: true }));
      dir.appendChild(row);
    }
  }
}

$('#search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  for (const row of $$('.dir-team')) {
    row.style.display = !q || row.dataset.search.includes(q) ? '' : 'none';
  }
  for (const h of $$('.dir-group')) {
    let el = h.nextElementSibling;
    let any = false;
    while (el && !el.classList.contains('dir-group')) {
      if (el.style.display !== 'none') any = true;
      el = el.nextElementSibling;
    }
    h.style.display = any ? '' : 'none';
  }
});

/* -------------------------------------------------------- departures */

function buildBoard() {
  const board = $('#board-list');
  board.innerHTML = '';
  const m = state.model;
  const live = m.matches.filter((x) => x.status === 'in');
  const next = m.matches.filter((x) => x.status === 'pre').sort((a, b) => a.ts - b.ts).slice(0, 3);
  const recent = m.matches.filter((x) => x.status === 'post').sort((a, b) => b.ts - a.ts).slice(0, 3);

  const item = (match, kind) => {
    const a = m.teams[match.a.teamId], b = m.teams[match.b.teamId];
    const div = document.createElement('button');
    div.className = `bd-item bd-${kind}`;
    const when = new Date(match.ts);
    const score = match.status === 'pre'
      ? 'v'
      : `${match.a.score ?? 0}–${match.b.score ?? 0}${match.a.pens != null ? ` (${match.a.pens}–${match.b.pens}p)` : ''}`;
    const flag = (t) => (t?.logo ? `<img class="bd-flag" src="${t.logo}" alt="" loading="lazy">` : '');
    const count = match.status === 'pre'
      ? `<span class="bd-count" data-ts="${match.ts}">${countdown(match.ts)}</span>` : '';
    div.innerHTML = `
      <span class="bd-round">${ROUND_LABEL[match.round].toUpperCase()}${kind === 'live' ? ` · ${match.clock || 'LIVE'}` : ''}</span>
      ${count}
      <span class="bd-teams">${flag(a)}<span>${a?.abbr ?? '?'}</span><b class="bd-score">${score}</b><span>${b?.abbr ?? '?'}</span>${flag(b)}</span>
      <span class="bd-when">${match.status === 'pre' ? when.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : when.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${match.city.split(',')[0]}</span>`;
    div.addEventListener('click', () => openMatchCard(match.id));
    board.appendChild(div);
  };

  for (const x of live) item(x, 'live');
  for (const x of next) item(x, 'next');
  if (recent.length) {
    const h = document.createElement('div');
    h.className = 'bd-head';
    h.textContent = 'RECENT ARRIVALS';
    board.appendChild(h);
    for (const x of recent) item(x, 'recent');
  }
  if (!live.length && !next.length && !recent.length) board.innerHTML = '<div class="bd-empty">No services found.</div>';
}

function countdown(ts) {
  const d = ts - Date.now();
  if (d <= 0) return 'kickoff';
  const mins = Math.floor(d / 60_000);
  const days = Math.floor(mins / 1440);
  const hrs = Math.floor((mins % 1440) / 60);
  const min = mins % 60;
  if (days > 0) return `in ${days}d ${hrs}h`;
  if (hrs > 0) return `in ${hrs}h ${String(min).padStart(2, '0')}m`;
  return `in ${min}m`;
}

// keep board countdowns ticking between data refreshes
setInterval(() => {
  for (const el of $$('.bd-count')) el.textContent = countdown(+el.dataset.ts);
}, 30_000);

/* ------------------------------------------------------- interactions */

function bindMapInteractions() {
  const svg = state.svg;

  svg.addEventListener('mouseover', (e) => {
    const tEl = e.target.closest('[data-team]');
    const mEl = e.target.closest('[data-match]');
    if (mEl) {
      const match = state.model.byId[mEl.dataset.match];
      const ids = new Set([match.a.teamId, match.b.teamId].filter(Boolean));
      if (match.status === 'pre') {
        const node = state.model.bracket.nodes[match.id];
        if (node) for (const id of node.candidates || []) ids.add(id);
      }
      focusTeams(ids);
      showTooltip(match, e);
      return;
    }
    hideTooltip();
    if (tEl) return focusTeams(new Set([tEl.dataset.team]));
    clearFocus();
  });
  svg.addEventListener('mousemove', (e) => {
    if (e.target.closest('[data-match]')) moveTooltip(e);
  });
  svg.addEventListener('mouseleave', () => { clearFocus(); hideTooltip(); });

  bindPanZoom();
}

function focusTeams(set) {
  state.focusTeams = set;
  applyFocus();
}
function clearFocus() {
  state.focusTeams = new Set();
  applyFocus();
}
function applyFocus() {
  const svg = state.svg;
  const active = state.focusTeams.size > 0 || state.selected;
  svg.classList.toggle('has-focus', active);
  const keep = new Set(state.focusTeams);
  if (state.selected) keep.add(state.selected);
  for (const g of $$('.team-line, .ko-seg', svg)) {
    g.classList.toggle('focus', keep.size > 0 && g.dataset.team && keep.has(g.dataset.team));
  }
  for (const s of $$('.station', svg)) {
    const match = state.model.byId[s.dataset.match];
    const hit = keep.size === 0 || [match.a.teamId, match.b.teamId].some((id) => keep.has(id));
    s.classList.toggle('focus', hit);
    s.classList.toggle('dim', keep.size > 0 && !hit);
  }
}

/* ---------------------------------------------------------- tooltip */

const tip = $('#tooltip');

function showTooltip(match, e) {
  const md = state.model;
  const a = md.teams[match.a.teamId], b = md.teams[match.b.teamId];
  const when = new Date(match.ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const row = (t, side, won) => `
    <div class="tt-team${won ? ' tt-won' : ''}">
      ${t?.logo ? `<img src="${t.logo}" alt="">` : ''}
      <span>${t?.name ?? 'TBD'}</span>
      <b>${match.status === 'pre' ? '' : side.score ?? ''}${side.pens != null ? ` (${side.pens})` : ''}</b>
    </div>`;
  const status = match.status === 'in'
    ? `<span class="tt-live">● LIVE ${match.clock || ''}</span>`
    : match.status === 'post' ? (match.detail || 'FT') : when;
  let note = '';
  if (match.status === 'pre') {
    const node = md.bracket.nodes[match.id];
    const n = node?.candidates?.length || 0;
    if (n > 2) note = `<div class="tt-note">${n} services can still reach this station</div>`;
  }
  tip.innerHTML = `
    <div class="tt-round">${ROUND_LABEL[match.round].toUpperCase()} · ${status}</div>
    ${row(a, match.a, match.a.winner)}
    ${row(b, match.b, match.b.winner)}
    <div class="tt-meta">${[match.venue, match.city.split(',')[0]].filter(Boolean).join(' · ')}</div>
    ${note}`;
  tip.classList.add('show');
  moveTooltip(e);
}

function moveTooltip(e) {
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideTooltip() { tip.classList.remove('show'); }

/* ---------------------------------------------------- team selection */

function selectTeam(teamId, { fly } = {}) {
  state.selected = teamId;
  applyFocus();
  const t = state.model.teams[teamId];
  if (!t) return;
  closeMobileSheet();
  if (fly) flyToTeam(teamId);
  openDrawer(t);
  for (const r of $$('.dir-team')) r.classList.toggle('active', r.dataset.team === teamId);
}

function myScore(match, teamId) {
  const mine = match.a.teamId === teamId ? match.a : match.b;
  const opp = match.a.teamId === teamId ? match.b : match.a;
  const s = `${mine.score ?? '–'}–${opp.score ?? '–'}`;
  if (mine.pens != null && opp.pens != null) return `${s} (${mine.pens}–${opp.pens}p)`;
  return s;
}

function openDrawer(t) {
  const d = $('#drawer');
  const m = state.model;
  const inBronze = !t.champion && t.journey.some((j) => j.round === 'm3p' && j.result === 'sched');
  const status = t.champion ? '<span class="chip chip-champ">Champion</span>'
    : inBronze ? '<span class="chip chip-bronze">Bronze service</span>'
    : t.eliminatedRound ? `<span class="chip chip-out">End of the line · ${ROUND_LABEL[t.eliminatedRound]}</span>`
    : '<span class="chip chip-alive">In service</span>';

  const record = t.pts != null
    ? `${t.w}W ${t.d}D ${t.l}L · ${t.pts} pts · ${t.gd > 0 ? '+' : ''}${t.gd} GD · ${t.rank}${ord(t.rank)} in Group ${t.group}`
    : '';

  const rows = t.journey.map((j) => {
    const opp = m.teams[j.opponentId];
    const res = j.result;
    const chip = res === 'w' ? '<b class="rchip rw">W</b>' : res === 'd' ? '<b class="rchip rd">D</b>'
      : res === 'l' ? '<b class="rchip rl">L</b>' : res === 'live' ? '<b class="rchip rlive">LIVE</b>'
      : '<b class="rchip rs">·</b>';
    const when = new Date(j.match.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `
      <button class="jr-row jr-${res}" data-match="${j.match.id}">
        ${chip}
        <div class="jr-main">
          <div class="jr-top">
            ${opp?.logo ? `<img src="${opp.logo}" alt="">` : ''}
            <span class="jr-opp">${opp?.name ?? 'TBD'}</span>
            <span class="jr-score">${res === 'sched' ? '' : myScore(j.match, t.id)}</span>
          </div>
          <div class="jr-sub">${ROUND_LABEL[j.round]} · ${when} · ${j.match.city.split(',')[0]}</div>
        </div>
      </button>`;
  }).join('');

  const lineColor = visibleColor(t.color);
  const fg = textOn(lineColor);
  const canPlay = state.routes?.[t.id]?.stops.length > 0;

  d.innerHTML = `
    <div class="mini">
      <button class="mini-main" id="mini-expand" aria-label="Expand journey">
        <span class="mini-cband" style="background:${lineColor}"></span>
        ${t.logo ? `<img src="${t.logo}" alt="">` : ''}
        <span class="mini-team">${t.abbr ?? t.name}</span>
        <span class="mini-stop" id="mini-stop">${t.name} line</span>
      </button>
      <button class="mini-btn" id="mini-play" aria-label="Play or pause">▶</button>
      <button class="mini-btn" id="mini-close" aria-label="Close">×</button>
    </div>
    <div class="dr-band" style="background:${lineColor};color:${fg}">
      <span class="dr-grab" aria-hidden="true"></span>
      ${t.logo ? `<img src="${t.logo}" alt="">` : ''}
      <span class="dr-line-name">${t.name}</span>
      <button class="close" id="drawer-close" aria-label="Close">×</button>
    </div>
    <div class="dr-body">
      <div class="dr-top">
        ${record ? `<span class="dr-sub">${record}</span>` : ''}
        ${status}
      </div>
      ${canPlay ? '<button id="journey-play" class="play-btn">▶ Play journey</button>' : ''}
      <div class="dr-route">${rows || '<div class="jr-empty">No services yet.</div>'}</div>
    </div>`;

  if (isMobile()) {
    const keepMini = d.classList.contains('open') && d.dataset.state === 'mini'
      && play.playing && play.teamId === t.id;
    d.dataset.state = keepMini ? 'mini' : (d.classList.contains('open') && d.dataset.state === 'full' ? 'full' : 'half');
  } else {
    delete d.dataset.state;
  }
  d.classList.add('open');

  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#mini-close').addEventListener('click', closeDrawer);
  $('#mini-expand').addEventListener('click', () => setDrawerState('half'));
  $('#mini-play').addEventListener('click', () => togglePlay(t.id));
  const playBtn = $('#journey-play');
  if (playBtn) playBtn.addEventListener('click', () => togglePlay(t.id));
  for (const row of $$('.jr-row', d)) {
    row.addEventListener('click', () => {
      seekToMatch(t.id, row.dataset.match);
      openMatchCard(row.dataset.match);
    });
  }
  bindDrawerDrag(d);
  updatePlayBtn();
}

function setDrawerState(s) {
  $('#drawer').dataset.state = s;
}

/* drag the journey sheet by its band: snaps to full / half / mini / closed */
function bindDrawerDrag(d) {
  const band = $('.dr-band', d);
  if (!band) return;
  let dragging = false, startY = 0, startT = 0, h = 0;

  band.addEventListener('pointerdown', (e) => {
    if (!isMobile() || e.target.closest('button')) return;
    dragging = true;
    band.setPointerCapture(e.pointerId);
    h = d.getBoundingClientRect().height;
    startY = e.clientY;
    startT = new DOMMatrixReadOnly(getComputedStyle(d).transform).m42;
    d.style.transition = 'none';
  });
  band.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const ty = Math.min(h, Math.max(0, startT + (e.clientY - startY)));
    d.style.transform = `translateY(${ty}px)`;
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    const ty = new DOMMatrixReadOnly(getComputedStyle(d).transform).m42;
    const miniH = $('.mini', d)?.offsetHeight || 60;
    const stops = [
      ['full', 0],
      ['half', Math.max(0, h - window.innerHeight * 0.46)],
      ['close', h],
    ];
    if (play.teamId) stops.splice(2, 0, ['mini', h - miniH]);
    const pick = stops.reduce((a, b) => (Math.abs(b[1] - ty) < Math.abs(a[1] - ty) ? b : a));
    d.style.transition = '';
    if (pick[0] === 'close') {
      d.style.transform = '';
      return closeDrawer();
    }
    setDrawerState(pick[0]);
    requestAnimationFrame(() => { d.style.transform = ''; });
  };
  band.addEventListener('pointerup', end);
  band.addEventListener('pointercancel', end);
}

function closeDrawer() {
  state.selected = null;
  destroyPlayLayer();
  $('#drawer').classList.remove('open');
  for (const r of $$('.dir-team')) r.classList.remove('active');
  applyFocus();
}

const ord = (n) => (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');

/* --------------------------------------------------- journey playback */

const play = {
  teamId: null,
  pathEl: null,
  markerEl: null,
  total: 0,
  stops: [],       // [{matchId, len}] ascending
  pos: 0,
  target: 0,
  raf: 0,
  lastTs: 0,
  waitUntil: 0,
  playing: false,
  seek: false,
  follow: true,
  pt: null,
};

const PLAY_SPEED = 430;      // map units / s while riding
const SEEK_SPEED = 1250;     // map units / s when jumping to a match
const STOP_PAUSE = 950;      // ms dwell at each station (time to read the result badge)

function ensurePlayLayer(teamId) {
  if (play.teamId === teamId && play.pathEl && play.pathEl.isConnected) return true;
  destroyPlayLayer();
  const route = state.routes?.[teamId];
  if (!route || route.pts.length < 2) return false;

  const lens = [0];
  for (let i = 1; i < route.pts.length; i++) {
    const a = route.pts[i - 1], b = route.pts[i];
    lens.push(lens[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = lens[lens.length - 1];
  const t = state.model.teams[teamId];
  const color = visibleColor(t.color);
  const d = route.pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

  const path = svgEl('path', { d, class: 'play-line', stroke: color });
  path.style.strokeDasharray = `${total} ${total}`;
  path.style.strokeDashoffset = total;
  state.svg.insertBefore(path, $('.stations', state.svg));

  const marker = svgEl('circle', { class: 'play-marker', r: 7, fill: color, cx: route.pts[0][0], cy: route.pts[0][1] });
  state.svg.appendChild(marker);

  Object.assign(play, {
    teamId, pathEl: path, markerEl: marker, total,
    stops: route.stops.map((s) => ({ matchId: s.matchId, len: lens[s.i] })),
    pos: 0, target: 0, lastTs: 0, waitUntil: 0,
    playing: false, seek: false, follow: true, pt: null,
  });
  state.svg.classList.add('playback');
  renderPlayProgress();
  return true;
}

function destroyPlayLayer() {
  if (play.raf) clearTimeout(play.raf);
  play.raf = 0;
  play.playing = false;
  play.pathEl?.remove();
  play.markerEl?.remove();
  play.pathEl = play.markerEl = null;
  if (state.svg) for (const c of $$('.play-callout', state.svg)) c.remove();
  play.teamId = null;
  state.svg?.classList.remove('playback');
  for (const r of $$('.jr-row.current')) r.classList.remove('current');
}

function togglePlay(teamId) {
  if (!ensurePlayLayer(teamId)) return;
  if (play.playing) {
    play.playing = false;
  } else {
    if (play.pos >= play.total - 1) play.pos = 0;
    play.target = play.total;
    play.seek = false;
    // riding on mobile: collapse the journey sheet to the mini player so the map shows
    if (isMobile()) setDrawerState('mini');
    if (REDUCED) {
      play.pos = play.total;
      renderPlayProgress();
      const last = play.stops[play.stops.length - 1];
      if (last) markCurrentRow(last.matchId);
    } else {
      startTicking();
    }
  }
  updatePlayBtn();
}

function seekToMatch(teamId, matchId) {
  if (!ensurePlayLayer(teamId)) return;
  const s = play.stops.find((x) => x.matchId === matchId);
  if (!s) return;
  markCurrentRow(matchId);
  if (REDUCED) {
    play.pos = s.len;
    renderPlayProgress();
    popStop(s);
    spawnCallout(s);
    return;
  }
  play.target = s.len;
  play.seek = true;
  startTicking();
  updatePlayBtn();
}

/* setTimeout-driven ticker (not rAF): keeps riding even when the
   window is occluded, and rAF starvation can't freeze the train */
function startTicking() {
  if (animId) { cancelAnimationFrame(animId); animId = null; } // camera flight yields to follow-cam
  play.playing = true;
  play.follow = true;
  play.lastTs = 0;
  play.waitUntil = 0;
  if (!play.raf) play.raf = setTimeout(playTick, 16);
}

function playTick() {
  play.raf = 0;
  if (!play.playing || !play.pathEl) return;
  const ts = performance.now();
  if (!play.lastTs) play.lastTs = ts;
  const dt = Math.min(100, ts - play.lastTs);
  play.lastTs = ts;
  followCam();

  if (ts < play.waitUntil) {
    play.raf = setTimeout(playTick, 16);
    return;
  }

  const dir = play.target >= play.pos ? 1 : -1;
  const speed = play.seek ? SEEK_SPEED : PLAY_SPEED;
  let next = play.pos + dir * speed * (dt / 1000);

  let arrived = null;
  if (dir > 0) {
    const s = play.stops.find((st) => st.len > play.pos + 0.5 && st.len <= next + 0.001 && st.len <= play.target + 0.001);
    if (s) {
      next = s.len;
      popStop(s);
      markCurrentRow(s.matchId);
      // announce the result at every riding stop; while seeking, only at the destination
      if (!play.seek) {
        arrived = s;
        play.waitUntil = performance.now() + STOP_PAUSE;
      } else if (Math.abs(s.len - play.target) < 0.01) {
        arrived = s;
      }
    }
  }

  if ((dir > 0 && next >= play.target) || (dir < 0 && next <= play.target)) {
    next = play.target;
    play.playing = false;
    play.seek = false;
  }

  play.pos = next;
  renderPlayProgress();
  if (arrived) spawnCallout(arrived);
  if (!play.playing) {
    updatePlayBtn();
    if (play.pos >= play.total - 0.5 && state.model.teams[play.teamId]?.champion) {
      spawnCallout(null, 'CHAMPION');
    }
    // glide the camera the rest of the way to the terminal stop
    if (play.follow && play.pt) {
      const s = camShift();
      animateVb({
        x: play.pt.x - state.vb.w / 2 + s.dx,
        y: play.pt.y - state.vb.h / 2 + s.dy,
        w: state.vb.w,
        h: state.vb.h,
      });
    }
  }
  if (play.playing) play.raf = setTimeout(playTick, 16);
}

/* result badge that pops above the station the train just reached */
function spawnCallout(s, special) {
  if (!play.pt || !state.svg) return;
  let label, cls, persist;
  if (special) {
    label = special;
    cls = 'champ';
    persist = true;
  } else {
    const m = state.model.byId[s.matchId];
    const t = state.model.teams[play.teamId];
    const j = t?.journey.find((x) => x.match.id === s.matchId);
    if (!m || !j) return;
    const opp = state.model.teams[j.opponentId]?.abbr ?? 'TBD';
    const res = j.result;
    if (res === 'sched') {
      label = `${new Date(m.ts).toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase()} · v ${opp}`;
      cls = 's';
    } else if (res === 'live') {
      label = `LIVE ${myScore(m, t.id)} ${opp}`;
      cls = 'live';
    } else {
      label = `${res.toUpperCase()} ${myScore(m, t.id)} ${opp}`;
      cls = res;
    }
    persist = s.len >= play.stops[play.stops.length - 1].len - 0.5;
  }
  if (special) {
    const ms = $('#mini-stop');
    if (ms) { ms.textContent = special; ms.dataset.res = 'champ'; }
  }
  const mob = isMobile();
  const ty = play.pt.y - (mob ? 24 : 21);
  const pt = { x: play.pt.x, y: play.pt.y };
  const g = svgEl('g', { class: `play-callout pc-${cls}` });
  const text = svgEl('text', { x: pt.x, y: ty, 'text-anchor': 'middle' });
  text.textContent = label;
  g.appendChild(text);
  state.svg.appendChild(g);
  const wpx = text.getComputedTextLength();
  g.insertBefore(svgEl('rect', {
    x: pt.x - wpx / 2 - 7, y: ty - (mob ? 15 : 12), width: wpx + 14, height: mob ? 21 : 17,
  }), text);
  if (!persist) {
    setTimeout(() => {
      g.classList.add('out');
      setTimeout(() => g.remove(), 500);
    }, 2400);
  }
}

function renderPlayProgress() {
  if (!play.pathEl) return;
  play.pathEl.style.strokeDashoffset = Math.max(0, play.total - play.pos);
  const pt = play.pathEl.getPointAtLength(Math.min(play.pos, play.total));
  play.pt = pt;
  play.markerEl.setAttribute('cx', pt.x);
  play.markerEl.setAttribute('cy', pt.y);
}

function popStop(s) {
  const stEl = state.stationEls?.[s.matchId]
    || state.svg.querySelector(`.tick[data-match="${s.matchId}"]`);
  if (!stEl) return;
  stEl.classList.remove('arrived');
  requestAnimationFrame(() => stEl.classList.add('arrived'));
  setTimeout(() => stEl.classList.remove('arrived'), 800);
}

function markCurrentRow(matchId) {
  for (const r of $$('.jr-row')) r.classList.toggle('current', r.dataset.match === matchId);
  const cur = $(`.jr-row[data-match="${matchId}"]`);
  cur?.scrollIntoView({ block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' });
  updateMiniStop(matchId);
}

/* current stop + result in the mini player bar */
function updateMiniStop(matchId) {
  const ms = $('#mini-stop');
  if (!ms || !play.teamId) return;
  const t = state.model.teams[play.teamId];
  const j = t?.journey.find((x) => x.match.id === matchId);
  if (!j) return;
  const opp = state.model.teams[j.opponentId]?.abbr ?? 'TBD';
  const res = j.result;
  const label = res === 'sched' ? `v ${opp}`
    : res === 'live' ? `LIVE ${myScore(j.match, t.id)} ${opp}`
    : `${res.toUpperCase()} ${myScore(j.match, t.id)} ${opp}`;
  ms.textContent = `${ROUND_LABEL[j.round].toUpperCase()} · ${label}`;
  ms.dataset.res = res;
}

function updatePlayBtn() {
  const idle = !play.teamId || play.total <= 0;
  const btn = $('#journey-play');
  if (btn) {
    btn.textContent = idle ? '▶ Play journey'
      : play.playing && !play.seek ? '❚❚ Pause'
      : play.pos >= play.total - 1 ? '↺ Replay journey'
      : play.pos > 0 ? '▶ Resume'
      : '▶ Play journey';
  }
  const mini = $('#mini-play');
  if (mini) {
    mini.textContent = idle ? '▶'
      : play.playing && !play.seek ? '❚❚'
      : play.pos >= play.total - 1 ? '↺' : '▶';
  }
}

/* shift (map units) so the follow target centers in the part of the
   viewport not covered by chrome: the side drawer on desktop, the
   open bottom sheet (mini player or half sheet) on mobile */
function camShift() {
  const r = $('#mapwrap').getBoundingClientRect();
  const d = $('#drawer');
  if (!d.classList.contains('open')) return { dx: 0, dy: 0 };
  if (r.width > 900) return { dx: (380 / 2) * (state.vb.w / r.width), dy: 0 };
  const top = d.getBoundingClientRect().top;
  const vis = Math.max(0, Math.min(r.height, r.height - top));
  return { dx: 0, dy: (vis / 2) * (state.vb.h / r.height) };
}

function followCam() {
  if (!play.follow || !play.pt) return;
  // keep the marker centered-ish; respect the user's zoom level (cap width)
  const followW = isMobile() ? 500 : 760;
  if (state.vb.w > followW) {
    state.vb.w = Math.max(followW, state.vb.w * 0.94);
    state.vb.h = state.vb.w / aspect();
  }
  const s = camShift();
  const cx = state.vb.x + state.vb.w / 2 - s.dx;
  const cy = state.vb.y + state.vb.h / 2 - s.dy;
  state.vb.x += (play.pt.x - cx) * 0.10;
  state.vb.y += (play.pt.y - cy) * 0.10;
  applyVb();
}

// user interaction breaks camera follow
for (const evt of ['pointerdown', 'wheel']) {
  $('#mapwrap').addEventListener(evt, () => { play.follow = false; }, { passive: true });
}

document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && play.teamId && !e.target.closest('input')) {
    e.preventDefault();
    togglePlay(play.teamId);
  }
});

/* ------------------------------------------------------- match card */

function openMatchCard(matchId) {
  const m = state.model.byId[matchId];
  if (!m) return;
  const a = state.model.teams[m.a.teamId], b = state.model.teams[m.b.teamId];
  const card = $('#matchcard');
  const when = new Date(m.ts).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const team = (t, side) => `
    <div class="mc-team">
      ${t?.logo ? `<img src="${t.logo}" alt="">` : ''}
      <span>${t?.name ?? 'TBD'}</span>
      <b class="mc-score">${side.score ?? '&ndash;'}${side.pens != null ? `<i>(${side.pens})</i>` : ''}</b>
    </div>`;
  card.innerHTML = `
    <div class="band">
      <span class="band-title">${ROUND_LABEL[m.round]} · ${m.status === 'in' ? `<span class="live-dot"></span>LIVE ${m.clock}` : (m.detail || '')}</span>
      <button class="close" id="mc-close" aria-label="Close">×</button>
    </div>
    <div class="mc-body">
      <div class="mc-teams">${team(a, m.a)}<div class="mc-div"></div>${team(b, m.b)}</div>
      <div class="mc-meta">${when}<br>${[m.venue, m.city].filter(Boolean).join(' · ')}</div>
    </div>`;
  card.classList.add('open');
  $('#mc-close').addEventListener('click', closeMatchCard);
}

function closeMatchCard() { $('#matchcard').classList.remove('open'); }

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDrawer(); closeMatchCard(); $('#legend').classList.remove('open'); }
});

/* -------------------------------------------------------- pan & zoom */

function bindPanZoom() {
  const wrap = $('#mapwrap');
  const pointers = new Map();
  let pinchD0 = 0, pinchW0 = 0;
  let moved = false;
  let downAt = null;
  let lastTap = null;
  let tapTimer = 0;

  const toSvg = (e) => {
    const r = wrap.getBoundingClientRect();
    return {
      x: state.vb.x + ((e.clientX - r.left) / r.width) * state.vb.w,
      y: state.vb.y + ((e.clientY - r.top) / r.height) * state.vb.h,
    };
  };

  wrap.onwheel = (e) => {
    e.preventDefault();
    const p = toSvg(e);
    const scale = Math.exp(e.deltaY * 0.0013);
    zoomAt(p.x, p.y, state.vb.w * scale);
  };

  /* pan can start anywhere (even on a station's hit target); a press that
     never moves past the threshold is treated as a tap on release */
  wrap.onpointerdown = (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      moved = false;
      downAt = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      moved = true; // a pinch is never a tap
      wrap.setPointerCapture(e.pointerId);
      const [p1, p2] = [...pointers.values()];
      pinchD0 = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      pinchW0 = state.vb.w;
    }
  };
  wrap.onpointermove = (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      if (!moved) {
        if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6) return;
        moved = true;
        wrap.setPointerCapture(e.pointerId);
      }
      const r = wrap.getBoundingClientRect();
      state.vb.x -= ((e.clientX - prev.x) / r.width) * state.vb.w;
      state.vb.y -= ((e.clientY - prev.y) / r.height) * state.vb.h;
      clampVb();
      applyVb();
    } else if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const dNow = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (dNow > 0 && pinchD0 > 0) {
        const c = toSvg({ clientX: (p1.x + p2.x) / 2, clientY: (p1.y + p2.y) / 2 });
        zoomAt(c.x, c.y, pinchW0 * (pinchD0 / dNow));
      }
    }
  };
  const up = (e) => {
    const wasTap = pointers.size === 1 && !moved && downAt;
    pointers.delete(e.pointerId);
    if (wasTap) handleTap(e);
    if (!pointers.size) downAt = null;
  };
  wrap.onpointerup = up;
  wrap.onpointercancel = (e) => { pointers.delete(e.pointerId); downAt = null; };

  function handleTap(e) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const mEl = target?.closest?.('[data-match]');
    if (mEl) {
      const match = state.model.byId[mEl.dataset.match];
      if (match) focusTeams(new Set([match.a.teamId, match.b.teamId].filter(Boolean)));
      closeMobileSheet();
      return openMatchCard(mEl.dataset.match);
    }
    const tEl = target?.closest?.('[data-team]');
    if (tEl) {
      closeMobileSheet();
      return selectTeam(tEl.dataset.team, { fly: false });
    }
    // background tap: double-tap zooms, single tap clears chrome
    if (isMobile()) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < 320
          && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 48) {
        clearTimeout(tapTimer);
        lastTap = null;
        const p = toSvg(e);
        return zoomAt(p.x, p.y, state.vb.w * 0.55);
      }
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      tapTimer = setTimeout(() => {
        lastTap = null;
        closeMatchCard();
        closeMobileSheet();
        // keep the mini player alive mid-ride; anything larger dismisses
        if ($('#drawer').dataset.state !== 'mini') closeDrawer();
      }, 330);
    } else {
      closeDrawer();
      closeMatchCard();
    }
  }
}

function zoomAt(x, y, newW) {
  const g = state.geo;
  const minW = 260, maxW = Math.max(g.W, g.H * aspect()) * 1.05;
  newW = Math.min(maxW, Math.max(minW, newW));
  const k = newW / state.vb.w;
  state.vb.x = x - (x - state.vb.x) * k;
  state.vb.y = y - (y - state.vb.y) * k;
  state.vb.w = newW;
  state.vb.h = newW / aspect();
  clampVb();
  applyVb();
}

function clampVb() {
  const g = state.geo;
  state.vb.x = Math.min(g.W - state.vb.w * 0.4, Math.max(-state.vb.w * 0.25, state.vb.x));
  state.vb.y = Math.min(g.H - state.vb.h * 0.4, Math.max(-state.vb.h * 0.25, state.vb.y));
}

function applyVb() {
  const { x, y, w, h } = state.vb;
  state.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  updateRoundStrip();
}

const aspect = () => {
  const r = $('#mapwrap').getBoundingClientRect();
  return r.width / Math.max(1, r.height);
};

function fitMap(animate = true) {
  const g = state.geo;
  const r = $('#mapwrap').getBoundingClientRect();
  const desktop = r.width > 900;
  // pixel padding so the plaque / sheets never cover the map
  const padL = desktop ? 330 : 10;
  const padT = desktop ? 10 : 96;
  const padR = desktop ? 14 : 10;
  const padB = desktop ? 14 : 72;
  // solve view width so content + css-px padding fits: w = W + (padL+padR)*(w/cssW)
  const wW = g.W / Math.max(0.2, 1 - (padL + padR) / r.width);
  const wH = (g.H / Math.max(0.2, 1 - (padT + padB) / r.height)) * aspect();
  const w = Math.max(wW, wH);
  const h = w / aspect();
  const k = w / r.width; // map units per css px
  const target = {
    x: g.W / 2 - w / 2 - ((padL - padR) / 2) * k,
    y: g.H / 2 - h / 2 - ((padT - padB) / 2) * k,
    w, h,
  };
  animate ? animateVb(target) : Object.assign(state.vb, target);
  applyVb();
}

function flyToTeam(teamId) {
  const a = state.teamAnchors[teamId];
  if (!a) return;
  if (isMobile()) {
    // half sheet covers the lower ~46dvh: aim the anchor at the visible upper area
    const w = 460, h = w / aspect();
    return animateVb({ x: a.x - w * 0.2, y: a.y - h * 0.25, w, h });
  }
  const w = 620;
  animateVb({ x: a.x - 180, y: a.y - (w / aspect()) / 2, w, h: w / aspect() });
}

let animId = null;
function animateVb(target) {
  if (animId) cancelAnimationFrame(animId);
  const from = { ...state.vb };
  const t0 = performance.now();
  const dur = REDUCED ? 0 : 480;
  const step = (t) => {
    const k = dur === 0 ? 1 : Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    state.vb.x = from.x + (target.x - from.x) * e;
    state.vb.y = from.y + (target.y - from.y) * e;
    state.vb.w = from.w + (target.w - from.w) * e;
    state.vb.h = from.h + (target.h - from.h) * e;
    applyVb();
    if (k < 1) animId = requestAnimationFrame(step);
  };
  animId = requestAnimationFrame(step);
}

$('#zoom-in').addEventListener('click', () => zoomAt(state.vb.x + state.vb.w / 2, state.vb.y + state.vb.h / 2, state.vb.w * 0.7));
$('#zoom-out').addEventListener('click', () => zoomAt(state.vb.x + state.vb.w / 2, state.vb.y + state.vb.h / 2, state.vb.w * 1.4));
$('#zoom-fit').addEventListener('click', () => fitMap(true));
$('#fit-map').addEventListener('click', () => fitMap(true));
window.addEventListener('resize', () => { if (state.geo) { state.vb.h = state.vb.w / aspect(); applyVb(); } });

/* ------------------------------------------------------------ panels */

/* mobile bottom sheet: Lines / Services segmented control */
function openMobileSheet(pane) {
  const sheet = $('#sheet');
  sheet.classList.add('open');
  sheet.dataset.pane = pane;
  $('#tab-lines').classList.toggle('active', pane === 'lines');
  $('#tab-services').classList.toggle('active', pane === 'services');
  closeMatchCard();
  const d = $('#drawer');
  if (d.classList.contains('open') && d.dataset.state !== 'mini') closeDrawer();
}
function closeMobileSheet() {
  $('#sheet').classList.remove('open');
  $('#tab-lines').classList.remove('active');
  $('#tab-services').classList.remove('active');
}
function bindTab(id, pane) {
  $(id).addEventListener('click', () => {
    const s = $('#sheet');
    if (s.classList.contains('open') && s.dataset.pane === pane) closeMobileSheet();
    else openMobileSheet(pane);
  });
}
bindTab('#tab-lines', 'lines');
bindTab('#tab-services', 'services');

$('#m-fit').addEventListener('click', () => fitMap(true));
$('#m-legend').addEventListener('click', () => $('#legend').classList.toggle('open'));
$('#legend-toggle').addEventListener('click', () => $('#legend').classList.toggle('open'));
$('#legend-close').addEventListener('click', () => $('#legend').classList.remove('open'));
$('#legend').addEventListener('click', (e) => { if (e.target.id === 'legend') $('#legend').classList.remove('open'); });

/* ------------------------------------------------------------ poll */

function schedulePoll() {
  clearTimeout(state.pollTimer);
  const anyLive = state.model.matches.some((m) => m.status === 'in');
  state.pollTimer = setTimeout(refresh, anyLive ? 60_000 : 300_000);
}

async function refresh() {
  if (play.playing) { schedulePoll(); return; } // don't tear down the map mid-ride
  try {
    const { model, source } = await loadModel();
    state.model = model;
    state.source = source;
    mount();
  } catch { /* keep old render */ }
  schedulePoll();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && state.model) refresh(); });
