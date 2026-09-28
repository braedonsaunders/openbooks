import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { accountRegister } = await import('./reports/registers.ts')

// The register's lines and its independent totals read the same posted
// set: a draft entry visible in the same account must move neither.
test('the account register shows only posted ledger entries in lines and totals', async () => {
  await withBypassContext(async () => {
    const scratch = await createScratchOrg()
    try {
      const accountId = randomUUID()
      const offsetAccountId = randomUUID()
      const postedEntryId = randomUUID()
      const draftEntryId = randomUUID()
      await withBypassContext(async () => {
        await db.execute(sql`
          insert into accounts (id, org_id, number, name, type, is_summary, is_active)
          values
            (${accountId}, ${scratch.orgId}, 'RGO-1', 'Posted-only register', 'asset_bank', false, true),
            (${offsetAccountId}, ${scratch.orgId}, 'RGO-2', 'Posted-only offset', 'income', false, true)
        `)
        for (const [entryId, status, amount] of [
          [postedEntryId, 'posted', '100.0000'],
          [draftEntryId, 'draft', '40.0000'],
        ] as const) {
          await db.execute(sql`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
            values
              (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, ${`RGO-${status}`},
               ${scratch.date}, ${scratch.periodId}, 'draft', 'manual')
          `)
          await db.execute(sql`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
            values
              (${scratch.orgId}, ${entryId}, 1, ${accountId}, ${scratch.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
              (${scratch.orgId}, ${entryId}, 2, ${offsetAccountId}, ${scratch.subsidiaryId}, ${`-${amount}`} , 'CAD', ${`-${amount}`}, '1')
          `)
          if (status === 'posted') {
            await db.execute(sql`
              update journal_entries set status = 'posted', posted_at = now()
               where id = ${entryId} and org_id = ${scratch.orgId}
            `)
          }
        }
      })

      const register = await accountRegister(scratch.orgId, accountId, 100, 0, undefined, null, scratch.bookId)
      assert.equal(register.total, 1, 'only the posted line counts toward the total')
      assert.equal(register.lines.length, 1, 'only the posted line is listed')
      assert.equal(register.lines[0]?.amount, '100.0000')
      assert.equal(register.balance, '100.0000', 'the draft 40.0000 moves neither lines nor balance')
    } finally { await dropScratchOrg(scratch.orgId) }
  })
})


const consolidatedRows = [
  { label: "account register export calendar", register: async () => {
        const { registerHooks } = await import("node:module");
        const { inflateSync } = await import("node:zlib");
        const ExcelJS = (await import("exceljs")).default;
        const { stubModules } = await import("../testing/stub-modules.ts");
        // Account-register exports stamp the org business day: the xlsx workbook's
        // created/modified properties and the PDF bytes carry it, and the download
        // filename names it. The route, the register query, the business-day clock,
        // and both exporters are real; only the access boundary (auth gate,
        // translations) is seammed.
        stubModules({ intl: true, navigation: false, authz: false, features: false });

        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier.endsWith("/lib/authz")) {
              return { shortCircuit: true, url: "mock:register-export-gate" };
            }
            return nextResolve(specifier, context);
          },
          load(url, context, nextLoad) {
            if (url === "mock:register-export-gate") {
              return {
                format: "module",
                shortCircuit: true,
                source: `import { permissionSetCovers } from '${enginePermissionsUrl}'
                  const key = Symbol.for('openbooks.register-export-gate')
                  export async function getAuthz() { return globalThis[key] }
                  export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }`,
              };
            }
            return nextLoad(url, context);
          },
        });

        const gateKey = Symbol.for("openbooks.register-export-gate");
        const enginePermissionsUrl = new URL(
          "../../engine/src/organization/permissions.ts",
          import.meta.url,
        ).href;
        const { db, withBypassContext: withBypass } = await import(
          "@openbooks/engine/src/platform/db.ts"
        );
        const { createScratchOrg, dropScratchOrg } = await import(
          "@openbooks/engine/src/testing/fixtures.ts"
        );
        const { businessToday } = await import("@openbooks/engine/src/platform/business-date.ts");
        const { GET } = await import("../app/api/accounts/[id]/register/route.ts");

        function pdfContentText(pdf: Buffer): string {
          const text = [pdf.toString("latin1")];
          let cursor = 0;
          while (true) {
            const marker = pdf.indexOf(Buffer.from("stream"), cursor);
            if (marker < 0) break;
            let start = marker + "stream".length;
            if (pdf[start] === 13 && pdf[start + 1] === 10) start += 2;
            else if (pdf[start] === 10) start += 1;
            else {
              cursor = start;
              continue;
            }
            const end = pdf.indexOf(Buffer.from("endstream"), start);
            if (end < 0) break;
            let stream = pdf.subarray(start, end);
            while (stream.length > 0 && (stream[stream.length - 1] === 10 || stream[stream.length - 1] === 13)) {
              stream = stream.subarray(0, -1);
            }
            try {
              stream = inflateSync(stream);
            } catch {
              // Uncompressed PDF streams already contain readable PDF operators.
            }
            const streamText = stream.toString("latin1");
            text.push(streamText);
            // PDFKit encodes shown text as hex runs; decode those runs to assert on
            // the reader-visible footer rather than the producer's stream bytes.
            for (const hex of streamText.matchAll(/<([0-9A-Fa-f]+)>/g)) {
              text.push(Buffer.from(hex[1] ?? "", "hex").toString("latin1"));
            }
            cursor = end + "endstream".length;
          }
          return text.join("\n");
        }

        async function seedRegister(scratch: { orgId: string; bookId: string; subsidiaryId: string; date: string; periodId: string }): Promise<string> {
          const accountId = randomUUID();
          const offsetAccountId = randomUUID();
          const entryId = randomUUID();
          await withBypass(async () => {
            await db.execute(sql`
              insert into accounts (id, org_id, number, name, type, is_summary, is_active)
              values
                (${accountId}, ${scratch.orgId}, 'RXE-1', 'Export register', 'asset_bank', false, true),
                (${offsetAccountId}, ${scratch.orgId}, 'RXE-2', 'Export offset', 'income', false, true)
            `);
            await db.execute(sql`
              insert into journal_entries
                (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
              values
                (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'RXE-1',
                 ${scratch.date}, ${scratch.periodId}, 'draft', 'manual')
            `);
            await db.execute(sql`
              insert into journal_lines
                (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
              values
                (${scratch.orgId}, ${entryId}, 1, ${accountId}, ${scratch.subsidiaryId}, '250.0000', 'CAD', '250.0000', '1'),
                (${scratch.orgId}, ${entryId}, 2, ${offsetAccountId}, ${scratch.subsidiaryId}, '-250.0000', 'CAD', '-250.0000', '1')
            `);
            await db.execute(sql`
              update journal_entries set status = 'posted', posted_at = now()
               where id = ${entryId} and org_id = ${scratch.orgId}
            `);
          });
          return accountId;
        }

        function gateFor(orgId: string): void {
          (globalThis as typeof globalThis & Record<symbol, unknown>)[gateKey] = {
            user: { id: "register-export-test", orgId },
            permissions: new Set(["gl.read", "data.export"]),
            allowedSubsidiaryIds: null,
          };
        }

        test("the register xlsx stamps the workbook and filename from the org business day", async () => {
          const scratch = await withBypass(() => createScratchOrg());
          try {
            gateFor(scratch.orgId);
            const accountId = await seedRegister(scratch);
            const stamp = await withBypass(() => businessToday(scratch.orgId));

            const response = await GET(
              new Request(`http://openbooks.test/api/accounts/${accountId}/register?format=xlsx`),
              { params: Promise.resolve({ id: accountId }) },
            );
            assert.equal(response.status, 200);
            const disposition = response.headers.get("content-disposition") ?? "";
            assert.ok(disposition.includes(stamp), "the download filename names the business day");

            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer);
            for (const property of [workbook.created, workbook.modified] as const) {
              assert.ok(property instanceof Date, "workbook properties arrive as dates");
              assert.equal(property.toISOString().slice(0, 10), stamp);
            }
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId));
          }
        });

        test("the register PDF branch serves the stamped download", async () => {
          const scratch = await withBypass(() => createScratchOrg());
          try {
            gateFor(scratch.orgId);
            const accountId = await seedRegister(scratch);
            const stamp = await withBypass(() => businessToday(scratch.orgId));

            const response = await GET(
              new Request(`http://openbooks.test/api/accounts/${accountId}/register?format=pdf`),
              { params: Promise.resolve({ id: accountId }) },
            );
            assert.equal(response.status, 200);
            assert.ok((response.headers.get("content-type") ?? "").includes("pdf"));
            const disposition = response.headers.get("content-disposition") ?? "";
            assert.ok(disposition.includes(stamp), "the download filename names the business day");
            const pdf = Buffer.from(await response.arrayBuffer());
            assert.ok(pdf.length > 1000, "a real PDF document came back");
            assert.ok(pdfContentText(pdf).includes(stamp), "the rendered PDF footer carries the business-day stamp");
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId));
          }
        });

        test("the PDF document input carries the business-day stamp into the footer", async () => {
          const { exportDataToPdfInput } = await import("./report-pdf.ts");
          const generatedAt = new Date("2024-02-29T00:00:00Z");
          const input = exportDataToPdfInput(
            { title: "Register", dateRangeLabel: "", groups: [], summary: [] },
            { orgName: "Stamp probe" },
            { paperSize: "letter", orientation: "landscape", marginMm: 12, density: "compact" },
            { generatedAt },
          );
          assert.deepEqual(input.generatedAt, generatedAt, "the stamp reaches the rendered footer input");
        });
  } },
  { label: "account register subsidiary", register: async () => {
        const { sql } = await import('drizzle-orm')
        const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { accountRegister, partyRegister } = await import('./reports/registers')

        test('account registers scope both lines and totals within a visible intercompany header', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const child = randomUUID(), entry = randomUUID(), sourceDoc = randomUUID()
            await withBypass(async () => {
              await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
                values (${child}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Other entity', 'CAD', 'CA')`)
              await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
                values (${sourceDoc}, ${scratch.orgId}, 'sales_invoice', 'draft', 'HIDDEN-DOC', ${scratch.date}, ${child}, 'CAD', 0, 0, 0, '{}'::jsonb)`)
              await db.execute(sql`insert into journal_entries
                (id, org_id, book_id, subsidiary_id, source_document_id, entry_number, posting_date, period_id, status, origin)
                values (${entry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, ${sourceDoc},
                  'REGISTER-SCOPE', ${scratch.date}, ${scratch.periodId}, 'draft', 'manual')`)
              await db.execute(sql`insert into journal_lines
                (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
                values (${scratch.orgId}, ${entry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, '100', 'CAD', '100', '1'),
                  (${scratch.orgId}, ${entry}, 2, ${scratch.accounts.bank}, ${child}, '-100', 'CAD', '-100', '1'),
                  (${scratch.orgId}, ${entry}, 3, ${scratch.accounts.ar}, ${scratch.subsidiaryId}, '-100', 'CAD', '-100', '1'),
                  (${scratch.orgId}, ${entry}, 4, ${scratch.accounts.revenue}, ${child}, '100', 'CAD', '100', '1')`)
              await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
            })
            const { scoped, childScoped, all, none, scopedAr } = await withOrgContext(scratch.orgId, async () => {
              const scoped = await accountRegister(scratch.orgId, scratch.accounts.bank, 100, 0, undefined, new Set([scratch.subsidiaryId]))
              const childScoped = await accountRegister(scratch.orgId, scratch.accounts.bank, 100, 0, undefined, new Set([child]))
              const all = await accountRegister(scratch.orgId, scratch.accounts.bank)
              const none = await accountRegister(scratch.orgId, scratch.accounts.bank, 100, 0, undefined, new Set())
              const scopedAr = await partyRegister("ar", { from: scratch.date, to: scratch.date, orgId: scratch.orgId, dims: { subsidiaryIds: [scratch.subsidiaryId] } })
              return { scoped, childScoped, all, none, scopedAr }
            })
            assert.equal(scoped.total, 1)
            assert.equal(scoped.balance, '100.0000')
            assert.equal(scoped.lines[0]?.doc_id, null)
            assert.equal(scoped.lines[0]?.amount, '100.0000')
            assert.equal(childScoped.total, 1)
            assert.equal(childScoped.balance, '-100.0000')
            assert.equal(childScoped.lines[0]?.amount, '-100.0000')
            assert.equal(all.total, 2)
            assert.equal(all.balance, '0.0000')
            assert.equal(none.total, 0)
            assert.equal(none.lines.length, 0)
            assert.deepEqual(scopedAr.parties.flatMap((section) => section.lines.map((line) => line.docId)), [null])
          } finally { await withBypass(() => dropScratchOrg(scratch.orgId)) }
        })

        test('account registers hide the header of an out-of-scope account even with no visible lines', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const other = randomUUID()
            const foreignAccount = randomUUID()
            const sharedAccount = randomUUID()
            await withBypass(async () => {
              await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
                values (${other}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Foreign entity', 'CAD', 'CA')`)
              await db.execute(sql`insert into accounts (id, org_id, number, name, type, subsidiary_id)
                values (${foreignAccount}, ${scratch.orgId}, '9301', 'Foreign scoped account', 'asset_other', ${other}),
                       (${sharedAccount}, ${scratch.orgId}, '9302', 'Shared chart account', 'asset_other', null)`)
            })
            const { hidden, visible, shared } = await withOrgContext(scratch.orgId, async () => {
              const hidden = await accountRegister(scratch.orgId, foreignAccount, 100, 0, undefined, new Set([scratch.subsidiaryId]))
              const visible = await accountRegister(scratch.orgId, foreignAccount, 100, 0, undefined, new Set([other]))
              const shared = await accountRegister(scratch.orgId, sharedAccount, 100, 0, undefined, new Set([other]))
              return { hidden, visible, shared }
            })
            // The header carries number, name and balance: without the header check
            // the out-of-scope account metadata would leak on an empty line list.
            assert.equal(hidden.account, undefined)
            assert.equal(hidden.total, 0)
            assert.deepEqual(hidden.lines, [])
            assert.ok(visible.account, 'the owning entity still reads its own header')
            assert.ok(shared.account, 'the shared chart header reads for every caller')
          } finally { await withBypass(() => dropScratchOrg(scratch.orgId)) }
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();
