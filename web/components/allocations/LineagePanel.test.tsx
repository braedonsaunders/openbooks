import assert from "node:assert/strict";
import test from "node:test";

/**
 * S3b: the Lines panel pages through the whole drill. A 252-row lineage at
 * pageSize 50 must reach rows 51–252 through Previous/Next with a
 * "Rows x–y of z" status — never strand past the first page.
 */

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/setup/allocations",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}

const { registerHooks } = await import("node:module");
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const worktreeUi = pathToFileURL(join(process.cwd(), "packages", "ui", "src", "index.ts")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){const{children,...rest}=p;return globalThis.React.createElement('a',rest,children)}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../messages/en")).default;
const { LineagePanel } = await import("./LineagePanel.tsx");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

interface FetchCall {
  limit: number;
  offset: number;
}

// 252 drill rows; row i carries amount `${i}.00` so the last page is
// identifiable by content, not just by the status line.
const ALL = Array.from({ length: 252 }, (_, index) => {
  const n = index + 1;
  return {
    id: `line-${n}`,
    ruleKey: `rule-${n}`,
    driverKey: null,
    driverValue: null,
    share: null,
    amount: `${n}.00`,
    residual: "0",
    journalEntryId: null,
  };
});
const calls: FetchCall[] = [];
(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
  const parsed = new URL(String(url), "http://localhost:4800");
  const limit = Number(parsed.searchParams.get("limit") ?? "200");
  const offset = Number(parsed.searchParams.get("offset") ?? "0");
  calls.push({ limit, offset });
  const rows = ALL.slice(offset, offset + limit);
  return {
    ok: true,
    json: async () => ({ rows, total: ALL.length, truncated: offset + rows.length < ALL.length }),
  };
};

function provider(children: React.ReactElement) {
  /* eslint-disable react/no-children-prop */
  return React.createElement(NextIntlClientProvider, {
    locale: "en",
    messages,
    timeZone: "UTC",
    children,
  });
  /* eslint-enable react/no-children-prop */
}

function buttons(): { previous: HTMLButtonElement; next: HTMLButtonElement } {
  const found = [...document.querySelectorAll("button")] as HTMLButtonElement[];
  const previous = found.find((b) => (b.textContent ?? "").includes("Previous"));
  const next = found.find((b) => (b.textContent ?? "").includes("Next"));
  assert.ok(previous, "a Previous button must render");
  assert.ok(next, "a Next button must render");
  return { previous, next };
}

function status(): string {
  const paragraph = [...document.querySelectorAll("p")].find((p) =>
    (p.textContent ?? "").includes("Rows "),
  );
  assert.ok(paragraph, "a Rows x–y of z status must render");
  return paragraph.textContent ?? "";
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
    await tick();
  });
}

test("S3b: the lineage drill pages to the last row", async () => {
  document.body.innerHTML = "";
  calls.length = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(provider(React.createElement(LineagePanel, { anchor: { runId: "run-1" }, pageSize: 50 })));
      await tick();
      await tick();
      await tick();
    });
    // First page: rows 1–50, Previous parked, Next live.
    assert.deepEqual(calls[0], { limit: 50, offset: 0 });
    assert.equal(status(), "Rows 1-50 of 252.");
    assert.ok(!document.body.textContent?.includes("252.00"), "row 252 must not render on page one");
    let pager = buttons();
    assert.equal(pager.previous.disabled, true);
    assert.equal(pager.next.disabled, false);
    // Walk to the last page: 51–100 … 201–250, then 251–252.
    for (const [from, to] of [[51, 100], [101, 150], [151, 200], [201, 250]] as const) {
      await click(pager.next);
      assert.equal(status(), `Rows ${from}-${to} of 252.`);
      pager = buttons();
    }
    await click(pager.next);
    assert.equal(status(), "Rows 251-252 of 252.");
    assert.ok(document.body.textContent?.includes("252.00"), "the last page must show row 252");
    pager = buttons();
    assert.equal(pager.next.disabled, true);
    assert.equal(pager.previous.disabled, false);
    // And back one page: Previous is a real control, not decoration.
    await click(pager.previous);
    assert.equal(status(), "Rows 201-250 of 252.");
    assert.ok(!document.body.textContent?.includes("252.00"), "leaving the last page must drop row 252");
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});
