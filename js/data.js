/*
 * WC26 Transit — data layer
 * Fetches + normalizes ESPN's public World Cup API into a bracket model.
 * ES module, no dependencies. Normalization is pure (node-testable).
 */

export const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200';
export const STANDINGS_URL =
  'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026';

export const ROUND_ORDER = ['group', 'r32', 'r16', 'qf', 'sf', 'm3p', 'final'];

export const ROUND_LABEL = {
  group: 'Group Stage',
  r32: 'Round of 32',
  r16: 'Round of 16',
  qf: 'Quarterfinal',
  sf: 'Semifinal',
  m3p: '3rd-Place Match',
  final: 'Final',
};

/* ---------------------------------------------------------- parsing */

export function roundFromNote(note) {
  if (!note) return null;
  const g = note.match(/Group\s+([A-L])\b/);
  if (g) return { round: 'group', group: g[1] };
  if (/Round of 32/.test(note)) return { round: 'r32' };
  if (/Round of 16/.test(note)) return { round: 'r16' };
  if (/Quarterfinal/.test(note)) return { round: 'qf' };
  if (/Semifinal/.test(note)) return { round: 'sf' };
  if (/3rd-Place/.test(note)) return { round: 'm3p' };
  if (/\bFinal\b/.test(note)) return { round: 'final' };
  return null;
}

function stat(entry, name) {
  const s = (entry.stats || []).find((x) => x.name === name);
  if (!s) return null;
  const v = s.value != null ? s.value : parseFloat(s.displayValue);
  return Number.isFinite(v) ? v : null;
}

/* ------------------------------------------------------ normalization */

export function normalize(raw) {
  const events = raw?.scoreboard?.events || [];
  const teams = {};
  const matches = [];

  const ensureTeam = (t) => {
    if (!t || !t.id) return null;
    if (!teams[t.id]) {
      teams[t.id] = {
        id: String(t.id),
        abbr: t.abbreviation || (t.displayName || '?').slice(0, 3).toUpperCase(),
        name: t.displayName || t.name || t.abbreviation || 'Unknown',
        color: t.color ? `#${t.color}` : null,
        logo: t.logo || null,
        group: null,
        rank: null,
        pts: null, w: null, d: null, l: null,
        gf: null, ga: null, gd: null,
        advanced: false,
        matches: [],
      };
    }
    return teams[t.id];
  };

  for (const e of events) {
    const c = e.competitions && e.competitions[0];
    if (!c) continue;
    const rn = roundFromNote(c.altGameNote || (c.notes && c.notes[0] && c.notes[0].headline) || '');
    if (!rn) continue;

    const competitors = c.competitors || [];
    if (competitors.length < 2) continue;
    const home = competitors.find((x) => x.homeAway === 'home') || competitors[0];
    const away = competitors.find((x) => x.homeAway === 'away') || competitors[1];

    const state = c.status?.type?.state || 'pre';
    const side = (x) => {
      const team = ensureTeam(x.team);
      const completed = c.status?.type?.completed === true;
      return {
        teamId: team ? team.id : null,
        score: state === 'pre' || x.score == null || x.score === '' ? null : parseInt(x.score, 10),
        pens: x.shootoutScore != null ? parseInt(x.shootoutScore, 10) : null,
        winner: completed ? x.winner === true : null,
      };
    };

    const match = {
      id: String(e.id),
      round: rn.round,
      group: rn.group || null,
      ts: Date.parse(e.date) || 0,
      dateISO: e.date,
      status: state === 'post' ? 'post' : state === 'in' ? 'in' : 'pre',
      detail: c.status?.type?.shortDetail || c.status?.type?.detail || '',
      clock: state === 'in' ? c.status?.displayClock || '' : '',
      venue: c.venue?.fullName || '',
      city: c.venue?.address?.city || '',
      country: c.venue?.address?.country || '',
      a: side(home),
      b: side(away),
    };
    matches.push(match);
    if (match.a.teamId) teams[match.a.teamId].matches.push(match.id);
    if (match.b.teamId) teams[match.b.teamId].matches.push(match.id);
  }

  matches.sort((m1, m2) => m1.ts - m2.ts || m1.id.localeCompare(m2.id));
  const byId = {};
  for (const m of matches) byId[m.id] = m;

  // standings → group membership, rank, record
  const children = raw?.standings?.children || [];
  for (const ch of children) {
    const g = (ch.abbreviation || ch.name || '').match(/Group\s+([A-L])/);
    const letter = g ? g[1] : null;
    for (const entry of ch.standings?.entries || []) {
      const t = teams[String(entry.team?.id)];
      if (!t) continue;
      t.group = letter;
      t.rank = stat(entry, 'rank');
      t.pts = stat(entry, 'points');
      t.w = stat(entry, 'wins');
      t.d = stat(entry, 'ties');
      t.l = stat(entry, 'losses');
      t.gf = stat(entry, 'pointsFor');
      t.ga = stat(entry, 'pointsAgainst');
      t.gd = stat(entry, 'pointDifferential');
      t.advanced = /^advance to/i.test(entry.note?.description || ''); // provisional; corrected below
    }
  }

  const model = { fetchedAt: raw.fetchedAt || new Date().toISOString(), teams, matches, byId };
  deriveJourneys(model);
  // ground truth: once R32 pairings exist, advancement = having an R32 match
  if (matches.some((m) => m.round === 'r32')) {
    for (const t of Object.values(teams)) {
      t.advanced = t.journey.some((j) => j.round === 'r32');
    }
  }
  deriveStatus(model);
  model.bracket = buildBracket(model);
  return model;
}

/* ------------------------------------------------------- derivations */

function resultFor(match, teamId) {
  if (match.status === 'pre') return 'sched';
  if (match.status === 'in') return 'live';
  const mine = match.a.teamId === teamId ? match.a : match.b;
  if (mine.winner === true) return 'w';
  if (mine.winner === false) {
    const other = match.a.teamId === teamId ? match.b : match.a;
    if (other.winner === false) return 'd'; // both false → draw (group stage)
    return 'l';
  }
  return 'sched';
}

function opponentOf(match, teamId) {
  return match.a.teamId === teamId ? match.b : match.a;
}

function deriveJourneys(model) {
  for (const t of Object.values(model.teams)) {
    const ms = t.matches.map((id) => model.byId[id]).filter(Boolean);
    ms.sort((m1, m2) => m1.ts - m2.ts);
    t.journey = ms.map((m) => ({
      match: m,
      round: m.round,
      result: resultFor(m, t.id),
      opponentId: opponentOf(m, t.id)?.teamId || null,
    }));
    t.md = t.journey.filter((j) => j.round === 'group').slice(0, 3);
  }
}

function deriveStatus(model) {
  for (const t of Object.values(model.teams)) {
    t.eliminatedRound = null;
    t.champion = false;
    const played = t.journey.filter((j) => j.result !== 'sched');
    const lostKo = t.journey.find((j) => j.round !== 'group' && j.round !== 'm3p' && j.result === 'l');
    const finalJ = t.journey.find((j) => j.round === 'final');
    if (finalJ && finalJ.result === 'w') t.champion = true;
    else if (lostKo) t.eliminatedRound = lostKo.round;
    else if (!t.advanced && t.md.length > 0 && t.md.every((j) => j.result !== 'sched' && j.result !== 'live')) {
      t.eliminatedRound = 'group';
    }
    t.alive = !t.eliminatedRound && !t.champion && played.length > 0;
  }
}

/* ---------------------------------------------------------- bracket */

const PREV_ROUND = { r16: 'r32', qf: 'r16', sf: 'qf', final: 'sf' };

export function buildBracket(model) {
  const ko = model.matches.filter((m) => m.round !== 'group');
  const nodes = {};
  for (const m of ko) nodes[m.id] = { match: m, round: m.round, feeders: [], slot: null };

  // link feeders by winner identity
  for (const m of ko) {
    const prev = PREV_ROUND[m.round];
    if (!prev) continue;
    const participants = [m.a.teamId, m.b.teamId].filter(Boolean);
    for (const pm of ko) {
      if (pm.round !== prev || pm.status !== 'post') continue;
      const w = pm.a.winner ? pm.a.teamId : pm.b.winner ? pm.b.teamId : null;
      if (w && participants.includes(w)) nodes[m.id].feeders.push(nodes[pm.id]);
    }
    // north feeder first (by eventual slot; placeholder sort by date for now)
    nodes[m.id].feeders.sort((a, b) => a.match.ts - b.match.ts);
  }

  // slot assignment: in-order traversal from the final
  const finalM = ko.find((m) => m.round === 'final');
  let slotCounter = 0;
  const walk = (node) => {
    if (!node) return 0;
    if (node.round === 'r32') {
      node.slot = slotCounter++;
      return node.slot;
    }
    if (node.feeders.length === 0) {
      node.slot = slotCounter; // undetermined subtree — reserve proportionally later
      return node.slot;
    }
    const slots = node.feeders.map(walk);
    node.slot = slots.reduce((s, x) => s + x, 0) / slots.length;
    return node.slot;
  };
  if (finalM) walk(nodes[finalM.id]);

  // any unlinked r32 matches (shouldn't happen with complete data): sort in by date
  for (const m of ko) {
    if (m.round === 'r32' && nodes[m.id].slot == null) nodes[m.id].slot = slotCounter++;
  }

  // candidate teams that can still reach each node (for "under construction")
  const candidates = (node) => {
    if (node.round === 'r32') return [node.match.a.teamId, node.match.b.teamId].filter(Boolean);
    if (node.match.status === 'post') {
      const w = node.match.a.winner ? node.match.a.teamId : node.match.b.teamId;
      return [w];
    }
    const set = new Set();
    for (const f of node.feeders) for (const id of candidates(f)) set.add(id);
    for (const id of [node.match.a.teamId, node.match.b.teamId].filter(Boolean)) set.add(id);
    return [...set];
  };
  for (const m of ko) nodes[m.id].candidates = candidates(nodes[m.id]);

  const winnerOf = (m) => {
    if (m.status !== 'post') return null;
    if (m.a.winner) return m.a.teamId;
    if (m.b.winner) return m.b.teamId;
    return null;
  };

  return { nodes, finalId: finalM ? finalM.id : null, winnerOf };
}

/* ------------------------------------------------------------ fetch */

/* Strip an ESPN payload down to the fields the app actually reads.
   Used for the bundled snapshot and the localStorage cache (~90% smaller). */
export function slim(raw) {
  const keepTeam = (t) => t && ({
    id: t.id, abbreviation: t.abbreviation, displayName: t.displayName,
    color: t.color, logo: t.logo,
  });
  const events = (raw?.scoreboard?.events || []).map((e) => {
    const c = e.competitions?.[0] || {};
    return {
      id: e.id,
      date: e.date,
      competitions: [{
        altGameNote: c.altGameNote,
        notes: c.notes,
        status: {
          displayClock: c.status?.displayClock,
          type: {
            state: c.status?.type?.state,
            completed: c.status?.type?.completed,
            shortDetail: c.status?.type?.shortDetail,
            detail: c.status?.type?.detail,
          },
        },
        venue: {
          fullName: c.venue?.fullName,
          address: { city: c.venue?.address?.city, country: c.venue?.address?.country },
        },
        competitors: (c.competitors || []).map((x) => ({
          homeAway: x.homeAway,
          score: x.score,
          shootoutScore: x.shootoutScore,
          winner: x.winner,
          team: keepTeam(x.team),
        })),
      }],
    };
  });
  const children = (raw?.standings?.children || []).map((ch) => ({
    abbreviation: ch.abbreviation,
    name: ch.name,
    standings: {
      entries: (ch.standings?.entries || []).map((en) => ({
        team: { id: en.team?.id, abbreviation: en.team?.abbreviation, displayName: en.team?.displayName },
        stats: (en.stats || [])
          .filter((s) => ['rank', 'points', 'wins', 'losses', 'ties', 'pointsFor', 'pointsAgainst', 'pointDifferential'].includes(s.name))
          .map((s) => ({ name: s.name, value: s.value, displayValue: s.displayValue })),
        note: en.note ? { description: en.note.description } : undefined,
      })),
    },
  }));
  return { fetchedAt: raw.fetchedAt, scoreboard: { events }, standings: { children } };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function loadModel({ snapshotUrl = 'data/snapshot.json', cacheKey = 'wc26-transit-cache' } = {}) {
  try {
    const [scoreboard, standings] = await Promise.all([fetchJson(SCOREBOARD_URL), fetchJson(STANDINGS_URL)]);
    if (!scoreboard?.events?.length) throw new Error('empty scoreboard');
    const raw = { fetchedAt: new Date().toISOString(), scoreboard, standings };
    try { localStorage.setItem(cacheKey, JSON.stringify(slim(raw))); } catch { /* full/private */ }
    return { model: normalize(raw), source: 'live' };
  } catch (err) {
    // fall through to snapshot / cache
  }
  try {
    const snap = await fetchJson(snapshotUrl);
    if (snap?.scoreboard?.events?.length) return { model: normalize(snap), source: 'snapshot' };
  } catch (err) { /* try cache */ }
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached?.scoreboard?.events?.length) return { model: normalize(cached), source: 'cache' };
  } catch (err) { /* nothing left */ }
  throw new Error('No data available (live, snapshot, and cache all failed).');
}
