/**
 * AI governance — internal-controls evidence cases (HR-21).
 *
 * Each case pins one invariant of the AI-on-the-rails policy as an
 * executable fixture and maps to its AUDIT-CONTROLS.md control id:
 * autonomy moves down only (nothing files, submits, approves or pays on
 * its own), every capability carries its subject notice, and the decision
 * ledger is append-only at the database layer. These are OpenBooks' own
 * controls, not requirements of a published accounting standard, so they
 * carry `control` instead of `citations` and are published in the
 * internal-controls matrix — never in the standards matrix.
 */

import { sql } from "drizzle-orm";
import { AI_CAPABILITIES, assertAutonomyAtOrBelowMax } from "../../hrm/ai/registry.ts";
import { logDecision } from "../../hrm/ai/governance.ts";
import { db } from "../../platform/db.ts";
import type { ActualOutcome } from "../types.ts";
import type { ControlCase } from "../controls.ts";

export const AI_GOVERNANCE_CONTROL_CASES: readonly ControlCase[] = [
  {
    id: "ai-autonomy-down-only",
    title: "Raising a capability above its autonomy ceiling is refused",
    control: "G17",
    support: "supported",
    tier: "computation",
    assertion:
      "Requesting propose for the drafting capability (ceiling draft) throws the named refusal, while lowering it to read-only is accepted — the ladder only moves down, so no capability can promote itself to filing, submitting, approving or paying.",
    facts: [
      "Drafting capability hrmDrafting with the registry ceiling draft.",
      "A raise to propose and a lowering to read-only through the same assertion.",
    ],
    expected: {
      values: {
        raiseRefused: "true",
        lowerAccepted: "true",
      },
    },
    run: (): ActualOutcome => {
      let raiseRefused = "false";
      try {
        assertAutonomyAtOrBelowMax("hrmDrafting", "propose");
      } catch {
        raiseRefused = "true";
      }
      let lowerAccepted = "false";
      try {
        assertAutonomyAtOrBelowMax("hrmDrafting", "read_only");
        lowerAccepted = "true";
      } catch {
        lowerAccepted = "false";
      }
      return { values: { raiseRefused, lowerAccepted } };
    },
  },
  {
    id: "ai-subject-notice-present",
    title: "Every AI capability declares its subject notice and prompt line",
    control: "G18",
    support: "supported",
    tier: "computation",
    assertion:
      "All six registry capabilities carry a non-empty subject notice (the one line shown wherever the output appears, stating what the AI did and that a human decided) and a prompt line stating their autonomy — a capability with no notice cannot ship silently.",
    facts: [
      "The six code-registry capabilities with their notices and prompt lines.",
    ],
    expected: {
      values: {
        capabilities: "6",
        withNotice: "6",
        withPromptLine: "6",
      },
    },
    run: (): ActualOutcome => {
      const defs = [...AI_CAPABILITIES.values()];
      return {
        values: {
          capabilities: String(defs.length),
          withNotice: String(defs.filter((d) => d.noticeText.trim().length > 0).length),
          withPromptLine: String(defs.filter((d) => d.promptLine.trim().length > 0).length),
        },
      };
    },
  },
  {
    id: "ai-ledger-append-only",
    title: "The AI decision ledger refuses updates and deletes",
    control: "G18",
    support: "supported",
    tier: "ledger",
    assertion:
      "Logging one decision stores its row; a later UPDATE and a DELETE against that row both refuse at the database trigger, and the row still reads with its original outcome — corrections are new rows, never edits.",
    facts: [
      "One logged payslip explanation (capability hrmExplainPay, outcome shown).",
      "An UPDATE setting outcome to rejected and a DELETE against the same row.",
    ],
    expected: {
      values: {
        updateRefused: "true",
        deleteRefused: "true",
        outcomeStillShown: "true",
      },
    },
    run: async (ctx): Promise<ActualOutcome> => {
      const ledger = ctx.ledger!;
      const id = await logDecision(db, {
        orgId: ledger.orgId,
        actorId: ledger.actorId,
        capabilityKey: "hrmExplainPay",
        subjectKind: "employment",
        subjectId: null,
        input: "in",
        output: "out",
        outputSummary: "append-only evidence probe",
        sources: [],
        outcome: "shown",
        model: "conformance",
      });
      let updateRefused = "false";
      try {
        await db.execute(sql`update ai_decisions set outcome = 'rejected' where id = ${id}::uuid`);
      } catch {
        updateRefused = "true";
      }
      let deleteRefused = "false";
      try {
        await db.execute(sql`delete from ai_decisions where id = ${id}::uuid`);
      } catch {
        deleteRefused = "true";
      }
      const rows = (await db.execute<{ outcome: string }>(
        sql`select outcome from ai_decisions where id = ${id}::uuid`,
      )).rows;
      return {
        values: {
          updateRefused,
          deleteRefused,
          outcomeStillShown: rows[0]?.outcome === "shown" ? "true" : "false",
        },
      };
    },
  },
];
