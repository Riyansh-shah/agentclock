// Smart nudge: at most one notification per wait, only when an agent has been
// waiting on you for a while AND you seem to be away. Pure, no Node imports.
import { isMeta } from './events.js';
import { fmtShort } from './report.js';

const CLEARS = new Set(['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'SessionEnd']);
const ENDS = new Set(['Stop', 'StopFailure', 'Interrupt']);

/**
 * Looks at one session's events. Returns `{ key, text }` when the agent has
 * been waiting on you (a permission prompt, or finished work) for at least
 * `after` ms, and Claude Code's own notification has fired for that wait
 * (it only fires when you haven't typed: ~6s after a permission prompt, 60s
 * after the agent finishes). `key` identifies the wait, so it's nudged once.
 */
export function nudgeFor(events, { now, after, session }) {
  const list = events.filter((e) => e && e.session === session && !isMeta(e)).sort((a, b) => a.ts - b.ts);
  let wait = null;
  for (const e of list) {
    if (CLEARS.has(e.event)) {
      wait = null;
    } else if (e.event === 'PermissionRequest') {
      if (wait?.kind !== 'approval') wait = { kind: 'approval', since: e.ts, project: e.project, away: false };
    } else if (ENDS.has(e.event)) {
      wait = { kind: 'done', since: e.ts, project: e.project, away: false };
    } else if (e.event === 'Notification' && wait) {
      const matches = wait.kind === 'approval' ? e.kind === 'permission_prompt' : e.kind === 'idle_prompt';
      if (matches) wait.away = true;
    }
  }
  if (!wait || !wait.away || now - wait.since < after) return null;

  const where = wait.project ? ` in ${wait.project}` : '';
  const text = wait.kind === 'approval'
    ? `Your agent${where} has been waiting for your approval for ${fmtShort(now - wait.since)}.`
    : `Your agent${where} finished ${fmtShort(now - wait.since)} ago and is waiting for you.`;
  return { key: `${session}:${wait.kind}:${wait.since}`, text };
}

/** ntfy topic names: letters, digits, - and _, up to 64 characters. */
export const isValidTopic = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(t);
