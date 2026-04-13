import { DEFAULT_TIMEOUT_MS } from "./constants.js";

export interface ServerConfig {
  cwd: string | null;
  gitTimeout: number | null;
  ghTimeout: number | null;
  ghUser: string | null;
}

interface FlagDef {
  field: keyof ServerConfig;
  label: string;
  parse?: (value: string, flag: string) => number;
}

function parseTimeout(value: string, flag: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`${flag}: "${value}" is not a number`);
  return n;
}

const FLAGS: Record<string, FlagDef> = {
  "--cwd": { field: "cwd", label: "a path" },
  "--git-timeout": { field: "gitTimeout", label: "a number", parse: parseTimeout },
  "--gh-timeout": { field: "ghTimeout", label: "a number", parse: parseTimeout },
  "--gh-user": { field: "ghUser", label: "a username" },
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
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help") {
      console.error(usage());
      process.exit(0);
    }

    const def = FLAGS[arg];
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
