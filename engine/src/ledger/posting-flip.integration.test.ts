import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { postDocument } from "./posting-document.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function setup(org: ScratchOrg): Promise<{
  documentId: string;
  secondaryBookId: string;
  actorId: string;
  mappedAccountId: string;
}> {
  const actorId = await withOrgContext(org.orgId, () =>
    createScratchUser(org.orgId, "Accounting poster", "accounting-poster"),
  );
  const secondaryBookId = randomUUID();
  const mappedAccountId = randomUUID();
  const sourceDepartment = randomUUID();
  const targetDepartment = randomUUID();
  const ruleId = randomUUID();
  const versionId = randomUUID();
  const documentId = randomUUID();
  await withOrgContext(org.orgId, async () => {
    await grantScratchPermissions(org.orgId, actorId, ["ap.post", "gl.post"]);
    assert.equal(
      (
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"allocations":true,"allocationsAtPosting":true}'::jsonb)
      where id=${org.orgId} returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
      values(${secondaryBookId},${org.orgId},'ALLOC','Allocation book',false,true,true) returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`insert into accounts(id,org_id,number,name,type,subsidiary_id,subsidiary_include_children)
      values(${mappedAccountId},${org.orgId},'ALLOC-EXP','Entity allocation expense','expense',${org.subsidiaryId},false) returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`insert into accounting_book_account_maps
      (org_id,book_id,subsidiary_id,source_account_id,target_account_id,effective_from,reason,created_by,updated_by)
      values(${org.orgId},${secondaryBookId},${org.subsidiaryId},${org.accounts.cogs},${mappedAccountId},
        '2026-01-01','Carry allocations in the entity account',${actorId},${actorId}) returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`insert into departments(id,org_id,name,is_active)
      values(${sourceDepartment},${org.orgId},'Source department',true),
        (${targetDepartment},${org.orgId},'Target department',true) returning id`,
          "objects",
        )
      ).length,
      2,
    );
    assert.equal(
      (
        await db.execute(
          sql`insert into allocation_rules
      (id,org_id,key,name,mode,sort_order,is_active,is_system,current_version_id)
      values(${ruleId},${org.orgId},'expense-attribution','Expense attribution','post',100,true,false,null) returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`insert into allocation_rule_versions
      (id,org_id,rule_id,version_no,status,effective_from,definition_hash,book_scope,book_ids,document_kinds,
       account_scope,dimension_filters,basis_kind,driver_id,driver_as_of,target_kind,impact,offset_account_id,residual_policy)
      values(${versionId},${org.orgId},${ruleId},1,'draft','2026-01-01',null,'books',
        ${JSON.stringify([secondaryBookId])}::jsonb,'["vendor_bill"]'::jsonb,
        ${JSON.stringify({ kind: "accounts", accountIds: [org.accounts.cogs] })}::jsonb,
        '{}'::jsonb,'fixed_percent',null,'period','explicit','net_zero_pair',null,'largest_share') returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`insert into allocation_rule_targets
      (org_id,version_id,sequence,department_id,fixed_percent,is_remainder)
      values(${org.orgId},${versionId},1,${targetDepartment},'100',false) returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`update allocation_rule_versions set status='published',definition_hash='declared-attribution'
      where org_id=${org.orgId} and id=${versionId} and status='draft' returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`update allocation_rules set current_version_id=${versionId}
      where org_id=${org.orgId} and id=${ruleId} returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`insert into documents
      (id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,posting_date,currency,fx_rate,subtotal,tax_total,total)
      values(${documentId},${org.orgId},'vendor_bill','draft',${`BILL-${documentId}`},null,${org.vendorId},
        ${org.date},${org.date},'CAD','1','100','0','100') returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`insert into document_lines
      (org_id,document_id,line_number,account_id,department_id,amount,tax_input_amount,tax_amount,quantity,unit_price)
      values(${org.orgId},${documentId},1,${org.accounts.cogs},${sourceDepartment},'100','100','0','1','100') returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`update documents set status='approved'
      where org_id=${org.orgId} and id=${documentId} and status='draft' returning id`,
          "objects",
        )
      ).length,
      1,
    );
  });
  return { documentId, secondaryBookId, actorId, mappedAccountId };
}

function post(org: ScratchOrg, documentId: string, actorId: string): Promise<string> {
  return postDocument(
    documentId,
    { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
    { audit: { actorId, source: "test" } },
  );
}

async function assertPostedBooks(
  org: ScratchOrg,
  documentId: string,
  primaryEntryId: string,
  secondaryBookId: string,
  mappedAccountId: string,
): Promise<void> {
  const entries = await db.execute<{
    id: string;
    book_id: string;
    status: string;
    posted_at: string | null;
    legs: number;
    balance: string;
  }>(
    sql`
    select e.id,e.book_id,e.status,e.posted_at::text,count(l.id)::int as legs,sum(l.amount)::text as balance
    from journal_entries e join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id
    where e.org_id=${org.orgId} and e.source_document_id=${documentId} group by e.id`,
    "objects",
  );
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.book_id === org.bookId)!.id, primaryEntryId);
  assert.equal(entries.find((entry) => entry.book_id === secondaryBookId)!.legs, 2);
  assert.ok(
    entries.every(
      (entry) =>
        entry.status === "posted" && entry.posted_at !== null && entry.balance === "0.0000",
    ),
  );
  const allocatedAccounts = (
    await db.execute<{ account_id: string }>(
      sql`
    select l.account_id from journal_lines l join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
     where e.org_id=${org.orgId} and e.source_document_id=${documentId} and e.book_id=${secondaryBookId}
     order by l.line_number`,
      "objects",
    )
  ).map((row) => row.account_id);
  assert.deepEqual(
    allocatedAccounts,
    [mappedAccountId, mappedAccountId],
    "book mappings use the root subsidiary when the document header omits it",
  );
  const document = (
    await db.execute<{ status: string; posted_entry_id: string }>(
      sql`
    select status,posted_entry_id from documents where org_id=${org.orgId} and id=${documentId}`,
      "objects",
    )
  )[0]!;
  assert.deepEqual(document, { status: "posted", posted_entry_id: primaryEntryId });
  const lineage = await db.execute<{
    target_status: string;
    source_status: string;
    target_book: string;
    source_book: string;
  }>(
    sql`
    select target.status as target_status,source.status as source_status,
      target.book_id as target_book,source.book_id as source_book
    from allocation_lineage a
    join journal_entries target on target.org_id=a.org_id and target.id=a.journal_entry_id
    join journal_lines source_line on source_line.org_id=a.org_id and source_line.id=a.source_journal_line_id
    join journal_entries source on source.org_id=source_line.org_id and source.id=source_line.entry_id
    where a.org_id=${org.orgId} and a.document_id=${documentId}`,
    "objects",
  );
  assert.equal(lineage.length, 2);
  assert.ok(
    lineage.every(
      (row) =>
        row.target_status === "posted" &&
        row.source_status === "posted" &&
        row.target_book === secondaryBookId &&
        row.source_book === org.bookId,
    ),
  );
}

test(
  "primary and allocation-book posting transitions roll back with their caller's transaction",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { documentId, actorId, secondaryBookId, mappedAccountId } = await setup(org);
      const cancelled = new Error("Cancel the wider accounting operation");
      await assert.rejects(
        () =>
          withOrgTransaction(org.orgId, async () => {
            const entryId = await post(org, documentId, actorId);
            await assertPostedBooks(org, documentId, entryId, secondaryBookId, mappedAccountId);
            throw cancelled;
          }),
        (error) => error === cancelled,
      );
      await withOrgContext(org.orgId, async () => {
        const document = (
          await db.execute<{ status: string; posted_entry_id: string | null }>(
            sql`
        select status,posted_entry_id from documents where org_id=${org.orgId} and id=${documentId}`,
            "objects",
          )
        )[0]!;
        assert.deepEqual(document, { status: "approved", posted_entry_id: null });
        for (const table of ["journal_entries", "journal_lines", "allocation_lineage"] as const) {
          assert.equal(
            (
              await db.execute(
                sql`select id from ${sql.identifier(table)} where org_id=${org.orgId}`,
                "objects",
              )
            ).length,
            0,
          );
        }
        assert.equal(
          (
            await db.execute(
              sql`select id from audit_log where org_id=${org.orgId}
        and row_id=${documentId} and action='post'`,
              "objects",
            )
          ).length,
          0,
        );
        const entryId = await post(org, documentId, actorId);
        await assertPostedBooks(org, documentId, entryId, secondaryBookId, mappedAccountId);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "racing document posts retain one posted primary and one posted allocation entry",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { documentId, actorId, secondaryBookId, mappedAccountId } = await setup(org);
      const outcomes = await Promise.allSettled(
        [0, 1].map(() => withOrgContext(org.orgId, () => post(org, documentId, actorId))),
      );
      const successful = outcomes.filter(
        (result) => result.status === "fulfilled",
      ) as PromiseFulfilledResult<string>[];
      assert.equal(successful.length, 1);
      const refused = outcomes.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      assert.ok(
        refused.reason instanceof PostingError,
        new Error("The competing post must return a typed posting refusal", {
          cause: refused.reason,
        }),
      );
      await withOrgContext(org.orgId, async () => {
        await assertPostedBooks(
          org,
          documentId,
          successful[0]!.value,
          secondaryBookId,
          mappedAccountId,
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from journal_entries where org_id=${org.orgId} and status='draft'`,
              "objects",
            )
          ).length,
          0,
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
