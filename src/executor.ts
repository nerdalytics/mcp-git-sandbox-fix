import { execFile } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { DEFAULT_TIMEOUT_MS } from "./constants.js";
import { sanitizeArgs } from "./sanitizer.js";
import { DEFAULT_POLICY } from "./policy.js";
import type { SecurityPolicy } from "./policy.js";

export interface ExecOptions {
  args: string[];
  cwd?: string;
  stdin?: string;
  timeout_ms?: number;
  extraEnv?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  errorCode?: string; // 'ENOENT', 'ETIMEDOUT', etc.
}

const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_STDIN_BYTES = 1_048_576; // 1 MB
const MIN_TIMEOUT_MS = 1_000;     // 1 second
const MAX_TIMEOUT_MS = 300_000;   // 5 minutes

const ALLOWED_BINARIES = new Set([
  "git", "gh", "ssh-keygen", "ssh-add", "ssh", "gpg",
]);

const PROTECTED_ENV_KEYS = new Set([
  "PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
  "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT", "GH_PROMPT_DISABLED",
  "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR",
]);

const INHERITED_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM",
  "SSH_AUTH_SOCK", "GIT_TERMINAL_PROMPT", "GH_PROMPT_DISABLED",
  "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "BROWSER",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "GPG_TTY", "GNUPGHOME", "MCP_GH_USER",
]);

const SENSITIVE_CWD_PREFIXES = [
  "/etc", "/System", "/usr/lib", "/usr/sbin",
];

// ── Policy state ────────────────────────────────────────────────────
// Defaults to DEFAULT_POLICY (secure by default). main() calls
// setPolicy() after loading the user's --policy file.

let activePolicy: SecurityPolicy = DEFAULT_POLICY;

export function setPolicy(policy: SecurityPolicy): void {
  activePolicy = policy;
}

// ── Shared helpers ──────────────────────────────────────────────────

function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || ms === null) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(ms, MAX_TIMEOUT_MS));
}

function validateCwd(cwd: string | undefined): string {
  const resolved = resolvePath(cwd || process.cwd());
  for (const prefix of SENSITIVE_CWD_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(prefix + "/")) {
      throw new Error(`cwd "${resolved}" is in a restricted system directory`);
    }
  }
  return resolved;
}

function buildSafeEnv(extraEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]!;
    }
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (!PROTECTED_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }
  return env;
}

function reject(stderr: string, errorCode?: string): Promise<ExecResult> {
  return Promise.resolve({ stdout: "", stderr, exitCode: 1, errorCode });
}

// ── Raw executor ────────────────────────────────────────────────────
// All hardening (binary allowlist, cwd, env, timeout, stdin) but
// NO policy check. Used by probes at startup before tools are live.

export function execProbeCommand(
  binary: string,
  options: ExecOptions,
): Promise<ExecResult> {
  const { args, cwd, stdin, timeout_ms, extraEnv } = options;

  if (!ALLOWED_BINARIES.has(binary)) {
    return reject(`Binary "${binary}" is not allowed`, "EACCES");
  }

  if (stdin && stdin.length > MAX_STDIN_BYTES) {
    return reject(`stdin exceeds ${MAX_STDIN_BYTES} byte limit`);
  }

  let resolvedCwd: string;
  try {
    resolvedCwd = validateCwd(cwd);
  } catch (e) {
    return reject((e as Error).message);
  }

  return new Promise((resolve) => {
    const child = execFile(
      binary,
      args,
      {
        cwd: resolvedCwd,
        timeout: clampTimeout(timeout_ms),
        maxBuffer: MAX_OUTPUT_BYTES,
        // Do NOT spread process.env into an explicit env object
        // when no extraEnv is provided. Bun compiled binaries may
        // have an incomplete process.env proxy, causing child
        // processes to lose environment variables that git needs
        // for SSH signing. Omitting env lets the child inherit the
        // full C-level environ directly.
        ...(extraEnv ? { env: buildSafeEnv(extraEnv) } : {}),
      },
      (error, stdout, stderr) => {
        let exitCode = 0;
        let errorCode: string | undefined;

        if (error) {
          const code = "code" in error ? error.code : undefined;
          errorCode = typeof code === "string" ? code : undefined;
          exitCode = typeof code === "number" ? code : 1;
        }

        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode,
          errorCode,
        });
      },
    );

    if (stdin && child.stdin) {
      child.stdin.on("error", () => {}); // prevent unhandled EPIPE
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

// ── Policy-enforced executor ────────────────────────────────────────
// For git and gh, validates args against the active security policy
// before executing. All other binaries pass straight through.

export function execCommand(
  binary: string,
  options: ExecOptions,
): Promise<ExecResult> {
  if (binary === "git" || binary === "gh") {
    const check = sanitizeArgs(binary, options.args, activePolicy);
    if (!check.ok) {
      return reject(`Blocked by security policy: ${check.reason}`);
    }
  }
  return execProbeCommand(binary, options);
}
