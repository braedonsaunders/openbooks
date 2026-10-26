import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the renderer is a client component reading browser globals.
const { bootJsdomEnvironment } = await import("../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/ap/bills",
  matchMediaMatches: false,
  scrollIntoView: false,
});

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href},p.children)}`,
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { ActionError } = await import("@braedonsaunders/appkit-errors");
const { ApiResponseError } = await import("../lib/api-error");
const { PeriodClosedRefusal, periodClosedScopeOf, reopenRequestHref } =
  await import("./period-closed-refusal");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const DETAILS = {
  kind: "period-closed",
  periodId: "11111111-1111-1111-1111-111111111111",
  bookId: "22222222-2222-2222-2222-222222222222",
  subsidiaryId: "33333333-3333-3333-3333-333333333333",
  module: "ap",
};

function refusalWithDetails(details: unknown) {
  const error = new ActionError({
    kind: "refused",
    status: 422,
    serverMessage: "AP is closed for this period",
  });
  if (details !== undefined) {
    (error as { details?: unknown }).details = details;
  }
  return error;
}

test("period-closed scope reads every refusal envelope, never message text", () => {
  assert.deepEqual(periodClosedScopeOf(refusalWithDetails(DETAILS)), {
    periodId: DETAILS.periodId,
    bookId: DETAILS.bookId,
    subsidiaryId: DETAILS.subsidiaryId,
    module: "ap",
  });
  assert.deepEqual(
    periodClosedScopeOf(
      new ApiResponseError("AP is closed", 422, { error: "AP is closed", details: DETAILS }),
    ),
    {
      periodId: DETAILS.periodId,
      bookId: DETAILS.bookId,
      subsidiaryId: DETAILS.subsidiaryId,
      module: "ap",
    },
  );
  assert.deepEqual(periodClosedScopeOf({ error: "AP is closed", details: DETAILS }), {
    periodId: DETAILS.periodId,
    bookId: DETAILS.bookId,
    subsidiaryId: DETAILS.subsidiaryId,
    module: "ap",
  });
  // A bare closed-period message without typed scope links nowhere.
  assert.equal(periodClosedScopeOf(refusalWithDetails(undefined)), null);
  assert.equal(periodClosedScopeOf(refusalWithDetails({ kind: "period-closed" })), null);
  assert.equal(periodClosedScopeOf(refusalWithDetails({ ...DETAILS, kind: "other" })), null);
  assert.equal(periodClosedScopeOf(refusalWithDetails({ ...DETAILS, subsidiaryId: 42 })), null);
  assert.equal(periodClosedScopeOf(null), null);
});

test("the reopen href prefills period, book, entity and module", () => {
  assert.equal(
    reopenRequestHref({
      periodId: DETAILS.periodId,
      bookId: DETAILS.bookId,
      subsidiaryId: DETAILS.subsidiaryId,
      module: "ap",
    }),
    `/admin/setup/period-close?tab=periods&period=${DETAILS.periodId}&book=${DETAILS.bookId}&reopenModule=ap&reopenEntity=${DETAILS.subsidiaryId}`,
  );
  assert.equal(
    reopenRequestHref({
      periodId: DETAILS.periodId,
      bookId: DETAILS.bookId,
      subsidiaryId: null,
      module: "gl",
    }),
    `/admin/setup/period-close?tab=periods&period=${DETAILS.periodId}&book=${DETAILS.bookId}&reopenModule=gl`,
  );
});

async function renderRefusal(error: unknown) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PeriodClosedRefusal error={error} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    host,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("the renderer links a typed closed period into the prefilled form", async () => {
  const { host, unmount } = await renderRefusal(refusalWithDetails(DETAILS));
  try {
    const link = host.querySelector("a");
    assert.ok(link, "a typed closed period renders the reopen link");
    assert.equal(
      link.getAttribute("href"),
      `/admin/setup/period-close?tab=periods&period=${DETAILS.periodId}&book=${DETAILS.bookId}&reopenModule=ap&reopenEntity=${DETAILS.subsidiaryId}`,
    );
    assert.ok((link.textContent ?? "").length > 0, "the link names its action");
  } finally {
    await unmount();
  }
});

test("the renderer stays silent without a typed closed period", async () => {
  for (const error of [
    refusalWithDetails(undefined),
    refusalWithDetails({ kind: "other" }),
    null,
  ]) {
    const { host, unmount } = await renderRefusal(error);
    try {
      assert.equal(host.querySelector("a"), null, "no link without typed scope");
      assert.equal((host.textContent ?? "").trim(), "", "nothing renders without typed scope");
    } finally {
      await unmount();
    }
  }
});
