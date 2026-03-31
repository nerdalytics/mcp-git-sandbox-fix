import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProbeResults } from "./probe.js";
import { z } from "zod";
import { check, textResult } from "./format.js";

function buildSurvey(
  probes: ProbeResults,
  binaryPath: string,
): string {
  const lines: string[] = [];

  lines.push("# MCP Server Onboarding");
  lines.push("");
  lines.push("## Environment Discovery");
  lines.push("");

  // Git
  if (probes.git.found) {
    lines.push(`  ${check(true)} git found: ${probes.git.version}`);
    if (probes.gitIdentity.configured) {
      lines.push(
        `  ${check(true)} git identity: ${probes.gitIdentity.userName} <${probes.gitIdentity.userEmail}>`,
      );
    } else {
      lines.push(`  ${check(false)} git identity not configured`);
      lines.push(
        "    Run: git config --global user.name/email before proceeding",
      );
    }
  } else {
    lines.push(`  ${check(false)} git not found on PATH`);
    lines.push("    Install git before using this server.");
    return lines.join("\n");
  }

  // SSH
  lines.push("");
  if (probes.ssh.found) {
    lines.push(`  ${check(true)} ssh found: ${probes.ssh.version}`);
    if (probes.sshAgent.socketSet && probes.sshAgent.socketReachable) {
      lines.push(
        `  ${check(true)} SSH agent reachable, ${probes.sshAgent.identityCount} identit${probes.sshAgent.identityCount === 1 ? "y" : "ies"} loaded`,
      );
    } else if (probes.sshAgent.socketSet) {
      lines.push(
        `  ${check(false)} SSH_AUTH_SOCK is set but agent is not reachable`,
      );
    } else {
      lines.push("  \u2014 SSH_AUTH_SOCK not set (not forwarded to server)");
    }
  } else {
    lines.push("  \u2014 ssh not found");
  }

  // Signing
  lines.push("");
  const s = probes.gitSigning;
  if (s.gpgFormat === "ssh" && s.commitGpgsign) {
    lines.push(`  ${check(true)} SSH commit signing configured (gpg.format=ssh, commit.gpgsign=true)`);
    if (s.signingKey) {
      lines.push(`  ${check(true)} signing key: ${s.signingKey}`);
      if (s.signingTest.attempted) {
        if (s.signingTest.success) {
          lines.push(`  ${check(true)} signing test passed`);
        } else {
          lines.push(`  ${check(false)} signing test FAILED: ${s.signingTest.error}`);
        }
      }
    } else {
      lines.push(
        "  \u2014 signing key not in global config (may be set via includeIf per repo)",
      );
    }
  } else if (s.gpgFormat === "gpg" || (!s.gpgFormat && probes.gpg.found)) {
    lines.push("  \u2014 GPG signing configured or available");
  } else {
    lines.push("  \u2014 commit signing not configured");
  }

  // gh
  lines.push("");
  if (probes.gh.found) {
    lines.push(`  ${check(true)} gh found: ${probes.gh.version}`);
  } else {
    lines.push("  \u2014 gh not found");
  }

  // Questions
  lines.push("");
  lines.push("## Setup Questions");
  lines.push("");
  lines.push("Ask the user these questions to determine their configuration:");
  lines.push("");
  lines.push("1. **Scope**: Should this be a global config (all projects) or project-specific?");
  lines.push("   \u2192 global: generates JSON for ~/.claude.json or `claude mcp add -s user` command");
  lines.push("   \u2192 project: generates .mcp.json for the project root");
  lines.push("");

  if (probes.ssh.found) {
    lines.push("2. **SSH**: Do you need SSH-based git operations (push/pull over SSH, SSH commit signing)?");
    lines.push("   \u2192 If yes: SSH_AUTH_SOCK will be forwarded");
    if (!probes.sshAgent.socketSet) {
      lines.push(
        "   \u26a0 SSH_AUTH_SOCK is not currently set in the server environment",
      );
    }
    lines.push("");
  }

  if (probes.gh.found) {
    lines.push("3. **GitHub CLI**: Do you need gh for PRs, issues, releases?");
    lines.push("   \u2192 If yes, which auth method?");
    lines.push(
      '   \u2192 a) MCP_GH_USER: specify your account name (recommended for SSO / multi-account)',
    );
    lines.push("   \u2192 b) GH_TOKEN: provide a personal access token");
    lines.push(
      "   \u2192 c) GH_CONFIG_DIR: point to a gh config directory",
    );
    lines.push("");
  }

  lines.push(
    `Then call this tool again with the setup parameter to generate the config.`,
  );
  lines.push("");
  lines.push("## Binary Path");
  lines.push(`  ${binaryPath}`);

  return lines.join("\n");
}

interface McpServerConfig {
  command: string;
  env?: Record<string, string>;
}

interface SetupInput {
  scope: string;
  ssh: boolean;
  gh_method?: string;
  gh_value?: string;
}

function buildConfig(
  binaryPath: string,
  setup: SetupInput,
): string {
  const lines: string[] = [];
  const env: Record<string, string> = {};

  if (setup.ssh) {
    env["SSH_AUTH_SOCK"] = "${SSH_AUTH_SOCK}";
  }

  const ghEnvKey: Record<string, string> = {
    user: "MCP_GH_USER",
    token: "GH_TOKEN",
    "config-dir": "GH_CONFIG_DIR",
  };
  if (setup.gh_method && setup.gh_value && ghEnvKey[setup.gh_method]) {
    env[ghEnvKey[setup.gh_method]] = setup.gh_value;
  }

  const serverConfig: McpServerConfig = { command: binaryPath };
  if (Object.keys(env).length > 0) {
    serverConfig.env = env;
  }

  const scope = setup.scope;

  if (scope === "project") {
    // .mcp.json format
    const mcpJson = {
      mcpServers: {
        "mcp-unsandboxed-git-cli": serverConfig,
      },
    };

    lines.push("## Project Config (.mcp.json)");
    lines.push("");
    lines.push("Create this file at the project root:");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(mcpJson, null, 2));
    lines.push("```");
  } else {
    // Global: ~/.claude.json format via claude mcp add
    const cliParts = [
      "claude mcp add -s user -t stdio",
    ];
    for (const [key, value] of Object.entries(env)) {
      cliParts.push(`-e ${key}='${value}'`);
    }
    cliParts.push("mcp-unsandboxed-git-cli");
    cliParts.push(binaryPath);

    // Also show the JSON for manual editing
    const claudeJson = {
      "mcp-unsandboxed-git-cli": {
        type: "stdio" as const,
        command: binaryPath,
        args: [] as string[],
        env,
      },
    };

    lines.push("## Global Config");
    lines.push("");
    lines.push("### Option A: CLI command");
    lines.push("");
    lines.push("```sh");
    lines.push(cliParts.join(" \\\n  "));
    lines.push("```");
    lines.push("");
    lines.push("### Option B: Add to ~/.claude.json mcpServers");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(claudeJson, null, 2));
    lines.push("```");
  }

  lines.push("");
  lines.push("After applying, restart the MCP server and run the `doctor` tool to verify.");

  return lines.join("\n");
}

export function registerOnboardTool(
  server: McpServer,
  binaryPath: string,
  probes: ProbeResults,
): void {
  server.registerTool(
    "onboard",
    {
      description:
        "Set up the MCP server configuration. " +
        "Call without parameters to discover the environment and get setup questions. " +
        "Call with setup parameters to generate the configuration.",
      inputSchema: {
        setup: z
          .object({
            scope: z
              .enum(["project", "user"])
              .describe('"project" for .mcp.json, "user" for ~/.claude.json'),
            ssh: z
              .boolean()
              .describe("Forward SSH_AUTH_SOCK for SSH operations and signing"),
            gh_method: z
              .enum(["user", "token", "config-dir"])
              .optional()
              .describe("gh auth method: user (MCP_GH_USER), token (GH_TOKEN), or config-dir (GH_CONFIG_DIR)"),
            gh_value: z
              .string()
              .optional()
              .describe("Value for the chosen gh auth method (username, token, or path)"),
          })
          .optional()
          .describe(
            "Omit to discover environment and get questions. Provide to generate config.",
          ),
      },
    },
    async ({ setup }) => {
      if (!setup) {
        return textResult(buildSurvey(probes, binaryPath));
      }
      return textResult(buildConfig(binaryPath, setup));
    },
  );
}
