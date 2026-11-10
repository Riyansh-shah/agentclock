// "Guess the run": guess how long your agent will take, and see how close you
// were when it finishes. Pure, no Node imports.
import { buildRuns, units } from './stats.js';
import { fmt, plural } from './report.js';

const { SEC, MIN, HOUR } = units;
export const HIT = 0.8; // within 20% of the real time counts as a hit

/**
 * "4m", "90s", "1h30m", "2m 30s", "3" (minutes), "2.5" (minutes).
 * @returns {number | null} milliseconds
 */
export function parseDuration(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) {
    const minutes = Number(t);
    return minutes > 0 ? Math.round(minutes * MIN) : null;
  }
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g;
  let total = 0;
  let consumed = '';
  let m;
  while ((m = re.exec(t))) {
    const unit = m[2][0];
    total += Number(m[1]) * (unit === 'h' ? HOUR : unit === 'm' ? MIN : SEC);
    consumed += m[0];
  }
  const squash = (s) => s.replace(/\s+/g, '');
  if (!total || squash(consumed) !== squash(t)) return null;
  return Math.round(total);
}

/**
 * Match each guess to the run it was about (the one running when you guessed,
 * else the next one in that session) and score it. The first guess for a run
 * counts; no changing your answer.
 */
export function scoreGuesses(events, { now = Date.now() } = {}) {
  const bySession = new Map();
  for (const r of buildRuns(events, { now })) {
    if (!bySession.has(r.session)) bySession.set(r.session, []);
    bySession.get(r.session).push(r);
  }
  const guesses = events
    .filter((e) => e && e.event === 'Guess' && typeof e.ms === 'number' && e.ms > 0)
    .sort((a, b) => a.ts - b.ts);

  const claimed = new Set();
  const results = [];
  const pending = [];
  for (const g of guesses) {
    const runs = bySession.get(g.session) || [];
    const run = runs.find((r) => r.start <= g.ts && g.ts <= r.end) || runs.find((r) => r.start > g.ts);
    if (!run) {
      pending.push(g);
      continue;
    }
    const key = `${run.session}:${run.start}`;
    if (claimed.has(key)) continue;
    claimed.add(key);
    const accuracy = run.duration > 0 ? Math.max(0, 1 - Math.abs(g.ms - run.duration) / run.duration) : 0;
    results.push({ session: g.session, guess: g.ms, actual: run.duration, end: run.end, accuracy, hit: accuracy >= HIT });
  }
  results.sort((a, b) => a.end - b.end);

  let streak = 0;
  let best = 0;
  for (const r of results) {
    streak = r.hit ? streak + 1 : 0;
    best = Math.max(best, streak);
  }
  const hits = results.filter((r) => r.hit).length;
  const avg = results.length ? results.reduce((a, r) => a + r.accuracy, 0) / results.length : 0;
  return { results, pending, hits, avg, streak, best };
}

const pct = (x) => `${Math.round(x * 100)}%`;

/** The one-line result shown when a guessed run finishes. */
export function formatGuessResult(result, streak) {
  const tail = result.hit ? (streak > 1 ? ` · ${streak} in a row` : ' · nice') : '';
  return `Guessed ${fmt(result.guess)} · took ${fmt(result.actual)} · ${pct(result.accuracy)} close${tail}`;
}

export function formatGuessSummary(s, { typical } = {}) {
  const out = ['agentclock · guess the run', ''];
  if (!s.results.length && !s.pending.length) {
    out.push(
      '  No guesses yet. While your agent works, or before you send a prompt, type',
      '  /agentclock-guess 5m. When it finishes you\'ll see how close you were.',
    );
  } else {
    if (s.results.length) {
      out.push(
        `  ${plural(s.results.length, 'guess', 'guesses')} · ${s.hits} within 20% · ${pct(s.avg)} average closeness`,
        `  Streak: ${s.streak} in a row (best ${s.best})`,
        '',
        '  Recent',
        ...s.results.slice(-5).reverse().map((r) =>
          `    guessed ${fmt(r.guess).padEnd(9)} took ${fmt(r.actual).padEnd(9)} ${pct(r.accuracy).padStart(4)}  ${r.hit ? 'hit' : 'miss'}`),
      );
    }
    if (s.pending.length) out.push('', `  Waiting to score: ${s.pending.map((g) => fmt(g.ms)).join(', ')}`);
  }
  if (typical) out.push('', `  Your typical run lately: ${fmt(typical)}`);
  out.push('  Guess the next one: /agentclock-guess 5m');
  return out.join('\n');
}
