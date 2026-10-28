import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg, grantScratchPermissions } =
  await import("@openbooks/engine/testing/fixtures");
const { listSessions } = await import("@openbooks/engine/pos");
const { documentRevisionCounterSql } = await import("@openbooks/engine/records/revision");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function context(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Sales command test",
        orgId,
        roles: [{ key: "sales-test", name: "Sales test" }],
        envKind: "sandbox",
        productionOrgId: orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function seedRegister(org: Awaited<ReturnType<typeof createScratchOrg>>, actorId: string) {
  const registerId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"cashSales":true,"posRegister":true}'::jsonb, true)
       where id = ${org.orgId}
    `);
    await db.execute(sql`
      insert into pos_registers
        (id, org_id, code, name, subsidiary_id, location_id, stock_location_id, default_customer_id, cash_account_id, denominations)
      values
        (${registerId}, ${org.orgId}, 'CMD', 'Command register', ${org.subsidiaryId}, ${org.locationId},
         ${org.stockLocationId}, ${org.customerId}, ${org.accounts.bank}, '{}'::text[])
    `);
  });
  await grantScratchPermissions(org.orgId, actorId, ["pos.drawer"]);
  return registerId;
}

test(
  "POS session commands open once, replay safely, and read through the native session query",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const userId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Sales operator", "register_manager"),
      );
      const registerId = await seedRegister(org, userId);
      const ctx = context(org.orgId, userId, ["pos.drawer"]);
      const run = (idempotencyKey: string) =>
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool("open_pos_session")!, ctx, {
            registerId,
            openingCount: [],
            idempotencyKey,
          }),
        );

      const first = (await run("sales-pos-open-0001")) as {
        replayed: boolean;
        session: { id: string };
      };
      assert.equal(first.replayed, false);
      const replay = (await run("sales-pos-open-0001")) as {
        replayed: boolean;
        session: { id: string };
      };
      assert.equal(replay.replayed, true);
      assert.equal(replay.session.id, first.session.id);

      const sessions = await withOrgContext(org.orgId, () =>
        listSessions(db, org.orgId, { registerId }, null),
      );
      assert.equal(sessions.rows.length, 1);
      assert.equal(sessions.rows[0]?.id, first.session.id);
      assert.equal(sessions.rows[0]?.status, "open");

      const closeInput = {
        sessionId: first.session.id,
        closingCount: [],
        idempotencyKey: "sales-pos-close-0001",
      };
      const closed = (await withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("close_pos_session")!, ctx, closeInput),
      )) as { replayed: boolean };
      assert.equal(closed.replayed, false);
      const closeReplay = (await withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("close_pos_session")!, ctx, closeInput),
      )) as { replayed: boolean };
      assert.equal(closeReplay.replayed, true);
      const closedSessions = await withOrgContext(org.orgId, () =>
        listSessions(db, org.orgId, { registerId }, null),
      );
      assert.equal(closedSessions.rows.length, 1);
      assert.equal(closedSessions.rows[0]?.status, "closed");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "quote conversion commands create an order and invoice that get_record can read",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const userId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Sales converter", "admin"),
      );
      const quoteId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{features}',
            coalesce(settings->'features', '{}'::jsonb) || '{"orders":true}'::jsonb, true)
           where id = ${org.orgId}
        `);
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
             currency, status, subtotal, tax_total, total, created_by, updated_by)
          values
            (${quoteId}, ${org.orgId}, 'quote', ${`Q-${quoteId.slice(0, 8)}`}, ${org.customerId},
             ${org.subsidiaryId}, ${org.date}, 'CAD', 'approved', '100', '0', '100', ${userId}, ${userId})
        `);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, description, quantity, unit,
             quantity_billed, quantity_fulfilled, unit_price, amount, tax_input_amount,
             tax_amount, created_by, updated_by)
          values
            (${org.orgId}, ${quoteId}, 1, ${org.accounts.revenue}, 'Implementation', '1', 'ea',
             '0', '0', '100', '100', '100', '0', ${userId}, ${userId})
        `);
      });
      const revision = (
        await withBypassContext(() =>
          db.execute<{ revision: string }>(
            sql`
            select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
              from documents where id = ${quoteId} and org_id = ${org.orgId}
          `,
            "objects",
          ),
        )
      )[0]!.revision;
      const ctx = context(org.orgId, userId, [
        "estimates.create",
        "estimates.read",
        "ar.create",
        "ar.read",
      ]);
      const convertQuote = () =>
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool("convert_quote_to_sales_order")!, ctx, {
            quoteId,
            expectedUpdatedAt: revision,
            idempotencyKey: "sales-quote-order-0001",
          }),
        );
      const first = (await convertQuote()) as { replayed: boolean; id: string };
      assert.equal(first.replayed, false);
      const replay = (await convertQuote()) as { replayed: boolean; id: string };
      assert.equal(replay.replayed, true);
      assert.equal(replay.id, first.id);

      const orderRead = (await withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("get_record")!, ctx, {
          typeKey: "sales-orders",
          id: first.id,
        }),
      )) as { record: { id: string; kind: string } };
      assert.equal(orderRead.record.id, first.id);
      assert.equal(orderRead.record.kind, "sales_order");

      const orderRevision = (
        await withBypassContext(() =>
          db.execute<{ revision: string }>(
            sql`
            select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
              from documents where id = ${first.id} and org_id = ${org.orgId}
          `,
            "objects",
          ),
        )
      )[0]!.revision;
      const invoice = (await withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("convert_sales_order_to_customer_invoice")!, ctx, {
          salesOrderId: first.id,
          expectedUpdatedAt: orderRevision,
          idempotencyKey: "sales-order-invoice-0001",
        }),
      )) as { id: string };
      const invoiceRead = (await withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("get_record")!, ctx, {
          typeKey: "invoices",
          id: invoice.id,
        }),
      )) as { record: { id: string; kind: string } };
      assert.equal(invoiceRead.record.id, invoice.id);
      assert.equal(invoiceRead.record.kind, "customer_invoice");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "POS commands enforce permission, feature, and organization boundaries",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const other = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Sales operator", "register_manager"),
      );
      const registerId = await seedRegister(org, actorId);
      const allowed = context(org.orgId, actorId, ["pos.drawer"]);

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          executeApplicationTool(
            applicationTool("open_pos_session")!,
            context(org.orgId, actorId, []),
            {
              registerId,
              openingCount: [],
              idempotencyKey: "sales-pos-denied-01",
            },
          ),
        ),
        /forbidden/,
      );

      await withBypassContext(() =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features,posRegister}', 'false'::jsonb, true)
       where id = ${org.orgId}
    `),
      );
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool("open_pos_session")!, allowed, {
            registerId,
            openingCount: [],
            idempotencyKey: "sales-pos-off-0001",
          }),
        ),
        /POS|register|disabled|turned off/i,
      );

      const foreignActor = await withBypassContext(() =>
        createScratchUser(other.orgId, "Foreign operator", "register_manager"),
      );
      await seedRegister(other, foreignActor);
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          executeApplicationTool(
            applicationTool("open_pos_session")!,
            context(other.orgId, foreignActor, ["pos.drawer"]),
            {
              registerId,
              openingCount: [],
              idempotencyKey: "sales-pos-cross-001",
            },
          ),
        ),
        /register not found|POS register/i,
      );
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);
