import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEvent, suggestedRule, mergeSources, parseLines, toLines, sessionFileName } from '../src/events.js';
import { buildRuns, units } from '../src/stats.js';
import { permissionAudit, formatAudit, isSafeRule } from '../src/audit.js';
import { liveSessions, formatStatus, todayWallTime, startOfDay } from '../src/live.js';
import { formatRecapText, recapHtml } from '../src/recap.js';
import { computeStats } from '../src/stats.js';

const { SEC, MIN, HOUR } = units;
const ev = (session, ts, event, extra = {}) => ({ ts, event, session, project: 'app', ...extra });

// ---------- events ----------

test('toEvent keeps timing and the suggested rule, never the command', () => {
  const e = toEvent({
    hook_event_name: 'PermissionRequest',
    session_id: 's1',
    cwd: 'C:\\work\\shop-api',
    tool_name: 'Bash',
    tool_input: { command: 'npm test -- --secret-flag' },
    permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }],
  }, { ts: 5, src: 'plugin' });
  assert.deepEqual(e, { ts: 5, event: 'PermissionRequest', session: 's1', project: 'shop-api', tool: 'Bash', rule: 'Bash(npm test:*)', src: 'plugin' });
  assert.doesNotMatch(JSON.stringify(e), /secret/);
});

test('suggestedRule ignores non-allow suggestions and other events', () => {
  assert.equal(suggestedRule({ hook_event_name: 'PermissionRequest', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits' }] }), undefined);
  assert.equal(suggestedRule({ hook_event_name: 'PermissionRequest', permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'WebFetch' }] }] }), 'WebFetch');
  assert.equal(suggestedRule({ hook_event_name: 'PreToolUse', permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash' }] }] }), undefined);
});

test('when the plugin and settings hooks both recorded a session, only the plugin copy counts', () => {
  const events = [
    ev('a', 0, 'UserPromptSubmit', { src: 'hook' }),
    ev('a', 1, 'UserPromptSubmit', { src: 'plugin' }),
    ev('b', 2, 'UserPromptSubmit', { src: 'hook' }),
  ];
  assert.deepEqual(mergeSources(events).map((e) => `${e.session}:${e.src}`), ['a:plugin', 'b:hook']);
});

test('lines round-trip and bad lines are skipped', () => {
  const events = [ev('a', 1, 'Stop'), ev('a', 2, 'Stop')];
  assert.deepEqual(parseLines(toLines(events) + '{"half', 'plugin').map((e) => e.ts), [1, 2]);
  assert.equal(sessionFileName('../../etc/passwd'), '______etc_passwd.jsonl');
});

test('PermissionRequest starts the waiting clock (it fires before the 6s-late notification)', () => {
  const [run] = buildRuns([
    ev('a', 0, 'UserPromptSubmit'),
    ev('a', 10 * SEC, 'PermissionRequest', { rule: 'Bash(npm test:*)' }),
    ev('a', 16 * SEC, 'Notification', { kind: 'permission_prompt' }),
    ev('a', 40 * SEC, 'PostToolUse'),
    ev('a', 50 * SEC, 'Stop'),
  ], { now: 1e15 });
  assert.equal(run.blocks, 1);
  assert.equal(run.blocked, 30 * SEC);
});

// ---------- audit ----------

function promptEvents() {
  const out = [];
  let t = 0;
  const ask = (rule, wait, session = 'a') => {
    out.push(ev(session, t, 'PermissionRequest', { rule, tool: rule.split('(')[0] }));
    out.push(ev(session, t + wait, 'Notification', { kind: 'permission_prompt' }));
    out.push(ev(session, t + wait, 'PostToolUse'));
    t += wait + 10 * SEC;
  };
  for (let i = 0; i < 5; i++) ask('Bash(git status:*)', 20 * SEC);
  for (let i = 0; i < 3; i++) ask('Bash(git push:*)', 60 * SEC);
  ask('WebFetch(domain:docs.python.org)', 5 * SEC);
  return out;
}

test('audit counts prompts per rule and how long you took to answer', () => {
  const a = permissionAudit(promptEvents());
  assert.equal(a.total, 9);
  assert.equal(a.totalWait, 5 * 20 * SEC + 3 * 60 * SEC + 5 * SEC);
  assert.deepEqual(a.rows.map((r) => [r.key, r.count]), [
    ['Bash(git status:*)', 5],
    ['Bash(git push:*)', 3],
    ['WebFetch(domain:docs.python.org)', 1],
  ]);
  assert.deepEqual(a.suggestions, ['Bash(git status:*)']);
  assert.deepEqual(a.risky, ['Bash(git push:*)']);
});

test('audit text lists rules ready to paste', () => {
  const text = formatAudit(permissionAudit(promptEvents()), { title: 'last 7 days' });
  assert.match(text, /9 prompts/);
  assert.match(text, /"Bash\(git status:\*\)"/);
  assert.match(text, /risky to allow without asking: Bash\(git push:\*\)/);
  assert.match(formatAudit(permissionAudit([]), { title: 'x' }), /No permission prompts/);
});

test('risky or blanket rules are never suggested', () => {
  for (const rule of ['Bash', 'Bash(*)', 'Bash(rm -rf:*)', 'Bash(sudo apt:*)', 'Bash(curl:*)', 'Bash(git push:*)']) {
    assert.equal(isSafeRule(rule), false, rule);
  }
  for (const rule of ['Bash(npm test:*)', 'Bash(git status:*)', 'WebFetch(domain:docs.python.org)', 'Read']) {
    assert.equal(isSafeRule(rule), true, rule);
  }
});

// ---------- live status ----------

test('live sessions: working, waiting on you, done, and stale ones dropped', () => {
  const now = 10 * HOUR;
  const live = liveSessions([
    ev('w', now - 2 * MIN, 'UserPromptSubmit', { project: 'web' }),
    ev('w', now - 1 * MIN, 'PostToolUse', { project: 'web' }),
    ev('p', now - 5 * MIN, 'UserPromptSubmit', { project: 'api' }),
    ev('p', now - 3 * MIN, 'PermissionRequest', { project: 'api' }),
    ev('d', now - 20 * MIN, 'UserPromptSubmit', { project: 'docs' }),
    ev('d', now - 4 * MIN, 'Stop', { project: 'docs' }),
    ev('old', now - 2 * HOUR, 'UserPromptSubmit'),
    ev('old', now - 90 * MIN, 'Stop'), // finished too long ago
    ev('gone', now - 5 * MIN, 'UserPromptSubmit'),
    ev('gone', now - 4 * MIN, 'SessionEnd'),
    ev('stale', now - 5 * HOUR, 'UserPromptSubmit'), // no news for hours
  ], { now });
  assert.deepEqual(live.map((s) => [s.session, s.state]).sort(), [['d', 'done'], ['p', 'waiting'], ['w', 'working']]);
});

test('answering the prompt moves a session back to working', () => {
  const now = 1 * HOUR;
  const [s] = liveSessions([
    ev('p', now - 5 * MIN, 'UserPromptSubmit'),
    ev('p', now - 3 * MIN, 'PermissionRequest'),
    ev('p', now - 1 * MIN, 'PostToolUse'),
  ], { now });
  assert.equal(s.state, 'working');
});

test('status line shows other sessions and leaves out your own', () => {
  const now = 10 * HOUR;
  const sessions = [
    { session: 'me', project: 'mine', state: 'working', since: now - MIN },
    { session: 'p', project: 'api', state: 'waiting', since: now - 3 * MIN },
    { session: 'd', project: 'docs', state: 'done', since: now - 4 * MIN },
    { session: 'w', project: 'web', state: 'working', since: now - 2 * MIN },
  ];
  assert.equal(
    formatStatus(sessions, { now, currentSession: 'me', todayWall: 2 * HOUR + 10 * MIN + 30 * SEC }),
    'agentclock · other agents: waiting on you: api 3m · done: docs 4m · 1 working · today 2h 10m with agents',
  );
  assert.equal(formatStatus([sessions[0]], { now, currentSession: 'me' }), 'agentclock');
});

test('today counts only time since midnight, without double counting parallel runs', () => {
  const now = startOfDay(Date.UTC(2026, 10, 11, 12)) + 12 * HOUR; // local noon
  const midnight = startOfDay(now);
  const wall = todayWallTime([
    ev('a', midnight - 30 * MIN, 'UserPromptSubmit'), // started yesterday
    ev('a', midnight + 30 * MIN, 'Stop'),
    ev('b', midnight + 60 * MIN, 'UserPromptSubmit'),
    ev('b', midnight + 120 * MIN, 'Stop'),
    ev('c', midnight + 90 * MIN, 'UserPromptSubmit'), // overlaps b
    ev('c', midnight + 150 * MIN, 'Stop'),
  ], now);
  assert.equal(wall, 30 * MIN + 90 * MIN);
});

// ---------- recap ----------

test('recap card has the week in numbers and no project names', () => {
  const runs = buildRuns([
    ev('a', 0, 'UserPromptSubmit', { project: 'client-secret-project' }),
    ev('a', 10 * MIN, 'Stop', { project: 'client-secret-project' }),
    ev('b', 5 * MIN, 'UserPromptSubmit', { project: 'client-secret-project' }),
    ev('b', 20 * MIN, 'Stop', { project: 'client-secret-project' }),
  ], { now: 1e15 });
  const stats = computeStats(runs, { now: 1e15 });
  const text = formatRecapText(stats, { title: 'last 7 days' });
  const html = recapHtml(stats, { title: 'last 7 days' });
  assert.match(text, /Agents worked\s+25m/);
  assert.match(text, /Most agents at once\s+2/);
  assert.match(html, /<svg[^>]+xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(html, /Save as PNG/);
  for (const out of [text, html]) assert.doesNotMatch(out, /client-secret-project/);
  const [heading, ...box] = text.split('\n');
  assert.equal(heading, 'agentclock · recap · last 7 days');
  const widths = new Set(box.map((l) => [...l].length));
  assert.equal(widths.size, 1, 'every line of the card has the same width');
  assert.match(text, /2 runs · measured/);
});
