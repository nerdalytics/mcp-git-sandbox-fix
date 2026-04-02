import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProbeResults } from "./probe.js";
import type { ServerConfig } from "./config.js";
import { check, textResult } from "./format.js";

function formatReport(probes: ProbeResults, ghRegistered: boolean, config: ServerConfig): string {
  const lines: string[] = [];
  const recommendations: string[] = [];

  lines.push("## Environment");
  lines.push(`  HOME: ${probes.env.home ?? "(not set)"}`);
  lines.push(`  PATH: ${probes.env.path ?? "(not set)"}`);
  lines.push(
    `  SSH_AUTH_SOCK: ${probes.env.sshAuthSock ?? "(not set)"}`,
  );
  lines.push(
    `  MCP_GH_USER: ${probes.env.mcpGhUser ?? "(not set)"}`,
  );
  lines.push(`  GH_TOKEN: ${probes.env.ghToken ? "(set)" : "(not set)"}`);
  lines.push(
    `  GH_CONFIG_DIR: ${probes.env.ghConfigDir ?? "(not set)"}`,
  );
  lines.push("");

  lines.push("## CLI Args");
  lines.push(`  --cwd: ${config.cwd ?? "(not set — using process.cwd)"}`);
  lines.push(`  --git-timeout: ${config.gitTimeout ?? "(default 60000)"}`);
  lines.push(`  --gh-timeout: ${config.ghTimeout ?? "(default 60000)"}`);
  lines.push(`  --gh-user: ${config.ghUser ?? "(not set)"}`);
  lines.push("");

  lines.push("## Binaries");
  lines.push(
    `  git: ${check(probes.git.found)} ${probes.git.version ?? "not found"}`,
  );
  lines.push(
    `  gh: ${check(probes.gh.found)} ${probes.gh.version ?? "not found"}`,
  );
  lines.push(
    `  ssh: ${check(probes.ssh.found)} ${probes.ssh.version ?? "not found"}`,
  );
  lines.push(
    `  gpg: ${check(probes.gpg.found)} ${probes.gpg.version ?? "not found"}`,
  );
  lines.push("");

  lines.push("## Git Identity");
  if (probes.gitIdentity.configured) {
    lines.push(`  user.name: ${probes.gitIdentity.userName}`);
    lines.push(`  user.email: ${probes.gitIdentity.userEmail}`);
  } else {
    lines.push(
      `  user.name: ${probes.gitIdentity.userName ?? "(not set)"}`,
    );
    lines.push(
      `  user.email: ${probes.gitIdentity.userEmail ?? "(not set)"}`,
    );
    recommendations.push(
      "Git identity is not fully configured. Run:\n" +
        '  git config --global user.name "Your Name"\n' +
        '  git config --global user.email "you@example.com"',
    );
  }
  lines.push("");

  lines.push("## Commit Signing");
  const s = probes.gitSigning;

  if (!s.gpgFormat && !s.commitGpgsign && !s.signingKey) {
    lines.push("  Not configured");
  } else {
    lines.push(`  gpg.format: ${s.gpgFormat ?? "(not set)"}`);
    lines.push(`  commit.gpgsign: ${s.commitGpgsign}`);
    if (s.signingKey) {
      lines.push(`  user.signingkey: ${s.signingKey}`);
      if (s.signingKeySource) {
        lines.push(`  signingkey source: ${s.signingKeySource}`);
      }
    } else {
      lines.push("  user.signingkey: (not set)");
    }

    if (s.signingTest.attempted) {
      if (s.signingTest.success) {
        lines.push(
          `  signing test (ssh-keygen file-based): ${check(true)} passed`,
        );
        lines.push(
          "  Note: This tests ssh-keygen with a temp file, matching how git invokes it.",
        );
        lines.push(
          "  The git tool also verifies signatures after each commit.",
        );
      } else {
        lines.push(
          `  signing test (ssh-keygen file-based): ${check(false)} FAILED`,
        );
        if (s.signingTest.error) {
          lines.push(`  error: ${s.signingTest.error}`);
        }
        recommendations.push(
          "SSH signing test failed. git commit -S will silently produce unsigned commits.\n" +
            `Error: ${s.signingTest.error ?? "(unknown)"}\n` +
            "\n" +
            "Common causes:\n" +
            "  - The private key requires a passphrase but the SSH agent cannot provide it\n" +
            "  - SSH_AUTH_SOCK is not set or the agent is unreachable from this process\n" +
            "  - The signing key file does not exist at the configured path\n" +
            "\n" +
            "To fix:\n" +
            "  1. Ensure SSH_AUTH_SOCK is forwarded to the server\n" +
            "  2. Ensure the key is loaded in the agent: ssh-add <private-key-path>\n" +
            "  3. Restart the MCP server",
        );
      }
    } else if (s.gpgFormat === "ssh" && !s.signingKey) {
      lines.push("  signing test: not attempted (no signing key in global config)");
      if (s.commitGpgsign) {
        lines.push(
          "  Note: commit.gpgsign is true but user.signingkey is not in the global config.",
        );
        lines.push(
          "  This is normal if user.signingkey is set via includeIf for specific repositories.",
        );
        lines.push(
          "  Signing will only work in repos where the conditional include resolves the key.",
        );
      } else {
        recommendations.push(
          "gpg.format is set to ssh but user.signingkey is not configured.\n" +
            "Signing will not work until a key is set:\n" +
            "  git config --global user.signingkey ~/.ssh/id_ed25519.pub",
        );
      }
    }
  }
  lines.push("");

  lines.push("## SSH Agent");
  if (!probes.env.sshAuthSock) {
    lines.push("  SSH_AUTH_SOCK: not set");
    recommendations.push(
      "SSH_AUTH_SOCK is not set. To enable SSH-based git operations and commit signing,\n" +
        "add to your server config (via `claude mcp add -e` or the env block in .mcp.json / .claude.json):\n" +
        '  "SSH_AUTH_SOCK": "${SSH_AUTH_SOCK}"',
    );
  } else if (!probes.sshAgent.socketReachable) {
    lines.push(`  Socket: ${probes.env.sshAuthSock}`);
    lines.push("  Agent reachable: no");
    recommendations.push(
      "SSH_AUTH_SOCK is set but the agent is not responding.\n" +
        "Ensure your SSH agent is running.",
    );
  } else {
    lines.push(`  Socket: ${probes.env.sshAuthSock}`);
    lines.push("  Agent reachable: yes");
    lines.push(`  Identities loaded: ${probes.sshAgent.identityCount}`);
    if (probes.sshAgent.identityCount === 0) {
      recommendations.push(
        "SSH agent is running but has no keys loaded.\n" +
          "Run ssh-add to add your default key, or ssh-add /path/to/key for a specific key.",
      );
    }
  }
  lines.push("");

  lines.push("## GitHub CLI Authentication");
  const hasGhConfig = !!(
    probes.env.mcpGhUser ||
    probes.env.ghToken ||
    probes.env.ghConfigDir
  );

  if (!probes.gh.found) {
    lines.push("  Status: gh binary not found");
  } else if (!hasGhConfig) {
    lines.push("  Status: not checked (no gh auth configured in server environment)");
  } else if (probes.ghAuth.authenticated) {
    lines.push(`  Status: authenticated`);
    lines.push(`  Account: ${probes.ghAuth.account ?? "(unknown)"}`);
    lines.push(`  Auth method: ${probes.ghAuth.authMethod}`);
  } else {
    lines.push(`  Status: authentication failed`);
    lines.push(`  Auth method attempted: ${probes.ghAuth.authMethod}`);
    if (probes.ghAuth.error) {
      lines.push(`  Error: ${probes.ghAuth.error}`);
    }

    if (probes.ghAuth.authMethod === "user") {
      recommendations.push(
        `MCP_GH_USER is set to "${probes.env.mcpGhUser}" but token resolution failed.\n` +
          `The account may not exist locally. Run:\n` +
          `  gh auth login\n` +
          `Then restart the MCP server.`,
      );
    } else if (probes.ghAuth.authMethod === "token") {
      recommendations.push(
        "GH_TOKEN is set but authentication failed.\n" +
          "The token may be invalid or expired.",
      );
    } else if (probes.ghAuth.authMethod === "config-dir") {
      recommendations.push(
        "GH_CONFIG_DIR is set but authentication failed.\n" +
          "Check that the config directory contains valid credentials.",
      );
    }
  }

  if (probes.env.mcpGhUser && probes.env.ghToken) {
    lines.push("");
    lines.push(
      "  Note: MCP_GH_USER and GH_TOKEN are both set. MCP_GH_USER takes priority; GH_TOKEN is overwritten with the resolved token.",
    );
  }
  lines.push("");

  lines.push("## Active Tools");
  lines.push(`  git: ${check(true)} enabled`);
  if (ghRegistered) {
    lines.push(`  gh: ${check(true)} enabled`);
  } else {
    const reason = !probes.gh.found
      ? "gh binary not found"
      : "no gh auth configured in server environment";
    lines.push(`  gh: ${check(false)} disabled \u2014 ${reason}`);
  }
  lines.push(`  doctor: ${check(true)} enabled`);
  lines.push("");

  lines.push("## gh Authentication Priority");
  lines.push("  The server resolves gh authentication in this order (first match wins):");
  lines.push(
    "  1. MCP_GH_USER  \u2014 resolves token via `gh auth token --user <value>` (recommended for SSO / multi-account)",
  );
  lines.push("  2. GH_TOKEN / GITHUB_TOKEN \u2014 uses token directly");
  lines.push(
    "  3. GH_CONFIG_DIR \u2014 defers to active account in that config directory",
  );
  lines.push("");

  if (!probes.gh.found && !hasGhConfig) {
    // gh not found and not configured — don't recommend anything, user probably doesn't need it
  } else if (probes.gh.found && !hasGhConfig) {
    recommendations.push(
      "gh is installed but not configured for this server.\n" +
        "To enable the gh tool, add one of these to your server config (via `claude mcp add -e` or the env block in .mcp.json / .claude.json):\n" +
        '  "MCP_GH_USER": "your-account"           \u2014 use a specific gh account (works with SSO)\n' +
        '  "GH_TOKEN": "ghp_..."                    \u2014 use a personal access token\n' +
        '  "GH_CONFIG_DIR": "${HOME}/.config/gh"    \u2014 use stored gh credentials',
    );
  }

  if (!probes.gpg.found) {
    recommendations.push(
      "gpg is not found. Install it if you need GPG commit signing:\n" +
        "  brew install gnupg",
    );
  }

  if (recommendations.length > 0) {
    lines.push("## Recommendations");
    for (const rec of recommendations) {
      lines.push(`  ${rec.replace(/\n/g, "\n  ")}`);
      lines.push("");
    }
  } else {
    lines.push("## Recommendations");
    lines.push("  No issues found.");
    lines.push("");
  }

  return lines.join("\n");
}

export function registerDoctorTool(
  server: McpServer,
  probes: ProbeResults,
  ghRegistered: boolean,
  config: ServerConfig,
): void {
  server.registerTool(
    "doctor",
    {
      description:
        "Diagnose the MCP server environment. Reports binary availability, " +
        "git identity, commit signing (tests actual ssh-keygen signing), " +
        "SSH agent status, gh authentication, active tools, " +
        "and actionable recommendations for fixing configuration issues.",
    },
    async () => {
      return textResult(formatReport(probes, ghRegistered, config));
    },
  );
}
