import { execCommand } from "./executor.js";
import { PROBE_TIMEOUT_MS } from "./constants.js";
import type { GitIdentityProbe, GitSigningProbe } from "./probe.js";

export async function probeExec(binary: string, args: string[]) {
  return execCommand(binary, { args, timeout_ms: PROBE_TIMEOUT_MS });
}

export async function readGitConfig(key: string): Promise<string | null> {
  const result = await probeExec("git", ["config", key]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function readGitConfigOrigin(
  key: string,
): Promise<{ value: string; source: string } | null> {
  const result = await probeExec("git", ["config", "--show-origin", key]);
  if (result.exitCode !== 0) return null;
  const raw = result.stdout.trim();
  const tabIndex = raw.indexOf("\t");
  if (tabIndex === -1) return { value: raw, source: "" };
  return {
    value: raw.substring(tabIndex + 1),
    source: raw.substring(0, tabIndex),
  };
}

export const DEFAULT_GIT_IDENTITY: GitIdentityProbe = {
  configured: false,
  userName: null,
  userEmail: null,
};

export const DEFAULT_GIT_SIGNING: GitSigningProbe = {
  gpgFormat: null,
  commitGpgsign: false,
  signingKey: null,
  signingKeySource: null,
  signingTest: { attempted: false, success: false, error: null },
};
