import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  type ScratchOrg,
  type FlowActors,
} from "../testing/fixtures.ts";
import {
  createLeaseAgreement,
  commenceLease,
  postDueLeaseSchedules,
} from "./leases.ts";
import {
  proposeLeaseChange,
  applyLeaseChange,
  type LeaseChangeInput,
} from "./lease-changes.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate, worklistGates } from "../flows/gates.ts";
import { toUnits } from "../money/money.ts";
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture(
  fn: (
    org: ScratchOrg,
    actors: FlowActors,
    leaseId: string,
    accounts: Record<string, string>,
  ) => Promise<void>,
  timing: "advance" | "arrears" = "advance",
) {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await db.execute(
      sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values (${org.orgId},${actors.submitterId},'assets.manage','grant')`,
    );
    const accounts: Record<string, string> = {
      payment: org.accounts.bank,
      gain: org.accounts.fxGainLoss,
    };
    for (const [key, number, type] of [
      ["rouAsset", "1781", "asset_fixed"],
      ["leaseLiability", "2781", "liability_long_term"],
      ["interestExpense", "6981", "expense_other"],
      ["amortizationExpense", "6982", "expense"],
      ["leaseExpense", "6983", "expense"],
    ] as const) {
      const id = randomUUID();
      await db.execute(
        sql`insert into accounts(id,org_id,number,name,type,is_active,is_summary,custom) values (${id},${org.orgId},${number},${key},${type},true,false,'{}'::jsonb)`,
      );
      accounts[key!] = id;
    }
    const result = await createLeaseAgreement(org.orgId, actors.submitterId, {
      subsidiaryId: org.subsidiaryId,
      leaseNumber: `LC-${randomUUID()}`,
      commencementOn: "2026-07-01",
      termPeriods: 3,
      paymentFrequency: "monthly",
      paymentTiming: timing,
      paymentAmount: "1000",
      annualDiscountRatePercent: "0",
      classificationInputs: { transfersOwnership: true },
      accounts: accounts as unknown as Parameters<
        typeof createLeaseAgreement
      >[2]["accounts"],
    });
    await commenceLease(org.orgId, result.leaseId, actors.submitterId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "financial_change",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
      preventSelfApproval: false,
    });
    await fn(org, actors, result.leaseId, accounts);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}
function input(
  accounts: Record<string, string>,
  patch: Partial<LeaseChangeInput> = {},
): LeaseChangeInput {
  return {
    operation: "termination",
    effectiveOn: "2026-07-16",
    reason: "Lease surrendered by mutual agreement",
    idempotencyKey: randomUUID(),
    scopeReductionPercent: "100",
    settlementPayment: "250",
    gainLossAccountId: accounts.gain!,
    assessment: "Entire right of use ends; signed settlement is 250.",
    ...patch,
  };
}
async function approve(org: ScratchOrg, actors: FlowActors, changeId: string) {
  await submitFinancialChange(org.orgId, changeId, actors.submitterId);
  const gate = (
    await db.execute<{ id: string }>(
      sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${changeId} and status='pending'`,
    )
  ).rows[0];
  assert.ok(gate, "a real approval gate was created");
  await decideGate({
    gateId: gate.id,
    userId: actors.approver1Id,
    decision: "approved",
  });
}
async function balance(orgId: string, accountId: string) {
  const row = (
    await db.execute<{ amount: string }>(
      sql`select coalesce(sum(l.amount),0)::text as amount from journal_lines l join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=${orgId} and l.account_id=${accountId} and e.status='posted'`,
    )
  ).rows[0]!;
  return toUnits(row.amount);
}
test(
  "advance cash posts at commencement; expense is not pulled forward from period end",
  { skip: !DB },
  async () => {
    await fixture(async (org, actors, lease, accounts) => {
      assert.equal(
        await balance(org.orgId, accounts.payment!),
        -toUnits("1000"),
      );
      assert.equal(
        await balance(org.orgId, accounts.rouAsset!),
        toUnits("3000"),
      );
      assert.equal(
        await balance(org.orgId, accounts.leaseLiability!),
        -toUnits("2000"),
      );
      assert.equal(await balance(org.orgId, accounts.amortizationExpense!), 0n);
      assert.equal(
        (
          await postDueLeaseSchedules(
            org.orgId,
            "2026-07-15",
            actors.submitterId,
            { leaseId: lease },
          )
        ).posted,
        0,
      );
      assert.equal(
        (
          await postDueLeaseSchedules(
            org.orgId,
            "2026-07-31",
            actors.submitterId,
            { leaseId: lease },
          )
        ).posted,
        1,
      );
      assert.equal(
        await balance(org.orgId, accounts.amortizationExpense!),
        toUnits("1000"),
      );
      assert.equal(
        await balance(org.orgId, accounts.payment!),
        -toUnits("1000"),
      );
      assert.equal(
        (
          await postDueLeaseSchedules(
            org.orgId,
            "2026-07-31",
            actors.submitterId,
            { leaseId: lease },
          )
        ).posted,
        0,
      );
    });
  },
);
test(
  "approved mid-period termination posts stub, removes balances, preserves cash history, and retries once",
  { skip: !DB },
  async () => {
    await fixture(async (org, actors, lease, accounts) => {
      const old = (
        await db.execute<{ id: string; payment_entry_id: string }>(
          sql`select id,payment_entry_id from lease_agreement_schedule_lines where org_id=${org.orgId} and lease_id=${lease} and sequence=1`,
        )
      ).rows[0]!;
      const { changeId } = await proposeLeaseChange(
        org.orgId,
        lease,
        actors.submitterId,
        input(accounts),
      );
      await assert.rejects(
        applyLeaseChange(org.orgId, changeId, actors.submitterId),
        /independent approval/,
      );
      await approve(org, actors, changeId);
      const first = await applyLeaseChange(
        org.orgId,
        changeId,
        actors.submitterId,
      );
      const second = await applyLeaseChange(
        org.orgId,
        changeId,
        actors.submitterId,
      );
      assert.deepEqual(second, first);
      assert.equal(await balance(org.orgId, accounts.rouAsset!), 0n);
      assert.equal(await balance(org.orgId, accounts.leaseLiability!), 0n);
      assert.equal(
        await balance(org.orgId, accounts.payment!),
        -toUnits("1250"),
      );
      const kept = (
        await db.execute<{
          payment_entry_id: string;
          superseded_by_change_id: string;
        }>(
          sql`select payment_entry_id,superseded_by_change_id from lease_agreement_schedule_lines where id=${old.id}`,
        )
      ).rows[0]!;
      assert.equal(kept.payment_entry_id, old.payment_entry_id);
      assert.equal(kept.superseded_by_change_id, changeId);
      assert.equal(
        (
          await postDueLeaseSchedules(
            org.orgId,
            "2026-09-30",
            actors.submitterId,
            { leaseId: lease },
          )
        ).posted,
        0,
      );
      await assert.rejects(
        async () =>
          await db.execute(
            sql`update lease_agreement_schedule_lines set payment='99' where id=${old.id}`,
          ),
        (error: unknown) => errorChainMatches(error, /lease schedule measurements are immutable; append a revision/),
      );
      await assert.rejects(
        async () =>
          await db.execute(
            sql`update financial_changes set reason='Rewrite approved terms' where id=${changeId}`,
          ),
        (error: unknown) => errorChainMatches(error, /financial changes are immutable evidence; propose a correcting change/),
      );
    });
  },
);
test(
  "remeasurement appends a new payment revision and the subledger agrees with the GL",
  { skip: !DB },
  async () => {
    await fixture(async (org, actors, lease, accounts) => {
      const { changeId } = await proposeLeaseChange(
        org.orgId,
        lease,
        actors.submitterId,
        input(accounts, {
          operation: "remeasurement",
          effectiveOn: "2026-07-01",
          scopeReductionPercent: "0",
          settlementPayment: "0",
          remainingTerms: {
            periods: 3,
            payment: "1200",
            paymentFrequency: "monthly",
            paymentTiming: "arrears",
            annualRatePercent: "0",
            classificationInputs: { transfersOwnership: true },
          },
        }),
      );
      await approve(org, actors, changeId);
      const result = await applyLeaseChange(
        org.orgId,
        changeId,
        actors.submitterId,
      );
      assert.equal(result.newLiability, "3600.0000");
      assert.equal(result.newRou, "4600.0000");
      assert.equal(
        await balance(org.orgId, accounts.leaseLiability!),
        -toUnits("3600"),
      );
      assert.equal(
        await balance(org.orgId, accounts.rouAsset!),
        toUnits("4600"),
      );
      const rows = (
        await db.execute<{ revision: number; superseded: boolean }>(
          sql`select revision,superseded_by_change_id is not null as superseded from lease_agreement_schedule_lines where org_id=${org.orgId} and lease_id=${lease} order by sequence`,
        )
      ).rows;
      assert.equal(rows.length, 6);
      assert.ok(rows.slice(0, 3).every((r) => r.superseded));
      assert.ok(rows.slice(3).every((r) => r.revision === 2 && !r.superseded));
      await postDueLeaseSchedules(org.orgId, "2026-07-31", actors.submitterId, {
        leaseId: lease,
      });
      assert.equal(
        await balance(org.orgId, accounts.payment!),
        -toUnits("2200"),
      );
    });
  },
);
test(
  "approval cannot apply a proposal after the underlying schedule posts",
  { skip: !DB },
  async () => {
    await fixture(async (org, actors, lease, accounts) => {
      const { changeId } = await proposeLeaseChange(
        org.orgId,
        lease,
        actors.submitterId,
        input(accounts),
      );
      await approve(org, actors, changeId);
      await postDueLeaseSchedules(org.orgId, "2026-07-31", actors.submitterId, {
        leaseId: lease,
      });
      const before = await balance(org.orgId, accounts.rouAsset!);
      await assert.rejects(
        applyLeaseChange(org.orgId, changeId, actors.submitterId),
        /already posted|changed after/,
      );
      assert.equal(await balance(org.orgId, accounts.rouAsset!), before);
    });
  },
);
test(
  "late posting failure rolls back stub and revision even when caller catches inside its transaction",
  { skip: !DB },
  async () => {
    await fixture(async (org, actors, lease, accounts) => {
      const { changeId } = await proposeLeaseChange(
        org.orgId,
        lease,
        actors.submitterId,
        input(accounts),
      );
      await approve(org, actors, changeId);
      await db.execute(
        sql`update accounts set is_active=false where id=${accounts.gain!} and org_id=${org.orgId}`,
      );
      const before = await balance(org.orgId, accounts.rouAsset!);
      await withOrg(org.orgId, async () => {
        await assert.rejects(
          applyLeaseChange(org.orgId, changeId, actors.submitterId),
          /active, non-summary/,
        );
      });
      assert.equal(await balance(org.orgId, accounts.rouAsset!), before);
      assert.equal(
        (
          await db.execute<{ revision: number }>(
            sql`select revision from lease_agreements where id=${lease}`,
          )
        ).rows[0]!.revision,
        1,
      );
    });
  },
);
test(
  "missing authority and cross-tenant ids refuse without creating change evidence",
  { skip: !DB },
  async () => {
    await fixture(async (org, actors, lease, accounts) => {
      await assert.rejects(
        proposeLeaseChange(
          org.orgId,
          lease,
          actors.outsiderId,
          input(accounts),
        ),
        /assets.manage/,
      );
      const other = await createScratchOrg();
      try {
        await assert.rejects(
          proposeLeaseChange(
            other.orgId,
            lease,
            actors.submitterId,
            input(accounts),
          ),
          /lease not found/,
        );
      } finally {
        await dropScratchOrg(other.orgId);
      }
      const count = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from financial_changes where org_id=${org.orgId}`,
        )
      ).rows[0]!.n;
      assert.equal(count, 0);
    });
  },
);
test(
  "independent approval cannot be bypassed and legal-entity worklists resolve accounting changes",
  { skip: !DB },
  async () => {
    await fixture(async (org, actors, lease, accounts) => {
      const { changeId } = await proposeLeaseChange(
        org.orgId,
        lease,
        actors.submitterId,
        input(accounts),
      );
      await submitFinancialChange(org.orgId, changeId, actors.submitterId);
      const gate = (
        await db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${changeId} and status='pending'`,
        )
      ).rows[0]!;
      await assert.rejects(
        decideGate({
          gateId: gate.id,
          userId: actors.submitterId,
          decision: "approved",
        }),
        /own submission|not assigned|not allowed|not found/,
      );
      const rows = await withOrg(org.orgId, () =>
        worklistGates(org.orgId, actors.approver1Id),
      );
      const visible = rows.find((row) => row.subjectId === changeId);
      assert.ok(visible);
      assert.equal(visible.subsidiaryId, org.subsidiaryId);
    });
  },
);
test(
  "proposal retry returns its original evidence after the approved termination was applied",
  { skip: !DB },
  async () => {
    await fixture(async (org, actors, lease, accounts) => {
      const proposal = input(accounts),
        first = await proposeLeaseChange(
          org.orgId,
          lease,
          actors.submitterId,
          proposal,
        );
      await approve(org, actors, first.changeId);
      await applyLeaseChange(org.orgId, first.changeId, actors.submitterId);
      assert.deepEqual(
        await proposeLeaseChange(
          org.orgId,
          lease,
          actors.submitterId,
          proposal,
        ),
        first,
      );
      await assert.rejects(
        proposeLeaseChange(org.orgId, lease, actors.submitterId, {
          ...proposal,
          settlementPayment: "1",
        }),
        /request key already/,
      );
    });
  },
);
