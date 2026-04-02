import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execCommand } from "./executor.js";
import {
  GIT_ALLOWED_SUBCOMMANDS,
  GH_ALLOWED_SUBCOMMANDS,
} from "./allowlist.js";
import { textResult } from "./format.js";
import { runAllProbes } from "./probe.js";
import { registerDoctorTool } from "./doctor.js";
import { registerOnboardTool } from "./onboard.js";
import { parseArgs } from "./config.js";

const server = new McpServer({
  name: "mcp-unsandboxed-git-cli",
  version: "0.1.0",
});

function validateSubcommand(
  subcommand: string,
  allowed: Set<string>,
) {
  if (!allowed.has(subcommand)) {
    return textResult(
      `Subcommand "${subcommand}" is not allowed. Allowed: ${[...allowed].join(", ")}`,
      true,
    );
  }
  return null;
}

function execResult(tool: string, result: { stdout: string; stderr: string; exitCode: number }) {
  if (result.exitCode !== 0) {
    return textResult(
      `${tool} exited with code ${result.exitCode}\n\nstderr:\n${result.stderr}\n\nstdout:\n${result.stdout}`,
      true,
    );
  }
  return textResult(result.stdout || result.stderr || "(no output)");
}

async function main() {
  const config = parseArgs(process.argv);

  // --gh-user arg acts as a fallback for MCP_GH_USER env.
  // Args take precedence only when the env var is not set,
  // so env-based config (the existing pattern) still wins.
  if (config.ghUser && !process.env.MCP_GH_USER) {
    process.env.MCP_GH_USER = config.ghUser;
  }

  // Disable terminal prompts in child processes — prevents git/gh
  // from hanging when they try to prompt for credentials interactively.
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.GH_PROMPT_DISABLED = "1";
  process.env.BROWSER = "";

  const probes = await runAllProbes();

  server.registerTool(
    "git",
    {
      description:
        "Run a git command outside the sandbox. Supports SSH signing, " +
        "full TLS, and stdin for commit messages (use with -F - flag). " +
        "The first element of args must be an allowed git subcommand.",
      inputSchema: {
        args: z
          .array(z.string())
          .min(1)
          .describe('Git arguments, e.g. ["commit", "-S", "-F", "-"]'),
        cwd: z
          .string()
          .optional()
          .describe("Working directory (defaults to server cwd)"),
        stdin: z
          .string()
          .optional()
          .describe("Text piped to stdin, useful with git commit -F -"),
        timeout_ms: z
          .number()
          .optional()
          .describe("Timeout in ms (default 60000)"),
      },
    },
    async ({ args, cwd, stdin, timeout_ms }) => {
      const subcommand = args[0];

      const denied = validateSubcommand(subcommand, GIT_ALLOWED_SUBCOMMANDS);
      if (denied) return denied;

      const effectiveCwd = cwd || config.cwd || undefined;
      const effectiveTimeout = timeout_ms ?? config.gitTimeout ?? undefined;

      // Detect whether this commit should be signed so we can verify afterward.
      // git silently produces unsigned commits when signing fails, so we
      // check the raw commit object post-commit to catch that.
      const isCommit = subcommand === "commit";
      const explicitSign = args.includes("-S") || args.includes("--gpg-sign");
      let signingExpected = false;

      if (isCommit) {
        const gpgsignCheck = await execCommand("git", {
          args: ["config", "commit.gpgsign"],
          cwd: effectiveCwd,
          timeout_ms: 5000,
        });
        signingExpected =
          explicitSign ||
          (gpgsignCheck.exitCode === 0 &&
            gpgsignCheck.stdout.trim() === "true");
      }

      const result = await execCommand("git", {
        args,
        cwd: effectiveCwd,
        stdin,
        timeout_ms: effectiveTimeout,
      });

      if (result.exitCode !== 0) {
        return execResult("git", result);
      }

      // Post-commit signature verification.
      // Check for the gpgsig header in the raw commit object instead of
      // %G?, which requires gpg.ssh.allowedSignersFile for SSH signatures
      // and returns "N" (no signature) even when a valid signature exists.
      if (isCommit && signingExpected) {
        const rawCheck = await execCommand("git", {
          args: ["show", "-s", "--format=raw", "HEAD"],
          cwd: effectiveCwd,
          timeout_ms: 5000,
        });

        if (!rawCheck.stdout.includes("gpgsig ")) {
          const signingKey = await execCommand("git", {
            args: ["config", "user.signingkey"],
            cwd: effectiveCwd,
            timeout_ms: 5000,
          });
          const keyPath =
            signingKey.exitCode === 0 ? signingKey.stdout.trim() : null;

          return textResult(
            `WARNING: Commit was created but is NOT signed.\n` +
            `Signing was expected (${explicitSign ? "-S flag" : "commit.gpgsign=true"}) ` +
            `but git produced an unsigned commit.\n` +
            `user.signingkey: ${keyPath ?? "(not set in this repo)"}` +
            `\nSSH_AUTH_SOCK: ${process.env.SSH_AUTH_SOCK ?? "(not set)"}` +
            `\n\ngit output:\n${result.stdout || "(no output)"}`,
            true,
          );
        }
      }

      return textResult(result.stdout || result.stderr || "(no output)");
    },
  );

  const ghConfigured =
    !!probes.env.mcpGhUser ||
    probes.env.ghToken ||
    !!probes.env.ghConfigDir;

  const ghRegistered = probes.gh.found && ghConfigured;

  if (ghRegistered) {
    server.registerTool(
      "gh",
      {
        description:
          "Run a GitHub CLI (gh) command outside the sandbox, bypassing " +
          "TLS/Go binary sandbox issues. The first element of args must " +
          "be an allowed gh subcommand.",
        inputSchema: {
          args: z
            .array(z.string())
            .min(1)
            .describe('gh arguments, e.g. ["pr", "list", "--limit", "10"]'),
          cwd: z
            .string()
            .optional()
            .describe("Working directory (defaults to server cwd)"),
          stdin: z.string().optional().describe("Text piped to stdin"),
          timeout_ms: z
            .number()
            .optional()
            .describe("Timeout in ms (default 60000)"),
        },
      },
      async ({ args, cwd, stdin, timeout_ms }) => {
        const denied = validateSubcommand(args[0], GH_ALLOWED_SUBCOMMANDS);
        if (denied) return denied;

        const result = await execCommand("gh", {
          args,
          cwd: cwd || config.cwd || undefined,
          stdin,
          timeout_ms: timeout_ms ?? config.ghTimeout ?? undefined,
        });
        return execResult("gh", result);
      },
    );
  }

  registerDoctorTool(server, probes, ghRegistered, config);

  const binaryPath = process.execPath;
  registerOnboardTool(server, binaryPath, probes, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const tools = ["git"];
  if (ghRegistered) tools.push("gh");
  tools.push("doctor", "onboard");
  console.error(
    `mcp-unsandboxed-git-cli running on stdio \u2014 tools: ${tools.join(", ")}`,
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
