export function fmt(ms) {
  if (ms == null || Number.isNaN(ms)) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Coarse duration for tight spaces like the status line: 45s, 3m, 1h 20m. */
export function fmtShort(ms) {
  if (ms == null || Number.isNaN(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

const pct = (x) => `${Math.round(x * 100)}%`;

function bar(share, width = 24) {
  const n = Math.round(share * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

const row = (label, value) => `  ${label.padEnd(30)}${value}`;

/** "1 run", "3 runs", "2 guesses". */
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * A smaller version of a report for Claude to read (when you choose to share
 * it): no bars, boxes, alignment padding or blank lines. Roughly half the tokens.
 */
export function compactForModel(text) {
  return String(text)
    .split('\n')
    .map((line) => line.replace(/[█░┌┐└┘─│]+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' };
export const agentName = (id) => AGENT_NAMES[id] || id;

export function formatReport(s, { title, dataPath }) {
  const out = [`agentclock · ${title}`, ''];

  if (!s.runs) {
    out.push(
      '  No finished agent runs yet.',
      '  Use Claude Code or Codex as usual. Stats show up after your first task.',
      '',
      `  Data: ${dataPath}`,
    );
    return out.join('\n');
  }

  const notes = [
    s.interrupted && `${s.interrupted} interrupted`,
    s.errored && `${s.errored} ended in an error`,
  ].filter(Boolean);

  out.push(row('Agent runs', `${s.runs}${notes.length ? ` (${notes.join(', ')})` : ''}`));
  out.push(row('Time agents worked', fmt(s.agentTime)));
  out.push(row('Time with an agent running', `${fmt(s.wallTime)}  (~${fmt(s.wallTime / s.activeDays)} per active day)`));
  out.push(row('Typical run', `${fmt(s.median)} median · ${fmt(s.p90)} at 90th pct · longest ${fmt(s.longest)}`));
  out.push(row('Tool calls per run', `${s.toolsMedian} median`));

  out.push('', '  Run lengths');
  for (const b of s.buckets) {
    const share = b.count / s.runs;
    out.push(`    ${b.label.padEnd(12)}${bar(share)}  ${pct(share).padStart(4)}  (${b.count})`);
  }
  out.push('');

  out.push(row('Waiting on your approval',
    s.blocks ? `${plural(s.blocks, 'permission prompt')} · ${fmt(s.blockedTime)} total` : 'none'));
  out.push(row('Back after it finished',
    s.comeback.count ? `${fmt(s.comeback.median)} median · ${pct(s.comeback.slowShare)} of the time 5m+` : '-'));
  out.push(row('Parallel agents',
    s.parallel.max > 1 ? `up to ${s.parallel.max} at once · 2+ running ${pct(s.parallel.share)} of the time` : 'one at a time'));
  if (s.projects.length) {
    out.push(row('Top projects', s.projects.map((p) => `${p.name} (${plural(p.runs, 'run')}, ${fmt(p.time)})`).join(' · ')));
  }
  const agents = Object.entries(s.agents || {});
  if (agents.length > 1) {
    out.push(row('Agents', agents.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, n]) => `${agentName(id)} ${plural(n, 'run')}`).join(' · ')));
  }

  out.push('', `  Your data stays on your machine: ${dataPath}`);
  return out.join('\n');
}
