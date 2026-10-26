import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "../dashboard/_dashboard-render-harness";
import { act, click, mountDashboard } from "../dashboard/_dashboard-render-harness";

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
// Shared controls dispatch genuine browser events, including on Node versions with a native Event.
Object.assign(globalThis, { Event: window.Event });
const { ReportFilterBar } = await import("./ReportFilterBar");

const dir = dirname(fileURLToPath(import.meta.url));
const catalogsFor = (locale: string) => {
  const read = (ns: string) =>
    JSON.parse(readFileSync(join(dir, "..", "..", "..", "messages", locale, `${ns}.json`), "utf8"));
  return {
    reports: read("reports"),
    common: read("common"),
    ui: read("ui"),
    periodLabels: read("periodLabels"),
  };
};
const messages = catalogsFor("en");

// Typed custom ranges stage until the operator applies them: typing must not
// navigate, and Apply (or Enter) commits period=custom with both bounds. A
// range commits only when both bounds are set and From is on or before To.

function recordReplaces(): { replaces: string[] } {
  const replaces: string[] = [];
  const router = (globalThis as unknown as { __dashRouter: Record<string, unknown> }).__dashRouter;
  router.replace = (href: string) => {
    replaces.push(href);
  };
  return { replaces };
}

function dateInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll("input[data-date-field]")] as HTMLInputElement[];
}

/**
 * Type into a date bound. A finished entry settles as moving to the next
 * control does; an unfinished one is still typed text, which Enter settles.
 */
async function typeDate(
  input: HTMLInputElement,
  value: string,
  { finish = true }: { finish?: boolean } = {},
): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    if (finish) input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

async function pressEnter(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

function applyButton(): HTMLButtonElement | null {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Apply",
  ) as HTMLButtonElement | null;
}

async function selectPeriod(value: string): Promise<void> {
  const trigger = document.querySelector('button[aria-label="Period"][aria-haspopup="listbox"]');
  assert.ok(trigger, "the native period picker trigger renders");
  await click(trigger);
  const label = (messages.periodLabels.presets as Record<string, string>)[value];
  const option = [...document.querySelectorAll('button[role="option"]')].find(
    (option) => option.textContent?.trim() === label,
  );
  assert.ok(option, `the native period option ${value} renders`);
  await click(option);
}

test("choosing Custom stages a complete range before navigating", async () => {
  const { unmount } = await mountDashboard(
    <ReportFilterBar controls={{ period: true }} />,
    messages,
  );
  const { replaces } = recordReplaces();
  try {
    await selectPeriod("custom");
    assert.equal(replaces.length, 0, "choosing Custom does not request an empty range");
    const [from, to] = dateInputs();
    assert.ok(from && to, "both custom bounds become editable");
    await typeDate(from, "2026-02-01");
    assert.equal(applyButton()?.disabled, true, "one bound cannot reach the report");
    await typeDate(to, "2026-02-28");
    await click(applyButton()!);
    assert.equal(replaces.length, 1, "the complete range navigates once");
    const params = new URL(replaces[0]!, "https://example.test").searchParams;
    assert.equal(params.get("period"), "custom");
    assert.equal(params.get("from"), "2026-02-01");
    assert.equal(params.get("to"), "2026-02-28");
  } finally {
    await unmount();
  }
});

test("choosing Custom on an as-of report waits for one complete date", async () => {
  const { unmount } = await mountDashboard(
    <ReportFilterBar controls={{ period: true, asOf: true }} defaultPeriod="today" />,
    messages,
  );
  const { replaces } = recordReplaces();
  try {
    await selectPeriod("custom");
    assert.equal(replaces.length, 0);
    const dates = dateInputs();
    assert.equal(dates.length, 1, "the as-of control remains a single date");
    await typeDate(dates[0]!, "2/28/2026", { finish: false });
    await pressEnter(dates[0]!);
    assert.equal(replaces.length, 1);
    const params = new URL(replaces[0]!, "https://example.test").searchParams;
    assert.equal(params.get("from"), "2026-02-28");
    assert.equal(params.get("to"), "2026-02-28");
  } finally {
    await unmount();
  }
});

test("a preset discards unapplied Custom bounds", async () => {
  const { unmount } = await mountDashboard(
    <ReportFilterBar controls={{ period: true }} />,
    messages,
  );
  const { replaces } = recordReplaces();
  try {
    await selectPeriod("custom");
    await typeDate(dateInputs()[0]!, "2026-02-01");
    await selectPeriod("today");
    assert.equal(replaces.length, 1, "only the selected preset navigates");
    const params = new URL(replaces[0]!, "https://example.test").searchParams;
    assert.equal(params.get("period"), "today");
    assert.equal(params.has("from"), false);
    assert.equal(params.has("to"), false);
    assert.equal(dateInputs().length, 0, "the abandoned Custom draft closes");
  } finally {
    await unmount();
  }
});

test("typing a custom bound stages it without navigating until Apply", async () => {
  const { unmount } = await mountDashboard(
    <ReportFilterBar controls={{ period: false }} defaultPeriod="custom" />,
    messages,
  );
  const { replaces } = recordReplaces();
  try {
    const [from, to] = dateInputs();
    assert.ok(from, "the custom From field renders");
    await typeDate(from!, "2026-02-01");
    assert.equal(replaces.length, 0, "typing alone must not re-run the report");
    assert.equal(
      applyButton()?.disabled,
      true,
      "Apply stays disabled until both bounds are staged",
    );
    await typeDate(to!, "2026-02-28");
    const apply = applyButton();
    assert.ok(apply, "an explicit Apply is offered");
    assert.equal(apply.disabled, false, "Apply enables with a staged range");
    await click(apply);
    assert.equal(replaces.length, 1, "Apply commits exactly once");
    const href = replaces[0]!;
    assert.ok(href.includes("period=custom"), "the commit selects the custom period");
    assert.ok(href.includes("from=2026-02-01"), "the commit carries the typed From");
    assert.ok(href.includes("to=2026-02-28"), "the commit carries the typed To");
  } finally {
    await unmount();
  }
});

test("Enter in a custom bound applies the staged range", async () => {
  const { unmount } = await mountDashboard(
    <ReportFilterBar controls={{ period: false }} defaultPeriod="custom" />,
    messages,
  );
  const { replaces } = recordReplaces();
  try {
    const [from, to] = dateInputs();
    assert.ok(to, "the custom To field renders");
    await typeDate(from!, "2026-02-01");
    await typeDate(to!, "2026-02-28", { finish: false });
    await pressEnter(to!);
    assert.equal(replaces.length, 1, "Enter commits the staged range");
    assert.ok(replaces[0]!.includes("from=2026-02-01"), "the commit carries the typed From");
    assert.ok(replaces[0]!.includes("to=2026-02-28"), "the commit carries the typed To");
  } finally {
    await unmount();
  }
});

test("always-visible From/To apply together with the resolved defaults", async () => {
  const { unmount } = await mountDashboard(
    <ReportFilterBar
      controls={{ period: false, dateRange: true }}
      dateRange={{ from: "2026-01-01", to: "2026-01-31" }}
    />,
    messages,
  );
  const { replaces } = recordReplaces();
  try {
    assert.equal(applyButton()?.disabled, true, "Apply rests disabled with nothing staged");
    const [from] = dateInputs();
    await typeDate(from!, "2026-01-05");
    assert.equal(replaces.length, 0, "typing alone must not re-run the report");
    await click(applyButton()!);
    assert.equal(replaces.length, 1, "Apply commits exactly once");
    const href = replaces[0]!;
    assert.ok(href.includes("period=custom"), "the commit selects the custom period");
    assert.ok(href.includes("from=2026-01-05"), "the commit carries the typed From");
    assert.ok(href.includes("to=2026-01-31"), "the untouched To keeps its resolved default");
  } finally {
    await unmount();
  }
});

test("a staged range that starts after it ends does not commit", async () => {
  const { unmount } = await mountDashboard(
    <ReportFilterBar
      controls={{ period: false, dateRange: true }}
      dateRange={{ from: "2026-01-01", to: "2026-01-31" }}
    />,
    messages,
  );
  const { replaces } = recordReplaces();
  try {
    const [from] = dateInputs();
    await typeDate(from!, "2026-02-01");
    assert.equal(applyButton()?.disabled, true, "Apply stays disabled for a reversed range");
    await click(applyButton()!);
    assert.equal(replaces.length, 0, "a reversed range never reaches the report or a saved view");
  } finally {
    await unmount();
  }
});

test("the period picker names every preset and group heading in the viewer's language", async () => {
  for (const locale of ["de", "ja", "fr"]) {
    const localized = catalogsFor(locale);
    const { unmount } = await mountDashboard(
      <ReportFilterBar controls={{ period: true }} />,
      localized,
      locale,
    );
    try {
      const trigger = document.querySelector('button[aria-haspopup="listbox"]');
      assert.ok(trigger, `${locale}: the period picker renders`);
      await click(trigger);
      const options = [...document.querySelectorAll('button[role="option"]')].map(
        (option) => option.textContent?.trim() ?? "",
      );
      const presets = localized.periodLabels.presets as Record<string, string>;
      for (const id of [
        "trailing_12_months",
        "last_30_days",
        "this_fiscal_quarter",
        "rolling_year",
      ]) {
        assert.ok(options.includes(presets[id]!), `${locale}: ${id} reads as ${presets[id]}`);
      }
      const english = messages.periodLabels.presets as Record<string, string>;
      const leaked = options.filter(
        (text) => Object.values(english).includes(text) && !Object.values(presets).includes(text),
      );
      assert.deepEqual(leaked, [], `${locale}: no English preset names`);
      const headings = Object.values(localized.periodLabels.groups as Record<string, string>);
      const shownText = document.body.textContent ?? "";
      assert.ok(
        headings.some((heading) => shownText.includes(heading)),
        `${locale}: group headings read in the locale`,
      );
    } finally {
      await unmount();
    }
  }
});
