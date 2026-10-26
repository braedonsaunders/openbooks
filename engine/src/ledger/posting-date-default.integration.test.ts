import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { effectivePostingDate } from "../journal/posting-contracts.ts";
import { db, withBypass } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPostingAccount,
} from "../testing/fixtures.ts";
import { createDocument } from "./document-write.ts";
import { postDocument } from "./posting-document.ts";

// An empty posting date posts on the document date — for every kind and
// every creation path (drawer save, direct API, recurring runs all store a
// null posting date). An explicit posting date is honoured. Posting into a
// date no period covers refuses with the remedy, never a bare failure.

const DB = !!process.env.OPENBOOKS_DB_URL;

test("effectivePostingDate prefers an explicit date, else the document date", () => {
  assert.equal(
    effectivePostingDate({ postingDate: "2026-11-20", documentDate: "2026-11-15" }),
    "2026-11-20",
  );
  assert.equal(
    effectivePostingDate({ postingDate: null, documentDate: "2026-11-15" }),
    "2026-11-15",
  );
  assert.equal(
    effectivePostingDate({ postingDate: undefined, documentDate: "2026-11-15" }),
    "2026-11-15",
  );
  assert.equal(effectivePostingDate({ postingDate: "", documentDate: "2026-11-15" }), "2026-11-15");
});

async function postInvoice(
  org: {
    orgId: string;
    subsidiaryId: string;
    customerId: string;
    date: string;
    accounts: { ar: string; ap: string; bank: string };
  },
  input: {
    userId: string;
    services: string;
    documentDate: string;
    postingDate?: string | null;
  },
) {
  const created = await withBypass(() =>
    createDocument({
      orgId: org.orgId,
      userId: input.userId,
      kind: "customer_invoice",
      key: randomUUID(),
      subsidiaryId: org.subsidiaryId,
      body: {
        partyId: org.customerId,
        documentDate: input.documentDate,
        ...(input.postingDate === undefined ? {} : { postingDate: input.postingDate }),
        lines: [{ accountId: input.services, amount: "100.0000" }],
      },
      requestBody: {},
    }),
  );
  await withBypass(() =>
    db.execute(sql`update documents set status = 'approved' where id = ${created.id}`),
  );
  const entryId = await withBypass(() =>
    postDocument(created.id, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }),
  );
  const entry = (
    await withBypass(() =>
      db.execute<{ d: string }>(
        sql`
    select posting_date::text as d from journal_entries where id = ${entryId}`,
        "objects",
      ),
    )
  )[0];
  return entry?.d;
}

test(
  "an invoice saved without a posting date posts on its document date",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const services = await withBypass(() =>
        seedPostingAccount(org.orgId, "4100", "Services", "income"),
      );
      const userId = String(await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin")));
      // The drawer sends no posting date when the field is blank, and direct
      // API callers omit it the same way recurring runs do.
      const entryDate = await postInvoice(org, { userId, services, documentDate: org.date });
      assert.equal(entryDate, org.date);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("an explicit posting date is honoured", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const services = await withBypass(() =>
      seedPostingAccount(org.orgId, "4100", "Services", "income"),
    );
    const userId = String(await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin")));
    // A second covered date inside the same period, distinct from the
    // document date, so the entry must follow the override, not the fallback.
    const window = (
      await withBypass(() =>
        db.execute<{ s: string; e: string }>(
          sql`
      select starts_on::text as s, ends_on::text as e from accounting_periods
       where org_id = ${org.orgId} and starts_on <= ${org.date}::date and ends_on >= ${org.date}::date
       order by starts_on limit 1`,
          "objects",
        ),
      )
    )[0];
    assert.ok(window, "the scratch period covers the scratch date");
    const explicit = window.s !== org.date ? window.s : window.e;
    assert.notEqual(explicit, org.date, "the scratch period spans more than one day");
    const entryDate = await postInvoice(org, {
      userId,
      services,
      documentDate: org.date,
      postingDate: explicit,
    });
    assert.equal(entryDate, explicit);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("posting into an uncovered date refuses with the remedy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const services = await withBypass(() =>
      seedPostingAccount(org.orgId, "4100", "Services", "income"),
    );
    const userId = String(await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin")));
    const created = await withBypass(() =>
      createDocument({
        orgId: org.orgId,
        userId,
        kind: "customer_invoice",
        key: randomUUID(),
        subsidiaryId: org.subsidiaryId,
        body: {
          partyId: org.customerId,
          documentDate: org.date,
          postingDate: "2020-05-15",
          lines: [{ accountId: services, amount: "100.0000" }],
        },
        requestBody: {},
      }),
    );
    await withBypass(() =>
      db.execute(sql`update documents set status = 'approved' where id = ${created.id}`),
    );
    await assert.rejects(
      withBypass(() =>
        postDocument(created.id, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        }),
      ),
      /no accounting period covers 2020-05-15 — generate the period covering that date, then post again/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
