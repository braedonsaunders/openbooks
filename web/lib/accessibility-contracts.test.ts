import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const utilizationView = () => readFileSync("web/app/(app)/analytics/utilization/UtilizationView.tsx", "utf8");

interface Button {
  tag: string;
  body: string;
}

/** Index just past an opening JSX tag's matching `>`, honouring strings and {…} expressions so `=>` inside handlers does not truncate the tag. */
function openTagEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '"') {
      i = source.indexOf('"', i + 1);
    } else if (ch === "'") {
      i = source.indexOf("'", i + 1);
    } else if (ch === "`") {
      i = source.indexOf("`", i + 1);
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
    } else if (ch === ">" && depth === 0) {
      return i;
    }
    if (i < 0) return -1;
  }
  return -1;
}

/** Every <button>…</button> pair in the source, with its complete opening tag and inner JSX. */
function buttonsIn(source: string): Button[] {
  const out: Button[] = [];
  for (let at = source.indexOf("<button"); at !== -1; ) {
    const end = openTagEnd(source, at);
    if (end === -1) break;
    const close = source.indexOf("</button>", end);
    if (close === -1) break;
    out.push({ tag: source.slice(at, end), body: source.slice(end + 1, close) });
    at = source.indexOf("<button", close);
  }
  return out;
}

/**
 * Icon-only = the button renders only element children (e.g. <Grid3X3 />):
 * no literal text and no `{…}` expression that could supply an accessible
 * name. These are exactly the buttons screen readers announce as blank.
 */
function isIconOnly(button: Button): boolean {
  const withoutElements = button.body.replace(/<\/?[A-Za-z][^>]*>/g, "");
  return !/[{A-Za-z0-9]/.test(withoutElements.trim());
}

function ariaLabel(button: Button): string | null {
  return button.tag.match(/aria-label=\{?["'`]([^"'`]*)["'`]\}?/)?.[1] ?? null;
}

test("every icon-only button in the utilization view carries an accessible name", () => {
  const unlabeled = buttonsIn(utilizationView())
    .filter(isIconOnly)
    .filter((b) => !ariaLabel(b))
    .map((b) => b.tag.slice(0, 120));
  assert.deepEqual(unlabeled, []);
});

test("the departments cards/table toggles announce their target and pressed state", () => {
  const source = utilizationView();
  const toggles = buttonsIn(source).filter((b) => /setView\('cards'\)|aria-pressed=\{view === '(cards|table)'\}/.test(b.tag));
  assert.equal(toggles.length, 2);

  const cards = toggles.find((b) => b.tag.includes("aria-pressed={view === 'cards'}"));
  const table = toggles.find((b) => b.tag.includes("aria-pressed={view === 'table'}"));
  assert.ok(cards && table);

  // Accessible names come from the utilization message catalog ("Show …").
  assert.match(cards.tag, /aria-label=\{\`\$\{t\('show'\)\} \$\{t\('tabs\.departments'\)\}\`\}/);
  assert.match(table.tag, /aria-label=\{\`\$\{t\('show'\)\} \$\{t\('table'\)\}\`\}/);
  // Toggle buttons must expose state, not just action.
  assert.match(cards.tag, /aria-pressed=\{view === 'cards'\}/);
  assert.match(table.tag, /aria-pressed=\{view === 'table'\}/);
});
