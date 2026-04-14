# mcp-sandboxed-git-gh-cli

An MCP server that runs `git` and `gh` CLI commands **outside** Claude Code's macOS sandbox, working around known sandbox bugs that break:

- **Git SSH signing** -- sandbox blocks SSH/raw TCP, preventing commit signing with SSH keys
- **GitHub CLI (gh) TLS** -- sandbox blocks `com.apple.trustd.agent` Mach IPC, causing Go binaries to fail with `x509: OSStatus -26276`
- **Heredoc temp files** -- sandbox blocks `/tmp` writes needed for multi-line commit messages

The server runs as a standalone binary that inherits the user's configured environment -- no shell, no profile scripts, no implicit state.

## Configure in Claude Code

Register the server globally with `claude mcp add`, or add a `.mcp.json` at the project root to share it with collaborators.

The server progressively discloses tools based on what you configure. Only `git` and `doctor` are always available. The `gh` tool requires explicit authentication configuration.

### Minimal: git only

No env vars needed. The MCP SDK passes `HOME` and `PATH` by default, which is enough for local git operations (status, log, diff, add, commit, branch, etc.).

```sh
claude mcp add -s user -t stdio mcp-sandboxed-git-gh-cli \
  /absolute/path/to/dist/mcp-sandboxed-git-gh-cli
```

### git + SSH

Required for `git push`/`pull` over SSH and SSH commit signing. Forward the SSH agent socket so the server can reach your keys.

```sh
claude mcp add -s user -t stdio mcp-sandboxed-git-gh-cli \
  -e SSH_AUTH_SOCK='${SSH_AUTH_SOCK}' \
  /absolute/path/to/dist/mcp-sandboxed-git-gh-cli
```

### git + gh (with account selection)

The `gh` tool is only registered when you explicitly configure authentication. This prevents the server from silently using the wrong account.

**Recommended: select a specific gh account (works with SSO and multi-account setups):**

```sh
claude mcp add -s user -t stdio mcp-sandboxed-git-gh-cli \
  -e SSH_AUTH_SOCK='${SSH_AUTH_SOCK}' \
  -e MCP_GH_USER=your-github-username \
  /absolute/path/to/dist/mcp-sandboxed-git-gh-cli
```

At startup the server runs `gh auth token --user <value>` to resolve the account's token from your local gh credential store. No global state is mutated -- the token is extracted and used for this server session only.

**Alternative: use a personal access token directly:**

```sh
claude mcp add -s user -t stdio mcp-sandboxed-git-gh-cli \
  -e SSH_AUTH_SOCK='${SSH_AUTH_SOCK}' \
  -e GH_TOKEN=ghp_... \
  /absolute/path/to/dist/mcp-sandboxed-git-gh-cli
```

**Alternative: point to a gh config directory:**

```sh
claude mcp add -s user -t stdio mcp-sandboxed-git-gh-cli \
  -e SSH_AUTH_SOCK='${SSH_AUTH_SOCK}' \
  -e GH_CONFIG_DIR='${HOME}/.config/gh' \
  /absolute/path/to/dist/mcp-sandboxed-git-gh-cli
```

`claude mcp add` writes to `~/.claude.json` (user scope) or `.claude.json` in the project root (project scope).

Alternatively, add a `.mcp.json` at the project root -- useful for sharing the config with collaborators:

```json
{
  "mcpServers": {
    "mcp-sandboxed-git-gh-cli": {
      "command": "/absolute/path/to/dist/mcp-sandboxed-git-gh-cli",
      "env": {
        "SSH_AUTH_SOCK": "${SSH_AUTH_SOCK}",
        "MCP_GH_USER": "your-github-username"
      }
    }
  }
}
```

### Make the tools discoverable

Claude Code loads MCP tools lazily -- they don't appear until you search for them. To make sure agents reach for these tools instead of Bash, add the following to your project's `CLAUDE.md` or `AGENTS.md`:

```markdown
## Git and gh run outside the sandbox

SSH signing and TLS break inside the macOS sandbox. This project has an MCP server that sidesteps that. Use these instead of Bash for all git/gh work:

- `mcp__mcp-sandboxed-git-gh-cli__git` -- git with working SSH signing
- `mcp__mcp-sandboxed-git-gh-cli__gh` -- gh with working TLS

Both are deferred tools. ToolSearch them before first use.
```

This works with any agent that reads `CLAUDE.md` or `AGENTS.md` -- symlink one to the other if you want to stay agent-agnostic.

### gh authentication priority

When multiple auth variables are set, the server uses the first match:

1. `MCP_GH_USER` -- resolves token via `gh auth token --user <value>`
2. `GH_TOKEN` / `GITHUB_TOKEN` -- uses token directly
3. `GH_CONFIG_DIR` -- defers to the active account in that config directory

### Environment variables reference

The MCP SDK passes `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, and `USER` by default. Anything else must be explicitly forwarded via `-e` flags or the `env` block.

| Variable | Purpose | When needed |
|----------|---------|-------------|
| `SSH_AUTH_SOCK` | SSH agent socket for key-based auth and signing | git push/pull over SSH, SSH commit signing |
| `MCP_GH_USER` | gh account to use (resolved at startup) | gh tool with SSO or multi-account |
| `GH_TOKEN` | GitHub personal access token | gh tool with a specific token |
| `GITHUB_TOKEN` | Alternative GitHub token variable | gh tool with a specific token |
| `GH_CONFIG_DIR` | Path to gh config directory | gh tool with stored credentials |

Only include variables that are set in your environment -- unset `${VAR}` references cause warnings.

## Tools

### `git`

Always available. Run git subcommands allowed by the active security policy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `args` | `string[]` | Yes | Git arguments, e.g. `["commit", "-S", "-F", "-"]` |
| `cwd` | `string` | No | Working directory (defaults to server cwd) |
| `stdin` | `string` | No | Text piped to stdin (use with `git commit -F -`) |
| `timeout_ms` | `number` | No | Timeout in ms (default 60000) |

Some subcommands have restricted flags under the default policy. See [Security policy](#security-policy) for the full table.

### `gh`

Available only when gh authentication is configured. Run gh subcommands allowed by the active security policy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `args` | `string[]` | Yes | gh arguments, e.g. `["pr", "list", "--limit", "10"]` |
| `cwd` | `string` | No | Working directory (defaults to server cwd) |
| `stdin` | `string` | No | Text piped to stdin |
| `timeout_ms` | `number` | No | Timeout in ms (default 60000) |

Some subcommands have restricted actions under the default policy. See [Security policy](#security-policy) for the full table.

### `doctor`

Always available. Takes no arguments. Diagnoses the server environment and reports:

- Binary availability (git, gh, ssh, gpg)
- Git identity (user.name, user.email)
- SSH agent status
- gh authentication status and method
- Which tools are active and why
- Actionable recommendations for fixing issues

Run the doctor tool after registering the server to verify your configuration.

## Prerequisites

- `git` installed and on PATH

Optional, depending on configuration:

- `gh` installed and authenticated (`gh auth login`) for the gh tool
- SSH agent running for SSH operations
- `gpg` installed for GPG commit signing

## Install

```sh
bun install
```

## Build

```sh
bun run build
```

Produces a standalone executable at `dist/mcp-sandboxed-git-gh-cli` (~66 MB). The binary is large because `bun build --compile` embeds the entire Bun runtime (JavaScriptCore engine, Node.js API compatibility, crypto, etc.). The actual application code is a few hundred KB -- the rest is the runtime. The tradeoff: no runtime dependencies needed on the target machine.

## Run (development)

```sh
bun run start
```

## Test

### Smoke test (initialize handshake)

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' \
  | ./dist/mcp-sandboxed-git-gh-cli
```

### Run the doctor tool

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"doctor","arguments":{}}}' \
  | ./dist/mcp-sandboxed-git-gh-cli
```

### Test allowlist rejection

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"git","arguments":{"args":["daemon"]}}}' \
  | ./dist/mcp-sandboxed-git-gh-cli
```

Replace `./dist/mcp-sandboxed-git-gh-cli` with `bun run src/index.ts` for development testing.

## Security policy

Commands run via `execFile` (no shell). Arguments are passed as an array, so shell metacharacters like `;`, `&&`, `$()`, and backticks are treated as literal strings -- no command injection is possible.

Beyond that, the server enforces a **configurable security policy** that validates git/gh arguments per subcommand. The default policy is secure out of the box. Users can widen permissions by supplying a custom policy file via `--policy <path>`.

| Layer | Mechanism |
|-------|-----------|
| No shell | `execFile` without `shell: true` -- args are an array, not a parsed string |
| Security policy | Per-subcommand argument validation (`src/policy.ts`, `src/sanitizer.ts`) |
| Binary allowlist | Only `git`, `gh`, `ssh-keygen`, `ssh-add`, `ssh`, `gpg` can be executed |
| cwd validation | System directories (`/etc`, `/System`, `/usr/lib`, `/usr/sbin`) are rejected |
| Environment protection | Protected env vars (`PATH`, `LD_PRELOAD`, `GIT_SSH_COMMAND`, etc.) cannot be overridden |
| Progressive disclosure | `gh` tool only exposed when auth is explicitly configured |
| Output sanitization | ANSI escape sequences stripped, output truncated at 1 MB |
| Timeout | Clamped to 1s--5min range; `timeout_ms: 0` cannot disable the timeout |
| stdin limit | 1 MB maximum to prevent memory exhaustion |
| No interactive prompts | `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1` prevent stalls |

### Default policy

The default policy ships with the server and is applied when no `--policy` flag is provided. Each subcommand is either unrestricted (`true`), disabled (`false`), or has specific constraints.

**Rule types:**

| Rule | Meaning |
|------|---------|
| `true` | Allowed, no restrictions on flags or arguments |
| `false` | Blocked entirely |
| `blockedFlags` | Specific flags are rejected (exact match and prefix match) |
| `readOnly` | For `git config`: only read operations and writes to `safeWriteKeys`. For `gh api`: only GET requests |
| `safeWriteKeys` | Config keys that are writable even in `readOnly` mode |
| `requireDryRun` | `--dry-run` or `-n` must be present |
| `allowedActions` | Only these `args[1]` values are permitted |
| `blockedActions` | These `args[1]` values are rejected |
| `blockedGlobalFlags` | Flags blocked regardless of subcommand (e.g., `git -c`) |

#### Git subcommands

| Subcommand | Rule | Details |
|------------|------|---------|
| `status` | `true` | |
| `log` | `true` | |
| `diff` | `true` | |
| `show` | `true` | |
| `branch` | `true` | |
| `tag` | `true` | |
| `remote` | `true` | |
| `rev-parse` | `true` | |
| `ls-files` | `true` | |
| `ls-remote` | `true` | |
| `blame` | `true` | |
| `shortlog` | `true` | |
| `describe` | `true` | |
| `stash` | `true` | |
| `gc` | `true` | |
| `add` | `true` | |
| `restore` | `true` | |
| `rm` | `true` | |
| `commit` | `true` | |
| `merge` | `true` | |
| `cherry-pick` | `true` | |
| `revert` | `true` | |
| `checkout` | `true` | |
| `switch` | `true` | |
| `init` | `true` | |
| `worktree` | `true` | |
| `config` | `readOnly` | Writes allowed only to: `user.name`, `user.email`, `commit.gpgsign`, `gpg.format`, `user.signingkey`, `tag.gpgsign`, `init.defaultBranch`, `push.autoSetupRemote` |
| `rebase` | `blockedFlags` | `--exec` blocked (shell execution) |
| `clone` | `blockedFlags` | `--upload-pack`, `--config`, `-c` blocked (arbitrary program execution) |
| `fetch` | `blockedFlags` | `--upload-pack` blocked |
| `pull` | `blockedFlags` | `--upload-pack` blocked |
| `push` | `blockedFlags` | `--receive-pack` blocked |
| `clean` | `requireDryRun` | `--dry-run` or `-n` required |
| `reset` | `blockedFlags` | `--hard` blocked (destroys uncommitted work) |

**Global:** `-c` flag blocked at top level (prevents `git -c core.hooksPath=... commit`)

#### GH subcommands

| Subcommand | Rule | Details |
|------------|------|---------|
| `pr` | `true` | |
| `issue` | `true` | |
| `run` | `true` | |
| `status` | `true` | |
| `search` | `true` | |
| `label` | `true` | |
| `project` | `true` | |
| `cache` | `true` | |
| `ruleset` | `true` | |
| `attestation` | `true` | |
| `auth` | `allowedActions` | Only `status` (blocks `token`, `login`, `logout`) |
| `api` | `readOnly` | GET only; blocks `-X POST/PUT/PATCH/DELETE`, `-f`, `--input` |
| `gist` | `blockedActions` | `create`, `edit`, `delete` blocked (data exfiltration) |
| `repo` | `blockedActions` | `delete`, `archive`, `rename`, `edit`, `create` blocked |
| `release` | `blockedActions` | `create`, `delete`, `edit`, `upload` blocked (supply chain) |
| `workflow` | `blockedActions` | `run`, `enable`, `disable` blocked (CI dispatch) |
| `secret` | `blockedActions` | `set`, `delete` blocked (CI poisoning) |
| `variable` | `blockedActions` | `set`, `delete` blocked |
| `codespace` | `false` | Disabled (remote shell access) |
| `browse` | `false` | Disabled (opens browser, useless in MCP) |

### Custom policy

To override specific defaults, create a JSON file and pass it via `--policy`:

```sh
claude mcp add -s user -t stdio mcp-sandboxed-git-gh-cli \
  /absolute/path/to/dist/mcp-sandboxed-git-gh-cli \
  -- --policy /path/to/policy.json
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "mcp-sandboxed-git-gh-cli": {
      "command": "/absolute/path/to/dist/mcp-sandboxed-git-gh-cli",
      "args": ["--policy", "./security-policy.json"]
    }
  }
}
```

The custom policy is **deep-merged** over the defaults -- you only need to specify the entries you want to change. Everything else keeps its default.

**Examples:**

Allow `git clean` without `--dry-run`:
```json
{
  "git": { "subcommands": { "clean": true } }
}
```

Allow `gh api` writes:
```json
{
  "gh": { "subcommands": { "api": true } }
}
```

Enable `gh codespace`:
```json
{
  "gh": { "subcommands": { "codespace": true } }
}
```

Allow `git config` to write any key:
```json
{
  "git": { "subcommands": { "config": true } }
}
```

Restrict `git config` writes to a custom set of keys:
```json
{
  "git": {
    "subcommands": {
      "config": {
        "readOnly": true,
        "safeWriteKeys": ["user.name", "user.email", "core.autocrlf"]
      }
    }
  }
}
```

Remove the `-c` global flag restriction:
```json
{
  "git": { "blockedGlobalFlags": [] }
}
```

## Project structure

```
src/
  index.ts          Server setup, probe-then-register flow, stdio transport
  executor.ts       execFile wrapper with policy enforcement, timeout, stdin, output cap
  policy.ts         SecurityPolicy types, DEFAULT_POLICY, load/merge
  sanitizer.ts      Policy-driven argument validator (sanitizeArgs)
  allowlist.ts      Derives allowed subcommand sets from policy (backward compat)
  config.ts         CLI argument parsing (--cwd, --policy, --git-timeout, etc.)
  probe.ts          Startup probes for binaries, identity, SSH, gh auth
  probe-helpers.ts  Probe utilities (git config reads, defaults)
  format.ts         Output formatting (ANSI stripping, truncation)
  doctor.ts         Doctor tool registration and diagnostic formatting
  onboard.ts        Onboard tool for guided setup
  constants.ts      Shared constants (timeouts, env key mappings)
dist/
  mcp-sandboxed-git-gh-cli   Compiled standalone binary
```

## License

MIT
