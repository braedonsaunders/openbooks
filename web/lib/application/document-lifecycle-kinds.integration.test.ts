import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// Sweep-C lifecycle verification: submit, post, void, and correct already
// exist as kind-generic application tools. This suite proves all six sweep-C
// kinds actually traverse them end to end — journal, vendor_credit,
// customer_credit, deposit, transfer, and card_charge — through
// executeApplicationTool, the same entry the chat loop and MCP share.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { documentRevisionCounterSql } = await import("@openbooks/engine/src/document-revision.ts");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;
const KIND_PERMS: Record<string, string[]> = {
  vendor_credit: ["ap.create", "ap.post"],
  customer_credit: ["ar.create", "ar.post"],
  deposit: ["gl.post"],
  transfer: ["gl.post"],
  card_charge: ["ap.create", "ap.post"],
};

function ctxFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId, email: `${userId}@test`, name: "Test", orgId,
        roles: [{ key: "lifecycle-role", name: "Lifecycle role" }],
        envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
        homeUserId: userId, homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function revisionOf(orgId: string, id: string): Promise<string> {
  const rows = (await db.execute<{ revision: string }>(sql`
    select ${documentRevisionCounterSql(sql.raw("revision_seq"))} as revision from documents where id = ${id} and org_id = ${orgId}`)).rows;
  return rows[0]!.revision;
}

async function statusOf(orgId: string, id: string): Promise<string> {
  const rows = (await db.execute<{ status: string }>(sql`
    select status::text as status from documents where id = ${id} and org_id = ${orgId}`)).rows;
  return rows[0]!.status;
}

// Voids and corrections date their reversals on the business day, so the
// current month must be open alongside the scratch 2026-07 period.
async function openCurrentMonth(orgId: string, periodId: string): Promise<void> {
  const today = new Date();
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
  if (monthStart === "2026-07-01") return;
  const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  await withBypassContext(() => db.execute(sql`
    insert into accounting_periods (org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    select ${orgId}, ${today.getUTCFullYear()}, ${today.getUTCMonth() + 1}, ${monthStart.slice(0, 7)}, ${monthStart}, ${monthEnd}, false, fiscal_calendar_id
      from accounting_periods where id = ${periodId} and org_id = ${orgId}`));
}

async function seedDoc(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actorId: string,
  kind: string,
  number: string,
  lines: { accountId: string; amount: string }[],
  extra: { partyId?: string | null; paymentCardId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id, payment_card_id,
       document_date, currency, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, ${kind}, 'draft', ${number}, ${org.subsidiaryId},
      ${extra.partyId ?? null}, ${extra.paymentCardId ?? null},
      '2026-07-15', 'CAD', '100.0000', '0.0000', '100.0000', ${actorId})
  `));
  let n = 0;
  for (const line of lines) {
    n += 1;
    await withBypassContext(() => db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount, created_by)
      values (${org.orgId}, ${id}, ${n}, ${line.accountId}, '1', ${line.amount}, ${line.amount}, '0.0000', '0.0000', ${actorId})
    `));
  }
  return id;
}

test("journals post and void through their governed path, never the generic lifecycle", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    await openCurrentMonth(org.orgId, org.periodId);
    const ctx = ctxFor(org.orgId, actors.adminId, ["gl.post"]);
    const run = (name: string, input: Record<string, unknown>) =>
      executeApplicationTool(applicationTool(name)!, ctx, input);
    await withOrgContext(org.orgId, async () => {
      const lines = [
        { accountId: org.accounts.bank, amount: "100.0000" },
        { accountId: org.accounts.revenue, amount: "-100.0000" },
      ];
      // The generic lifecycle refuses journal documents outright.
      const refused = await seedDoc(org, actors.adminId, "journal", "JE-REFUSED", lines);
      await assert.rejects(
        run("submit_document", { documentId: refused, idempotencyKey: "a05-journal-refused-1" }),
        /dedicated lifecycle/,
      );
      // post_journal submits the draft and posts it through the kernel.
      const journalId = await seedDoc(org, actors.adminId, "journal", "JE-POST", lines);
      const posted = await run("post_journal", { documentId: journalId, idempotencyKey: "a05-journal-post-1" }) as {
        result: { status: string; entryId: string };
      };
      assert.equal(posted.result.status, "posted");
      assert.ok(posted.result.entryId, "journal post returns a journal entry");
      // Replaying the exact post replays instead of double-posting.
      const replayed = await run("post_journal", { documentId: journalId, idempotencyKey: "a05-journal-post-1" }) as {
        replayed: boolean;
      };
      assert.equal(replayed.replayed, true);
      // void_document voids the posted journal; correct_document refuses it
      // (corrections are offsetting journals, drafted like any other).
      await run("void_document", {
        documentId: journalId, reason: "entered in the wrong period", idempotencyKey: "a05-journal-void-1",
      });
      assert.equal(await statusOf(org.orgId, journalId), "voided");
      const postedAgain = await seedDoc(org, actors.adminId, "journal", "JE-CORRECT", lines);
      await run("post_journal", { documentId: postedAgain, idempotencyKey: "a05-journal-post-2" });
      await assert.rejects(
        run("correct_document", {
          documentId: postedAgain,
          correction: {
            amendmentReason: "journals correct via offsetting drafts",
            expectedUpdatedAt: await revisionOf(org.orgId, postedAgain),
          },
          idempotencyKey: "a05-journal-correct-1",
        }),
        /dedicated correction workflow/,
      );
      // Non-journal documents are not journals, indistinguishably.
      const bill = await seedDoc(
        org, actors.adminId, "vendor_credit", "VC-NOT-JOURNAL",
        [{ accountId: org.accounts.cogs, amount: "100.0000" }], { partyId: org.vendorId },
      );
      await assert.rejects(
        run("post_journal", { documentId: bill, idempotencyKey: "a05-journal-kind-1" }),
        /journal not found/,
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("credits, deposits, transfers, and card charges traverse submit, post, void, and correct", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    await openCurrentMonth(org.orgId, org.periodId);
    // Second bank account for transfers; card + liability for card charges.
    const bankB = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${bankB}, ${org.orgId}, '1020', 'Petty Cash', 'asset_bank', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
    `));
    const cardLiability = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${cardLiability}, ${org.orgId}, '2010', 'Card Payable', 'liability_credit', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
    `));
    const cardId = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into payment_cards (id, org_id, holder_party_id, liability_account_id, label, last_four)
      values (${cardId}, ${org.orgId}, ${org.vendorId}, ${cardLiability}, 'Probe card', '4242')
    `));

    const bodies: Record<string, { lines: { accountId: string; amount: string }[]; extra?: { partyId?: string | null; paymentCardId?: string | null } }> = {
      vendor_credit: { lines: [{ accountId: org.accounts.cogs, amount: "100.0000" }], extra: { partyId: org.vendorId } },
      customer_credit: { lines: [{ accountId: org.accounts.revenue, amount: "100.0000" }], extra: { partyId: org.customerId } },
      deposit: { lines: [{ accountId: org.accounts.revenue, amount: "100.0000" }] },
      transfer: { lines: [{ accountId: bankB, amount: "100.0000" }, { accountId: org.accounts.bank, amount: "0.0000" }] },
      card_charge: { lines: [{ accountId: org.accounts.cogs, amount: "100.0000" }], extra: { partyId: org.vendorId, paymentCardId: cardId } },
    };

    await withOrgContext(org.orgId, async () => {
      for (const kind of Object.keys(bodies)) {
        const ctx = ctxFor(org.orgId, actors.adminId, KIND_PERMS[kind]!);
        const run = (name: string, input: Record<string, unknown>) =>
          executeApplicationTool(applicationTool(name)!, ctx, input);
        const body = bodies[kind]!;

        // Document A: submit, post, then the direct void path.
        const voidId = await seedDoc(org, actors.adminId, kind, `VOID-${kind}`, body.lines, body.extra ?? {});
        const submitted = await run("submit_document", { documentId: voidId, idempotencyKey: `a05-${kind}-submit-1` }) as { result: { status: string } };
        assert.equal(submitted.result.status, "approved", `${kind} submits`);
        const posted = await run("post_document", { documentId: voidId, idempotencyKey: `a05-${kind}-post-1` }) as {
          result: { status: string; entryId: string };
        };
        assert.equal(posted.result.status, "posted", `${kind} posts`);
        assert.ok(posted.result.entryId, `${kind} post returns a journal entry`);
        const voided = await run("void_document", {
          documentId: voidId, reason: `void the ${kind} evidence`, idempotencyKey: `a05-${kind}-void-1`,
        }) as {
          result: { status?: string };
        };
        assert.equal(await statusOf(org.orgId, voidId), "voided", `${kind} voids`);
        void voided;

        // Document B: submit, post, then the correction path (replacement
        // draft plus a controlled void of the source).
        const correctId = await seedDoc(org, actors.adminId, kind, `CORR-${kind}`, body.lines, body.extra ?? {});
        await run("submit_document", { documentId: correctId, idempotencyKey: `a05-${kind}-submit-2` });
        await run("post_document", { documentId: correctId, idempotencyKey: `a05-${kind}-post-2` });
        const corrected = await run("correct_document", {
          documentId: correctId,
          correction: {
            amendmentReason: `correct the ${kind} evidence`,
            expectedUpdatedAt: await revisionOf(org.orgId, correctId),
          },
          idempotencyKey: `a05-${kind}-correct-1`,
        }) as { result: { correctionId: string } };
        assert.ok(corrected.result.correctionId, `${kind} corrects to a replacement draft`);
        assert.equal(await statusOf(org.orgId, corrected.result.correctionId), "draft", `${kind} replacement is a draft`);
      }
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
