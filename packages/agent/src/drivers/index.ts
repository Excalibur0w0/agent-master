import type { AgentKind } from "../registry.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { opencode } from "./opencode.ts";
import type { Driver } from "./types.ts";

export const DRIVERS: Record<AgentKind, Driver> = { claude, codex, opencode };

export { AmError, poll, sleep } from "./types.ts";
export type { Driver, LaunchPlan, StatusView } from "./types.ts";
