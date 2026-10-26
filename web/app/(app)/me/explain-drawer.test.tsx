import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// The Explain drawer is a pure function of its trace: capped deduction
// lines render their year-to-date, annual maximum, remaining room and the
// explicit capped note, while the Records row links the stub through the
// self-service view and leaves every other record plain text.

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript,const R=globalThis.React;" +
          "function el(tag){return function(p){return R.createElement(tag,{className:p&&p.className},p&&p.children)}};" +
          'export const Table=el("table");export const TableBody=el("tbody");' +
          'export const TableRow=el("tr");export const TableCell=el("td");' +
          'export function UrlDrawer(p){return R.createElement("div",{title:p.title},p.children)}',
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { renderToStaticMarkup } = await import("react-dom/server");
const { ExplainDrawer } = await import("./sections");

const STUB_ID = "00000000-0000-4000-8000-00000000d001";

function explain(trace: Record<string, unknown>) {
  return {
    stubId: STUB_ID,
    closeHref: "/me",
    title: "Payslip explanation",
    missing: null,
    grossLabel: "Gross",
    netLabel: "Net pay",
    employerCostLabel: "Employer cost",
    earningsTitle: "Earnings",
    deductionsTitle: "Deductions",
    contributionsTitle: "Employer contributions",
    inputsTitle: "Inputs",
    diffTitle: "Changed",
    sourcesTitle: "Records",
    ytdLabel: "Year to date",
    maximumLabel: "Annual maximum",
    remainingLabel: "Remaining before this stub",
    cappedNoteTemplate: "Annual maximum reached — this stub takes only the remaining {amount}",
    trace: {
      stubId: STUB_ID,
      employmentId: "00000000-0000-4000-8000-00000000e001",
      payRunDocumentId: "00000000-0000-4000-8000-00000000r001",
      payDate: "2026-11-30",
      gross: "6000.0000",
      netPay: "4200.0000",
      employerCost: "900.0000",
      earnings: [],
      deductions: [],
      employerContributions: [],
      benefitInputs: [],
      leaveInputs: [],
      wageRates: [],
      diffVsPrevious: { previousStubId: null, previousPayDate: null, changes: [] },
      sources: [],
      ...trace,
    },
  };
}

function deduction(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-00000000l001",
    componentId: "00000000-0000-4000-8000-00000000c001",
    kind: "deduction",
    description: "EI",
    hours: null,
    rate: null,
    amount: "123.0700",
    treatment: null,
    ytd: null,
    annualMaximum: null,
    remainingBeforeMax: null,
    capped: false,
    ...overrides,
  };
}

test("a capped line shows YTD, the maximum, remaining room, and the capped note", () => {
  const html = renderToStaticMarkup(
    React.createElement(ExplainDrawer, {
      explain: explain({
        deductions: [
          deduction({
            ytd: "1123.0700",
            annualMaximum: "1123.07",
            remainingBeforeMax: "123.0700",
            capped: true,
          }),
        ],
      }),
    }),
  );
  assert.ok(html.includes("Year to date 1123.0700"), "YTD must render beside the line");
  assert.ok(html.includes("Annual maximum 1123.07"), "the annual maximum must render");
  assert.ok(html.includes("Remaining before this stub 123.0700"), "remaining room must render");
  assert.ok(
    html.includes("Annual maximum reached — this stub takes only the remaining 123.0700"),
    "the capped note names the remaining amount taken",
  );
});

test("an uncapped line shows no note and a stub record links to the self-service view", () => {
  const inputId = "00000000-0000-4000-8000-00000000i001";
  const html = renderToStaticMarkup(
    React.createElement(ExplainDrawer, {
      explain: explain({
        deductions: [
          deduction({
            id: "00000000-0000-4000-8000-00000000l002",
            ytd: "50.0000",
            annualMaximum: "1123.07",
            remainingBeforeMax: "1123.0700",
            capped: false,
          }),
          deduction({
            id: "00000000-0000-4000-8000-00000000l003",
            description: "Income tax",
            amount: "500.0000",
          }),
        ],
        sources: [
          { kind: "pay_stub", id: STUB_ID },
          { kind: "hrm_payroll_input", id: inputId },
        ],
      }),
    }),
  );
  assert.ok(!html.includes("Annual maximum reached"), "no capped note without a reached maximum");
  assert.ok(
    html.includes(`<a class="underline" href="/me?explain=${STUB_ID}">pay_stub · ${STUB_ID}</a>`),
    "the stub record must link through the self-service view",
  );
  assert.ok(
    html.includes(`hrm_payroll_input · ${inputId}`) && !html.includes(`explain=${inputId}`),
    "other records stay plain text",
  );
});
