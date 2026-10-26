import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../testing/jsdom-env";
import { stubModules } from "../../testing/stub-modules";

await bootJsdomEnvironment({ event: "native", matchMediaMatches: true });
stubModules({ navigation: false });
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../messages/en")).default;
const { ShortcutHelpSheet, referenceKeys, shortcutReferenceMatches } =
  await import("./shortcut-help-sheet");
const { SHORTCUT_REFERENCE_GROUPS } = await import("./shortcut-catalog");
const { EDITOR_SHORTCUT_REFERENCE } = await import("./editor-shortcut-catalog");
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("the shortcut drawer opens with the whole application reference and searchable keys", async (t) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ShortcutHelpSheet
          open
          commands={[
            {
              id: "custom",
              order: 1,
              label: "Current record action",
              scope: "form",
              binding: { modifier: "primary", code: "KeyS" },
              run() {},
            },
          ]}
          apple={false}
          onClose={() => undefined}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  const drawer = document.querySelector('[role="dialog"]')!;
  for (const label of [
    "Save and new",
    "Next capture",
    "Fill down",
    "Run the query from the SQL editor",
    "Fold all code blocks",
    "Post all bills",
  ]) {
    assert.ok(
      drawer.textContent?.includes(label),
      `${label} is documented without visiting its owning screen`,
    );
  }
  assert.ok(
    drawer.querySelectorAll("li").length > 180,
    "the full reference includes editor and application bindings",
  );
  const search = drawer.querySelector(
    'input[aria-label="Find an action, screen or key…"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      search,
      "Ctrl+Enter",
    );
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  assert.ok(drawer.textContent?.includes("Run the query from the SQL editor"));
  assert.ok(!drawer.textContent?.includes("Fold all code blocks"));
  const current = [...drawer.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes("Current screen"),
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      search,
      "",
    );
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    current.click();
    await tick();
  });
  assert.ok(drawer.textContent?.includes("Current record action"));
  assert.ok(!drawer.textContent?.includes("Fold all code blocks"));
});

test("every catalog entry has translated copy in every supported locale and valid platform keys", async () => {
  const { readFile } = await import("node:fs/promises");
  const entries = [
    ...SHORTCUT_REFERENCE_GROUPS.flatMap((group) => group.entries),
    ...EDITOR_SHORTCUT_REFERENCE,
  ];
  for (const locale of ["en", "fr", "es", "de", "pt-BR", "zh", "ja"]) {
    const namespaces = new Map<string, unknown>();
    for (const entry of entries) {
      for (const path of [entry.labelKey, entry.labelValueKey].filter((value): value is string =>
        Boolean(value),
      )) {
        const [namespace, ...keys] = path.split(".");
        if (!namespaces.has(namespace!))
          namespaces.set(
            namespace!,
            JSON.parse(
              await readFile(
                new URL(`../../messages/${locale}/${namespace}.json`, import.meta.url),
                "utf8",
              ),
            ),
          );
        let value: unknown = namespaces.get(namespace!);
        for (const key of keys) value = (value as Record<string, unknown> | undefined)?.[key];
        assert.equal(typeof value, "string", `${locale}: ${path}`);
      }
    }
  }
  assert.ok(
    entries.every(
      (entry) =>
        referenceKeys(entry, true).length ||
        referenceKeys(entry, false).length ||
        referenceKeys(entry, false, true).length,
    ),
  );
  assert.equal(
    shortcutReferenceMatches("cmd+enter", "Post and new", "Forms", ["⌘", "Enter"]),
    true,
  );
  assert.equal(
    shortcutReferenceMatches("ctrl+enter", "Run query", "Queries", ["Ctrl", "Enter"]),
    true,
  );
});

test("the source-editor reference covers every enabled keymap binding and selection variant", async () => {
  const commands = await import("@codemirror/commands");
  const search = await import("@codemirror/search");
  const language = await import("@codemirror/language");
  const complete = await import("@codemirror/autocomplete");
  const lint = await import("@codemirror/lint");
  const enabled = [
    ...complete.closeBracketsKeymap,
    ...commands.defaultKeymap,
    ...search.searchKeymap,
    ...commands.historyKeymap,
    ...language.foldKeymap,
    ...complete.completionKeymap,
    ...lint.lintKeymap,
    commands.indentWithTab,
  ];
  for (const native of enabled) {
    for (const [variant, prefix] of [
      [native.run, ""],
      [native.shift, "Shift-"],
    ] as const) {
      if (!variant) continue;
      const expected = Object.fromEntries(
        ["key", "mac", "win", "linux"].flatMap((platform) => {
          const raw = native[platform as "key" | "mac" | "win" | "linux"];
          return raw ? [[platform, prefix + raw]] : [];
        }),
      );
      assert.ok(
        EDITOR_SHORTCUT_REFERENCE.some(
          (entry) => JSON.stringify(entry.editorBinding) === JSON.stringify(expected),
        ),
        `the editor shortcut ${JSON.stringify(expected)} is discoverable`,
      );
    }
  }
});
