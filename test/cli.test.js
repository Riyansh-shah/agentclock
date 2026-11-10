import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../cli/agentclock.js', import.meta.url));

function run(args, { input, home }) {
  return spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, AGENTCLOCK_HOME: home },
  });
}

test('hook logging is silent, records timing only, and shows up in the report', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentclock-home-'));
  const base = { session_id: 's1', cwd: '/work/my-app', transcript_path: '/secret/t.jsonl' };

  const steps = [
    [['log', '--event', 'UserPromptSubmit'], { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'TOP SECRET PROMPT' }],
    [['log', '--event', 'PostToolUse'], { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf secret' } }],
    [['log', '--event', 'Stop'], { ...base, hook_event_name: 'Stop', last_assistant_message: 'secret answer' }],
  ];
  for (const [args, payload] of steps) {
    const r = run(args, { input: JSON.stringify(payload), home });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'hooks must not print (stdout can reach the model)');
  }

  const raw = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /SECRET|secret/i, 'no prompt, command, path or answer content is stored');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ['UserPromptSubmit', 'PostToolUse', 'Stop']);
  assert.equal(lines[0].project, 'my-app');
  assert.equal(lines[1].tool, 'Bash');

  const report = JSON.parse(run(['report', '--json'], { home }).stdout);
  assert.equal(report.runs, 1);
  assert.equal(report.toolsMedian, 1);

  const text = run([], { home }).stdout;
  assert.match(text, /Agent runs\s+1/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('logging never fails, even with garbage input', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentclock-home-'));
  const r = run(['log', '--event', 'Stop'], { input: 'not json at all', home });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('empty report explains what to do', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentclock-home-'));
  assert.match(run([], { home }).stdout, /No finished agent runs yet/);
  fs.rmSync(home, { recursive: true, force: true });
});
