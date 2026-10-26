import { and, eq, sql } from "drizzle-orm";
import { db, schema, withBypass, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { postEntry, type PostEntryLineInput } from "../journal/post-entry.ts";
import { reversalJournalLines } from "../records/reversal-journal-lines.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { JournalInstructionError } from "./journal-instruction-error.ts";

export async function queueJournalReversal(
  runner: SqlExecutor,
  input: {
    orgId: string;
    documentId: string;
    sourceEntryId: string;
    reverseOn: string;
    actorId: string | null;
  },
): Promise<void> {
  const saved = await runner.execute(
    sql`insert into journal_reversal_instructions(org_id,document_id,source_entry_id,reverse_on,created_by,updated_by)
    values(${input.orgId},${input.documentId},${input.sourceEntryId},${input.reverseOn},${input.actorId},${input.actorId}) returning id`,
    "objects",
  );
  if (saved.length !== 1)
    throw new JournalInstructionError(
      "The approved reversal instruction could not be stored.",
      "Retry posting the journal; the posting and its instruction were rolled back together.",
    );
}

export async function cancelScheduledJournalReversal(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
  actorId: string | null,
  reason = "The source journal was voided through its native lifecycle.",
): Promise<void> {
  const changed = await runner.execute<{ id: string }>(
    sql`update journal_reversal_instructions set status='cancelled',last_error=null,updated_at=now(),updated_by=${actorId}
    where org_id=${orgId} and document_id=${documentId} and status in ('planned','blocked') returning id`,
    "objects",
  );
  for (const row of changed)
    await runner.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${orgId},'journal_reversal_instructions',${row.id},'cancel',${JSON.stringify({ reason })}::jsonb,${actorId})`);
}

export async function runScheduledJournalReversals(input: {
  orgId: string;
  actorId?: string | null;
  asOf?: string;
}): Promise<{ reversed: number; blocked: { id: string; message: string }[] }> {
  if (input.asOf && !isIsoCalendarDate(input.asOf))
    throw new JournalInstructionError(
      "The reversal cutoff is not a calendar date.",
      "Choose YYYY-MM-DD.",
    );
  const due = await withOrgTransaction(input.orgId, async () => {
    const today = await businessTodayInTx(db, input.orgId);
    if (input.asOf && input.asOf > today)
      throw new JournalInstructionError(
        "Scheduled reversals cannot run before their approved date.",
        "Choose today or an earlier cutoff.",
      );
    const cutoff = input.asOf ?? today;
    const allowed = input.actorId
      ? await actorAllowedSubsidiaryIds(db, input.orgId, input.actorId)
      : null;
    if (input.actorId)
      await lockActorCommandAuthority(db, input.orgId, input.actorId, null, "gl.post");
    return await db.execute<{ id: string }>(
      sql`
      select i.id from journal_reversal_instructions i join documents d on d.org_id=i.org_id and d.id=i.document_id
      where i.org_id=${input.orgId} and i.status in ('planned','blocked') and i.reverse_on<=${cutoff}
      ${allowed === null ? sql`` : sql`and d.subsidiary_id=any(${`{${[...allowed].join(",")}}`}::uuid[])`}
      order by i.reverse_on,i.id`,
      "objects",
    );
  });
  const result = { reversed: 0, blocked: [] as { id: string; message: string }[] };
  for (const candidate of due) {
    try {
      const reversed = await withOrgTransaction(input.orgId, async () => {
        await lockLedgerSetupFence(db, input.orgId, "shared");
        // Native lifecycle lock order is document, instruction, then entry.
        const document = (
          await db.execute<{ id: string; void_requested_at: unknown }>(
            sql`
          select d.id,d.void_requested_at from documents d join journal_reversal_instructions i on i.org_id=d.org_id and i.document_id=d.id
          where i.org_id=${input.orgId} and i.id=${candidate.id} for update of d`,
            "objects",
          )
        )[0];
        if (!document) return false;
        if (document.void_requested_at)
          throw new JournalInstructionError(
            "The source journal is awaiting a governed void decision.",
            "Complete or reject that decision before retrying the automatic reversal.",
          );
        const instruction = (
          await db.execute<{
            document_id: string;
            source_entry_id: string;
            reverse_on: string;
            status: string;
            subsidiary_id: string;
          }>(
            sql`
          select i.document_id,i.source_entry_id,i.reverse_on::text,i.status,d.subsidiary_id
          from journal_reversal_instructions i join documents d on d.org_id=i.org_id and d.id=i.document_id
          where i.org_id=${input.orgId} and i.id=${candidate.id} for update of i`,
            "objects",
          )
        )[0];
        if (!instruction || !["planned", "blocked"].includes(instruction.status)) return false;
        if (input.actorId)
          await lockActorCommandAuthority(
            db,
            input.orgId,
            input.actorId,
            instruction.subsidiary_id,
            "gl.post",
          );
        const source = (
          await db.execute<{
            book_id: string;
            subsidiary_id: string;
            entry_number: string;
            origin: string;
            status: string;
          }>(
            sql`
          select book_id,subsidiary_id,entry_number,origin,status from journal_entries
          where org_id=${input.orgId} and id=${instruction.source_entry_id} for update`,
            "objects",
          )
        )[0];
        if (!source || source.status !== "posted") {
          await cancelScheduledJournalReversal(
            db,
            input.orgId,
            instruction.document_id,
            input.actorId ?? null,
          );
          return false;
        }
        const liveEntries = await db.execute<{
          id: string;
          entry_number: string;
          origin: string;
          book_id: string;
          subsidiary_id: string;
        }>(
          sql`
          select id,entry_number,origin,book_id,subsidiary_id from journal_entries where org_id=${input.orgId} and source_document_id=${instruction.document_id}
            and (book_id=${source.book_id} or origin='allocation') and status='posted' and reverses_entry_id is null -- Live entries only: scheduled reversal must not reverse an already reversed entry.
          order by (id=${instruction.source_entry_id}) desc,id for update`,
          "objects",
        );
        let primaryReversalId: string | null = null;
        for (const live of liveEntries) {
          const period = await resolveCoveringPeriod(
            db,
            input.orgId,
            instruction.reverse_on,
            live.subsidiary_id,
          );
          if (!period)
            throw new JournalInstructionError(
              "No accounting period covers the approved reversal date.",
              "Generate the entity's period, then retry the scheduled reversals.",
            );
          const lines = await db
            .select()
            .from(schema.journalLines)
            .where(
              and(
                eq(schema.journalLines.orgId, input.orgId),
                eq(schema.journalLines.entryId, live.id),
              ),
            );
          const mirrored = reversalJournalLines(lines, { orgId: input.orgId, entryId: "" });
          const reversal = await postEntry(db, {
            orgId: input.orgId,
            bookId: live.book_id,
            subsidiaryId: live.subsidiary_id,
            entryNumber: await nextFreeEntryNumber(db, input.orgId, `REV-${live.entry_number}`),
            postingDate: instruction.reverse_on,
            periodId: period.id,
            origin: live.origin,
            sourceDocumentId: instruction.document_id,
            reversesEntryId: live.id,
            actorId: input.actorId ?? null,
            memo: `Approved automatic reversal of ${live.entry_number}`,
            allowInactiveAccounts: true,
            amountBasis: "book",
            accountBasis: "book",
            idempotencyKey:
              live.id === instruction.source_entry_id
                ? `journal-reversal:${candidate.id}`
                : `journal-reversal:${candidate.id}:${live.id}`,
            auditChanges: {
              instructionId: candidate.id,
              approvedReversalOn: instruction.reverse_on,
              actorKind: input.actorId ? "user" : "system",
            },
            lines: mirrored.map((line) => ({
              ...line,
              currency: line.currency!,
              txnAmount: line.txnAmount!,
              amount: line.amount!,
              subsidiaryId: line.subsidiaryId!,
              isOpenItem: false,
              extraDims: line.extraDims as PostEntryLineInput["extraDims"],
              custom: line.custom as PostEntryLineInput["custom"],
            })),
          });
          if (live.id === instruction.source_entry_id) primaryReversalId = reversal.entryId;
        }
        if (!primaryReversalId)
          throw new JournalInstructionError(
            "The approved source entry is not part of the live journal projection.",
            "Review the journal's governed correction history before retrying.",
          );
        const updated = await db.execute(
          sql`update journal_reversal_instructions set status='completed',reversal_entry_id=${primaryReversalId},last_error=null,updated_at=now(),updated_by=${input.actorId ?? null}
          where org_id=${input.orgId} and id=${candidate.id} and status in ('planned','blocked') returning id`,
          "objects",
        );
        if (updated.length !== 1)
          throw new JournalInstructionError(
            "The scheduled reversal changed concurrently.",
            "Reload the journal and retry.",
          );
        await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
          values(${input.orgId},'journal_reversal_instructions',${candidate.id},'complete',${JSON.stringify({ sourceEntryId: instruction.source_entry_id, reversalEntryId: primaryReversalId, reverseOn: instruction.reverse_on, actorKind: input.actorId ? "user" : "system" })}::jsonb,${input.actorId ?? null})`);
        return true;
      });
      if (reversed) result.reversed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.blocked.push({ id: candidate.id, message });
      await withOrgTransaction(input.orgId, async () => {
        const changed = await db.execute(
          sql`update journal_reversal_instructions set status='blocked',last_error=${message},updated_at=now(),updated_by=${input.actorId ?? null}
          where org_id=${input.orgId} and id=${candidate.id} and status in ('planned','blocked') returning id`,
          "objects",
        );
        if (changed.length > 0)
          await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
          values(${input.orgId},'journal_reversal_instructions',${candidate.id},'blocked',${JSON.stringify({ message })}::jsonb,${input.actorId ?? null})`);
      });
    }
  }
  return result;
}

/** Scheduled duty discovers tenants once, then executes each approved instruction in its own tenant context. */
export async function runDueJournalReversals(): Promise<void> {
  // bypass: scheduler-tick — discover organizations with pending instructions;
  // execute each retained instruction through its tenant-scoped native command.
  const orgs = await withBypass(
    async () =>
      await db.execute<{ org_id: string }>(
        sql`
    select distinct org_id from journal_reversal_instructions where status in ('planned','blocked') order by org_id`,
        "objects",
      ),
  );
  for (const row of orgs) {
    try {
      await runScheduledJournalReversals({ orgId: row.org_id });
    } catch (error) {
      console.error("Scheduled journal reversal scan failed for organization", row.org_id, error);
    }
  }
}

/** A completed automatic adjustment is corrected by another journal, rather than a duplicate void mirror. */
export async function assertJournalVoidNotAutomaticallyReversed(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<void> {
  const completed = (
    await runner.execute<{ id: string }>(
      sql`select id from journal_reversal_instructions where org_id=${orgId} and document_id=${documentId} and status='completed'`,
      "objects",
    )
  )[0];
  if (completed)
    throw new JournalInstructionError(
      "This journal already has its approved automatic reversal.",
      "Create a correcting journal for any further adjustment; the original and its reversal are retained history.",
    );
}
