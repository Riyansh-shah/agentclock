import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK = 'agentclock';

// The Claude Code hook events agentclock listens to. All run async, so they
// never slow the agent down.
export const HOOKS = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'PostToolUseFailure', matcher: '*' },
  { event: 'PermissionRequest', matcher: '*' },
  { event: 'Notification', matcher: 'permission_prompt', kind: 'permission_prompt' },
  { event: 'Notification', matcher: 'idle_prompt', kind: 'idle_prompt' },
  { event: 'Stop' },
  { event: 'StopFailure' },
  { event: 'SessionEnd' },
];

// Codex hooks (~/.codex/hooks.json). Codex has no Notification event, and
// sends Interrupt when you press Esc.
export const CODEX_HOOKS = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'PermissionRequest', matcher: '*' },
  { event: 'Stop' },
  { event: 'Interrupt' },
  { event: 'SessionEnd' },
];

export function defaultSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export function defaultCodexHooksPath() {
  return path.join(os.homedir(), '.codex', 'hooks.json');
}

export function hookCommand(event, kind, { scriptPath, nodePath = process.execPath, agent }) {
  const quote = (p) => `"${p.replace(/\\/g, '/')}"`;
  const extra = `${kind ? ` --kind ${kind}` : ''}${agent && agent !== 'claude' ? ` --agent ${agent}` : ''}`;
  return `${quote(nodePath)} ${quote(scriptPath)} log --event ${event}${extra}`;
}

const isOurs = (handler) => typeof handler?.command === 'string' && handler.command.includes(MARK);

/** Return a copy of settings with every agentclock hook removed and everything else untouched. */
export function removeHooks(settings) {
  const out = structuredClone(settings ?? {});
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const handlers = group.hooks.filter((h) => !isOurs(h));
      if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length) out.hooks[event] = kept;
    else delete out.hooks[event];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

/**
 * Return a copy of settings with agentclock's hooks added (replacing any older
 * copies). `opts.agent: 'codex'` writes the Codex set instead (same file shape).
 */
export function addHooks(settings, opts) {
  const isCodex = opts.agent === 'codex';
  const out = removeHooks(settings);
  out.hooks ??= {};
  for (const h of isCodex ? CODEX_HOOKS : HOOKS) {
    const handler = { type: 'command', command: hookCommand(h.event, h.kind, opts), async: true };
    // Codex caps SessionEnd/Interrupt hooks at 3s, so let it use its own defaults.
    if (!isCodex) handler.timeout = 10;
    const group = h.matcher ? { matcher: h.matcher, hooks: [handler] } : { hooks: [handler] };
    (out.hooks[h.event] ??= []).push(group);
  }
  return out;
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return { text: null, settings: {} };
  const text = fs.readFileSync(settingsPath, 'utf8');
  const clean = text.replace(/^﻿/, '');
  try {
    return { text, settings: clean.trim() ? JSON.parse(clean) : {} };
  } catch (e) {
    throw new Error(`Couldn't read ${settingsPath} (${e.message}). Leaving it unchanged.`);
  }
}

function writeSettings(settingsPath, text, next) {
  let backup = null;
  if (text != null) {
    backup = `${settingsPath}.agentclock-backup`;
    fs.writeFileSync(backup, text);
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n');
  return { backup };
}

export function installTo(settingsPath, opts) {
  const { text, settings } = readSettings(settingsPath);
  return writeSettings(settingsPath, text, addHooks(settings, opts));
}

export function uninstallFrom(settingsPath) {
  const { text, settings } = readSettings(settingsPath);
  if (text == null) return { backup: null, changed: false };
  return { ...writeSettings(settingsPath, text, removeHooks(settings)), changed: true };
}
