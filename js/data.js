/*
 * js/data.js — WC26 Live Bracket data layer.
 *
 * Classic browser script (no import/export). Exposes `window.WC` per SPEC.md.
 * Also exposes `window.WC.normalizeTournament` as a standalone pure function
 * so it can be unit tested outside the browser (see scratchpad test harness).
 *
 * No external dependencies.
 */
(function (global) {
  'use strict';

  var SCOREBOARD_URL =
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200';
  var STANDINGS_URL =
    'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026';
  var SNAPSHOT_URL = 'data/snapshot.json';
  var CACHE_KEY = 'wc26-cache';

  var LIVE_POLL_MS = 60 * 1000;
  var IDLE_POLL_MS = 5 * 60 * 1000;
  var ERROR_RETRY_MS = 5 * 60 * 1000;

  // ---------------------------------------------------------------------
  // Round bookkeeping
  // ---------------------------------------------------------------------

  // ESPN season.slug -> our Round key
  var SLUG_TO_ROUND = {
    'round-of-32': 'r32',
    'round-of-16': 'r16',
    quarterfinals: 'qf',
    semifinals: 'sf',
    '3rd-place-match': 'third',
    final: 'final'
  };

  // Round key -> the round that feeds into it (null = fed by groups)
  var PARENT_ROUND = {
    r32: null,
    r16: 'r32',
    qf: 'r16',
    sf: 'qf',
    third: 'sf',
    final: 'sf'
  };

  // Rounds in ascending "tournament progress" order, group stage included
  // only for phase/live-count bookkeeping (it is not part of Tournament.rounds).
  var PHASE_ORDER = ['group', 'r32', 'r16', 'qf', 'sf', 'third', 'final'];

  var ROUND_LABELS = {
    group: 'Group Stage',
    r32: 'Round of 32',
    r16: 'Round of 16',
    qf: 'Quarterfinals',
    sf: 'Semifinals',
    third: 'Third Place Match',
    final: 'Final'
  };

  var BRACKET_ROUNDS = ['r32', 'r16', 'qf', 'sf', 'third', 'final'];

  // ---------------------------------------------------------------------
  // Small defensive utilities
  // ---------------------------------------------------------------------

  function toInt(v) {
    if (v === undefined || v === null || v === '') return null;
    var n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }

  function isPlaceholderName(name) {
    return /winner|loser/i.test(name || '');
  }

  // Parses strings like "Quarterfinal 1 Winner", "Round of 16 6 Winner",
  // "Semifinal 2 Loser" -> { k: 1-based chronological index, kind: 'winner'|'loser' }
  function parsePlaceholder(name) {
    var m = /(\d+)\s*(winner|loser)/i.exec(name || '');
    if (!m) return null;
    return { k: parseInt(m[1], 10), kind: m[2].toLowerCase() };
  }

  function safeGet(obj, path, fallback) {
    try {
      var cur = obj;
      for (var i = 0; i < path.length; i++) {
        if (cur === null || cur === undefined) return fallback;
        cur = cur[path[i]];
      }
      return cur === undefined ? fallback : cur;
    } catch (e) {
      return fallback;
    }
  }

  // ---------------------------------------------------------------------
  // Event -> raw match parsing
  // ---------------------------------------------------------------------

  function buildSlot(competitor, statusState) {
    var team = (competitor && competitor.team) || {};
    var name = team.displayName || team.name || team.shortDisplayName || '';
    var score = statusState === 'pre' ? null : toInt(competitor ? competitor.score : null);
    return {
      id: team.id != null ? String(team.id) : null,
      name: name,
      abbr: team.abbreviation || null,
      logo: team.logo || null,
      score: score,
      shootoutScore: toInt(competitor ? competitor.shootoutScore : null),
      winner: !!(competitor && competitor.winner),
      placeholder: isPlaceholderName(name)
    };
  }

  // Converts one ESPN event into an internal "raw" match (feeds not yet computed).
  function parseEvent(event) {
    try {
      var slug = safeGet(event, ['season', 'slug'], null);
      var comp = safeGet(event, ['competitions', 0], null);
      if (!comp) return null;
      var competitors = comp.competitors || [];
      if (competitors.length < 2) return null;

      var homeRaw = competitors.filter(function (c) { return c.homeAway === 'home'; })[0] || competitors[0];
      var awayRaw = competitors.filter(function (c) { return c.homeAway === 'away'; })[0] || competitors[1];

      var statusState = safeGet(comp, ['status', 'type', 'state'], 'pre');
      var detail = safeGet(comp, ['status', 'type', 'detail'], '') || '';
      var clock = comp.status ? (comp.status.displayClock || null) : null;

      var home = buildSlot(homeRaw, statusState);
      var away = buildSlot(awayRaw, statusState);

      var winnerId = null;
      if (home.winner) winnerId = home.id;
      else if (away.winner) winnerId = away.id;

      return {
        id: event.id != null ? String(event.id) : null,
        round: SLUG_TO_ROUND[slug] || null,
        isGroup: slug === 'group-stage',
        date: event.date || comp.date || null,
        venue: safeGet(comp, ['venue', 'fullName'], null),
        city: safeGet(comp, ['venue', 'address', 'city'], null),
        status: statusState,
        detail: detail,
        clock: clock,
        home: home,
        away: away,
        winnerId: winnerId
      };
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Bracket linkage (`feeds`) + re-sort
  // ---------------------------------------------------------------------

  // Finds, within `parentMatches` (raw chronological order for the parent round),
  // the match id that feeds a given slot of a child-round match.
  function resolveFeed(slot, parentMatches, mode) {
    if (!slot) return null;
    if (slot.placeholder) {
      var ref = parsePlaceholder(slot.name);
      if (!ref) return null;
      var idx = ref.k - 1;
      if (idx < 0 || idx >= parentMatches.length) return null;
      return parentMatches[idx].id;
    }
    // Real team: trace to the parent-round match this team played.
    for (var i = 0; i < parentMatches.length; i++) {
      var m = parentMatches[i];
      var isHome = m.home.id === slot.id;
      var isAway = m.away.id === slot.id;
      if (!isHome && !isAway) continue;
      if (mode === 'loser') {
        // Only a resolved loser if the match has a decided winner and this team lost.
        if (m.winnerId && m.winnerId !== slot.id) return m.id;
      } else {
        if (m.winnerId === slot.id) return m.id;
      }
    }
    return null;
  }

  function computeFeeds(matchesByRound) {
    BRACKET_ROUNDS.forEach(function (round) {
      var parentRound = PARENT_ROUND[round];
      var list = matchesByRound[round] || [];
      if (!parentRound) {
        list.forEach(function (m) {
          m.feeds = { home: null, away: null };
        });
        return;
      }
      var parentMatches = matchesByRound[parentRound] || [];
      var mode = round === 'third' ? 'loser' : 'winner';
      list.forEach(function (m) {
        m.feeds = {
          home: resolveFeed(m.home, parentMatches, mode),
          away: resolveFeed(m.away, parentMatches, mode)
        };
      });
    });
  }

  // Reorders `pool` (array of matches, any order) so that it follows the
  // sequence of ids in `ids` (which may contain nulls / unmatched ids).
  // Any pool items not referenced by `ids` are appended in original order,
  // filling any gaps left by unresolved ids first. This keeps the function
  // total even when feed data is incomplete (defensive fallback to raw order).
  function pickByIds(pool, ids) {
    var used = {};
    var result = new Array(ids.length);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var found = null;
      if (id != null) {
        for (var j = 0; j < pool.length; j++) {
          if (pool[j].id === id && !used[pool[j].id]) {
            found = pool[j];
            break;
          }
        }
      }
      if (found) {
        used[found.id] = true;
        result[i] = found;
      } else {
        result[i] = null;
      }
    }
    var leftover = pool.filter(function (m) {
      return !used[m.id];
    });
    var li = 0;
    for (var k = 0; k < result.length; k++) {
      if (result[k] === null) result[k] = leftover[li++];
    }
    while (li < leftover.length) result.push(leftover[li++]);
    // Drop any still-null slots (pool simply didn't have enough matches).
    return result.filter(function (m) {
      return m != null;
    });
  }

  // Re-sorts every round so the bracket tree nests correctly: final -> sf top
  // down, then qf ordered by the sf slot it feeds, then r16 by qf, then r32
  // by r16. `feeds` values (already computed against raw chronological order)
  // are used as the linkage; this step only changes display order / index.
  function reorderRounds(matchesByRound) {
    var out = {};
    out.final = (matchesByRound.final || []).slice();

    var finalFeedIds = [];
    out.final.forEach(function (m) {
      finalFeedIds.push(m.feeds.home, m.feeds.away);
    });
    out.sf = pickByIds(matchesByRound.sf || [], finalFeedIds);

    // Third place has exactly one match; its own feeds already point at the
    // correct semifinal matches regardless of sf's on-screen order.
    out.third = (matchesByRound.third || []).slice();

    var qfFeedIds = [];
    out.sf.forEach(function (m) {
      qfFeedIds.push(m.feeds.home, m.feeds.away);
    });
    out.qf = pickByIds(matchesByRound.qf || [], qfFeedIds);

    var r16FeedIds = [];
    out.qf.forEach(function (m) {
      r16FeedIds.push(m.feeds.home, m.feeds.away);
    });
    out.r16 = pickByIds(matchesByRound.r16 || [], r16FeedIds);

    var r32FeedIds = [];
    out.r16.forEach(function (m) {
      r32FeedIds.push(m.feeds.home, m.feeds.away);
    });
    out.r32 = pickByIds(matchesByRound.r32 || [], r32FeedIds);

    BRACKET_ROUNDS.forEach(function (round) {
      out[round].forEach(function (m, i) {
        m.index = i;
      });
    });

    return out;
  }

  // ---------------------------------------------------------------------
  // Groups / standings
  // ---------------------------------------------------------------------

  function statValue(stats, name) {
    if (!stats) return null;
    for (var i = 0; i < stats.length; i++) {
      if (stats[i] && stats[i].name === name) return stats[i].value;
    }
    return null;
  }

  function groupKeyFromName(name) {
    var m = /Group\s+([A-Za-z0-9]+)/i.exec(name || '');
    return m ? m[1] : name;
  }

  function normalizeGroups(standingsJson) {
    var children = safeGet(standingsJson, ['children'], []) || [];
    return children.map(function (g) {
      var name = g.name || g.abbreviation || '';
      var entries = safeGet(g, ['standings', 'entries'], []) || [];
      var normEntries = entries.map(function (e) {
        var team = e.team || {};
        var note = e.note || null;
        var stats = e.stats || [];
        return {
          id: team.id != null ? String(team.id) : null,
          name: team.displayName || team.name || '',
          abbr: team.abbreviation || null,
          logo: safeGet(team, ['logos', 0, 'href'], null),
          played: statValue(stats, 'gamesPlayed') || 0,
          won: statValue(stats, 'wins') || 0,
          drawn: statValue(stats, 'ties') || 0,
          lost: statValue(stats, 'losses') || 0,
          gf: statValue(stats, 'pointsFor') || 0,
          ga: statValue(stats, 'pointsAgainst') || 0,
          gd: statValue(stats, 'pointDifferential') || 0,
          points: statValue(stats, 'points') || 0,
          rank: statValue(stats, 'rank') || 0,
          advanced: !!(note && note.description && /advance/i.test(note.description)),
          noteColor: note ? note.color || null : null
        };
      });
      normEntries.sort(function (a, b) {
        return (a.rank || 0) - (b.rank || 0);
      });
      return {
        key: groupKeyFromName(name),
        name: name,
        entries: normEntries
      };
    });
  }

  // ---------------------------------------------------------------------
  // Phase / live-count
  // ---------------------------------------------------------------------

  function computeCurrentPhase(allRaw) {
    var i, round, has;
    for (i = PHASE_ORDER.length - 1; i >= 0; i--) {
      round = PHASE_ORDER[i];
      has = allRaw.some(function (m) {
        return (m.isGroup ? 'group' : m.round) === round && m.status !== 'pre';
      });
      if (has) return ROUND_LABELS[round];
    }
    for (i = 0; i < PHASE_ORDER.length; i++) {
      round = PHASE_ORDER[i];
      has = allRaw.some(function (m) {
        return (m.isGroup ? 'group' : m.round) === round;
      });
      if (has) return ROUND_LABELS[round];
    }
    return ROUND_LABELS.group;
  }

  // ---------------------------------------------------------------------
  // Public: normalizeTournament(scoreboardJson, standingsJson, meta)
  // ---------------------------------------------------------------------

  function normalizeTournament(scoreboardJson, standingsJson, meta) {
    meta = meta || {};
    var events = safeGet(scoreboardJson, ['events'], []) || [];

    var allRaw = [];
    var matchesByRound = { r32: [], r16: [], qf: [], sf: [], third: [], final: [] };

    for (var i = 0; i < events.length; i++) {
      var raw = parseEvent(events[i]);
      if (!raw) continue;
      allRaw.push(raw);
      if (raw.round && matchesByRound[raw.round]) {
        matchesByRound[raw.round].push(raw);
      }
    }

    // Raw chronological order within each round (needed for placeholder
    // "K-th chronological match" resolution and for a stable base order).
    BRACKET_ROUNDS.forEach(function (round) {
      matchesByRound[round].sort(function (a, b) {
        return new Date(a.date || 0) - new Date(b.date || 0);
      });
    });

    computeFeeds(matchesByRound);
    var ordered = reorderRounds(matchesByRound);

    // Strip internal-only fields (isGroup) from the public Match shape.
    var rounds = {};
    BRACKET_ROUNDS.forEach(function (round) {
      rounds[round] = ordered[round].map(function (m) {
        return {
          id: m.id,
          round: m.round,
          index: m.index,
          date: m.date,
          venue: m.venue,
          city: m.city,
          status: m.status,
          detail: m.detail,
          clock: m.clock,
          home: m.home,
          away: m.away,
          winnerId: m.winnerId,
          feeds: m.feeds
        };
      });
    });

    var liveCount = allRaw.filter(function (m) {
      return m.status === 'in';
    }).length;

    var currentPhase = computeCurrentPhase(allRaw);

    var champion = null;
    var finalMatch = rounds.final[0];
    if (finalMatch && finalMatch.status === 'post' && finalMatch.winnerId) {
      champion = finalMatch.home.id === finalMatch.winnerId ? finalMatch.home : finalMatch.away;
    }

    return {
      updatedAt: meta.updatedAt || new Date().toISOString(),
      source: meta.source || 'live',
      currentPhase: currentPhase,
      champion: champion,
      groups: normalizeGroups(standingsJson),
      rounds: rounds,
      liveCount: liveCount
    };
  }

  // ---------------------------------------------------------------------
  // Fetch / fallback chain
  // ---------------------------------------------------------------------

  function fetchJson(url) {
    return global.fetch(url, { headers: { accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error('Request failed (' + res.status + '): ' + url);
      return res.json();
    });
  }

  function writeCache(scoreboard, standings, fetchedAt) {
    try {
      global.localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ fetchedAt: fetchedAt, scoreboard: scoreboard, standings: standings })
      );
    } catch (e) {
      // localStorage unavailable / quota exceeded — non-fatal.
    }
  }

  function readCache() {
    var raw = null;
    try {
      raw = global.localStorage.getItem(CACHE_KEY);
    } catch (e) {
      raw = null;
    }
    if (!raw) throw new Error('No cached WC26 data available.');
    var parsed = JSON.parse(raw);
    return normalizeTournament(parsed.scoreboard, parsed.standings, {
      source: 'cache',
      updatedAt: parsed.fetchedAt
    });
  }

  function fetchLive() {
    return Promise.all([fetchJson(SCOREBOARD_URL), fetchJson(STANDINGS_URL)]).then(function (results) {
      var scoreboard = results[0];
      var standings = results[1];
      var fetchedAt = new Date().toISOString();
      var tournament = normalizeTournament(scoreboard, standings, { source: 'live', updatedAt: fetchedAt });
      writeCache(scoreboard, standings, fetchedAt);
      return tournament;
    });
  }

  function fetchSnapshot() {
    return fetchJson(SNAPSHOT_URL).then(function (snap) {
      return normalizeTournament(snap.scoreboard, snap.standings, {
        source: 'snapshot',
        updatedAt: snap.fetchedAt
      });
    });
  }

  function loadTournament() {
    return fetchLive()
      .catch(function (liveErr) {
        return fetchSnapshot().catch(function () {
          try {
            return readCache();
          } catch (cacheErr) {
            // Nothing worked — surface the original network error.
            throw liveErr;
          }
        });
      });
  }

  // ---------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------

  function startPolling(onUpdate, onError) {
    var timer = null;
    var stopped = false;
    var inFlight = false;

    function delayFor(tournament) {
      return tournament && tournament.liveCount > 0 ? LIVE_POLL_MS : IDLE_POLL_MS;
    }

    function clearTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function schedule(ms) {
      clearTimer();
      if (stopped) return;
      timer = setTimeout(run, ms);
    }

    function run() {
      if (stopped) return;
      if (typeof global.document !== 'undefined' && global.document.hidden) {
        // Paused while hidden; visibilitychange handler resumes us.
        return;
      }
      if (inFlight) return;
      inFlight = true;
      loadTournament()
        .then(function (tournament) {
          inFlight = false;
          if (stopped) return;
          if (onUpdate) onUpdate(tournament);
          // If the page went hidden while the fetch was in flight, don't keep
          // the timer chain alive; visibilitychange resumes us when visible.
          if (typeof global.document === 'undefined' || !global.document.hidden) {
            schedule(delayFor(tournament));
          }
        })
        .catch(function (err) {
          inFlight = false;
          if (stopped) return;
          if (onError) onError(err);
          if (typeof global.document === 'undefined' || !global.document.hidden) {
            schedule(ERROR_RETRY_MS);
          }
        });
    }

    function onVisibilityChange() {
      if (stopped) return;
      if (global.document.hidden) {
        clearTimer();
      } else {
        clearTimer();
        run();
      }
    }

    if (typeof global.document !== 'undefined' && global.document.addEventListener) {
      global.document.addEventListener('visibilitychange', onVisibilityChange);
    }

    run();

    return {
      stop: function () {
        stopped = true;
        clearTimer();
        if (typeof global.document !== 'undefined' && global.document.removeEventListener) {
          global.document.removeEventListener('visibilitychange', onVisibilityChange);
        }
      }
    };
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------

  global.WC = {
    loadTournament: loadTournament,
    startPolling: startPolling,
    normalizeTournament: normalizeTournament
  };
})(typeof window !== 'undefined' ? window : this);
