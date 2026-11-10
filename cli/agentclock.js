#!/usr/bin/env node
// Taken at startup (before waiting on stdin), so events are timed close to when the hook fired.
const startedAt = Date.now();

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appendEvent, appendSessionEvent, readEvents, dataDir, writeFile } from '../src/store.js';
import { toEvent } from '../src/events.js';
import { buildRuns, computeStats, units } from '../src/stats.js';
import { formatReport } from '../src/report.js';
import { permissionAudit, formatAudit } from '../src/audit.js';
import { formatRecapText, recapHtml } from '../src/recap.js';
import { liveSessions, formatStatus, todayWallTime } from '../src/live.js';
import { scoreGuesses, formatGuessSummary } from '../src/guess.js';
import { installTo, uninstallFrom, defaultSettingsPath, defaultCodexHooksPath } from '../src/install.js';

const scriptPath = fileURLToPath(import.meta.url);

const HELP = `agentclock: see how much time you spend waiting on your AI coding agents

Usage:
  agentclock [report] [--days N | --all] [--json]   Your stats (default: last 7 days)
  agentclock audit [--days N]                       Which permission prompts cost you the most time
  agentclock recap [--days N]                       A shareable card of your week (text + image)
  agentclock guess                                  Your "guess the run" record
  agentclock status                                 One status line: what your agents are doing now
  agentclock install [--codex] [--settings PATH]    Record Codex (--codex), or Claude Code without the plugin
  agentclock uninstall [--codex] [--settings PATH]  Remove those hooks
  agentclock where                                  Where your data is stored
  agentclock log --event NAME [--agent codex]       Used by the hooks (reads hook JSON on stdin)
`;

function parse(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      days: { type: 'string' },
      all: { type: 'boolean' },
      json: { type: 'boolean' },
      event: { type: 'string' },
      kind: { type: 'string' },
      agent: { type: 'string' },
      codex: { type: 'boolean' },
      settings: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

function readStdin(timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

const str = (v) => (typeof v === 'string' && v ? v : undefined);

async function readJsonStdin() {
  try {
    return JSON.parse(await readStdin()) || {};
  } catch {
    return {};
  }
}

// Called by Claude Code / Codex hooks. Records timing only: never prompts, code, or commands.
// Must never print anything or fail, so it can't affect the agent.
async function logEvent() {
  try {
    const { values } = parse(process.argv.slice(3));
    const input = await readJsonStdin();
    const agent = str(values.agent) === 'codex' ? 'codex' : undefined;
    const evt = toEvent(input, { ts: startedAt, event: str(values.event), kind: str(values.kind), agent, src: agent });
    if (agent) appendSessionEvent(evt);
    else appendEvent(evt);
  } catch {}
  process.exit(0);
}

function range(values, now) {
  const days = values.all ? null : Math.max(1, Math.floor(Number(values.days)) || 7);
  return {
    days,
    since: days ? now - days * units.DAY : 0,
    title: days ? `last ${days} day${days > 1 ? 's' : ''}` : 'all time',
  };
}

function report(values) {
  const now = Date.now();
  const { days, since, title } = range(values, now);
  const stats = computeStats(buildRuns(readEvents(), { now }), { since, now });
  if (values.json) return console.log(JSON.stringify({ days, ...stats }, null, 2));
  console.log(formatReport(stats, { title, dataPath: dataDir() }));
}

function audit(values) {
  const now = Date.now();
  const { since, title } = range(values, now);
  const result = permissionAudit(readEvents(), { since, now });
  if (values.json) return console.log(JSON.stringify(result, null, 2));
  console.log(formatAudit(result, { title }));
}

function recap(values) {
  const now = Date.now();
  const { since, title } = range(values, now);
  const stats = computeStats(buildRuns(readEvents(), { now }), { since, now });
  console.log(formatRecapText(stats, { title }));
  if (stats.runs) {
    const file = writeFile('recap.html', recapHtml(stats, { title }));
    console.log(`\nImage version: open ${file} in a browser and press "Save as PNG".`);
  }
}

function guess(values) {
  const now = Date.now();
  const events = readEvents();
  const summary = scoreGuesses(events, { now });
  if (values.json) return console.log(JSON.stringify(summary, null, 2));
  const typical = computeStats(buildRuns(events, { now }), { since: now - 7 * units.DAY, now }).median;
  console.log(formatGuessSummary(summary, { typical }));
}

// Usable as a Claude Code statusLine command for people not using the plugin.
async function status() {
  const input = await readJsonStdin();
  const now = Date.now();
  const events = readEvents();
  console.log(formatStatus(liveSessions(events, { now }), {
    now,
    currentSession: str(input.session_id),
    todayWall: todayWallTime(events, now),
  }));
}

function target(values) {
  if (values.codex) return { path: str(values.settings) || defaultCodexHooksPath(), agent: 'codex', name: 'Codex' };
  return { path: str(values.settings) || defaultSettingsPath(), agent: 'claude', name: 'Claude Code' };
}

function install(values) {
  const t = target(values);
  const { backup } = installTo(t.path, { scriptPath, agent: t.agent });
  console.log(`Added agentclock hooks to ${t.path}`);
  if (backup) console.log(`Your previous file was backed up to ${backup}`);
  if (t.agent === 'codex') {
    console.log('Codex asks you to trust new hooks: start Codex, run /hooks, and trust the agentclock ones.');
    console.log('After that, Codex sessions show up in your stats and in the Claude Code status line.');
  } else {
    console.log('Start a new Claude Code session and work as usual. Run "agentclock" any time to see your stats.');
  }
}

function uninstall(values) {
  const t = target(values);
  const { changed, backup } = uninstallFrom(t.path);
  if (!changed) return console.log(`No file at ${t.path}. Nothing to remove.`);
  console.log(`Removed agentclock hooks from ${t.path} (backup: ${backup})`);
  console.log(`Your recorded data is still in ${dataDir()}. Delete it if you don't want it.`);
}

async function main() {
  if (process.argv[2] === 'log') return logEvent();
  const { values, positionals } = parse(process.argv.slice(2));
  const cmd = positionals[0] ?? 'report';
  if (values.help || cmd === 'help') return console.log(HELP);
  try {
    switch (cmd) {
      case 'report': return report(values);
      case 'audit': return audit(values);
      case 'recap': return recap(values);
      case 'guess': return guess(values);
      case 'status': return await status();
      case 'install': return install(values);
      case 'uninstall': return uninstall(values);
      case 'where': return console.log(dataDir());
      default:
        console.error(`Unknown command: ${cmd}\n\n${HELP}`);
        process.exitCode = 1;
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

main();
