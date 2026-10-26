import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { errorChainMatches } from "../testing/error-chain.ts";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { createCabinetFile } from "../platform/file-ingestion.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedApprovalFlow,
  seedFlowActors,
  seedPostingAccount,
} from "../testing/fixtures.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { markEntryReversed, postEntry } from "./post-entry.ts";
import {
  applyHistoricalTranslationContribution,
  proposeHistoricalTranslationContribution,
  readHistoricalTranslationContribution,
  readHistoricalTranslationAuthoringContext,
  sumHistoricalTranslationExactAmounts,
  type HistoricalTranslationInstruction,
} from "./historical-translation-evidence.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
async function fixture() {
  const org = await createScratchOrg();
  const setup = await withBypassContext(async () => {
    const actors = await seedFlowActors(org.orgId);
    const equity = await seedPostingAccount(org.orgId, "3100", "Share capital", "equity");
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
      values(${folderId},${org.orgId},'Capital contribution sources',true,${actors.adminId}) returning id`,
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
    "Dated source capital schedule: CAD measurement, USD presentation, independently evidenced historic layers.",
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
  const authority = { orgId: org.orgId, actorId: setup.actors.submitterId };
  const source = {
    fileId: file.id,
    versionId: file.currentVersionId,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
  };
  async function entry(
    amount: string,
    origin: "manual" | "opening" = "manual",
    reversesEntryId: string | null = null,
  ) {
    return withOrgTransaction(org.orgId, async () => {
      const posted = await postEntry(db, {
        orgId: org.orgId,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        periodId: org.periodId,
        entryNumber: `CAP-${randomUUID()}`,
        postingDate: org.date,
        currency: "CAD",
        origin,
        reversesEntryId,
        actorId: authority.actorId,
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
    lineId: string,
    amount: string,
    rate: string,
  ): HistoricalTranslationInstruction {
    return {
      sourceLineId: lineId,
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
  async function approve(changeId: string, verifyDeniedReviewer = false) {
    await withOrgContext(org.orgId, async () => {
      await submitFinancialChange(org.orgId, changeId, authority.actorId);
      const gate = (
        await db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${changeId} and status='pending'`,
          "objects",
        )
      )[0];
      assert.ok(gate);
      if (verifyDeniedReviewer) {
        assert.equal(
          (
            await withBypassContext(() =>
              db.execute(
                sql`delete from resource_grants where org_id=${org.orgId}
          and resource_type='folder' and resource_id=${setup.folderId} and principal_type='user'
          and principal_id=${setup.actors.approver1Id} returning id`,
                "objects",
              ),
            )
          ).length,
          1,
        );
        await assert.rejects(
          decideGate({ gateId: gate.id, decision: "approved", userId: setup.actors.approver1Id }),
          /Source file is unavailable/,
        );
        assert.equal(
          (
            await withBypassContext(() =>
              db.execute(
                sql`insert into resource_grants(org_id,resource_type,resource_id,principal_type,principal_id,access,created_by)
          values(${org.orgId},'folder',${setup.folderId},'user',${setup.actors.approver1Id},'viewer',${setup.actors.adminId}) returning id`,
                "objects",
              ),
            )
          ).length,
          1,
        );
      }
      await decideGate({ gateId: gate.id, decision: "approved", userId: setup.actors.approver1Id });
    });
  }
  async function propose(value: HistoricalTranslationInstruction) {
    return proposeHistoricalTranslationContribution({
      ...authority,
      instruction: value,
      reason: "Retain independently reviewed original capital translation evidence",
      idempotencyKey: randomUUID(),
    });
  }
  return { org, ...setup, authority, source, entry, instruction, approve, propose };
}

test(
  "approved exact contribution sources translate in a read-only snapshot and replay without adopting posted data",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const first = await f.entry("-100"),
        second = await f.entry("-100");
      const input = {
        ...f.authority,
        instruction: f.instruction(first.lineId, "-100", "1.20"),
        reason: "Retain independently reviewed original contribution rate",
        idempotencyKey: randomUUID(),
      };
      assert.equal(
        (
          await withBypassContext(() =>
            db.execute(
              sql`delete from resource_grants where org_id=${f.org.orgId}
      and resource_type='folder' and resource_id=${f.folderId} and principal_type='user' and principal_id=${f.authority.actorId} returning id`,
              "objects",
            ),
          )
        ).length,
        1,
      );
      await assert.rejects(
        proposeHistoricalTranslationContribution(input),
        /Source file is unavailable/,
      );
      assert.equal(
        (
          await withBypassContext(() =>
            db.execute(
              sql`insert into resource_grants(org_id,resource_type,resource_id,principal_type,principal_id,access,created_by)
      values(${f.org.orgId},'folder',${f.folderId},'user',${f.authority.actorId},'viewer',${f.actors.adminId}) returning id`,
              "objects",
            ),
          )
        ).length,
        1,
      );
      const proposed = await proposeHistoricalTranslationContribution(input);
      assert.deepEqual(await proposeHistoricalTranslationContribution(input), proposed);
      await assert.rejects(
        applyHistoricalTranslationContribution({ ...f.authority, changeId: proposed.changeId }),
        /approval|Flows/i,
      );
      await assert.rejects(
        withOrgTransaction(f.org.orgId, () =>
          readHistoricalTranslationContribution(db, {
            orgId: f.org.orgId,
            sourceLineId: first.lineId,
            presentationCurrency: "USD",
          }),
        ),
        /no approved historical contribution basis/,
      );
      await f.approve(proposed.changeId, true);
      // Approval alone cannot supply a basis before the explicit apply command.
      await assert.rejects(
        withOrgTransaction(f.org.orgId, () =>
          readHistoricalTranslationContribution(db, {
            orgId: f.org.orgId,
            sourceLineId: first.lineId,
            presentationCurrency: "USD",
          }),
        ),
        /no approved historical contribution basis/,
      );
      const applied = await applyHistoricalTranslationContribution({
        ...f.authority,
        changeId: proposed.changeId,
      });
      assert.deepEqual(
        await applyHistoricalTranslationContribution({
          ...f.authority,
          changeId: proposed.changeId,
        }),
        applied,
      );
      const next = await f.propose(f.instruction(second.lineId, "-100", "1.40"));
      await f.approve(next.changeId);
      await applyHistoricalTranslationContribution({ ...f.authority, changeId: next.changeId });
      const read = await withOrgTransaction(
        f.org.orgId,
        async () => {
          const a = await readHistoricalTranslationContribution(db, {
            orgId: f.org.orgId,
            sourceLineId: first.lineId,
            presentationCurrency: "USD",
          });
          const b = await readHistoricalTranslationContribution(db, {
            orgId: f.org.orgId,
            sourceLineId: second.lineId,
            presentationCurrency: "USD",
          });
          const identity = await readHistoricalTranslationContribution(db, {
            orgId: f.org.orgId,
            sourceLineId: first.lineId,
            presentationCurrency: "CAD",
          });
          return { a, b, identity };
        },
        { readOnly: true, isolationLevel: "REPEATABLE READ" },
      );
      assert.equal(read.a.translatedAmount, "-120.00000000000000");
      assert.equal(read.b.translatedAmount, "-140.00000000000000");
      assert.equal(read.identity.translatedAmount, "-100.0000");
      assert.ok("identity" in read.identity && read.identity.identity);
      const physical = await withOrgTransaction(f.org.orgId, () =>
        db.execute<{ amount: string }>(
          sql`select amount::text from journal_lines where org_id=${f.org.orgId} and id=${first.lineId}`,
          "objects",
        ),
      );
      assert.equal(physical[0]!.amount, "-100.0000");
      await assert.rejects(
        withOrgTransaction(f.org.orgId, () =>
          db.execute(
            sql`update historical_translation_layers set rate=1.9 where org_id=${f.org.orgId} and basis_id=${applied.basisId}`,
          ),
        ),
        (error) => errorChainMatches(error, /immutable/i),
      );
      await assert.rejects(
        withOrgTransaction(f.org.orgId, () =>
          db.execute(
            sql`delete from historical_translation_contributions where org_id=${f.org.orgId} and id=${applied.basisId}`,
          ),
        ),
        (error) => errorChainMatches(error, /immutable/i),
      );
      await assert.rejects(
        withOrgTransaction(f.org.orgId, () =>
          db.execute(sql`update file_versions set content_hash=${"b".repeat(64)}
      where file_id=${f.source.fileId} and id=${f.source.versionId}`),
        ),
        (error) => errorChainMatches(error, /immutable Cabinet version/),
      );
      await assert.rejects(
        withOrgTransaction(f.org.orgId, () =>
          db.execute(sql`delete from file_blobs where version_id=${f.source.versionId}`),
        ),
        (error) => errorChainMatches(error, /immutable Cabinet version/),
      );
      await assert.rejects(
        f.propose({
          ...f.instruction(first.lineId, "-100", "1.2"),
          measurementCurrency: "EUR",
          presentationCurrency: "GBP",
        }),
        /different measurement currency/,
      );
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "same-currency source identity is explicitly assessed and read through the authorized workspace",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const entry = await f.entry("-100");
      const instruction = {
        ...f.instruction(entry.lineId, "-100", "1"),
        presentationCurrency: "CAD",
      };
      const proposed = await f.propose(instruction);
      const pending = await readHistoricalTranslationAuthoringContext({
        ...f.authority,
        sourceLineId: entry.lineId,
      });
      assert.equal(pending.source.lineId, entry.lineId);
      assert.equal(pending.certificates.length, 0);
      assert.equal(pending.proposals[0]?.changeId, proposed.changeId);
      assert.ok(pending.currencies.includes("CAD"));
      await f.approve(proposed.changeId);
      const applied = await applyHistoricalTranslationContribution({
        ...f.authority,
        changeId: proposed.changeId,
      });
      const context = await readHistoricalTranslationAuthoringContext({
        ...f.authority,
        sourceLineId: entry.lineId,
      });
      assert.equal(context.certificates[0]?.basisId, applied.basisId);
      assert.equal(context.certificates[0]?.translatedAmount, "-100.0000");
      const read = await withOrgTransaction(f.org.orgId, async () => {
        await db.execute(sql`set transaction read only`);
        return readHistoricalTranslationContribution(db, {
          orgId: f.org.orgId,
          sourceLineId: entry.lineId,
          presentationCurrency: "CAD",
        });
      });
      assert.equal(read.identity, true);
      assert.equal(read.layers[0]?.rate, "1.0000000000");
      assert.equal(
        (
          await withBypassContext(() =>
            db.execute(
              sql`delete from resource_grants where org_id=${f.org.orgId}
      and resource_type='folder' and resource_id=${f.folderId} and principal_type='user' and principal_id=${f.authority.actorId} returning id`,
              "objects",
            ),
          )
        ).length,
        1,
      );
      await assert.rejects(
        readHistoricalTranslationAuthoringContext({ ...f.authority, sourceLineId: entry.lineId }),
        /Source file is unavailable/,
      );
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "unknown identity and tenant substitution refuse, and apply rolls back its complete evidence composition",
  { skip: !DB },
  async () => {
    const f = await fixture(),
      other = await createScratchOrg();
    try {
      const posted = await f.entry("-100");
      await assert.rejects(
        withOrgTransaction(f.org.orgId, () =>
          readHistoricalTranslationContribution(db, {
            orgId: f.org.orgId,
            sourceLineId: posted.lineId,
            presentationCurrency: "CAD",
            measurementCurrency: "CAD",
          }),
        ),
        /no approved historical contribution basis/,
      );
      await assert.rejects(
        proposeHistoricalTranslationContribution({
          ...f.authority,
          orgId: other.orgId,
          instruction: f.instruction(posted.lineId, "-100", "1.2"),
          reason: "Review an exact original source contribution",
          idempotencyKey: randomUUID(),
        }),
        /not found|Source file is unavailable/i,
      );
      const proposed = await f.propose(f.instruction(posted.lineId, "-100", "1.2"));
      await f.approve(proposed.changeId);
      const snapshot = await withOrgTransaction(f.org.orgId, () =>
        db.execute<{ n: number }>(
          sql`select count(*)::int as n from historical_translation_contributions where org_id=${f.org.orgId}`,
          "objects",
        ),
      );
      assert.equal(snapshot[0]!.n, 0);
      await assert.rejects(
        withOrgTransaction(f.org.orgId, async () => {
          await applyHistoricalTranslationContribution({
            ...f.authority,
            changeId: proposed.changeId,
          });
          throw new Error("Rollback the complete approved evidence transaction");
        }),
        /Rollback the complete/,
      );
      assert.equal(
        (
          await withOrgTransaction(f.org.orgId, () =>
            db.execute<{ n: number }>(
              sql`select count(*)::int as n from historical_translation_contributions where org_id=${f.org.orgId}`,
              "objects",
            ),
          )
        )[0]!.n,
        0,
      );
      const applied = await applyHistoricalTranslationContribution({
        ...f.authority,
        changeId: proposed.changeId,
      });
      assert.ok(applied.basisId);
    } finally {
      await dropScratchOrg(other.orgId);
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "inaccessible optional originals do not block authoring or expose their retained sources",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const privateFolderId = randomUUID();
      await withBypassContext(async () => {
        assert.equal(
          (
            await db.execute(
              sql`insert into folders(id,org_id,name,is_private,owner_id)
        values(${privateFolderId},${f.org.orgId},'Private capital sources',true,${f.actors.adminId}) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        for (const actor of [f.authority.actorId, f.actors.approver1Id])
          assert.equal(
            (
              await db.execute(
                sql`insert into resource_grants(org_id,resource_type,resource_id,principal_type,principal_id,access,created_by)
          values(${f.org.orgId},'folder',${privateFolderId},'user',${actor},'viewer',${f.actors.adminId}) returning id`,
                "objects",
              )
            ).length,
            1,
          );
      });
      const bytes = Buffer.from(
        "A separately protected original shareholder contribution schedule.",
      );
      const privateFile = await withOrgTransaction(f.org.orgId, () =>
        createCabinetFile({
          orgId: f.org.orgId,
          folderId: privateFolderId,
          filename: "private-capital.txt",
          contentType: "text/plain",
          bytes,
          createdBy: f.authority.actorId,
          auditActorId: f.authority.actorId,
          executor: db,
        }),
      );
      assert.ok(privateFile.currentVersionId);
      const privateSource = {
        fileId: privateFile.id,
        versionId: privateFile.currentVersionId,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
      };
      const protectedOriginal = await f.entry("-100");
      const privateInstruction = f.instruction(protectedOriginal.lineId, "-100", "1.2");
      privateInstruction.layers[0]!.source = privateSource;
      const protectedProposal = await f.propose(privateInstruction);
      await f.approve(protectedProposal.changeId);
      await applyHistoricalTranslationContribution({
        ...f.authority,
        changeId: protectedProposal.changeId,
      });
      const protectedCertificate = await withOrgTransaction(f.org.orgId, () =>
        readHistoricalTranslationContribution(db, {
          orgId: f.org.orgId,
          sourceLineId: protectedOriginal.lineId,
          presentationCurrency: "USD",
        }),
      );
      const visibleOriginal = await f.entry("-100");
      const visibleProposal = await f.propose(f.instruction(visibleOriginal.lineId, "-100", "1.2"));
      await f.approve(visibleProposal.changeId);
      await applyHistoricalTranslationContribution({
        ...f.authority,
        changeId: visibleProposal.changeId,
      });
      assert.equal(
        (
          await withBypassContext(() =>
            db.execute(
              sql`delete from resource_grants where org_id=${f.org.orgId}
      and resource_type='folder' and resource_id=${privateFolderId} and principal_type='user'
      and principal_id=${f.authority.actorId} returning id`,
              "objects",
            ),
          )
        ).length,
        1,
      );

      const newSource = await f.entry("100");
      const context = await readHistoricalTranslationAuthoringContext({
        ...f.authority,
        sourceLineId: newSource.lineId,
      });
      assert.deepEqual(
        context.originalLayers.map((layer) => layer.sourceLineId),
        [visibleOriginal.lineId],
      );
      assert.ok(!JSON.stringify(context).includes(privateSource.fileId));
      await f.propose(f.instruction(newSource.lineId, "100", "1.3"));
      await assert.rejects(
        readHistoricalTranslationAuthoringContext({
          ...f.authority,
          sourceLineId: protectedOriginal.lineId,
        }),
        /Source file is unavailable/,
      );
      const selectedPrivate = {
        ...privateInstruction,
        sourceLineId: newSource.lineId,
        kind: "correction" as const,
        layers: [
          {
            ...privateInstruction.layers[0]!,
            amount: "100",
            originalLayerId: protectedCertificate.layers[0]!.id,
          },
        ],
      };
      await assert.rejects(f.propose(selectedPrivate), /Source file is unavailable/);

      const reversal = await f.entry("100", "manual", visibleOriginal.entryId);
      const reversalContext = await readHistoricalTranslationAuthoringContext({
        ...f.authority,
        sourceLineId: reversal.lineId,
      });
      assert.deepEqual(
        reversalContext.originalLayers.map((layer) => layer.entryId),
        [visibleOriginal.entryId],
      );
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "mapped tenant members and foreign platform operators retain their actual acting identity",
  { skip: !DB },
  async () => {
    const f = await fixture(),
      home = await createScratchOrg();
    try {
      const homeActorId = await withBypassContext(() =>
        createScratchUser(home.orgId, "Visiting capital operator", "visiting_accountant"),
      );
      const memberActorId = await withBypassContext(() =>
        createScratchUser(f.org.orgId, "Mapped capital operator", "mapped_member"),
      );
      const roleId = randomUUID();
      await withBypassContext(async () => {
        assert.equal(
          (
            await db.execute(
              sql`insert into app_roles(id,org_id,key,name,is_built_in,permissions,subsidiary_restriction)
        values(${roleId},${f.org.orgId},'capital_operator','Capital operator',false,'["close.run","documents.read"]'::jsonb,
          '{"mode":"all"}'::jsonb) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`insert into role_assignments(org_id,user_id,role_id)
        values(${f.org.orgId},${memberActorId},${roleId}) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`insert into user_org_access(member_user_id,org_id,acting_user_id)
        values(${homeActorId},${f.org.orgId},${memberActorId}) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`insert into resource_grants(org_id,resource_type,resource_id,principal_type,principal_id,access,created_by)
        values(${f.org.orgId},'folder',${f.folderId},'user',${memberActorId},'viewer',${f.actors.adminId}) returning id`,
              "objects",
            )
          ).length,
          1,
        );
      });
      for (const platform of [false, true]) {
        if (platform)
          await withBypassContext(async () => {
            assert.equal(
              (
                await db.execute(
                  sql`delete from resource_grants where org_id=${f.org.orgId} and principal_id=${memberActorId} returning id`,
                  "objects",
                )
              ).length,
              1,
            );
            assert.equal(
              (
                await db.execute(
                  sql`update users set is_super_admin=true where org_id=${home.orgId} and id=${homeActorId} returning id`,
                  "objects",
                )
              ).length,
              1,
            );
          });
        const actorId = platform ? homeActorId : memberActorId;
        const posted = await f.entry("-100");
        const proposed = await f.propose(f.instruction(posted.lineId, "-100", "1.2"));
        await f.approve(proposed.changeId);
        const result = await applyHistoricalTranslationContribution({
          orgId: f.org.orgId,
          actorId,
          changeId: proposed.changeId,
        });
        const retained = await withOrgTransaction(f.org.orgId, () =>
          db.execute<{ createdBy: string }>(
            sql`
        select created_by as "createdBy" from historical_translation_contributions where org_id=${f.org.orgId} and id=${result.basisId}`,
            "objects",
          ),
        );
        assert.equal(retained[0]?.createdBy, actorId);
        assert.deepEqual(
          await applyHistoricalTranslationContribution({
            orgId: f.org.orgId,
            actorId,
            changeId: proposed.changeId,
          }),
          result,
        );
      }
    } finally {
      await dropScratchOrg(f.org.orgId);
      await dropScratchOrg(home.orgId);
    }
  },
);

test(
  "concurrent corrections cannot consume more than one original contribution layer",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const original = await f.entry("-100");
      const proposed = await f.propose(f.instruction(original.lineId, "-100", "1.20"));
      await f.approve(proposed.changeId);
      await applyHistoricalTranslationContribution({ ...f.authority, changeId: proposed.changeId });
      const read = await withOrgTransaction(f.org.orgId, () =>
        readHistoricalTranslationContribution(db, {
          orgId: f.org.orgId,
          sourceLineId: original.lineId,
          presentationCurrency: "USD",
        }),
      );
      assert.ok("layers" in read);
      const layer = read.layers[0]!;
      const corrections: string[] = [];
      for (let i = 0; i < 2; i++) {
        const source = await f.entry("75");
        const assessment = await f.propose({
          ...f.instruction(source.lineId, "75", "1.2"),
          kind: "correction",
          layers: [
            {
              amount: "75",
              rate: layer.rate,
              historicalDate: layer.historicalDate,
              provenance: layer.provenance,
              source: layer.source,
              originalLayerId: layer.id,
            },
          ],
        });
        await f.approve(assessment.changeId);
        corrections.push(assessment.changeId);
      }
      const results = await Promise.allSettled(
        corrections.map((changeId) =>
          applyHistoricalTranslationContribution({ ...f.authority, changeId }),
        ),
      );
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const refused = results.find((result) => result.status === "rejected");
      assert.ok(refused?.status === "rejected");
      assert.match(
        String(refused.reason),
        /remaining applied parent layer|allocation state changed/,
      );
      const used = await withOrgTransaction(f.org.orgId, () =>
        db.execute<{ total: string }>(
          sql`select sum(abs(amount))::text as total
      from historical_translation_layers where org_id=${f.org.orgId} and original_layer_id=${layer.id}`,
          "objects",
        ),
      );
      assert.equal(used[0]!.total, "75.0000");
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "corrections consume explicitly named original layers at retained rates and cannot overdraw them",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const original = await f.entry("-100");
      const proposed = await f.propose(f.instruction(original.lineId, "-100", "1.20"));
      await f.approve(proposed.changeId);
      await applyHistoricalTranslationContribution({ ...f.authority, changeId: proposed.changeId });
      const read = await withOrgTransaction(f.org.orgId, () =>
        readHistoricalTranslationContribution(db, {
          orgId: f.org.orgId,
          sourceLineId: original.lineId,
          presentationCurrency: "USD",
        }),
      );
      assert.ok("layers" in read);
      const layer = read.layers[0]!;
      const reversal = await f.entry("100", "manual", original.entryId);
      const correction: HistoricalTranslationInstruction = {
        ...f.instruction(reversal.lineId, "100", "1.2"),
        kind: "correction",
        layers: [
          {
            amount: "100",
            rate: layer.rate,
            historicalDate: layer.historicalDate,
            provenance: layer.provenance,
            source: layer.source,
            originalLayerId: layer.id,
          },
        ],
      };
      await assert.rejects(
        f.propose({ ...correction, layers: [{ ...correction.layers[0]!, rate: "1.40" }] }),
        /preserving its exact rate/,
      );
      const corrected = await f.propose(correction);
      await f.approve(corrected.changeId);
      await applyHistoricalTranslationContribution({
        ...f.authority,
        changeId: corrected.changeId,
      });
      const reversed = await withOrgTransaction(f.org.orgId, () =>
        readHistoricalTranslationContribution(db, {
          orgId: f.org.orgId,
          sourceLineId: reversal.lineId,
          presentationCurrency: "USD",
        }),
      );
      assert.equal(reversed.translatedAmount, "120.00000000000000");
      const overdraw = await f.entry("1");
      await assert.rejects(
        f.propose({
          ...correction,
          sourceLineId: overdraw.lineId,
          layers: [{ ...correction.layers[0]!, amount: "1" }],
        }),
        /remaining applied parent layer/,
      );
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "a later correction cannot reinterpret the original consumed state reviewed by its approver",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const source = await f.entry("-0.0002");
      const original = await f.propose(f.instruction(source.lineId, "-0.0002", "0.5"));
      await f.approve(original.changeId);
      await applyHistoricalTranslationContribution({ ...f.authority, changeId: original.changeId });
      const approved = await withOrgTransaction(f.org.orgId, () =>
        readHistoricalTranslationContribution(db, {
          orgId: f.org.orgId,
          sourceLineId: source.lineId,
          presentationCurrency: "USD",
        }),
      );
      assert.ok("layers" in approved);
      const layer = approved.layers[0]!;
      const corrections: Array<{
        changeId: string;
        instruction: HistoricalTranslationInstruction;
      }> = [];
      for (let i = 0; i < 2; i++) {
        const posted = await f.entry("0.0001");
        const instruction: HistoricalTranslationInstruction = {
          ...f.instruction(posted.lineId, "0.0001", "0.5"),
          kind: "correction",
          layers: [
            {
              amount: "0.0001",
              rate: layer.rate,
              historicalDate: layer.historicalDate,
              provenance: layer.provenance,
              source: layer.source,
              originalLayerId: layer.id,
            },
          ],
        };
        const proposed = await f.propose(instruction);
        await f.approve(proposed.changeId);
        corrections.push({ ...proposed, instruction });
      }
      await applyHistoricalTranslationContribution({
        ...f.authority,
        changeId: corrections[0]!.changeId,
      });
      await assert.rejects(
        applyHistoricalTranslationContribution({
          ...f.authority,
          changeId: corrections[1]!.changeId,
        }),
        /allocation state changed/,
      );
      const refreshed = await f.propose(corrections[1]!.instruction);
      await f.approve(refreshed.changeId);
      await applyHistoricalTranslationContribution({
        ...f.authority,
        changeId: refreshed.changeId,
      });
      const products = await withOrgTransaction(f.org.orgId, () =>
        db.execute<{ total: string }>(
          sql`select sum(translated_amount)::text as total
      from historical_translation_layers where org_id=${f.org.orgId}`,
          "objects",
        ),
      );
      assert.equal(products[0]!.total, "0.00000000000000");
      assert.deepEqual(
        await applyHistoricalTranslationContribution({
          ...f.authority,
          changeId: corrections[0]!.changeId,
        }),
        (
          await withOrgTransaction(f.org.orgId, () =>
            db.execute<{ result: { basisId: string } }>(
              sql`select result from financial_changes
        where org_id=${f.org.orgId} and id=${corrections[0]!.changeId}`,
              "objects",
            ),
          )
        )[0]!.result,
      );
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "an applied correction can be reversed and corrected again without releasing ancestor capacity or rewriting its source",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const original = await f.entry("-100");
      const apply = async (instruction: HistoricalTranslationInstruction) => {
        const proposed = await f.propose(instruction);
        await f.approve(proposed.changeId);
        await applyHistoricalTranslationContribution({
          ...f.authority,
          changeId: proposed.changeId,
        });
        return withOrgTransaction(f.org.orgId, () =>
          readHistoricalTranslationContribution(db, {
            orgId: f.org.orgId,
            sourceLineId: instruction.sourceLineId,
            presentationCurrency: "USD",
          }),
        );
      };
      const first = await apply(f.instruction(original.lineId, "-100", "1.20"));
      const snapshot = () =>
        withOrgTransaction(
          f.org.orgId,
          async () =>
            (
              await db.execute<{ state: unknown }>(
                sql`
      select jsonb_build_object(
        'entry',(select to_jsonb(entry) from journal_entries entry where org_id=${f.org.orgId} and id=${original.entryId}),
        'lines',(select jsonb_agg(to_jsonb(line) order by line_number) from journal_lines line where org_id=${f.org.orgId} and entry_id=${original.entryId}),
        'basis',(select to_jsonb(basis) from historical_translation_contributions basis where org_id=${f.org.orgId} and id=${first.basisId}),
        'layers',(select jsonb_agg(to_jsonb(layer) order by layer_number) from historical_translation_layers layer where org_id=${f.org.orgId} and basis_id=${first.basisId}),
        'version',(select to_jsonb(version) from file_versions version where file_id=${f.source.fileId} and id=${f.source.versionId}),
        'bytes',(select jsonb_agg(to_jsonb(blob)) from file_blobs blob where version_id=${f.source.versionId})
      ) as state`,
                "objects",
              )
            )[0]!.state,
        );
      const preserved = await snapshot();
      const firstLayer = first.layers[0]!;
      const instructionFor = (
        lineId: string,
        amount: string,
        parent: typeof firstLayer,
      ): HistoricalTranslationInstruction => ({
        ...f.instruction(lineId, amount, parent.rate),
        kind: "correction",
        layers: [
          {
            amount,
            rate: parent.rate,
            historicalDate: parent.historicalDate,
            provenance: parent.provenance,
            source: parent.source,
            originalLayerId: parent.id,
          },
        ],
      });
      const reductionSource = await f.entry("60");
      const reduced = await apply(instructionFor(reductionSource.lineId, "60", firstLayer));
      const reductionLayer = reduced.layers[0]!;
      const unrelated = await f.entry("60");
      const unrelatedBasis = await apply(f.instruction(unrelated.lineId, "60", "1.20"));
      const restoredSource = await f.entry("-60", "manual", reductionSource.entryId);
      await withOrgTransaction(f.org.orgId, () =>
        markEntryReversed(db, {
          orgId: f.org.orgId,
          entryId: reductionSource.entryId,
          actorId: f.authority.actorId,
        }),
      );
      const candidates = await readHistoricalTranslationAuthoringContext({
        ...f.authority,
        sourceLineId: restoredSource.lineId,
      });
      assert.deepEqual(
        candidates.originalLayers.map((layer) => layer.id),
        [reductionLayer.id],
      );
      assert.equal(candidates.originalLayers[0]!.remainingAmount, "60.0000");
      await assert.rejects(
        f.propose(instructionFor(restoredSource.lineId, "-60", unrelatedBasis.layers[0]!)),
        /applied parent layer/,
      );
      const restored = await apply(instructionFor(restoredSource.lineId, "-60", reductionLayer));
      assert.equal(restored.evidence.instruction.kind, "correction");
      assert.equal(restored.layers[0]!.originalLayerId, reductionLayer.id);
      assert.equal(restored.translatedAmount, "-72.00000000000000");
      assert.equal(
        sumHistoricalTranslationExactAmounts([
          first.translatedAmount,
          reduced.translatedAmount,
          restored.translatedAmount,
        ]),
        "-120.00000000000000",
      );
      const nextSource = await f.entry("30");
      const nextCandidates = await readHistoricalTranslationAuthoringContext({
        ...f.authority,
        sourceLineId: nextSource.lineId,
      });
      assert.equal(
        nextCandidates.originalLayers.find((layer) => layer.id === firstLayer.id)!.remainingAmount,
        "40.0000",
      );
      assert.equal(
        nextCandidates.originalLayers.find((layer) => layer.id === restored.layers[0]!.id)!
          .remainingAmount,
        "60.0000",
      );
      const next = await apply(instructionFor(nextSource.lineId, "30", restored.layers[0]!));
      assert.equal(next.layers[0]!.originalLayerId, restored.layers[0]!.id);
      assert.equal(next.translatedAmount, "36.00000000000000");
      const excess = await f.entry("31");
      await assert.rejects(
        f.propose(instructionFor(excess.lineId, "31", restored.layers[0]!)),
        /remaining applied parent layer/,
      );
      const reuse = await f.entry("-1");
      await assert.rejects(
        f.propose(instructionFor(reuse.lineId, "-1", reductionLayer)),
        /remaining applied parent layer/,
      );
      const allocations = await withOrgTransaction(f.org.orgId, () =>
        db.execute<{ id: string; used: string }>(
          sql`
      select parent.id,coalesce(sum(abs(child.amount)),0)::numeric(19,4)::text as used
      from historical_translation_layers parent left join historical_translation_layers child
        on child.org_id=parent.org_id and child.original_layer_id=parent.id
      where parent.org_id=${f.org.orgId} and parent.id in (${firstLayer.id},${reductionLayer.id},${restored.layers[0]!.id})
      group by parent.id`,
          "objects",
        ),
      );
      assert.equal(allocations.find((row) => row.id === firstLayer.id)!.used, "60.0000");
      assert.equal(allocations.find((row) => row.id === reductionLayer.id)!.used, "60.0000");
      assert.equal(allocations.find((row) => row.id === restored.layers[0]!.id)!.used, "30.0000");
      assert.deepEqual(await snapshot(), preserved);
      assert.deepEqual(restored.layers[0]!.source, firstLayer.source);
      assert.equal(restored.layers[0]!.versionNumber, firstLayer.versionNumber);
      await assert.rejects(
        withOrgTransaction(f.org.orgId, () =>
          db.execute(sql`update historical_translation_layers
      set original_layer_id=${firstLayer.id} where org_id=${f.org.orgId} and id=${restored.layers[0]!.id}`),
        ),
        (error) => errorChainMatches(error, /immutable/i),
      );
      assert.equal(
        (
          await withBypassContext(() =>
            db.execute(
              sql`delete from resource_grants where org_id=${f.org.orgId}
      and resource_type='folder' and resource_id=${f.folderId} and principal_type='user'
      and principal_id=${f.authority.actorId} returning id`,
              "objects",
            ),
          )
        ).length,
        1,
      );
      const privateCandidates = await readHistoricalTranslationAuthoringContext({
        ...f.authority,
        sourceLineId: excess.lineId,
      });
      assert.deepEqual(privateCandidates.originalLayers, []);
      assert.ok(!JSON.stringify(privateCandidates).includes(f.source.fileId));
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);
