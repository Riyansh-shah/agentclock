import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addHooks, removeHooks, installTo, uninstallFrom, HOOKS } from '../src/install.js';

const opts = { scriptPath: 'C:\\tools\\agentclock\\bin\\agentclock.js', nodePath: 'C:\\Program Files\\nodejs\\node.exe' };

const userSettings = {
  model: 'opus',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] }],
  },
};

const countOurs = (settings) =>
  Object.values(settings.hooks ?? {}).flat().flatMap((g) => g.hooks).filter((h) => h.command.includes('agentclock')).length;

test('adds one hook per event and keeps the user\'s own settings and hooks', () => {
  const next = addHooks(userSettings, opts);
  assert.equal(next.model, 'opus');
  assert.equal(countOurs(next), HOOKS.length);
  assert.ok(next.hooks.Stop.some((g) => g.hooks[0].command === 'say done'));
  assert.ok(next.hooks.PreToolUse.some((g) => g.hooks[0].command === 'my-guard.sh'));
  const ours = next.hooks.Stop.find((g) => g.hooks[0].command.includes('agentclock')).hooks[0];
  assert.equal(ours.command, '"C:/Program Files/nodejs/node.exe" "C:/tools/agentclock/bin/agentclock.js" log --event Stop');
  assert.equal(ours.async, true);
  const permission = next.hooks.Notification.find((g) => g.matcher === 'permission_prompt');
  assert.match(permission.hooks[0].command, /--event Notification --kind permission_prompt$/);
});

test('installing twice does not duplicate hooks', () => {
  assert.equal(countOurs(addHooks(addHooks(userSettings, opts), opts)), HOOKS.length);
});

test('removing restores the original settings exactly', () => {
  assert.deepEqual(removeHooks(addHooks(userSettings, opts)), userSettings);
  assert.deepEqual(removeHooks(addHooks({}, opts)), {});
});

test('install and uninstall on disk, with a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentclock-'));
  const file = path.join(dir, 'settings.json');
  const original = JSON.stringify(userSettings, null, 2);
  fs.writeFileSync(file, original);

  const { backup } = installTo(file, opts);
  assert.equal(fs.readFileSync(backup, 'utf8'), original);
  assert.equal(countOurs(JSON.parse(fs.readFileSync(file, 'utf8'))), HOOKS.length);

  uninstallFrom(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), userSettings);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses to touch a settings file it cannot parse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentclock-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => installTo(file, opts), /Leaving it unchanged/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  fs.rmSync(dir, { recursive: true, force: true });
});
