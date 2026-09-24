import assert from "node:assert/strict";
import test from "node:test";
import { resolveDriverVintage } from "./driver-asof.ts";
import type { db } from "../platform/db.ts";

type Runner = Pick<typeof db, "execute">;

/** Stub runner answering period reads by matching the query text. */
function stubRunner(opts: {
  covering: Record<string, string | number> | null;
  priorId: string | null;
}): Runner {
  return {
    execute: (async (query: unknown) => {
      const text = JSON.stringify(query);
      if (text.includes("fiscal_calendars")) {
        return { rows: opts.covering ? [opts.covering] : [] };
      }
      if (text.includes("ends_on <")) {
        return { rows: opts.priorId ? [{ id: opts.priorId }] : [] };
      }
      return { rows: [] };
    }) as Runner["execute"],
  };
}

const JULY = { id: "jul", name: "2026-07", startsOn: "2026-07-01", endsOn: "2026-07-31" };
const JULY_ROW = {
  id: "jul",
  fiscal_calendar_id: "cal",
  fiscal_year: 2026,
  period_number: 7,
  name: "2026-07",
  starts_on: "2026-07-01",
  ends_on: "2026-07-31",
};

function runner(): Runner {
  return stubRunner({ covering: JULY_ROW, priorId: "jun" });
}

test("a sweep and a posting in the same period measure the same vintage", async () => {
  // prior_period: the July sweep and a July posting both read June.
  const sweep = await resolveDriverVintage(runner(), "org-1", "prior_period", { kind: "period", period: JULY });
  const posting = await resolveDriverVintage(runner(), "org-1", "prior_period", {
    kind: "posting",
    postingDate: "2026-07-15",
    documentDate: "2026-07-15",
  });
  assert.deepEqual(sweep, { asOf: { periodId: "jun" } });
  assert.deepEqual(posting, sweep);
  // period: both read July itself.
  const sweepCurrent = await resolveDriverVintage(runner(), "org-1", "period", { kind: "period", period: JULY });
  const postingCurrent = await resolveDriverVintage(runner(), "org-1", "period", {
    kind: "posting",
    postingDate: "2026-07-15",
    documentDate: "2026-07-15",
  });
  assert.deepEqual(sweepCurrent, { asOf: { periodId: "jul" } });
  assert.deepEqual(postingCurrent, sweepCurrent);
});

test("document_date at posting reads the document date, not the posting date", async () => {
  const vintage = await resolveDriverVintage(runner(), "org-1", "document_date", {
    kind: "posting",
    postingDate: "2026-08-05",
    documentDate: "2026-07-15",
  });
  assert.deepEqual(vintage, { asOf: { date: "2026-07-15" } });
});

test("a sweep without a document reads its period end for document_date", async () => {
  const vintage = await resolveDriverVintage(runner(), "org-1", "document_date", { kind: "period", period: JULY });
  assert.deepEqual(vintage, { asOf: { date: "2026-07-31" } });
});

test("a vintage with no honest window is a refusal, never a live measure", async () => {
  const noPrior = await resolveDriverVintage(
    stubRunner({ covering: JULY_ROW, priorId: null }),
    "org-1",
    "prior_period",
    { kind: "posting", postingDate: "2026-07-15", documentDate: "2026-07-15" },
  );
  assert.deepEqual(noPrior, { refusal: "no prior period exists for driver lookback on 2026-07" });
  const noCover = await resolveDriverVintage(
    stubRunner({ covering: null, priorId: "jun" }),
    "org-1",
    "prior_period",
    { kind: "posting", postingDate: "2026-07-15", documentDate: "2026-07-15" },
  );
  assert.deepEqual(noCover, { refusal: "no accounting period covers the posting date for driver lookback" });
});
