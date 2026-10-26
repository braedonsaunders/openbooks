import { installEngineSeams } from "@openbooks/engine/composition/install";
installEngineSeams();
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "@openbooks/engine/testing/fixtures";
import { fromUnits, toUnits } from "@openbooks/engine/money/money";
import { postEntry } from "@openbooks/engine/testing/journal/post-entry";
import {
  importStatement,
  startReconciliation,
  createMatch,
  markReconciled,
} from "@openbooks/engine/banking/banking";
import { withAuthzContext } from "../../../../../../lib/authz-context";
import type { Authz } from "../../../../../../lib/authz";
import { GET, POST } from "./route.ts";
import { POST as signOff } from "../sign-off/route.ts";
import { PATCH as adjust } from "../route.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

test(
  "native review-only API records independent evidence while sign-off and adjustment remain forbidden",
  enabled,
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const signer = await withBypassContext(() =>
        createScratchUser(org.orgId, "Original signer", "signer"),
      );
      const reviewer = await withBypassContext(() =>
        createScratchUser(org.orgId, "Independent evidence reviewer", "reviewer"),
      );
      await withBypassContext(async () => {
        assert.equal(
          (
            await db.execute(
              sql`update app_roles set permissions=case when key='reviewer'
        then '["banking.read","banking.review_sign_off"]'::jsonb else '["banking.reconcile","gl.post"]'::jsonb end
        where org_id=${org.orgId} and key in ('signer','reviewer') returning id`,
              "objects",
            )
          ).length,
          2,
        );
        assert.equal(
          (
            await db.execute(
              sql`update orgs set settings=jsonb_set(settings,'{features,banking}','true'::jsonb)
        where id=${org.orgId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update accounts set reconcilable=true,currency_restriction='CAD',subsidiary_id=${org.subsidiaryId}
        where org_id=${org.orgId} and id=${org.accounts.bank} returning id`,
              "objects",
            )
          ).length,
          1,
        );
      });
      const signerCtx = { orgId: org.orgId, userId: signer, allowedSubsidiaryIds: null };
      const inOrg = <T>(fn: () => Promise<T>) => withOrgContext(org.orgId, fn);
      const entry = async (amount: string) => {
        const posted = await postEntry(db, {
          orgId: org.orgId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          periodId: org.periodId,
          postingDate: org.date,
          entryNumber: `REVIEW-${randomUUID()}`,
          origin: "manual",
          actorId: signer,
          currency: "CAD",
          lines: [
            { accountId: org.accounts.bank, amount, txnAmount: amount, fxRate: "1" },
            {
              accountId: org.accounts.adjustment,
              amount: fromUnits(-toUnits(amount)),
              txnAmount: fromUnits(-toUnits(amount)),
              fxRate: "1",
            },
          ],
        });
        return (
          await db.execute<{ id: string }>(
            sql`select id from journal_lines where org_id=${org.orgId}
        and entry_id=${posted.entryId} and account_id=${org.accounts.bank}`,
            "objects",
          )
        )[0]!.id;
      };
      const id = await inOrg(async () => {
        const line = await entry("250.00");
        const content = `date,amount,description,bank_transaction_id\n${org.date},250.00,Deposit,deposit\n`;
        const statement = await importStatement(
          {
            accountId: org.accounts.bank,
            source: "csv",
            statementDate: org.date,
            currency: "CAD",
            lines: [
              {
                postedOn: org.date,
                amount: "250.00",
                description: "Deposit",
                bankTransactionId: "deposit",
              },
            ],
            sourceEvidence: {
              content,
              filename: "statement.csv",
              contentType: "text/csv",
              csvMapping: { date: 0, amount: 1, description: 2, bankTransactionId: 3 },
            },
          },
          signerCtx,
        );
        const statementLine = (
          await db.execute<{ id: string }>(
            sql`select id from bank_statement_lines
        where org_id=${org.orgId} and statement_id=${statement.statementId}`,
            "objects",
          )
        )[0]!.id;
        const session = await startReconciliation(
          { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "250.00" },
          signerCtx,
        );
        await createMatch(
          {
            reconciliationId: session.id,
            statementLineIds: [statementLine],
            journalLineIds: [line],
          },
          signerCtx,
        );
        await markReconciled(session.id, signerCtx);
        await entry("5.00");
        await entry("-5.00");
        return session.id;
      });
      const principal = {
        user: { orgId: org.orgId, id: reviewer },
        permissions: new Set(["banking.read", "banking.review_sign_off"]),
        allowedSubsidiaryIds: null,
      } as Authz;
      const request = (method: string, body?: unknown) =>
        new Request(`http://openbooks.test/api/banking/reconciliations/${id}/revalidate-sign-off`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        });
      const call = <T>(fn: () => Promise<T>) => inOrg(() => withAuthzContext(principal, fn));
      const params = { params: Promise.resolve({ id }) };
      const evidence = () =>
        inOrg(async () => ({
          recon: await db.execute(
            sql`select to_jsonb(r)::text as value from reconciliations r where org_id=${org.orgId} and id=${id}`,
            "objects",
          ),
          matches: await db.execute(
            sql`select to_jsonb(m)::text as value from reconciliation_matches m where org_id=${org.orgId} order by id`,
            "objects",
          ),
          lines: await db.execute(
            sql`select to_jsonb(l)::text as value from journal_lines l where org_id=${org.orgId} order by id`,
            "objects",
          ),
        }));
      const before = await evidence();
      assert.equal((await call(() => signOff(request("POST"), params))).status, 403);
      assert.equal(
        (await call(() => adjust(request("PATCH", { statementBalance: "251.00" }), params))).status,
        403,
      );
      const preview = await call(() => GET(request("GET"), params));
      assert.equal(preview.status, 200, await preview.clone().text());
      const basis = (await preview.json()) as { proof: { digest: string } };
      const reason =
        "Independent review of unchanged signed balances and retained neutral movements";
      const body = { expectedDigest: basis.proof.digest, reason };
      const recorded = await call(() => POST(request("POST", body), params));
      assert.equal(recorded.status, 200, await recorded.clone().text());
      assert.equal(((await recorded.json()) as { replayed: boolean }).replayed, false);
      assert.equal(
        (
          (await (await call(() => POST(request("POST", body), params))).json()) as {
            replayed: boolean;
          }
        ).replayed,
        true,
      );
      assert.deepEqual(await evidence(), before);
      principal.permissions = new Set(["banking.read"]);
      assert.equal((await call(() => GET(request("GET"), params))).status, 403);
      principal.permissions = new Set(["banking.read", "banking.review_sign_off"]);
      await withBypassContext(() =>
        db.execute(sql`update app_roles set permissions='["banking.read"]'::jsonb
      where org_id=${org.orgId} and key='reviewer'`),
      );
      assert.equal(
        (await call(() => POST(request("POST", body), params))).status,
        404,
        "a stale session cannot replay after native duty revocation",
      );
      const audits = await inOrg(() =>
        db.execute<{ actor_id: string; reason: string }>(
          sql`select actor_id,changes->>'reason' as reason
      from audit_log where org_id=${org.orgId} and row_id=${id} and changes->>'operation'='revalidate_sign_off'`,
          "objects",
        ),
      );
      assert.deepEqual(audits, [{ actor_id: reviewer, reason }]);
      assert.deepEqual(await evidence(), before);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
