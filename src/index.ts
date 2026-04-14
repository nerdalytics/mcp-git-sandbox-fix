import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { basename } from "node:path";
import { z } from "zod";
import { execCommand, setPolicy } from "./executor.js";
import { textResult } from "./format.js";
import { runAllProbes } from "./probe.js";
import { registerDoctorTool } from "./doctor.js";
import { registerOnboardTool } from "./onboard.js";
import { parseArgs } from "./config.js";
import type { ServerConfig } from "./config.js";
import { PROBE_TIMEOUT_MS } from "./constants.js";
import { DEFAULT_POLICY, loadPolicy, allowedSubcommands } from "./policy.js";
import type { SecurityPolicy } from "./policy.js";
import { sanitizeArgs } from "./sanitizer.js";

const server = new McpServer({
	name: "mcp-sandboxed-git-gh-cli",
	version: "0.1.0",
});

function validateArgs(
	tool: "git" | "gh",
	args: string[],
	policy: SecurityPolicy,
) {
	const result = sanitizeArgs(tool, args, policy);
	if (!result.ok) {
		return textResult(result.reason, true);
	}
	return null;
}

function execResult(
	tool: string,
	result: { stdout: string; stderr: string; exitCode: number },
) {
	if (result.exitCode !== 0) {
		return textResult(
			`${tool} exited with code ${result.exitCode}\n\nstderr:\n${result.stderr}\n\nstdout:\n${result.stdout}`,
			true,
		);
	}
	// Flag stderr-only output as an error — security warnings from git/gh
	// (MITM, TLS, redirect) should not be silently presented as success.
	if (!result.stdout && result.stderr) {
		return textResult(result.stderr, true);
	}
	return textResult(result.stdout || "(no output)");
}

const sharedToolFields = {
	cwd: z
		.string()
		.optional()
		.describe("Working directory (defaults to server cwd)"),
	stdin: z.string().optional().describe("Text piped to stdin"),
	timeout_ms: z
		.number()
		.optional()
		.describe("Timeout in ms (default 60000)"),
};

async function runTool(
	tool: "git" | "gh",
	args: string[],
	opts: { cwd?: string; stdin?: string; timeout_ms?: number },
	config: ServerConfig,
	policy: SecurityPolicy,
) {
	const denied = validateArgs(tool, args, policy);
	if (denied) return denied;

	const effectiveCwd = opts.cwd || config.cwd || undefined;
	const effectiveTimeout =
		(opts.timeout_ms != null && opts.timeout_ms > 0)
			? opts.timeout_ms
			: (tool === "git" ? config.gitTimeout : config.ghTimeout)
			?? undefined;

	const result = await execCommand(tool, {
		args,
		cwd: effectiveCwd,
		stdin: opts.stdin,
		timeout_ms: effectiveTimeout,
	});

	return { result, effectiveCwd };
}

async function main() {
	const config = parseArgs(process.argv);

	// Load security policy: custom file merged over defaults, or defaults alone
	const policy: SecurityPolicy = config.policyPath
		? loadPolicy(config.policyPath)
		: DEFAULT_POLICY;

	// Push policy into the executor so every execCommand call enforces it
	setPolicy(policy);

	// --gh-user arg acts as a fallback for MCP_GH_USER env.
	// Args take precedence only when the env var is not set,
	// so env-based config (the existing pattern) still wins.
	if (config.ghUser && !process.env.MCP_GH_USER) {
		if (/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(config.ghUser)) {
			process.env.MCP_GH_USER = config.ghUser;
		} else {
			console.error(
				`WARNING: --gh-user value contains invalid characters, ignoring`,
			);
		}
	}

	// Disable terminal prompts in child processes — prevents git/gh
	// from hanging when they try to prompt for credentials interactively.
	process.env.GIT_TERMINAL_PROMPT = "0";
	process.env.GH_PROMPT_DISABLED = "1";
	process.env.BROWSER = "";

	const probes = await runAllProbes();

	// Set resolved GH_TOKEN explicitly (previously mutated inside resolveGhAuth)
	if (probes.ghAuth.resolvedToken) {
		process.env.GH_TOKEN = probes.ghAuth.resolvedToken;
	}

	server.registerTool(
		"git",
		{
			description:
				"Run a git command outside the sandbox. Supports SSH signing, " +
				"full TLS, and stdin for commit messages (use with -F - flag). " +
				"The first element of args must be an allowed git subcommand. " +
				"Some subcommands have restricted flags per the active security policy.",
			inputSchema: {
				args: z
					.array(z.string())
					.min(1)
					.describe('Git arguments, e.g. ["commit", "-S", "-F", "-"]'),
				...sharedToolFields,
				stdin: z
					.string()
					.optional()
					.describe("Text piped to stdin, useful with git commit -F -"),
			},
		},
		async ({ args, cwd, stdin, timeout_ms }) => {
			const subcommand = args[0];
			const ran = await runTool("git", args, { cwd, stdin, timeout_ms }, config, policy);
			if ("content" in ran) return ran; // denied

			const { result, effectiveCwd } = ran;

			if (result.exitCode !== 0) {
				return execResult("git", result);
			}

			const isCommit = subcommand === "commit";
			const explicitSign = args.some(
				(a) => a === "-S" || a.startsWith("-S") || a === "--gpg-sign" || a.startsWith("--gpg-sign="),
			);
			let signingExpected = false;

			if (isCommit) {
				const gpgsignCheck = await execCommand("git", {
					args: ["config", "commit.gpgsign"],
					cwd: effectiveCwd,
					timeout_ms: PROBE_TIMEOUT_MS,
				});
				signingExpected =
					explicitSign ||
					(gpgsignCheck.exitCode === 0 &&
						gpgsignCheck.stdout.trim() === "true");
			}

			if (isCommit && signingExpected) {
				// Capture the actual commit hash to avoid TOCTOU race
				const hashResult = await execCommand("git", {
					args: ["rev-parse", "HEAD"],
					cwd: effectiveCwd,
					timeout_ms: PROBE_TIMEOUT_MS,
				});
				const commitHash = hashResult.stdout.trim();

				const rawCheck = await execCommand("git", {
					args: ["show", "-s", "--format=raw", commitHash],
					cwd: effectiveCwd,
					timeout_ms: PROBE_TIMEOUT_MS,
				});

				// Check for gpgsig only in the header section (before the
				// first blank line that separates headers from the message body).
				// This prevents false positives from commit messages containing "gpgsig ".
				const headerSection = rawCheck.stdout.split("\n\n")[0] || "";
				const hasSignature = headerSection.split("\n").some(
					(line) => line.startsWith("gpgsig "),
				);

				if (!hasSignature) {
					const signingKey = await execCommand("git", {
						args: ["config", "user.signingkey"],
						cwd: effectiveCwd,
						timeout_ms: PROBE_TIMEOUT_MS,
					});
					const keyPath =
						signingKey.exitCode === 0 ? signingKey.stdout.trim() : null;

					return textResult(
						`WARNING: Commit was created but is NOT signed.\n` +
							`Signing was expected (${explicitSign ? "-S flag" : "commit.gpgsign=true"}) ` +
							`but git produced an unsigned commit.\n` +
							`user.signingkey: ${keyPath ? basename(keyPath) : "(not set in this repo)"}` +
							`\nSSH_AUTH_SOCK: ${process.env.SSH_AUTH_SOCK ? "(set)" : "(not set)"}` +
							`\n\ngit output:\n${result.stdout || "(no output)"}`,
						true,
					);
				}
			}

			return execResult("git", result);
		},
	);

	const ghConfigured =
		!!probes.env.mcpGhUser || probes.env.ghToken || !!probes.env.ghConfigDir;

	const ghRegistered = probes.gh.found && ghConfigured;

	if (ghRegistered) {
		server.registerTool(
			"gh",
			{
				description:
					"Run a GitHub CLI (gh) command outside the sandbox, bypassing " +
					"TLS/Go binary sandbox issues. The first element of args must " +
					"be an allowed gh subcommand. " +
					"Some subcommands have restricted actions per the active security policy.",
				inputSchema: {
					args: z
						.array(z.string())
						.min(1)
						.describe('gh arguments, e.g. ["pr", "list", "--limit", "10"]'),
					...sharedToolFields,
				},
			},
			async ({ args, cwd, stdin, timeout_ms }) => {
				const ran = await runTool("gh", args, { cwd, stdin, timeout_ms }, config, policy);
				if ("content" in ran) return ran; // denied
				return execResult("gh", ran.result);
			},
		);
	}

	registerDoctorTool(server, probes, ghRegistered, config);

	const binaryPath = process.execPath;
	registerOnboardTool(server, binaryPath, probes, config);

	const transport = new StdioServerTransport();
	await server.connect(transport);

	const tools = ["git"];
	if (ghRegistered) tools.push("gh");
	tools.push("doctor", "onboard");
	console.error(
		`mcp-sandboxed-git-gh-cli running on stdio \u2014 tools: ${tools.join(", ")}`,
	);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
