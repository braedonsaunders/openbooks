import type { ToolSet } from "ai";

/**
 * Model-facing compaction for assistant tool results. A turn runs ~12 tool
 * steps against a fixed context budget, so every result is compacted BEFORE
 * it reaches the model: long strings are cut with a marker, long arrays are
 * capped with a `truncatedCount`, and nesting deeper than the limit is
 * replaced by a shape marker. The full result still flows to the client and
 * the persisted transcript (tool-output parts); only the model copy shrinks.
 * Wired via the AI SDK `toModelOutput` hook, which `convertToModelMessages`
 * and the tool loop both honour — so history and live steps stay bounded.
 */

export const MODEL_RESULT_STRING_CHARS = 2000;
export const MODEL_RESULT_ARRAY_ITEMS = 50;
export const MODEL_RESULT_MAX_DEPTH = 6;
/** Hard cap on tool round-trips per turn (see agent.ts DEFAULT_MAX_STEPS). */
export const MODEL_TURN_STEPS = 12;
/** Worst-case bytes one tool result may contribute to the model context. */
export const MODEL_RESULT_BYTES = 8_000;
/** Worst-case bytes a full 12-step turn may contribute (12 × per-result). */
export const MODEL_TURN_BYTES = MODEL_TURN_STEPS * MODEL_RESULT_BYTES;
/** Smallest useful page once the turn budget is nearly spent. */
const TURN_MIN_RESULT_BYTES = 1_024;

export function byteSize(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) return 0;
    return new TextEncoder().encode(serialized).length;
  } catch {
    return String(value).length;
  }
}

type CompactState = { truncated: boolean };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function compactString(value: string, maxChars: number, state: CompactState): string {
  if (value.length <= maxChars) return value;
  state.truncated = true;
  return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

function compactValue(
  value: unknown,
  depth: number,
  arrayCap: number,
  maxChars: number,
  state: CompactState,
): unknown {
  if (typeof value === "string") return compactString(value, maxChars, state);
  if (Array.isArray(value)) {
    if (depth >= MODEL_RESULT_MAX_DEPTH) {
      state.truncated = true;
      return `[array(${value.length}) — truncated for model context]`;
    }
    const items = value.map((item) => compactValue(item, depth + 1, arrayCap, maxChars, state));
    if (items.length <= arrayCap) return items;
    state.truncated = true;
    return { items: items.slice(0, arrayCap), truncatedCount: items.length - arrayCap };
  }
  if (isPlainObject(value)) {
    if (depth >= MODEL_RESULT_MAX_DEPTH) {
      state.truncated = true;
      return `[object(${Object.keys(value).length} keys) — truncated for model context]`;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = compactValue(entry, depth + 1, arrayCap, maxChars, state);
    }
    return out;
  }
  return value;
}

/** Compact one tool result so its serialized size fits `budget` bytes. Pure. */
export function compactToolResultForModel(value: unknown, budget: number = MODEL_RESULT_BYTES): unknown {
  const floor = Math.max(512, Math.min(budget, MODEL_RESULT_BYTES));
  let cap = MODEL_RESULT_ARRAY_ITEMS;
  const state: CompactState = { truncated: false };
  let compacted = compactValue(value, 0, cap, MODEL_RESULT_STRING_CHARS, state);
  while (byteSize(compacted) > floor && cap > 1) {
    cap = Math.max(1, Math.floor(cap / 2));
    const retry: CompactState = { truncated: true };
    compacted = compactValue(value, 0, cap, MODEL_RESULT_STRING_CHARS, retry);
    state.truncated = true;
  }
  if (byteSize(compacted) > floor) {
    state.truncated = true;
    const preview = JSON.stringify(compacted) ?? "";
    return {
      truncated: "result-exceeds-model-budget",
      byteSize: byteSize(value),
      preview: `${preview.slice(0, Math.max(0, floor - 200))}…[truncated]`,
    };
  }
  return compacted;
}

/**
 * Per-turn compactor: the first results get the full per-result budget and
 * later ones shrink as the turn budget runs down, so any number of steps
 * stays near MODEL_TURN_BYTES (bounded overshoot of one minimum page per
 * over-budget call). One instance per turn — `withModelCompaction` owns it.
 */
export function createTurnCompactor(
  turnBudget: number = MODEL_TURN_BYTES,
  perResultBudget: number = MODEL_RESULT_BYTES,
): (output: unknown) => unknown {
  let used = 0;
  return (output: unknown) => {
    const remaining = turnBudget - used;
    const allowance =
      remaining <= 0
        ? TURN_MIN_RESULT_BYTES
        : Math.min(perResultBudget, Math.max(TURN_MIN_RESULT_BYTES, remaining));
    const compacted = compactToolResultForModel(output, allowance);
    used += byteSize(compacted);
    return compacted;
  };
}

type ModelOutputArgs = { output: unknown };
type ModelOutput = { type: "json"; value: unknown };

function attachModelOutput<T extends object>(definition: T, compact: (output: unknown) => unknown): T {
  return {
    ...(definition as Record<string, unknown>),
    toModelOutput: ({ output }: ModelOutputArgs): ModelOutput => ({
      type: "json",
      value: compact(output),
    }),
  } as T;
}

const compactedSets = new WeakSet<object>();

/**
 * Add the model-facing compaction hook to every tool in the set, sharing one
 * turn compactor. Idempotent — safe to apply in both the route (for history
 * conversion) and the agent (for live steps).
 */
export function withModelCompaction(tools: ToolSet): ToolSet {
  if (compactedSets.has(tools)) return tools;
  const compact = createTurnCompactor();
  const wrapped = Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => [name, attachModelOutput(definition, compact)]),
  );
  const out = wrapped as ToolSet;
  compactedSets.add(out);
  return out;
}
