# mcp-unsandboxed-git-cli

MCP server that exposes `git` and `gh` CLI tools outside Claude Code's sandbox, enabling SSH signing, full TLS, and stdin-based commit messages.

## Quick Commands

| Command | Purpose |
|---------|---------|
| `bun run start` | Run server via Bun |
| `bun run build` | Compile to standalone binary in `dist/` |

## Architecture

- **Transport**: Stdio (McpServer + StdioServerTransport)
- **Tools exposed**: `git` (subcommand-allowlisted), `gh` (subcommand-allowlisted)
- **Execution**: `node:child_process.execFile` with 60s default timeout, 1MB max output, terminal prompts disabled
- **Runtime**: Bun 1.3.11 (via mise)

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Server setup, tool registration for `git` and `gh` |
| `src/executor.ts` | `execCommand` wrapper around `execFile` with timeout/stdin support |
| `src/allowlist.ts` | Allowed subcommand sets for `git` and `gh` |
| `.mcp.json` | MCP server config pointing to compiled binary |
| `mise.local.toml` | Local tooling (Bun version) and gh auth hook |

<!--— MCP-UNSANDBOXED-GIT-START —>[Project Index]
|root: .
|IMPORTANT: This is a security-sensitive project — changes to allowlist.ts expand attack surface
|src:{*.ts}
|config:{package.json,tsconfig.json,.mcp.json,mise.local.toml}
|dist:{mcp-unsandboxed-git-cli}
<!--— MCP-UNSANDBOXED-GIT-END —>
