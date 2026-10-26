/**
 * A voided source cancels its amortization schedules inside the void's own
 * transaction. The void reversal already returns the full deferral to the
 * payable; the schedule's posted amortization then returns from expense to
 * the deferral account on the reversal date, so expense and the deferral
 * both net to zero for the source. Earlier amortization entries are never
 * edited, and their periods are never reopened.
 */
import type { SqlExecutor } from "../platform/db.ts";
import { recordScheduleEvent } from "./internal.ts";
import {
  closePlannedLines,
  livePlanLines,
  lockSchedulesForDocument,
  scheduleBalance,
  updateSchedule,
} from "./schedule-store.ts";
import { reversePostedAmortization } from "./schedules.ts";
import { fromUnits } from "../money/money.ts";

export async function cancelAmortizationForVoidedSource(
  runner: SqlExecutor,
  input: {
    orgId: string;
    documentId: string;
    reversalDate: string;
    actorId: string | null;
    reason: string;
  },
): Promise<{ scheduleId: string; entryId: string | null }[]> {
  const out: { scheduleId: string; entryId: string | null }[] = [];
  for (const schedule of await lockSchedulesForDocument(runner, input.orgId, input.documentId)) {
    if (schedule.status === "cancelled") continue;
    const lines = await livePlanLines(runner, input.orgId, schedule.id);
    const balance = scheduleBalance(schedule, lines);
    const restored = await reversePostedAmortization(runner, schedule, {
      postingDate: input.reversalDate,
      entrySuffix: "VOID",
      idempotencyKey: `expense-amortization:source-void:${schedule.id}`,
      memo: `Source voided: amortization of ${schedule.scheduleNumber} returned`,
      actorId: input.actorId,
    });
    await closePlannedLines(
      runner,
      input.orgId,
      lines.filter((line) => line.status === "planned").map((line) => line.id),
      "cancelled",
    );
    const updated = await updateSchedule(runner, schedule, input.actorId, {
      status: "cancelled",
      cancelled: true,
      reversed: schedule.reversed + restored.amount,
      holdReason: null,
    });
    await recordScheduleEvent(runner, {
      orgId: input.orgId,
      scheduleId: schedule.id,
      kind: "source_voided",
      reason:
        input.reason.trim().length >= 1
          ? input.reason.trim().slice(0, 2000)
          : "Source document voided.",
      effectiveOn: input.reversalDate,
      balanceDelta: -balance.remaining,
      before: {
        status: schedule.status,
        remaining: fromUnits(balance.remaining),
        amortized: fromUnits(balance.amortized),
      },
      after: { status: updated.status, restored: fromUnits(restored.amount) },
      journalEntryId: restored.entryId,
      relatedDocumentId: input.documentId,
      actorId: input.actorId,
    });
    out.push({ scheduleId: schedule.id, entryId: restored.entryId });
  }
  return out;
}
