import "server-only";
import { generateText, stepCountIs, streamText, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import { AIDisabledError, getModel, type AiConfig, type ModelTier } from "./client";

/**
 * Agentic, multi-step tool-using turn. Ported from beaconhs's
 * packages/ai/src/agent.ts: the caller passes a permission-bound ToolSet plus
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
  const result = await generateText({
    model,
    system: args.system,
    prompt: args.prompt,
    tools: args.tools,
    stopWhen: stepCountIs(Math.max(4, args.maxSteps ?? DEFAULT_MAX_STEPS)),
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

  const result = streamText({
    model,
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    // CRITICAL: the SDK default is stepCountIs(1) — without raising it the model
    // calls a single tool and stops before ever using the result. THIS is the
    // line that makes the loop genuinely agentic.
    stopWhen: stepCountIs(Math.max(2, args.maxSteps ?? DEFAULT_MAX_STEPS)),
    temperature: args.temperature ?? 0.3,
    abortSignal: args.abortSignal,
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: false,
    onError: (err) => {
      // Never leak provider/internal error text — it may carry keys/base URLs.
      console.warn("[assistant/agent] stream error", err);
      return "The assistant hit an error completing that step. Please try again.";
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
}
