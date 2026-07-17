/*
 * WC26 Transit — app bootstrap & interactions
 */

import { loadModel, ROUND_LABEL } from './data.js';
import { render, scoreText, stationTitle, visibleColor, L } from './metro.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  model: null,
  source: 'live',
  geo: null,
  svg: null,
  selected: null,      // teamId
  focusTeams: new Set(),
  vb: { x: 0, y: 0, w: 1000, h: 700 },
  pollTimer: null,
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
  const wrap = $('#mapwrap');
  wrap.innerHTML = '';
  const { svg, geo, teamAnchors } = render(state.model);
  state.svg = svg;
  state.geo = geo;
  state.teamAnchors = teamAnchors;
  wrap.appendChild(svg);

  fitMap(false);
  buildDirectory();
  buildBoard();
  bindMapInteractions();
  updatePlaque();
  if (state.selected) selectTeam(state.selected, { fly: false });
}

function updatePlaque() {
  const m = state.model;
  const when = new Date(m.fetchedAt);
  $('#datasource').textContent =
    `${state.source === 'live' ? '● LIVE DATA' : state.source === 'snapshot' ? '◐ SNAPSHOT' : '◌ CACHED'} · ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('#datasource').className = `ds ds-${state.source}`;
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
        : inBronze ? ['BRONZE SERVICE', 'st-bronze']
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
    div.innerHTML = `
      <span class="bd-round">${ROUND_LABEL[match.round].toUpperCase()}${kind === 'live' ? ` · ${match.clock || 'LIVE'}` : ''}</span>
      <span class="bd-teams">${a?.abbr ?? '?'} ${score} ${b?.abbr ?? '?'}</span>
      <span class="bd-when">${kind === 'pre' ? when.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : when.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${match.city.split(',')[0]}</span>`;
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

/* ------------------------------------------------------- interactions */

function bindMapInteractions() {
  const svg = state.svg;

  svg.addEventListener('mouseover', (e) => {
    const tEl = e.target.closest('[data-team]');
    const mEl = e.target.closest('[data-match]');
    if (tEl) return focusTeams(new Set([tEl.dataset.team]));
    if (mEl) {
      const match = state.model.byId[mEl.dataset.match];
      const ids = new Set([match.a.teamId, match.b.teamId].filter(Boolean));
      if (match.status === 'pre') {
        const node = state.model.bracket.nodes[match.id];
        if (node) for (const id of node.candidates || []) ids.add(id);
      }
      return focusTeams(ids);
    }
    clearFocus();
  });
  svg.addEventListener('mouseleave', clearFocus);

  svg.addEventListener('click', (e) => {
    const mEl = e.target.closest('.station[data-match]');
    if (mEl) return openMatchCard(mEl.dataset.match);
    const tEl = e.target.closest('[data-team]');
    if (tEl) return selectTeam(tEl.dataset.team, { fly: false });
    closeDrawer();
    closeMatchCard();
  });

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

/* ---------------------------------------------------- team selection */

function selectTeam(teamId, { fly } = {}) {
  state.selected = teamId;
  applyFocus();
  const t = state.model.teams[teamId];
  if (!t) return;
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
  const status = t.champion ? '<span class="chip chip-champ">CHAMPION</span>'
    : inBronze ? '<span class="chip chip-bronze">BRONZE SERVICE</span>'
    : t.eliminatedRound ? `<span class="chip chip-out">END OF THE LINE · ${ROUND_LABEL[t.eliminatedRound].toUpperCase()}</span>`
    : '<span class="chip chip-alive">IN SERVICE</span>';

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
      <div class="jr-row jr-${res}" data-match="${j.match.id}">
        ${chip}
        <div class="jr-main">
          <div class="jr-top">
            ${opp?.logo ? `<img src="${opp.logo}" alt="">` : ''}
            <span class="jr-opp">${opp?.name ?? 'TBD'}</span>
            <span class="jr-score">${res === 'sched' ? '' : myScore(j.match, t.id)}</span>
          </div>
          <div class="jr-sub">${ROUND_LABEL[j.round]} · ${when} · ${j.match.city.split(',')[0]}</div>
        </div>
      </div>`;
  }).join('');

  d.innerHTML = `
    <button class="close" id="drawer-close">×</button>
    <div class="dr-head">
      <span class="dr-swatch" style="background:${visibleColor(t.color)}"></span>
      ${t.logo ? `<img class="dr-flag" src="${t.logo}" alt="">` : ''}
      <div>
        <div class="dr-name">${t.name}</div>
        <div class="dr-sub">${record}</div>
      </div>
      ${status}
    </div>
    <div class="dr-route">${rows || '<div class="jr-empty">No services yet.</div>'}</div>`;
  d.classList.add('open');

  $('#drawer-close').addEventListener('click', closeDrawer);
  for (const row of $$('.jr-row', d)) {
    row.addEventListener('click', () => openMatchCard(row.dataset.match));
  }
}

function closeDrawer() {
  state.selected = null;
  $('#drawer').classList.remove('open');
  for (const r of $$('.dir-team')) r.classList.remove('active');
  applyFocus();
}

const ord = (n) => (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');

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
    <button class="close" id="mc-close">×</button>
    <div class="mc-round">${ROUND_LABEL[m.round].toUpperCase()} · ${m.status === 'in' ? `<span class="live-dot"></span>LIVE ${m.clock}` : m.detail.toUpperCase()}</div>
    <div class="mc-teams">${team(a, m.a)}<div class="mc-div"></div>${team(b, m.b)}</div>
    <div class="mc-meta">${when}<br>${[m.venue, m.city].filter(Boolean).join(' · ')}</div>`;
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
  const svg = state.svg;
  const pointers = new Map();
  let pinchD0 = 0, pinchW0 = 0;

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

  wrap.onpointerdown = (e) => {
    if (e.target.closest('.station, [data-team]')) return; // let clicks through
    wrap.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
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
  const up = (e) => pointers.delete(e.pointerId);
  wrap.onpointerup = up;
  wrap.onpointercancel = up;
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
  const padL = desktop ? 330 : 8;
  const padT = desktop ? 10 : 150;
  const padR = desktop ? 14 : 8;
  const padB = desktop ? 14 : 60;
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
  const w = 620;
  animateVb({ x: a.x - 180, y: a.y - (w / aspect()) / 2, w, h: w / aspect() });
}

let animId = null;
function animateVb(target) {
  if (animId) cancelAnimationFrame(animId);
  const from = { ...state.vb };
  const t0 = performance.now();
  const dur = 480;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
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
window.addEventListener('resize', () => { if (state.geo) { state.vb.h = state.vb.w / aspect(); applyVb(); } });

/* ------------------------------------------------------------ panels */

$('#dir-toggle').addEventListener('click', () => $('#directory').classList.toggle('open'));
$('#board-toggle').addEventListener('click', () => $('#board').classList.toggle('open'));
$('#legend-toggle').addEventListener('click', () => $('#legend').classList.toggle('open'));
$('#legend-close').addEventListener('click', () => $('#legend').classList.remove('open'));

/* ------------------------------------------------------------ poll */

function schedulePoll() {
  clearTimeout(state.pollTimer);
  const anyLive = state.model.matches.some((m) => m.status === 'in');
  state.pollTimer = setTimeout(refresh, anyLive ? 60_000 : 300_000);
}

async function refresh() {
  try {
    const { model, source } = await loadModel();
    state.model = model;
    state.source = source;
    mount();
  } catch { /* keep old render */ }
  schedulePoll();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && state.model) refresh(); });
