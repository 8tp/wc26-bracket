#!/usr/bin/env node
/*
 * scripts/update-snapshot.mjs
 * Fetches ESPN's public World Cup 2026 endpoints and writes data/snapshot.json
 * as the resilience fallback consumed by js/data.js.
 * Node >= 18, no dependencies. Nonzero exit on failure (CI-detectable).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slim } from '../js/data.js';

const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200';
const STANDINGS_URL =
  'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'data', 'snapshot.json');

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  const [scoreboard, standings] = await Promise.all([fetchJson(SCOREBOARD_URL), fetchJson(STANDINGS_URL)]);

  if (!scoreboard || !Array.isArray(scoreboard.events) || scoreboard.events.length === 0) {
    throw new Error('Scoreboard response missing events[] — refusing to write an empty snapshot.');
  }
  if (!standings || !Array.isArray(standings.children) || standings.children.length === 0) {
    throw new Error('Standings response missing children[] — refusing to write an empty snapshot.');
  }

  const snapshot = slim({ fetchedAt: new Date().toISOString(), scoreboard, standings });
  snapshot.fetchedAt = new Date().toISOString();
  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${OUT_PATH} (events: ${scoreboard.events.length}, groups: ${standings.children.length})`);
}

main().catch((err) => {
  console.error('update-snapshot failed:', err?.message || err);
  process.exit(1);
});
