import "server-only";
import { sql } from "drizzle-orm";
import { generateText, type LanguageModel } from "ai";
import { db } from "@openbooks/engine/src/db.ts";
import type { Authz } from "../authz";
import { countConversationAssistantTurns, isMissingMetadataColumn } from "./conversation-memory";

/**
 * Auto titles for assistant threads: the 60-char prompt slice stored at
 * creation is a placeholder, not a title. After the FIRST assistant turn of a
 * conversation completes, the chat route generates a short title with the
 * org's configured fast model and persists it; the client's end-of-turn
 * refresh then shows it. A title the user renamed is never overwritten — the
 * source rides `ai_conversations.metadata -> 'title'`, tolerated as missing
 * on older tenants exactly like conversation memory (no migration here).
 */

/** A title is at most this many words (shard contract). */
export const TITLE_MAX_WORDS = 6;
/** Hard timeout for the title call — a title must never stall a completed turn. */
export const TITLE_TIMEOUT_MS = 10_000;
/** Bounded output: six words need only a few dozen tokens. */
const TITLE_MAX_OUTPUT_TOKENS = 32;
/** Mirrors AI_CONVERSATION_TITLE_MAX_CHARS (owned by ai-conversations.ts). */
const TITLE_MAX_CHARS = 120;

/** Where the current title came from: generated, or chosen by the user. */
export type TitleSource = "auto" | "user";

export type TitleState = { title: string; source: TitleSource | null };

/**
 * Strip model chatter down to at most six plain words. Null when nothing
 * usable remains — the caller keeps the placeholder.
 */
export function cleanGeneratedTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const firstLine = (raw.split(/\r?\n/, 1)[0] ?? "").trim();
  const dequoted = firstLine
    .replace(/^["'«»“”‘’\s]+|["'«»“”‘’.!?;:\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!dequoted) return null;
  const words = dequoted.split(" ").filter(Boolean).slice(0, TITLE_MAX_WORDS);
  if (words.length === 0) return null;
  const joined = words.join(" ");
  if (joined.length <= TITLE_MAX_CHARS) return joined;
  // Pathological long words: cut at a word boundary, or reject a single
  // giant token rather than persisting a fragment.
  const cut = joined.slice(0, TITLE_MAX_CHARS);
  const boundary = cut.lastIndexOf(" ");
  return boundary > 0 ? cut.slice(0, boundary) : null;
}

/**
 * Whether an auto title may be attempted. A user rename always wins, and only
 * the first completed assistant turn renames — later turns leave the title
 * (generated or placeholder) alone.
 */
export function shouldAttemptAutoTitle(
  state: TitleState | null,
  assistantTurns: number,
): boolean {
  if (!state) return false;
  if (state.source === "user") return false;
  return assistantTurns === 1;
}

/** Owner-only title + source read; null when the conversation is not owned. */
export async function readTitleState(
  authz: Authz,
  conversationId: string,
): Promise<TitleState | null> {
  let r: { rows: { title: string; source: string | null }[] };
  try {
    r = await db.execute<{ title: string; source: string | null }>(sql`
      select c.title, c.metadata -> 'title' ->> 'source' as source
        from ai_conversations c
       where c.id = ${conversationId}
         and c.org_id = ${authz.user.orgId} and c.user_id = ${authz.user.id}
    `);
  } catch (error) {
    if (!isMissingMetadataColumn(error)) throw error;
    const fallback = await db.execute<{ title: string }>(sql`
      select c.title
        from ai_conversations c
       where c.id = ${conversationId}
         and c.org_id = ${authz.user.orgId} and c.user_id = ${authz.user.id}
    `);
    if (fallback.rows.length === 0) return null;
    return { title: fallback.rows[0]!.title, source: null };
  }
  if (r.rows.length === 0) return null;
  const source = r.rows[0]!.source;
  return {
    title: r.rows[0]!.title,
    source: source === "user" || source === "auto" ? source : null,
  };
}

/**
 * Owner-only persist of a generated title (records the `auto` source).
 * Returns false when the conversation is not owned. Never throws for a
 * missing metadata column — the title itself is always stored.
 */
export async function writeAutoTitle(
  authz: Authz,
  conversationId: string,
  title: string,
): Promise<boolean> {
  const clean = title.trim().slice(0, TITLE_MAX_CHARS);
  if (!clean) return false;
  const payload = JSON.stringify({ source: "auto", updatedAt: new Date().toISOString() });
  try {
    const r = await db.execute(sql`
      update ai_conversations
         set title = ${clean}, updated_by = ${authz.user.id},
             metadata = coalesce(metadata, '{}'::jsonb)
                      || jsonb_build_object('title', ${payload}::jsonb)
       where id = ${conversationId}
         and org_id = ${authz.user.orgId} and user_id = ${authz.user.id}
      returning id
    `);
    return r.rows.length > 0;
  } catch (error) {
    if (!isMissingMetadataColumn(error)) throw error;
    const r = await db.execute(sql`
      update ai_conversations
         set title = ${clean}, updated_by = ${authz.user.id}
       where id = ${conversationId}
         and org_id = ${authz.user.orgId} and user_id = ${authz.user.id}
      returning id
    `);
    return r.rows.length > 0;
  }
}

/**
 * Record a user rename so later turns never overwrite it. Best-effort and
 * never throwing — a rename must not fail for title memory.
 */
export async function markTitleRenamed(authz: Authz, conversationId: string): Promise<void> {
  const payload = JSON.stringify({ source: "user", updatedAt: new Date().toISOString() });
  try {
    await db.execute(sql`
      update ai_conversations
         set metadata = coalesce(metadata, '{}'::jsonb)
                      || jsonb_build_object('title', ${payload}::jsonb)
       where id = ${conversationId}
         and org_id = ${authz.user.orgId} and user_id = ${authz.user.id}
    `);
  } catch (error) {
    if (!isMissingMetadataColumn(error)) {
      console.warn("[assistant/title] failed to record user rename", error);
    }
  }
}

/** Seams for the post-close scheduler's unit test (production defaults hit the DB/model). */
export type AutoTitleDeps = {
  countTurns?: (authz: Authz, conversationId: string) => Promise<number>;
  readState?: (authz: Authz, conversationId: string) => Promise<TitleState | null>;
  generate?: typeof generateText;
  write?: (authz: Authz, conversationId: string, title: string) => Promise<boolean>;
};

/**
 * Fire-and-forget auto title for AFTER the stream closes. Returns
 * immediately — the SSE stream (and the composer's locked state) never waits
 * for the title round-trip, which carries its own bounded tokens and hard
 * timeout inside. All failures resolve to keeping the placeholder; a user
 * rename still wins via shouldAttemptAutoTitle. Never throws.
 */
export function scheduleAutoTitle(args: {
  authz: Authz;
  conversationId: string;
  prompt: string;
  assistantContent: string;
  model: LanguageModel | null;
  deps?: AutoTitleDeps;
}): void {
  if (!args.model) return;
  const model = args.model;
  const deps = args.deps ?? {};
  void (async () => {
    try {
      const countTurns = deps.countTurns ?? countConversationAssistantTurns;
      const readState = deps.readState ?? readTitleState;
      const write = deps.write ?? writeAutoTitle;
      const turns = await countTurns(args.authz, args.conversationId);
      const state = await readState(args.authz, args.conversationId);
      if (!shouldAttemptAutoTitle(state, turns)) return;
      const title = await generateConversationTitle({
        model,
        prompt: args.prompt,
        assistantContent: args.assistantContent,
        generate: deps.generate,
      });
      if (title) await write(args.authz, args.conversationId, title);
    } catch {
      // best-effort — the placeholder stays
    }
  })();
}

/**
 * Generate a short title with the org's configured model. Bounded tokens plus
 * a hard timeout; ANY failure resolves null so the caller keeps the
 * placeholder. Vendor-neutral copy; no model names here.
 */
export async function generateConversationTitle(args: {
  model: LanguageModel;
  prompt: string;
  assistantContent: string;
  timeoutMs?: number;
  generate?: typeof generateText;
}): Promise<string | null> {
  const generate = args.generate ?? generateText;
  const timeoutMs = args.timeoutMs ?? TITLE_TIMEOUT_MS;
  const transcript = `user: ${args.prompt}\nassistant: ${args.assistantContent}`.slice(-2_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = generate({
      model: args.model,
      system:
        "You write short titles for accounting-assistant chat threads. " +
        "Reply with at most six words naming the topic — plain words only, " +
        "no quotation marks, no trailing period.",
      prompt: `Title this conversation:\n${transcript}`,
      temperature: 0.2,
      maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("title generation timed out")), timeoutMs);
    });
    const result = await Promise.race([pending, timeout]);
    return cleanGeneratedTitle(result.text);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
