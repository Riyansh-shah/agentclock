// What every agent is doing right now, for the status line. Pure, no Node imports.
import { buildRuns, overlap, units } from './stats.js';
import { fmt, fmtShort } from './report.js';
import { isMeta } from './events.js';

const { MIN, HOUR } = units;

const isPrompt = (e) => e.event === 'PermissionRequest' || (e.event === 'Notification' && e.kind === 'permission_prompt');

/**
 * The current state of each recent session: `working`, `waiting` (sitting on a
 * permission prompt) or `done` (finished, waiting for your next prompt).
 * Sessions that ended, went quiet for hours, or finished long ago are left out.
 */
export function liveSessions(events, { now, doneFor = 30 * MIN, staleAfter = 3 * HOUR } = {}) {
  const bySession = new Map();
  for (const e of events) {
    if (!e || typeof e.ts !== 'number' || isMeta(e)) continue;
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(e);
  }

  const out = [];
  for (const [session, list] of bySession) {
    list.sort((a, b) => a.ts - b.ts);
    let state = null;
    let project = null;
    let last = 0;
    for (const e of list) {
      project = e.project || project;
      if (e.event === 'UserPromptSubmit') {
        state = { state: 'working', since: e.ts };
      } else if (isPrompt(e)) {
        if (state && state.state === 'working') state = { state: 'waiting', since: e.ts };
      } else if (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure') {
        if (state && state.state === 'waiting') state = { state: 'working', since: e.ts };
      } else if (e.event === 'Stop' || e.event === 'StopFailure' || e.event === 'Interrupt') {
        state = { state: 'done', since: e.ts };
      } else if (e.event === 'SessionEnd') {
        state = null;
      }
      if (e.event !== 'Notification') last = e.ts;
    }
    if (!state) continue;
    if (state.state === 'done' ? now - state.since > doneFor : now - last > staleAfter) continue;
    out.push({ session, project, ...state });
  }
  return out.sort((a, b) => a.since - b.since);
}

/** Start of the local day containing `now`. */
export function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Clock time today with at least one agent running. */
export function todayWallTime(events, now) {
  const midnight = startOfDay(now);
  const runs = buildRuns(events, { now }).filter((r) => r.end > midnight);
  const clipped = runs.map((r) => ({ ...r, start: Math.max(r.start, midnight) }));
  return overlap(clipped).union;
}

function names(items, now) {
  const shown = items.slice(0, 3).map((s) => `${s.project || 'session'} ${fmtShort(now - s.since)}`);
  return shown.join(', ') + (items.length > 3 ? ` +${items.length - 3}` : '');
}

/**
 * One line for the status bar. Your own session is left out of the lists (you
 * can see it already); the point is the agents in your other sessions.
 */
export function formatStatus(sessions, { now, currentSession, todayWall = 0 } = {}) {
  const others = sessions.filter((s) => s.session !== currentSession);
  const working = others.filter((s) => s.state === 'working').length;
  const waiting = others.filter((s) => s.state === 'waiting');
  const done = others.filter((s) => s.state === 'done');

  const parts = [];
  if (waiting.length) parts.push(`waiting on you: ${names(waiting, now)}`);
  if (done.length) parts.push(`done: ${names(done, now)}`);
  if (working) parts.push(`${working} working`);

  const head = parts.length ? `other agents: ${parts.join(' · ')}` : null;
  const today = todayWall >= MIN ? `today ${fmt(todayWall - (todayWall % MIN))} with agents` : null;
  return ['agentclock', head, today].filter(Boolean).join(' · ');
}
