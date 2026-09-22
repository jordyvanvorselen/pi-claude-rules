# pi-claude-rules

Load Claude Code rules from `.claude/rules/` into [pi](https://github.com/earendil-works/pi-coding-agent).

Pi only reads `AGENTS.md` and `CLAUDE.md`. Teams that deploy scoped instructions with APM or Claude Code into `.claude/rules/*.md` get nothing from them in pi. This extension fixes that. By default it eagerly loads every discovered rule body into the system prompt before the first model/tool call, which is the safe Claude-compatible behavior.

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

Put rule files in `.claude/rules/` in your project. Start pi. A `[Claude rules]` block appears under pi's own `[Skills]` and `[Extensions]` blocks:

```
[Claude rules]
  api-versioning, authorization, design-system, git-workflow, java-code-style
  5 rules: 0 always, 5 path-scoped, 0 listed
```

Press Ctrl+O to expand it. The expanded form shows one line per rule with its mode and glob scope, grouped by source directory:

```
[Claude rules]
  5 rules: 0 always, 5 path-scoped, 0 listed
  .claude/rules
    api-versioning   on match  connect-backend/src/main/**/*.java
    authorization    on match  connect-backend/src/**/*.java
    design-system    on match  connect-portal/src/**/*.scss
    git-workflow     on match  **
    java-code-style  on match  {connect-backend,panel-event-processor}/src/main/**/*.java
```

The block is a TUI-only session entry. It is stored in the session file so it survives a resume, and it is never sent to the model.

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
| path-scoped | The rule has globs | Eager mode includes its body up front; `onMatch` mode injects it after a matching path is touched. |
| unscoped | No globs and not always-apply | Eager mode includes its body up front; `onMatch` uses `unscopedRules` to list or inline it. |

### How path-scoped injection works (`onMatch` mode)

On each `read`, `write`, or `edit` call, the extension resolves the `path` argument against the working directory and checks it against every scoped rule. Bash commands are checked too. Any token in the command that names an existing file is matched.

A matching rule is sent to the agent as a hidden custom message with `deliverAs: "steer"`. Pi delivers it after the current batch of tool calls and before the next model call. In the transcript you see a TUI-only line instead:

```
[Claude rules] activated api-versioning, authorization, error-handling
```

Expand it with Ctrl+O to see the file that triggered it and the glob of each rule. Use `/claude-rules <name>` to read the full rule text.

**Each rule is injected at most once while its model-visible message remains in active context.** Pi's compaction-aware session projection is used on resume and after `/compact`; rules omitted by compaction can be injected again. `/claude-rules-reload` rescans and clears activation state.

## Where rules are loaded from

In this order:

1. `.claude/rules/` in the working directory and in each parent directory. Globs are relative to the directory that holds `.claude/`.
2. `~/.claude/rules/` in your home directory. Globs are relative to the working directory.
3. `.cursor/rules/*.mdc` in the working directory and its parents, when `cursorRules` is on.
4. Any extra directories from the `directories` setting.

Subdirectories are scanned recursively. Only `.md` files are read, plus `.mdc` for Cursor directories.

Identical deployed copies at the same logical path are merged (the `.claude` identity wins) while scopes and metadata are unioned. Distinct authored files are never merged merely because their bodies are identical.

## Slash commands

| Command | What it does |
|---|---|
| `/claude-rules` | List every discovered rule with its mode, globs, and path. Rules that were already injected are marked with `*`. |
| `/claude-rules <name>` | Show one rule in full, including its activation status. |
| `/claude-rules-reload` | Rescan the rule directories, forget which rules were injected, and print a fresh `[Claude rules]` block. |

## Configuration

Create `~/.pi/agent/claude-rules.json` for user-wide settings or `.pi/claude-rules.json` in a project. Project settings override user settings. Every key is optional.

```json
{
  "directories": ["docs/rules", "~/team-rules"],
  "cursorRules": false,
  "ruleLoading": "eager",
  "unscopedRules": "list",
  "tools": ["read", "write", "edit"],
  "bashActivation": true,
  "activation": "message",
  "startupSummary": "compact",
  "notify": true,
  "enabled": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `directories` | `[]` | Extra rule directories. Relative paths resolve against the working directory. `~` is expanded. Both `.md` and `.mdc` files are read. |
| `cursorRules` | `false` | Also load `.cursor/rules/*.mdc`. |
| `ruleLoading` | `"eager"` | `"eager"` inlines every rule body before the first tool call (safe Claude-compatible default). `"onMatch"` injects scoped rules after matching tool paths; it is not pre-tool equivalent. |
| `unscopedRules` | `"list"` | Used in `onMatch` mode. `"list"` shows unscoped rules; `"inject"` inlines them. Eager mode always loads all bodies. |
| `tools` | `["read", "write", "edit"]` | Tool names whose `path` argument triggers activation. Add `grep`, `find`, or `ls` if you want directory arguments to count. |
| `bashActivation` | `false` | Optional extension: scan bash commands for existing file paths. Enable it for `onMatch` mode if desired (including extensionless `Dockerfile` and `Makefile`). |
| `activation` | `"message"` | `"message"` injects the rule as a steering message. `"toolResult"` appends the rule to the result of the tool call that triggered it. |
| `startupSummary` | `"compact"` | How the `[Claude rules]` block renders at startup. `"compact"` shows the names and counts and expands with Ctrl+O. `"full"` always shows the expanded list. `"off"` shows no block. |
| `notify` | `true` | Show a transient startup notification with the rule counts. Only used when `startupSummary` is `"off"`, since the block already carries that information. |
| `enabled` | `true` | Set to `false` to turn the extension off for a project. |

## How this differs from Claude Code

Eager loading is the default because Pi cannot make a path-targeted rule available before the first tool execution. It guarantees all scoped and unscoped instructions are available up front, at the cost of context. `onMatch` is an explicit context-saving migration option, but scoped bodies arrive after a matching tool call. Bash activation is an optional extension and is off by default.

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
