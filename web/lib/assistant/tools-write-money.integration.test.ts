import assert from "node:assert/strict";
import test from "node:test";

const { env, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { executeAssistantTool } = await import("./registry");
const DB = !!env.OPENBOOKS_DB_URL;

test("journal drafting preserves decimal strings and refuses JSON numbers", { skip: !DB }, async () => {
  const fixture = await withBypassContext(async () => {
    const org = await createScratchOrg();
    return { org, actors: await seedFlowActors(org.orgId) };
  });
  try {
    const userId = fixture.actors.adminId;
    const authz = {
      user: {
        id: userId,
        orgId: fixture.org.orgId,
        name: "Exact journal drafter",
        email: "exact-journal@scratch.test",
        roles: [],
        isSuperAdmin: false,
        envKind: "production",
        productionOrgId: fixture.org.orgId,
        homeOrgId: fixture.org.orgId,
        homeUserId: userId,
      },
      permissions: new Set(["assistant.use", "assistant.write", "gl.post"]),
      allowedSubsidiaryIds: null,
    };
    const draft = (amount: string | number) => executeAssistantTool(authz as never, "draft_journal_entry", {
      documentDate: fixture.org.date,
      lines: [
        { account: "1000", amount },
        { account: "4000", amount: typeof amount === "number" ? -amount : `-${amount}` },
      ],
    });

    const exact = await draft("999999999999998.99");
    assert.equal(exact.ok, true, `exact decimal was refused: ${JSON.stringify(exact)}`);
    if (exact.ok) {
      const proposed = (exact.data as { proposed: { preview: { lines: { amount: string }[] } } }).proposed;
      assert.equal(proposed.preview.lines[0]!.amount, "999999999999998.9900");
      assert.equal(proposed.preview.lines[1]!.amount, "-999999999999998.9900");
    }

    const roundedNumber = await draft(999999999999998.99);
    assert.deepEqual(roundedNumber, { ok: false, error: "invalid_input" });
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});
