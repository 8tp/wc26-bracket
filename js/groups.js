/* groups.js — shared UI utilities (window.WCUI) + Groups view renderer (window.WCGroups)
 * Loaded before bracket.js and app.js, so WCUI is available to both.
 * Consumes ONLY the normalized Tournament contract from window.WC (see SPEC.md).
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- utils */
  var WCUI = {};

  WCUI.esc = function (v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  // Shorten placeholder slot names: "Quarterfinal 1 Winner" -> "Winner QF1"
  WCUI.shortName = function (slot) {
    if (!slot) return 'TBD';
    var name = slot.name || slot.abbr || 'TBD';
    if (!slot.placeholder) return name;
    var maps = [
      [/round of 32\D*(\d+)\D*(winner|loser)/i, 'R32'],
      [/round of 16\D*(\d+)\D*(winner|loser)/i, 'R16'],
      [/quarterfinal\D*(\d+)\D*(winner|loser)/i, 'QF'],
      [/semifinal\D*(\d+)\D*(winner|loser)/i, 'SF'],
      [/final\D*(\d+)?\D*(winner|loser)/i, 'F']
    ];
    for (var i = 0; i < maps.length; i++) {
      var m = name.match(maps[i][0]);
      if (m) {
        var role = /loser/i.test(name) ? 'Loser' : 'Winner';
        var label = maps[i][1];
        var n = m[1] ? (label.length > 2 ? '-' + m[1] : m[1]) : '';
        return role + ' ' + label + n;
      }
    }
    // group placeholders like "Group A Winner"
    var g = name.match(/group\s+([a-l])\D*(winner|runner|\d)/i);
    if (g) return name;
    return slot.abbr || name;
  };

  // Monogram (1-3 letters) for a slot lacking a logo.
  WCUI.monogram = function (slot) {
    if (!slot) return '?';
    if (slot.abbr) return slot.abbr.slice(0, 3).toUpperCase();
    var n = (slot.name || '').replace(/[^a-z]/gi, '');
    return (n.slice(0, 2) || '?').toUpperCase();
  };

  // Flag/logo markup with graceful fallback to a monogram box.
  WCUI.flag = function (slot, cls) {
    cls = cls || 'flag';
    var mono = WCUI.esc(WCUI.monogram(slot));
    if (slot && slot.logo && !slot.placeholder) {
      return '<span class="' + cls + '">' +
        '<img src="' + WCUI.esc(slot.logo) + '" alt="" loading="lazy" decoding="async" ' +
        'onerror="this.parentNode.classList.add(\'flag--broken\');this.remove();" />' +
        '<span class="flag-mono" aria-hidden="true">' + mono + '</span></span>';
    }
    return '<span class="' + cls + ' flag--mono">' +
      '<span class="flag-mono" aria-hidden="true">' + mono + '</span></span>';
  };

  // Local kickoff time for upcoming matches.
  WCUI.kickoff = function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    try {
      var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (sameDay) return time;
      var day = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return day + ' · ' + time;
    } catch (e) {
      return d.toISOString().slice(11, 16);
    }
  };

  WCUI.clockTime = function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return d.toISOString().slice(11, 16);
    }
  };

  WCUI.num = function (v) {
    return (v === null || v === undefined || v === '') ? '' : String(v);
  };

  WCUI.signed = function (v) {
    var n = Number(v);
    if (isNaN(n)) return WCUI.num(v);
    return n > 0 ? '+' + n : String(n);
  };

  window.WCUI = WCUI;

  /* --------------------------------------------------------------- groups */
  // API-provided colors go into an inline style attribute: accept strict hex
  // only (#rgb…#rrggbbaa) so no CSS declarations can be injected via ';' etc.
  function safeColor(c) {
    return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) ? c : null;
  }

  function entryRow(e, rank) {
    e = e || {};
    var advanced = !!e.advanced;
    var note = safeColor(e.noteColor);
    var tint = note ? ' style="--note:' + note + '"' : '';
    var slot = { name: e.name, abbr: e.abbr, logo: e.logo, placeholder: false };
    return '<tr class="grp-row' + (advanced ? ' is-advanced' : '') + '"' + tint + '>' +
      '<td class="c-rank">' + WCUI.esc(e.rank || rank) + '</td>' +
      '<td class="c-team">' + WCUI.flag(slot, 'flag flag--sm') +
      '<span class="grp-team"><span class="tn-full">' + WCUI.esc(e.name || '') + '</span>' +
      '<span class="tn-abbr">' + WCUI.esc(e.abbr || e.name || '') + '</span></span></td>' +
      '<td class="c-num">' + WCUI.esc(WCUI.num(e.played)) + '</td>' +
      '<td class="c-num">' + WCUI.esc(WCUI.num(e.won)) + '</td>' +
      '<td class="c-num">' + WCUI.esc(WCUI.num(e.drawn)) + '</td>' +
      '<td class="c-num">' + WCUI.esc(WCUI.num(e.lost)) + '</td>' +
      '<td class="c-num c-opt">' + WCUI.esc(WCUI.num(e.gf)) + '</td>' +
      '<td class="c-num c-opt">' + WCUI.esc(WCUI.num(e.ga)) + '</td>' +
      '<td class="c-num">' + WCUI.esc(WCUI.signed(e.gd)) + '</td>' +
      '<td class="c-num c-pts">' + WCUI.esc(WCUI.num(e.points)) + '</td>' +
      '</tr>';
  }

  function groupCard(g) {
    g = g || {};
    var entries = g.entries || [];
    var rows = '';
    for (var i = 0; i < entries.length; i++) rows += entryRow(entries[i], i + 1);
    if (!rows) {
      rows = '<tr class="grp-row grp-empty"><td colspan="10">Standings not available</td></tr>';
    }
    return '<section class="group-card" aria-label="' + WCUI.esc(g.name || ('Group ' + g.key)) + '">' +
      '<h3 class="group-head"><span class="group-letter">' + WCUI.esc(g.key || '') + '</span>' +
      WCUI.esc(g.name || ('Group ' + g.key)) + '</h3>' +
      '<div class="group-table-wrap">' +
      '<table class="group-table"><thead><tr>' +
      '<th class="c-rank" scope="col"><span class="sr-only">Position</span>#</th>' +
      '<th class="c-team" scope="col">Team</th>' +
      '<th class="c-num" scope="col" title="Played">P</th>' +
      '<th class="c-num" scope="col" title="Won">W</th>' +
      '<th class="c-num" scope="col" title="Drawn">D</th>' +
      '<th class="c-num" scope="col" title="Lost">L</th>' +
      '<th class="c-num c-opt" scope="col" title="Goals for">GF</th>' +
      '<th class="c-num c-opt" scope="col" title="Goals against">GA</th>' +
      '<th class="c-num" scope="col" title="Goal difference">GD</th>' +
      '<th class="c-num c-pts" scope="col" title="Points">Pts</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></section>';
  }

  function render(root, t) {
    if (!root) return;
    var groups = (t && t.groups) || [];
    if (!groups.length) {
      root.innerHTML = '<div class="empty-state">Group standings are not available yet.</div>';
      return;
    }
    var html = '<div class="groups-grid">';
    for (var i = 0; i < groups.length; i++) html += groupCard(groups[i]);
    html += '</div>';
    html += '<p class="groups-legend"><span class="legend-swatch"></span>' +
      'Highlighted rows advance to the knockout stage (top two of each group plus the best third-placed teams).</p>';
    root.innerHTML = html;
  }

  window.WCGroups = { render: render };
})();
