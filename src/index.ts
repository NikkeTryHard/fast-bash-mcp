#!/usr/bin/env bun
/**
 * Fast Bash MCP Server v3.0
 * Provides direct bash execution tools that bypass Claude Code's
 * slow haiku-based pre-flight checks.
 *
 * Features:
 * - fast_bash: Single command execution
 * - fast_bash_parallel: Multiple commands in parallel
 * - fast_bash_sequence: Sequential commands in a single shell session (stateful)
 * - fast_bash_bg: Background execution with task tracking
 * - fast_bash_bg_status: Check background task status
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";

const server = new Server(
  {
    name: "fast-bash",
    version: "3.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// =============================================================================
// Types
// =============================================================================

type ErrorType = "timeout" | "killed" | "spawn_error" | "command_not_found" | "permission_denied" | "cwd_not_found" | undefined;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  killed: boolean;
  forceKilled: boolean;
  error_type?: ErrorType;
  durationMs?: number;
}

interface BackgroundTask {
  id: string;
  command: string;
  description?: string;
  startTime: number;
  completedTime?: number;
  process: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  completed: boolean;
  killed: boolean;
  error_type?: ErrorType;
}

// =============================================================================
// Constants
// =============================================================================

const backgroundTasks = new Map<string, BackgroundTask>();
let taskIdCounter = 0;

// Default working directory: env var > process.cwd() > HOME > /tmp
const DEFAULT_CWD = process.env.FAST_BASH_DEFAULT_CWD || process.cwd() || process.env.HOME || "/tmp";

// Task retention for auto-cleanup (hours)
const TASK_RETENTION_HOURS = parseInt(process.env.FAST_BASH_TASK_RETENTION_HOURS || "24", 10);

// Grace period before SIGKILL (ms)
const GRACEFUL_TIMEOUT_MS = 5000;

// Reserved characters for truncation ellipsis
const TRUNCATION_ELLIPSIS_RESERVE = 50;

// Exit code for timeout (shell convention)
const EXIT_CODE_TIMEOUT = 124;

// Maximum buffer size for background task output (1MB)
const MAX_BG_BUFFER = 1_000_000;

// Valid shells for validation
const VALID_SHELLS = ["bash", "zsh", "sh"] as const;

// Default timeout for sequence commands (5 minutes)
const DEFAULT_SEQUENCE_TIMEOUT = 300000;

// Unique marker prefix for sequence parsing (unlikely to appear in normal output)
const MARKER_PREFIX = "__FASTBASH_7f3a9c2e_";

// =============================================================================
// Batch 1.1: DRY Output Formatting
// =============================================================================

/**
 * Format command line with $ prefix
 */
function formatCommandLine(command: string): string {
  return `$ ${command}`;
}

/**
 * Format timing
 */
function formatTiming(durationMs: number): string {
  return `[${durationMs}ms]`;
}

/**
 * Format full output (command + body + timing)
 */
function formatFullOutput(command: string, body: string, durationMs: number): string {
  return `${formatCommandLine(command)}\n${body}\n${formatTiming(durationMs)}`;
}

/**
 * Middle-truncate output to preserve beginning and end
 */
function middleTruncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const halfLength = Math.floor((maxLength - TRUNCATION_ELLIPSIS_RESERVE) / 2);
  const start = text.slice(0, halfLength);
  const end = text.slice(-halfLength);
  const truncatedBytes = text.length - maxLength;

  return `${start}\n\n... [truncated ${truncatedBytes} characters] ...\n\n${end}`;
}

/**
 * Classify error type from exit code and error conditions
 */
function classifyErrorType(exitCode: number | null, killed: boolean, forceKilled: boolean, spawnError?: Error, cwdError?: boolean): ErrorType {
  if (cwdError) return "cwd_not_found";
  if (spawnError) {
    if ((spawnError as NodeJS.ErrnoException).code === "ENOENT") return "spawn_error";
    return "spawn_error";
  }
  if (killed) return forceKilled ? "killed" : "timeout";
  if (exitCode === 127) return "command_not_found";
  if (exitCode === 126) return "permission_denied";
  return undefined;
}

/**
 * Format command result for output (Batch 1.2: includes error_type)
 */
function formatResult(
  result: CommandResult,
  options: {
    description?: string;
    timeout?: number;
    command?: string;
    showTiming?: boolean;
  } = {},
): string {
  const { description, timeout, command, showTiming = false } = options;
  let output = "";

  if (description) output += `--- ${description} ---\n`;
  if (command) output += `${formatCommandLine(command)}\n`;
  if (result.stdout) output += result.stdout;
  if (result.stderr) output += `\n[stderr]: ${result.stderr}`;

  if (result.killed) {
    if (result.forceKilled) {
      output += `\n[timeout after ${(timeout || 30000) + GRACEFUL_TIMEOUT_MS}ms, SIGKILL]`;
    } else {
      output += `\n[timeout after ${timeout || 30000}ms, SIGTERM]`;
    }
  }

  if (result.error_type && result.error_type !== "timeout") {
    output += `\n[error_type: ${result.error_type}]`;
  }

  output += `\n[exit code: ${result.exitCode}]`;

  if (showTiming && result.durationMs !== undefined) {
    output += `\n${formatTiming(result.durationMs)}`;
  }

  return output.trim() || "(no output)";
}

// =============================================================================
// Batch 5.1: File Output Helper
// =============================================================================

/**
 * Write output to file (before truncation)
 * Returns error message on failure, undefined on success
 */
function writeOutputToFile(filePath: string, content: string): string | undefined {
  try {
    fs.writeFileSync(filePath, content, "utf8");
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

// =============================================================================
// Batch 1.3: CWD Validation + Batch 5.2: Graceful Timeout
// =============================================================================

/**
 * Execute a command and return result
 */
function executeCommand(options: { command: string; cwd?: string; timeout?: number; shell?: string; env?: Record<string, string>; stdin?: string; maxOutput?: number; outputFile?: string; stderrFile?: string }): Promise<CommandResult> {
  const { command, cwd = DEFAULT_CWD, timeout = 30000, shell = "bash", env, stdin, maxOutput = 30000, outputFile, stderrFile } = options;

  return new Promise((resolve) => {
    const startTime = Date.now();

    // Validate shell parameter
    if (!VALID_SHELLS.includes(shell as (typeof VALID_SHELLS)[number])) {
      resolve({
        stdout: "",
        stderr: `[error]: Invalid shell: ${shell}. Must be one of: ${VALID_SHELLS.join(", ")}`,
        exitCode: 1,
        killed: false,
        forceKilled: false,
        error_type: "spawn_error",
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // Batch 1.3: CWD Validation
    if (!fs.existsSync(cwd)) {
      resolve({
        stdout: "",
        stderr: `[error]: Working directory does not exist: ${cwd}`,
        exitCode: 1,
        killed: false,
        forceKilled: false,
        error_type: "cwd_not_found",
        durationMs: Date.now() - startTime,
      });
      return;
    }

    const mergedEnv = { ...process.env, ...env };

    let proc: ChildProcess;
    try {
      proc = spawn(shell, ["-c", command], {
        cwd,
        env: mergedEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: `[error]: Failed to spawn process: ${(err as Error).message}`,
        exitCode: 1,
        killed: false,
        forceKilled: false,
        error_type: "spawn_error",
        durationMs: Date.now() - startTime,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;
    let forceKilled = false;
    let completed = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    // Batch 5.2: Graceful Timeout - SIGTERM first, then SIGKILL after grace period
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");

      // Grace period before SIGKILL
      graceTimer = setTimeout(() => {
        if (!completed) {
          proc.kill("SIGKILL");
          forceKilled = true;
        }
      }, GRACEFUL_TIMEOUT_MS);
    }, timeout);

    if (stdin) {
      proc.stdin?.write(stdin);
      proc.stdin?.end();
    }

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      completed = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      const durationMs = Date.now() - startTime;

      // Batch 5.1: Write to files BEFORE truncation
      if (outputFile) {
        writeOutputToFile(outputFile, stdout);
      }
      if (stderrFile) {
        writeOutputToFile(stderrFile, stderr);
      }

      // Apply truncation for response
      let truncatedStdout = stdout;
      let truncatedStderr = stderr;
      if (truncatedStdout.length > maxOutput) {
        truncatedStdout = middleTruncate(truncatedStdout, maxOutput);
      }
      if (truncatedStderr.length > maxOutput) {
        truncatedStderr = middleTruncate(truncatedStderr, maxOutput);
      }

      const error_type = classifyErrorType(code, killed, forceKilled);

      resolve({
        stdout: truncatedStdout,
        stderr: truncatedStderr,
        exitCode: killed ? EXIT_CODE_TIMEOUT : code,
        killed,
        forceKilled,
        error_type,
        durationMs,
      });
    });

    proc.on("error", (err) => {
      completed = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      const durationMs = Date.now() - startTime;

      resolve({
        stdout: "",
        stderr: err.message,
        exitCode: 1,
        killed: false,
        forceKilled: false,
        error_type: classifyErrorType(1, false, false, err),
        durationMs,
      });
    });
  });
}

// =============================================================================
// Batch 3.2: Auto-Cleanup for Background Tasks
// =============================================================================

/**
 * Clean up old completed tasks
 */
function cleanupOldTasks(olderThanHours: number = TASK_RETENTION_HOURS): { cleaned: number; remaining: number; running: number; completed: number } {
  const cutoffTime = Date.now() - olderThanHours * 60 * 60 * 1000;
  let cleaned = 0;
  let running = 0;
  let completed = 0;

  for (const [taskId, task] of backgroundTasks) {
    if (task.completed) {
      const endTime = task.completedTime || task.startTime;
      if (endTime < cutoffTime) {
        backgroundTasks.delete(taskId);
        cleaned++;
      } else {
        completed++;
      }
    } else {
      running++;
    }
  }

  return { cleaned, remaining: backgroundTasks.size, running, completed };
}

// =============================================================================
// Batch 4: fast_bash_sequence Implementation
// =============================================================================

interface SequenceCommandResult {
  index: number;
  command: string;
  description?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  stopped?: boolean;
  stopReason?: string;
}

/**
 * Execute commands sequentially in a single shell session (stateful)
 */
async function executeSequence(options: { commands: Array<{ command: string; description?: string }>; stopOnFailure?: boolean; continueOnCodes?: number[]; cwd?: string; timeout?: number; shell?: string; env?: Record<string, string>; maxOutput?: number; outputFile?: string }): Promise<{
  results: SequenceCommandResult[];
  totalDurationMs: number;
  succeeded: number;
  failed: number;
  executed: number;
  stoppedAt?: number;
}> {
  const { commands, stopOnFailure = true, continueOnCodes = [0], cwd = DEFAULT_CWD, timeout = DEFAULT_SEQUENCE_TIMEOUT, shell = "bash", env, maxOutput = 30000, outputFile } = options;

  const startTime = Date.now();

  // Validate shell parameter
  if (!VALID_SHELLS.includes(shell as (typeof VALID_SHELLS)[number])) {
    return {
      results: [
        {
          index: 0,
          command: commands[0]?.command || "",
          stdout: "",
          stderr: `[error]: Invalid shell: ${shell}. Must be one of: ${VALID_SHELLS.join(", ")}`,
          exitCode: 1,
          durationMs: 0,
          stopped: true,
          stopReason: "spawn_error",
        },
      ],
      totalDurationMs: 0,
      succeeded: 0,
      failed: 1,
      executed: 0,
      stoppedAt: 0,
    };
  }

  // Empty commands validation
  if (commands.length === 0) {
    return {
      results: [],
      totalDurationMs: 0,
      succeeded: 0,
      failed: 0,
      executed: 0,
    };
  }

  // CWD Validation
  if (!fs.existsSync(cwd)) {
    return {
      results: [
        {
          index: 0,
          command: commands[0]?.command || "",
          stdout: "",
          stderr: `[error]: Working directory does not exist: ${cwd}`,
          exitCode: 1,
          durationMs: 0,
          stopped: true,
          stopReason: "cwd_not_found",
        },
      ],
      totalDurationMs: 0,
      succeeded: 0,
      failed: 1,
      executed: 0,
      stoppedAt: 0,
    };
  }

  // Build shell script with markers
  const scriptLines: string[] = ["set -o pipefail"];

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const idx = i + 1;
    scriptLines.push(`echo "${MARKER_PREFIX}START:${idx}:$(date +%s%3N)"`);
    scriptLines.push(cmd.command);
    scriptLines.push(`__ec=$?; echo "${MARKER_PREFIX}END:${idx}:$__ec:$(date +%s%3N)"`);

    if (stopOnFailure) {
      // Check if exit code is in continue_on_codes
      const codesCheck = continueOnCodes.map((c) => `$__ec -eq ${c}`).join(" -o ");
      scriptLines.push(`if ! [ ${codesCheck} ]; then exit $__ec; fi`);
    }
  }

  const script = scriptLines.join("\n");

  const mergedEnv = { ...process.env, ...env };

  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(shell, ["-c", script], {
        cwd,
        env: mergedEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        results: [
          {
            index: 0,
            command: commands[0]?.command || "",
            stdout: "",
            stderr: `[error]: Failed to spawn process: ${(err as Error).message}`,
            exitCode: 1,
            durationMs: 0,
            stopped: true,
            stopReason: "spawn_error",
          },
        ],
        totalDurationMs: 0,
        succeeded: 0,
        failed: 1,
        executed: 0,
        stoppedAt: 0,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;
    let completed = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      graceTimer = setTimeout(() => {
        if (!completed) {
          proc.kill("SIGKILL");
        }
      }, GRACEFUL_TIMEOUT_MS);
    }, timeout);

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", () => {
      completed = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      const totalDurationMs = Date.now() - startTime;

      // Write full output to file before truncation
      if (outputFile) {
        writeOutputToFile(outputFile, stdout);
      }

      // Parse output by markers
      const results: SequenceCommandResult[] = [];
      let succeeded = 0;
      let failed = 0;
      let stoppedAt: number | undefined;

      for (let i = 0; i < commands.length; i++) {
        const idx = i + 1;
        const cmd = commands[i];

        const startMarkerRegex = new RegExp(`${MARKER_PREFIX}START:${idx}:(\\d+)`);
        const endMarkerRegex = new RegExp(`${MARKER_PREFIX}END:${idx}:(\\d+):(\\d+)`);

        const startMatch = stdout.match(startMarkerRegex);
        const endMatch = stdout.match(endMarkerRegex);

        if (!startMatch) {
          // Command didn't start - stopped before this point
          if (stoppedAt === undefined) stoppedAt = i;
          break;
        }

        const startMs = parseInt(startMatch[1], 10);
        let cmdOutput = "";
        let exitCode = 0;
        let durationMs = 0;

        if (endMatch) {
          exitCode = parseInt(endMatch[1], 10);
          const endMs = parseInt(endMatch[2], 10);
          durationMs = endMs - startMs;

          // Extract output between markers
          const startIdx = stdout.indexOf(startMatch[0]) + startMatch[0].length;
          const endIdx = stdout.indexOf(endMatch[0]);
          cmdOutput = stdout.slice(startIdx, endIdx).trim();
        } else {
          // Command started but didn't finish - timeout or crash
          const startIdx = stdout.indexOf(startMatch[0]) + startMatch[0].length;
          cmdOutput = stdout.slice(startIdx).trim();
          exitCode = killed ? EXIT_CODE_TIMEOUT : 1;
          durationMs = totalDurationMs;
          stoppedAt = i;
        }

        // Truncate individual command output
        if (cmdOutput.length > maxOutput) {
          cmdOutput = middleTruncate(cmdOutput, maxOutput);
        }

        const isContinueCode = continueOnCodes.includes(exitCode);
        if (isContinueCode) {
          succeeded++;
        } else {
          failed++;
          if (stopOnFailure && stoppedAt === undefined) {
            stoppedAt = i;
          }
        }

        const result: SequenceCommandResult = {
          index: idx,
          command: cmd.command,
          description: cmd.description,
          stdout: cmdOutput,
          stderr: "", // stderr is combined for the whole script
          exitCode,
          durationMs,
        };

        if (stoppedAt === i) {
          result.stopped = true;
          result.stopReason = killed ? "timeout" : `exit code ${exitCode} not in continue_on_codes`;
        }

        results.push(result);

        if (stoppedAt !== undefined) break;
      }

      // Distribute stderr (best effort - assign to last executed command)
      if (stderr && results.length > 0) {
        results[results.length - 1].stderr = stderr.length > maxOutput ? middleTruncate(stderr, maxOutput) : stderr;
      }

      resolve({
        results,
        totalDurationMs,
        succeeded,
        failed,
        executed: results.length,
        stoppedAt,
      });
    });

    proc.on("error", (err) => {
      completed = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);

      resolve({
        results: [
          {
            index: 1,
            command: commands[0]?.command || "",
            stdout: "",
            stderr: err.message,
            exitCode: 1,
            durationMs: 0,
            stopped: true,
            stopReason: "spawn_error",
          },
        ],
        totalDurationMs: Date.now() - startTime,
        succeeded: 0,
        failed: 1,
        executed: 0,
        stoppedAt: 0,
      });
    });
  });
}

// =============================================================================
// Tool Definitions
// =============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "fast_bash",
        description: "Execute a bash command directly without pre-flight LLM checks. Use this for fast command execution when you need immediate results. Returns stdout, stderr, and exit code.",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The bash command to execute",
            },
            cwd: {
              type: "string",
              description: "Working directory (optional, defaults to project directory)",
            },
            timeout: {
              type: "number",
              description: "Timeout in milliseconds (optional, default 30000, max 600000)",
            },
            description: {
              type: "string",
              description: "Short description of what this command does (for logging)",
            },
            shell: {
              type: "string",
              description: "Shell to use: bash, zsh, or sh (default: bash)",
              enum: ["bash", "zsh", "sh"],
            },
            env: {
              type: "object",
              description: "Additional environment variables to set",
              additionalProperties: { type: "string" },
            },
            stdin: {
              type: "string",
              description: "Input to pipe to the command's stdin",
            },
            max_output: {
              type: "number",
              description: "Maximum output length before middle-truncation (default 30000)",
            },
            output_file: {
              type: "string",
              description: "File path to save full stdout (before truncation)",
            },
            stderr_file: {
              type: "string",
              description: "File path to save full stderr (before truncation)",
            },
          },
          required: ["command"],
        },
      },
      {
        name: "fast_bash_parallel",
        description: "Execute multiple bash commands in parallel. Returns all results together. Use this when you have independent commands that can run concurrently.",
        inputSchema: {
          type: "object",
          properties: {
            commands: {
              type: "array",
              description: "Array of commands to execute in parallel",
              items: {
                type: "object",
                properties: {
                  command: { type: "string", description: "The bash command" },
                  description: { type: "string", description: "Short description" },
                  cwd: { type: "string", description: "Working directory" },
                  timeout: { type: "number", description: "Timeout in ms" },
                  shell: { type: "string", enum: ["bash", "zsh", "sh"] },
                  env: { type: "object", additionalProperties: { type: "string" } },
                },
                required: ["command"],
              },
            },
            default_cwd: {
              type: "string",
              description: "Default working directory for all commands",
            },
            default_timeout: {
              type: "number",
              description: "Default timeout for all commands (default 30000)",
            },
            output_file: {
              type: "string",
              description: "File path to save combined full output (before truncation)",
            },
          },
          required: ["commands"],
        },
      },
      {
        name: "fast_bash_sequence",
        description: "Execute commands sequentially in a SINGLE shell session (stateful). Unlike parallel, cd/export commands persist between steps. Use for workflows where commands depend on each other. Note: stderr is combined for the whole script and assigned to the last executed command.",
        inputSchema: {
          type: "object",
          properties: {
            commands: {
              type: "array",
              description: "Array of commands to execute sequentially in one shell",
              items: {
                type: "object",
                properties: {
                  command: { type: "string", description: "The bash command" },
                  description: { type: "string", description: "Short description" },
                },
                required: ["command"],
              },
            },
            stop_on_failure: {
              type: "boolean",
              description: "Stop execution if a command fails (default: true)",
            },
            continue_on_codes: {
              type: "array",
              description: "Exit codes that are considered success (default: [0])",
              items: { type: "number" },
            },
            cwd: {
              type: "string",
              description: "Initial working directory",
            },
            timeout: {
              type: "number",
              description: "Overall timeout for all commands in ms (default: 300000)",
            },
            shell: {
              type: "string",
              description: "Shell to use: bash, zsh, or sh (default: bash)",
              enum: ["bash", "zsh", "sh"],
            },
            env: {
              type: "object",
              description: "Additional environment variables to set",
              additionalProperties: { type: "string" },
            },
            output_file: {
              type: "string",
              description: "File path to save full output (before truncation)",
            },
          },
          required: ["commands"],
        },
      },
      {
        name: "fast_bash_bg",
        description: "Start a bash command in the background. Returns a task_id immediately. Use fast_bash_bg_status to check on the task later. Good for long-running commands like builds or servers.",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The bash command to execute in background",
            },
            description: {
              type: "string",
              description: "Short description of the task",
            },
            cwd: {
              type: "string",
              description: "Working directory (optional, defaults to project directory)",
            },
            shell: {
              type: "string",
              description: "Shell to use: bash, zsh, or sh (default: bash)",
              enum: ["bash", "zsh", "sh"],
            },
            env: {
              type: "object",
              description: "Additional environment variables to set",
              additionalProperties: { type: "string" },
            },
          },
          required: ["command"],
        },
      },
      {
        name: "fast_bash_bg_status",
        description: "Check status of a background task, get its output, kill it, list all tasks, or cleanup old tasks.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "The task ID returned by fast_bash_bg",
            },
            action: {
              type: "string",
              description: "Action to take: status (default), output, kill, list, cleanup",
              enum: ["status", "output", "kill", "list", "cleanup"],
            },
            max_output: {
              type: "number",
              description: "Maximum output length (default 30000)",
            },
            tail_lines: {
              type: "number",
              description: "Only return last N lines of output (for output action)",
            },
            older_than_hours: {
              type: "number",
              description: "For cleanup action: remove tasks older than N hours (default: 1)",
            },
            output_file: {
              type: "string",
              description: "File path to save full output (before truncation, for output action)",
            },
          },
          required: [],
        },
      },
    ],
  };
});

// =============================================================================
// Tool Handlers
// =============================================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments as Record<string, unknown>;

  switch (toolName) {
    // =========================================================================
    // fast_bash
    // =========================================================================
    case "fast_bash": {
      const command = args.command as string;
      const timeout = Math.min((args.timeout as number) || 30000, 600000);

      const result = await executeCommand({
        command,
        cwd: args.cwd as string | undefined,
        timeout,
        shell: (args.shell as string) || "bash",
        env: args.env as Record<string, string> | undefined,
        stdin: args.stdin as string | undefined,
        maxOutput: (args.max_output as number) || 30000,
        outputFile: args.output_file as string | undefined,
        stderrFile: args.stderr_file as string | undefined,
      });

      // Use formatFullOutput for DRY consistency
      let output = formatResult(result, {
        description: args.description as string,
        timeout,
        command,
        showTiming: true,
      });

      // Add file save notices
      if (args.output_file) {
        output += `\n[stdout saved to: ${args.output_file}]`;
      }
      if (args.stderr_file) {
        output += `\n[stderr saved to: ${args.stderr_file}]`;
      }

      return {
        content: [{ type: "text", text: output }],
      };
    }

    // =========================================================================
    // fast_bash_parallel (Batch 2: [N] prefix + Summary)
    // =========================================================================
    case "fast_bash_parallel": {
      const commands = args.commands as Array<{
        command: string;
        description?: string;
        cwd?: string;
        timeout?: number;
        shell?: string;
        env?: Record<string, string>;
      }>;
      const defaultCwd = args.default_cwd as string | undefined;
      const defaultTimeout = (args.default_timeout as number) || 30000;
      const outputFile = args.output_file as string | undefined;

      const overallStart = Date.now();

      const promises = commands.map((cmd, index) => {
        const startTime = Date.now();
        return executeCommand({
          command: cmd.command,
          cwd: cmd.cwd || defaultCwd,
          timeout: cmd.timeout || defaultTimeout,
          shell: cmd.shell || "bash",
          env: cmd.env,
          maxOutput: 30000,
        }).then((result) => ({
          index,
          command: cmd.command,
          description: cmd.description,
          result,
          duration: Date.now() - startTime,
        }));
      });

      const results = await Promise.all(promises);
      const overallDuration = Date.now() - overallStart;

      // Track stats for summary
      let succeeded = 0;
      let failed = 0;
      const failedIndices: number[] = [];
      let longestIdx = 0;
      let longestDuration = 0;
      let longestDesc = "";

      // Batch 2.1: Always show [N] prefix
      const maxOutputPerCmd = 10000; // Limit per command to prevent massive output
      const outputParts = results.map((r) => {
        const idx = r.index + 1;
        const header = r.description ? `[${idx}] === ${r.description} ===` : `[${idx}] === Command ${idx} ===`;

        const cmdLine = formatCommandLine(r.command);

        let body = "";
        if (r.result.stdout) {
          body += r.result.stdout.length > maxOutputPerCmd ? middleTruncate(r.result.stdout, maxOutputPerCmd) : r.result.stdout;
        }
        if (r.result.stderr) {
          const stderrContent = r.result.stderr.length > maxOutputPerCmd ? middleTruncate(r.result.stderr, maxOutputPerCmd) : r.result.stderr;
          body += `\n[stderr]: ${stderrContent}`;
        }
        if (r.result.killed) {
          if (r.result.forceKilled) {
            body += `\n[timeout, SIGKILL]`;
          } else {
            body += `\n[timeout, SIGTERM]`;
          }
        }
        if (r.result.error_type && r.result.error_type !== "timeout") {
          body += `\n[error_type: ${r.result.error_type}]`;
        }
        body += `\n[exit code: ${r.result.exitCode}]`;

        const timing = formatTiming(r.duration);

        // Track stats
        if (r.result.exitCode === 0) {
          succeeded++;
        } else {
          failed++;
          failedIndices.push(idx);
        }

        if (r.duration > longestDuration) {
          longestDuration = r.duration;
          longestIdx = idx;
          longestDesc = r.description || r.command.slice(0, 30);
        }

        return `${header}\n${cmdLine}\n${body.trim()}\n${timing}`;
      });

      // Batch 2.2: Failure Summary
      let summary = `\n=== Summary ===\nTotal: ${overallDuration}ms | Succeeded: ${succeeded} | Failed: ${failed}`;
      if (failedIndices.length > 0) {
        summary += `\nFailed: [${failedIndices.join(", ")}]`;
      }
      summary += `\nLongest: [${longestIdx}] ${longestDesc} (${longestDuration}ms)`;

      const fullOutput = outputParts.join("\n\n") + summary;

      // Write to file before returning
      if (outputFile) {
        writeOutputToFile(outputFile, fullOutput);
      }

      let response = fullOutput;
      if (outputFile) {
        response += `\n[output saved to: ${outputFile}]`;
      }

      return {
        content: [{ type: "text", text: response }],
      };
    }

    // =========================================================================
    // fast_bash_sequence (Batch 4)
    // =========================================================================
    case "fast_bash_sequence": {
      const commands = args.commands as Array<{ command: string; description?: string }>;
      const stopOnFailure = args.stop_on_failure !== false; // default true
      const continueOnCodes = (args.continue_on_codes as number[]) || [0];
      const cwd = args.cwd as string | undefined;
      const timeout = (args.timeout as number) || 300000;
      const shell = (args.shell as string) || "bash";
      const env = args.env as Record<string, string> | undefined;
      const outputFile = args.output_file as string | undefined;

      const seqResult = await executeSequence({
        commands,
        stopOnFailure,
        continueOnCodes,
        cwd,
        timeout,
        shell,
        env,
        outputFile,
      });

      // Format output per Batch 4.4 spec
      const outputParts = seqResult.results.map((r) => {
        const header = r.description ? `[${r.index}] === ${r.description} ===` : `[${r.index}] === Command ${r.index} ===`;

        const cmdLine = formatCommandLine(r.command);

        let body = "";
        if (r.stdout) body += r.stdout;
        if (r.stderr) body += `\n[stderr]: ${r.stderr}`;
        body += `\n[exit code: ${r.exitCode}]`;

        if (r.stopped && r.stopReason) {
          body += `\n[stopped - ${r.stopReason}]`;
        }

        const timing = formatTiming(r.durationMs);

        return `${header}\n${cmdLine}\n${body.trim()}\n${timing}`;
      });

      // Summary
      let summary = `\n=== Summary ===`;
      summary += `\nTotal: ${seqResult.totalDurationMs}ms | Executed: ${seqResult.executed}/${commands.length} | Succeeded: ${seqResult.succeeded} | Failed: ${seqResult.failed}`;

      if (seqResult.stoppedAt !== undefined) {
        const stoppedCmd = seqResult.results[seqResult.stoppedAt];
        const stoppedDesc = stoppedCmd?.description || stoppedCmd?.command?.slice(0, 30) || "unknown";
        summary += `\nStopped at: [${seqResult.stoppedAt + 1}] ${stoppedDesc}`;
      }

      let response = outputParts.join("\n\n") + summary;

      if (outputFile) {
        response += `\n[output saved to: ${outputFile}]`;
      }

      return {
        content: [{ type: "text", text: response }],
      };
    }

    // =========================================================================
    // fast_bash_bg (Batch 3.2: Auto-cleanup on each call)
    // =========================================================================
    case "fast_bash_bg": {
      // Batch 3.2: Auto-cleanup old tasks
      cleanupOldTasks();

      const taskId = `task_${++taskIdCounter}`;
      const command = args.command as string;
      const description = args.description as string | undefined;
      const cwd = (args.cwd as string) || DEFAULT_CWD;
      const shell = (args.shell as string) || "bash";
      const env = { ...process.env, ...(args.env as Record<string, string>) };

      // Validate CWD
      if (!fs.existsSync(cwd)) {
        return {
          content: [
            {
              type: "text",
              text: `[error]: Working directory does not exist: ${cwd}\n[error_type: cwd_not_found]`,
            },
          ],
        };
      }

      let proc: ChildProcess;
      try {
        proc = spawn(shell, ["-c", command], {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `[error]: Failed to spawn process: ${(err as Error).message}\n[error_type: spawn_error]`,
            },
          ],
        };
      }

      const task: BackgroundTask = {
        id: taskId,
        command,
        description,
        startTime: Date.now(),
        process: proc,
        stdout: "",
        stderr: "",
        exitCode: null,
        completed: false,
        killed: false,
      };

      proc.stdout?.on("data", (data) => {
        task.stdout += data.toString();
        if (task.stdout.length > MAX_BG_BUFFER) {
          task.stdout = task.stdout.slice(-MAX_BG_BUFFER);
        }
      });

      proc.stderr?.on("data", (data) => {
        task.stderr += data.toString();
        if (task.stderr.length > MAX_BG_BUFFER) {
          task.stderr = task.stderr.slice(-MAX_BG_BUFFER);
        }
      });

      proc.on("close", (code) => {
        task.exitCode = code;
        task.completed = true;
        task.completedTime = Date.now();
        task.error_type = classifyErrorType(code, task.killed, false);
      });

      proc.on("error", (err) => {
        task.stderr += `\n[error]: ${err.message}`;
        task.completed = true;
        task.completedTime = Date.now();
        task.exitCode = 1;
        task.error_type = "spawn_error";
      });

      backgroundTasks.set(taskId, task);

      // Close stdin to prevent commands from hanging waiting for input
      proc.stdin?.end();

      // Use formatCommandLine for consistency
      const cmdLine = formatCommandLine(command);
      return {
        content: [
          {
            type: "text",
            text: `Background task started\n[task_id]: ${taskId}\n[command]: ${cmdLine}${description ? `\n[description]: ${description}` : ""}\n\nUse fast_bash_bg_status with task_id="${taskId}" to check status.`,
          },
        ],
      };
    }

    // =========================================================================
    // fast_bash_bg_status (Batch 3: tail_lines, cleanup action)
    // =========================================================================
    case "fast_bash_bg_status": {
      const action = (args.action as string) || "status";
      const maxOutput = (args.max_output as number) || 30000;
      const tailLines = args.tail_lines as number | undefined;
      const olderThanHours = (args.older_than_hours as number) || 1;
      const outputFile = args.output_file as string | undefined;

      // Batch 3.3: Cleanup action
      if (action === "cleanup") {
        const result = cleanupOldTasks(olderThanHours);
        return {
          content: [
            {
              type: "text",
              text: `Cleaned up ${result.cleaned} tasks older than ${olderThanHours} hour${olderThanHours !== 1 ? "s" : ""}\nRemaining: ${result.remaining} tasks (${result.running} running, ${result.completed} completed)`,
            },
          ],
        };
      }

      if (action === "list") {
        if (backgroundTasks.size === 0) {
          return { content: [{ type: "text", text: "No background tasks." }] };
        }

        const list = Array.from(backgroundTasks.values())
          .map((task) => {
            const status = task.completed ? (task.exitCode === 0 ? "completed" : "failed") : "running";
            const runtime = ((Date.now() - task.startTime) / 1000).toFixed(1);
            return `[${task.id}] ${status} (${runtime}s) - ${task.description || task.command.slice(0, 50)}`;
          })
          .join("\n");

        return { content: [{ type: "text", text: list }] };
      }

      const taskId = args.task_id as string;
      if (!taskId) {
        return { content: [{ type: "text", text: "[error]: task_id required for status/output/kill actions" }] };
      }

      const task = backgroundTasks.get(taskId);
      if (!task) {
        return { content: [{ type: "text", text: `[error]: Task ${taskId} not found` }] };
      }

      if (action === "kill") {
        if (task.completed) {
          return { content: [{ type: "text", text: `Task ${taskId} already completed` }] };
        }
        task.killed = true;
        task.process.kill("SIGTERM");

        // Graceful kill with SIGKILL fallback - store timer for potential cancellation
        const killTimer = setTimeout(() => {
          if (!task.completed) {
            task.process.kill("SIGKILL");
          }
        }, GRACEFUL_TIMEOUT_MS);

        // Cancel SIGKILL timer if process exits gracefully
        task.process.once("close", () => {
          clearTimeout(killTimer);
        });

        return { content: [{ type: "text", text: `Task ${taskId} killed (SIGTERM sent, SIGKILL in ${GRACEFUL_TIMEOUT_MS}ms if needed)` }] };
      }

      if (action === "output") {
        let stdout = task.stdout;
        let stderr = task.stderr;
        let outputFileError: string | undefined;

        // Write full output to file before processing
        if (outputFile) {
          outputFileError = writeOutputToFile(outputFile, stdout);
        }

        // Batch 3.1: Apply tail_lines before truncation
        if (tailLines !== undefined && tailLines > 0) {
          const lines = stdout.split("\n");
          if (lines.length > tailLines) {
            stdout = lines.slice(-tailLines).join("\n");
          }
        }

        if (stdout.length > maxOutput) stdout = middleTruncate(stdout, maxOutput);
        if (stderr.length > maxOutput) stderr = middleTruncate(stderr, maxOutput);

        // Use formatFullOutput pattern for consistency
        const duration = Date.now() - task.startTime;
        let output = formatCommandLine(task.command) + "\n";
        if (stdout) output += stdout;
        if (stderr) output += `\n[stderr]: ${stderr}`;

        if (task.completed) {
          if (task.killed) output += "\n[killed]";
          if (task.error_type) output += `\n[error_type: ${task.error_type}]`;
          output += `\n[exit code: ${task.exitCode}]`;
        } else {
          output += "\n[still running...]";
        }

        output += `\n${formatTiming(duration)}`;

        if (outputFile) {
          if (outputFileError) {
            output += `\n[error]: Failed to save output to ${outputFile}: ${outputFileError}`;
          } else {
            output += `\n[full output saved to: ${outputFile}]`;
          }
        }

        return { content: [{ type: "text", text: output.trim() || "(no output yet)" }] };
      }

      // Default: status
      const runtime = ((Date.now() - task.startTime) / 1000).toFixed(1);
      const status = task.completed ? (task.exitCode === 0 ? "completed successfully" : `failed (exit ${task.exitCode})`) : "running";

      let statusOutput = `[task_id]: ${taskId}\n[status]: ${status}\n[runtime]: ${runtime}s\n[command]: ${task.command}`;
      if (task.description) statusOutput += `\n[description]: ${task.description}`;
      if (task.error_type) statusOutput += `\n[error_type]: ${task.error_type}`;
      statusOutput += `\n[stdout bytes]: ${task.stdout.length}\n[stderr bytes]: ${task.stderr.length}`;

      return {
        content: [{ type: "text", text: statusOutput }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
});

// =============================================================================
// Start Server
// =============================================================================

const transport = new StdioServerTransport();
server.connect(transport);
console.error("Fast Bash MCP server v3.0 running");
