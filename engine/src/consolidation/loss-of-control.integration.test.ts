import { consolidationHistory } from "./consolidation-history.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  type ScratchOrg,
  type FlowActors,
} from "../testing/fixtures.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import {
  proposeLossOfControl,
  applyLossOfControl,
  proposeLossOfControlReversal,
  applyLossOfControlReversal,
  loadLossOfControlProposalData,
  LossOfControlProposalError,
  type LossOfControlInput,
} from "./loss-of-control.ts";
import { runOwnershipConsolidation } from "./consolidation.ts";
const DB = !!process.env.OPENBOOKS_DB_URL;
type Fixture = {
  org: ScratchOrg;
  actors: FlowActors;
  child: string;
  elimination: string;
  interest: string;
  accounts: Record<string, string>;
};
async function post(
  f: Fixture,
  subsidiaryId: string,
  date: string,
  lines: { accountId: string; amount: string }[],
  reversesEntryId: string | null = null,
) {
  return db.transaction(async (tx) => {
    const id = randomUUID();
    await tx.execute(
      sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,reverses_entry_id) values(${id},${f.org.orgId},${f.org.bookId},${subsidiaryId},${id},${date},${f.org.periodId},'draft','manual',${reversesEntryId})`,
    );
    for (const [i, l] of lines.entries())
      await tx.execute(
        sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate) values(${f.org.orgId},${id},${i + 1},${l.accountId},${subsidiaryId},${l.amount},'CAD',${l.amount},1)`,
      );
    await tx.execute(
      sql`update journal_entries set status='posted',posted_at=now() where org_id=${f.org.orgId} and id=${id}`,
    );
    return id;
  });
}
async function fixture(work: (f: Fixture) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId),
      child = randomUUID(),
      elimination = randomUUID(),
      interest = randomUUID(),
      accounts: Record<string, string> = {};
    await db.execute(
      sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${actors.submitterId},'close.run','grant')`,
    );
    await db.execute(
      sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_elimination,is_active) values(${child},${org.orgId},${org.subsidiaryId},'Disposal subject','CAD','CA',false,true),(${elimination},${org.orgId},${org.subsidiaryId},'Group eliminations','CAD','CA',true,true)`,
    );
    for (const [key, type] of Object.entries({
      investment: "asset_current_other",
      retained: "asset_current_other",
      income: "income_other",
      gain: "income_other",
      nci: "equity",
      nciIncome: "expense_other",
      goodwill: "asset_fixed",
      fairValue: "asset_fixed",
      equity: "equity",
      cta: "equity",
    })) {
      const id = randomUUID();
      accounts[key] = id;
      await db.execute(
        sql`insert into accounts(id,org_id,number,name,type,is_active,is_summary,eliminate) values(${id},${org.orgId},${`C-${key}`},${key},${type},true,false,false)`,
      );
    }
    const f = { org, actors, child, elimination, interest, accounts };
    await post(f, org.subsidiaryId, "2026-07-01", [
      { accountId: accounts.investment!, amount: "900" },
      { accountId: org.accounts.bank, amount: "-900" },
    ]);
    await post(f, child, "2026-07-01", [
      { accountId: org.accounts.bank, amount: "1000" },
      { accountId: accounts.equity!, amount: "-1000" },
    ]);
    await post(f, child, "2026-07-15", [
      { accountId: org.accounts.bank, amount: "100" },
      { accountId: org.accounts.revenue, amount: "-100" },
    ]);
    await db.execute(
      sql`insert into subsidiary_ownership_interests(id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,acquisition_date,acquisition_cost,fair_value_net_assets,acquisition_rate,nci_measurement,investment_account_id,equity_income_account_id,nci_equity_account_id,nci_income_account_id,goodwill_account_id,fair_value_adjustment_account_id) values(${interest},${org.orgId},${org.subsidiaryId},${child},'2026-07-01',80,'full','2026-07-01',900,1000,1,'proportionate',${accounts.investment!},${accounts.income!},${accounts.nci!},${accounts.nciIncome!},${accounts.goodwill!},${accounts.fairValue!})`,
    );
    await seedApprovalFlow(org.orgId, {
      subjectKind: "financial_change",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
      preventSelfApproval: false,
    });
    await work(f);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}
function input(
  f: Fixture,
  patch: Partial<LossOfControlInput> = {},
): LossOfControlInput {
  return {
    effectiveOn: "2026-07-20",
    reason: "Executed disposal of the controlling investment",
    idempotencyKey: randomUUID(),
    assessment:
      "Voting and contractual rights cease under the signed sale agreement",
    ociAssessment:
      "All group reserve accounts reviewed; no attributed OCI balance on this domestic fixture",
    eliminationSubsidiaryId: f.elimination,
    proceeds: "1050",
    proceedsAccountId: f.org.accounts.bank,
    parentInvestmentCarrying: "900",
    parentRetainedCarrying: "0",
    parentToGroupRate: "1",
    investmentTranslationAccountId: f.accounts.cta!,
    retainedFairValue: "0",
    retainedPercent: "0",
    retainedMethod: "none",
    retainedAccountId: f.accounts.retained!,
    gainLossAccountId: f.accounts.gain!,
    parentGainLossAccountId: f.accounts.gain!,
    equityIncomeAccountId: f.accounts.income!,
    distributionAccountId: null,
    distributionIncomeAccountId: null,
    rates: [{ subsidiaryId: f.child, rate: "1" }],
    additionalConsolidationLines: [],
    oci: [],
    ...patch,
  };
}
async function approve(f: Fixture, id: string) {
  await submitFinancialChange(f.org.orgId, id, f.actors.submitterId);
  const gate = (
    await db.execute<{ id: string }>(
      sql`select id from flow_gates where org_id=${f.org.orgId} and subject_id=${id} and status='pending'`,
    )
  ).rows[0]!;
  await decideGate({
    gateId: gate.id,
    userId: f.actors.approver1Id,
    decision: "approved",
  });
}
const deepest = (e: unknown): string =>
  e && typeof e === "object" && "cause" in e && e.cause
    ? deepest(e.cause)
    : String(e);
async function twoFamilyFixture(
  work: (
    f: Fixture & { childB: string; bAccount: string; aAccount: string },
  ) => Promise<void>,
) {
  return fixture(async (f) => {
    const childB = randomUUID(),
      bAccount = randomUUID(),
      aAccount = randomUUID();
    await db.execute(
      sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_elimination,is_active) values(${childB},${f.org.orgId},${f.org.subsidiaryId},'Second family','CAD','CA',false,true)`,
    );
    await db.execute(
      sql`insert into accounts(id,org_id,number,name,type,is_active,is_summary,eliminate,subsidiary_id) values(${bAccount},${f.org.orgId},'C-b','B family ledger','asset_current_other',true,false,false,${childB}),(${aAccount},${f.org.orgId},'C-a','A family ledger','asset_current_other',true,false,false,${f.child})`,
    );
    await work({ ...f, childB, bAccount, aAccount });
  });
}
test(
  "loss of control previews without posting, requires approval, derecognizes goodwill/NCI, and is idempotent",
  { skip: !DB },
  async () =>
    fixture(async (f) => {
      const before = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int n from journal_entries where org_id=${f.org.orgId}`,
        )
      ).rows[0]!.n;
      const args = input(f),
        id = await proposeLossOfControl(
          f.org.orgId,
          f.interest,
          f.actors.submitterId,
          args,
        );
      assert.equal(
        (
          await db.execute<{ n: number }>(
            sql`select count(*)::int n from journal_entries where org_id=${f.org.orgId}`,
          )
        ).rows[0]!.n,
        before,
        "rollback-only preview must retain no provisional journal",
      );
      const proposal = (
        await db.execute<{ before_state: Record<string, unknown> }>(sql`
          select before_state from financial_changes
           where org_id=${f.org.orgId} and id=${id}`)
      ).rows[0]!;
      assert.ok(
        proposal.before_state.preview,
        "the approval workpaper must retain its measured balances",
      );
      for (const key of ["generatedEntryIds", "sourceEntryIds"]) {
        assert.equal(
          Object.hasOwn(proposal.before_state, key),
          false,
          `${key} must not expose journals created inside the rolled-back preview`,
        );
      }
      await assert.rejects(
        applyLossOfControl(f.org.orgId, id, f.actors.submitterId),
        /independent approval/,
      );
      await approve(f, id);
      const result = await applyLossOfControl(
        f.org.orgId,
        id,
        f.actors.submitterId,
      );
      assert.equal(result.groupGain, "70.0000");
      assert.deepEqual(
        await applyLossOfControl(f.org.orgId, id, f.actors.submitterId),
        result,
      );
      assert.equal(
        await proposeLossOfControl(
          f.org.orgId,
          f.interest,
          f.actors.submitterId,
          args,
        ),
        id,
      );
      const loss = (
        await db.execute<{
          measurement: { preview: { netAssets: string; nci: string } };
        }>(
          sql`select measurement from consolidation_control_losses where org_id=${f.org.orgId} and change_id=${id}`,
        )
      ).rows[0]!;
      assert.equal(loss.measurement.preview.netAssets, "1200.0000");
      assert.equal(loss.measurement.preview.nci, "220.0000");
      const count = (result.entryIds as string[]).length;
      assert.ok(
        count >= 3,
        "real ownership phase and separate/group disposal entries must be retained",
      );
      const returnedIds = result.entryIds as string[];
      assert.equal(
        new Set(returnedIds).size,
        returnedIds.length,
        "committed journal links must be unique",
      );
      const committedEntries = (
        await db.execute<{ id: string; status: string }>(sql`
          select id,status from journal_entries where org_id=${f.org.orgId}
           and id in(select jsonb_array_elements_text(${JSON.stringify(returnedIds)}::jsonb)::uuid)`)
      ).rows;
      assert.deepEqual(
        committedEntries.map((entry) => entry.id).sort(),
        [...returnedIds].sort(),
        "every returned journal link must resolve in the same organization after application",
      );
      assert.ok(
        committedEntries.every(
          (entry) => entry.status === "posted" || entry.status === "reversed",
        ),
        "application must not return a draft or provisional journal",
      );
      const next = await runOwnershipConsolidation(
        f.org.orgId,
        f.org.periodId,
        f.actors.adminId,
      );
      assert.deepEqual(
        next.entryIds,
        [],
        "a later close must not reverse the ownership basis used by the disposal",
      );
      await assert.rejects(
        post(f, f.child, "2026-07-19", [
          { accountId: f.org.accounts.bank, amount: "1" },
          { accountId: f.org.accounts.revenue, amount: "-1" },
        ]),
        (e) => /approved disposal source/.test(deepest(e)),
      );
      await post(f, f.child, "2026-07-21", [
        { accountId: f.org.accounts.bank, amount: "20" },
        { accountId: f.org.accounts.revenue, amount: "-20" },
      ]);
    }),
);
test(
  "retained equity interest starts at fair value and a controlled correction preserves every original journal",
  { skip: !DB },
  async () =>
    fixture(async (f) => {
      const id = await proposeLossOfControl(
        f.org.orgId,
        f.interest,
        f.actors.submitterId,
        input(f, {
          proceeds: "900",
          parentRetainedCarrying: "225",
          retainedFairValue: "300",
          retainedPercent: "20",
          retainedMethod: "equity",
        }),
      );
      await approve(f, id);
      const result = await applyLossOfControl(
        f.org.orgId,
        id,
        f.actors.submitterId,
      );
      assert.equal(result.groupGain, "220.0000");
      const retained = (
        await db.execute<{
          effective_from: string;
          acquisition_cost: string;
          method: string;
        }>(
          sql`select effective_from::text,acquisition_cost::text,method from subsidiary_ownership_interests where org_id=${f.org.orgId} and id=${result.retainedInterestId as string}`,
        )
      ).rows[0]!;
      assert.deepEqual(retained, {
        effective_from: "2026-07-21",
        acquisition_cost: "300.0000",
        method: "equity",
      });
      const rev = await proposeLossOfControlReversal(
        f.org.orgId,
        id,
        f.actors.submitterId,
        "Sale rescinded before the retained-interest close",
        randomUUID(),
      );
      await approve(f, rev);
      const reversed = await applyLossOfControlReversal(
        f.org.orgId,
        rev,
        f.actors.submitterId,
      );
      assert.ok(
        (reversed.entryIds as string[]).length >=
          (result.entryIds as string[]).length,
      );
      const investment = (
        await db.execute<{ balance: string }>(
          sql`select coalesce(sum(l.amount),0)::text as balance from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id where l.org_id=${f.org.orgId} and l.account_id=${f.accounts.investment!} and e.status in('posted','reversed')`,
        )
      ).rows[0]!.balance;
      assert.equal(
        investment,
        "0.0000",
        "the restored parent investment has exactly one consolidation elimination",
      );
      const old = (
        await db.execute<{ status: string }>(
          sql`select status from journal_entries where org_id=${f.org.orgId} and id in(select jsonb_array_elements_text(${JSON.stringify(result.entryIds)}::jsonb)::uuid)`,
        )
      ).rows;
      assert.ok(old.length > 0 && old.every((e) => e.status === "reversed"));
      assert.equal(
        (
          await db.execute<{ effective_to: string | null }>(
            sql`select effective_to::text from subsidiary_ownership_interests where org_id=${f.org.orgId} and id=${f.interest}`,
          )
        ).rows[0]!.effective_to,
        null,
      );
      assert.deepEqual(
        await applyLossOfControlReversal(
          f.org.orgId,
          rev,
          f.actors.submitterId,
        ),
        reversed,
      );
    }),
);
test(
  "changed ledger evidence invalidates approval instead of applying an old disposal amount",
  { skip: !DB },
  async () =>
    fixture(async (f) => {
      const id = await proposeLossOfControl(
        f.org.orgId,
        f.interest,
        f.actors.submitterId,
        input(f),
      );
      await approve(f, id);
      await post(f, f.child, "2026-07-18", [
        { accountId: f.org.accounts.bank, amount: "50" },
        { accountId: f.org.accounts.revenue, amount: "-50" },
      ]);
      await assert.rejects(
        applyLossOfControl(f.org.orgId, id, f.actors.submitterId),
        /changed after this proposal/,
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from consolidation_control_losses where org_id=${f.org.orgId}`,
          )
        ).rows.length,
        0,
      );
    }),
);
test(
  "failed final storage write rolls back every disposal journal and ownership-window change",
  { skip: !DB },
  async () =>
    fixture(async (f) => {
      const id = await proposeLossOfControl(
        f.org.orgId,
        f.interest,
        f.actors.submitterId,
        input(f),
      );
      await approve(f, id);
      const name = `fail_control_${randomUUID().replaceAll("-", "")}`;
      await db.execute(
        sql.raw(
          `create function ${name}() returns trigger language plpgsql as $$ begin if NEW.org_id='${f.org.orgId}'::uuid then raise exception 'injected control loss storage failure'; end if; return NEW; end $$; create trigger ${name} before insert on consolidation_control_losses for each row execute function ${name}()`,
        ),
      );
      const before = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int n from journal_entries where org_id=${f.org.orgId}`,
        )
      ).rows[0]!.n;
      try {
        await assert.rejects(
          applyLossOfControl(f.org.orgId, id, f.actors.submitterId),
          (e) => /injected control loss/.test(deepest(e)),
        );
        assert.equal(
          (
            await db.execute<{ n: number }>(
              sql`select count(*)::int n from journal_entries where org_id=${f.org.orgId}`,
            )
          ).rows[0]!.n,
          before,
        );
        assert.equal(
          (
            await db.execute<{ effective_to: string | null }>(
              sql`select effective_to::text from subsidiary_ownership_interests where org_id=${f.org.orgId} and id=${f.interest}`,
            )
          ).rows[0]!.effective_to,
          null,
        );
      } finally {
        await db.execute(
          sql.raw(
            `drop trigger ${name} on consolidation_control_losses; drop function ${name}()`,
          ),
        );
      }
    }),
);

test(
  "L1: the proposal picker offers no other family's restricted accounts",
  { skip: !DB },
  async () =>
    twoFamilyFixture(async (f) => {
      const scope = new Set([f.org.subsidiaryId, f.child, f.elimination]);
      const data = await loadLossOfControlProposalData(
        db,
        f.org.orgId,
        f.interest,
        scope,
      );
      const ids = new Set(data.accounts.map((a) => a.id));
      assert.ok(
        !ids.has(f.bAccount),
        "an account restricted to family B must not appear in family A's picker",
      );
      assert.ok(
        !ids.has(f.aAccount),
        "an account restricted to family A's child cannot post the parent/elimination legs",
      );
      assert.ok(
        ids.has(f.accounts.investment!),
        "an unrestricted disposal account stays offerable",
      );
      const open = await loadLossOfControlProposalData(
        db,
        f.org.orgId,
        f.interest,
        null,
      );
      assert.ok(
        !new Set(open.accounts.map((a) => a.id)).has(f.bAccount),
        "inadmissible accounts stay out of the picker for unrestricted callers too",
      );
      await assert.rejects(
        loadLossOfControlProposalData(
          db,
          f.org.orgId,
          f.interest,
          new Set([f.childB]),
        ),
        (e) =>
          e instanceof LossOfControlProposalError &&
          (e as LossOfControlProposalError).status === 404,
      );
    }),
);
async function scopedActor(f: Fixture): Promise<string> {
  const userId = await createScratchUser(
    f.org.orgId,
    "A scoped controller",
    "a_scoped_controller",
  );
  const updated = await db.execute(
    sql`update app_roles set subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [f.org.subsidiaryId, f.child, f.elimination] })}::jsonb where org_id=${f.org.orgId} and key='a_scoped_controller' returning id`,
  );
  assert.equal(
    updated.rows.length,
    1,
    "the scoped role restriction must apply to exactly one role",
  );
  await db.execute(
    sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${f.org.orgId},${userId},'close.run','grant')`,
  );
  return userId;
}
async function bOnlyManualLine(f: Fixture) {
  // Like post(), but stamps the B-family memo at insert time: posted journal
  // lines are immutable, so the memo cannot be added afterwards.
  const entry = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin) values(${entry},${f.org.orgId},${f.org.bookId},${f.elimination},${entry},'2026-07-16',${f.org.periodId},'draft','manual')`,
    );
    for (const [i, l] of [
      { accountId: f.accounts.goodwill!, amount: "100" },
      { accountId: f.org.accounts.bank, amount: "-100" },
    ].entries())
      await tx.execute(
        sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,memo) values(${f.org.orgId},${entry},${i + 1},${l.accountId},${f.elimination},${l.amount},'CAD',${l.amount},1,'B family goodwill impairment')`,
      );
    await tx.execute(
      sql`update journal_entries set status='posted',posted_at=now() where org_id=${f.org.orgId} and id=${entry}`,
    );
  });
  return (
    await db.execute<{ id: string; amount: string }>(
      sql`select id,amount::text as amount from journal_lines where org_id=${f.org.orgId} and entry_id=${entry} and account_id=${f.accounts.goodwill!} order by line_number limit 1`,
    )
  ).rows[0]!;
}
test(
  "L2: a B-only manual elimination is hidden from family A's restricted picker",
  { skip: !DB },
  async () =>
    twoFamilyFixture(async (f) => {
      await bOnlyManualLine(f);
      const restricted = await loadLossOfControlProposalData(
        db,
        f.org.orgId,
        f.interest,
        new Set([f.org.subsidiaryId, f.child, f.elimination]),
      );
      assert.deepEqual(
        restricted.adjustmentLines,
        [],
        "lines without family lineage must not leak to a restricted caller",
      );
      const open = await loadLossOfControlProposalData(
        db,
        f.org.orgId,
        f.interest,
        null,
      );
      assert.ok(
        open.adjustmentLines.some(
          (l) => l.memo === "B family goodwill impairment",
        ),
        "unrestricted callers still see the unattributed manual lines",
      );
    }),
);
test(
  "L2: selecting a manual line requires an unrestricted proposer",
  { skip: !DB },
  async () =>
    twoFamilyFixture(async (f) => {
      const line = await bOnlyManualLine(f);
      await assert.rejects(
        proposeLossOfControl(
          f.org.orgId,
          f.interest,
          await scopedActor(f),
          input(f, {
            additionalConsolidationLines: [
              { lineId: line.id, amount: line.amount },
            ],
          }),
        ),
        (e) => /subsidiary-restricted proposal cannot select them/.test(deepest(e)),
      );
      assert.ok(
        await proposeLossOfControl(
          f.org.orgId,
          f.interest,
          f.actors.submitterId,
          input(f, {
            additionalConsolidationLines: [
              { lineId: line.id, amount: line.amount },
            ],
          }),
        ),
        "an unrestricted controller's explicit selection is the attributable provenance",
      );
    }),
);
async function secondInterest(
  f: Fixture & { childB: string },
): Promise<string> {
  const investB = randomUUID(),
    interestB = randomUUID();
  await db.execute(
    sql`insert into accounts(id,org_id,number,name,type,is_active,is_summary,eliminate) values(${investB},${f.org.orgId},'C-invest-b','B investment','asset_current_other',true,false,false)`,
  );
  const created = await db.execute(
    sql`insert into subsidiary_ownership_interests(id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,acquisition_date,investment_account_id,equity_income_account_id,nci_equity_account_id,nci_income_account_id,goodwill_account_id,fair_value_adjustment_account_id) values(${interestB},${f.org.orgId},${f.org.subsidiaryId},${f.childB},'2026-07-01',80,'full','2026-07-01',${investB},${f.accounts.income!},${f.accounts.nci!},${f.accounts.nciIncome!},${f.accounts.goodwill!},${f.accounts.fairValue!}) returning id`,
  );
  assert.equal(
    created.rows.length,
    1,
    "the second family's ownership interest must be recorded",
  );
  return interestB;
}
test(
  "L3: one elimination line cannot be attributed twice across families",
  { skip: !DB },
  async () =>
    twoFamilyFixture(async (f) => {
      const line = await bOnlyManualLine(f);
      const interestB = await secondInterest(f);
      const idA = await proposeLossOfControl(
        f.org.orgId,
        f.interest,
        f.actors.submitterId,
        input(f, {
          additionalConsolidationLines: [
            { lineId: line.id, amount: line.amount },
          ],
        }),
      );
      await approve(f, idA);
      await applyLossOfControl(f.org.orgId, idA, f.actors.submitterId);
      await assert.rejects(
        proposeLossOfControl(
          f.org.orgId,
          interestB,
          f.actors.submitterId,
          input(f, {
            parentInvestmentCarrying: "0",
            rates: [{ subsidiaryId: f.childB, rate: "1" }],
            additionalConsolidationLines: [
              { lineId: line.id, amount: line.amount },
            ],
          }),
        ),
        (e) => /already attributes .* to other disposals/.test(deepest(e)),
      );
    }),
);
test(
  "L1: a proposal using another family's account refuses by name",
  { skip: !DB },
  async () =>
    twoFamilyFixture(async (f) => {
      await assert.rejects(
        proposeLossOfControl(
          f.org.orgId,
          f.interest,
          f.actors.submitterId,
          input(f, { proceedsAccountId: f.bAccount }),
        ),
        (e) =>
          /account "B family ledger" is restricted to "Second family"/.test(
            deepest(e),
          ),
      );
    }),
);
test(
  "generic correcting journals remain automatic source evidence, never manual disposal inputs",
  { skip: !DB },
  async () =>
    fixture(async (f) => {
      const initial = await runOwnershipConsolidation(
        f.org.orgId,
        f.org.periodId,
        f.actors.adminId,
      );
      assert.ok(
        initial.entryIds.length > 0,
        "fixture must create a real ownership consolidation generation",
      );
      const original = initial.entryIds[0]!;
      const originalLines = (
        await db.execute<{ account_id: string; amount: string }>(
          sql`select account_id,(-amount)::text as amount from journal_lines where org_id=${f.org.orgId} and entry_id=${original} order by line_number`,
        )
      ).rows;
      const correction = await post(
        f,
        f.elimination,
        "2026-07-31",
        originalLines.map((l) => ({
          accountId: l.account_id,
          amount: l.amount,
        })),
        original,
      );
      const history = (
        await db.execute<{ id: string }>(
          sql`${consolidationHistory(f.org.orgId)} select id from history where id in(${original},${correction})`,
        )
      ).rows;
      assert.deepEqual(
        history.map((r) => r.id).sort(),
        [original, correction].sort(),
        "a correcting journal occurs once in the automatic lineage",
      );
      const correctingLine = (
        await db.execute<{ id: string; amount: string }>(
          sql`select id,amount::text from journal_lines where org_id=${f.org.orgId} and entry_id=${correction} order by line_number limit 1`,
        )
      ).rows[0]!;
      await assert.rejects(
        proposeLossOfControl(
          f.org.orgId,
          f.interest,
          f.actors.submitterId,
          input(f, {
            effectiveOn: "2026-07-31",
            additionalConsolidationLines: [
              { lineId: correctingLine.id, amount: correctingLine.amount },
            ],
          }),
        ),
        /already included automatically/,
      );
    }),
);
