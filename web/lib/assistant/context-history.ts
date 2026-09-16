/**
 * Turn history budget: long conversations must not resend every past tool
 * result on every step. Assistant turns older than the last
 * KEEP_FULL_ASSISTANT_TURNS keep their prose but have their tool-call parts
 * replaced by one compact summary line each (tool name + key figures), so a
 * turn resends recent evidence in full and older evidence as pointers.
 *
 * Pure (no server imports) so the budget is unit-testable with the plain
 * Node runner. Operates on an in-memory copy of the persisted parts — the
 * stored transcript always keeps the full parts for UI re-render.
 */

export type HistoryPart = { type: string; [key: string]: unknown };
export type HistoryMessage = { role: string; parts: HistoryPart[] };

/** Assistant turns newer than this keep full tool parts in the model window. */
export const KEEP_FULL_ASSISTANT_TURNS = 2;
/** Marks a replacement part as a compaction product, never model prose. */
export const HISTORY_SUMMARY_PREFIX = "[earlier in this conversation: ";
/** Hard cap on one tool summary line. */
export const HISTORY_SUMMARY_CHARS = 240;

/** Same bytes/4 estimator as the tool-budget test so numbers compare. */
export function estimateHistoryTokens(value: unknown): number {
  const serialized = JSON.stringify(value) ?? "";
  return Math.round(Buffer.byteLength(serialized, "utf8") / 4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortScalar(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 80) return null;
    return trimmed;
  }
  return null;
}

const FIGURE_KEY = /^(total|sum|balance|count|returned|matched|openBalance|amount|net|rows)/i;
const ROW_LIST_KEY = /^(items|projects|rows|lines|entries|accounts)$/;

/** One compact line for a tool result: key figures + row counts, never rows. */
export function summarizeToolOutputForHistory(output: unknown): string {
  const wrapper = isRecord(output) ? output : null;
  if (wrapper && wrapper.ok === false) {
    const error = typeof wrapper.error === "string" ? wrapper.error : "unknown error";
    return `error: ${error}`.slice(0, HISTORY_SUMMARY_CHARS);
  }
  const data = wrapper && isRecord(wrapper.data) ? wrapper.data : isRecord(output) ? output : null;
  if (!data) return typeof output === "string" ? output.slice(0, HISTORY_SUMMARY_CHARS) : "no result";
  const figures: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!FIGURE_KEY.test(key)) continue;
    const scalar = shortScalar(value);
    if (scalar !== null) figures.push(`${key}: ${scalar}`);
  }
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && ROW_LIST_KEY.test(key)) {
      figures.push(`${value.length} row${value.length === 1 ? "" : "s"}`);
    }
  }
  if (typeof data.truncated === "boolean" && data.truncated) figures.push("truncated page");
  const note = typeof data.note === "undefined" && wrapper && typeof wrapper.note === "string"
    ? wrapper.note
    : null;
  if (note) figures.push(`note: ${note.slice(0, 80)}`);
  const line = figures.length ? figures.join("; ") : "ok";
  return line.length > HISTORY_SUMMARY_CHARS ? `${line.slice(0, HISTORY_SUMMARY_CHARS - 1)}…` : line;
}

function toolNameOf(part: HistoryPart): string {
  if (typeof part.toolName === "string" && part.toolName) return part.toolName;
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return part.type;
}

function toolOutputOf(part: HistoryPart): unknown {
  if ("output" in part) return part.output;
  if (typeof part.errorText === "string" && part.errorText) {
    return { ok: false as const, error: part.errorText };
  }
  return null;
}

function isToolPart(part: HistoryPart): boolean {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

/**
 * Compact one assistant turn: prose stays, every tool part becomes one
 * `• name: figures` line inside a single marked text part.
 */
export function compactAssistantTurn(parts: HistoryPart[]): HistoryPart[] {
  const summaries: string[] = [];
  const kept: HistoryPart[] = [];
  for (const part of parts) {
    if (isToolPart(part)) {
      summaries.push(`• ${toolNameOf(part)}: ${summarizeToolOutputForHistory(toolOutputOf(part))}`);
    } else if (part.type === "text") {
      kept.push(part);
    }
    // Reasoning/source/file parts are ephemeral step artefacts — they cost
    // context on every future turn and add nothing once the turn is over.
  }
  if (summaries.length === 0) return parts;
  return [...kept, { type: "text", text: `${HISTORY_SUMMARY_PREFIX}${summaries.join("; ")}]` }];
}

/**
 * Tool names the conversation already called, oldest first, deduped. Feeds
 * the b01 pre-router so a follow-up keeps the modules it already used (and
 * the adaptive step budget sees the turn's true shape).
 */
export function collectPriorToolNames(messages: HistoryMessage[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isToolPart(part)) continue;
      const name = toolNameOf(part);
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * Apply the history budget to a model-window message list. Returns a new
 * list; the input (the persisted transcript) is never mutated.
 */
export function applyHistoryBudget(
  messages: HistoryMessage[],
  keepFullAssistantTurns: number = KEEP_FULL_ASSISTANT_TURNS,
): HistoryMessage[] {
  const assistantIndexes = messages
    .map((message, index) => (message.role === "assistant" ? index : -1))
    .filter((index) => index >= 0);
  const fullFrom = assistantIndexes.length <= keepFullAssistantTurns
    ? -1
    : assistantIndexes[assistantIndexes.length - keepFullAssistantTurns]!;
  return messages.map((message, index) => {
    if (message.role !== "assistant" || index >= fullFrom) return message;
    return { ...message, parts: compactAssistantTurn(message.parts) };
  });
}
