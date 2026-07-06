# WC26 Live Bracket — Architecture Spec

A static, no-build-step website (deployed on GitHub Pages) showing the 2026 FIFA World Cup
bracket and group standings, **updating live** from ESPN's public API. Must look great on
mobile AND desktop. Today is July 5 2026 — the tournament is mid-Round-of-16, so real data
flows through everything.

## File layout (repo root = site root)

```
index.html            — single page, loads css/js, no frameworks, no build step
css/styles.css        — all styles (mobile-first, dark default + light via prefers-color-scheme)
js/data.js            — DATA LAYER (owned by data agent) — see contract below
js/app.js             — app bootstrap, view switching, polling wiring (UI agent)
js/bracket.js         — bracket view renderer (UI agent)
js/groups.js          — group-stage standings view renderer (UI agent)
data/snapshot.json    — bundled fallback snapshot {scoreboard, standings} (data agent generates)
scripts/update-snapshot.mjs — node script that fetches ESPN + writes data/snapshot.json (data agent)
.github/workflows/update-data.yml — cron workflow refreshing snapshot.json (data agent)
```

Plain ES5/ES2020 browser JS via `<script src>` tags (NOT modules with CORS issues on file://
— use classic scripts setting `window.WC`). No external JS/CSS dependencies. Google Fonts allowed.

## Data source (verified working, CORS `Access-Control-Allow-Origin: *`)

1. All 104 matches:
   `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200`
2. Group standings (12 groups):
   `https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026`

Raw fixture files for development are at repo root: `espn_all.json` (scoreboard), `espn_standings.json`.
These will be deleted before commit; `data/snapshot.json` is the bundled copy.

### Key facts about the ESPN payload (verified against live data)
- `events[]`, each with `season.slug` ∈ `group-stage`(72), `round-of-32`(16), `round-of-16`(8),
  `quarterfinals`(4), `semifinals`(2), `3rd-place-match`(1), `final`(1). Total 104.
- `event.competitions[0].competitors[]`: `homeAway` ('home'|'away'), `team.id`, `team.displayName`,
  `team.abbreviation`, `team.logo` (country flag PNG from a.espncdn.com), `score` (string),
  `winner` (bool), `shootoutScore` (number, only present after penalties).
- Unresolved future slots are placeholder teams, e.g. `displayName: "Quarterfinal 1 Winner"`,
  `abbreviation: "QFW1"` — these have NO real logo; treat any team whose displayName matches
  /winner|loser/i as a placeholder slot.
- `competitions[0].status`: `type.state` ∈ 'pre'|'in'|'post'; `type.detail` e.g. "FT", "FT-Pens",
  kickoff string for 'pre'; `displayClock` (e.g. "90'+11'") and `period` for live.
- `competitions[0].venue.fullName` + `venue.address.city`.
- Standings payload: `children[]` = groups (name "Group A"…"Group L"), each
  `standings.entries[]` with `team` (id/displayName/abbreviation/logos[0].href),
  `note` ({color, description, rank} for advancement), and `stats[]` array — find by `name`:
  gamesPlayed, wins, ties, losses, points, pointsFor (GF), pointsAgainst (GA), pointDifferential (GD), rank.

## DATA CONTRACT — `js/data.js` exposes `window.WC`:

```js
window.WC = {
  // Fetch live from ESPN; on network failure fall back to data/snapshot.json,
  // then to localStorage cache ('wc26-cache'). Resolves a Tournament object.
  loadTournament: function() { return Promise<Tournament> },

  // Calls onUpdate(tournament) immediately-after-first-load and then re-fetches:
  // every 60s if any match status==='in', every 5 min otherwise. Handles visibilitychange
  // (pause when hidden, refresh on visible). Returns {stop: fn}.
  startPolling: function(onUpdate, onError) { ... },
};

Tournament = {
  updatedAt: ISOString,          // when this data was fetched
  source: 'live'|'snapshot'|'cache',
  currentPhase: string,          // e.g. "Round of 16" (from most recent non-'pre' round)
  champion: Slot|null,           // winner of final if final is post
  groups: [ { key:'A', name:'Group A', entries:[GroupEntry x4] } x12 ],  // sorted by rank
  rounds: { r32:Match[16], r16:Match[8], qf:Match[4], sf:Match[2], third:Match[1], final:Match[1] },
  liveCount: number,             // matches currently in play
}
GroupEntry = { id, name, abbr, logo, played, won, drawn, lost, gf, ga, gd, points, rank,
               advanced: bool,   // note.description mentions advance
               noteColor: string|null }
Match = {
  id, round: 'r32'|'r16'|'qf'|'sf'|'third'|'final',
  index: number,                 // 0-based position within its round, chronological by date
  date: ISOString, venue, city,
  status: 'pre'|'in'|'post', detail: string, clock: string|null,
  home: Slot, away: Slot,
  winnerId: string|null,
  feeds: { home: matchId|null, away: matchId|null },  // which prior-round match produces each slot
}
Slot = { id, name, abbr, logo: string|null, score: number|null,
         shootoutScore: number|null, winner: bool, placeholder: bool }
```

### Bracket linkage (`feeds`) algorithm
For each match M in round N+1, for each slot S:
- If S is a real team, find the round-N match whose winner is that team id → feeds.
- If S is a placeholder like "Quarterfinal K Winner", feed = K-th (1-based) chronological
  match of round N.
- Round of 32 has feeds = null (comes from groups).
- 3rd-place match feeds from the two semifinals (losers) — same index logic.

Matches within each round MUST be ordered so the bracket tree nests correctly:
order rounds sf → final top-down, then order qf so that qf feeding sf[0] come first, etc.
(I.e., after computing feeds, re-sort each earlier round by the position of the match it
feeds into; keep `index` = final display order. r32 pairs feed r16 in order.)

## UI requirements

- **Two views**: Bracket (default) and Groups, switchable via a top tab/segmented control.
- **Bracket desktop (≥960px)**: classic tree — left half (8 R32 matches → 4 R16 → 2 QF → 1 SF)
  flowing rightward, right half mirrored flowing leftward, Final + champion + 3rd-place in the
  center column. Connector lines between rounds. This is the marquee visual — make it beautiful.
- **Bracket mobile (<960px)**: horizontally swipeable round-by-round columns with scroll-snap +
  a sticky round selector (R32 · R16 · QF · SF · Final). No pinch-zooming ever needed.
- **Match card**: flags, team names (abbr on tight screens), scores, penalty scores as e.g.
  "(4) 1–1 (3)" or a "pens" annotation, winner bolded / loser dimmed, LIVE pulsing badge with
  clock for in-play, kickoff in the VIEWER'S local time (from ISO date) for upcoming, venue.
- **Champion celebration**: when final is decided, show champion prominently center-top.
- **Groups view**: 12 group tables (A–L) in a responsive grid, advancement rows tinted
  (top-2 + best 3rds advance; use the `advanced` flag), W/D/L/GD/Pts columns.
- **Header**: title, current phase, live-match count badge, "Updated HH:MM" stamp, subtle
  refresh spinner during fetches. Footer: data source credit (ESPN) + last update.
- **Theme**: dark default, respects `prefers-color-scheme: light`. Accent palette inspired by
  the 2026 tri-host: deep navy/near-black bg, electric green + warm red accents used sparingly.
  Typeface: a display font (e.g. 'Archivo' or 'Sora' from Google Fonts) for headings, system
  stack for data. Must remain legible and fast.
- Accessibility: semantic HTML, aria-labels on match cards, focus styles, prefers-reduced-motion.
- Zero horizontal body scroll on mobile; the bracket scrolls inside its own container.

## Update flow

Live-first: browser fetches ESPN directly (CORS is open). `data/snapshot.json` is only a
resilience fallback, refreshed by the GitHub Action every 30 min during tournament dates.
The Action commits only when content changed. GitHub Pages serves from main / root.
