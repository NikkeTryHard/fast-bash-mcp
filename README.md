# Fast Bash MCP Server for Claude Code

A high-performance MCP server that provides fast bash command execution for Claude Code, bypassing the slow haiku-based pre-flight checks that cause 30+ second delays.

## The Problem

Claude Code's built-in Bash tool makes **two LLM API calls per command**:

1. `bash_extract_prefix` - Pre-flight check before execution
2. `bash_extract_command_paths` - Post-execution file path extraction

These calls go through the configured haiku model and can add **30+ seconds of latency** per bash command, even for simple operations like `git status` or `ls`.

### Investigation Findings

| Factor                  | Impact          | Status         |
| ----------------------- | --------------- | -------------- |
| Shell profile startup   | 95ms            | Not the issue  |
| Proxy latency           | 1-2s            | Not the issue  |
| Bubblewrap sandbox      | Minimal         | Not the issue  |
| Command injection check | Minimal         | Not the issue  |
| **Haiku LLM calls**     | **30+ seconds** | **Root cause** |

### Related GitHub Issues

- [#10181](https://github.com/anthropics/claude-code/issues/10181) - Shell profile interference
- [#3505](https://github.com/anthropics/claude-code/issues/3505) - 2-minute timeout issues
- [#19585](https://github.com/anthropics/claude-code/issues/19585) - Shell snapshot creation timing out
- [#4049](https://github.com/anthropics/claude-code/issues/4049) - Pre-flight Haiku model access denied
- [#19247](https://github.com/anthropics/claude-code/issues/19247) - Basic tool calls hanging

## The Solution

This MCP server provides direct bash execution without LLM pre-flight checks, giving you the speed of Claude Code's `!` prefix but accessible to agents programmatically.

## Features

| Tool                  | Description                               |
| --------------------- | ----------------------------------------- |
| `fast_bash`           | Single command execution with all options |
| `fast_bash_parallel`  | Run multiple commands concurrently        |
| `fast_bash_bg`        | Start background task, get task_id        |
| `fast_bash_bg_status` | Check/kill/list background tasks          |

### fast_bash Parameters

| Parameter     | Type   | Default     | Description                      |
| ------------- | ------ | ----------- | -------------------------------- |
| `command`     | string | required    | The bash command to execute      |
| `cwd`         | string | project dir | Working directory                |
| `timeout`     | number | 30000       | Timeout in ms (max 600000)       |
| `description` | string | -           | Short description for logging    |
| `shell`       | string | bash        | Shell: bash, zsh, or sh          |
| `env`         | object | -           | Additional environment variables |
| `stdin`       | string | -           | Input to pipe to command         |
| `max_output`  | number | 30000       | Truncation limit (chars)         |

### Additional Features

- **Middle-truncation**: Preserves beginning and end of large outputs (like Claude's Bash)
- **Shell selection**: Use bash, zsh, or sh
- **Custom env vars**: Pass environment variables per command
- **Stdin support**: Pipe input to commands
- **Parallel execution**: Run independent commands concurrently
- **Background tasks**: Track long-running processes with task IDs

## Quick Install

### Using Claude CLI (Recommended)

```bash
# Clone the repo
git clone https://github.com/nikketryhard/fast-bash-mcp.git ~/.claude/mcp-servers/fast-bash

# Install dependencies
cd ~/.claude/mcp-servers/fast-bash && bun install

# Add MCP server using Claude CLI
claude mcp add --transport stdio -e FAST_BASH_DEFAULT_CWD='${PWD}' fast-bash -- bun run ~/.claude/mcp-servers/fast-bash/src/index.ts

# Restart Claude Code
```

#### Scope Options

```bash
# User scope (default) - available in all projects
claude mcp add fast-bash -- bun run ~/.claude/mcp-servers/fast-bash/src/index.ts

# Project scope - only in current project (.claude/settings.local.json)
claude mcp add --scope project fast-bash -- bun run ~/.claude/mcp-servers/fast-bash/src/index.ts

# Local scope - gitignored, only your machine (.claude/settings.local.json)
claude mcp add --scope local fast-bash -- bun run ~/.claude/mcp-servers/fast-bash/src/index.ts
```

### Manual Installation

```bash
# Clone the repo
git clone https://github.com/nikketryhard/fast-bash-mcp.git ~/.claude/mcp-servers/fast-bash

# Install dependencies
cd ~/.claude/mcp-servers/fast-bash && bun install

# Restart Claude Code
```

Then add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "fast-bash": {
      "command": "bun",
      "args": ["run", "/home/YOUR_USERNAME/.claude/mcp-servers/fast-bash/src/index.ts"],
      "env": {
        "FAST_BASH_DEFAULT_CWD": "${PWD}"
      }
    }
  }
}
```

## Configuration

### 1. MCP Server Configuration (~/.claude.json)

Add `mcpServers` to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "fast-bash": {
      "command": "bun",
      "args": ["run", "/path/to/fast-bash-mcp/src/index.ts"],
      "env": {
        "FAST_BASH_DEFAULT_CWD": "${PWD}"
      }
    }
  }
}
```

### 2. Disable Built-in Bash (Optional)

Add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Bash"]
  }
}
```

### 3. Instruct Claude to Use Fast Bash

Add to `~/.claude/CLAUDE.md`:

```markdown
BASH COMMANDS 0. ALWAYS use fast-bash MCP tools instead of the built-in Bash tool.

1. Use mcp**fast-bash**fast_bash for single commands
2. Use mcp**fast-bash**fast_bash_parallel for multiple independent commands
3. Use mcp**fast-bash**fast_bash_bg for long-running commands (builds, servers)
4. Use mcp**fast-bash**fast_bash_bg_status to check background task status
5. Commands run from project directory by default. Pass cwd parameter to override.
```

## Usage Examples

### Single Command

```json
{
  "command": "git status",
  "description": "Check git status"
}
```

### Parallel Commands

```json
{
  "commands": [
    { "command": "git status", "description": "Git status" },
    { "command": "npm test", "description": "Run tests" },
    { "command": "npm run build", "description": "Build project" }
  ],
  "default_cwd": "/path/to/project"
}
```

### Background Task

```json
// Start
{"command": "npm run dev", "description": "Dev server"}
// Returns: task_id: "task_1"

// Check status
{"task_id": "task_1", "action": "status"}

// Get output
{"task_id": "task_1", "action": "output"}

// Kill
{"task_id": "task_1", "action": "kill"}

// List all
{"action": "list"}
```

## How It Works

### Claude Code's Bash Tool

```
Command -> Haiku LLM (prefix extraction) -> Execute -> Haiku LLM (path extraction) -> Result
           ~15-30 seconds                              ~15-30 seconds
```

### Fast Bash MCP

```
Command -> Execute -> Result
           ~50ms
```

The MCP server uses Node.js `child_process.spawn` directly, bypassing all LLM-based checks.

## Working Directory Behavior

- Commands run from **project directory** by default (where Claude Code was started)
- `${PWD}` is captured when Claude Code launches and passed via env var
- Unlike Claude's Bash, `cd` does **not persist** between calls
- Use `cd dir && command` or pass explicit `cwd` parameter

## Comparison with Built-in Bash

| Feature               | Built-in Bash    | Fast Bash MCP      |
| --------------------- | ---------------- | ------------------ |
| Speed                 | 30+ seconds      | ~50ms              |
| Pre-flight LLM check  | Yes              | No                 |
| Post-flight LLM check | Yes              | No                 |
| Sandbox               | Yes (bubblewrap) | No                 |
| cwd persistence       | Yes              | No                 |
| Background execution  | Yes              | Yes                |
| Output truncation     | Yes (30k)        | Yes (configurable) |
| Parallel commands     | No               | Yes                |

## Requirements

- [Bun](https://bun.sh/) runtime
- Claude Code 2.0+

## License

MIT

## Contributing

PRs welcome! Please open an issue first to discuss changes.
