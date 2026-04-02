export interface ServerConfig {
  cwd: string | null;
  gitTimeout: number | null;
  ghTimeout: number | null;
  ghUser: string | null;
}

function usage(): string {
  return [
    "Usage: mcp-git-sandbox-fix [options]",
    "",
    "Options:",
    "  --cwd <path>           Default working directory for all commands",
    "  --git-timeout <ms>     Default timeout for git operations (default: 60000)",
    "  --gh-timeout <ms>      Default timeout for gh operations (default: 60000)",
    "  --gh-user <name>       GitHub username for gh auth (alternative to MCP_GH_USER env)",
    "  --help                 Show this help",
  ].join("\n");
}

export function parseArgs(argv: string[]): ServerConfig {
  // Skip runtime and script entries.
  // Bun compiled binary: argv[0] is the binary path, args start at [1].
  // bun run src/index.ts: argv[0] is bun, argv[1] is the script, args start at [2].
  const isBunRun = argv[0]?.includes("bun") && argv[1]?.endsWith(".ts");
  const args = argv.slice(isBunRun ? 2 : 1);

  const config: ServerConfig = {
    cwd: null,
    gitTimeout: null,
    ghTimeout: null,
    ghUser: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--cwd":
        if (!next) throw new Error("--cwd requires a path");
        config.cwd = next;
        i++;
        break;
      case "--git-timeout":
        if (!next) throw new Error("--git-timeout requires a number");
        config.gitTimeout = parseInt(next, 10);
        if (Number.isNaN(config.gitTimeout)) throw new Error(`--git-timeout: "${next}" is not a number`);
        i++;
        break;
      case "--gh-timeout":
        if (!next) throw new Error("--gh-timeout requires a number");
        config.ghTimeout = parseInt(next, 10);
        if (Number.isNaN(config.ghTimeout)) throw new Error(`--gh-timeout: "${next}" is not a number`);
        i++;
        break;
      case "--gh-user":
        if (!next) throw new Error("--gh-user requires a username");
        config.ghUser = next;
        i++;
        break;
      case "--help":
        console.error(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  return config;
}
