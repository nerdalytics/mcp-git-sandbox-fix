// Legacy exports — derived from DEFAULT_POLICY for backward compatibility
// with existing tests. New code should use policy.ts directly.

import { DEFAULT_POLICY, allowedSubcommands } from "./policy.js";

export const GIT_ALLOWED_SUBCOMMANDS = allowedSubcommands(DEFAULT_POLICY.git);
export const GH_ALLOWED_SUBCOMMANDS = allowedSubcommands(DEFAULT_POLICY.gh);
