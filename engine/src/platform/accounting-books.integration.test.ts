import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { activePostingPrimaryBookId } from "./accounting-books.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

// The active posting primary book is the single shared definition of which
// book is authoritative (B4-PRJ-01). Every ledger read and posting gate
// resolves through here, so a deactivated (or non-posting) primary stops
// being read the moment it stops being written.
test("the shared book resolver tracks the live primary", async () => {
  const org = await createScratchOrg();
  try {
    assert.equal(await activePostingPrimaryBookId(org.orgId), org.bookId);

    // A deactivated primary is no book at all: readers sum nothing, writers
    // refuse on the null.
    await db.execute(sql`update accounting_books set is_active = false where id = ${org.bookId}`);
    assert.equal(await activePostingPrimaryBookId(org.orgId), null);

    // Reactivate but stop posting: still no book.
    await db.execute(
      sql`update accounting_books set is_active = true, posts_gl = false where id = ${org.bookId}`,
    );
    assert.equal(await activePostingPrimaryBookId(org.orgId), null);

    // A live primary resolves again.
    await db.execute(sql`update accounting_books set posts_gl = true where id = ${org.bookId}`);
    assert.equal(await activePostingPrimaryBookId(org.orgId), org.bookId);

    // Unknown orgs resolve like the Features page: defaults, not a throw.
    assert.equal(
      await activePostingPrimaryBookId("00000000-0000-4000-8000-000000000000"),
      null,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
