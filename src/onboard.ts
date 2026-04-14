import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProbeResults } from "./probe.js";
import type { ServerConfig } from "./config.js";
import { z } from "zod";
import { check, textResult } from "./format.js";
import { SCOPES, GH_METHODS, AGENT_FILES, GH_ENV_KEYS } from "./constants.js";

function pushFenced(lines: string[], lang: string, content: string) {
  lines.push(`\`\`\`${lang}`);
  lines.push(content);
  lines.push("```");
}

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

  // Build structured questions for AskUserQuestion tool
  interface SurveyOption {
    label: string;
    description: string;
  }
  interface SurveyQuestion {
    question: string;
    header: string;
    options: SurveyOption[];
    multiSelect: boolean;
    maps_to: string;
  }

  const questions: SurveyQuestion[] = [];

  questions.push({
    question: "Should this MCP server be configured globally or per-project?",
    header: "Scope",
    options: [
      { label: "Global (Recommended)", description: "Adds to ~/.claude.json — available in all projects" },
      { label: "Project", description: "Creates .mcp.json in the project root — shareable with collaborators" },
    ],
    multiSelect: false,
    maps_to: "scope",
  });

  if (probes.ssh.found) {
    const sshDesc = probes.sshAgent.socketSet
      ? "Forward SSH_AUTH_SOCK so the server can reach your keys"
      : "Forward SSH_AUTH_SOCK (not currently set in the server environment)";
    questions.push({
      question: "Do you need SSH-based git operations?",
      header: "SSH",
      options: [
        { label: "Yes (Recommended)", description: sshDesc },
        { label: "No", description: "HTTPS-only git operations, no commit signing" },
      ],
      multiSelect: false,
      maps_to: "ssh",
    });
  }

  if (probes.gh.found) {
    questions.push({
      question: "Do you need the GitHub CLI (gh) for PRs, issues, releases?",
      header: "GitHub CLI",
      options: [
        { label: `${GH_ENV_KEYS.user} (Recommended)`, description: "Specify your GitHub username — best for SSO and multi-account setups" },
        { label: GH_ENV_KEYS.token, description: "Use a personal access token directly" },
        { label: GH_ENV_KEYS["config-dir"], description: "Point to a gh config directory with stored credentials" },
        { label: "No gh", description: "Skip GitHub CLI — git only" },
      ],
      multiSelect: false,
      maps_to: "gh_method",
    });
  }

  questions.push({
    question: "Where should tool hints go so agents find the MCP tools instead of using Bash?",
    header: "Agent file",
    options: [
      { label: "AGENTS.md", description: "Agent-agnostic — symlink CLAUDE.md to it" },
      { label: "CLAUDE.md", description: "Claude Code default" },
      { label: "Both", description: "Separate CLAUDE.md and AGENTS.md files" },
      { label: "Skip", description: "I'll handle it myself" },
    ],
    multiSelect: false,
    maps_to: "agent_file",
  });

  lines.push("");
  lines.push("## Setup Questions");
  lines.push("");
  lines.push("Present these to the user using the AskUserQuestion tool.");
  lines.push("AskUserQuestion supports up to 4 questions per call, so batch them.");
  lines.push("If the user picks MCP_GH_USER or GH_TOKEN or GH_CONFIG_DIR,");
  lines.push("ask a follow-up for the value (username, token, or path).");
  lines.push("");
  pushFenced(lines, "json", JSON.stringify(questions, null, 2));
  lines.push("");
  lines.push("## Mapping answers to setup parameters");
  lines.push("");
  lines.push("Once you have the answers, call this tool again with the setup parameter.");
  lines.push("Map answers as follows:");
  lines.push('  Scope: "Global" -> scope: "user", "Project" -> scope: "project"');
  lines.push('  SSH: "Yes" -> ssh: true, "No" -> ssh: false');
  lines.push('  GitHub CLI: "MCP_GH_USER" -> gh_method: "user", gh_value: <username>');
  lines.push('              "GH_TOKEN" -> gh_method: "token", gh_value: <token>');
  lines.push('              "GH_CONFIG_DIR" -> gh_method: "config-dir", gh_value: <path>');
  lines.push('              "No gh" -> omit gh_method and gh_value');
  lines.push('  Agent file: "AGENTS.md" -> agent_file: "agents"');
  lines.push('              "CLAUDE.md" -> agent_file: "claude"');
  lines.push('              "Both" -> agent_file: "both"');
  lines.push('              "Skip" -> agent_file: "skip"');
  lines.push("");
  lines.push("## Binary Path");
  lines.push(`  ${binaryPath}`);

  return lines.join("\n");
}

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface SetupInput {
  scope: string;
  ssh: boolean;
  gh_method?: string;
  gh_value?: string;
  agent_file?: string;
  cwd?: string;
  git_timeout?: number;
  gh_timeout?: number;
}

function buildConfig(
  binaryPath: string,
  setup: SetupInput,
): string {
  const lines: string[] = [];
  const env: Record<string, string> = {};
  const args: string[] = [];

  if (setup.ssh) {
    env["SSH_AUTH_SOCK"] = "${SSH_AUTH_SOCK}";
  }

  // gh auth: prefer --gh-user arg for non-secret values, env for tokens
  if (setup.gh_method === "user" && setup.gh_value) {
    args.push("--gh-user", setup.gh_value);
  } else if (setup.gh_method && setup.gh_value && GH_ENV_KEYS[setup.gh_method as keyof typeof GH_ENV_KEYS]) {
    env[GH_ENV_KEYS[setup.gh_method as keyof typeof GH_ENV_KEYS]] = setup.gh_value;
  }

  if (setup.cwd) {
    args.push("--cwd", setup.cwd);
  }
  if (setup.git_timeout) {
    args.push("--git-timeout", String(setup.git_timeout));
  }
  if (setup.gh_timeout) {
    args.push("--gh-timeout", String(setup.gh_timeout));
  }

  const serverConfig: McpServerConfig = { command: binaryPath };
  if (args.length > 0) {
    serverConfig.args = args;
  }
  if (Object.keys(env).length > 0) {
    serverConfig.env = env;
  }

  const scope = setup.scope;

  if (scope === "project") {
    // .mcp.json format
    const mcpJson = {
      mcpServers: {
        "mcp-sandboxed-git-gh-cli": serverConfig,
      },
    };

    lines.push("## Project Config (.mcp.json)");
    lines.push("");
    lines.push("Create this file at the project root:");
    lines.push("");
    pushFenced(lines, "json", JSON.stringify(mcpJson, null, 2));
  } else {
    // Global: ~/.claude.json format via claude mcp add
    const cliParts = [
      "claude mcp add -s user -t stdio",
    ];
    for (const [key, value] of Object.entries(env)) {
      cliParts.push(`-e ${key}='${value}'`);
    }
    cliParts.push("mcp-sandboxed-git-gh-cli");
    cliParts.push(binaryPath);
    if (args.length > 0) {
      cliParts.push("--");
      cliParts.push(...args);
    }

    // Also show the JSON for manual editing
    const claudeJson = {
      "mcp-sandboxed-git-gh-cli": {
        type: "stdio" as const,
        command: binaryPath,
        args,
        env,
      },
    };

    lines.push("## Global Config");
    lines.push("");
    lines.push("### Option A: CLI command");
    lines.push("");
    pushFenced(lines, "sh", cliParts.join(" \\\n  "));
    lines.push("");
    lines.push("### Option B: Add to ~/.claude.json mcpServers");
    lines.push("");
    pushFenced(lines, "json", JSON.stringify(claudeJson, null, 2));
  }

  lines.push("");
  lines.push("After applying, restart the MCP server and run the `doctor` tool to verify.");

  const agentFile = setup.agent_file ?? "skip";
  if (agentFile !== "skip") {
    const snippet = [
      "## Git and gh run outside the sandbox",
      "",
      "SSH signing and TLS break inside the macOS sandbox. This project has an MCP",
      "server that sidesteps that. Use these instead of Bash for all git/gh work:",
      "",
      "- `mcp__mcp-sandboxed-git-gh-cli__git` \u2014 git with working SSH signing",
      "- `mcp__mcp-sandboxed-git-gh-cli__gh` \u2014 gh with working TLS",
      "",
      "Both are deferred tools. ToolSearch them before first use.",
    ].join("\n");

    const files: string[] = [];
    if (agentFile === "claude" || agentFile === "both") files.push("CLAUDE.md");
    if (agentFile === "agents" || agentFile === "both") files.push("AGENTS.md");

    lines.push("");
    lines.push("## Make the tools discoverable");
    lines.push("");
    lines.push(`Add the following to ${files.join(" and ")} in your project root:`);
    lines.push("");
    pushFenced(lines, "markdown", snippet);

    if (agentFile === "agents") {
      lines.push("");
      lines.push("Symlink CLAUDE.md to AGENTS.md so Claude Code picks it up too:");
      lines.push("  ln -s AGENTS.md CLAUDE.md");
    }
  }

  return lines.join("\n");
}

export function registerOnboardTool(
  server: McpServer,
  binaryPath: string,
  probes: ProbeResults,
  config: ServerConfig,
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
              .enum(SCOPES)
              .describe('"project" for .mcp.json, "user" for ~/.claude.json'),
            ssh: z
              .boolean()
              .describe("Forward SSH_AUTH_SOCK for SSH operations and signing"),
            gh_method: z
              .enum(GH_METHODS)
              .optional()
              .describe("gh auth method: user (MCP_GH_USER), token (GH_TOKEN), or config-dir (GH_CONFIG_DIR)"),
            gh_value: z
              .string()
              .optional()
              .describe("Value for the chosen gh auth method (username, token, or path)"),
            agent_file: z
              .enum(AGENT_FILES)
              .optional()
              .describe("Which file to add tool hints to: claude (CLAUDE.md), agents (AGENTS.md), both, or skip"),
            cwd: z
              .string()
              .optional()
              .describe("Default working directory for all commands (--cwd)"),
            git_timeout: z
              .number()
              .optional()
              .describe("Default timeout in ms for git operations (--git-timeout)"),
            gh_timeout: z
              .number()
              .optional()
              .describe("Default timeout in ms for gh operations (--gh-timeout)"),
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
