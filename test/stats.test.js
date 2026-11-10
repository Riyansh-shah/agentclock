import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuns, computeStats, units } from '../src/stats.js';

const { SEC, MIN, HOUR } = units;
const FAR_FUTURE = 1e15;
const ev = (session, ts, event, extra = {}) => ({ ts, event, session, project: 'app', ...extra });

test('a prompt followed by a stop is one run', () => {
  const runs = buildRuns([
    ev('a', 0, 'UserPromptSubmit'),
    ev('a', 10 * SEC, 'PostToolUse', { tool: 'Edit' }),
    ev('a', 20 * SEC, 'PostToolUseFailure', { tool: 'Bash' }),
    ev('a', 90 * SEC, 'Stop'),
  ], { now: FAR_FUTURE });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].duration, 90 * SEC);
  assert.equal(runs[0].tools, 2);
  assert.equal(runs[0].ending, 'stop');
});

test('time sitting on a permission prompt counts as waiting on you', () => {
  const [run] = buildRuns([
    ev('a', 0, 'UserPromptSubmit'),
    ev('a', 20 * SEC, 'Notification', { kind: 'permission_prompt' }),
    ev('a', 80 * SEC, 'PostToolUse'),
    ev('a', 100 * SEC, 'Stop'),
  ], { now: FAR_FUTURE });
  assert.equal(run.blocks, 1);
  assert.equal(run.blocked, 60 * SEC);
  assert.equal(run.duration, 100 * SEC);
});

test('comeback is the gap between a stop and your next prompt', () => {
  const runs = buildRuns([
    ev('a', 0, 'UserPromptSubmit'),
    ev('a', 1 * MIN, 'Stop'),
    ev('a', 4 * MIN, 'UserPromptSubmit'),
    ev('a', 5 * MIN, 'Stop'),
    ev('a', 5 * MIN + 4 * HOUR, 'UserPromptSubmit'), // came back next morning: not counted
    ev('a', 5 * MIN + 4 * HOUR + 30 * SEC, 'Stop'),
  ], { now: FAR_FUTURE });
  assert.deepEqual(runs.map((r) => r.comeback), [null, 3 * MIN, null]);
});

test('a new prompt with no stop marks the previous run interrupted', () => {
  const runs = buildRuns([
    ev('a', 0, 'UserPromptSubmit'),
    ev('a', 30 * SEC, 'PostToolUse'),
    ev('a', 50 * SEC, 'UserPromptSubmit'),
    ev('a', 70 * SEC, 'Stop'),
  ], { now: FAR_FUTURE });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].ending, 'interrupted');
  assert.equal(runs[0].duration, 30 * SEC);
  assert.equal(runs[1].duration, 20 * SEC);
  assert.equal(runs[1].comeback, null);
});

test('interrupting while a permission prompt is open counts the wait up to the new prompt', () => {
  const [run] = buildRuns([
    ev('a', 0, 'UserPromptSubmit'),
    ev('a', 10 * SEC, 'Notification', { kind: 'permission_prompt' }),
    ev('a', 70 * SEC, 'UserPromptSubmit'),
  ], { now: 80 * SEC });
  assert.equal(run.ending, 'interrupted');
  assert.equal(run.duration, 70 * SEC);
  assert.equal(run.blocked, 60 * SEC);
});

test('idle notifications after a run finished are ignored', () => {
  const runs = buildRuns([
    ev('a', 0, 'UserPromptSubmit'),
    ev('a', 30 * SEC, 'Stop'),
    ev('a', 90 * SEC, 'Notification', { kind: 'idle_prompt' }),
  ], { now: FAR_FUTURE });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].duration, 30 * SEC);
});

test('a run still in progress is left out; a stale unfinished one counts as interrupted', () => {
  const now = 10 * HOUR;
  const runs = buildRuns([
    ev('old', now - 5 * HOUR, 'UserPromptSubmit'),
    ev('old', now - 5 * HOUR + 1 * MIN, 'PostToolUse'),
    ev('live', now - 1 * MIN, 'UserPromptSubmit'),
  ], { now });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].session, 'old');
  assert.equal(runs[0].ending, 'interrupted');
  assert.equal(runs[0].duration, 1 * MIN);
});

test('session end closes an open run and resets comeback', () => {
  const runs = buildRuns([
    ev('a', 0, 'UserPromptSubmit'),
    ev('a', 10 * SEC, 'Stop'),
    ev('a', 20 * SEC, 'SessionEnd'),
    ev('a', 60 * SEC, 'UserPromptSubmit'),
    ev('a', 70 * SEC, 'Stop'),
  ], { now: FAR_FUTURE });
  assert.equal(runs[1].comeback, null);
});

test('an API error ends the run', () => {
  const [run] = buildRuns([
    ev('a', 0, 'UserPromptSubmit'),
    ev('a', 15 * SEC, 'StopFailure'),
  ], { now: FAR_FUTURE });
  assert.equal(run.ending, 'error');
  assert.equal(run.duration, 15 * SEC);
});

test('parallel agents across sessions', () => {
  const runs = buildRuns([
    ev('a', 0, 'UserPromptSubmit'),
    ev('a', 10 * MIN, 'Stop'),
    ev('b', 5 * MIN, 'UserPromptSubmit'),
    ev('b', 20 * MIN, 'Stop'),
  ], { now: FAR_FUTURE });
  const s = computeStats(runs, { now: FAR_FUTURE });
  assert.equal(s.parallel.max, 2);
  assert.equal(s.agentTime, 25 * MIN);
  assert.equal(s.wallTime, 20 * MIN);
  assert.equal(s.parallel.share, 0.25);
});

test('summary numbers: buckets, median, 90th percentile, slow comebacks', () => {
  const lengths = [10 * SEC, 1 * MIN, 5 * MIN, 15 * MIN, 40 * MIN];
  const events = [];
  let t = 0;
  for (const len of lengths) {
    events.push(ev('a', t, 'UserPromptSubmit'), ev('a', t + len, 'Stop'));
    t += len + 6 * MIN; // you come back 6 minutes after each run
  }
  const s = computeStats(buildRuns(events, { now: FAR_FUTURE }), { now: FAR_FUTURE });
  assert.equal(s.runs, 5);
  assert.deepEqual(s.buckets.map((b) => b.count), [1, 1, 1, 1, 1]);
  assert.equal(s.median, 5 * MIN);
  assert.equal(s.p90, 40 * MIN);
  assert.equal(s.longest, 40 * MIN);
  assert.equal(s.comeback.count, 4);
  assert.equal(s.comeback.median, 6 * MIN);
  assert.equal(s.comeback.slowShare, 1);
});

test('since filter only keeps recent runs', () => {
  const runs = buildRuns([
    ev('a', 0, 'UserPromptSubmit'),
    ev('a', 1 * MIN, 'Stop'),
    ev('b', 2 * HOUR, 'UserPromptSubmit'),
    ev('b', 2 * HOUR + 1 * MIN, 'Stop'),
  ], { now: FAR_FUTURE });
  assert.equal(computeStats(runs, { since: 1 * HOUR, now: FAR_FUTURE }).runs, 1);
});

test('empty data gives zeroed stats', () => {
  const s = computeStats([], { now: FAR_FUTURE });
  assert.equal(s.runs, 0);
  assert.equal(s.median, null);
  assert.equal(s.parallel.max, 0);
});
