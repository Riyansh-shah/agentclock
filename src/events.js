// Event records: how a Claude Code hook payload becomes the small timing record
// agentclock stores. Pure functions with no Node imports, so the CLI and the
// Claude Code plugin share them.

/**
 * @typedef {{
 *   ts: number, event: string, session: string, project?: string,
 *   kind?: string, tool?: string, rule?: string, subagent?: boolean, src?: string
 * }} AgentEvent
 */

const str = (v) => (typeof v === 'string' && v ? v : undefined);

/**
 * Events agentclock writes itself (not Claude Code / Codex activity), e.g. a
 * "guess the run" guess. Timing logic skips them.
 */
export const META_EVENTS = new Set(['Guess']);
export const isMeta = (e) => META_EVENTS.has(e?.event);

/** Last part of a path, for either slash. */
export function basename(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

/**
 * The permission rule Claude Code itself suggests for a permission prompt,
 * e.g. "Bash(npm test:*)". Only the suggested rule is kept, never the command.
 * @returns {string | undefined}
 */
export function suggestedRule(input) {
  if (!input || input.hook_event_name !== 'PermissionRequest') return undefined;
  const suggestions = Array.isArray(input.permission_suggestions) ? input.permission_suggestions : [];
  for (const s of suggestions) {
    if (s?.type !== 'addRules' || s.behavior !== 'allow' || !Array.isArray(s.rules)) continue;
    const r = s.rules[0];
    if (!str(r?.toolName)) continue;
    return str(r.ruleContent) ? `${r.toolName}(${r.ruleContent})` : r.toolName;
  }
  return undefined;
}

/**
 * Turn a hook payload into a timing record. Prompts, code, commands, paths and
 * answers are never copied.
 * @returns {AgentEvent}
 */
export function toEvent(input, { ts, src, event, kind, agent } = {}) {
  input = input && typeof input === 'object' ? input : {};
  /** @type {AgentEvent} */
  const evt = {
    ts,
    event: str(input.hook_event_name) || str(event) || 'Unknown',
    session: str(input.session_id) || 'unknown',
  };
  if (str(input.cwd)) evt.project = basename(input.cwd);
  const k = str(kind) || str(input.notification_type);
  if (k) evt.kind = k;
  if (str(input.tool_name)) evt.tool = input.tool_name;
  const rule = suggestedRule(input);
  if (rule) evt.rule = rule;
  if (input.agent_id) evt.subagent = true;
  if (str(agent) && agent !== 'claude') evt.agent = agent;
  if (src) evt.src = src;
  return evt;
}

/** Parse JSON lines, skipping half-written ones. @returns {AgentEvent[]} */
export function parseLines(text, src) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!e || typeof e !== 'object') continue;
      if (src && !e.src) e.src = src;
      out.push(e);
    } catch {
      // half-written line
    }
  }
  return out;
}

/** @param {AgentEvent[]} events */
export function toLines(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
}

/**
 * If both the plugin and settings hooks recorded the same session (someone
 * installed both), keep only the plugin's copy so nothing is counted twice.
 * @param {AgentEvent[]} events
 */
export function mergeSources(events) {
  const pluginSessions = new Set(events.filter((e) => e.src === 'plugin').map((e) => e.session));
  return events.filter((e) => e.src === 'plugin' || !pluginSessions.has(e.session));
}

/**
 * A safe file name for a session id. Sessions recorded by command hooks for
 * another agent (e.g. Codex) get a prefix, so the plugin never rewrites them.
 */
export function sessionFileName(session, agent) {
  const prefix = str(agent) && agent !== 'claude' ? `${agent.replace(/[^a-z0-9]/gi, '')}-` : '';
  return `${prefix}${String(session).replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`;
}
