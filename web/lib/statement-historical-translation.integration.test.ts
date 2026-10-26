import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  db,
  withBypassContext,
  withOrgContext,
  withOrgTransaction,
} from "@openbooks/engine/platform/db";
import { createCabinetFile } from "@openbooks/engine/platform/file-ingestion";
import {
  createScratchOrg,
  dropScratchOrg,
  grantScratchPermissions,
  seedApprovalFlow,
  seedFlowActors,
  seedPostingAccount,
} from "@openbooks/engine/testing/fixtures";
import { submitFinancialChange } from "@openbooks/engine/flows/financial-changes-adapter";
import { decideGate } from "@openbooks/engine/testing/flows/gates";
import { postEntry } from "@openbooks/engine/testing/journal/post-entry";
import {
  applyHistoricalTranslationContribution,
  proposeHistoricalTranslationContribution,
  readHistoricalTranslationContribution,
  type HistoricalTranslationInstruction,
} from "@openbooks/engine/journal/historical-translation-evidence";
import {
  balanceSheetView,
  statementMatrix,
  type BalanceSheetLabels,
  type StatementSubsidiaryContext,
} from "./statement-matrix";
import { cashFlow } from "./reports/cash-flow";
import { cashFlowIndirect } from "./reports/cash-flow-indirect";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const labels: BalanceSheetLabels = {
  assets: "Assets",
  liabilities: "Liabilities",
  equity: "Equity",
  totalAssets: "Total assets",
  totalLiabilities: "Total liabilities",
  totalEquity: "Total equity",
  liabilitiesAndEquity: "Liabilities and equity",
  retainedEarningsPrior: "Prior earnings",
  currentYearEarnings: "Current earnings",
  translationAdjustment: "Translation adjustment",
  totalOf: (label) => `Total ${label}`,
};

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const setup = await withBypassContext(async () => {
    const actors = await seedFlowActors(org.orgId);
    const equity = await seedPostingAccount(org.orgId, "3100", "Share capital", "equity");
    // The global currency registry may be absent in a schema-only fixture.
    await db.execute(
      sql`insert into currencies(code,name,minor_units) values('USD','US Dollar',2) on conflict(code) do nothing`,
    );
    assert.equal(
      (
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb)
      where id=${org.orgId} returning id`,
          "objects",
        )
      ).length,
      1,
    );
    for (const actor of [actors.submitterId, actors.approver1Id])
      await grantScratchPermissions(org.orgId, actor, ["close.run", "documents.read"]);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "financial_change",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
      preventSelfApproval: true,
    });
    const folderId = randomUUID();
    assert.equal(
      (
        await db.execute(
          sql`insert into folders(id,org_id,name,is_private,owner_id)
      values(${folderId},${org.orgId},'Original capital documents',true,${actors.adminId}) returning id`,
          "objects",
        )
      ).length,
      1,
    );
    for (const actor of [actors.submitterId, actors.approver1Id])
      assert.equal(
        (
          await db.execute(
            sql`insert into resource_grants(org_id,resource_type,resource_id,principal_type,principal_id,access,created_by)
        values(${org.orgId},'folder',${folderId},'user',${actor},'viewer',${actors.adminId}) returning id`,
            "objects",
          )
        ).length,
        1,
      );
    return { actors, equity, folderId };
  });
  const bytes = Buffer.from(
    "Original dated share contribution schedule and its exact documentary measurement currency.",
  );
  const file = await withOrgTransaction(org.orgId, () =>
    createCabinetFile({
      orgId: org.orgId,
      folderId: setup.folderId,
      filename: "capital.txt",
      contentType: "text/plain",
      bytes,
      createdBy: setup.actors.submitterId,
      auditActorId: setup.actors.submitterId,
      executor: db,
    }),
  );
  assert.ok(file.currentVersionId);
  const source = {
    fileId: file.id,
    versionId: file.currentVersionId,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
  };
  const authority = { orgId: org.orgId, actorId: setup.actors.submitterId };
  const subsidiary: StatementSubsidiaryContext = {
    ids: [org.subsidiaryId],
    presentationCurrency: "USD",
    rates: [
      {
        subsidiaryId: org.subsidiaryId,
        currency: "CAD",
        periodFrom: "2026-07-01",
        periodTo: "2026-07-31",
        currentRate: "1.3",
        averageRate: "1.25",
        historicalRate: "9",
      },
    ],
  };
  async function post(
    amount: string,
    origin: "manual" | "book_opening" = "manual",
    reversesEntryId: string | null = null,
  ) {
    return withOrgTransaction(org.orgId, async () => {
      const posted = await postEntry(db, {
        ...authority,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        periodId: org.periodId,
        entryNumber: `CAPITAL-${randomUUID()}`,
        postingDate: org.date,
        currency: "CAD",
        origin,
        reversesEntryId,
        lines: [
          {
            accountId: setup.equity,
            subsidiaryId: org.subsidiaryId,
            amount,
            currency: "CAD",
            txnAmount: amount,
            fxRate: "1",
          },
          {
            accountId: org.accounts.bank,
            subsidiaryId: org.subsidiaryId,
            amount: amount.startsWith("-") ? amount.slice(1) : `-${amount}`,
            currency: "CAD",
            txnAmount: amount.startsWith("-") ? amount.slice(1) : `-${amount}`,
            fxRate: "1",
          },
        ],
      });
      const line = await db.execute<{ id: string }>(
        sql`select id from journal_lines where org_id=${org.orgId} and entry_id=${posted.entryId} and account_id=${setup.equity}`,
        "objects",
      );
      assert.equal(line.length, 1);
      return { entryId: posted.entryId, lineId: line[0]!.id };
    });
  }
  function instruction(
    sourceLineId: string,
    amount: string,
    rate: string,
  ): HistoricalTranslationInstruction {
    return {
      sourceLineId,
      measurementCurrency: "CAD",
      presentationCurrency: "USD",
      kind: "contribution",
      layers: [
        {
          amount,
          rate,
          historicalDate: org.date,
          provenance: "Original shareholder contribution schedule",
          source,
          originalLayerId: null,
        },
      ],
    };
  }
  async function apply(instruction: HistoricalTranslationInstruction) {
    const proposal = await proposeHistoricalTranslationContribution({
      ...authority,
      instruction,
      reason: "Retain the independently evidenced original contribution basis",
      idempotencyKey: randomUUID(),
    });
    await withOrgContext(org.orgId, async () => {
      await submitFinancialChange(org.orgId, proposal.changeId, authority.actorId);
      const gate = (
        await db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${proposal.changeId} and status='pending'`,
          "objects",
        )
      )[0];
      assert.ok(gate);
      await decideGate({ gateId: gate.id, decision: "approved", userId: setup.actors.approver1Id });
    });
    return applyHistoricalTranslationContribution({ ...authority, changeId: proposal.changeId });
  }
  async function matrix(context = subsidiary) {
    return withOrgTransaction(
      org.orgId,
      () =>
        statementMatrix({
          orgId: org.orgId,
          bookId: org.bookId,
          types: ["equity"],
          mode: "balance",
          period: { from: "2026-07-01", to: org.date },
          periodLabel: "July",
          subsidiary: context,
          showZero: true,
        }),
      { readOnly: true, isolationLevel: "REPEATABLE READ" },
    );
  }
  return { org, ...setup, authority, subsidiary, source, post, instruction, apply, matrix };
}

test(
  "statements use each immutable contribution and its correction and retain their basis after current currency changes",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await withBypassContext(async () => {
        assert.equal(
          (
            await db.execute(
              sql`insert into account_translation_policies(org_id,account_id,effective_from,general_rate_type,cash_flow_rate_type,reason)
        values(${f.org.orgId},${f.equity},'2026-01-01','historical','historical','Retain original contribution rates for capital cash movements') returning id`,
              "objects",
            )
          ).length,
          1,
        );
      });
      const first = await f.post("-100"),
        second = await f.post("-100");
      await assert.rejects(f.matrix(), /historical contribution basis|Historical translation/i);
      await f.apply(f.instruction(first.lineId, "-100", "1.2"));
      await assert.rejects(f.matrix(), /historical contribution basis|Historical translation/i);
      await f.apply(f.instruction(second.lineId, "-100", "1.4"));
      assert.deepEqual((await f.matrix()).rows.find((row) => row.id === f.equity)?.values, [
        "260.0000",
      ]);
      const original = await withOrgTransaction(f.org.orgId, () =>
        readHistoricalTranslationContribution(db, {
          orgId: f.org.orgId,
          sourceLineId: first.lineId,
          presentationCurrency: "USD",
        }),
      );
      assert.ok("layers" in original);
      const layer = original.layers[0]!;
      const correction = await f.post("50");
      await f.apply({
        ...f.instruction(correction.lineId, "50", layer.rate),
        kind: "correction",
        layers: [
          {
            amount: "50",
            rate: layer.rate,
            historicalDate: layer.historicalDate,
            provenance: layer.provenance,
            source: layer.source,
            originalLayerId: layer.id,
          },
        ],
      });
      assert.deepEqual((await f.matrix()).rows.find((row) => row.id === f.equity)?.values, [
        "200.0000",
      ]);
      const view = await withOrgTransaction(
        f.org.orgId,
        () =>
          balanceSheetView({ from: "2026-07-01", to: f.org.date }, "July", labels, {
            orgId: f.org.orgId,
            bookId: f.org.bookId,
            subsidiary: f.subsidiary,
          }),
        { readOnly: true, isolationLevel: "REPEATABLE READ" },
      );
      assert.deepEqual(view.lines.find((line) => line.label === labels.totalAssets)?.values, [
        "195.0000",
      ]);
      assert.deepEqual(
        view.lines.find((line) => line.label === labels.liabilitiesAndEquity)?.values,
        ["195.0000"],
      );
      assert.deepEqual(
        view.lines.find((line) => line.label === labels.translationAdjustment)?.values,
        ["-5.0000"],
      );
      const cash = await withOrgTransaction(
        f.org.orgId,
        async () => ({
          direct: await cashFlow(
            "2026-07-02",
            f.org.date,
            { subsidiaryIds: [f.org.subsidiaryId] },
            f.org.orgId,
            f.org.bookId,
            f.subsidiary,
          ),
          indirect: await cashFlowIndirect(
            "2026-07-02",
            f.org.date,
            { subsidiaryIds: [f.org.subsidiaryId] },
            f.org.orgId,
            f.org.bookId,
            f.subsidiary,
          ),
        }),
        { readOnly: true, isolationLevel: "REPEATABLE READ" },
      );
      assert.equal(
        cash.direct.sections.find((section) => section.section === "financing")?.subtotal,
        "200.0000",
      );
      assert.equal(cash.indirect.financingTotal, "200.0000");
      await withBypassContext(async () => {
        assert.equal(
          (
            await db.execute(
              sql`update subsidiaries set base_currency='USD' where org_id=${f.org.orgId} and id=${f.org.subsidiaryId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
      });
      const currentlyIdentity = { ...f.subsidiary, rates: [] };
      assert.deepEqual(
        (await f.matrix(currentlyIdentity)).rows.find((row) => row.id === f.equity)?.values,
        ["200.0000"],
      );
      const unassessed = await f.post("-1");
      await assert.rejects(
        f.matrix(currentlyIdentity),
        /historical contribution basis|Historical translation/i,
      );
      assert.ok(unassessed.lineId);
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "account columns round only after exact fourteen-place products from ordinary and opening certificates are summed",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 2; i++) {
        const source = await f.post("-0.0001");
        await f.apply(f.instruction(source.lineId, "-0.0001", "0.4"));
      }
      const opening = await f.post("-0.0002", "book_opening");
      const instruction = f.instruction(opening.lineId, "-0.0001", "0.4");
      await f.apply({
        ...instruction,
        kind: "opening",
        layers: [instruction.layers[0]!, { ...instruction.layers[0]! }],
      });
      const matrix = await f.matrix();
      assert.deepEqual(matrix.rows.find((row) => row.id === f.equity)?.values, ["0.0002"]);
      const other = await withBypassContext(() => createScratchOrg());
      try {
        await assert.rejects(
          withOrgTransaction(other.orgId, () =>
            readHistoricalTranslationContribution(db, {
              orgId: other.orgId,
              sourceLineId: opening.lineId,
              presentationCurrency: "USD",
            }),
          ),
          /not found/i,
        );
      } finally {
        await dropScratchOrg(other.orgId);
      }
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "same-currency identity requires a native approved documentary certificate",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const source = await f.post("-100");
      const identityContext = { ...f.subsidiary, presentationCurrency: "CAD", rates: [] };
      await assert.rejects(
        f.matrix(identityContext),
        /historical contribution basis|Historical translation/i,
      );
      await f.apply({ ...f.instruction(source.lineId, "-100", "1"), presentationCurrency: "CAD" });
      assert.deepEqual(
        (await f.matrix(identityContext)).rows.find((row) => row.id === f.equity)?.values,
        ["100.0000"],
      );
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "non-equity manual historical and equity average policies retain their own rate contracts",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await withBypassContext(async () => {
        assert.equal(
          (
            await db.execute(
              sql`insert into account_translation_policies(org_id,account_id,effective_from,general_rate_type,cash_flow_rate_type,reason)
        values(${f.org.orgId},${f.org.accounts.bank},'2026-01-01','historical','current','Explicit manual historical policy for this account'),
          (${f.org.orgId},${f.equity},'2026-01-01','average','average','Explicit average policy for this equity account') returning id`,
              "objects",
            )
          ).length,
          2,
        );
      });
      await f.post("-100");
      const matrix = await withOrgTransaction(
        f.org.orgId,
        () =>
          statementMatrix({
            orgId: f.org.orgId,
            bookId: f.org.bookId,
            types: ["asset_bank", "equity"],
            mode: "balance",
            period: { from: "2026-07-01", to: f.org.date },
            periodLabel: "July",
            subsidiary: f.subsidiary,
          }),
        { readOnly: true, isolationLevel: "REPEATABLE READ" },
      );
      assert.deepEqual(matrix.rows.find((row) => row.id === f.org.accounts.bank)?.values, [
        "900.0000",
      ]);
      assert.deepEqual(matrix.rows.find((row) => row.id === f.equity)?.values, ["125.0000"]);
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);
