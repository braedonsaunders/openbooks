import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "../../dashboard/_dashboard-render-harness";
import { act, click, mountDashboard, scriptFetch } from "../../dashboard/_dashboard-render-harness";

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { StatementBalanceForm } = await import("./StatementBalanceForm");

const dir = dirname(fileURLToPath(import.meta.url));
const messages = {
  banking: JSON.parse(
    readFileSync(join(dir, "..", "..", "..", "..", "messages", "en", "banking.json"), "utf8"),
  ),
  common: JSON.parse(
    readFileSync(join(dir, "..", "..", "..", "..", "messages", "en", "common.json"), "utf8"),
  ),
  ui: JSON.parse(
    readFileSync(join(dir, "..", "..", "..", "..", "messages", "en", "ui.json"), "utf8"),
  ),
};

const STATEMENT_ID = "11111111-0000-4000-8000-000000000001";

function toasts(): { kind: string; message: string }[] {
  return (globalThis as unknown as { __dashToasts: { kind: string; message: string }[] })
    .__dashToasts;
}

function saveButton(): HTMLButtonElement | null {
  return (
    ([...document.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Save balances",
    ) as HTMLButtonElement | null) ?? null
  );
}

// A CSV import lands with no bank-reported balances: the drawer offers both
// fields, and saving PATCHes the statement, toasts, and refreshes.
test("saving posts both balances, toasts and refreshes", async () => {
  const calls: { url: string; method?: string; body?: string }[] = [];
  let refreshed = 0;
  const restoreFetch = scriptFetch((url, init) => {
    if (url.includes(`/api/banking/statements/${STATEMENT_ID}`)) {
      calls.push({ url, method: init?.method, body: String(init?.body ?? "") });
      return Response.json({ ok: true, openingBalance: "1000.0000", closingBalance: "1100.0000" });
    }
    return null;
  });
  const { unmount } = await mountDashboard(
    <StatementBalanceForm
      statementId={STATEMENT_ID}
      opening={null}
      closing={null}
      canEdit
      blockedReason={null}
    />,
    messages,
  );
  try {
    const router = (globalThis as unknown as { __dashRouter: { refresh(): void } }).__dashRouter;
    router.refresh = () => {
      refreshed += 1;
    };
    const inputs = [...document.querySelectorAll("input")];
    assert.equal(inputs.length, 2, "both balance fields render");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(inputs[0], "1000.00");
      inputs[0]!.dispatchEvent(new window.Event("input", { bubbles: true }));
      setter.call(inputs[1], "1100.00");
      inputs[1]!.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const save = saveButton();
    assert.ok(save, "the form offers Save balances");
    assert.equal(save.disabled, false, "edited balances enable the save");
    await click(save);
    await act(async () => {});
    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(patch, `saving must PATCH the statement, got ${JSON.stringify(calls)}`);
    assert.deepEqual(
      JSON.parse(patch.body ?? "{}"),
      { openingBalance: "1000.00", closingBalance: "1100.00" },
      "both balances travel in one audited write",
    );
    assert.ok(
      toasts().some((t) => t.kind === "success" && t.message.includes("Statement balances saved")),
      `saving must toast, got ${JSON.stringify(toasts())}`,
    );
    assert.equal(refreshed, 1, "the drawer refreshes after the save");
  } finally {
    await unmount();
    restoreFetch();
  }
});

test("a blocked statement names its reason with no fields", async () => {
  const { unmount } = await mountDashboard(
    <StatementBalanceForm
      statementId={STATEMENT_ID}
      opening="1000.0000"
      closing={null}
      canEdit={false}
      blockedReason="Balances are locked — this import has 1 matched line."
    />,
    messages,
  );
  try {
    assert.equal(
      document.querySelectorAll("input").length,
      0,
      "a blocked statement offers no balance fields",
    );
    assert.ok(
      (document.body.textContent ?? "").includes("Balances are locked"),
      "the blocked statement names its reason",
    );
  } finally {
    await unmount();
  }
});

// Stored balances carry numeric(19,4) padding. The fields show the canonical
// amount, and retyping that same amount in another spelling is not an edit.
test("stored balances show their canonical amount and an unchanged figure cannot save", async () => {
  const { unmount } = await mountDashboard(
    <StatementBalanceForm
      statementId={STATEMENT_ID}
      opening="5028.8200"
      closing="-12.5000"
      canEdit
      blockedReason={null}
    />,
    messages,
  );
  try {
    const inputs = [...document.querySelectorAll("input")] as HTMLInputElement[];
    assert.equal(inputs.length, 2, "both balance fields render");
    assert.equal(inputs[0]!.value, "5028.82", "the opening field shows the trimmed amount");
    assert.equal(inputs[1]!.value, "-12.50", "the closing field keeps two places");
    const save = saveButton();
    assert.ok(save, "the form offers Save balances");
    assert.equal(save.disabled, true, "an unedited statement offers no save");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(inputs[0], "5028.8200");
      inputs[0]!.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(saveButton()!.disabled, true, "the same amount in another padding is not an edit");
  } finally {
    await unmount();
  }
});
