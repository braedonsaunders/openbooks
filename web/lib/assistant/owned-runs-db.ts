import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import type { Authz } from "../authz";
import type { OwnedRunOutcome, OwnedRunSnapshot, OwnedRunStatus, OwnedRunStore } from "./owned-runs";

/**
 * Database adapter for server-owned assistant runs. Runs live in the
 * existing ai_messages table — NO schema change: the run IS the assistant
 * message row, progressively enriched while it streams.
 *
 *   data = { v: 1, kind: "agent-turn", status, revision, abortRequested,
 *            finishReason, usage, parts }
 *
 * Transcript readers (recentMessages/olderMessages) already render
 * data.parts, so a running row shows its live progress on reload with no
 * reader changes; the status field tells the client whether to follow it.
 * Every write re-checks conversation ownership in SQL, like the rest of
 * ai-conversations.ts — a caller can never touch another owner's run.
 */

type RunRow = {
  id: string;
  conversation_id: string;
  status: OwnedRunStatus;
  parts: unknown[];
  revision: number;
  aborted: boolean;
  updated_at: string;
};

const RUN_DATA = sql`m.data`;

function toSnapshot(row: RunRow): OwnedRunSnapshot {
  return {
    runId: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    parts: Array.isArray(row.parts) ? row.parts : [],
    revision: row.revision,
  };
}

export function createDbOwnedRunStore(authz: Authz): OwnedRunStore {
  const { user } = authz;
  /** Ownership predicate for run rows: this user's org-owned conversation. */
  const ownedConversation = (conversationId: unknown) => sql`
    select 1 from ai_conversations c
     where c.id = ${conversationId}
       and c.org_id = ${user.orgId} and c.user_id = ${user.id}`;

  return {
    async startRun(conversationId: string) {
      const rows = (await db.execute<{ id: string }>(sql`
        insert into ai_messages (org_id, conversation_id, role, content, data, created_by, updated_by)
        select ${user.orgId}, ${conversationId}, 'assistant', '',
               ${JSON.stringify({ v: 1, kind: "agent-turn", status: "running", revision: 0, abortRequested: false, parts: [] })}::jsonb,
               ${user.id}, ${user.id}
         where exists (${ownedConversation(conversationId)})
        returning id`)).rows;
      const id = rows[0]?.id;
      if (!id) throw new Error("conversation not owned");
      return { runId: id };
    },

    async writeProgress(runId: string, parts: unknown[], revision: number) {
      const rows = (await db.execute<{ id: string }>(sql`
        update ai_messages m
           set data = jsonb_set(jsonb_set(${RUN_DATA}, '{parts}', ${JSON.stringify(parts)}::jsonb), '{revision}', ${JSON.stringify(revision)}::jsonb),
               updated_at = now(), updated_by = ${user.id}
          from ai_conversations c
         where m.id = ${runId}
           and c.id = m.conversation_id
           and c.org_id = ${user.orgId} and c.user_id = ${user.id}
           and m.data ->> 'status' = 'running'
        returning m.id`)).rows;
      return rows.length > 0;
    },

    async finishRun(runId: string, outcome: OwnedRunOutcome) {
      const rows = (await db.execute<{ id: string }>(sql`
        update ai_messages m
           set content = ${outcome.content},
               data = jsonb_build_object(
                 'v', 1, 'kind', 'agent-turn', 'status', ${outcome.status}::text,
                 'revision', coalesce((m.data ->> 'revision')::int, 0) + 1,
                 'abortRequested', false,
                 'finishReason', ${outcome.finishReason}::text,
                 'usage', ${JSON.stringify(outcome.usage ?? {})}::jsonb,
                 'parts', ${JSON.stringify(outcome.parts ?? [])}::jsonb
               ),
               updated_at = now(), updated_by = ${user.id}
          from ai_conversations c
         where m.id = ${runId}
           and c.id = m.conversation_id
           and c.org_id = ${user.orgId} and c.user_id = ${user.id}
        returning m.id`)).rows;
      return rows.length > 0;
    },

    async readRun(runId: string) {
      const rows = (await db.execute<RunRow>(sql`
        select m.id, m.conversation_id,
               m.data ->> 'status' as status,
               coalesce(m.data -> 'parts', '[]'::jsonb) as parts,
               coalesce((m.data ->> 'revision')::int, 0) as revision,
               coalesce((m.data ->> 'abortRequested')::boolean, false) as aborted,
               m.updated_at as updated_at
          from ai_messages m
          join ai_conversations c on c.id = m.conversation_id
         where m.id = ${runId}
           and c.org_id = ${user.orgId} and c.user_id = ${user.id}
           and m.data ->> 'kind' = 'agent-turn'`)).rows;
      const row = rows[0];
      return row ? toSnapshot(row) : null;
    },

    async activeRun(conversationId: string) {
      const rows = (await db.execute<RunRow>(sql`
        select m.id, m.conversation_id,
               m.data ->> 'status' as status,
               coalesce(m.data -> 'parts', '[]'::jsonb) as parts,
               coalesce((m.data ->> 'revision')::int, 0) as revision,
               coalesce((m.data ->> 'abortRequested')::boolean, false) as aborted,
               m.updated_at as updated_at
          from ai_messages m
          join ai_conversations c on c.id = m.conversation_id
         where m.conversation_id = ${conversationId}
           and c.org_id = ${user.orgId} and c.user_id = ${user.id}
           and m.data ->> 'kind' = 'agent-turn'
           and m.data ->> 'status' = 'running'
         order by m.created_at desc
         limit 1`)).rows;
      const row = rows[0];
      return row ? toSnapshot(row) : null;
    },

    async requestAbort(runId: string) {
      const { abortOwnedRunNow } = await import("./owned-runs");
      abortOwnedRunNow(runId);
      const rows = (await db.execute<{ id: string }>(sql`
        update ai_messages m
           set data = jsonb_set(${RUN_DATA}, '{abortRequested}', 'true'::jsonb),
               updated_at = now(), updated_by = ${user.id}
          from ai_conversations c
         where m.id = ${runId}
           and c.id = m.conversation_id
           and c.org_id = ${user.orgId} and c.user_id = ${user.id}
           and m.data ->> 'status' = 'running'
        returning m.id`)).rows;
      return rows.length > 0;
    },

    async abortRequested(runId: string) {
      const rows = (await db.execute<{ aborted: boolean }>(sql`
        select coalesce((m.data ->> 'abortRequested')::boolean, false) as aborted
          from ai_messages m
          join ai_conversations c on c.id = m.conversation_id
         where m.id = ${runId}
           and c.org_id = ${user.orgId} and c.user_id = ${user.id}`)).rows;
      return rows[0]?.aborted === true;
    },
  };
}
