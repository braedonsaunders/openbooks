import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { inflateSync } from "node:zlib";
import test from "node:test";
import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";

// Account-register exports stamp the org business day: the xlsx workbook's
// created/modified properties and the PDF bytes carry it, and the download
// filename names it. The route, the register query, the business-day clock,
// and both exporters are real; only the access boundary (auth gate,
// translations) is seammed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.endsWith("/lib/authz")) {
      return { shortCircuit: true, url: "mock:register-export-gate" };
    }
    if (specifier === "next-intl/server") {
      return { shortCircuit: true, url: "mock:register-export-intl" };
    }
    if (specifier.startsWith("@/")) {
      const path = `../${specifier.slice(2)}`;
      return {
        shortCircuit: true,
        url: new URL(path.endsWith(".ts") ? path : `${path}.ts`, import.meta.url).href,
      };
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
    if (url === "mock:register-export-intl") {
      return {
        format: "module",
        shortCircuit: true,
        source: `export async function getTranslations() { return (key) => key }`,
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
