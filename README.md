# WC26 Live Bracket

A live-updating 2026 FIFA World Cup bracket and group-stage tracker. Pure static site —
no build step, no framework, no API key — designed for GitHub Pages.

**Live data:** the browser fetches ESPN's public scoreboard + standings APIs directly
(CORS-open) and re-polls every 60 seconds while matches are in play (every 5 minutes
otherwise). If the API is unreachable, it falls back to a bundled snapshot
(`data/snapshot.json`, refreshed every 30 minutes by a GitHub Action) and then to the
last good copy cached in `localStorage`.

## Features

- Full 48-team format: 12 group tables (A–L) and the complete knockout tree
  (Round of 32 → Round of 16 → Quarterfinals → Semifinals → Final + 3rd place)
- Mirrored desktop bracket with connector lines and a center Final column
- Mobile: swipeable round-by-round columns with a sticky round selector — no pinch-zoom
- Live match badges with match clock, penalty-shootout scores, kickoff times shown in
  your local timezone, venues
- Champion celebration once the Final is decided
- Dark theme by default, honors `prefers-color-scheme: light` and `prefers-reduced-motion`

## Deploy (GitHub Pages)

Settings → Pages → Deploy from a branch → `main` / `/ (root)`. That's it — the site is
static files at the repo root.

## Local development

Serve the folder over HTTP (needed so `data/snapshot.json` can be fetched):

```sh
npx serve .        # or: python -m http.server
```

Refresh the bundled snapshot manually:

```sh
node scripts/update-snapshot.mjs
```

## Structure

```
index.html                     entry point
css/styles.css                 all styling (mobile-first)
js/data.js                     ESPN fetch + normalization + polling (window.WC)
js/bracket.js, js/groups.js    view renderers
js/app.js                      bootstrap + view switching
data/snapshot.json             bundled fallback data
scripts/update-snapshot.mjs    snapshot refresher (used by CI)
.github/workflows/update-data.yml  30-min cron refresh during the tournament
```

Data courtesy of ESPN's public API. Flags via ESPN country logos. Not affiliated with
FIFA or ESPN. Inspired by [shadymccoy/WC26](https://shadymccoy.github.io/WC26/).
