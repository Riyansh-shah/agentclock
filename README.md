# agentclock

See how much time you spend waiting on your AI coding agents.

agentclock times your Claude Code sessions and shows you how long your agents actually run,
which agents are waiting on you right now, which permission prompts keep interrupting you,
and a weekly recap you can share.

## What you get

**A live status line** across all your sessions, so you know which agent needs you:

```
agentclock · other agents: waiting on you: shop-api 3m · done: landing-page 2m · 1 working · today 2h 10m with agents
```

**`/agentclock-audit`**: which permission prompts cost you the most time, and allow rules to stop them:

```
  80 prompts · 1h 22m waiting for your answer · 36s typical answer time

  Most asked                         times  waiting
    Bash(git status:*)                  26  23m 41s
    Bash(ls:*)                          14  17m 4s
    Bash(npm test:*)                    10  9m 57s
    Bash(git push:*)                     9  11m 4s

  To stop being asked for these, add them to "permissions" > "allow" in
  ~/.claude/settings.json (or use /permissions):

      "Bash(git status:*)",
      "Bash(ls:*)",
      "Bash(npm test:*)"

  Not suggested, risky to allow without asking: Bash(git push:*)
```

**`/agentclock-recap`**: a card of your week, as text and as an image you can post:

```
┌──────────────────────────────────────────┐
│ My AI agents · last 7 days               │
│                                          │
│ Agents worked           17h 54m          │
│ Waited for my approval  1h 22m           │
│ Typical run             3m 39s           │
│ Longest run             36m 57s          │
│ Most agents at once     2                │
│ Back after it finished  3m 56s median    │
│                                          │
│ 134 runs · measured with agentclock      │
└──────────────────────────────────────────┘
```

**`/agentclock`**: the full stats (run lengths, time waiting on you, how fast you come back,
parallel agents, top projects, Claude Code vs Codex). Add a number for more days: `/agentclock 30`.

**`/agentclock-guess 5m`**: guess how long your agent will take, while it works or before
you send the prompt. When it finishes you see how close you were:

```
Guessed 4m · took 3m 40s · 91% close · 3 in a row
```

`/agentclock-guess` on its own shows your record: guesses, hits (within 20%), streaks.

**A nudge (optional, off by default)**: one notification when an agent has been waiting on
you for a while and you seem to be away (Claude Code's own "waiting for input" notice has
fired). At most one per wait. Turn it on in `/config`, set the minutes, and optionally add an
[ntfy](https://ntfy.sh) topic to get it on your phone.

**Codex too**: `/agentclock-codex` shows the one command that adds Codex sessions to all of
the above, including the status line.

(Examples above are from sample data.)

## Claude token use

agentclock adds **nothing** to Claude's context on a normal turn: no system prompt text, no
hook output, and the status line, toasts and nudges are display-only.

Reports are shown to you only (as a dim notice Claude doesn't receive), so running a command
costs about the length of the command line itself. Before this, each report put roughly
170-550 tokens into the conversation, which then stayed there for the rest of the session.

Want Claude to act on a report? Add `share`, e.g. `/agentclock-audit share` and then "add
those allow rules for me". Claude gets a compact copy (no bars, boxes or padding).

## Privacy

- **Recorded:** when things happen (prompt sent, tool finished, permission asked, agent
  stopped), the session, the project folder's name, tool names (like `Edit` or `Bash`), and
  for permission prompts the allow rule Claude Code itself suggests (like `Bash(npm test:*)`,
  which can include the start of a command).
- **Never recorded:** your prompts, code, file contents, full commands, file paths, or the
  agent's answers.
- **Stays on your machine** in `~/.agentclock/`. Nothing is sent anywhere, with one opt-in
  exception: if you set an ntfy topic, nudges (which name the project folder) go to ntfy.sh.
- **The recap card never shows project names or rules**, so it's safe to post.

## Install (Claude Code plugin, recommended)

At the prompt of a Claude Code terminal session:

```
/plugin install agentclock --marketplace Riyansh-shah/agentclock
```

Answer `y` to add the marketplace, then pick a scope (user scope = every project). It's
active right away. No Node.js needed for the plugin.

From a shell:

```
claude plugin install agentclock --marketplace Riyansh-shah/agentclock
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then
Plugins, Add marketplace with `Riyansh-shah/agentclock`, then Add plugin.

To try it from a local folder instead: `claude --plugin-dir /path/to/agentclock`

## Command line (optional)

The same reports are available from a terminal, with Node.js 18+:

```sh
node cli/agentclock.js              # stats, last 7 days (--days 30, --all, --json)
node cli/agentclock.js audit        # permission prompts
node cli/agentclock.js recap        # weekly card + recap.html image
node cli/agentclock.js guess        # your guess-the-run record
node cli/agentclock.js status       # the status line text
node cli/agentclock.js where        # where your data lives
```

**Codex:** `node cli/agentclock.js install --codex` adds hooks to `~/.codex/hooks.json`
(backed up first). Then start Codex, run `/hooks`, and trust the agentclock hooks. Undo with
`uninstall --codex`.

**Claude Code without the plugin:** `node cli/agentclock.js install` records through settings
hooks in `~/.claude/settings.json` instead (your settings are kept and backed up first;
`uninstall` removes only agentclock's hooks). Use either the plugin or settings hooks; if
both are on, agentclock counts each session once.

## What the numbers mean

| Stat | Meaning |
|------|---------|
| Agent run | From the moment you send a prompt until the agent stops. |
| Time agents worked | All runs added together. |
| Time with an agent running | Clock time with at least one agent working. Lower than the line above if you run agents in parallel. |
| Waiting on your approval | Time an agent sat on a permission prompt until you answered. |
| Back after it finished | Time from the agent finishing to your next prompt in that session (includes reading the result). Gaps over 3 hours aren't counted. |
| Parallel agents | Most runs going at the same moment, across all your sessions. |
| Interrupted | Runs that ended without the agent finishing (Esc, a new prompt, or closing the session). |
| Status line: done | An agent finished in the last 30 minutes and is waiting for your next prompt. |

## Limitations

- Claude Code (plugin or settings hooks) and Codex (hooks). Other agents not yet.
- The status line lists your *other* sessions (you can already see the one you're in) and
  refreshes every 10 seconds.
- Interrupted runs are estimated: they end at the agent's last recorded activity.
- Audit suggestions need 3+ approvals of the same rule, and never include risky commands
  (rm, sudo, git push, curl, ...). Review a rule before you add it. Codex doesn't suggest
  rules, so Codex prompts are counted by tool only.
- Nudges work for Claude Code sessions (they rely on Claude Code's own "waiting for input"
  notice to tell that you're away).
- Guesses: the first guess for a run counts. Guessing late in a run is easier; that's on you.

## Development

```sh
npm test                          # 46 tests, no dependencies
claude plugin validate .          # checks the plugin
```

Layout: `hooks/register.ts` is the plugin (Claude Code function hooks), `src/` is the shared
logic (plain JavaScript, no Node imports except `store.js` and `install.js`), `cli/` is the
command line tool.
