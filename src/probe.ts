import { openSync, writeSync, closeSync, unlinkSync, constants as fsConstants } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { probeExec, readGitConfig, readGitConfigOrigin, DEFAULT_GIT_IDENTITY, DEFAULT_GIT_SIGNING } from "./probe-helpers.js";

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
  resolvedToken?: string; // Resolved token to be set by main() explicitly
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
  const result = await probeExec(name, name === "ssh" ? ["-V"] : ["--version"]);

  if (result.errorCode === "ENOENT") {
    return { found: false, version: null };
  }

  const output = result.stdout || result.stderr;
  const versionLine = output.split("\n")[0]?.trim() || null;
  return { found: true, version: versionLine };
}

async function probeGitIdentity(): Promise<GitIdentityProbe> {
  const [userName, userEmail] = await Promise.all([
    readGitConfig("user.name"),
    readGitConfig("user.email"),
  ]);

  return {
    configured: userName !== null && userEmail !== null,
    userName,
    userEmail,
  };
}

async function probeGitSigning(): Promise<GitSigningProbe> {
  const [gpgFormat, gpgsignRaw, keyOrigin] = await Promise.all([
    readGitConfig("gpg.format"),
    readGitConfig("commit.gpgsign"),
    readGitConfigOrigin("user.signingkey"),
  ]);

  const commitGpgsign = gpgsignRaw === "true";
  const signingKey = keyOrigin?.value ?? null;
  const signingKeySource = keyOrigin?.source ?? null;

  const base = { gpgFormat, commitGpgsign, signingKey, signingKeySource };

  if (gpgFormat !== "ssh" || !signingKey) {
    return { ...base, signingTest: { attempted: false, success: false, error: null } };
  }

  // Validate signing key path before passing to ssh-keygen
  if (!isAbsolute(signingKey) || signingKey.includes("..")) {
    return { ...base, signingTest: { attempted: false, success: false, error: "invalid signing key path" } };
  }

  // Use unpredictable filename + exclusive creation to prevent symlink attacks
  const tmpFile = join(tmpdir(), `.mcp_sign_test_${randomBytes(12).toString("hex")}`);
  let signResult: { exitCode: number; stderr: string; stdout: string };
  try {
    const fd = openSync(tmpFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    writeSync(fd, "doctor-signing-test");
    closeSync(fd);
    signResult = await probeExec("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", signingKey, tmpFile]);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(tmpFile + ".sig"); } catch {}
  }

  if (signResult.exitCode === 0) {
    return { ...base, signingTest: { attempted: true, success: true, error: null } };
  }

  const error = (signResult.stderr || signResult.stdout).trim();
  return { ...base, signingTest: { attempted: true, success: false, error } };
}

async function probeSshAgent(): Promise<SshAgentProbe> {
  const socketPath = process.env.SSH_AUTH_SOCK;
  if (!socketPath) {
    return { socketSet: false, socketReachable: false, identityCount: 0 };
  }

  const result = await probeExec("ssh-add", ["-l"]);

  // ENOENT = ssh-add missing, exit 2 = agent unreachable
  if (result.errorCode === "ENOENT" || result.exitCode === 2) {
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

async function checkGhAuthStatus(
  authMethod: GhAuthProbe["authMethod"],
  fallbackAccount: string | null = null,
): Promise<GhAuthProbe> {
  const statusResult = await probeExec("gh", ["auth", "status"]);

  const output = statusResult.stdout + statusResult.stderr;
  const match = output.match(/account\s+(\S+)/);

  return {
    authenticated: statusResult.exitCode === 0,
    account: match?.[1] || fallbackAccount,
    authMethod,
    error: statusResult.exitCode !== 0 ? statusResult.stderr.trim() : null,
  };
}

async function resolveGhAuth(ghFound: boolean): Promise<GhAuthProbe> {
  const mcpGhUser = process.env.MCP_GH_USER;
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const ghConfigDir = process.env.GH_CONFIG_DIR;

  if (!ghFound || !(mcpGhUser || ghToken || ghConfigDir)) {
    return { authenticated: false, account: null, authMethod: null, error: null };
  }

  if (mcpGhUser) {
    // Validate username to prevent injection
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(mcpGhUser)) {
      return {
        authenticated: false,
        account: null,
        authMethod: "user",
        error: "MCP_GH_USER contains invalid characters",
      };
    }

    const tokenResult = await probeExec("gh", ["auth", "token", "--user", mcpGhUser]);

    if (tokenResult.exitCode !== 0) {
      return {
        authenticated: false,
        account: mcpGhUser,
        authMethod: "user",
        error: `Failed to resolve token for user "${mcpGhUser}": ${tokenResult.stderr.trim()}`,
      };
    }

    const resolvedToken = tokenResult.stdout.trim();
    // Return the resolved token instead of mutating process.env here.
    // main() in index.ts sets it explicitly.
    const authStatus = await checkGhAuthStatus("user", mcpGhUser);
    if (resolvedToken) {
      authStatus.resolvedToken = resolvedToken;
    }
    return authStatus;
  }

  if (ghToken) {
    return checkGhAuthStatus("token");
  }

  return checkGhAuthStatus("config-dir");
}

export async function runAllProbes(): Promise<ProbeResults> {
  // Snapshot environment state before auth resolution
  const env = {
    home: process.env.HOME || null,
    path: process.env.PATH || null,
    sshAuthSock: process.env.SSH_AUTH_SOCK || null,
    mcpGhUser: process.env.MCP_GH_USER || null,
    ghToken: !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
    ghConfigDir: process.env.GH_CONFIG_DIR || null,
  };

  const [git, gh, ssh, gpg] = await Promise.all([
    probeBinary("git"),
    probeBinary("gh"),
    probeBinary("ssh"),
    probeBinary("gpg"),
  ]);

  // Gated on binary availability from the first batch
  const [gitIdentity, gitSigning, sshAgent, ghAuth] = await Promise.all([
    git.found ? probeGitIdentity() : DEFAULT_GIT_IDENTITY,
    git.found ? probeGitSigning() : DEFAULT_GIT_SIGNING,
    probeSshAgent(),
    resolveGhAuth(gh.found),
  ]);

  return { git, gh, ssh, gpg, gitIdentity, gitSigning, sshAgent, ghAuth, env };
}
