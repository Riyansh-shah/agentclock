// Where agentclock keeps its data (CLI side; the plugin uses the same layout):
//   ~/.agentclock/events.jsonl                 Claude Code settings hooks (`agentclock install`)
//   ~/.agentclock/sessions/<id>.jsonl          the Claude Code plugin, one file per session
//   ~/.agentclock/sessions/codex-<id>.jsonl    Codex hooks (`agentclock install --codex`)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLines, mergeSources, sessionFileName } from './events.js';

export function dataDir() {
  return process.env.AGENTCLOCK_HOME || path.join(os.homedir(), '.agentclock');
}

export function eventsFile() {
  return path.join(dataDir(), 'events.jsonl');
}

export function sessionsDir() {
  return path.join(dataDir(), 'sessions');
}

export function appendEvent(evt) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.appendFileSync(eventsFile(), JSON.stringify(evt) + '\n');
}

/** Codex sessions go to their own file, so the Claude Code status line sees them too. */
export function appendSessionEvent(evt) {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.appendFileSync(path.join(sessionsDir(), sessionFileName(evt.session, evt.agent)), JSON.stringify(evt) + '\n');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function readEvents() {
  const events = parseLines(readText(eventsFile()), 'hook');
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir()).filter((n) => n.endsWith('.jsonl'));
  } catch {
    // no plugin data yet
  }
  for (const name of names) events.push(...parseLines(readText(path.join(sessionsDir(), name)), 'plugin'));
  return mergeSources(events);
}

export function writeFile(name, text) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = path.join(dataDir(), name);
  fs.writeFileSync(file, text);
  return file;
}
