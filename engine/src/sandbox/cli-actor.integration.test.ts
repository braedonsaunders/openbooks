import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withBypass } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { resolveCliActor } from "./cli-actor.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("promote without --actor is refused instead of capturing unattributed", { skip: !DB }, async () => {
  // C-46: an unattributed CLI capture would leave change_sets.created_by
  // null through the whole review. The CLI must refuse before buildChangeSet.
  await assert.rejects(resolveCliActor([]), /--actor/);
  await assert.rejects(resolveCliActor(["--tier=masked"]), /--actor/);
  await assert.rejects(resolveCliActor(["--actor=not-a-uuid"]), /--actor must be a valid existing user id/);
  await assert.rejects(resolveCliActor([`--actor=${randomUUID()}`]), /unknown actor/);
});

test("promote --actor resolves an existing user", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "CLI actor", "admin"));
    assert.equal(await resolveCliActor([`--actor=${userId}`]), userId);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
