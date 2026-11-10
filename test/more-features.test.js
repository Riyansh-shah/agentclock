import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDuration, scoreGuesses, formatGuessResult, formatGuessSummary } from '../src/guess.js';
import { nudgeFor, isValidTopic } from '../src/nudge.js';
import { buildRuns, computeStats, units } from '../src/stats.js';
import { formatReport, plural, compactForModel } from '../src/report.js';
import { formatRecapText } from '../src/recap.js';
import { liveSessions } from '../src/live.js';
import { addHooks, removeHooks, CODEX_HOOKS } from '../src/install.js';
import { sessionFileName } from '../src/events.js';

const { SEC, MIN, HOUR } = units;
const ev = (session, ts, event, extra = {}) => ({ ts, event, session, project: 'app', ...extra });
const cli = fileURLToPath(new URL('../cli/agentclock.js', import.meta.url));

// ---------- guess the run ----------

test('durations people type are understood', () => {
  const cases = { '5m': 5 * MIN, '90s': 90 * SEC, '1h30m': 90 * MIN, '2m 30s': 150 * SEC, '3': 3 * MIN, '2.5': 150 * SEC, '10 min': 10 * MIN, '1 hour': HOUR, '45 secs': 45 * SEC };
  for (const [text, ms] of Object.entries(cases)) assert.equal(parseDuration(text), ms, text);
  for (const bad of ['', 'soon', '5x', '-3', '0', '5ms', 'm5']) assert.equal(parseDuration(bad), null, bad);
});

test('a guess is scored against the run it was made in, or the next one', () => {
  const events = [
    ev('a', 0, 'Guess', { ms: 4 * MIN }), // before the run: counts for the next run
    ev('a', 1 * SEC, 'UserPromptSubmit'),
    ev('a', 5 * MIN + 1 * SEC, 'Stop'), // took 5m: 75% close, a miss
    ev('a', 10 * MIN, 'UserPromptSubmit'),
    ev('a', 10 * MIN + 30 * SEC, 'Guess', { ms: 2 * MIN }), // during the run
    ev('a', 10 * MIN + 45 * SEC, 'Guess', { ms: 9 * MIN }), // second guess for the same run: ignored
    ev('a', 12 * MIN, 'Stop'), // took 2m: exact
    ev('a', 20 * MIN, 'Guess', { ms: 3 * MIN }), // nothing ran after this yet
  ];
  const s = scoreGuesses(events, { now: 30 * MIN });
  assert.deepEqual(s.results.map((r) => [r.guess / MIN, Math.round(r.accuracy * 100), r.hit]), [[4, 80, true], [2, 100, true]]);
  assert.equal(s.streak, 2);
  assert.equal(s.best, 2);
  assert.equal(s.pending.length, 1);
});

test('guess messages read well', () => {
  assert.equal(
    formatGuessResult({ guess: 4 * MIN, actual: 3 * MIN + 40 * SEC, accuracy: 0.91, hit: true }, 3),
    'Guessed 4m · took 3m 40s · 91% close · 3 in a row',
  );
  assert.equal(formatGuessResult({ guess: 10 * MIN, actual: 2 * MIN, accuracy: 0, hit: false }, 0), 'Guessed 10m · took 2m · 0% close');
  const empty = formatGuessSummary(scoreGuesses([]), {});
  assert.match(empty, /No guesses yet/);
  const one = formatGuessSummary({ results: [{ guess: MIN, actual: MIN, accuracy: 1, hit: true }], pending: [], hits: 1, avg: 1, streak: 1, best: 1 }, { typical: 3 * MIN });
  assert.match(one, /1 guess · 1 within 20%/);
  assert.match(one, /typical run lately: 3m/);
});

test('guesses never count as agent activity', () => {
  const events = [
    ev('a', 0, 'UserPromptSubmit'),
    ev('a', 10 * SEC, 'PermissionRequest'),
    ev('a', 20 * SEC, 'Guess', { ms: MIN }), // must not end the permission wait
    ev('a', 70 * SEC, 'PostToolUse'),
    ev('a', 80 * SEC, 'Stop'),
  ];
  const [run] = buildRuns(events, { now: 1e15 });
  assert.equal(run.blocked, 60 * SEC);
  assert.equal(run.tools, 1);
});

// ---------- nudge ----------

test('nudge: only after the wait is long enough and Claude Code says you are away', () => {
  const after = 5 * MIN;
  const base = [ev('s', 0, 'UserPromptSubmit'), ev('s', 1 * MIN, 'PermissionRequest', { project: 'shop-api' })];
  // you were typing, so no permission_prompt notification: no nudge
  assert.equal(nudgeFor(base, { now: 20 * MIN, after, session: 's' }), null);
  const away = [...base, ev('s', 1 * MIN + 6 * SEC, 'Notification', { kind: 'permission_prompt' })];
  assert.equal(nudgeFor(away, { now: 4 * MIN, after, session: 's' }), null, 'too early');
  const n = nudgeFor(away, { now: 7 * MIN, after, session: 's' });
  assert.equal(n.text, 'Your agent in shop-api has been waiting for your approval for 6m.');
  assert.equal(n.key, `s:approval:${1 * MIN}`);
  // answered: nothing to nudge
  assert.equal(nudgeFor([...away, ev('s', 3 * MIN, 'PostToolUse')], { now: 20 * MIN, after, session: 's' }), null);
});

test('nudge: finished work you have not come back to', () => {
  const events = [
    ev('s', 0, 'UserPromptSubmit', { project: 'web' }),
    ev('s', 2 * MIN, 'Stop', { project: 'web' }),
    ev('s', 3 * MIN, 'Notification', { kind: 'idle_prompt' }),
  ];
  assert.equal(nudgeFor(events, { now: 10 * MIN, after: 5 * MIN, session: 's' }).text, 'Your agent in web finished 8m ago and is waiting for you.');
  assert.equal(nudgeFor([...events, ev('s', 9 * MIN, 'UserPromptSubmit')], { now: 10 * MIN, after: 5 * MIN, session: 's' }), null);
  assert.equal(nudgeFor(events, { now: 10 * MIN, after: 5 * MIN, session: 'other' }), null);
});

test('ntfy topics are checked', () => {
  assert.equal(isValidTopic('my-agents_x7k2'), true);
  for (const bad of ['', 'has space', 'a/b', 'x'.repeat(65), undefined]) assert.equal(isValidTopic(bad), false);
});

// ---------- Codex ----------

test('Codex hooks: the right events, tagged as Codex, and removable', () => {
  const opts = { scriptPath: '/opt/agentclock/cli/agentclock.js', nodePath: '/usr/bin/node', agent: 'codex' };
  const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] } };
  const next = addHooks(mine, opts);
  assert.deepEqual(Object.keys(next.hooks).sort(), [...new Set(CODEX_HOOKS.map((h) => h.event))].sort());
  const interrupt = next.hooks.Interrupt[0].hooks[0];
  assert.equal(interrupt.command, '"/usr/bin/node" "/opt/agentclock/cli/agentclock.js" log --event Interrupt --agent codex');
  assert.equal(interrupt.timeout, undefined, 'Codex caps some hook timeouts, so none is set');
  assert.equal(next.hooks.Stop.length, 2, 'your own Stop hook is kept');
  assert.deepEqual(removeHooks(next), mine);
});

test('Codex: Interrupt ends a run, and reports split runs by agent', () => {
  const events = [
    ev('c1', 0, 'UserPromptSubmit', { agent: 'codex' }),
    ev('c1', 2 * MIN, 'Interrupt', { agent: 'codex' }),
    ev('k1', 0, 'UserPromptSubmit'),
    ev('k1', 1 * MIN, 'Stop'),
  ];
  const runs = buildRuns(events, { now: 1e15 });
  assert.deepEqual(runs.map((r) => [r.agent, r.ending]).sort(), [['claude', 'stop'], ['codex', 'interrupted']]);
  const text = formatReport(computeStats(runs, { now: 1e15 }), { title: 'x', dataPath: '/d' });
  assert.match(text, /Agents\s+Claude Code 1 run · Codex 1 run/);
  const live = liveSessions(events, { now: 3 * MIN });
  assert.equal(live.find((s) => s.session === 'c1').state, 'done');
});

test('Codex sessions are written to their own prefixed file by the CLI', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentclock-codex-'));
  const env = { ...process.env, AGENTCLOCK_HOME: home };
  const send = (event, extra = {}) => spawnSync(process.execPath, [cli, 'log', '--event', event, '--agent', 'codex'], {
    input: JSON.stringify({ hook_event_name: event, session_id: 'cx-1', cwd: '/work/api', model: 'gpt', turn_id: 't', prompt: 'SECRET', ...extra }),
    encoding: 'utf8',
    env,
  });
  for (const r of [send('UserPromptSubmit'), send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'SECRET' } }), send('Stop')]) {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
  const file = path.join(home, 'sessions', sessionFileName('cx-1', 'codex'));
  assert.equal(path.basename(file), 'codex-cx-1.jsonl');
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /SECRET/);
  const report = JSON.parse(spawnSync(process.execPath, [cli, 'report', '--json'], { encoding: 'utf8', env }).stdout);
  assert.equal(report.runs, 1);
  assert.deepEqual(report.agents, { codex: 1 });
  fs.rmSync(home, { recursive: true, force: true });
});

test('the copy shared with Claude drops bars, boxes, padding and blank lines', () => {
  const runs = buildRuns([ev('a', 0, 'UserPromptSubmit'), ev('a', 3 * MIN, 'Stop')], { now: 1e15 });
  const stats = computeStats(runs, { now: 1e15 });
  for (const full of [formatReport(stats, { title: 'last 7 days', dataPath: '/d' }), formatRecapText(stats, { title: 'last 7 days' })]) {
    const small = compactForModel(full);
    assert.doesNotMatch(small, /[█░┌┐└┘─│]|\s{2,}|\n\n/);
    assert.ok(small.length < full.length * 0.8, `${small.length} vs ${full.length}`);
  }
  assert.match(compactForModel(formatRecapText(stats, { title: 'x' })), /Agents worked 3m/);
});

test('plural', () => {
  assert.equal(plural(1, 'run'), '1 run');
  assert.equal(plural(2, 'run'), '2 runs');
  assert.equal(plural(2, 'guess', 'guesses'), '2 guesses');
});
