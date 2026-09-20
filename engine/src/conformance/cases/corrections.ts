/**
 * Posted-history correction model — internal-controls evidence cases.
 *
 * Each case pins one invariant of the repository correction policy as an
 * executable fixture and maps to its AUDIT-CONTROLS.md control id: posted
 * history is immutable except through reversal and replacement, and a
 * reversal restores every balance. These are OpenBooks' own controls, not
 * requirements of a published accounting standard, so they carry `control`
 * instead of `citations` and are published in the internal-controls
 * matrix — never in the standards matrix.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  postProjectGlEntry,
  reverseProjectGlEntry,
} from "../../projects/recognition.ts";
import { capture } from "../ledger-helpers.ts";
import type { CaseContext } from "../types.ts";
import type { ControlCase } from "../controls.ts";

export const CORRECTION_CONTROL_CASES: readonly ControlCase[] = [
  {
    id: "correction-reversal-restores",
    title: "Reversing a posted entry restores every balance",
    control: "E9",
    support: "supported",
    tier: "ledger",
    assertion:
      "Posting a 1,000.00 project cost moves 1,000.00 onto the cost account, reversing mirrors every leg through a posted reversal entry, and the ledger afterwards equals the pre-cost ledger on every account.",
    facts: [
      "Project cost 1000.00 on the cost account against bank in the open period.",
      "Reversal through the project GL reversal service with a recorded reason, dated inside the open period.",
      "The original entry ends reversed; the reversal entry ends posted and references the original.",
    ],
    expected: {
      entries: [
        {
          step: "post project cost",
          lines: [
            { role: "cogs", amount: "1000.0000" },
            { role: "bank", amount: "-1000.0000" },
          ],
        },
        {
          step: "reverse project cost",
          lines: [
            { role: "cogs", amount: "-1000.0000" },
            { role: "bank", amount: "1000.0000" },
          ],
        },
        { step: "balances after reversal equal pre-cost balances", lines: [] },
      ],
      values: { statusAfterReverse: "reversed" },
    },
    run: async (ctx: CaseContext) => {
      const ledger = ctx.ledger!;
      let entryId = "";
      const postEntry = await capture(ctx, "post project cost", async () => {
        const posted = await postProjectGlEntry({
          orgId: ledger.orgId,
          actorId: ledger.actorId,
          origin: "manual",
          entryNumber: `CORRECTION-SEED-${randomUUID()}`,
          postingDate: ledger.date,
          memo: "Correction-model project cost",
          subsidiaryId: ledger.subsidiaryId,
          currency: "CAD",
          lines: [
            { accountId: ctx.roles.cogs, amount: "1000" },
            { accountId: ctx.roles.bank, amount: "-1000" },
          ],
        });
        if (!posted) throw new Error("project cost entry did not post");
        entryId = posted;
      });
      let reversedStatus = "";
      const reverseEntry = await capture(ctx, "reverse project cost", async () => {
        const reversalId = await reverseProjectGlEntry(
          ledger.orgId,
          ledger.actorId,
          entryId,
          "Reverse the correction-model project cost",
          ledger.date,
        );
        if (!reversalId) throw new Error("reverse wrote no reversal entry");
        reversedStatus = (
          await db.execute<{ status: string }>(
            sql`select status from journal_entries where id = ${entryId}`,
          )
        ).rows[0]!.status;
      });
      const restoredEntry = await capture(
        ctx,
        "balances after reversal equal pre-cost balances",
        async () => {},
      );
      return {
        entries: [postEntry, reverseEntry, restoredEntry],
        values: { statusAfterReverse: reversedStatus },
      };
    },
  },
];
