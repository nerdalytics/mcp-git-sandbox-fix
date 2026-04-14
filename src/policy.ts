import { readFileSync } from "node:fs";

// ── Types ───────────────────────────────────────────────────────────

export interface SubcommandRule {
  blockedFlags?: string[];
  readOnly?: boolean;
  safeWriteKeys?: string[];
  requireDryRun?: boolean;
  allowedActions?: string[];
  blockedActions?: string[];
}

export interface ToolPolicy {
  subcommands: Record<string, boolean | SubcommandRule>;
  blockedGlobalFlags?: string[];
}

export interface SecurityPolicy {
  git: ToolPolicy;
  gh: ToolPolicy;
}

// ── Default policy ──────────────────────────────────────────────────
// Encodes the security audit recommendations as secure defaults.
// Users can widen permissions by supplying a --policy file that
// deep-merges over these defaults.

export const DEFAULT_POLICY: SecurityPolicy = {
  git: {
    blockedGlobalFlags: ["-c"],
    subcommands: {
      // Read-only / safe commands — no restrictions
      status: true,
      log: true,
      diff: true,
      show: true,
      branch: true,
      tag: true,
      remote: true,
      "rev-parse": true,
      "ls-files": true,
      "ls-remote": true,
      blame: true,
      shortlog: true,
      describe: true,
      stash: true,
      gc: true,

      // Staging / working-tree — safe
      add: true,
      restore: true,
      rm: true,

      // Commit / merge / rebase — with restrictions where needed
      commit: true,
      merge: true,
      "cherry-pick": true,
      revert: true,
      checkout: true,
      switch: true,

      // config: read-only by default, writes only to safe keys
      config: {
        readOnly: true,
        safeWriteKeys: [
          "user.name",
          "user.email",
          "commit.gpgsign",
          "gpg.format",
          "user.signingkey",
          "tag.gpgsign",
          "init.defaultBranch",
          "push.autoSetupRemote",
        ],
      },

      // rebase: block --exec (direct shell execution)
      rebase: { blockedFlags: ["--exec"] },

      // Transport commands: block --upload-pack / --receive-pack (arbitrary program execution)
      clone: { blockedFlags: ["--upload-pack", "--config", "-c"] },
      fetch: { blockedFlags: ["--upload-pack"] },
      pull: { blockedFlags: ["--upload-pack"] },
      push: { blockedFlags: ["--receive-pack"] },

      // clean: require --dry-run (prevents destructive deletion)
      clean: { requireDryRun: true },

      // reset: block --hard (destroys uncommitted work)
      reset: { blockedFlags: ["--hard"] },

      // init / worktree: allowed (path confinement via cwd validation)
      init: true,
      worktree: true,
    },
  },
  gh: {
    subcommands: {
      // Safe read/write commands — no restrictions
      pr: true,
      issue: true,
      run: true,
      status: true,
      search: true,
      label: true,
      project: true,
      cache: true,
      ruleset: true,
      attestation: true,

      // auth: only status (blocks token exposure, login hijack)
      auth: { allowedActions: ["status"] },

      // api: read-only (blocks POST/PUT/PATCH/DELETE)
      api: { readOnly: true },

      // gist: block create/edit/delete (data exfiltration)
      gist: { blockedActions: ["create", "edit", "delete"] },

      // repo: block destructive operations
      repo: {
        blockedActions: ["delete", "archive", "rename", "edit", "create"],
      },

      // release: block publishing (supply chain)
      release: {
        blockedActions: ["create", "delete", "edit", "upload"],
      },

      // workflow: block dispatch (remote code execution)
      workflow: { blockedActions: ["run", "enable", "disable"] },

      // secret / variable: block writes (CI poisoning)
      secret: { blockedActions: ["set", "delete"] },
      variable: { blockedActions: ["set", "delete"] },

      // codespace: disabled (remote shell access)
      codespace: false,

      // browse: disabled (opens browser, useless in MCP)
      browse: false,
    },
  },
};

// ── Policy loading ──────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge user overrides onto the default policy. */
export function mergePolicy(
  base: SecurityPolicy,
  override: Record<string, unknown>,
): SecurityPolicy {
  const result: SecurityPolicy = {
    git: {
      subcommands: { ...base.git.subcommands },
      blockedGlobalFlags: base.git.blockedGlobalFlags
        ? [...base.git.blockedGlobalFlags]
        : undefined,
    },
    gh: {
      subcommands: { ...base.gh.subcommands },
      blockedGlobalFlags: base.gh.blockedGlobalFlags
        ? [...base.gh.blockedGlobalFlags]
        : undefined,
    },
  };

  for (const tool of ["git", "gh"] as const) {
    const overrideTool = override[tool];
    if (!isPlainObject(overrideTool)) continue;

    // Merge blockedGlobalFlags
    if (Array.isArray(overrideTool.blockedGlobalFlags)) {
      result[tool].blockedGlobalFlags = overrideTool.blockedGlobalFlags as string[];
    }

    // Merge subcommands
    const overrideSubs = overrideTool.subcommands;
    if (!isPlainObject(overrideSubs)) continue;

    for (const [name, rule] of Object.entries(overrideSubs)) {
      if (rule === true || rule === false) {
        result[tool].subcommands[name] = rule;
      } else if (isPlainObject(rule)) {
        result[tool].subcommands[name] = rule as SubcommandRule;
      }
    }
  }

  return result;
}

/** Load a policy from a JSON file and merge over defaults. */
export function loadPolicy(policyPath: string): SecurityPolicy {
  const raw = readFileSync(policyPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in policy file: ${policyPath}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Policy file must contain a JSON object: ${policyPath}`);
  }
  return mergePolicy(DEFAULT_POLICY, parsed);
}

/** Derive the set of allowed subcommand names from a tool policy. */
export function allowedSubcommands(policy: ToolPolicy): Set<string> {
  return new Set(
    Object.entries(policy.subcommands)
      .filter(([, rule]) => rule !== false)
      .map(([name]) => name),
  );
}
