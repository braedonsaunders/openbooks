import { decideGate } from "../flows/gates.ts";
import { before as initializeNativeComposition } from "node:test";
initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg, withBypassContext } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  grantScratchPermissions,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { createDocument } from "../ledger/document-write.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { controlRecognition } from "./recognition-controls.ts";
import { previewRevenueRecognition } from "./recognition-preview.ts";
import { runRevenueRecognition } from "./recognition-run.ts";
import {
  approveRebateAgreement,
  generateRebateClaim,
  approveRebateClaim,
  settleRebatePayment,
  reverseRebatePayment,
  accrueRebatesForDocument,
} from "./rebates.ts";
import { createRebateSettlement } from "../composition/rebate-settlement.ts";
import { generateAccountingPeriods } from "../close/calendar.ts";
import { neg } from "../money/money.ts";

const enabled = Boolean(process.env.OPENBOOKS_DB_URL);
async function commercialActors(org: ScratchOrg) {
  return withBypassContext(async () => {
    const actors = await seedFlowActors(org.orgId);
    await grantScratchPermissions(org.orgId, actors.adminId, [
      "ar.create",
      "ar.post",
      "ap.create",
      "ap.post",
    ]);
    await grantScratchPermissions(org.orgId, actors.submitterId, ["ar.post", "ap.post"]);
    await db.execute(
      sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true,"revenueRecognition":true}'::jsonb) where id=${org.orgId}`,
    );
    await db.execute(
      sql`insert into customer_roles(org_id,party_id,ar_account_id,is_active,created_by) values(${org.orgId},${org.customerId},${org.accounts.ar},true,${actors.adminId})`,
    );
    await db.execute(
      sql`insert into vendor_roles(org_id,party_id,ap_account_id,is_active,created_by) values(${org.orgId},${org.vendorId},${org.accounts.ap},true,${actors.adminId})`,
    );
    const calendar = (
      await db.execute<{ id: string }>(
        sql`select fiscal_calendar_id as id from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`,
        "objects",
      )
    )[0]!.id;
    await generateAccountingPeriods(org.orgId, calendar, 2026, actors.adminId);
    await generateAccountingPeriods(org.orgId, calendar, 2027, actors.adminId);
    return actors;
  });
}
async function invoice(org: ScratchOrg, actorId: string, amount: string, itemId?: string) {
  const document = await withOrg(org.orgId, () =>
    createDocument({
      orgId: org.orgId,
      userId: actorId,
      key: randomUUID(),
      kind: "customer_invoice",
      subsidiaryId: org.subsidiaryId,
      requestBody: { amount, ...(itemId ? { itemId } : {}) },
      body: {
        partyId: org.customerId,
        documentDate: org.date,
        currency: "CAD",
        lines: [
          {
            accountId: org.accounts.revenue,
            itemId,
            quantity: "1",
            unitPrice: amount,
            amount,
            description: "Commercial service",
          },
        ],
      },
    }),
  );
  await withBypassContext(() =>
    db.execute(
      sql`update documents set status='approved' where org_id=${org.orgId} and id=${document.id}`,
    ),
  );
  await withOrg(org.orgId, () =>
    postDocument(
      document.id,
      { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
      { deferEffects: true, suppressAutomation: true, audit: { actorId, source: "api" } },
    ),
  );
  return document.id;
}
async function seedAgreement(
  org: ScratchOrg,
  creator: string,
  code: string,
  tiers = [
    { threshold: "0", rate: "5" },
    { threshold: "1000", rate: "10" },
  ],
  stacking = "best",
) {
  const id = randomUUID();
  await withBypassContext(() =>
    db.execute(
      sql`update orgs set settings=jsonb_set(settings,'{features,rebateManagement}','true'::jsonb,true) where id=${org.orgId}`,
    ),
  );
  await withBypassContext(() =>
    db.execute(sql`insert into rebate_agreements(id,org_id,code,name,subsidiary_id,side,activity,party_id,currency,effective_from,effective_to,method,tier_basis,tiers,stacking,selection_group,accrual_account_id,offset_account_id,fx_account_id,tax_treatment,reason,created_by,updated_by)
  values(${id},${org.orgId},${code},'Volume service rebate',${org.subsidiaryId},'customer','sale',${org.customerId},'CAD',${org.date},${org.date},'percent','amount',${JSON.stringify(tiers)}::jsonb,${stacking},'standard',${org.accounts.deferred},${org.accounts.revenue},${org.accounts.fxGainLoss},'outside_scope','Reviewed commercial agreement',${creator},${creator})`),
  );
  return id;
}
async function earned(orgId: string, agreementId: string) {
  return (
    await withOrg(orgId, () =>
      db.execute<{ amount: string }>(
        sql`select coalesce(sum(amount),0)::text as amount from rebate_accruals where org_id=${orgId} and agreement_id=${agreementId}`,
        "objects",
      ),
    )
  )[0]!.amount;
}

test(
  "hold/release requires live authority and revision, skips journals, and resumes the unchanged plan",
  { skip: !enabled },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await commercialActors(org);
      const documentId = await invoice(org, actors.adminId, "1200", org.items.service);
      const obligation = (
        await withOrg(org.orgId, () =>
          db.execute<{ id: string }>(
            sql`select o.id from performance_obligations o join document_lines l on l.org_id=o.org_id and l.id=o.document_line_id where o.org_id=${org.orgId} and l.document_id=${documentId}`,
            "objects",
          ),
        )
      )[0]!;
      const end = (
        await withOrg(org.orgId, () =>
          db.execute<{ ends_on: string }>(
            sql`select ends_on::text from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`,
            "objects",
          ),
        )
      )[0]!.ends_on;
      await assert.rejects(() =>
        withOrg(org.orgId, () =>
          controlRecognition(org.orgId, actors.outsiderId, obligation.id, {
            action: "hold",
            expectedRevision: 1,
            reason: "Awaiting delivery acceptance",
          }),
        ),
      );
      await withOrg(org.orgId, () =>
        controlRecognition(org.orgId, actors.adminId, obligation.id, {
          action: "hold",
          expectedRevision: 1,
          reason: "Awaiting delivery acceptance",
        }),
      );
      const preview = await withOrg(org.orgId, () =>
        previewRevenueRecognition(org.orgId, { asOfDate: end, obligationId: obligation.id }),
      );
      assert(preview.rows.length > 0);
      assert(preview.rows.every((r) => r.skipReason === "operator_hold"));
      const held = await withOrg(org.orgId, () =>
        runRevenueRecognition(org.orgId, end, actors.adminId, obligation.id),
      );
      assert.equal(held.posted, 0);
      await assert.rejects(
        () =>
          withOrg(org.orgId, () =>
            controlRecognition(org.orgId, actors.adminId, obligation.id, {
              action: "release",
              expectedRevision: 1,
              reason: "Acceptance confirmed by customer",
            }),
          ),
        /changed/,
      );
      await withOrg(org.orgId, () =>
        controlRecognition(org.orgId, actors.adminId, obligation.id, {
          action: "release",
          expectedRevision: 2,
          reason: "Acceptance confirmed by customer",
        }),
      );
      assert(
        (
          await withOrg(org.orgId, () =>
            runRevenueRecognition(org.orgId, end, actors.adminId, obligation.id),
          )
        ).posted > 0,
      );
      assert.equal(
        (
          await withOrg(org.orgId, () =>
            runRevenueRecognition(org.orgId, end, actors.adminId, obligation.id),
          )
        ).posted,
        0,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "retrospective tiers append balanced catch-up facts and claims follow tenant Flow approval, replay and reversal",
  { skip: !enabled },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await commercialActors(org);
      const agreementId = await seedAgreement(org, actors.submitterId, "VOLUME");
      await approveRebateAgreement(
        org.orgId,
        actors.submitterId,
        agreementId,
        "Reviewed commercial liability",
      );
      const approved = (
        await withOrg(org.orgId, () =>
          db.execute<{ approved_by: string }>(
            sql`select approved_by from rebate_agreements where org_id=${org.orgId} and id=${agreementId} and status='approved'`,
            "objects",
          ),
        )
      )[0];
      assert.equal(
        approved?.approved_by,
        actors.submitterId,
        "the tenant’s zero-gate policy permits the maker to submit and release the agreement",
      );
      const first = await invoice(org, actors.adminId, "350");
      assert.equal(await earned(org.orgId, agreementId), "17.5000");
      const original = (
        await withOrg(org.orgId, () =>
          db.execute<{ id: string; amount: string }>(
            sql`select id,amount::text from rebate_accruals where org_id=${org.orgId} and agreement_id=${agreementId}`,
            "objects",
          ),
        )
      )[0]!;
      await invoice(org, actors.adminId, "650");
      assert.equal(await earned(org.orgId, agreementId), "100.0000");
      assert.equal(
        (
          await withOrg(org.orgId, () =>
            db.execute<{ amount: string }>(
              sql`select amount::text from rebate_accruals where org_id=${org.orgId} and id=${original.id}`,
              "objects",
            ),
          )
        )[0]!.amount,
        original.amount,
      );
      await accrueRebatesForDocument(org.orgId, first, actors.adminId);
      assert.equal(await earned(org.orgId, agreementId), "100.0000");
      const claim = await generateRebateClaim(
        org.orgId,
        actors.submitterId,
        agreementId,
        org.customerId,
        org.date,
        "Claim period reconciled",
      );
      await seedApprovalFlow(org.orgId, {
        subjectKind: "customer_rebate_claim",
        mode: "all",
        preventSelfApproval: true,
        assignees: [
          { type: "user", userId: actors.submitterId },
          { type: "user", userId: actors.adminId },
        ],
      });
      const submitted = await approveRebateClaim(
        org.orgId,
        actors.submitterId,
        claim.id,
        "Claim reconciled for settlement",
      );
      assert.ok("pendingApproval" in submitted && submitted.pendingApproval);
      const gates = await withOrg(org.orgId, () =>
        db.execute<{ id: string; assignee_user_id: string }>(
          sql`select id,assignee_user_id from flow_gates
    where org_id=${org.orgId} and subject_id=${claim.id} and status='pending'`,
          "objects",
        ),
      );
      assert.deepEqual(
        gates.map((gate) => gate.assignee_user_id),
        [actors.adminId],
        "tenant policy excludes the claim maker",
      );
      await decideGate({
        gateId: gates[0]!.id,
        decision: "approved",
        userId: actors.adminId,
        allowedSubsidiaryIds: null,
        comment: "Independent claim reconciliation",
      });
      const input = {
        postingDate: org.date,
        bankAccountId: org.accounts.bank,
        fxRate: "1",
        reason: "Paid contractual earned rebate",
      };
      const settlement = await settleRebatePayment(org.orgId, actors.adminId, claim.id, input);
      assert.equal(
        (await settleRebatePayment(org.orgId, actors.adminId, claim.id, input)).entryId,
        settlement.entryId,
      );
      await assert.rejects(
        () =>
          settleRebatePayment(org.orgId, actors.adminId, claim.id, {
            ...input,
            reason: "Different payment request image",
          }),
        /different payment/,
      );
      const imbalance = (
        await withOrg(org.orgId, () =>
          db.execute<{ amount: string }>(
            sql`select sum(amount)::text as amount from journal_lines where org_id=${org.orgId} and entry_id=${settlement.entryId}`,
            "objects",
          ),
        )
      )[0]!.amount;
      assert.equal(imbalance, "0.0000");
      const reversed = await reverseRebatePayment(
        org.orgId,
        actors.adminId,
        claim.id,
        org.date,
        "Bank settlement reversed for correction",
      );
      const mirrored = await withOrg(org.orgId, () =>
        db.execute<{
          amount: string;
          txn_amount: string;
          currency: string;
          fx_rate: string;
          account_id: string;
          line_number: number;
          entry_id: string;
        }>(
          sql`select amount::text,txn_amount::text,currency,fx_rate::text,account_id,line_number,entry_id from journal_lines where org_id=${org.orgId} and entry_id in (${settlement.entryId},${reversed.entryId}) order by entry_id,line_number`,
          "objects",
        ),
      );
      const originalLines = mirrored.filter((line) => line.entry_id === settlement.entryId);
      assert.deepEqual(
        mirrored
          .filter((line) => line.entry_id === reversed.entryId)
          .map(({ entry_id, ...line }) => line),
        originalLines.map(({ entry_id, ...line }) => ({
          ...line,
          amount: neg(line.amount),
          txn_amount: neg(line.txn_amount),
        })),
      );
      assert.equal(
        (
          await withOrg(org.orgId, () =>
            db.execute<{ status: string }>(
              sql`select status from rebate_claims where org_id=${org.orgId} and id=${claim.id}`,
              "objects",
            ),
          )
        )[0]!.status,
        "approved",
      );
      await assert.rejects(
        () =>
          generateRebateClaim(
            org.orgId,
            actors.adminId,
            agreementId,
            org.customerId,
            org.date,
            "Duplicate earned claim refusal",
          ),
        /No unclaimed/,
      );
      const resettled = await settleRebatePayment(org.orgId, actors.adminId, claim.id, input);
      assert.notEqual(
        resettled.entryId,
        settlement.entryId,
        "a reversed claim receives a fresh settlement journal",
      );
      assert.equal(
        (
          await withOrg(org.orgId, () =>
            db.execute<{ status: string }>(
              sql`select status from journal_entries where org_id=${org.orgId} and id=${resettled.entryId}`,
              "objects",
            ),
          )
        )[0]!.status,
        "posted",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "native credit settlement links the approved claim to the posted credit once",
  { skip: !enabled },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await commercialActors(org);
      const agreementId = await seedAgreement(org, actors.submitterId, "CREDIT", [
        { threshold: "0", rate: "10" },
      ]);
      await approveRebateAgreement(
        org.orgId,
        actors.adminId,
        agreementId,
        "Approved credit settlement terms",
      );
      await invoice(org, actors.adminId, "100");
      const claim = await generateRebateClaim(
        org.orgId,
        actors.submitterId,
        agreementId,
        org.customerId,
        org.date,
        "Reconciled earned credit claim",
      );
      await approveRebateClaim(
        org.orgId,
        actors.adminId,
        claim.id,
        "Approved settlement to customer",
      );
      const document = await createRebateSettlement(org.orgId, actors.adminId, claim.id, org.date);
      assert.equal(
        (await createRebateSettlement(org.orgId, actors.adminId, claim.id, org.date)).documentId,
        document.documentId,
      );
      await withBypassContext(() =>
        db.execute(
          sql`update documents set status='approved' where org_id=${org.orgId} and id=${document.documentId}`,
        ),
      );
      const entryId = await withOrg(org.orgId, () =>
        postDocument(
          document.documentId,
          { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
          {
            deferEffects: true,
            suppressAutomation: true,
            audit: { actorId: actors.adminId, source: "api" },
          },
        ),
      );
      const row = (
        await withOrg(org.orgId, () =>
          db.execute<{ status: string; settlement_entry_id: string }>(
            sql`select status,settlement_entry_id from rebate_claims where org_id=${org.orgId} and id=${claim.id}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(row.status, "settled");
      assert.equal(row.settlement_entry_id, entryId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "taxable rebate settlement refuses a posted document after its agreement tax code is removed",
  { skip: !enabled },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await commercialActors(org),
        taxCodeId = randomUUID(),
        agreementId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,rebateManagement}','true'::jsonb,true) where id=${org.orgId}`,
        );
        await db.execute(sql`insert into tax_codes(id,org_id,code,name,applies_to,calculation_type,collected_account_id,paid_account_id,is_active)
    values(${taxCodeId},${org.orgId},'REBATE-TAX','Rebate settlement tax','both','standard',${org.accounts.taxOutput},${org.accounts.taxInput},true)`);
        await db.execute(
          sql`insert into tax_rates(org_id,tax_code_id,rate_percent,effective_from) values(${org.orgId},${taxCodeId},'13',${org.date})`,
        );
        await db.execute(sql`insert into rebate_agreements(id,org_id,code,name,subsidiary_id,side,activity,party_id,currency,effective_from,effective_to,method,tier_basis,tiers,stacking,selection_group,accrual_account_id,offset_account_id,fx_account_id,tax_treatment,settlement_tax_code_id,reason,created_by,updated_by)
    values(${agreementId},${org.orgId},'TAXABLE','Taxable customer rebate',${org.subsidiaryId},'customer','sale',${org.customerId},'CAD',${org.date},${org.date},'percent','amount','[{"threshold":"0","rate":"10"}]'::jsonb,'best','taxable-rebate',${org.accounts.deferred},${org.accounts.revenue},${org.accounts.fxGainLoss},'taxable',${taxCodeId},'Reviewed taxable commercial agreement',${actors.submitterId},${actors.submitterId})`);
      });
      await approveRebateAgreement(
        org.orgId,
        actors.adminId,
        agreementId,
        "Approved taxable rebate agreement",
      );
      await invoice(org, actors.adminId, "100");
      const claim = await generateRebateClaim(
        org.orgId,
        actors.submitterId,
        agreementId,
        org.customerId,
        org.date,
        "Reconciled taxable rebate claim",
      );
      await approveRebateClaim(org.orgId, actors.adminId, claim.id, "Approved taxable settlement");
      const document = await createRebateSettlement(org.orgId, actors.adminId, claim.id, org.date);
      await withBypassContext(async () => {
        await db.execute(sql`update document_lines set tax_code_id=null,tax_amount=0,tax_overridden=false
    where org_id=${org.orgId} and document_id=${document.documentId}`);
        await db.execute(
          sql`update documents set status='approved' where org_id=${org.orgId} and id=${document.documentId}`,
        );
      });
      await assert.rejects(
        () =>
          withOrg(org.orgId, () =>
            postDocument(
              document.documentId,
              { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
              {
                deferEffects: true,
                suppressAutomation: true,
                audit: { actorId: actors.adminId, source: "api" },
              },
            ),
          ),
        /agreement tax treatment/i,
        "a taxable settlement cannot post after its required tax code is removed",
      );
      const claimStatus = (
        await withOrg(org.orgId, () =>
          db.execute<{ status: string }>(
            sql`select status from rebate_claims where org_id=${org.orgId} and id=${claim.id}`,
            "objects",
          ),
        )
      )[0]!.status;
      assert.equal(
        claimStatus,
        "document_pending",
        "the failed posting leaves the claim available for correction",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "software residuals defer every bundle element until documented delivery and preserve exact VSOE evidence",
  { skip: !enabled },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await commercialActors(org),
        software = randomUUID(),
        observable = randomUUID(),
        fairValueId = randomUUID();
      await withBypassContext(async () => {
        for (const [id, code, allocation] of [
          [software, "SOFTWARE", "software"],
          [observable, "SUPPORT", "normal"],
        ])
          await db.execute(
            sql`insert into items(id,org_id,code,name,kind,revenue_allocation,recognition_rule_id,income_account_id,deferred_account_id) values(${id},${org.orgId},${code},${code},'service',${allocation},${org.recognitionRuleId},${org.accounts.revenue},${org.accounts.deferred})`,
          );
        await db.execute(
          sql`insert into fair_value_prices(id,org_id,item_id,currency,unit_price,calculation_method,formula_percent,list_price,effective_from,effective_to,created_by,updated_by) values(${fairValueId},${org.orgId},${observable},'CAD','0','percent_of_list','40','200',${org.date},${org.date},${actors.adminId},${actors.adminId})`,
        );
      });
      const document = await withOrg(org.orgId, () =>
        createDocument({
          orgId: org.orgId,
          userId: actors.adminId,
          key: randomUUID(),
          kind: "customer_invoice",
          subsidiaryId: org.subsidiaryId,
          requestBody: { software, observable },
          body: {
            partyId: org.customerId,
            documentDate: org.date,
            currency: "CAD",
            lines: [
              {
                accountId: org.accounts.revenue,
                itemId: software,
                amount: "150",
                quantity: "1",
                unitPrice: "150",
                description: "Software license",
              },
              {
                accountId: org.accounts.revenue,
                itemId: observable,
                amount: "50",
                quantity: "1",
                unitPrice: "50",
                description: "Support",
              },
            ],
          },
        }),
      );
      await withBypassContext(() =>
        db.execute(
          sql`update documents set status='approved' where org_id=${org.orgId} and id=${document.id}`,
        ),
      );
      await withOrg(org.orgId, () =>
        postDocument(
          document.id,
          { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
          {
            deferEffects: true,
            suppressAutomation: true,
            audit: { actorId: actors.adminId, source: "api" },
          },
        ),
      );
      const obligations = await withOrg(org.orgId, () =>
        db.execute<{
          id: string;
          item_id: string;
          allocated_price: string;
          allocation_basis: { fairValuePriceId: string | null };
        }>(
          sql`select id,item_id,allocated_price::text,allocation_basis from performance_obligations where org_id=${org.orgId} and delivery_bundle_document_id=${document.id} order by item_id`,
          "objects",
        ),
      );
      assert.equal(obligations.length, 2);
      assert.equal(obligations.find((o) => o.item_id === software)!.allocated_price, "120.0000");
      assert.equal(obligations.find((o) => o.item_id === observable)!.allocated_price, "80.0000");
      assert.equal(
        obligations.find((o) => o.item_id === observable)!.allocation_basis.fairValuePriceId,
        fairValueId,
      );
      const end = (
        await withOrg(org.orgId, () =>
          db.execute<{ ends_on: string }>(
            sql`select ends_on::text from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`,
            "objects",
          ),
        )
      )[0]!.ends_on;
      const pending = await withOrg(org.orgId, () =>
        previewRevenueRecognition(org.orgId, { asOfDate: end }),
      );
      assert(pending.rows.length > 0);
      assert(pending.rows.every((r) => r.skipReason === "delivery_pending"));
      await controlRecognition(org.orgId, actors.adminId, obligations[0]!.id, {
        action: "deliver",
        effectiveOn: org.date,
        evidence: "Customer signed delivery acceptance",
        reason: "Reviewed customer acceptance record",
        expectedRevision: 1,
      });
      assert.equal(
        (await withOrg(org.orgId, () => runRevenueRecognition(org.orgId, end, actors.adminId)))
          .posted,
        0,
      );
      await controlRecognition(org.orgId, actors.adminId, obligations[1]!.id, {
        action: "deliver",
        effectiveOn: org.date,
        evidence: "Support access and delivery confirmed",
        reason: "Reviewed support delivery evidence",
        expectedRevision: 1,
      });
      assert(
        (await withOrg(org.orgId, () => runRevenueRecognition(org.orgId, end, actors.adminId)))
          .posted > 0,
      );
      await assert.rejects(
        () =>
          withOrg(org.orgId, () =>
            db.execute(
              sql`update fair_value_prices set formula_percent='50' where org_id=${org.orgId} and id=${fairValueId}`,
            ),
          ),
        (error) => {
          let cause: unknown = error;
          for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
            if (/immutable|successor/.test(cause.message)) return true;
            cause = cause.cause;
          }
          return false;
        },
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "supplier-funded downstream margin rebates use posted stock cost and create the vendor receivable",
  { skip: !enabled },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await commercialActors(org),
        agreementId = randomUUID(),
        receivable = randomUUID();
      await withBypassContext(async () => {
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,rebateManagement}','true'::jsonb,true) where id=${org.orgId}`,
        );
        await db.execute(
          sql`insert into accounts(id,org_id,number,name,type,is_active,is_summary) values(${receivable},${org.orgId},'1380','Supplier rebate receivable','asset_current_other',true,false)`,
        );
        await db.execute(sql`insert into rebate_agreements(id,org_id,code,name,subsidiary_id,side,activity,party_id,item_id,currency,effective_from,effective_to,method,tier_basis,tiers,margin_percent,stacking,selection_group,accrual_account_id,offset_account_id,fx_account_id,tax_treatment,reason,created_by,updated_by)
    values(${agreementId},${org.orgId},'MARGIN','Supplier margin guarantee',${org.subsidiaryId},'vendor','downstream_sale',${org.vendorId},${org.items.fifo},'CAD',${org.date},${org.date},'guaranteed_margin','amount','[]'::jsonb,'30','stack','supplier-margin',${receivable},${org.accounts.cogs},${org.accounts.fxGainLoss},'outside_scope','Supplier guarantees the downstream margin',${actors.submitterId},${actors.submitterId})`);
      });
      await approveRebateAgreement(
        org.orgId,
        actors.adminId,
        agreementId,
        "Approved supplier-funded margin agreement",
      );
      for (const [kind, partyId, amount, accountId] of [
        ["vendor_bill", org.vendorId, "160", org.accounts.invAsset],
        ["customer_invoice", org.customerId, "200", org.accounts.revenue],
      ]) {
        const document = await withOrg(org.orgId, () =>
          createDocument({
            orgId: org.orgId,
            userId: actors.adminId,
            key: randomUUID(),
            kind: kind!,
            subsidiaryId: org.subsidiaryId,
            requestBody: { kind, amount },
            body: {
              partyId,
              documentDate: org.date,
              currency: "CAD",
              lines: [
                {
                  accountId: accountId!,
                  itemId: org.items.fifo,
                  amount: amount!,
                  quantity: "1",
                  unitPrice: amount!,
                  stockLocationId: org.stockLocationId,
                  description: "Guaranteed margin stock",
                },
              ],
            },
          }),
        );
        await withBypassContext(() =>
          db.execute(
            sql`update documents set status='approved' where org_id=${org.orgId} and id=${document.id}`,
          ),
        );
        await withOrg(org.orgId, () =>
          postDocument(
            document.id,
            { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
            {
              deferEffects: true,
              suppressAutomation: true,
              audit: { actorId: actors.adminId, source: "api" },
            },
          ),
        );
      }
      assert.equal(await earned(org.orgId, agreementId), "20.0000");
      const leg = (
        await withOrg(org.orgId, () =>
          db.execute<{ amount: string; party_id: string }>(
            sql`select jl.amount::text,jl.party_id from journal_lines jl join rebate_accruals f on f.org_id=jl.org_id and f.journal_entry_id=jl.entry_id where f.org_id=${org.orgId} and f.agreement_id=${agreementId} and jl.account_id=${receivable}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(leg.amount, "20.0000");
      assert.equal(leg.party_id, org.vendorId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
