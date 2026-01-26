#!/usr/bin/env bun
/**
 * Fast Bash MCP Server v2.0
 * Provides direct bash execution tools that bypass Claude Code's
 * slow haiku-based pre-flight checks.
 *
 * Features:
 * - fast_bash: Single command execution
 * - fast_bash_parallel: Multiple commands in parallel
 * - fast_bash_bg: Background execution with task tracking
 * - fast_bash_bg_status: Check background task status
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, ChildProcess } from "child_process";

const server = new Server(
  {
    name: "fast-bash",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Background task tracking
interface BackgroundTask {
  id: string;
  command: string;
  description?: string;
  startTime: number;
  process: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  completed: boolean;
  killed: boolean;
}

const backgroundTasks = new Map<string, BackgroundTask>();
let taskIdCounter = 0;

// Default working directory: env var > process.cwd() > HOME > /tmp
const DEFAULT_CWD = process.env.FAST_BASH_DEFAULT_CWD || process.cwd() || process.env.HOME || "/tmp";

/**
 * Middle-truncate output to preserve beginning and end
 */
function middleTruncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const halfLength = Math.floor((maxLength - 50) / 2);
  const start = text.slice(0, halfLength);
  const end = text.slice(-halfLength);
  const truncatedBytes = text.length - maxLength;

  return `${start}\n\n... [truncated ${truncatedBytes} characters] ...\n\n${end}`;
}

/**
 * Execute a command and return result
 */
function executeCommand(options: { command: string; cwd?: string; timeout?: number; shell?: string; env?: Record<string, string>; stdin?: string; maxOutput?: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null; killed: boolean }> {
  const { command, cwd = DEFAULT_CWD, timeout = 30000, shell = "bash", env, stdin, maxOutput = 30000 } = options;

  return new Promise((resolve) => {
    const mergedEnv = { ...process.env, ...env };

    const proc = spawn(shell, ["-c", command], {
      cwd,
      env: mergedEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, timeout);

    if (stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);

      // Apply truncation
      if (stdout.length > maxOutput) {
        stdout = middleTruncate(stdout, maxOutput);
      }
      if (stderr.length > maxOutput) {
        stderr = middleTruncate(stderr, maxOutput);
      }

      resolve({ stdout, stderr, exitCode: code, killed });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err.message, exitCode: 1, killed: false });
    });
  });
}

/**
 * Format command result for output
 */
function formatResult(result: { stdout: string; stderr: string; exitCode: number | null; killed: boolean }, description?: string, timeout?: number): string {
  let output = "";
  if (description) output += `[${description}]\n`;
  if (result.stdout) output += result.stdout;
  if (result.stderr) output += `\n[stderr]: ${result.stderr}`;
  if (result.killed) output += `\n[timeout after ${timeout}ms]`;
  output += `\n[exit code: ${result.exitCode}]`;
  return output.trim() || "(no output)";
}

// List available tools
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
        description: "Check status of a background task, get its output, or kill it.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "The task ID returned by fast_bash_bg",
            },
            action: {
              type: "string",
              description: "Action to take: status (default), output, kill, list",
              enum: ["status", "output", "kill", "list"],
            },
            max_output: {
              type: "number",
              description: "Maximum output length (default 30000)",
            },
          },
          required: [],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments as Record<string, unknown>;

  switch (toolName) {
    case "fast_bash": {
      const result = await executeCommand({
        command: args.command as string,
        cwd: args.cwd as string | undefined,
        timeout: Math.min((args.timeout as number) || 30000, 600000),
        shell: (args.shell as string) || "bash",
        env: args.env as Record<string, string> | undefined,
        stdin: args.stdin as string | undefined,
        maxOutput: (args.max_output as number) || 30000,
      });

      return {
        content: [
          {
            type: "text",
            text: formatResult(result, args.description as string, args.timeout as number),
          },
        ],
      };
    }

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

      const promises = commands.map((cmd, index) => {
        const startTime = Date.now();
        return executeCommand({
          command: cmd.command,
          cwd: cmd.cwd || defaultCwd,
          timeout: cmd.timeout || defaultTimeout,
          shell: cmd.shell || "bash",
          env: cmd.env,
        }).then((result) => ({
          index,
          command: cmd.command,
          description: cmd.description,
          result,
          duration: Date.now() - startTime,
        }));
      });

      const results = await Promise.all(promises);

      const output = results
        .map((r) => {
          const header = r.description ? `=== ${r.description} ===` : `=== Command ${r.index + 1} ===`;
          const cmdLine = `$ ${r.command}`;
          const body = formatResult(r.result);
          const timing = `[${r.duration}ms]`;
          return `${header}\n${cmdLine}\n${body}\n${timing}`;
        })
        .join("\n\n");

      return {
        content: [{ type: "text", text: output }],
      };
    }

    case "fast_bash_bg": {
      const taskId = `task_${++taskIdCounter}`;
      const command = args.command as string;
      const description = args.description as string | undefined;
      const cwd = (args.cwd as string) || DEFAULT_CWD;
      const shell = (args.shell as string) || "bash";
      const env = { ...process.env, ...(args.env as Record<string, string>) };

      const proc = spawn(shell, ["-c", command], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

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

      proc.stdout.on("data", (data) => {
        task.stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        task.stderr += data.toString();
      });

      proc.on("close", (code) => {
        task.exitCode = code;
        task.completed = true;
      });

      proc.on("error", (err) => {
        task.stderr += `\n[error]: ${err.message}`;
        task.completed = true;
        task.exitCode = 1;
      });

      backgroundTasks.set(taskId, task);

      return {
        content: [
          {
            type: "text",
            text: `Background task started\n[task_id]: ${taskId}\n[command]: ${command}${description ? `\n[description]: ${description}` : ""}\n\nUse fast_bash_bg_status with task_id="${taskId}" to check status.`,
          },
        ],
      };
    }

    case "fast_bash_bg_status": {
      const action = (args.action as string) || "status";
      const maxOutput = (args.max_output as number) || 30000;

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
        return { content: [{ type: "text", text: "Error: task_id required for status/output/kill actions" }] };
      }

      const task = backgroundTasks.get(taskId);
      if (!task) {
        return { content: [{ type: "text", text: `Error: Task ${taskId} not found` }] };
      }

      if (action === "kill") {
        if (task.completed) {
          return { content: [{ type: "text", text: `Task ${taskId} already completed` }] };
        }
        task.killed = true;
        task.process.kill("SIGTERM");
        return { content: [{ type: "text", text: `Task ${taskId} killed` }] };
      }

      if (action === "output") {
        let stdout = task.stdout;
        let stderr = task.stderr;

        if (stdout.length > maxOutput) stdout = middleTruncate(stdout, maxOutput);
        if (stderr.length > maxOutput) stderr = middleTruncate(stderr, maxOutput);

        let output = "";
        if (stdout) output += stdout;
        if (stderr) output += `\n[stderr]: ${stderr}`;
        if (task.completed) {
          if (task.killed) output += "\n[killed]";
          output += `\n[exit code: ${task.exitCode}]`;
        } else {
          output += "\n[still running...]";
        }

        return { content: [{ type: "text", text: output.trim() || "(no output yet)" }] };
      }

      // Default: status
      const runtime = ((Date.now() - task.startTime) / 1000).toFixed(1);
      const status = task.completed ? (task.exitCode === 0 ? "completed successfully" : `failed (exit ${task.exitCode})`) : "running";

      return {
        content: [
          {
            type: "text",
            text: `[task_id]: ${taskId}\n[status]: ${status}\n[runtime]: ${runtime}s\n[command]: ${task.command}${task.description ? `\n[description]: ${task.description}` : ""}\n[stdout bytes]: ${task.stdout.length}\n[stderr bytes]: ${task.stderr.length}`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
});

// Start server
const transport = new StdioServerTransport();
server.connect(transport);
console.error("Fast Bash MCP server v2.0 running");
