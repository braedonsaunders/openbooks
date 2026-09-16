import "server-only";
import { randomUUID } from "node:crypto";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { AIDisabledError, getModel, type AiConfig, type ModelTier } from "./client";

/**
 * Agentic, multi-step tool-using turn. The caller passes a permission-bound ToolSet plus
 * a system prompt; we run the Vercel AI SDK tool loop and stream the result to
 * the browser using the UI-message protocol — which `readUIMessageStream`
 * decodes on the client into the same `parts[]` shape we persist and
 * re-render on reload.
 */

export type AgentTurnResult = {
  /** Assembled assistant message parts (text + tool-use cards), in order. */
  parts: UIMessage["parts"];
  aborted: boolean;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
};

export type RunAgentTurnArgs = {
  /** Prior transcript as model messages (build with convertToModelMessages). */
  messages: ModelMessage[];
  system: string;
  /** Permission-bound tools; the model only ever sees what the caller includes. */
  tools: ToolSet;
  tier?: ModelTier;
  /** Hard cap on agent steps (tool round-trips). Default 12; floored at 2. */
  maxSteps?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  /** Settled-turn hook (fires on success AND on abort) with the assembled parts. */
  onComplete?: (result: AgentTurnResult) => void | Promise<void>;
};

const DEFAULT_MAX_STEPS = 12;

/** Shown (and persisted) when a turn ends without the model writing any prose —
 *  e.g. the provider cut the response or the loop ended on a tool call. */
export const NO_ANSWER_MESSAGE =
  "I gathered data but ran out of room before writing an answer. Ask again with a narrower question, or tell me which part to focus on.";

/**
 * On the final permitted step the model must ANSWER, not call another tool:
 * otherwise a turn that spends its whole budget on lookups ends with tool
 * results and no prose (the user sees a dead turn). `stepNumber` is 0-based.
 */
function finalStepMustAnswer(maxSteps: number) {
  return ({ stepNumber }: { stepNumber: number }) =>
    stepNumber >= maxSteps - 1 ? { toolChoice: "none" as const } : undefined;
}

export type BackgroundAgentResult = {
  text: string;
  finishReason: string;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number };
};

/**
 * Non-streaming form of the same tool loop for scheduled agents. It receives
 * the identical permission-bound ToolSet as chat and is still capped by a
 * hard step limit. Background agents are only given read tools.
 */
export async function runBackgroundAgent(
  config: AiConfig | null | undefined,
  args: {
    prompt: string;
    system: string;
    tools: ToolSet;
    tier?: ModelTier;
    maxSteps?: number;
    temperature?: number;
    abortSignal?: AbortSignal;
  },
): Promise<BackgroundAgentResult> {
  const model = getModel(config, args.tier ?? "smart");
  if (!model) throw new AIDisabledError();
  const maxSteps = Math.max(4, args.maxSteps ?? DEFAULT_MAX_STEPS);
  const result = await generateText({
    model,
    system: args.system,
    prompt: args.prompt,
    tools: args.tools,
    stopWhen: stepCountIs(maxSteps),
    prepareStep: finalStepMustAnswer(maxSteps),
    temperature: args.temperature ?? 0.2,
    abortSignal: args.abortSignal,
  });
  return {
    text: result.text,
    finishReason: result.finishReason,
    toolCalls: result.steps.reduce((count, step) => count + step.toolCalls.length, 0),
    usage: {
      inputTokens: result.totalUsage.inputTokens ?? 0,
      outputTokens: result.totalUsage.outputTokens ?? 0,
    },
  };
}

/**
 * Run one agentic turn and return a streaming Response (UI-message SSE protocol).
 * Throws AIDisabledError when the org has no model configured.
 */
export function runAgentTurn(config: AiConfig | null | undefined, args: RunAgentTurnArgs): Response {
  const model = getModel(config, args.tier ?? "smart");
  if (!model) throw new AIDisabledError();
  const maxSteps = Math.max(2, args.maxSteps ?? DEFAULT_MAX_STEPS);

  const result = streamText({
    model,
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    // CRITICAL: the SDK default is stepCountIs(1) — without raising it the model
    // calls a single tool and stops before ever using the result. THIS is the
    // line that makes the loop genuinely agentic.
    stopWhen: stepCountIs(maxSteps),
    prepareStep: finalStepMustAnswer(maxSteps),
    temperature: args.temperature ?? 0.3,
    abortSignal: args.abortSignal,
  });

  const onError = (err: unknown) => {
    // Never leak provider/internal error text — it may carry keys/base URLs.
    console.warn("[assistant/agent] stream error", err);
    return "The assistant hit an error completing that step. Please try again.";
  };

  const stream = createUIMessageStream({
    onError,
    execute: async ({ writer }) => {
      // Pump the model stream through so we can see whether any prose was
      // produced. A turn that ends on tool output alone (provider cut-off,
      // finishReason "other"/"length") gets a visible fallback text part
      // BEFORE the finish chunk, so the client and the persisted transcript
      // both carry an answer instead of a blank bubble.
      const reader = result.toUIMessageStream({ sendReasoning: false, onError }).getReader();
      let sawText = false;
      let sawError = false;
      let finish: UIMessageChunk | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value.type === "text-delta" && value.delta) sawText = true;
        else if (value.type === "error") sawError = true;
        if (value.type === "finish") {
          finish = value;
          continue;
        }
        writer.write(value);
      }
      if (!sawText && !sawError && !args.abortSignal?.aborted) {
        const id = `fallback-${randomUUID()}`;
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: NO_ANSWER_MESSAGE });
        writer.write({ type: "text-end", id });
      }
      if (finish) writer.write(finish);
    },
    onFinish: async ({ responseMessage, isAborted, finishReason }) => {
      if (!args.onComplete) return;
      let usage = { inputTokens: 0, outputTokens: 0 };
      try {
        const u = await result.totalUsage;
        usage = { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 };
      } catch {
        // best-effort token accounting
      }
      await args.onComplete({
        parts: responseMessage.parts,
        aborted: isAborted,
        finishReason: finishReason ?? (isAborted ? "abort" : "stop"),
        usage,
      });
    },
  });

  return createUIMessageStreamResponse({ stream });
}
