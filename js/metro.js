/*
 * WC26 Transit — metro map renderer
 * Lays out the tournament as a Beck-style transit diagram and renders SVG.
 * Pure view layer: consumes the normalized model from data.js.
 * Also records each team's route polyline (+ stop indices) for journey playback.
 */

const SVGNS = 'http://www.w3.org/2000/svg';

/* --------------------------------------------------------- constants */

export const L = {
  // group district zone
  ROW: 26,            // pitch between team rows inside a group
  GROUP_GAP: 40,      // vertical gap between group districts
  TOP: 132,           // y of first group row center
  LABEL_X: 136,       // team name right edge
  FLAG_X: 142,        // flag left edge
  ORIGIN_X: 172,      // origin terminus ring
  MD_X: [216, 258, 300],   // matchday tick columns
  GATE_X: 344,        // group exit gate (terminus for the 24 eliminated)

  // rail yard (32 parallel tracks fanning group rows -> R32 berths)
  YARD_X0: 428,
  TRACK_PITCH: 6.6,
  APPROACH: 34,       // horizontal run into a station before the blob

  // knockout columns
  R32_X: 692,
  R16_X: 884,
  QF_X: 1052,
  SF_X: 1204,
  M3P_X: 1292,
  M3P_DY: 178,        // bronze shuttle drops this far below the final axis
  FINAL_X: 1380,
  CROWN_X: 1490,

  BERTH: 7,           // half-distance between the two berths of a match
  SR: 9,              // station blob radius
  LINE_W: 4.6,

  HEADER_Y: 66,
  PAD: 28,
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/* ----------------------------------------------------------- helpers */

function el(tag, attrs = {}, children = []) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    n.setAttribute(k, v);
  }
  for (const c of children) n.appendChild(c);
  return n;
}

function pts(d) {
  return d.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
}

/* 45°-elbow router: horizontal lead, then diagonal, then horizontal.
   Falls back to a vertical mid-segment when the rise is too steep. */
function route45(x1, y1, x2, y2, lead = 22) {
  const dy = y2 - y1;
  const s = Math.sign(dy) || 1;
  const ady = Math.abs(dy);
  if (ady < 1.5) return [[x1, y1], [x2, y2]];
  const xa = x1 + lead;
  const rem = x2 - xa;
  if (ady <= rem) {
    return [[x1, y1], [xa, y1], [xa + ady, y2], [x2, y2]];
  }
  const xm = (xa + x2) / 2;
  return [
    [x1, y1],
    [xa, y1],
    [xm, y1 + (xm - xa) * s],
    [xm, y2 - (x2 - xm) * s],
    [x2, y2],
  ];
}

/* theme-aware line color: lighten too-dark colors on the night map,
   darken too-light colors on the paper map */
export function visibleColor(hex) {
  const dark = document.documentElement.dataset.theme === 'dark';
  if (!hex) return dark ? '#9aa4b8' : '#6b7280';
  const m = hex.replace('#', '');
  let r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (dark && lum < 0.22) {
    const t = 0.62 * (0.22 - lum) / 0.22;
    r = Math.round(r + (255 - r) * t);
    g = Math.round(g + (255 - g) * t);
    b = Math.round(b + (255 - b) * t);
  } else if (!dark && lum > 0.60) {
    const t = 0.55 * (lum - 0.60) / 0.40;
    r = Math.round(r * (1 - t));
    g = Math.round(g * (1 - t));
    b = Math.round(b * (1 - t));
  }
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/* ink or paper text on a given background color */
export function textOn(hex) {
  const m = (hex || '#888888').replace('#', '');
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? '#17191d' : '#ffffff';
}

const shortCity = (m) => (m.city || m.venue || '').split(',')[0];
const dayLabel = (m) => {
  const d = new Date(m.ts);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
};

export function scoreText(m) {
  if (m.status === 'pre') return 'vs';
  let a = m.a.score ?? 0, b = m.b.score ?? 0;
  let txt;
  if (m.status === 'post' && m.b.winner) { txt = `${b}–${a}`; }
  else { txt = `${a}–${b}`; }
  if (m.a.pens != null && m.b.pens != null) {
    const pw = m.a.winner ? m.a.pens : m.b.pens;
    const pl = m.a.winner ? m.b.pens : m.a.pens;
    txt += ` (${pw}–${pl}p)`;
  } else if (/AET/i.test(m.detail)) {
    txt += ' aet';
  }
  return txt;
}

/* ------------------------------------------------------------ layout */

export function layout(model) {
  const teams = Object.values(model.teams);

  // group rows: group index A=0..L=11, sorted by rank inside group
  const groups = {};
  for (const t of teams) {
    const g = t.group || '?';
    (groups[g] = groups[g] || []).push(t);
  }
  const letters = Object.keys(groups).sort();
  for (const g of letters) {
    groups[g].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.name.localeCompare(b.name));
  }

  const groupRowH = 4 * L.ROW;
  const districtH = groupRowH + L.GROUP_GAP;
  const yTeam = {};
  const teamRow = {}; // teamId -> {letter, row}
  letters.forEach((g, gi) => {
    groups[g].forEach((t, ri) => {
      yTeam[t.id] = L.TOP + gi * districtH + ri * L.ROW;
      teamRow[t.id] = { letter: g, row: ri };
    });
  });
  const zoneBottom = L.TOP + (letters.length - 1) * districtH + groupRowH;

  // knockout slots → y
  const koTop = L.TOP - 6;
  const koBot = zoneBottom - 6;
  const nSlots = 16;
  const pitch = (koBot - koTop) / nSlots;
  const ySlot = (s) => koTop + (s + 0.5) * pitch;

  const { nodes } = model.bracket;
  const nodeList = Object.values(nodes);
  for (const n of nodeList) n.feeders.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const nodeY = {};
  const yOf = (n) => {
    if (nodeY[n.match.id] != null) return nodeY[n.match.id];
    let y;
    if (n.round === 'r32') y = ySlot(n.slot ?? 0);
    else if (n.feeders.length) y = n.feeders.reduce((s2, f) => s2 + yOf(f), 0) / n.feeders.length;
    else y = ySlot(n.slot ?? 0);
    nodeY[n.match.id] = y;
    return y;
  };
  for (const n of nodeList) yOf(n);

  const COL = { r32: L.R32_X, r16: L.R16_X, qf: L.QF_X, sf: L.SF_X, final: L.FINAL_X };
  const finalNode = nodeList.find((n) => n.round === 'final');
  const yFinal = finalNode ? yOf(finalNode) : (koTop + koBot) / 2;
  const m3pNode = nodeList.find((n) => n.round === 'm3p');

  // next-node map + berth side (north feeder → -BERTH, south → +BERTH)
  const edgeTo = {}; // feederMatchId -> {node, berthY}
  for (const n of nodeList) {
    if (!COL[n.round]) continue;
    n.feeders.forEach((f, i) => {
      const berthY = nodeY[n.match.id] + (i === 0 ? -L.BERTH : L.BERTH);
      edgeTo[f.match.id] = { node: n, berthY };
    });
  }

  // yard berth index: r32 slot s, side 0/1 → track 2s+side
  const berthOf = (n, teamId) => {
    const side = n.match.a.teamId === teamId ? 0 : 1;
    return { track: (n.slot ?? 0) * 2 + side, y: ySlot(n.slot ?? 0) + (side === 0 ? -L.BERTH : L.BERTH) };
  };

  return {
    groups, letters, yTeam, teamRow, zoneBottom,
    ySlot, nodeY, edgeTo, berthOf, yFinal, m3pNode, finalNode,
    W: L.CROWN_X + 130,
    H: Math.max(zoneBottom + 120, yFinal + L.M3P_DY + 90),
  };
}

/* ------------------------------------------------------------ render */

export function render(model) {
  const geo = layout(model);
  const { nodes } = model.bracket;
  const teamColor = {};
  for (const t of Object.values(model.teams)) teamColor[t.id] = visibleColor(t.color);

  const svg = el('svg', {
    class: 'metro',
    viewBox: `0 0 ${geo.W} ${geo.H}`,
    role: 'img',
    'aria-label': 'World Cup 2026 rendered as a metro map',
  });

  /* defs: dot grid */
  const defs = el('defs');
  const grid = el('pattern', { id: 'dotgrid', width: 26, height: 26, patternUnits: 'userSpaceOnUse' });
  grid.appendChild(el('circle', { cx: 1.2, cy: 1.2, r: 1.1, class: 'grid-dot' }));
  defs.appendChild(grid);
  svg.appendChild(defs);
  svg.appendChild(el('rect', { x: 0, y: 0, width: geo.W, height: geo.H, fill: 'url(#dotgrid)' }));

  const gFurniture = el('g', { class: 'furniture' });
  const gGuides = el('g', { class: 'guides' });
  const gLines = el('g', { class: 'lines' });
  const gStations = el('g', { class: 'stations' });
  const gLabels = el('g', { class: 'map-labels' });
  svg.append(gFurniture, gGuides, gLines, gStations, gLabels);

  /* ---- round headers ---- */
  const headers = [
    ['GROUP STAGE', (L.ORIGIN_X + L.GATE_X) / 2 + 40],
    ['THE YARD', L.YARD_X0 + 16 * L.TRACK_PITCH],
    ['ROUND OF 32', L.R32_X],
    ['ROUND OF 16', L.R16_X],
    ['QUARTER-FINALS', L.QF_X],
    ['SEMI-FINALS', L.SF_X],
    ['FINAL', L.FINAL_X],
  ];
  for (const [txt, x] of headers) {
    gFurniture.appendChild(el('text', { x, y: L.HEADER_Y, class: 'round-header', 'text-anchor': 'middle' }, [document.createTextNode(txt)]));
    gFurniture.appendChild(el('line', { x1: x, y1: L.HEADER_Y + 12, x2: x, y2: geo.zoneBottom + 26, class: 'column-rule' }));
  }

  /* ---- group districts ---- */
  geo.letters.forEach((gLetter, gi) => {
    const top = L.TOP + gi * (4 * L.ROW + L.GROUP_GAP) - L.ROW * 0.72;
    const h = 4 * L.ROW + 6;
    gFurniture.appendChild(el('rect', {
      x: 10, y: top, width: L.GATE_X + 22, height: h, class: 'district',
    }));
    gFurniture.appendChild(el('text', { x: 22, y: top + 16, class: 'district-label' }, [document.createTextNode(`GROUP ${gLetter}`)]));
  });

  /* ---- team lines: origins, matchday ticks, yard fan ---- */
  const teamAnchors = {};
  const routes = {}; // teamId -> { pts: [[x,y],...], stops: [{matchId, i}] }
  const colOf = { r32: L.R32_X, r16: L.R16_X, qf: L.QF_X, sf: L.SF_X, final: L.FINAL_X };

  for (const t of Object.values(model.teams)) {
    const y = geo.yTeam[t.id];
    if (y == null) continue;
    const color = teamColor[t.id];
    const gLine = el('g', { class: 'team-line', 'data-team': t.id });
    teamAnchors[t.id] = { x: L.ORIGIN_X, y };

    // flag + name
    const gOrg = el('g', { class: 'origin', 'data-team': t.id });
    gOrg.appendChild(el('rect', { x: L.FLAG_X - 1, y: y - 6.5, width: 20, height: 13, fill: color, opacity: 0.85 }));
    if (t.logo) gOrg.appendChild(el('image', { href: t.logo, x: L.FLAG_X, y: y - 5.5, width: 18, height: 11, preserveAspectRatio: 'xMidYMid slice' }));
    gOrg.appendChild(el('text', { x: L.LABEL_X - 6, y: y + 3.6, class: 'team-name', 'text-anchor': 'end' }, [document.createTextNode(t.name)]));
    gOrg.appendChild(el('circle', { cx: L.ORIGIN_X, cy: y, r: 3.6, fill: color, class: 'origin-ring', 'stroke-width': 1.4 }));
    gLine.appendChild(gOrg);

    // base polyline: origin → gate (dead) or origin → yard → R32 berth
    let d = null;
    let r32j = null;
    let r32BerthY = null;
    if (t.advanced) {
      r32j = t.journey.find((j) => j.round === 'r32');
      if (r32j) {
        const n = nodes[r32j.match.id];
        const berth = geo.berthOf(n, t.id);
        r32BerthY = berth.y;
        const xc = L.YARD_X0 + berth.track * L.TRACK_PITCH;
        const xApp = L.R32_X - L.APPROACH;
        d = [[L.ORIGIN_X + 4, y]];
        const sgn = Math.sign(berth.y - y) || 1;
        const dIn = xc - L.GATE_X, dOut = xApp - xc;
        if (Math.abs(berth.y - y) >= dIn + dOut) {
          d.push([L.GATE_X, y]);
          d.push([xc, y + dIn * sgn]);
          d.push([xc, berth.y - dOut * sgn]);
        } else {
          const xe = L.GATE_X + Math.abs(berth.y - y);
          d.push([L.GATE_X, y]);
          d.push([xe, berth.y]);
        }
        d.push([xApp, berth.y], [L.R32_X - L.SR - 1, berth.y]);
        gLine.appendChild(el('path', { d: pts(d), class: 'line', stroke: color }));
      }
    }
    if (!d) {
      // eliminated (or group ongoing): local service ends at the gate
      d = [[L.ORIGIN_X + 4, y], [L.GATE_X, y]];
      gLine.appendChild(el('path', { d: pts(d), class: 'line line-dead', stroke: color }));
      gLine.appendChild(terminusBar(L.GATE_X + 3, y));
    }
    gLines.appendChild(gLine);

    // route record: origin, matchday stops (on the straight run), then the rest
    const rPts = [d[0]];
    const rStops = [];
    t.md.forEach((j, i) => {
      const x = L.MD_X[i];
      if (!x) return;
      rPts.push([x, y]);
      rStops.push({ matchId: j.match.id, i: rPts.length - 1 });
    });
    for (let k = 1; k < d.length; k++) rPts.push(d[k]);
    if (r32j && r32BerthY != null) {
      rPts.push([L.R32_X, r32BerthY]);
      rStops.push({ matchId: r32j.match.id, i: rPts.length - 1 });
    }
    routes[t.id] = { pts: rPts, stops: rStops };

    // matchday ticks
    t.md.forEach((j, i) => {
      const x = L.MD_X[i];
      if (!x) return;
      const res = j.result;
      const tick = el('circle', {
        cx: x, cy: y, r: 4, class: `tick tick-${res}`, 'data-team': t.id, 'data-match': j.match.id,
      });
      gLine.appendChild(tick);
    });
  }

  /* ---- knockout edges (winner continues / under construction) ---- */
  for (const n of Object.values(nodes)) {
    if (n.round === 'm3p' || n.round === 'r32') continue;
    const xN = colOf[n.round];
    const yN = geo.nodeY[n.match.id];
    n.feeders.forEach((f, i) => {
      const xF = colOf[f.round];
      const yF = geo.nodeY[f.match.id];
      const berthY = yN + (i === 0 ? -L.BERTH : L.BERTH);
      const w = model.bracket.winnerOf(f.match);
      const d = route45(xF + L.SR + 1, yF, xN - L.SR - 1, berthY, 24);
      if (w) {
        gLines.appendChild(el('path', {
          d: pts(d), class: 'line ko-seg', stroke: teamColor[w], 'data-team': w,
        }));
      } else {
        gGuides.appendChild(el('path', { d: pts(d), class: 'guide' }));
      }
    });
  }

  /* final approach to the crown */
  if (geo.finalNode) {
    const yF = geo.yFinal;
    const w = model.bracket.winnerOf(geo.finalNode.match);
    const d = route45(L.FINAL_X + 13, yF, L.CROWN_X, yF, 20);
    if (w) gLines.appendChild(el('path', { d: pts(d), class: 'line ko-seg', stroke: teamColor[w], 'data-team': w }));
    else gGuides.appendChild(el('path', { d: pts(d), class: 'guide guide-gold' }));
  }

  /* bronze shuttle (3rd place) */
  if (geo.m3pNode) {
    const yM = geo.yFinal + L.M3P_DY;
    for (const sf of Object.values(nodes).filter((n) => n.round === 'sf')) {
      const d = route45(L.SF_X + L.SR + 1, geo.nodeY[sf.match.id], L.M3P_X - L.SR - 1, yM, 18);
      gGuides.appendChild(el('path', { d: pts(d), class: 'guide guide-bronze' }));
    }
  }

  /* ---- extend routes through the knockout rounds ---- */
  for (const t of Object.values(model.teams)) {
    const rt = routes[t.id];
    if (!rt) continue;
    const r32j = t.journey.find((j) => j.round === 'r32');
    let prev = r32j ? { x: L.R32_X, y: geo.nodeY[r32j.match.id] } : null;
    for (const j of t.journey) {
      if (j.round === 'group' || j.round === 'r32') continue;
      if (!prev) break;
      const m = j.match;
      const n = nodes[m.id];
      let seg, stopPt, nextPrev;
      if (j.round === 'm3p') {
        const yM = geo.yFinal + L.M3P_DY;
        seg = route45(prev.x + L.SR + 1, prev.y, L.M3P_X - L.SR - 1, yM, 18);
        stopPt = [L.M3P_X, yM];
        nextPrev = { x: L.M3P_X, y: yM };
      } else {
        const xN = colOf[n.round];
        const yN = geo.nodeY[m.id];
        const fi = n.feeders.findIndex((f) => model.bracket.winnerOf(f.match) === t.id);
        const berthY = yN + (fi === 1 ? L.BERTH : -L.BERTH);
        seg = route45(prev.x + L.SR + 1, prev.y, xN - L.SR - 1, berthY, 24);
        stopPt = [xN, berthY];
        nextPrev = { x: xN, y: yN };
      }
      for (const p of seg) rt.pts.push(p);
      rt.pts.push(stopPt);
      rt.stops.push({ matchId: m.id, i: rt.pts.length - 1 });
      prev = nextPrev;
    }
    if (t.champion && geo.finalNode) {
      const yF = geo.yFinal;
      for (const p of route45(L.FINAL_X + 13, yF, L.CROWN_X, yF, 20)) rt.pts.push(p);
      rt.pts.push([L.CROWN_X + 10, yF]);
    }
  }

  /* ---- stations ---- */
  const stationEls = {};
  for (const n of Object.values(nodes)) {
    const isFinal = n.round === 'final';
    const isM3p = n.round === 'm3p';
    const x = isM3p ? L.M3P_X : colOf[n.round];
    const y = isM3p ? geo.yFinal + L.M3P_DY : geo.nodeY[n.match.id];
    const m = n.match;
    const w = model.bracket.winnerOf(m);
    const r = isFinal ? 12 : L.SR;

    const gSt = el('g', { class: `station st-${m.status}${isFinal ? ' st-final' : ''}${isM3p ? ' st-m3p' : ''}`, 'data-match': m.id });
    gSt.appendChild(el('circle', { cx: x, cy: y, r, class: 'blob' }));
    if (m.status === 'in') gSt.appendChild(el('circle', { cx: x, cy: y, r: r + 5, class: 'pulse' }));
    if (w) {
      // winner's flag at the core (color dot fallback when no logo)
      const wt = model.teams[w];
      if (wt?.logo) {
        const fw = isFinal ? 15 : 12, fh = isFinal ? 10 : 8;
        gSt.appendChild(el('image', {
          href: wt.logo, x: x - fw / 2, y: y - fh / 2, width: fw, height: fh,
          preserveAspectRatio: 'xMidYMid slice', class: 'blob-flag',
        }));
        gSt.appendChild(el('rect', {
          x: x - fw / 2, y: y - fh / 2, width: fw, height: fh, class: 'blob-flag-ring',
        }));
      } else {
        gSt.appendChild(el('circle', { cx: x, cy: y, r: isFinal ? 6 : 4.4, fill: teamColor[w], class: 'blob-core' }));
      }
    }
    if (isM3p) gSt.appendChild(el('circle', { cx: x, cy: y, r: r + 3.5, class: 'bronze-ring' }));

    // labels: date above, city + score below
    gSt.appendChild(el('text', { x, y: y - r - 7, class: 'st-date', 'text-anchor': 'middle' }, [document.createTextNode(dayLabel(m))]));
    gSt.appendChild(el('text', { x, y: y + r + 13, class: 'st-city', 'text-anchor': 'middle' }, [document.createTextNode(shortCity(m))]));
    if (m.status !== 'pre') {
      gSt.appendChild(el('text', { x, y: y + r + 25, class: 'st-score', 'text-anchor': 'middle' }, [document.createTextNode(scoreText(m))]));
    }

    // loser terminus bars on feeder berths
    if (m.status === 'post' && !isM3p) {
      const loserId = m.a.winner ? m.b.teamId : m.a.teamId;
      const berthSide = n.round === 'r32'
        ? (m.a.teamId === loserId ? -1 : 1)
        : (n.feeders.findIndex((f) => {
            const lw = model.bracket.winnerOf(f.match);
            return lw === loserId;
          }) === 0 ? -1 : 1);
      const by = y + berthSide * L.BERTH;
      gSt.appendChild(terminusBar(x - r - 4, by));
      const t = el('text', { x: x - r - 9, y: by + 3, class: 'st-out', 'text-anchor': 'end' }, [document.createTextNode(scoreText(m))]);
      gSt.appendChild(t);
    }

    gStations.appendChild(gSt);
    stationEls[m.id] = gSt;
  }

  /* ---- crown terminal ---- */
  const crownY = geo.yFinal;
  const champ = Object.values(model.teams).find((t) => t.champion);
  const gCrown = el('g', { class: `crown${champ ? ' crowned' : ''}` });
  gCrown.appendChild(crownPath(L.CROWN_X + 16, crownY, champ ? 1 : 0.45));
  gCrown.appendChild(el('text', {
    x: L.CROWN_X + 16, y: crownY + 34, class: 'crown-label', 'text-anchor': 'middle',
  }, [document.createTextNode(champ ? 'CHAMPION' : 'TERMINUS · METLIFE')]));
  if (champ) {
    gCrown.appendChild(el('text', { x: L.CROWN_X + 16, y: crownY + 50, class: 'crown-team', 'text-anchor': 'middle' }, [document.createTextNode(champ.name.toUpperCase())]));
  }
  gFurniture.appendChild(gCrown);

  return { svg, geo, stationEls, teamAnchors, routes };
}

/* ---------------------------------------------------------- pieces */

function terminusBar(x, y) {
  return el('line', {
    x1: x, y1: y - 7, x2: x, y2: y + 7,
    class: 'terminus',
  });
}

function crownPath(cx, cy, opacity = 1) {
  const w = 30, h = 20;
  const d = `M${cx - w / 2},${cy + h / 2}
    L${cx - w / 2 + 2},${cy - h / 4}
    L${cx - w / 4},${cy + h / 8}
    L${cx},${cy - h / 2}
    L${cx + w / 4},${cy + h / 8}
    L${cx + w / 2 - 2},${cy - h / 4}
    L${cx + w / 2},${cy + h / 2} Z`;
  return el('path', { d, class: 'crown-shape', opacity });
}
