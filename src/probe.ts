import { execCommand } from "./executor.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROBE_TIMEOUT = 5_000;

export interface BinaryProbe {
  found: boolean;
  version: string | null;
}

export interface GitIdentityProbe {
  configured: boolean;
  userName: string | null;
  userEmail: string | null;
}

export interface SshAgentProbe {
  socketSet: boolean;
  socketReachable: boolean;
  identityCount: number;
}

export interface GitSigningProbe {
  gpgFormat: string | null; // 'ssh', 'gpg', 'x509', or null
  commitGpgsign: boolean;
  signingKey: string | null; // user.signingkey value
  signingKeySource: string | null; // which config file it came from
  signingTest: {
    attempted: boolean;
    success: boolean;
    error: string | null;
  };
}

export interface GhAuthProbe {
  authenticated: boolean;
  account: string | null;
  authMethod: "user" | "token" | "config-dir" | null;
  error: string | null;
}

export interface ProbeResults {
  git: BinaryProbe;
  gh: BinaryProbe;
  ssh: BinaryProbe;
  gpg: BinaryProbe;
  gitIdentity: GitIdentityProbe;
  gitSigning: GitSigningProbe;
  sshAgent: SshAgentProbe;
  ghAuth: GhAuthProbe;
  env: {
    home: string | null;
    path: string | null;
    sshAuthSock: string | null;
    mcpGhUser: string | null;
    ghToken: boolean;
    ghConfigDir: string | null;
  };
}

async function probeBinary(name: string): Promise<BinaryProbe> {
  const args = name === "ssh" ? ["-V"] : ["--version"];
  const result = await execCommand(name, { args, timeout_ms: PROBE_TIMEOUT });

  if (result.errorCode === "ENOENT") {
    return { found: false, version: null };
  }

  const output = result.stdout || result.stderr;
  const versionLine = output.split("\n")[0]?.trim() || null;
  return { found: true, version: versionLine };
}

async function probeGitIdentity(): Promise<GitIdentityProbe> {
  const [nameResult, emailResult] = await Promise.all([
    execCommand("git", { args: ["config", "user.name"], timeout_ms: PROBE_TIMEOUT }),
    execCommand("git", { args: ["config", "user.email"], timeout_ms: PROBE_TIMEOUT }),
  ]);

  const userName = nameResult.exitCode === 0 ? nameResult.stdout.trim() : null;
  const userEmail = emailResult.exitCode === 0 ? emailResult.stdout.trim() : null;

  return {
    configured: userName !== null && userEmail !== null,
    userName,
    userEmail,
  };
}

async function probeGitSigning(): Promise<GitSigningProbe> {
  const [formatResult, gpgsignResult, keyResult] = await Promise.all([
    execCommand("git", { args: ["config", "gpg.format"], timeout_ms: PROBE_TIMEOUT }),
    execCommand("git", { args: ["config", "commit.gpgsign"], timeout_ms: PROBE_TIMEOUT }),
    execCommand("git", {
      args: ["config", "--show-origin", "user.signingkey"],
      timeout_ms: PROBE_TIMEOUT,
    }),
  ]);

  const gpgFormat =
    formatResult.exitCode === 0 ? formatResult.stdout.trim() : null;
  const commitGpgsign =
    gpgsignResult.exitCode === 0 && gpgsignResult.stdout.trim() === "true";

  let signingKey: string | null = null;
  let signingKeySource: string | null = null;
  if (keyResult.exitCode === 0) {
    // --show-origin output: "file:/path/to/config\tvalue"
    const raw = keyResult.stdout.trim();
    const tabIndex = raw.indexOf("\t");
    if (tabIndex !== -1) {
      signingKeySource = raw.substring(0, tabIndex);
      signingKey = raw.substring(tabIndex + 1);
    } else {
      signingKey = raw;
    }
  }

  // Only attempt signing test for SSH signing with a key configured
  if (gpgFormat !== "ssh" || !signingKey) {
    return {
      gpgFormat,
      commitGpgsign,
      signingKey,
      signingKeySource,
      signingTest: { attempted: false, success: false, error: null },
    };
  }

  // Test actual SSH signing using a temp FILE — matching how git invokes it:
  //   ssh-keygen -Y sign -n git -f <pubkey> <file>
  // NOT via stdin, which is a different code path that can give false positives.
  const tmpFile = join(tmpdir(), `.mcp_doctor_sign_test_${process.pid}`);
  let signResult: { exitCode: number; stderr: string; stdout: string };
  try {
    writeFileSync(tmpFile, "doctor-signing-test");
    signResult = await execCommand("ssh-keygen", {
      args: ["-Y", "sign", "-n", "git", "-f", signingKey, tmpFile],
      timeout_ms: PROBE_TIMEOUT,
    });
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {}
  }

  if (signResult.exitCode === 0) {
    return {
      gpgFormat,
      commitGpgsign,
      signingKey,
      signingKeySource,
      signingTest: { attempted: true, success: true, error: null },
    };
  }

  const error = (signResult.stderr || signResult.stdout).trim();
  return {
    gpgFormat,
    commitGpgsign,
    signingKey,
    signingKeySource,
    signingTest: { attempted: true, success: false, error },
  };
}

async function probeSshAgent(): Promise<SshAgentProbe> {
  const socketPath = process.env.SSH_AUTH_SOCK;
  if (!socketPath) {
    return { socketSet: false, socketReachable: false, identityCount: 0 };
  }

  const result = await execCommand("ssh-add", {
    args: ["-l"],
    timeout_ms: PROBE_TIMEOUT,
  });

  if (result.errorCode === "ENOENT") {
    return { socketSet: true, socketReachable: false, identityCount: 0 };
  }

  // Exit 2 = agent unreachable, exit 1 = reachable but no identities
  if (result.exitCode === 2) {
    return { socketSet: true, socketReachable: false, identityCount: 0 };
  }

  const lines = result.stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);

  return {
    socketSet: true,
    socketReachable: true,
    identityCount: result.exitCode === 0 ? lines.length : 0,
  };
}

async function resolveGhAuth(ghFound: boolean): Promise<GhAuthProbe> {
  const mcpGhUser = process.env.MCP_GH_USER;
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const ghConfigDir = process.env.GH_CONFIG_DIR;

  const hasGhConfig = !!(mcpGhUser || ghToken || ghConfigDir);

  if (!ghFound || !hasGhConfig) {
    return { authenticated: false, account: null, authMethod: null, error: null };
  }

  // Priority 1: MCP_GH_USER — resolve token via gh auth token
  if (mcpGhUser) {
    const tokenResult = await execCommand("gh", {
      args: ["auth", "token", "--user", mcpGhUser],
      timeout_ms: PROBE_TIMEOUT,
    });

    if (tokenResult.exitCode !== 0) {
      return {
        authenticated: false,
        account: mcpGhUser,
        authMethod: "user",
        error: `Failed to resolve token for user "${mcpGhUser}": ${tokenResult.stderr.trim()}`,
      };
    }

    const resolvedToken = tokenResult.stdout.trim();
    if (resolvedToken) {
      process.env.GH_TOKEN = resolvedToken;
    }

    const statusResult = await execCommand("gh", {
      args: ["auth", "status"],
      timeout_ms: PROBE_TIMEOUT,
    });

    const output = statusResult.stdout + statusResult.stderr;
    const match = output.match(/account\s+(\S+)/);

    return {
      authenticated: statusResult.exitCode === 0,
      account: match?.[1] || mcpGhUser,
      authMethod: "user",
      error: statusResult.exitCode !== 0 ? statusResult.stderr.trim() : null,
    };
  }

  // Priority 2: GH_TOKEN / GITHUB_TOKEN — verify with gh auth status
  if (ghToken) {
    const statusResult = await execCommand("gh", {
      args: ["auth", "status"],
      timeout_ms: PROBE_TIMEOUT,
    });

    const output = statusResult.stdout + statusResult.stderr;
    const match = output.match(/account\s+(\S+)/);

    return {
      authenticated: statusResult.exitCode === 0,
      account: match?.[1] || null,
      authMethod: "token",
      error: statusResult.exitCode !== 0 ? statusResult.stderr.trim() : null,
    };
  }

  // Priority 3: GH_CONFIG_DIR — verify with gh auth status
  const statusResult = await execCommand("gh", {
    args: ["auth", "status"],
    timeout_ms: PROBE_TIMEOUT,
  });

  const output = statusResult.stdout + statusResult.stderr;
  const match = output.match(/account\s+(\S+)/);

  return {
    authenticated: statusResult.exitCode === 0,
    account: match?.[1] || null,
    authMethod: "config-dir",
    error: statusResult.exitCode !== 0 ? statusResult.stderr.trim() : null,
  };
}

export async function runAllProbes(): Promise<ProbeResults> {
  // Capture env snapshot BEFORE auth resolution can mutate process.env.GH_TOKEN
  const env = {
    home: process.env.HOME || null,
    path: process.env.PATH || null,
    sshAuthSock: process.env.SSH_AUTH_SOCK || null,
    mcpGhUser: process.env.MCP_GH_USER || null,
    ghToken: !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
    ghConfigDir: process.env.GH_CONFIG_DIR || null,
  };

  // Phase 1: binary probes in parallel
  const [git, gh, ssh, gpg] = await Promise.all([
    probeBinary("git"),
    probeBinary("gh"),
    probeBinary("ssh"),
    probeBinary("gpg"),
  ]);

  // Phase 2: dependent probes in parallel (gh auth depends on gh binary result)
  const [gitIdentity, gitSigning, sshAgent, ghAuth] = await Promise.all([
    git.found
      ? probeGitIdentity()
      : { configured: false, userName: null, userEmail: null },
    git.found
      ? probeGitSigning()
      : {
          gpgFormat: null,
          commitGpgsign: false,
          signingKey: null,
          signingKeySource: null,
          signingTest: { attempted: false, success: false, error: null },
        },
    probeSshAgent(),
    resolveGhAuth(gh.found),
  ]);

  return { git, gh, ssh, gpg, gitIdentity, gitSigning, sshAgent, ghAuth, env };
}
