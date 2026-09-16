/**
 * Adaptive step budget: the agentic loop's hard step cap follows the turn's
 * shape instead of a flat 12. Simple questions get 6 steps, general analysis
 * 12, close work and forensics 16. The shape comes from b01's pre-router
 * (imported, never forked): its module set already encodes what the turn is
 * about, including the modules of tools the conversation already used (so a
 * "tell me more" follow-up keeps its budget).
 *
 * Pure (no server imports).
 */

import { preRouteModules } from "./tool-router";

/** Greetings, capabilities, single-lookup questions. */
export const STEP_BUDGET_SIMPLE = 6;
/** General multi-tool analysis. */
export const STEP_BUDGET_STANDARD = 12;
/** Close checklists and forensic investigations. */
export const STEP_BUDGET_DEEP = 16;

/** Modules whose turns always run deep. */
const DEEP_MODULES: ReadonlySet<string> = new Set(["close", "continuousClose", "advancedClose"]);

/**
 * Forensics subset of the analytics module (sentinel investigations,
 * round-dollar/weekend patterns). The pre-router files these under
 * analytics; only this narrow, vendor-neutral slice earns the deep budget —
 * plain dashboards stay standard.
 */
const FORENSICS_PATTERN = /\b(sentinel|forensic|fraud|suspicious|anomal|round-dollar|round dollar)\b/i;

/**
 * Resolve the turn's max agent steps from the user message plus the tools
 * the conversation already called. `resolveModule` maps a tool name to its
 * b01 module (the route builds it from the registry catalog).
 */
export function resolveStepBudget(
  message: string,
  priorToolNames: readonly string[] = [],
  resolveModule: (toolName: string) => string = () => "core",
): number {
  const modules = preRouteModules(message, priorToolNames, resolveModule);
  if (modules.some((module) => DEEP_MODULES.has(module))) return STEP_BUDGET_DEEP;
  if (modules.includes("analytics") && FORENSICS_PATTERN.test(message)) return STEP_BUDGET_DEEP;
  if (modules.length === 0) return STEP_BUDGET_SIMPLE;
  return STEP_BUDGET_STANDARD;
}
