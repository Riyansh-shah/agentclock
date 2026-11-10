import { isMeta } from './events.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const units = { SEC, MIN, HOUR, DAY };

// Stop/StopFailure: Claude Code. Interrupt: Codex (you pressed Esc).
const RUN_END = { Stop: 'stop', StopFailure: 'error', Interrupt: 'interrupted' };
const TOOL_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);

export const BUCKETS = [
  { label: 'under 30s', min: 0, max: 30 * SEC },
  { label: '30s-2m', min: 30 * SEC, max: 2 * MIN },
  { label: '2-10m', min: 2 * MIN, max: 10 * MIN },
  { label: '10-30m', min: 10 * MIN, max: 30 * MIN },
  { label: '30m+', min: 30 * MIN, max: Infinity },
];

/**
 * Turn raw hook events into "runs": one stretch of an agent working, from the
 * prompt you sent until the agent stopped.
 *
 * Each run records how long it took, how many tools it used, how long it sat
 * waiting for your permission, and how long you took to send the next prompt
 * after the previous run finished ("comeback").
 */
export function buildRuns(events, { now = Date.now(), staleAfter = 3 * HOUR, comebackCap = 3 * HOUR } = {}) {
  const sessions = new Map();
  for (const e of events) {
    if (!e || typeof e.ts !== 'number' || !e.event || isMeta(e)) continue;
    const key = e.session || 'unknown';
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(e);
  }

  const runs = [];
  for (const [session, list] of sessions) {
    list.sort((a, b) => a.ts - b.ts);
    let run = null;
    let lastStop = null;

    const close = (end, ending) => {
      const blocked = run.blockStart != null ? Math.max(0, end - run.blockStart) : 0;
      runs.push({
        session,
        agent: run.agent,
        project: run.project,
        start: run.start,
        end,
        duration: Math.max(0, end - run.start),
        tools: run.tools,
        blocks: run.blocks,
        blocked: run.blocked + blocked,
        comeback: run.comeback,
        ending,
      });
      run = null;
    };

    for (const e of list) {
      if (e.event === 'UserPromptSubmit') {
        // A new prompt while the last run never stopped means it was interrupted.
        // If it was stuck on a permission prompt, you were the one it waited for.
        if (run) close(run.blockStart != null ? e.ts : run.lastTs, 'interrupted');
        const gap = lastStop != null ? e.ts - lastStop : null;
        run = {
          agent: e.agent || 'claude',
          project: e.project || null,
          start: e.ts,
          lastTs: e.ts,
          tools: 0,
          blocks: 0,
          blocked: 0,
          blockStart: null,
          comeback: gap != null && gap <= comebackCap ? gap : null,
        };
        lastStop = null;
        continue;
      }

      if (e.event === 'SessionEnd') {
        if (run) close(run.lastTs, 'interrupted');
        lastStop = null;
        continue;
      }

      if (!run) continue; // e.g. idle notifications after the agent already finished

      // A permission prompt: PermissionRequest fires as the prompt appears; the
      // permission_prompt notification ~6s later (older data only has that one).
      if (e.event === 'PermissionRequest' || e.event === 'Notification') {
        const isPrompt = e.event === 'PermissionRequest' || e.kind === 'permission_prompt';
        if (isPrompt && run.blockStart == null) {
          run.blockStart = e.ts;
          run.blocks++;
        }
        run.lastTs = e.ts;
        continue;
      }

      if (run.blockStart != null) {
        run.blocked += Math.max(0, e.ts - run.blockStart);
        run.blockStart = null;
      }
      run.lastTs = e.ts;

      if (TOOL_EVENTS.has(e.event)) {
        run.tools++;
      } else if (RUN_END[e.event]) {
        close(e.ts, RUN_END[e.event]);
        lastStop = e.ts;
      }
    }

    // A run with no end: if it's old, it was interrupted. If it's recent, it's
    // probably still running, so leave it out for now.
    if (run && now - run.lastTs > staleAfter) close(run.lastTs, 'interrupted');
  }

  return runs.sort((a, b) => a.start - b.start);
}

/** Nearest-rank quantile of an already-sorted array. */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const asc = (a, b) => a - b;

/** How runs overlap in time: max running at once, and time with 1+ and 2+ running. */
export function overlap(runs) {
  const points = [];
  for (const r of runs) {
    if (r.end > r.start) points.push([r.start, 1], [r.end, -1]);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ends before starts at the same instant
  let running = 0;
  let max = runs.length ? 1 : 0;
  let union = 0;
  let multi = 0;
  let prev = null;
  for (const [t, delta] of points) {
    if (prev != null) {
      if (running >= 1) union += t - prev;
      if (running >= 2) multi += t - prev;
    }
    running += delta;
    max = Math.max(max, running);
    prev = t;
  }
  return { max, union, multi };
}

export function computeStats(allRuns, { since = 0, now = Date.now() } = {}) {
  const runs = allRuns.filter((r) => r.start >= since && r.start <= now);
  const durations = runs.map((r) => r.duration).sort(asc);
  const comebacks = runs.map((r) => r.comeback).filter((c) => c != null).sort(asc);
  const tools = runs.map((r) => r.tools).sort(asc);
  const ov = overlap(runs);

  const byProject = new Map();
  for (const r of runs) {
    const name = r.project || '(unknown)';
    const p = byProject.get(name) || { name, runs: 0, time: 0 };
    p.runs++;
    p.time += r.duration;
    byProject.set(name, p);
  }

  return {
    runs: runs.length,
    interrupted: runs.filter((r) => r.ending === 'interrupted').length,
    errored: runs.filter((r) => r.ending === 'error').length,
    agentTime: sum(durations),
    wallTime: ov.union,
    activeDays: new Set(runs.map((r) => new Date(r.start).toDateString())).size,
    median: quantile(durations, 0.5),
    p90: quantile(durations, 0.9),
    longest: durations.length ? durations[durations.length - 1] : null,
    buckets: BUCKETS.map((b) => ({
      label: b.label,
      count: durations.filter((d) => d >= b.min && d < b.max).length,
    })),
    toolsMedian: quantile(tools, 0.5),
    blocks: sum(runs.map((r) => r.blocks)),
    blockedTime: sum(runs.map((r) => r.blocked)),
    comeback: {
      count: comebacks.length,
      median: quantile(comebacks, 0.5),
      slowShare: comebacks.length ? comebacks.filter((c) => c >= 5 * MIN).length / comebacks.length : 0,
    },
    parallel: {
      max: ov.max,
      share: ov.union ? ov.multi / ov.union : 0,
    },
    projects: [...byProject.values()].sort((a, b) => b.time - a.time).slice(0, 3),
    agents: countBy(runs, (r) => r.agent || 'claude'),
  };
}

function countBy(items, key) {
  const out = {};
  for (const item of items) out[key(item)] = (out[key(item)] || 0) + 1;
  return out;
}
