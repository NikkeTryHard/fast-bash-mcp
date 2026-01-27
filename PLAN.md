# Fast-Bash MCP Improvements Plan

## Overview
Adding 9 features to enhance fast-bash for AI assistants. Focus on DRY code and consistent output formatting.

## Confirmed Design Choices
- Error Classification: Minimal (standard shell-compatible types)
- Cleanup Strategy: Hybrid (time-based auto + manual cleanup action)
- Sequence Failure: Full control (stop_on_failure + continue_on_codes)
- Output File: All tools support output_file parameter

---

## Batch 1: Core Infrastructure (DRY + Error Types + CWD Validation)

### 1.1 DRY Output Formatting
Create centralized formatting functions to ensure consistency across all tools.

**New helper functions:**
```typescript
// Format command line with $ prefix
function formatCommandLine(command: string): string

// Format timing
function formatTiming(durationMs: number): string

// Format full output (command + body + timing)
function formatFullOutput(command: string, body: string, durationMs: number): string
```

**Refactor existing code:**
- `fast_bash` - use formatFullOutput
- `fast_bash_parallel` - use formatCommandLine, formatTiming
- `fast_bash_bg` - use formatCommandLine
- `fast_bash_bg_status` output action - use formatFullOutput

### 1.2 Error Type Classification
Add error_type field to command results.

**Types (shell-standard):**
- `timeout` - killed by our timeout
- `killed` - received signal (SIGTERM/SIGKILL)
- `spawn_error` - failed to start process
- `command_not_found` - exit code 127
- `permission_denied` - exit code 126
- `cwd_not_found` - ENOENT on cwd

**Changes:**
- Update `executeCommand()` return type to include `error_type?: string`
- Update `formatResult()` to include error_type in output
- Detect error types from exit codes and spawn errors

### 1.3 CWD Validation
Pre-validate working directory before spawning.

**Changes:**
- Add `fs.existsSync(cwd)` check in `executeCommand()`
- Return early with `error_type: "cwd_not_found"` if invalid
- Clear error message: `[error]: Working directory does not exist: /path`

---

## Batch 2: Parallel Improvements

### 2.1 Consistent [N] Prefix
Always show index prefix for easy reference.

**Current:** `=== Description ===` or `=== Command 1 ===`
**New:** `[1] === Description ===` or `[1] === Command 1 ===`

### 2.2 Failure Summary
Add summary block at end of parallel output.

**Format:**
```
=== Summary ===
Total: 1523ms | Succeeded: 4 | Failed: 1
Failed: [2]
Longest: [3] npm test (1200ms)
```

### 2.3 Changes
- Update output formatting in `fast_bash_parallel` case
- Track succeeded/failed counts
- Track longest command
- Calculate total execution time

---

## Batch 3: Background Task Improvements

### 3.1 Tail Output (tail_lines parameter)
Add `tail_lines` parameter to `fast_bash_bg_status`.

**New parameter:**
```typescript
tail_lines?: number;  // Return only last N lines of output
```

**Behavior:**
- If `tail_lines` provided, split stdout by newlines and take last N
- Apply before max_output truncation
- Useful for checking server startup logs

### 3.2 Auto-Cleanup
Clean old completed tasks automatically.

**Environment variable:**
```
FAST_BASH_TASK_RETENTION_HOURS=24  (default)
```

**Implementation:**
- On each `fast_bash_bg` call, run cleanup check
- Remove completed tasks older than retention period
- Only clean completed tasks, never running ones

### 3.3 Manual Cleanup Action
Add `cleanup` action to `fast_bash_bg_status`.

**New action:**
```typescript
action: "cleanup"
older_than_hours?: number;  // default: 1
```

**Output:**
```
Cleaned up 3 tasks older than 1 hour
Remaining: 2 tasks (1 running, 1 completed)
```

### 3.4 Schema Updates
Update `fast_bash_bg_status` inputSchema:
- Add `tail_lines` parameter
- Add `cleanup` to action enum
- Add `older_than_hours` parameter

---

## Batch 4: fast_bash_sequence Tool

### 4.1 New Tool Definition
Sequential command execution in a **single shell session** (stateful).

**Key difference from parallel:**
- `fast_bash_parallel` → Stateless (concurrent, isolated processes)
- `fast_bash_sequence` → Stateful (single shell, `cd`/`export` persist)

**Parameters:**
```typescript
{
  commands: Array<{
    command: string;
    description?: string;
  }>;
  stop_on_failure?: boolean;      // default: true
  continue_on_codes?: number[];   // e.g., [0, 1] to allow grep "not found"
  cwd?: string;                   // initial working directory
  timeout?: number;               // overall timeout for all commands
  shell?: string;
  env?: Record<string, string>;
}
```

### 4.2 Behavior
- Execute all commands in a SINGLE shell session (stateful)
- `cd /foo` in command 1 affects command 2
- `export VAR=val` persists for later commands
- After each command, check exit code via `||` trap
- If `stop_on_failure` and exit code not in `continue_on_codes`, stop
- Single overall timeout (not per-command)

### 4.3 Implementation Approach
Build a shell script that:
1. Runs each command
2. Captures exit code after each
3. Echoes markers between commands for parsing
4. Stops on failure if configured

```bash
# Generated script example:
set -o pipefail
echo "===CMD_START:1==="
cd /foo
__ec=$?; echo "===CMD_END:1:$__ec==="; [ $__ec -eq 0 ] || exit $__ec
echo "===CMD_START:2==="
npm install
__ec=$?; echo "===CMD_END:2:$__ec==="; [ $__ec -eq 0 ] || exit $__ec
```

Then parse output by markers to split per-command results.

### 4.3 Output Format
```
[1] === npm install ===
$ npm install
{output}
[exit code: 0]
[1523ms]

[2] === npm build ===
$ npm run build
{output}
[exit code: 0]
[3241ms]

[3] === npm test ===
$ npm test
{output}
[exit code: 1]
[stopped - exit code 1 not in continue_on_codes]
[892ms]

=== Summary ===
Total: 5656ms | Executed: 3/5 | Succeeded: 2 | Failed: 1
Stopped at: [3] npm test
```

---

## Batch 5: Output File + Graceful Timeout

### 5.1 Output File Redirection
Add `output_file` and `stderr_file` parameters to all tools.

**New parameters:**
```typescript
output_file?: string;   // Write full stdout to this file
stderr_file?: string;   // Write full stderr to this file
```

**Behavior:**
- Write BEFORE truncation (full output)
- Still return truncated output in response
- Add `[stdout saved to: /path]` in response

**Tools to update:**
- `fast_bash`
- `fast_bash_parallel` (per-command or combined?)
- `fast_bash_sequence`
- `fast_bash_bg_status` output action

### 5.2 Graceful Timeout
Send SIGTERM first, then SIGKILL after grace period.

**Current:** Immediate SIGTERM on timeout
**New:** SIGTERM → wait 5s → SIGKILL if still running

**Changes to executeCommand():**
```typescript
const timer = setTimeout(() => {
  killed = true;
  proc.kill("SIGTERM");

  // Grace period before SIGKILL
  setTimeout(() => {
    if (!completed) {
      proc.kill("SIGKILL");
      forceKilled = true;
    }
  }, 5000);
}, timeout);
```

**Output change:**
- `[timeout after 30000ms]` → `[timeout after 30000ms, SIGTERM]`
- `[timeout after 35000ms, SIGKILL]` if force killed

---

## File Changes Summary

| File | Changes |
|------|---------|
| src/index.ts | All changes (single file project) |

## New Interfaces

```typescript
interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  killed: boolean;
  forceKilled?: boolean;  // NEW: SIGKILL after grace period
  error_type?: string;    // NEW: timeout | killed | spawn_error | command_not_found | permission_denied | cwd_not_found
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| FAST_BASH_DEFAULT_CWD | process.cwd() | Default working directory |
| FAST_BASH_TASK_RETENTION_HOURS | 24 | Auto-cleanup completed tasks older than this |

---

## Execution Order

1. **Batch 1** - Core infrastructure first (other batches depend on DRY helpers)
2. **Batch 2** - Parallel improvements (standalone)
3. **Batch 3** - Background task improvements (standalone)
4. **Batch 4** - Sequence tool (uses helpers from Batch 1)
5. **Batch 5** - Output file + graceful timeout (touches executeCommand)
