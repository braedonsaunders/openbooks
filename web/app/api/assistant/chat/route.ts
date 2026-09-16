import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { convertToModelMessages, generateText, type UIMessage } from "ai";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { can, guardPermission } from "../../../../lib/authz";
import { AIDisabledError, getModel } from "../../../../lib/assistant/client";
import { getOrgAiConfig } from "../../../../lib/assistant/ai-config";
import { NO_ANSWER_MESSAGE, runAgentTurn } from "../../../../lib/assistant/agent";
import { buildChatTurn } from "../../../../lib/assistant/registry";
import { priorToolNames } from "../../../../lib/assistant/tool-router";
import { ASSISTANT_TOOLS, buildToolRegistryAsync } from "../../../../lib/assistant/registry";
import { APPLICATION_TOOLS } from "../../../../lib/application/tool-catalog";
import { withModelCompaction } from "../../../../lib/assistant/result-compaction";
import { assistantSystemPrompt } from "../../../../lib/assistant/system-prompt";
import {
  applyHistoryBudget,
  collectPriorToolNames,
  type HistoryMessage,
  type HistoryPart,
} from "../../../../lib/assistant/context-history";
import {
  foldPartsIntoPins,
  hasAnaphor,
  renderPinsSection,
  type EntityPins,
} from "../../../../lib/assistant/context-pins";
import { resolveStepBudget } from "../../../../lib/assistant/context-steps";
import {
  buildSummaryPrompt,
  buildSummarySection,
  collectPinnedEntities,
  mergeResolvedEntities,
  parseSummaryModelOutput,
  shouldRefreshSummary,
} from "../../../../lib/assistant/context-summary";
import {
  countConversationAssistantTurns,
  readConversationSummary,
  writeConversationSummary,
} from "../../../../lib/assistant/conversation-memory";
import { moduleOfTool } from "../../../../lib/assistant/tool-router";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { orgFiscalContext } from "../../../../lib/fiscal";
import { resolvedFeatureState } from "../../../../lib/features";
import {
  appendMessage,
  createConversation,
  ownsConversation,
  recentMessages,
} from "../../../../lib/ai-conversations";

/**
 * The agentic turn endpoint.
 * Streams a multi-step tool-using assistant turn over the UI-message protocol
 * (decoded client-side by readUIMessageStream) and persists the assembled
 * transcript into ai_messages on finish.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Agent turns run a multi-step tool loop — far longer than a single completion.
export const maxDuration = 300;

const SCOPE = "assistant";
const MAX_PROMPT_CHARS = 32_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TURN_FAILURE_MESSAGE = "The assistant could not complete this response. Please try again.";

function conversationResponse(
  body: BodyInit | null,
  status: number,
  conversationId: string | null,
): Response {
  const headers = new Headers();
  if (conversationId) headers.set("x-conversation-id", conversationId);
  return new Response(body, { status, headers });
}

export async function POST(req: Request): Promise<Response> {
  const gate = await guardPermission("assistant.use");
  if (gate instanceof NextResponse) return gate;
  const authz = gate;

  let body: unknown;
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = parsedBody.data;
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new Response("Bad request", { status: 400 });
  }
  const input = body as { conversationId?: unknown; prompt?: unknown };
  if (
    input.conversationId !== undefined &&
    input.conversationId !== null &&
    typeof input.conversationId !== "string"
  ) {
    return new Response("Bad request", { status: 400 });
  }
  if (typeof input.prompt !== "string") return new Response("Invalid prompt", { status: 400 });
  if (input.prompt.length > MAX_PROMPT_CHARS) {
    return new Response("Prompt too large", { status: 413 });
  }
  const prompt = input.prompt.trim();
  if (!prompt) return new Response("Empty prompt", { status: 400 });

  // Resolve / create the conversation. Only the OWNER may send a turn.
  let conversationId = (input.conversationId as string | undefined) ?? null;
  if (conversationId) {
    if (!UUID_RE.test(conversationId)) return new Response("Bad request", { status: 400 });
    if (!(await ownsConversation(authz, conversationId, SCOPE))) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  // Resolve provider/model readiness before creating a thread. A disabled or
  // incomplete configuration must not leave an unreachable user-only chat.
  const aiConfig = await getOrgAiConfig(authz.user.orgId);
  if (!getModel(aiConfig, "smart")) {
    return conversationResponse("AI is not configured.", 503, conversationId);
  }

  const org = (await db.execute<{ base_currency: string }>(
    sql`select base_currency from orgs where id = ${authz.user.orgId}`,
  ));

  const today = await businessToday(authz.user.orgId);
  const features = await resolvedFeatureState(authz.user.orgId);
  const system = assistantSystemPrompt({
    orgName: aiConfig?.org?.name ?? null,
    baseCurrency: org.rows[0]?.base_currency ?? null,
    userName: authz.user.name,
    today,
    fiscal: await orgFiscalContext(today, authz.user.orgId),
    canWrite: can(authz, "assistant.write"),
    features,
  });
  // Model-facing tool outputs are compacted (history conversion and live
  // steps); the streamed and persisted parts keep the full results.
  const tools = withModelCompaction(await buildToolRegistryAsync(authz, features));
  // Static catalog snapshot for the pure b01 module router (payload routing
  // only — gates stay in the registry above).
  const moduleByTool = new Map<string, string>([
    ...ASSISTANT_TOOLS.map((t) => [t.name, moduleOfTool(t.name, t.feature)] as const),
    ...APPLICATION_TOOLS.map((t) => [t.name, moduleOfTool(t.name, t.featureKey)] as const),
  ]);
  const resolveModule = (toolName: string): string => moduleByTool.get(toolName) ?? "core";

  if (!conversationId) {
    conversationId = await createConversation(authz, SCOPE, prompt.slice(0, 60));
  }
  // Rolling memory is per-conversation and owner-scoped; a fresh thread
  // simply has none yet.
  const storedSummary = await readConversationSummary(authz, conversationId);
  let userPersisted = false;
  try {
    // Persist first so a dropped connection cannot lose a turn that actually started.
    await appendMessage(authz, { conversationId, role: "user", content: prompt });
    userPersisted = true;

    // Fetch exactly the recent model window; never materialize the full transcript.
    const history = await recentMessages(authz, conversationId);
    const uiMessages = history.map((message) => ({
      role: message.role,
      parts:
        message.data &&
        Array.isArray((message.data as { parts?: unknown }).parts) &&
        (message.data as { parts: unknown[] }).parts.length > 0
          ? ((message.data as { parts: unknown }).parts as UIMessage["parts"])
          : ([{ type: "text", text: message.content }] as UIMessage["parts"]),
    }));
    // The persisted parts are plain JSON; view them through the history
    // helpers (single cast at the boundary — the SDK revalidates on send).
    const historyView = uiMessages as unknown as HistoryMessage[];

    // Entity pins fold over the FULL window (budgeting below only shrinks
    // the model copy); the step budget sees the prompt plus prior tools.
    let windowPins: EntityPins = {};
    for (const message of historyView) {
      windowPins = foldPartsIntoPins(windowPins, message.parts);
    }
    const priorToolNames = collectPriorToolNames(historyView);
    const maxSteps = resolveStepBudget(prompt, priorToolNames, resolveModule);

    const system = assistantSystemPrompt({
      orgName: aiConfig?.org?.name ?? null,
      baseCurrency: org.rows[0]?.base_currency ?? null,
      userName: authz.user.name,
      today,
      fiscal: await orgFiscalContext(today, authz.user.orgId),
      canWrite: can(authz, "assistant.write"),
      features,
      maxSteps,
      memorySections: [
        buildSummarySection(storedSummary),
        renderPinsSection(windowPins, hasAnaphor(prompt)),
      ],
    });

    // Older turns' tool parts ride as compact summaries; the UI keeps full parts.
    const budgeted = applyHistoryBudget(historyView);

    // Two-stage catalog: the full gated catalog stays registered (instant,
    // typed activation) while each step only SENDS core ∪ pre-routed ∪
    // activated tools. Model-facing outputs are compacted; the streamed and
    // persisted parts keep the full results.
    const turn = await buildChatTurn(authz, features, prompt, priorToolNames(uiMessages));
    const tools = withModelCompaction(turn.tools);

    let modelMessages;
    try {
      modelMessages = await convertToModelMessages(budgeted as unknown as UIMessage[], {
        tools,
        ignoreIncompleteToolCalls: true,
      });
    } catch {
      // Fall back to plain text if an older persisted tool part is no longer convertible.
      modelMessages = await convertToModelMessages(
        history.map((message) => ({
          role: message.role,
          parts: [{ type: "text", text: message.content }],
        })),
        { ignoreIncompleteToolCalls: true },
      );
    }

    const res = runAgentTurn(aiConfig, {
      messages: modelMessages,
      system,
      tools,
      activeTools: turn.activeTools,
      maxSteps,
      abortSignal: req.signal,
      onComplete: async ({ parts, aborted, finishReason, usage }) => {
        const text = parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n")
          .trim();
        const fallback = aborted
          ? "Response stopped."
          : finishReason === "error"
            ? TURN_FAILURE_MESSAGE
            : NO_ANSWER_MESSAGE;
        const content = text || fallback;
        const persistedParts = parts.length
          ? parts
          : content
            ? ([{ type: "text", text: content }] as UIMessage["parts"])
            : [];
        await appendMessage(authz, {
          conversationId: conversationId!,
          role: "assistant",
          content,
          data: {
            v: 1,
            kind: "agent-turn",
            status: aborted ? "stopped" : finishReason === "error" ? "failed" : "complete",
            finishReason,
            aborted,
            usage,
            parts: persistedParts,
          },
        });
        // Best-effort rolling summary: refresh every K turns, but never fail
        // a completed turn for memory.
        try {
          const turns = await countConversationAssistantTurns(authz, conversationId!);
          if (!shouldRefreshSummary(turns, storedSummary)) return;
          try {
            const model = getModel(aiConfig, "fast");
            if (!model) return;
            const transcript = [
              ...history.map((message) => `${message.role}: ${message.content}`),
              `user: ${prompt}`,
              `assistant: ${content}`,
            ]
              .join("\n")
              .slice(-12_000);
            const generated = await generateText({
              model,
              system: "You summarise accounting-assistant conversations for continuity.",
              prompt: buildSummaryPrompt(transcript, storedSummary),
              temperature: 0.2,
            });
            const parsed = parseSummaryModelOutput(generated.text);
            const turnPins = foldPartsIntoPins(
              windowPins,
              persistedParts as unknown as HistoryPart[],
            );
            await writeConversationSummary(authz, conversationId!, {
              text: parsed.text || content.slice(0, 1_000),
              entities: mergeResolvedEntities(storedSummary?.entities ?? [], [
                ...parsed.entities,
                ...collectPinnedEntities(turnPins),
              ]),
              turnsCovered: turns,
            });
          } catch (summaryError) {
            console.warn("[assistant/chat] summary refresh failed", summaryError);
          }
        } catch (countError) {
          console.warn("[assistant/chat] summary turn count failed", countError);
        }
      },
    });

    // Surface the (possibly new) conversation id to the client.
    const headers = new Headers(res.headers);
    headers.set("x-conversation-id", conversationId);
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    if (userPersisted) {
      try {
        await appendMessage(authz, {
          conversationId,
          role: "assistant",
          content: TURN_FAILURE_MESSAGE,
          data: {
            v: 1,
            kind: "agent-turn",
            status: "failed",
            finishReason: "error",
            aborted: false,
            parts: [{ type: "text", text: TURN_FAILURE_MESSAGE }],
          },
        });
      } catch (persistError) {
        console.error("[assistant/chat] failed to persist terminal error state", persistError);
      }
    }
    if (err instanceof AIDisabledError) {
      return conversationResponse("AI is not configured.", 503, conversationId);
    }
    console.error("[assistant/chat] failed", err);
    return conversationResponse("Assistant request failed.", 500, conversationId);
  }
}
