import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { parseMoney } from "../money/brands.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  seedHourlyPayrollOrg,
  seedHourlyPayrollEmployee,
} from "../testing/payroll-hourly-fixture.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { insertPayStubRow, insertPayStubLineRows, type Line } from "./run-stub-records.ts";
import {
  resolveStatutoryHistoryScope,
  requireStatutoryHistoryFactors,
} from "./statutory-history-scope.ts";

test(
  "legacy zero Canadian bases require original zero cash lines and retained dated applicability",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async (t) => {
    const fx = await seedHourlyPayrollOrg();
    try {
      const { partyId, employmentId } = await seedHourlyPayrollEmployee(
        fx,
        "Zero basis employee",
        fx.subsidiaryId,
      );
      const current = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      const componentId = (
        await db.execute<{ id: string }>(
          sql`select id from pay_components
      where org_id=${fx.orgId} and system_key='base_pay' and kind='earning' and (country is null or country='CA')`,
          "objects",
        )
      )[0]!.id;
      const scope = await resolveStatutoryHistoryScope(db, {
        orgId: fx.orgId,
        documentId: current.documentId,
        taxYear: 2026,
        country: "CA",
        employeePartyId: partyId,
        employmentId,
      });
      const treatment = {
        componentId,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        programExclusions: [] as string[],
      };
      type Case = {
        name: string;
        accepts?: boolean;
        factors?: Record<string, unknown>;
        gross?: string;
        treatments?: unknown;
        amounts?: string[];
        paymentKind?: "cash" | "non_cash";
        derivedRuleCode?: string;
        keys?: string[];
      };
      const cases: Case[] = [
        { name: "both missing bases with full original zero evidence", accepts: true },
        {
          name: "explicit numeric zero needs no reconstructed evidence",
          accepts: true,
          factors: { WCB_EARN: "0.0000", EHT_EARN: "0.0000" },
          treatments: null,
        },
        {
          name: "a malformed present factor cannot use the exception",
          factors: { WCB_EARN: "unknown" },
        },
        { name: "a null present factor cannot use the exception", factors: { WCB_EARN: null } },
        { name: "missing treatment snapshot", treatments: null },
        { name: "uncovered component", treatments: [] },
        { name: "unknown applicability", treatments: [{ ...treatment, programExclusions: null }] },
        {
          name: "retained WCB exclusion",
          treatments: [{ ...treatment, programExclusions: ["wcb"] }],
        },
        {
          name: "retained EHT exclusion",
          treatments: [{ ...treatment, programExclusions: ["eht"] }],
        },
        {
          name: "treatment starts after the original pay date",
          treatments: [{ ...treatment, effectiveFrom: "2026-07-01" }],
        },
        {
          name: "treatment ends before the original pay date",
          treatments: [{ ...treatment, effectiveTo: "2026-06-01" }],
        },
        { name: "positive original gross", gross: "1", amounts: ["1"] },
        { name: "offsetting amounts are not zero original lines", amounts: ["1", "-1"] },
        { name: "noncash original line", paymentKind: "non_cash" },
        { name: "derived operational earnings", derivedRuleCode: "distance" },
        { name: "another missing statutory factor", keys: ["CNT_EARN"] },
      ];
      const rolledBack = new Error("fixture rollback");
      for (const item of cases)
        await t.test(item.name, async () => {
          await assert.rejects(
            db.transaction(async (tx) => {
              const documentId = randomUUID();
              const lineComponentId = item.paymentKind ? randomUUID() : componentId;
              if (item.paymentKind)
                await tx.execute(sql`insert into pay_components
          (id,org_id,code,name,kind,country,payment_kind,non_cash_account_id)
          values(${lineComponentId},${fx.orgId},'ZERO-NONCASH','Original noncash earning','earning','CA',
            'non_cash',${fx.accounts.wageExpense})`);
              await tx.execute(sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency,status,created_by,updated_by)
          values(${documentId},${fx.orgId},'pay_run',${"PAY-" + documentId.slice(0, 8)},${fx.subsidiaryId},'2026-06-23','CAD','approved',${fx.actorId},${fx.actorId})`);
              const snapshot = {
                payComponentStatutoryTreatments:
                  item.treatments === undefined
                    ? [{ ...treatment, componentId: lineComponentId }]
                    : item.treatments,
              };
              const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
              await tx.execute(sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,calculation_source_snapshot,calculation_source_digest,created_by,updated_by)
          values(${documentId},${fx.orgId},${fx.scheduleId},'2026-06-07','2026-06-20','2026-06-23',2026,'committed',${JSON.stringify(snapshot)}::jsonb,${digest},${fx.actorId},${fx.actorId})`);
              const stubId = await insertPayStubRow(tx, {
                orgId: fx.orgId,
                actorId: fx.actorId,
                documentId,
                employeePartyId: partyId,
                employmentId,
                filingAccountId: null,
                country: "CA",
                currency: "CAD",
                province: "ON",
                periodsPerYear: 52,
                payDate: "2026-06-23",
                taxYear: 2026,
                federalClaim: "0",
                provincialClaim: "0",
                gross: item.gross ?? "0",
                pensionable: "0",
                insurable: "0",
                net: "0",
                employerCost: "0",
                vacationAccrued: "0",
                factors: {},
                paymentMethod: "cheque",
              });
              if (item.factors)
                await tx.execute(
                  sql`update pay_stubs set factors=${JSON.stringify(item.factors)}::jsonb where org_id=${fx.orgId} and id=${stubId}`,
                );
              const lines: Line[] = (item.amounts ?? ["0"]).map((amount, i) => ({
                componentId: lineComponentId,
                kind: "earning",
                description: "Original zero register line",
                amount: parseMoney(amount),
                sequence: i + 1,
                ...(item.derivedRuleCode
                  ? { derivedRuleCode: item.derivedRuleCode, derivedQuantity: "1.0000" }
                  : {}),
                ...(item.paymentKind
                  ? { paymentKind: item.paymentKind, nonCashAccountId: fx.accounts.wageExpense }
                  : {}),
              }));
              await insertPayStubLineRows(
                tx,
                {
                  orgId: fx.orgId,
                  actorId: fx.actorId,
                  stubId,
                  country: "CA",
                  payDate: "2026-06-23",
                },
                lines,
              );
              const original = (
                await tx.execute<{ body: string }>(
                  sql`select to_jsonb(s)::text as body from pay_stubs s where org_id=${fx.orgId} and id=${stubId}`,
                  "objects",
                )
              )[0]!.body;
              const validate = () =>
                requireStatutoryHistoryFactors(
                  tx,
                  scope,
                  { employeePartyId: partyId },
                  item.keys ?? ["WCB_EARN", "EHT_EARN"],
                );
              if (item.accepts) await validate();
              else await assert.rejects(validate(), /missing a numeric factor/);
              assert.equal(
                (
                  await tx.execute<{ body: string }>(
                    sql`select to_jsonb(s)::text as body from pay_stubs s where org_id=${fx.orgId} and id=${stubId}`,
                    "objects",
                  )
                )[0]!.body,
                original,
              );
              throw rolledBack;
            }),
            (error) => error === rolledBack,
          );
        });
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
