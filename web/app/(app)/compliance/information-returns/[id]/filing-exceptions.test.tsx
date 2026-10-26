import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import "../../../dashboard/_dashboard-render-harness";
import { mountDashboard } from "../../../dashboard/_dashboard-render-harness";
import type { FilingDetail } from "../../../../../lib/compliance";

// Await-imports so module hooks from the harness are registered first.
const { FilingExceptionList } = await import("./FilingExceptionList");
const { FilingWorksheet } = await import("./FilingWorksheet");

const dir = dirname(fileURLToPath(import.meta.url));
const MESSAGES = join(dir, "..", "..", "..", "..", "..", "messages");
const loadCompliance = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(MESSAGES, locale, "compliance.json"), "utf8")) as Record<
    string,
    unknown
  >;

const EXCEPTIONS = [
  {
    kind: "corporation_flagged",
    partyName: "Ace Framing",
    detail: "classified c_corp — corporations are generally not reportable",
    message: 'vendor "Ace Framing": classified c_corp — corporations are generally not reportable',
    remedy:
      "if it is not reportable, clear the reportable flag on the vendor record or exclude the recipient with a reason",
  },
  {
    kind: "missing_form_assignment",
    partyName: "Birch Supply",
    detail: "flagged as reportable but no information return is assigned",
    message:
      'vendor "Birch Supply" is flagged as reportable but has no information return assigned',
    remedy:
      "assign one on the vendor record (or clear the reportable flag), then recompute before finalizing",
  },
];

function draftFiling(): FilingDetail {
  return {
    id: "filing-1",
    taxYear: 2025,
    formType: "1099-NEC",
    status: "draft",
    threshold: "600",
    currency: "USD",
    subsidiaryName: null,
    computedAt: null,
    finalizedAt: null,
    filedAt: null,
    filingChannel: null,
    filingReference: null,
    includedCount: 0,
    excludedCount: 0,
    missingTinCount: 0,
    filedTotal: "0",
    payerSnapshot: {},
    notes: null,
    recipients: [],
  };
}

test("the exception list names each exception and its remedy", async () => {
  const { unmount } = await mountDashboard(<FilingExceptionList exceptions={EXCEPTIONS} />, {
    compliance: loadCompliance("en"),
  });
  try {
    const html = document.body.innerHTML;
    for (const exception of EXCEPTIONS) {
      assert.ok(html.includes(exception.message), `shows the message for ${exception.kind}`);
      assert.ok(html.includes(exception.remedy), `shows the remedy for ${exception.kind}`);
    }
  } finally {
    await unmount();
  }
});

test("the exception list renders nothing when a compute found no exceptions", async () => {
  const { host, unmount } = await mountDashboard(<FilingExceptionList exceptions={[]} />, {
    compliance: loadCompliance("en"),
  });
  try {
    assert.equal(host.textContent, "");
  } finally {
    await unmount();
  }
});

test("computing a filing shows every exception with its remedy, not a bare count", async () => {
  const prior = globalThis.fetch;
  const sent: { url: string; method: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? "GET" });
    return Response.json({ recipients: 1, tracedCash: "5000.00", exceptions: EXCEPTIONS });
  }) as typeof fetch;
  const { host, unmount } = await mountDashboard(
    <FilingWorksheet filing={draftFiling()} boxes={[]} canManage canFile={false} />,
    { compliance: loadCompliance("en") },
  );
  try {
    const compute = [...host.querySelectorAll("button")].find(
      (button) => (button.textContent ?? "").trim() === "Compute from ledger",
    );
    assert.ok(compute, "the draft filing offers Compute");
    await act(async () => {
      compute.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(sent.filter((request) => request.method === "POST").length, 1);
    const html = host.textContent ?? "";
    for (const exception of EXCEPTIONS) {
      assert.ok(
        html.includes(exception.message),
        `the worksheet shows ${exception.partyName}'s message`,
      );
      assert.ok(
        html.includes(exception.remedy),
        `the worksheet shows ${exception.partyName}'s remedy`,
      );
    }
  } finally {
    globalThis.fetch = prior;
    await unmount();
  }
});
