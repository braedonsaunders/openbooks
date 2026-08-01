import { NextResponse } from "next/server";
import { convertToModelMessages, type UIMessage } from "ai";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { can, guardPermission } from "../../../../lib/authz";
import { AIDisabledError, getModel } from "../../../../lib/assistant/client";
import { getOrgAiConfig } from "../../../../lib/assistant/ai-config";
import { runAgentTurn } from "../../../../lib/assistant/agent";
import { buildToolRegistry } from "../../../../lib/assistant/registry";
import { assistantSystemPrompt } from "../../../../lib/assistant/system-prompt";
import {
  appendMessage,
  createConversation,
  ownsConversation,
  recentMessages,
} from "../../../../lib/ai-conversations";

/**
 * The agentic turn endpoint, ported from beaconhs's assistant/chat/route.ts.
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
    body = await req.json();
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

  const org = (await db.execute(
    sql`select base_currency from orgs where id = ${authz.user.orgId}`,
  )) as unknown as { rows: { base_currency: string }[] };

  const tools = buildToolRegistry(authz);
  const system = assistantSystemPrompt({
    orgName: aiConfig?.org?.name ?? null,
    baseCurrency: org.rows[0]?.base_currency ?? null,
    userName: authz.user.name,
    today: new Date().toISOString().slice(0, 10),
    canWrite: can(authz, "assistant.write"),
  });

  if (!conversationId) {
    conversationId = await createConversation(authz, SCOPE, prompt.slice(0, 60));
  }
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

    let modelMessages;
    try {
      modelMessages = await convertToModelMessages(uiMessages, {
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
            : "";
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
