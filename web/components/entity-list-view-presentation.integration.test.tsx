import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";

// Translation is the only scripted boundary: the list, the personal
// presentation read, authorization and the database stay real.
stubModules({ intl: true });

const React = await import("react");
Object.assign(globalThis, { React });
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext, withOrgTransaction } =
  await import("@openbooks/engine/platform/db");
const { installTrustedTestDatabaseBypass } =
  await import("@openbooks/engine/testing/database-bypass");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { saveWorkListPresentation } =
  await import("@openbooks/engine/organization/list-presentation");
const { EntityListView } = await import("./entity-list-view.tsx");
const { WorkListPresentation } = await import("./work-list-presentation.tsx");

installTrustedTestDatabaseBypass();
const DB = !!process.env.OPENBOOKS_DB_URL;

/** The presentation the server selected, read from the rendered tree. */
function selectedPresentation(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = selectedPresentation(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!React.isValidElement(node)) return undefined;
  const props = node.props as { value?: string; children?: unknown };
  if (node.type === WorkListPresentation) return props.value;
  return selectedPresentation(props.children);
}

test(
  "the projects list renders from page context and honours the viewer's saved board presentation",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const userId = await withBypassContext(async () => {
        const id = await createScratchUser(org.orgId, "project-reader", "project-reader");
        const updated = await db.execute(
          sql`update app_roles set permissions=${JSON.stringify(["projects.read"])}::jsonb where org_id=${org.orgId} and key='project-reader' returning key`,
          "objects",
        );
        assert.equal(updated.length, 1, "reader role setup updates one role");
        await db.execute(
          sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,projects}', 'true'::jsonb, true) where id = ${org.orgId}`,
        );
        return id;
      });
      // A page render holds organization context but no transaction of its own.
      const render = () =>
        withOrgContext(org.orgId, () =>
          EntityListView({
            recordType: "project",
            orgId: org.orgId,
            userId,
            canManage: false,
            sp: {},
          }),
        );

      assert.equal(
        selectedPresentation(await render()),
        "list",
        "without a preference the list presentation is selected",
      );

      await withOrgTransaction(org.orgId, () =>
        saveWorkListPresentation(db, org.orgId, userId, "project", "board"),
      );
      assert.equal(
        selectedPresentation(await render()),
        "board",
        "the saved board presentation is selected",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
