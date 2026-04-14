import { resolve } from "node:path";
import { DEFAULT_TIMEOUT_MS } from "./constants.js";

export interface ServerConfig {
  cwd: string | null;
  gitTimeout: number | null;
  ghTimeout: number | null;
  ghUser: string | null;
  policyPath: string | null;
}

interface FlagDef {
  field: keyof ServerConfig;
  label: string;
  parse?: (value: string, flag: string) => number;
}

function parseTimeout(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag}: "${value}" is not a valid positive integer`);
  }
  const n = parseInt(value, 10);
  if (n < 1_000) throw new Error(`${flag}: minimum timeout is 1000ms`);
  if (n > 300_000) throw new Error(`${flag}: maximum timeout is 300000ms (5 minutes)`);
  return n;
}

const FLAGS: Record<string, FlagDef> = {
  "--cwd": { field: "cwd", label: "a path", parse: (v) => resolve(v) },
  "--git-timeout": { field: "gitTimeout", label: "a number", parse: parseTimeout },
  "--gh-timeout": { field: "ghTimeout", label: "a number", parse: parseTimeout },
  "--gh-user": { field: "ghUser", label: "a username" },
  "--policy": { field: "policyPath", label: "a path to a security policy JSON file" },
};

function usage(): string {
  return [
    "Usage: mcp-sandboxed-git-gh-cli [options]",
    "",
    "Options:",
    "  --cwd <path>           Default working directory for all commands",
    `  --git-timeout <ms>     Default timeout for git operations (default: ${DEFAULT_TIMEOUT_MS})`,
    `  --gh-timeout <ms>      Default timeout for gh operations (default: ${DEFAULT_TIMEOUT_MS})`,
    "  --gh-user <name>       GitHub username for gh auth (alternative to MCP_GH_USER env)",
    "  --policy <path>        Path to a security policy JSON file (overrides defaults)",
    "  --help                 Show this help",
  ].join("\n");
}

export function parseArgs(argv: string[]): ServerConfig {
  const args = argv.slice(2);

  const config: ServerConfig = {
    cwd: null,
    gitTimeout: null,
    ghTimeout: null,
    ghUser: null,
    policyPath: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help") {
      console.error(usage());
      process.exit(0);
    }

    const def = Object.hasOwn(FLAGS, arg) ? FLAGS[arg] : undefined;
    if (!def) {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }

    const next = args[i + 1];
    if (!next) throw new Error(`${arg} requires ${def.label}`);

    (config as Record<string, unknown>)[def.field] = def.parse
      ? def.parse(next, arg)
      : next;
    i++;
  }

  return config;
}
