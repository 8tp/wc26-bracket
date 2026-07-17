# WC26 Transit Authority

**The 2026 FIFA World Cup rendered as a living metro map.**
48 lines depart the group districts. One reaches the crown at MetLife.

Every national team is a metro line drawn in its real colors. Every match is a
station where exactly two lines meet. Win, and your service continues east.
Lose, and it's the end of the line — terminus bar, with the score that ended it.

## Reading the map

- **Group districts (left third):** twelve neighborhoods, four local lines each.
  Matchday results are tick stops (green/amber/red). The 24 lines that don't
  qualify terminate at the district gate.
- **The Yard:** 32 qualifiers fan through a rail-yard throat of parallel 45°
  tracks into their Round-of-32 berths — the busiest stretch of the network.
- **The knockout trunk:** R32 → R16 → QF → SF → Final. Each station halves the
  network. The blob's core takes the winner's color.
- **Under construction:** dashed guideways where the route exists but the
  traveler doesn't. Hover a future station to light up every team that can
  still reach it.
- **The Bronze Shuttle:** a dashed spur carrying semifinal losers to the
  third-place match.
- **The crown terminal:** one line ends at MetLife Stadium with the crown.

## Using it

- **Hover** any line or station to isolate routes (future stations show all
  possible arrivals)
- **Click a team** for its journey receipt — every stop, score, venue, in your
  timezone
- **Click a station** for full match details
- **Directory** (left) to search and fly to any of the 48 lines
- **Departures board** (top right): live services, next kickoffs, recent results
- Drag to pan, scroll to zoom — works with touch and pinch

## Data

The browser fetches ESPN's public scoreboard + standings APIs directly
(CORS-open), re-polling every 60s while matches are live (5 min otherwise).
Fallback chain: live API → bundled `data/snapshot.json` (refreshed every
30 min by a GitHub Action during the tournament) → last good copy in
`localStorage`.

Flags/logos and team colors: ESPN. Not affiliated with FIFA or ESPN.
Map grammar after Harry Beck.

## Deploy (GitHub Pages)

Settings → Pages → Deploy from a branch → `main` / `/ (root)`. Done — the site
is static files at the repo root; `data/snapshot.json` is bundled in-repo.

## Local development

Serve over HTTP (so the snapshot fetch works):

```sh
npx serve .        # or: python3 -m http.server
```

Refresh the bundled snapshot manually:

```sh
node scripts/update-snapshot.mjs
```

## Structure

```
index.html                      entry point
css/styles.css                  visual system (dark transit theme)
js/data.js                      ESPN fetch + normalization + bracket builder
js/metro.js                     map layout engine + SVG renderer
js/app.js                       panels, routing interactions, pan/zoom, polling
data/snapshot.json              bundled fallback data
scripts/update-snapshot.mjs     snapshot refresher (used by CI)
.github/workflows/update-data.yml
```

Inspired by [shadymccoy/WC26](https://shadymccoy.github.io/WC26/) and
[8tp/wc26-bracket](https://github.com/8tp/wc26-bracket) — both excellent
classic brackets. This one takes the train.
