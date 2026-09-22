# pi-claude-rules

Load Claude Code rules from `.claude/rules/` into [pi](https://github.com/earendil-works/pi-coding-agent).

Pi only reads `AGENTS.md` and `CLAUDE.md`. Teams that deploy scoped instructions with APM or Claude Code into `.claude/rules/*.md` get nothing from them in pi. This extension fixes that. It lists every rule in the system prompt, inlines the rules marked always-apply, and injects a path-scoped rule into the conversation the first time the agent reads, writes, or edits a file that matches its globs.

## Quick start

Install the package:

```bash
pi install git:github.com/jordyvanvorselen/pi-claude-rules
```

Or install from a local checkout:

```bash
pi install /path/to/pi-claude-rules
```

Or try it for one run without installing:

```bash
pi -e git:github.com/jordyvanvorselen/pi-claude-rules
```

Put rule files in `.claude/rules/` in your project. Start pi. You will see a notification like `claude-rules: 30 rule(s): 0 always, 30 path-scoped, 0 listed`.

Run `/claude-rules` to see what was found.

## Rule files

A rule is a Markdown file with optional YAML frontmatter. The body is the instruction text.

```markdown
---
description: V1/V2 API versioning rules for the backend
paths:
  - "connect-backend/src/main/**/*.java"
---
# API versioning

Only some APIs have both a V1 and a V2 ...
```

### Supported frontmatter

| Key | Type | Meaning |
|---|---|---|
| `paths` | string or list | Globs that scope the rule. Claude Code format. |
| `applyTo` | comma-separated string | Same as `paths`. APM and GitHub Copilot format. Commas inside `{a,b}` braces are kept. |
| `globs` | string or list | Same as `paths`. Cursor format. |
| `alwaysApply` | boolean | Inline the full rule body in every system prompt. |
| `always` | boolean | Same as `alwaysApply`. |
| `description` | string | One line summary shown in the system prompt listing. Falls back to the first Markdown heading, then to the file name. |

`paths`, `applyTo`, and `globs` are synonyms. When a file uses more than one, the globs are merged.

Unknown keys are ignored. `/claude-rules` shows a warning for each unknown key so typos are easy to spot.

### Glob matching

Globs are matched against the path relative to the project root, which is the directory that contains `.claude/`. The matcher supports `**`, `*`, `?`, `{a,b}` alternatives, and `[abc]` character classes. A glob with no slash, like `*.feature`, matches at any depth. A glob ending in `/` or `/**` matches the whole subtree. A glob of `**` matches every file.

## Activation modes

Every rule ends up in one of three modes.

| Mode | When | What happens |
|---|---|---|
| always | `alwaysApply: true` | The full body is inlined in the system prompt on every turn. |
| path-scoped | The rule has globs | The rule is listed in the system prompt with its globs. The full body is injected into the conversation the first time a tool call touches a matching file. |
| unscoped | No globs and not always-apply | The rule is listed in the system prompt with its description. The agent reads it on demand. Set `unscopedRules` to `inject` to inline these too. |

### How path-scoped injection works

On each `read`, `write`, or `edit` call, the extension resolves the `path` argument against the working directory and checks it against every scoped rule. Bash commands are checked too. Any token in the command that names an existing file is matched.

A matching rule is sent to the agent as a custom message with `deliverAs: "steer"`. Pi delivers it after the current batch of tool calls and before the next model call. The message shows up in the transcript as one line. Expand it to see the full rule.

**Each rule is injected at most once per session.** The extension remembers which rules it injected. It rebuilds that memory from the session file on resume, so a resumed session does not repeat rules that are already in context. `/claude-rules-reload` clears the memory on purpose.

Rules are not re-injected after `/compact`. Run `/claude-rules-reload` if you want them to come back when the agent next touches a matching file.

## Where rules are loaded from

In this order:

1. `.claude/rules/` in the working directory and in each parent directory. Globs are relative to the directory that holds `.claude/`.
2. `~/.claude/rules/` in your home directory. Globs are relative to the working directory.
3. `.cursor/rules/*.mdc` in the working directory and its parents, when `cursorRules` is on.
4. Any extra directories from the `directories` setting.

Subdirectories are scanned recursively. Only `.md` files are read, plus `.mdc` for Cursor directories.

Rules with identical bodies are merged and the first one wins. This matters when APM deploys the same source to both `.claude/rules/` and `.cursor/rules/`. If the Claude copy has no `description` and the Cursor copy does, the description is borrowed.

## Slash commands

| Command | What it does |
|---|---|
| `/claude-rules` | List every discovered rule with its mode, globs, and path. Rules that were already injected are marked with `*`. |
| `/claude-rules <name>` | Show one rule in full, including its activation status. |
| `/claude-rules-reload` | Rescan the rule directories and forget which rules were injected. |

## Configuration

Create `~/.pi/agent/claude-rules.json` for user-wide settings or `.pi/claude-rules.json` in a project. Project settings override user settings. Every key is optional.

```json
{
  "directories": ["docs/rules", "~/team-rules"],
  "cursorRules": false,
  "unscopedRules": "list",
  "tools": ["read", "write", "edit"],
  "bashActivation": true,
  "activation": "message",
  "notify": true,
  "enabled": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `directories` | `[]` | Extra rule directories. Relative paths resolve against the working directory. `~` is expanded. Both `.md` and `.mdc` files are read. |
| `cursorRules` | `false` | Also load `.cursor/rules/*.mdc`. |
| `unscopedRules` | `"list"` | `"list"` shows unscoped rules in the system prompt listing. `"inject"` inlines their full body like always-apply rules. |
| `tools` | `["read", "write", "edit"]` | Tool names whose `path` argument triggers activation. Add `grep`, `find`, or `ls` if you want directory arguments to count. |
| `bashActivation` | `true` | Scan bash commands for existing file paths and activate matching rules. |
| `activation` | `"message"` | `"message"` injects the rule as a steering message. `"toolResult"` appends the rule to the result of the tool call that triggered it. |
| `notify` | `true` | Show a notification on startup and on each activation. |
| `enabled` | `true` | Set to `false` to turn the extension off for a project. |

## How this differs from Claude Code

Claude Code loads path-scoped rules when Claude reads or edits a matching file, and unscoped rules on every session. This extension mirrors that, with a few differences you should know about.

- Unscoped rules are listed, not inlined, by default. Claude Code inlines them. Set `unscopedRules` to `inject` to match Claude Code. The default keeps the system prompt small for projects that deploy many rules.
- Injection happens once per session per rule. Claude Code manages rule context internally and may present rules differently after compaction.
- Bash commands can activate rules. Claude Code only activates on its file tools. Turn off `bashActivation` if you prefer the stricter behaviour.
- Rules from parent directories are loaded, the same way pi loads `AGENTS.md` from parents. Claude Code only loads from the project root.
- Cursor `.mdc` files and extra directories are supported. Claude Code ignores them.
- Symlinked files and directories inside a rules directory are followed. Loops are skipped.

## Development

```bash
npm install
npm run typecheck
npm test
```

Try it against a project without installing:

```bash
cd /path/to/project
pi -e /path/to/pi-claude-rules/src/index.ts
```

## License

MIT
