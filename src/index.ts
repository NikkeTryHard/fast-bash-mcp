#!/usr/bin/env bun
/**
 * Fast Bash MCP Server v3.2
 * Provides direct bash execution tools that bypass Claude Code's
 * slow haiku-based pre-flight checks.
 *
 * Features:
 * - fast_bash: Single command execution
 * - fast_bash_parallel: Multiple commands in parallel
 * - fast_bash_sequence: Sequential commands in a single shell session (stateful)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

const server = new Server(
  {
    name: "fast-bash",
    version: "3.2.0",
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

// =============================================================================
// Constants
// =============================================================================

// Default working directory: env var > process.cwd() > HOME > /tmp
const DEFAULT_CWD = process.env.FAST_BASH_DEFAULT_CWD || process.cwd() || process.env.HOME || "/tmp";

// Grace period before SIGKILL (ms)
const GRACEFUL_TIMEOUT_MS = 5000;

// Reserved characters for truncation ellipsis
const TRUNCATION_ELLIPSIS_RESERVE = 50;

// Exit code for timeout (shell convention)
const EXIT_CODE_TIMEOUT = 124;

// Valid shells for validation
const VALID_SHELLS = ["bash", "zsh", "sh"] as const;

// Sudo rejection message
const SUDO_REJECTION_MESSAGE = "[REJECTED] sudo commands cannot be executed. Please STOP and ask human user to run it for you!\n";

// Interactive command rejection message
const INTERACTIVE_REJECTION_MESSAGE = "[REJECTED] Interactive commands cannot be executed in non-TTY mode. Use non-interactive alternatives (e.g. `ssh host 'command'` instead of `ssh host`).\n";

// SSH hosts that are always blocked (even with remote commands)
const BLOCKED_SSH_HOSTS = new Set(["supernova"]);

// Security hardening toggle (set FAST_BASH_HARDENED=1 to enable)
// When OFF: no path sanitization, no env var filtering, no max_output ceiling
// When ON: blocks path traversal, system dir writes, dangerous env vars, caps max_output
const HARDENED_MODE = process.env.FAST_BASH_HARDENED === "1";

// Default timeout for single and parallel commands (7 minutes)
const DEFAULT_TIMEOUT = 420000;

// Maximum allowed timeout (10 minutes)
const MAX_TIMEOUT = 600000;

// Maximum allowed max_output value (10MB) — only enforced in hardened mode
const MAX_OUTPUT_CEILING = 10_000_000;

// Default max_output
const DEFAULT_MAX_OUTPUT = 30000;

// In-process memory cap for stdout/stderr accumulation (50MB)
// Prevents OOM from commands like `yes` or `cat /dev/urandom`
// Always active — this is a safety net, not a restriction
const MEMORY_CAP = 50_000_000;

// Environment variables that cannot be overridden (hardened mode only)
const PROTECTED_ENV_VARS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);

/**
 * Check if a command contains sudo
 * Matches: sudo at start, after semicolon, after &&, after ||, after |, after $(, after backtick
 */
function containsSudo(command: string): boolean {
  // Match sudo as a standalone command (not part of another word like "pseudocode")
  return /(?:^|[;&|`$()]\s*)sudo(?:\s|$)/m.test(command);
}

/**
 * Check if a command would start an interactive session (no TTY available).
 * Blocks: bare ssh/telnet/ftp without a remote command, bare shell/REPL invocations.
 * Allows: ssh host 'cmd', ssh -o Option host cmd, scp, rsync, mysql -e 'query', etc.
 */
function isInteractiveCommand(command: string): boolean {
  // Trim and split on pipes/chains to check each segment
  const segments = command.split(/[;&|]+/).map((s) => s.trim());
  for (const seg of segments) {
    if (!seg) continue;
    // Tokenize: strip leading env assignments (VAR=val) and get the binary + args
    const tokens = seg.split(/\s+/);
    let cmdIndex = 0;
    while (cmdIndex < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cmdIndex])) {
      cmdIndex++;
    }
    if (cmdIndex >= tokens.length) continue;
    const binary = path.basename(tokens[cmdIndex]);
    const rest = tokens.slice(cmdIndex + 1);

    // ssh: block specific hosts entirely, block interactive (no remote command) for others
    if (binary === "ssh") {
      // Collect non-flag arguments (skip flags and their values)
      const flagsWithArg = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const tok = rest[i];
        if (tok === "--") {
          positional.push(...rest.slice(i + 1));
          break;
        }
        if (tok.startsWith("-") && flagsWithArg.has(tok)) {
          i++; // skip next token (flag value)
        } else if (tok.startsWith("-")) {
          // boolean flag, skip
        } else {
          positional.push(tok);
        }
      }
      // Block specific SSH targets entirely (even with remote commands)
      const host = positional[0]?.replace(/^.*@/, ""); // strip user@ prefix
      if (host && BLOCKED_SSH_HOSTS.has(host)) return true;
      // positional[0] = [user@]host, positional[1+] = remote command
      if (positional.length <= 1) return true; // no remote command → interactive
      continue;
    }

    if (binary === "telnet" || binary === "ftp" || binary === "sftp") {
      return true; // always interactive
    }

    // Bare shell invocations (no -c flag → starts interactive session)
    if ((binary === "bash" || binary === "zsh" || binary === "sh" || binary === "fish" || binary === "csh" || binary === "tcsh") && !rest.some((t) => t === "-c")) {
      // Allow if a script file is passed (e.g. bash script.sh)
      const nonFlagArgs = rest.filter((t) => !t.startsWith("-"));
      if (nonFlagArgs.length === 0) return true; // bare shell → interactive
    }

    // Bare REPL invocations (python/node/etc. with no script or -c/-e)
    if ((binary === "python" || binary === "python3" || binary === "python2") && rest.length === 0) return true;
    if (binary === "node" && rest.length === 0) return true;
    if (binary === "irb" || binary === "pry") return true;
  }
  return false;
}

/**
 * Sanitize a file output path to prevent path traversal attacks.
 * Only active in hardened mode. Returns valid:true when hardened mode is off.
 */
function sanitizeOutputPath(filePath: string): { valid: boolean; error?: string } {
  if (!HARDENED_MODE) return { valid: true };

  const resolved = path.resolve(filePath);

  // Reject path traversal
  if (filePath.includes("..")) {
    return { valid: false, error: `Writing to "${filePath}" is not allowed (path traversal). Please STOP and ask human to run it for you.` };
  }

  // Reject writes to sensitive system directories
  const blockedPrefixes = ["/etc/", "/usr/", "/bin/", "/sbin/", "/boot/", "/dev/", "/proc/", "/sys/"];
  for (const prefix of blockedPrefixes) {
    if (resolved.startsWith(prefix)) {
      return { valid: false, error: `Writing to "${resolved}" is not allowed (system directory). Please STOP and ask human to run it for you.` };
    }
  }

  return { valid: true };
}

/**
 * Filter out protected environment variables that could be used for injection.
 * Only active in hardened mode. Passes everything through when hardened mode is off.
 */
function filterEnvVars(env: Record<string, string> | undefined): { filtered: Record<string, string> | undefined; rejected: string[] } {
  if (!env) return { filtered: undefined, rejected: [] };
  if (!HARDENED_MODE) return { filtered: env, rejected: [] };

  const rejected: string[] = [];
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (PROTECTED_ENV_VARS.has(key.toUpperCase())) {
      rejected.push(key);
    } else {
      filtered[key] = value;
    }
  }

  return { filtered: Object.keys(filtered).length > 0 ? filtered : undefined, rejected };
}

/**
 * Clamp max_output to a safe ceiling value (hardened mode only)
 */
function clampMaxOutput(value: number | undefined): number {
  if (!value || value <= 0) return DEFAULT_MAX_OUTPUT;
  if (!HARDENED_MODE) return value;
  return Math.min(value, MAX_OUTPUT_CEILING);
}

/**
 * Validate output file paths. Returns error message or undefined if valid.
 */
function validateOutputFiles(outputFile?: string, stderrFile?: string): string | undefined {
  if (outputFile) {
    const check = sanitizeOutputPath(outputFile);
    if (!check.valid) return check.error!;
  }
  if (stderrFile) {
    const check = sanitizeOutputPath(stderrFile);
    if (!check.valid) return check.error!;
  }
  return undefined;
}

// Default timeout for sequence commands (7 minutes)
const DEFAULT_SEQUENCE_TIMEOUT = 420000;

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

  if (description) output += `=== ${description} ===\n`;
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
function executeCommand(options: { command: string; cwd?: string; timeout?: number; shell?: string; env?: Record<string, string>; stdin?: string; maxOutput?: number; outputFile?: string; stderrFile?: string; loginShell?: boolean }): Promise<CommandResult> {
  const { command, cwd = DEFAULT_CWD, timeout = DEFAULT_TIMEOUT, shell = "bash", env, stdin, maxOutput = DEFAULT_MAX_OUTPUT, outputFile, stderrFile, loginShell = false } = options;

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

    // CWD Validation
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
      // Use -lc for login shell (sources .profile), -c for regular
      const shellArgs = loginShell ? ["-lc", command] : ["-c", command];
      proc = spawn(shell, shellArgs, {
        cwd,
        env: mergedEnv,
        stdio: ["pipe", "pipe", "pipe"],
        // Use process group so we can kill child processes too
        detached: true,
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

    // Close stdin immediately if no input — prevents commands from hanging
    if (stdin) {
      proc.stdin?.write(stdin);
      proc.stdin?.end();
    } else {
      proc.stdin?.end();
    }

    let stdout = "";
    let stderr = "";
    let killed = false;
    let forceKilled = false;
    let completed = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutEnded = false;
    let stderrEnded = false;
    let exitCode: number | null = null;

    // Kill the entire process group
    const killGroup = (signal: NodeJS.Signals) => {
      const pid = proc.pid;
      if (pid) {
        try {
          // Kill process group (negative PID)
          process.kill(-pid, signal);
        } catch {
          // Fallback to direct kill if group kill fails
          proc.kill(signal);
        }
      } else {
        proc.kill(signal);
      }
    };

    // Graceful Timeout - SIGTERM first, then SIGKILL after grace period
    const timer = setTimeout(() => {
      killed = true;
      killGroup("SIGTERM");

      // Grace period before SIGKILL
      graceTimer = setTimeout(() => {
        if (!completed) {
          killGroup("SIGKILL");
          forceKilled = true;
        }
      }, GRACEFUL_TIMEOUT_MS);
    }, timeout);

    proc.stdout?.on("data", (data) => {
      if (stdout.length < MEMORY_CAP) {
        stdout += data.toString();
      }
    });

    proc.stderr?.on("data", (data) => {
      if (stderr.length < MEMORY_CAP) {
        stderr += data.toString();
      }
    });

    // Wait for both streams to end AND process to close before resolving.
    // This prevents the race condition where 'close' fires before all
    // 'data' events have been flushed from stdout/stderr.
    const maybeResolve = () => {
      if (!stdoutEnded || !stderrEnded || exitCode === undefined) return;
      completed = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      const durationMs = Date.now() - startTime;

      // Write to files BEFORE truncation
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

      const error_type = classifyErrorType(exitCode, killed, forceKilled);

      resolve({
        stdout: truncatedStdout,
        stderr: truncatedStderr,
        exitCode: killed ? EXIT_CODE_TIMEOUT : exitCode,
        killed,
        forceKilled,
        error_type,
        durationMs,
      });
    };

    proc.stdout?.on("end", () => {
      stdoutEnded = true;
      maybeResolve();
    });

    proc.stderr?.on("end", () => {
      stderrEnded = true;
      maybeResolve();
    });

    proc.on("close", (code) => {
      exitCode = code;
      maybeResolve();
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
        detached: true,
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

    // Close stdin immediately — sequences don't accept interactive input
    proc.stdin?.end();

    let stdout = "";
    let stderr = "";
    let killed = false;
    let completed = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutEnded = false;
    let stderrEnded = false;
    let processExited = false;

    // Kill the entire process group
    const killGroup = (signal: NodeJS.Signals) => {
      const pid = proc.pid;
      if (pid) {
        try { process.kill(-pid, signal); } catch { proc.kill(signal); }
      } else {
        proc.kill(signal);
      }
    };

    const timer = setTimeout(() => {
      killed = true;
      killGroup("SIGTERM");
      graceTimer = setTimeout(() => {
        if (!completed) {
          killGroup("SIGKILL");
        }
      }, GRACEFUL_TIMEOUT_MS);
    }, timeout);

    proc.stdout?.on("data", (data) => {
      if (stdout.length < MEMORY_CAP) {
        stdout += data.toString();
      }
    });

    proc.stderr?.on("data", (data) => {
      if (stderr.length < MEMORY_CAP) {
        stderr += data.toString();
      }
    });

    // Wait for streams + close to all finish before resolving
    const maybeResolve = () => {
      if (!stdoutEnded || !stderrEnded || !processExited) return;
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
    };

    proc.stdout?.on("end", () => { stdoutEnded = true; maybeResolve(); });
    proc.stderr?.on("end", () => { stderrEnded = true; maybeResolve(); });
    proc.on("close", () => { processExited = true; maybeResolve(); });

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
              description: "Timeout in milliseconds (optional, default 420000, max 600000)",
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
            login_shell: {
              type: "boolean",
              description: "Run as login shell (-l flag) to source .profile/.bash_profile (default: false)",
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
              description: "Default timeout for all commands (default 420000)",
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
              description: "Overall timeout for all commands in ms (default: 420000)",
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

      // Reject sudo commands
      if (containsSudo(command)) {
        return {
          content: [{ type: "text", text: `${SUDO_REJECTION_MESSAGE}$ ${command}` }],
        };
      }

      // Reject interactive commands (no TTY available)
      if (isInteractiveCommand(command)) {
        return {
          content: [{ type: "text", text: `${INTERACTIVE_REJECTION_MESSAGE}$ ${command}` }],
        };
      }

      // Validate output file paths
      const fileError = validateOutputFiles(args.output_file as string | undefined, args.stderr_file as string | undefined);
      if (fileError) {
        return { content: [{ type: "text", text: `[REJECTED] ${fileError}` }] };
      }

      // Filter protected env vars
      const { filtered: safeEnv, rejected: rejectedVars } = filterEnvVars(args.env as Record<string, string> | undefined);

      const timeout = Math.min((args.timeout as number) || DEFAULT_TIMEOUT, MAX_TIMEOUT);

      const result = await executeCommand({
        command,
        cwd: args.cwd as string | undefined,
        timeout,
        shell: (args.shell as string) || "bash",
        env: safeEnv,
        stdin: args.stdin as string | undefined,
        maxOutput: clampMaxOutput(args.max_output as number | undefined),
        outputFile: args.output_file as string | undefined,
        stderrFile: args.stderr_file as string | undefined,
        loginShell: (args.login_shell as boolean) ?? false,
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
      if (rejectedVars.length > 0) {
        output += `\n[security: blocked env vars: ${rejectedVars.join(", ")}]`;
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

      // Reject any command containing sudo
      for (let i = 0; i < commands.length; i++) {
        if (containsSudo(commands[i].command)) {
          return {
            content: [{ type: "text", text: `${SUDO_REJECTION_MESSAGE}[${i + 1}] $ ${commands[i].command}` }],
          };
        }
      }

      // Reject interactive commands
      for (let i = 0; i < commands.length; i++) {
        if (isInteractiveCommand(commands[i].command)) {
          return {
            content: [{ type: "text", text: `${INTERACTIVE_REJECTION_MESSAGE}[${i + 1}] $ ${commands[i].command}` }],
          };
        }
      }

      // Validate output file path
      const outputFile = args.output_file as string | undefined;
      if (outputFile) {
        const check = sanitizeOutputPath(outputFile);
        if (!check.valid) {
          return { content: [{ type: "text", text: `[REJECTED] ${check.error}` }] };
        }
      }

      const defaultCwd = args.default_cwd as string | undefined;
      const defaultTimeout = Math.min((args.default_timeout as number) || DEFAULT_TIMEOUT, MAX_TIMEOUT);

      const overallStart = Date.now();

      const promises = commands.map((cmd, index) => {
        const startTime = Date.now();
        // Filter env vars per-command
        const { filtered: safeEnv } = filterEnvVars(cmd.env);
        return executeCommand({
          command: cmd.command,
          cwd: cmd.cwd || defaultCwd,
          timeout: Math.min(cmd.timeout || defaultTimeout, MAX_TIMEOUT),
          shell: cmd.shell || "bash",
          env: safeEnv,
          maxOutput: DEFAULT_MAX_OUTPUT,
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

      // Reject any command containing sudo
      for (let i = 0; i < commands.length; i++) {
        if (containsSudo(commands[i].command)) {
          return {
            content: [{ type: "text", text: `${SUDO_REJECTION_MESSAGE}[${i + 1}] $ ${commands[i].command}` }],
          };
        }
      }

      // Reject interactive commands
      for (let i = 0; i < commands.length; i++) {
        if (isInteractiveCommand(commands[i].command)) {
          return {
            content: [{ type: "text", text: `${INTERACTIVE_REJECTION_MESSAGE}[${i + 1}] $ ${commands[i].command}` }],
          };
        }
      }

      const stopOnFailure = args.stop_on_failure !== false; // default true
      const continueOnCodes = (args.continue_on_codes as number[]) || [0];
      const cwd = args.cwd as string | undefined;
      const timeout = Math.min((args.timeout as number) || DEFAULT_SEQUENCE_TIMEOUT, MAX_TIMEOUT);
      const shell = (args.shell as string) || "bash";
      const { filtered: safeEnv, rejected: rejectedVars } = filterEnvVars(args.env as Record<string, string> | undefined);
      const outputFile = args.output_file as string | undefined;

      // Validate output file path
      if (outputFile) {
        const check = sanitizeOutputPath(outputFile);
        if (!check.valid) {
          return { content: [{ type: "text", text: `[REJECTED] ${check.error}` }] };
        }
      }

      const seqResult = await executeSequence({
        commands,
        stopOnFailure,
        continueOnCodes,
        cwd,
        timeout,
        shell,
        env: safeEnv,
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
      if (rejectedVars.length > 0) {
        response += `\n[security: blocked env vars: ${rejectedVars.join(", ")}]`;
      }

      return {
        content: [{ type: "text", text: response }],
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
console.error(`Fast Bash MCP server v3.3 running (hardened: ${HARDENED_MODE ? "ON" : "OFF"})`);
