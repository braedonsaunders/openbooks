import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const utilizationView = () => readFileSync("web/app/(app)/analytics/utilization/UtilizationView.tsx", "utf8");
const drawerSource = () => readFileSync("packages/ui/src/drawer.tsx", "utf8");

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

/** Every .tsx source under web/ (build output excluded), with its path. */
function tsxSources(dir = "web"): [path: string, source: string][] {
  const out: [path: string, source: string][] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...tsxSources(`${dir}/${entry.name}`));
    } else if (entry.name.endsWith(".tsx")) {
      out.push([`${dir}/${entry.name}`, readFileSync(`${dir}/${entry.name}`, "utf8")]);
    }
  }
  return out;
}

/** Opening tags of every `<Name …>` occurrence in the source, sliced to the tag itself. */
function openingTags(source: string, name: string): string[] {
  const tags: string[] = [];
  const pattern = new RegExp(`<${name}(?=[\\s>/])`, "g");
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const end = openTagEnd(source, match.index);
    if (end === -1) break;
    tags.push(source.slice(match.index, end + 1));
  }
  return tags;
}

/** JSX attribute names written directly on an opening tag — `{…}` expression interiors are skipped so a nested component's props never count. */
function attributes(tag: string): Set<string> {
  const names = new Set<string>();
  let depth = 0;
  for (let i = 0; i < tag.length; i++) {
    const ch = tag[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      i = tag.indexOf(ch, i + 1);
      if (i < 0) break;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
    } else if (depth === 0 && /[A-Za-z]/.test(ch)) {
      const word = /^[A-Za-z][A-Za-z0-9-]*/.exec(tag.slice(i))![0];
      if (/[\s]/.test(tag[i - 1] ?? "")) names.add(word);
      i += word.length - 1;
    }
  }
  return names;
}

/** Title values that can never name a dialog, even though the prop is present. */
const STATIC_EMPTY_TITLE = /title=(?:"\s*"|'\s*'|`{2}|\{\s*(?:"\s*"|'\s*'|undefined|null)\s*\})(?=[\s/>])/;

function drawerTitleViolations(path: string, source: string): string[] {
  const violations: string[] = [];
  for (const name of ["Drawer", "UrlDrawer"]) {
    for (const tag of openingTags(source, name)) {
      const flat = tag.replace(/\s+/g, " ").trim();
      const namedStatically = attributes(tag).has("title") && !STATIC_EMPTY_TITLE.test(flat);
      if (!namedStatically) violations.push(`${path}: ${flat}`);
    }
  }
  return violations;
}

test("every drawer instance names its dialog through a non-empty title prop", () => {
  const violations = tsxSources().flatMap(([path, source]) => drawerTitleViolations(path, source));
  assert.deepEqual(violations, []);
});

test("a drawer without a title fails this contract suite instead of shipping unnamed", () => {
  assert.deepEqual(drawerTitleViolations("fixture", '<Drawer open onClose={() => {}} size="md"><form /></Drawer>').length, 1);
  assert.deepEqual(drawerTitleViolations("fixture", '<UrlDrawer open closeHref="/x"><form /></UrlDrawer>').length, 1);
  assert.deepEqual(drawerTitleViolations("fixture", '<Drawer open onClose={() => {}} title={undefined}>x</Drawer>').length, 1);
  assert.deepEqual(drawerTitleViolations("fixture", '<Drawer open onClose={() => {}} title={null}>x</Drawer>').length, 1);
  assert.deepEqual(drawerTitleViolations("fixture", '<Drawer open onClose={() => {}} title="">x</Drawer>').length, 1);
  assert.deepEqual(drawerTitleViolations("fixture", '<Drawer open onClose={() => {}} title={" "}>x</Drawer>').length, 1);
  // A real title satisfies the contract, and nested components carrying their
  // own title attributes do not mask an unnamed host drawer.
  assert.deepEqual(drawerTitleViolations("fixture", '<Drawer open onClose={() => {}} title={t("new")}><Panel title="Forecast" /></Drawer>'), []);
});

test("the shared drawer derives its dialog name from its own heading", () => {
  const src = drawerSource();
  // The panel is labelled by the generated heading id…
  assert.match(src, /role="dialog"\s*\n\s*aria-modal="true"\s*\n\s*aria-labelledby=\{headingId\}/);
  // …which is owned by the rendered heading.
  assert.match(src, /<h2 id=\{headingId\}/);
  // The heading id comes from useId, so no call site supplies ids by hand.
  assert.match(src, /const headingId = React\.useId\(\)/);
});

test("drawer title is required at compile time and fails closed at runtime", () => {
  const src = drawerSource();
  // No optional `title?:` remains on either Drawer or UrlDrawer: omitting it
  // is a type error, not a silently unnamed dialog.
  assert.doesNotMatch(src, /title\?:/);
  // A drawer opened with a title that resolves empty throws rather than
  // mounting a role=dialog with no accessible name.
  assert.match(
    src,
    /throw new Error\(["']Drawer: a non-empty title is required so the dialog exposes an accessible name\.["']\)/,
  );
});
