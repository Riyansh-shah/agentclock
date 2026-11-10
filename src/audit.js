// Permission audit: which prompts you keep answering, how long they cost you,
// and which allow rules would stop them. Pure, no Node imports.
import { quantile, units } from './stats.js';
import { fmt } from './report.js';
import { isMeta } from './events.js';

const { HOUR } = units;

// Rules we never suggest auto-allowing, however often you approve them.
const RISKY = /^Bash\((sudo|su|rm|rmdir|dd|mkfs|chmod|chown|kill|pkill|killall|shutdown|reboot|curl|wget|ssh|scp|rsync|git push|git reset|git clean|git checkout|git rebase|npm publish|yarn publish|pnpm publish|docker rm|docker rmi|kubectl delete|terraform)\b/;

export function isSafeRule(rule) {
  if (!rule || rule === 'Bash' || /^Bash\(\s*\*?\s*\)$/.test(rule) || /^Bash\(:\*\)$/.test(rule)) return false;
  return !RISKY.test(rule);
}

const isQuiet = (e) => e.event === 'PermissionRequest' || e.event === 'Notification' || isMeta(e);

export function permissionAudit(events, { since = 0, now = Infinity, minCount = 3, top = 8, maxWait = 3 * HOUR } = {}) {
  const bySession = new Map();
  for (const e of events) {
    if (!e || typeof e.ts !== 'number') continue;
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(e);
  }

  const rows = new Map();
  const waits = [];
  let total = 0;
  for (const list of bySession.values()) {
    list.sort((a, b) => a.ts - b.ts);
    list.forEach((e, i) => {
      if (e.event !== 'PermissionRequest' || e.ts < since || e.ts > now) return;
      total++;
      // Your answer shows up as the next thing that happens in that session.
      const next = list.slice(i + 1).find((x) => !isQuiet(x));
      const wait = next && next.ts - e.ts <= maxWait ? next.ts - e.ts : null;
      if (wait != null) waits.push(wait);
      const key = e.rule || e.tool || 'unknown';
      const row = rows.get(key) || { key, rule: e.rule || null, count: 0, wait: 0 };
      row.count++;
      row.wait += wait ?? 0;
      rows.set(key, row);
    });
  }

  const sorted = [...rows.values()].sort((a, b) => b.count - a.count || b.wait - a.wait);
  const frequent = sorted.filter((r) => r.rule && r.count >= minCount);
  waits.sort((a, b) => a - b);
  return {
    total,
    totalWait: waits.reduce((a, b) => a + b, 0),
    medianWait: quantile(waits, 0.5),
    rows: sorted.slice(0, top),
    suggestions: frequent.filter((r) => isSafeRule(r.rule)).map((r) => r.rule),
    risky: frequent.filter((r) => !isSafeRule(r.rule)).map((r) => r.rule),
  };
}

export function formatAudit(a, { title } = {}) {
  const out = [`agentclock · permission prompts · ${title}`, ''];
  if (!a.total) {
    out.push(
      '  No permission prompts recorded in this period.',
      '  (Prompt details are recorded from agentclock 0.2 on.)',
    );
    return out.join('\n');
  }

  out.push(`  ${a.total} prompts · ${fmt(a.totalWait)} waiting for your answer · ${fmt(a.medianWait)} typical answer time`, '');
  const width = Math.min(48, Math.max(12, ...a.rows.map((r) => r.key.length)));
  out.push(`  ${'Most asked'.padEnd(width + 2)}${'times'.padStart(6)}  waiting`);
  for (const r of a.rows) {
    const key = r.key.length > width ? `${r.key.slice(0, width - 1)}…` : r.key;
    out.push(`    ${key.padEnd(width)}${String(r.count).padStart(6)}  ${fmt(r.wait)}`);
  }

  if (a.suggestions.length) {
    out.push(
      '',
      '  To stop being asked for these, add them to "permissions" > "allow" in',
      '  ~/.claude/settings.json (or use /permissions):',
      '',
      ...a.suggestions.map((r, i) => `      ${JSON.stringify(r)}${i < a.suggestions.length - 1 ? ',' : ''}`),
      '',
      "  Only allow commands you'd be fine with running without asking.",
    );
  } else {
    out.push('', '  No safe allow rules to suggest yet (a rule needs 3+ approvals).');
  }
  if (a.risky.length) {
    out.push(`  Not suggested, risky to allow without asking: ${a.risky.join(', ')}`);
  }
  return out.join('\n');
}
