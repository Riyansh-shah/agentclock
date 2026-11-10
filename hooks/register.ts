// agentclock as a Claude Code plugin.
//
// - Records timing events from Claude Code's own hook events (no prompts, code,
//   commands or answers), one file per session in ~/.agentclock/sessions/.
// - Shows a status line entry: what your agents in other sessions are doing now.
// - Optional nudge: one notification when an agent has waited on you a while.
// - Commands: /agentclock, /agentclock-audit, /agentclock-recap,
//   /agentclock-guess, /agentclock-codex.
//
// The logic lives in ../src (plain JavaScript shared with the CLI).
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { mergeSources, parseLines, sessionFileName, toEvent, toLines } from '../src/events.js'
import { buildRuns, computeStats, units } from '../src/stats.js'
import { compactForModel, fmt, formatReport } from '../src/report.js'
import { formatStatus, liveSessions, startOfDay, todayWallTime } from '../src/live.js'
import { formatAudit, permissionAudit } from '../src/audit.js'
import { formatRecapText, recapHtml } from '../src/recap.js'
import { formatGuessResult, formatGuessSummary, parseDuration, scoreGuesses } from '../src/guess.js'
import { isValidTopic, nudgeFor } from '../src/nudge.js'

type Engine = EngineInterface
type Timer = ReturnType<Engine['clock']['after']>
type AgentEvent = { ts: number; event: string; session: string; project?: string; src?: string; ms?: number }

const MAX_READ = 4 * 1024 * 1024 // $.fs.read refuses files over 4 MiB
const TICK_MS = 10_000
const BATCH_MS = 2_000
// The status line depends on these, so they're written right away; tool events are batched.
const URGENT = new Set(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'])

// Module state. A hot reload starts it over; the data on disk stays.
let dir: string | undefined
let sep = '/'
let current: string | undefined
let shown: string | undefined
let batch: Timer | undefined
let writing: Promise<void> = Promise.resolve()
const loaded = new Map<string, Promise<AgentEvent[]>>() // this process's sessions
const dirty = new Set<string>()
const cache = new Map<string, { mtimeMs: number; size: number; events: AgentEvent[] }>()
const nudged = new Set<string>()
let nudgeOn = false
let nudgeAfter = 5 * units.MIN
let ntfyTopic: string | undefined

const join = (...parts: string[]) => parts.join(sep)
// Claude Code already puts "agentclock:" in front of a command's output.
const tidy = (text: string) => text.replace(/^agentclock · /, '')

// Token budget: reports are shown to you with $.ui.log, which never reaches the
// model, so a command costs Claude nothing beyond the "/agentclock" line itself.
// Add "share" to a command to hand Claude a compact copy (e.g. "add these rules").
const SHARE = /(^|\s)share(?=\s|$)/i
const splitShare = (args: string) => ({ share: SHARE.test(args), rest: args.replace(SHARE, ' ').trim() })

function present($: Engine, text: string, share: boolean) {
  if (share) return { text: compactForModel(tidy(text)) }
  $.ui.log(text)
  return {}
}

function configure(options: PluginOptions): void {
  nudgeOn = options.nudge === true
  const minutes = Number(options.nudge_minutes)
  nudgeAfter = (minutes >= 1 ? minutes : 5) * units.MIN
  const topic = typeof options.ntfy_topic === 'string' ? options.ntfy_topic.trim() : ''
  ntfyTopic = isValidTopic(topic) ? topic : undefined
}

async function dataDir($: Engine): Promise<string | undefined> {
  if (dir) return dir
  const custom = await $.env.get('AGENTCLOCK_HOME')
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  const base = custom || (home ? `${home.replace(/[\\/]+$/, '')}${home.includes('\\') ? '\\' : '/'}.agentclock` : undefined)
  if (base) {
    sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
    dir = base
  }
  return dir
}

async function readText($: Engine, path: string): Promise<string> {
  const text = await $.fs.read(path).catch(() => '')
  return typeof text === 'string' ? text : ''
}

async function loadSession($: Engine, root: string, session: string): Promise<AgentEvent[]> {
  return parseLines(await readText($, join(root, 'sessions', sessionFileName(session))), 'plugin') as AgentEvent[]
}

function sessionEvents($: Engine, root: string, session: string): Promise<AgentEvent[]> {
  let events = loaded.get(session)
  if (!events) {
    events = loadSession($, root, session)
    loaded.set(session, events)
  }
  return events
}

async function writeDirty($: Engine): Promise<void> {
  const root = await dataDir($)
  if (!root) return
  for (const session of [...dirty]) {
    dirty.delete(session)
    const events = await loaded.get(session)
    if (events) await $.fs.write(join(root, 'sessions', sessionFileName(session)), toLines(events))
  }
}

function flush($: Engine): Promise<void> {
  writing = writing.then(() => writeDirty($)).catch(() => {})
  return writing
}

async function flushAndRefresh($: Engine): Promise<void> {
  await flush($)
  await refresh($)
}

function schedule($: Engine, isUrgent: boolean): void {
  if (isUrgent) {
    batch?.cancel()
    batch = undefined
    $.clock.after(1, () => void flushAndRefresh($))
  } else if (!batch) {
    batch = $.clock.after(BATCH_MS, () => {
      batch = undefined
      void flush($)
    })
  }
}

async function record($: Engine, input: unknown, event: string): Promise<void> {
  try {
    const root = await dataDir($)
    if (!root) return
    const evt = toEvent(input, { ts: await $.clock.now(), src: 'plugin', event }) as AgentEvent
    if (evt.session === 'unknown') return
    current = evt.session
    const events = await sessionEvents($, root, evt.session)
    events.push(evt)
    dirty.add(evt.session)
    if (evt.event === 'SessionEnd') {
      await flush($) // the process may be about to exit
      return
    }
    schedule($, URGENT.has(evt.event))
    if ((evt.event === 'Stop' || evt.event === 'StopFailure') && events.some(e => e.event === 'Guess')) {
      $.clock.after(1, () => void announceGuess($, evt.ts))
    }
  } catch {
    // never get in the agent's way
  }
}

async function readSessions($: Engine, root: string, since = 0): Promise<AgentEvent[]> {
  const entries = await $.fs.list(join(root, 'sessions')).catch(() => [])
  const out: AgentEvent[] = []
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.jsonl') || f.mtimeMs < since || f.size > MAX_READ) continue
    const hit = cache.get(f.name)
    if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) {
      out.push(...hit.events)
      continue
    }
    const events = parseLines(await readText($, join(root, 'sessions', f.name)), 'plugin') as AgentEvent[]
    cache.set(f.name, { mtimeMs: f.mtimeMs, size: f.size, events })
    out.push(...events)
  }
  return out
}

/** Everything on disk, with this session's newest events from memory. */
async function readAll($: Engine): Promise<{ events: AgentEvent[]; note: string }> {
  const root = await dataDir($)
  if (!root) return { events: [], note: '\n\n  (agentclock could not find your home folder.)' }
  const mine = current ? await loaded.get(current) : undefined
  const events = (await readSessions($, root)).filter(e => !mine || e.session !== current)
  if (mine) events.push(...mine)
  let note = ''
  const legacy = join(root, 'events.jsonl')
  const stat = await $.fs.stat(legacy).catch(() => undefined)
  if (stat && stat.size > MAX_READ) note = `\n\n  (${legacy} is too large to read here; run the agentclock CLI for full history.)`
  else if (stat) events.push(...(parseLines(await readText($, legacy), 'hook') as AgentEvent[]))
  return { events: mergeSources(events) as AgentEvent[], note }
}

async function refresh($: Engine): Promise<void> {
  try {
    const root = await dataDir($)
    if (!root) return
    const now = await $.clock.now()
    const events = await readSessions($, root, Math.min(startOfDay(now), now - 3 * units.HOUR))
    const text = formatStatus(liveSessions(events, { now }), {
      now,
      currentSession: current,
      todayWall: todayWallTime(events, now),
    })
    if (text !== shown) {
      shown = text
      $.ui.status(text)
    }
  } catch {
    // the status line is best effort
  }
}

async function checkNudge($: Engine): Promise<void> {
  if (!nudgeOn || !current) return
  try {
    const events = await loaded.get(current)
    if (!events) return
    const nudge = nudgeFor(events, { now: await $.clock.now(), after: nudgeAfter, session: current })
    if (!nudge || nudged.has(nudge.key)) return
    nudged.add(nudge.key)
    await $.ui.notify(nudge.text, { title: 'agentclock' }).catch(() => undefined)
    if (ntfyTopic) {
      await $.http
        .fetch(`https://ntfy.sh/${ntfyTopic}`, { method: 'POST', body: nudge.text, headers: { Title: 'agentclock' } })
        .catch(() => undefined)
    }
  } catch {
    // a missed nudge is fine
  }
}

async function tick($: Engine): Promise<void> {
  await refresh($)
  await checkNudge($)
}

async function announceGuess($: Engine, end: number): Promise<void> {
  try {
    const { events } = await readAll($)
    const summary = scoreGuesses(events, { now: end })
    const result = summary.results.find(r => r.end === end && r.session === current)
    if (result) $.ui.toast(formatGuessResult(result, summary.streak))
  } catch {
    // no toast then
  }
}

async function period($: Engine, args: string) {
  const n = Math.floor(Number(args.trim()))
  const days = n > 0 ? n : 7
  const now = await $.clock.now()
  const { events, note } = await readAll($)
  return { now, since: now - days * units.DAY, title: `last ${days} day${days > 1 ? 's' : ''}`, events, note }
}

function failed($: Engine, err: unknown) {
  $.ui.log(`agentclock: something went wrong (${err instanceof Error ? err.message : String(err)})`)
  return {}
}

async function reportCommand($: Engine, args: string) {
  try {
    const { share, rest } = splitShare(args)
    const { now, since, title, events, note } = await period($, rest)
    const stats = computeStats(buildRuns(events, { now }), { since, now })
    return present($, formatReport(stats, { title, dataPath: dir ?? '~/.agentclock' }) + note, share)
  } catch (err) {
    return failed($, err)
  }
}

async function auditCommand($: Engine, args: string) {
  try {
    const { share, rest } = splitShare(args)
    const { now, since, title, events, note } = await period($, rest)
    return present($, formatAudit(permissionAudit(events, { since, now }), { title }) + note, share)
  } catch (err) {
    return failed($, err)
  }
}

async function recapCommand($: Engine, args: string) {
  try {
    const { share, rest } = splitShare(args)
    const { now, since, title, events, note } = await period($, rest)
    const stats = computeStats(buildRuns(events, { now }), { since, now })
    let text = formatRecapText(stats, { title })
    if (stats.runs && dir) {
      const file = join(dir, 'recap.html')
      await $.fs.write(file, recapHtml(stats, { title }))
      if (!share) text += `\n\nImage version: open ${file} in a browser and press "Save as PNG".`
    }
    return present($, text + note, share)
  } catch (err) {
    return failed($, err)
  }
}

async function guessCommand($: Engine, args: string) {
  try {
    const now = await $.clock.now()
    const { share, rest } = splitShare(args)
    if (!rest) {
      const { events } = await readAll($)
      const typical = computeStats(buildRuns(events, { now }), { since: now - 7 * units.DAY, now }).median
      return present($, formatGuessSummary(scoreGuesses(events, { now }), { typical }), share)
    }
    const ms = parseDuration(rest)
    if (!ms) {
      $.ui.log('agentclock: guess a duration like 5m, 90s or 1h30m, e.g. /agentclock-guess 5m')
      return {}
    }
    const root = await dataDir($)
    if (!root) return failed($, 'could not find your home folder')
    const session = current ?? (await $.session.id())
    current = session
    const events = await sessionEvents($, root, session)
    const state = liveSessions(events, { now }).find(s => s.session === session)?.state
    events.push({ ts: now, event: 'Guess', session, ms, src: 'plugin' })
    dirty.add(session)
    await flush($)
    const which = state === 'working' || state === 'waiting' ? 'this run' : 'your next run'
    $.ui.toast(`Guess locked in: ${fmt(ms)} for ${which}. You'll see how close you were when it finishes.`, { timeoutMs: 6000 })
    return {}
  } catch (err) {
    return failed($, err)
  }
}

function codexCommand($: Engine) {
  const root = $.plugin.root
  const s = root.includes('\\') ? '\\' : '/'
  const cli = `${root}${s}cli${s}agentclock.js`
  return present(
    $,
    [
      'agentclock · track your Codex sessions too',
      '',
      '  Run this once in a terminal (needs Node.js 18+):',
      '',
      `    node "${cli}" install --codex`,
      '',
      '  It adds agentclock hooks to ~/.codex/hooks.json (your file is backed up first).',
      '  Then start Codex, run /hooks, and trust the agentclock hooks.',
      '  Codex sessions then show up in /agentclock, the audit, the recap and the status line.',
      '',
      '  The path above changes when this plugin updates: run the command again after an update.',
      `  To undo: node "${cli}" uninstall --codex`,
    ].join('\n'),
    false,
  )
}

async function start($: Engine): Promise<void> {
  current = current ?? (await $.session.id().catch(() => undefined))
  const skip = () => undefined
  await $.command.register({ name: 'agentclock', description: 'agentclock: your agent stats (run times, waiting, parallel agents)', argumentHint: '[days] [share]' }).catch(skip)
  await $.command.register({ name: 'agentclock-audit', description: 'agentclock: which permission prompts cost you the most time', argumentHint: '[days] [share]' }).catch(skip)
  await $.command.register({ name: 'agentclock-recap', description: 'agentclock: a shareable card of your week with agents', argumentHint: '[days] [share]' }).catch(skip)
  await $.command.register({ name: 'agentclock-guess', description: 'agentclock: guess how long your agent will take (e.g. 5m), or see your record', argumentHint: '[5m]', immediate: true }).catch(skip)
  await $.command.register({ name: 'agentclock-codex', description: 'agentclock: how to track your Codex sessions too' }).catch(skip)
  $.clock.every(TICK_MS, () => void tick($))
  await refresh($)
}

export const register: Register = (on, options) => {
  configure(options)

  on('session.start', async ($, e, next) => {
    await start($)
    return next(e)
  })

  // Timing events, from Claude Code's own hook events.
  on('classic.SessionStart', async ($, e, next) => { await record($, e, 'SessionStart'); return next(e) })
  on('classic.UserPromptSubmit', async ($, e, next) => { await record($, e, 'UserPromptSubmit'); return next(e) })
  on('classic.PostToolUse', async ($, e, next) => { await record($, e, 'PostToolUse'); return next(e) })
  on('classic.PostToolUseFailure', async ($, e, next) => { await record($, e, 'PostToolUseFailure'); return next(e) })
  on('classic.PermissionRequest', async ($, e, next) => { await record($, e, 'PermissionRequest'); return next(e) })
  on('classic.Notification', async ($, e, next) => { await record($, e, 'Notification'); return next(e) })
  on('classic.Stop', async ($, e, next) => { await record($, e, 'Stop'); return next(e) })
  on('classic.StopFailure', async ($, e, next) => { await record($, e, 'StopFailure'); return next(e) })
  on('classic.SessionEnd', async ($, e, next) => { await record($, e, 'SessionEnd'); return next(e) })

  // Slash commands, answered directly (no model call).
  on('command.run', { command: 'agentclock' }, ($, e) => reportCommand($, e.args))
  on('command.run', { command: 'agentclock-audit' }, ($, e) => auditCommand($, e.args))
  on('command.run', { command: 'agentclock-recap' }, ($, e) => recapCommand($, e.args))
  on('command.run', { command: 'agentclock-guess' }, ($, e) => guessCommand($, e.args))
  on('command.run', { command: 'agentclock-codex' }, $ => codexCommand($))
}
