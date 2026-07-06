/* bracket.js — Bracket view renderer (window.WCBracket)
 * Renders a desktop mirrored tree + a mobile horizontally-snapping column view
 * with a sticky round selector. Depends on window.WCUI (from groups.js).
 * Consumes ONLY the normalized Tournament contract from window.WC (see SPEC.md).
 */
(function () {
  'use strict';

  var U = window.WCUI || {};

  var ROUND_ORDER = ['r32', 'r16', 'qf', 'sf', 'final'];
  var ROUND_LABEL = {
    r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarterfinals',
    sf: 'Semifinals', third: '3rd Place', final: 'Final'
  };
  var ROUND_SHORT = {
    r32: 'R32', r16: 'R16', qf: 'QF', sf: 'SF', third: '3rd', final: 'Final'
  };

  // Preserved across re-renders for the mobile view.
  var mobileActiveRound = 'r32';
  // Desktop tree scroll position; null = not scrolled yet, center the Final.
  var desktopScrollLeft = null;

  /* ------------------------------------------------------------ match card */
  function statusLabel(m) {
    if (!m) return '';
    if (m.status === 'in') {
      var clk = m.clock || m.detail || 'LIVE';
      return '<span class="m-live"><span class="live-dot" aria-hidden="true"></span>LIVE</span>' +
        '<span class="m-clock">' + U.esc(clk) + '</span>';
    }
    if (m.status === 'pre') {
      var t = U.kickoff(m.date);
      return '<span class="m-time">' + (t ? U.esc(t) : 'TBD') + '</span>';
    }
    // post
    return '<span class="m-final">' + U.esc(m.detail || 'FT') + '</span>';
  }

  function isWinner(slot, m) {
    if (!slot) return false;
    if (slot.winner) return true;
    if (m && m.winnerId && slot.id && String(slot.id) === String(m.winnerId)) return true;
    return false;
  }

  function scoreCell(slot, m) {
    if (!slot) return '<span class="m-score"></span>';
    var showScore = m && m.status !== 'pre' && slot.score !== null && slot.score !== undefined;
    var pen = (slot.shootoutScore !== null && slot.shootoutScore !== undefined)
      ? '<span class="m-pen">(' + U.esc(slot.shootoutScore) + ')</span>' : '';
    var sc = showScore ? '<span class="m-goals">' + U.esc(slot.score) + '</span>' : '<span class="m-goals m-goals--empty">–</span>';
    if (m && m.status === 'pre') sc = '<span class="m-goals m-goals--empty"></span>';
    return '<span class="m-score">' + sc + pen + '</span>';
  }

  function teamRow(slot, m, side) {
    slot = slot || { placeholder: true, name: 'TBD' };
    var win = isWinner(slot, m);
    var loser = m && m.status === 'post' && m.winnerId && !win && !slot.placeholder;
    var cls = 'm-team m-team--' + side;
    if (slot.placeholder) cls += ' is-placeholder';
    if (win) cls += ' is-winner';
    if (loser) cls += ' is-loser';
    var full = slot.placeholder ? U.shortName(slot) : (slot.name || 'TBD');
    var abbr = slot.placeholder ? U.shortName(slot) : (slot.abbr || slot.name || 'TBD');
    return '<div class="' + cls + '">' +
      U.flag(slot, 'flag') +
      '<span class="m-name"><span class="tn-full">' + U.esc(full) + '</span>' +
      '<span class="tn-abbr">' + U.esc(abbr) + '</span></span>' +
      scoreCell(slot, m) + '</div>';
  }

  function matchAria(m) {
    if (!m) return 'Match to be determined';
    var h = m.home || {}, a = m.away || {};
    var hn = h.placeholder ? U.shortName(h) : (h.name || 'TBD');
    var an = a.placeholder ? U.shortName(a) : (a.name || 'TBD');
    var label = (ROUND_LABEL[m.round] || '') + ': ' + hn + ' versus ' + an;
    if (m.status === 'post') label += ', full time ' + U.num(h.score) + ' to ' + U.num(a.score);
    else if (m.status === 'in') label += ', live ' + (m.clock || '');
    else label += ', kickoff ' + U.kickoff(m.date);
    return label;
  }

  function venueLine(m) {
    if (!m || (!m.venue && !m.city)) return '';
    var parts = [];
    if (m.venue) parts.push(U.esc(m.venue));
    if (m.city) parts.push(U.esc(m.city));
    return '<div class="m-venue">' + parts.join(' · ') + '</div>';
  }

  function matchCard(m, opts) {
    opts = opts || {};
    if (!m) return '<div class="match match--empty" aria-hidden="true"></div>';
    var tag = opts.showRound ? '<span class="m-tag">' + U.esc(ROUND_SHORT[m.round] || '') + '</span>' : '';
    return '<article class="match" data-status="' + U.esc(m.status || 'pre') + '" ' +
      'tabindex="0" aria-label="' + U.esc(matchAria(m)) + '">' +
      '<div class="m-top">' + tag + '<span class="m-status">' + statusLabel(m) + '</span></div>' +
      '<div class="m-teams">' + teamRow(m.home, m, 'home') + teamRow(m.away, m, 'away') + '</div>' +
      venueLine(m) + '</article>';
  }

  /* -------------------------------------------------------- desktop tree */
  function halfMatches(arr, which) {
    arr = arr || [];
    var mid = Math.ceil(arr.length / 2);
    return which === 'left' ? arr.slice(0, mid) : arr.slice(mid);
  }

  function roundColumn(matches, roundKey, half) {
    var wraps = '';
    for (var i = 0; i < matches.length; i++) {
      var pair = (matches.length > 1 && i % 2 === 0);
      wraps += '<div class="match-wrap">' +
        matchCard(matches[i]) +
        (pair ? '<i class="conn-v" aria-hidden="true"></i>' : '') +
        '</div>';
    }
    return '<div class="round round--' + roundKey + '">' +
      '<div class="round-label">' + U.esc(ROUND_SHORT[roundKey]) + '</div>' +
      '<div class="round-body">' + wraps + '</div></div>';
  }

  function championBlock(t) {
    var champ = t && t.champion;
    if (!champ) {
      return '<div class="champion-slot champion-slot--empty">' +
        '<div class="trophy" aria-hidden="true">🏆</div>' +
        '<div class="champ-label">Champion</div>' +
        '<div class="champ-name champ-name--tbd">To be crowned</div></div>';
    }
    return '<div class="champion-slot is-crowned">' +
      '<div class="trophy" aria-hidden="true">🏆</div>' +
      '<div class="champ-label">World Champions</div>' +
      '<div class="champ-team">' + U.flag(champ, 'flag flag--lg') +
      '<span class="champ-name">' + U.esc(champ.name || '') + '</span></div></div>';
  }

  function thirdBlock(t) {
    var m = t && t.rounds && t.rounds.third && t.rounds.third[0];
    if (!m) return '<div class="third-slot"></div>';
    return '<div class="third-slot"><div class="third-label">Third-place play-off</div>' +
      matchCard(m) + '</div>';
  }

  function desktopTree(t) {
    var r = (t && t.rounds) || {};
    var lHtml = '<div class="half half-left">' +
      roundColumn(halfMatches(r.r32, 'left'), 'r32', 'left') +
      roundColumn(halfMatches(r.r16, 'left'), 'r16', 'left') +
      roundColumn(halfMatches(r.qf, 'left'), 'qf', 'left') +
      roundColumn(halfMatches(r.sf, 'left'), 'sf', 'left') +
      '</div>';
    var finalM = (r.final && r.final[0]) || null;
    // Champion + Final + third-place live INSIDE the round body as
    // flex(1)/none/flex(1) items so the Final card's center sits at exactly
    // the same height as the semifinal connector stubs, whatever its height.
    var center = '<div class="center-col">' +
      '<div class="round round--final"><div class="round-label">Final</div>' +
      '<div class="round-body">' +
      championBlock(t) +
      '<div class="match-wrap match-wrap--final">' + matchCard(finalM) + '</div>' +
      thirdBlock(t) +
      '</div></div></div>';
    var rHtml = '<div class="half half-right">' +
      roundColumn(halfMatches(r.sf, 'right'), 'sf', 'right') +
      roundColumn(halfMatches(r.qf, 'right'), 'qf', 'right') +
      roundColumn(halfMatches(r.r16, 'right'), 'r16', 'right') +
      roundColumn(halfMatches(r.r32, 'right'), 'r32', 'right') +
      '</div>';
    return '<div class="bracket-desktop" role="group" aria-label="Knockout bracket">' +
      '<div class="bracket-tree">' + lHtml + center + rHtml + '</div></div>';
  }

  /* --------------------------------------------------------- mobile view */
  function mobileColumn(roundKey, t) {
    var r = (t && t.rounds) || {};
    var cards = '';
    if (roundKey === 'final') {
      cards += championBlock(t);
      var fm = (r.final && r.final[0]) || null;
      cards += '<div class="mcol-final">' + matchCard(fm) + '</div>';
      var tm = (r.third && r.third[0]) || null;
      if (tm) cards += '<div class="mcol-third"><div class="third-label">Third-place play-off</div>' + matchCard(tm) + '</div>';
    } else {
      var arr = r[roundKey] || [];
      for (var i = 0; i < arr.length; i++) cards += matchCard(arr[i]);
      if (!arr.length) cards = '<div class="empty-state">No matches</div>';
    }
    return '<section class="bcol" id="bcol-' + roundKey + '" data-round="' + roundKey + '" ' +
      'aria-label="' + U.esc(ROUND_LABEL[roundKey]) + '">' +
      '<h3 class="bcol-head">' + U.esc(ROUND_LABEL[roundKey]) + '</h3>' +
      '<div class="bcol-body">' + cards + '</div></section>';
  }

  function roundSelector() {
    var btns = '';
    for (var i = 0; i < ROUND_ORDER.length; i++) {
      var k = ROUND_ORDER[i];
      btns += '<button type="button" class="rsel-btn' + (k === mobileActiveRound ? ' is-active' : '') +
        '" data-target="' + k + '">' + U.esc(ROUND_SHORT[k]) + '</button>';
    }
    return '<div class="round-selector" role="tablist" aria-label="Bracket round">' + btns + '</div>';
  }

  function mobileTree(t) {
    var cols = '';
    for (var i = 0; i < ROUND_ORDER.length; i++) cols += mobileColumn(ROUND_ORDER[i], t);
    return '<div class="bracket-mobile" id="bracket-mobile">' + cols + '</div>';
  }

  /* --------------------------------------------------------------- wiring */
  function wireMobile(root) {
    var selector = root.querySelector('.round-selector');
    var scroller = root.querySelector('#bracket-mobile');
    if (!selector || !scroller) return;

    function scrollToRound(key) {
      var col = scroller.querySelector('#bcol-' + key);
      if (!col) return;
      scroller.scrollTo({ left: col.offsetLeft - scroller.offsetLeft, behavior: 'smooth' });
    }
    function setActive(key) {
      mobileActiveRound = key;
      var btns = selector.querySelectorAll('.rsel-btn');
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].getAttribute('data-target') === key;
        btns[i].classList.toggle('is-active', on);
        btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
      }
    }

    selector.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.rsel-btn') : null;
      if (!btn) return;
      var key = btn.getAttribute('data-target');
      setActive(key);
      scrollToRound(key);
    });

    var ticking = false;
    scroller.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () {
        ticking = false;
        var cols = scroller.querySelectorAll('.bcol');
        var center = scroller.scrollLeft + scroller.clientWidth / 2;
        var best = null, bestD = Infinity;
        for (var i = 0; i < cols.length; i++) {
          var c = cols[i];
          var cc = c.offsetLeft - scroller.offsetLeft + c.clientWidth / 2;
          var d = Math.abs(cc - center);
          if (d < bestD) { bestD = d; best = c; }
        }
        if (best) {
          var key = best.getAttribute('data-round');
          if (key !== mobileActiveRound) setActive(key);
        }
      });
    }, { passive: true });

    // Restore previous active round position without animation.
    var restore = scroller.querySelector('#bcol-' + mobileActiveRound);
    if (restore) scroller.scrollLeft = restore.offsetLeft - scroller.offsetLeft;
  }

  function wireDesktop(root) {
    var scroller = root.querySelector('.bracket-desktop');
    if (!scroller) return;
    // Only meaningful when the desktop tree is visible and overflowing.
    var apply = function () {
      if (scroller.scrollWidth <= scroller.clientWidth || scroller.clientWidth === 0) return;
      if (desktopScrollLeft !== null) {
        scroller.scrollLeft = desktopScrollLeft;
      } else {
        // Center the Final/champion column on first paint.
        scroller.scrollLeft = Math.max(0, (scroller.scrollWidth - scroller.clientWidth) / 2);
      }
    };
    apply();
    // Fonts/flags loading can change widths slightly; re-apply next frame.
    if (window.requestAnimationFrame) window.requestAnimationFrame(apply);
    scroller.addEventListener('scroll', function () {
      if (scroller.clientWidth > 0) desktopScrollLeft = scroller.scrollLeft;
    }, { passive: true });
  }

  /* --------------------------------------------------------------- render */
  function render(root, t) {
    if (!root) return;
    root.innerHTML =
      roundSelector() +
      desktopTree(t) +
      mobileTree(t);
    wireMobile(root);
    wireDesktop(root);
  }

  window.WCBracket = { render: render };
})();
