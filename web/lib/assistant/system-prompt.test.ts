import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { fiscalContextFor } from "@openbooks/reports";
import { assistantSystemPrompt, fiscalCalendarLine } from "./system-prompt";

// An April-start org (the configuration that exposed the calendar-year YTD
// defect) must yield a prompt that states fiscal boundaries explicitly.

describe("assistantSystemPrompt fiscal context", () => {
  const fiscal = fiscalContextFor("2026-08-16", 4);
  const prompt = assistantSystemPrompt({
    orgName: "Northfield Services Inc",
    baseCurrency: "CAD",
    userName: "Alex",
    today: "2026-08-16",
    fiscal,
    canWrite: false,
  });

  it("states the fiscal year start month and exact FY boundaries", () => {
    assert.match(prompt, /fiscal year starts on April 1/);
    assert.match(prompt, /FY 2027 \(2026-04-01 – 2027-03-31\)/);
  });

  it("states fiscal YTD and the PYTD comparative with exact dates", () => {
    assert.match(prompt, /Fiscal year to date is 2026-04-01 – 2026-08-16/);
    assert.match(prompt, /PYTD\) is 2025-04-01 – 2025-08-16/);
  });

  it("declares relative period language fiscal by default and steers to presets", () => {
    assert.match(prompt, /Relative period language is FISCAL by default/);
    assert.match(prompt, /this_fiscal_year_to_date/);
  });

  it("steers analytics requests to the analytics_* dashboard tools", () => {
    assert.match(prompt, /analytics_\* dashboard tools/);
  });

  it("renders the current fiscal quarter", () => {
    assert.match(prompt, /fiscal quarter Q2 \(2026-07-01 – 2026-09-30\)/);
  });
});

describe("fiscalCalendarLine", () => {
  it("degenerates cleanly for a January (calendar-year) org", () => {
    const line = fiscalCalendarLine(fiscalContextFor("2026-08-16", 1));
    assert.match(line, /fiscal year starts on January 1/);
    assert.match(line, /FY 2026 \(2026-01-01 – 2026-12-31\)/);
  });
});
