export const SCOPES = ["project", "user"] as const;
export type Scope = (typeof SCOPES)[number];

export const GH_METHODS = ["user", "token", "config-dir"] as const;
export type GhMethod = (typeof GH_METHODS)[number];

export const AGENT_FILES = ["claude", "agents", "both", "skip"] as const;
export type AgentFile = (typeof AGENT_FILES)[number];

export const GH_ENV_KEYS: Record<GhMethod, string> = {
  user: "MCP_GH_USER",
  token: "GH_TOKEN",
  "config-dir": "GH_CONFIG_DIR",
};

export const DEFAULT_TIMEOUT_MS = 60_000;
export const PROBE_TIMEOUT_MS = 5_000;
