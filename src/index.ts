import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execCommand } from "./executor.js";
import {
  GIT_ALLOWED_SUBCOMMANDS,
  GH_ALLOWED_SUBCOMMANDS,
} from "./allowlist.js";
import { runAllProbes } from "./probe.js";
import { registerDoctorTool } from "./doctor.js";
import { registerOnboardTool } from "./onboard.js";

const server = new McpServer({
  name: "mcp-unsandboxed-git-cli",
  version: "0.1.0",
});

async function main() {
  // Set env overrides once — child processes inherit them naturally
  // via C-level environ without needing an explicit env object.
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.GH_PROMPT_DISABLED = "1";
  process.env.BROWSER = "";

  const probes = await runAllProbes();

  // --- git: always registered ---
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

      if (!GIT_ALLOWED_SUBCOMMANDS.has(subcommand)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Subcommand "${subcommand}" is not allowed. Allowed: ${[...GIT_ALLOWED_SUBCOMMANDS].join(", ")}`,
            },
          ],
        };
      }

      // For commit operations where SSH signing is expected, use a
      // minimal wrapper as gpg.ssh.program. The previous wrapper with
      // pipes and fd redirects broke git's subprocess management.
      //
      // New approach: log env to a file, then exec ssh-keygen.
      // exec replaces the shell process — git's pipes connect directly
      // to ssh-keygen with zero intermediary. No pipes, no tee, no
      // fd clobbering.
      const isCommit = subcommand === "commit";
      const explicitSign = args.includes("-S") || args.includes("--gpg-sign");
      let signingExpected = false;

      if (isCommit) {
        const gpgsignCheck = await execCommand("git", {
          args: ["config", "commit.gpgsign"],
          cwd,
          timeout_ms: 5000,
        });
        signingExpected =
          explicitSign ||
          (gpgsignCheck.exitCode === 0 &&
            gpgsignCheck.stdout.trim() === "true");
      }

      // No gpg.ssh.program override needed — git finds ssh-keygen via
      // the inherited PATH. Previous -c flag and wrapper approaches all
      // failed because Bun's process.env spread was incomplete.

      try {
        const result = await execCommand("git", {
          args,
          cwd,
          stdin,
          timeout_ms,
        });

        if (result.exitCode !== 0) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `git exited with code ${result.exitCode}\n\nstderr:\n${result.stderr}\n\nstdout:\n${result.stdout}`,
              },
            ],
          };
        }

        // Post-commit signature verification.
        // Check for the gpgsig header in the raw commit object instead of
        // %G?, which requires gpg.ssh.allowedSignersFile for SSH signatures
        // and returns "N" (no signature) even when a valid signature exists.
        if (isCommit && signingExpected) {
          const rawCheck = await execCommand("git", {
            args: ["show", "-s", "--format=raw", "HEAD"],
            cwd,
            timeout_ms: 5000,
          });

          const hasSignature = rawCheck.stdout.includes("gpgsig ");

          if (!hasSignature) {
            const signingKey = await execCommand("git", {
              args: ["config", "user.signingkey"],
              cwd,
              timeout_ms: 5000,
            });
            const keyPath =
              signingKey.exitCode === 0 ? signingKey.stdout.trim() : null;

            const output = result.stdout || "(no output)";
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text:
                    `WARNING: Commit was created but is NOT signed.\n` +
                    `Signing was expected (${explicitSign ? "-S flag" : "commit.gpgsign=true"}) ` +
                    `but git produced an unsigned commit.\n` +
                    `user.signingkey: ${keyPath ?? "(not set in this repo)"}` +
                    `\nSSH_AUTH_SOCK: ${process.env.SSH_AUTH_SOCK ?? "(not set)"}` +
                    `\n\ngit output:\n${output}`,
                },
              ],
            };
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: result.stdout || result.stderr || "(no output)",
            },
          ],
        };
      } finally {}
    },
  );

  // --- gh: only registered when explicitly configured ---
  const ghConfigured =
    !!process.env.MCP_GH_USER ||
    !!process.env.GH_TOKEN ||
    !!process.env.GITHUB_TOKEN ||
    !!process.env.GH_CONFIG_DIR;

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
        const subcommand = args[0];

        if (!GH_ALLOWED_SUBCOMMANDS.has(subcommand)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Subcommand "${subcommand}" is not allowed. Allowed: ${[...GH_ALLOWED_SUBCOMMANDS].join(", ")}`,
              },
            ],
          };
        }

        const result = await execCommand("gh", { args, cwd, stdin, timeout_ms });

        if (result.exitCode !== 0) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `gh exited with code ${result.exitCode}\n\nstderr:\n${result.stderr}\n\nstdout:\n${result.stdout}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: result.stdout || result.stderr || "(no output)",
            },
          ],
        };
      },
    );
  }

  // --- doctor: always registered ---
  registerDoctorTool(server, probes, ghRegistered);

  // --- onboard: always registered ---
  const binaryPath = process.execPath;
  registerOnboardTool(server, binaryPath);

  // --- connect ---
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
