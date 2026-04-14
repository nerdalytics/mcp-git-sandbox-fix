import type { SecurityPolicy, SubcommandRule } from "./policy.js";

type SanitizeResult = { ok: true } | { ok: false; reason: string };

const deny = (reason: string): SanitizeResult => ({ ok: false, reason });
const allow: SanitizeResult = { ok: true };

// ── Git config read-only detection ──────────────────────────────────

const GIT_CONFIG_READ_FLAGS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "--show-origin",
  "--show-scope",
  "-l",
]);

const GIT_CONFIG_WRITE_FLAGS = new Set([
  "--unset",
  "--unset-all",
  "--rename-section",
  "--remove-section",
  "--replace-all",
  "--add",
  "--edit",
  "-e",
]);

function checkGitConfigReadOnly(
  args: string[],
  rule: SubcommandRule,
): SanitizeResult {
  // args[0] is "config", args[1..] are the config arguments
  const configArgs = args.slice(1);

  // If any explicit read flag is present, it's a read operation
  if (configArgs.some((a) => GIT_CONFIG_READ_FLAGS.has(a))) {
    return allow;
  }

  // If any explicit write flag is present, it's a write
  if (configArgs.some((a) => GIT_CONFIG_WRITE_FLAGS.has(a))) {
    // Check if the key being written is in safeWriteKeys
    return checkConfigKeyAllowed(configArgs, rule);
  }

  // Positional form: `git config <key>` = read, `git config <key> <value>` = write
  // Filter out scope flags (--global, --local, --system, --file, --worktree)
  // and their arguments to find positional args
  const positional = extractPositionalConfigArgs(configArgs);

  if (positional.length <= 1) {
    // 0 or 1 positional = reading (or --list which has 0)
    return allow;
  }

  // 2+ positional = write: `git config <key> <value>`
  return checkConfigKeyAllowed(configArgs, rule);
}

function checkConfigKeyAllowed(
  configArgs: string[],
  rule: SubcommandRule,
): SanitizeResult {
  const safeKeys = rule.safeWriteKeys ?? [];
  // Find the config key — first positional arg that doesn't start with -
  const positional = extractPositionalConfigArgs(configArgs);
  const key = positional[0];
  if (!key) return deny("`git config` write blocked by policy (no key found)");

  if (safeKeys.includes(key)) {
    return allow;
  }
  return deny(
    `\`git config\` write to "${key}" blocked by policy. ` +
      `Writable keys: ${safeKeys.join(", ")}`,
  );
}

const CONFIG_SCOPE_FLAGS_WITH_ARG = new Set(["--file", "-f"]);
const CONFIG_SCOPE_FLAGS = new Set([
  "--global",
  "--local",
  "--system",
  "--worktree",
  "--show-origin",
  "--show-scope",
]);

function extractPositionalConfigArgs(configArgs: string[]): string[] {
  const positional: string[] = [];
  let i = 0;
  while (i < configArgs.length) {
    const a = configArgs[i];
    if (a === "--") {
      // Everything after -- is positional
      positional.push(...configArgs.slice(i + 1));
      break;
    }
    if (CONFIG_SCOPE_FLAGS_WITH_ARG.has(a)) {
      i += 2; // skip flag + its argument
      continue;
    }
    if (CONFIG_SCOPE_FLAGS.has(a) || GIT_CONFIG_READ_FLAGS.has(a) || GIT_CONFIG_WRITE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      i++;
      continue;
    }
    positional.push(a);
    i++;
  }
  return positional;
}

// ── GH API read-only detection ──────────────────────────────────────

const GH_API_WRITE_METHOD_FLAGS = new Set(["-X", "--method"]);
const GH_API_WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const GH_API_WRITE_PAYLOAD_FLAGS = new Set([
  "-f",
  "--field",
  "-F",
  "--raw-field",
  "--input",
]);

function checkGhApiReadOnly(args: string[]): SanitizeResult {
  // args[0] is "api", args[1..] are the api arguments
  const apiArgs = args.slice(1);

  for (let i = 0; i < apiArgs.length; i++) {
    const a = apiArgs[i];
    if (GH_API_WRITE_METHOD_FLAGS.has(a)) {
      const method = apiArgs[i + 1]?.toUpperCase();
      if (method && GH_API_WRITE_METHODS.has(method)) {
        return deny(
          `\`gh api\` with method ${method} blocked by policy (read-only mode)`,
        );
      }
    }
    if (GH_API_WRITE_PAYLOAD_FLAGS.has(a)) {
      return deny(
        `\`gh api\` with "${a}" blocked by policy (read-only mode). ` +
          `Write payloads are not allowed.`,
      );
    }
  }
  return allow;
}

// ── Core sanitizer ──────────────────────────────────────────────────

function hasFlag(args: string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(flag + "="));
}

function checkBlockedFlags(
  args: string[],
  blockedFlags: string[],
  tool: string,
  subcommand: string,
): SanitizeResult {
  for (const flag of blockedFlags) {
    if (hasFlag(args.slice(1), flag)) {
      return deny(
        `\`${tool} ${subcommand}\` with "${flag}" blocked by security policy`,
      );
    }
  }
  return allow;
}

function checkRequireDryRun(args: string[]): SanitizeResult {
  const hasCleanArgs = args.slice(1);
  if (
    hasCleanArgs.includes("--dry-run") ||
    hasCleanArgs.includes("-n")
  ) {
    return allow;
  }
  return deny(
    "`git clean` requires --dry-run or -n under the current security policy. " +
      "Override with a custom --policy file to allow destructive clean.",
  );
}

function checkAllowedActions(
  args: string[],
  allowed: string[],
  tool: string,
  subcommand: string,
): SanitizeResult {
  const action = args[1];
  if (!action) {
    // No action specified — some gh commands work with no subaction (e.g., `gh auth status`)
    // Block if there's no default that makes sense
    return deny(
      `\`${tool} ${subcommand}\` requires an action. Allowed: ${allowed.join(", ")}`,
    );
  }
  if (allowed.includes(action)) {
    return allow;
  }
  return deny(
    `\`${tool} ${subcommand} ${action}\` blocked by policy. ` +
      `Allowed actions: ${allowed.join(", ")}`,
  );
}

function checkBlockedActions(
  args: string[],
  blocked: string[],
  tool: string,
  subcommand: string,
): SanitizeResult {
  const action = args[1];
  if (action && blocked.includes(action)) {
    return deny(
      `\`${tool} ${subcommand} ${action}\` blocked by security policy`,
    );
  }
  return allow;
}

function checkGlobalFlags(
  args: string[],
  blockedGlobalFlags: string[],
  tool: string,
): SanitizeResult {
  // Global flags can appear before the subcommand or anywhere in the args.
  // For git, `-c key=value` is the main concern.
  for (const flag of blockedGlobalFlags) {
    if (args.includes(flag)) {
      return deny(
        `\`${tool}\` global flag "${flag}" blocked by security policy`,
      );
    }
  }
  return allow;
}

// ── Public API ──────────────────────────────────────────────────────

export function sanitizeArgs(
  tool: "git" | "gh",
  args: string[],
  policy: SecurityPolicy,
): SanitizeResult {
  if (args.length === 0) {
    return deny("No arguments provided");
  }

  const toolPolicy = policy[tool];
  const subcommand = args[0];

  // Check subcommand is in policy
  if (!(subcommand in toolPolicy.subcommands)) {
    return deny(
      `Subcommand "${subcommand}" is not allowed by policy. ` +
        `Allowed: ${Object.keys(toolPolicy.subcommands).filter((k) => toolPolicy.subcommands[k] !== false).join(", ")}`,
    );
  }

  const rule = toolPolicy.subcommands[subcommand];

  // Blocked entirely
  if (rule === false) {
    return deny(`\`${tool} ${subcommand}\` is disabled by security policy`);
  }

  // Check global blocked flags
  if (toolPolicy.blockedGlobalFlags?.length) {
    const globalCheck = checkGlobalFlags(
      args,
      toolPolicy.blockedGlobalFlags,
      tool,
    );
    if (!globalCheck.ok) return globalCheck;
  }

  // Allowed with no restrictions
  if (rule === true) {
    return allow;
  }

  // Rule object — apply constraints
  let result: SanitizeResult;

  // blockedFlags
  if (rule.blockedFlags?.length) {
    result = checkBlockedFlags(args, rule.blockedFlags, tool, subcommand);
    if (!result.ok) return result;
  }

  // readOnly (git config)
  if (rule.readOnly && tool === "git" && subcommand === "config") {
    result = checkGitConfigReadOnly(args, rule);
    if (!result.ok) return result;
  }

  // readOnly (gh api)
  if (rule.readOnly && tool === "gh" && subcommand === "api") {
    result = checkGhApiReadOnly(args);
    if (!result.ok) return result;
  }

  // requireDryRun
  if (rule.requireDryRun) {
    result = checkRequireDryRun(args);
    if (!result.ok) return result;
  }

  // allowedActions
  if (rule.allowedActions?.length) {
    result = checkAllowedActions(
      args,
      rule.allowedActions,
      tool,
      subcommand,
    );
    if (!result.ok) return result;
  }

  // blockedActions
  if (rule.blockedActions?.length) {
    result = checkBlockedActions(
      args,
      rule.blockedActions,
      tool,
      subcommand,
    );
    if (!result.ok) return result;
  }

  return allow;
}
