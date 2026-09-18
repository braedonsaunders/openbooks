/**
 * Scheduler-tick helper for the subscription-to-revenue E2E workflow.
 *
 * The Playwright runner loads spec files through a CommonJS transform, which
 * cannot import the engine's ESM modules (`import.meta` in db.ts). So the
 * spec does not import the engine in-process; it spawns this script with tsx
 * (the same runner CI uses for `seed-e2e-approver.ts`) and reads JSON off
 * stdout. Each invocation is one short-lived process against the scratch
 * database named by OPENBOOKS_DB_URL.
 *
 * Every command here is scheduler-owned surface with no HTTP route by design:
 * firing the real dunning tick (`runDunningForOrg`, the exact function the
 * worker calls) and read probes over the product's own dunning/contract
 * tables. All money the ticks act on is seeded and asserted through product
 * HTTP routes and rendered pages in the spec.
 *
 * Usage: scheduler-tick.mts <command> [args...]
 *   org <adminEmail>
 *   obligations <orgId> <contractNumber,contractNumber,...>
 *   contract <orgId> <contractNumber>
 *   dunning-run <orgId> <asOfDate>
 *   dunning-log <orgId>
 *   dunning-outbox <orgId>
 *   docs <orgId> <partyId>
 */
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../../../engine/src/db.ts";
import { runDunningForOrg } from "../../../engine/src/dunning.ts";

function emit(value: unknown): void {
  console.log(`W5TICK ${JSON.stringify(value)}`);
}

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (command) {
    case "org": {
      const [email] = args;
      // Identity bootstrap: this resolves WHICH org to scope to, so it cannot
      // run inside withOrg. Under FORCE row-level security as the constrained
      // runtime role an unscoped read returns zero rows SILENTLY, which
      // surfaced as "no user e2e@openbooks.test" against a database that has
      // one. withBypassContext is the documented remedy for exactly this.
      const rows = (
        await withBypassContext(() =>
          db.execute<{ orgId: string }>(sql`
            select u.org_id as "orgId" from users u where u.email = ${email} order by u.created_at limit 1
          `),
        )
      ).rows;
      if (!rows[0]) throw new Error(`no user ${email}`);
      emit({ orgId: rows[0].orgId });
      return;
    }
    case "obligations": {
      const [orgId, csv] = args;
      const contracts = String(csv).split(",").filter(Boolean);
      const res = await withOrg(String(orgId), () =>
        db.execute<Record<string, unknown>>(sql`
          select c.contract_number as "contract", o.id
            from performance_obligations o
            join revenue_contracts c on c.id = o.contract_id
           where c.contract_number = any(${`{${contracts.join(",")}}`}::text[])
        `),
      );
      emit({ obligations: Object.fromEntries(res.rows.map((r) => [String(r.contract), String(r.id)])) });
      return;
    }
    case "contract": {
      const [orgId, number] = args;
      const res = await withOrg(String(orgId), () =>
        db.execute<Record<string, unknown>>(sql`
          select id from revenue_contracts where contract_number = ${number} limit 1
        `),
      );
      if (!res.rows[0]) throw new Error(`no contract ${number}`);
      emit({ id: String(res.rows[0].id) });
      return;
    }
    case "dunning-run": {
      const [orgId, asOf] = args;
      const result = await withOrg(String(orgId), () => runDunningForOrg(String(orgId), String(asOf)));
      emit({ result });
      return;
    }
    case "dunning-log": {
      const [orgId] = args;
      const res = await withOrg(String(orgId), () =>
        db.execute<Record<string, unknown>>(sql`
          select d.document_number as "documentNumber", st.sequence, st.name as "stageName",
                 dl.amount_due as "amountDue", dl.status, dl.to_email as "toEmail"
            from dunning_log dl
            join documents d on d.id = dl.document_id
            join dunning_stages st on st.id = dl.stage_id
           order by dl.sent_at, st.sequence
        `),
      );
      emit({
        log: res.rows.map((r) => ({
          documentNumber: String(r.documentNumber),
          sequence: Number(r.sequence),
          stageName: String(r.stageName),
          amountDue: String(r.amountDue),
          status: String(r.status),
          toEmail: r.toEmail == null ? null : String(r.toEmail),
        })),
      });
      return;
    }
    case "docs": {
      // Posted document ids for a party by kind (re-entry probe: pick up ids
      // a dead chunk seeded but never saved to the state file).
      const [orgId, partyId] = args;
      const res = await withOrg(String(orgId), () =>
        db.execute<Record<string, unknown>>(sql`
          select id, document_number as "number", kind, status
            from documents
           where org_id = ${String(orgId)} and party_id = ${String(partyId)}
             and kind in ('customer_invoice', 'customer_credit', 'customer_payment')
           order by created_at
        `),
      );
      emit({
        docs: res.rows.map((r) => ({
          id: String(r.id),
          number: String(r.number),
          kind: String(r.kind),
          status: String(r.status),
        })),
      });
      return;
    }
    case "dunning-outbox": {
      const [orgId] = args;
      const res = await withOrg(String(orgId), () =>
        db.execute<Record<string, unknown>>(sql`
          select payload from scheduler_outbox
           where occurrence_key like 'dunning:%' order by created_at
        `),
      );
      emit({
        outbox: res.rows.map((r) => {
          const payload = r.payload as { subject?: unknown; to?: unknown };
          return {
            subject: String(payload?.subject ?? ""),
            to: Array.isArray(payload?.to) ? payload.to.map(String).join(",") : "",
          };
        }),
      });
      return;
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`W5TICK-ERROR ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
