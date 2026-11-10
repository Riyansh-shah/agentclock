import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../cli/agentclock.js', import.meta.url));
const MIN = 60_000;

function run(args, home, input) {
  return spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', env: { ...process.env, AGENTCLOCK_HOME: home } });
}

test('the CLI reads what the plugin wrote, and the new commands work', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentclock-plugin-'));
  const now = Date.now();
  const lines = [];
  const add = (session, ts, event, extra = {}) => lines.push({ ts, event, session, project: 'shop-api', src: 'plugin', ...extra });
  for (let i = 0; i < 4; i++) {
    const t = now - 60 * MIN + i * 10 * MIN;
    add('p1', t, 'UserPromptSubmit');
    add('p1', t + MIN, 'PermissionRequest', { tool: 'Bash', rule: 'Bash(npm test:*)' });
    add('p1', t + 2 * MIN, 'PostToolUse', { tool: 'Bash' });
    add('p1', t + 3 * MIN, 'Stop');
  }
  add('p2', now - 2 * MIN, 'UserPromptSubmit', { project: 'web' });
  add('p2', now - MIN, 'PermissionRequest', { project: 'web', tool: 'Bash' });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', 'p1.jsonl'), lines.filter((l) => l.session === 'p1').map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(home, 'sessions', 'p2.jsonl'), lines.filter((l) => l.session === 'p2').map((l) => JSON.stringify(l)).join('\n') + '\n');

  const report = JSON.parse(run(['report', '--json'], home).stdout);
  assert.equal(report.runs, 4);
  assert.equal(report.blocks, 4);

  const audit = run(['audit'], home).stdout;
  assert.match(audit, /5 prompts/);
  assert.match(audit, /"Bash\(npm test:\*\)"/);

  const recap = run(['recap'], home).stdout;
  assert.match(recap, /My AI agents · last 7 days/);
  assert.ok(fs.existsSync(path.join(home, 'recap.html')));

  const status = run(['status'], home, JSON.stringify({ session_id: 'p1' })).stdout.trim();
  assert.match(status, /^agentclock · other agents: waiting on you: web 1m/);

  fs.rmSync(home, { recursive: true, force: true });
});
