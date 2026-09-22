import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract coverage for /hrm/positions without booting Next: source
 * assertions over the page shell (gate placement, metadata, search-params
 * passthrough) and the loader/spec split between the view and the shared
 * drawer component.
 */

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const sections = readFileSync(new URL("./sections.tsx", import.meta.url), "utf8");
const form = readFileSync(new URL("./PositionCreateForm.tsx", import.meta.url), "utf8");

test("positions page carries the gate where the route-gate scanner reads it", () => {
  assert.match(view, /requirePermission\('hrm\.position\.read'\)/, "the page enforces the position read grant, not the employment one");
  assert.match(view, /isFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "the page enforces the hrm switch with a 404");
  assert.match(page, /loadPositionsPage\(sp\)/, "the page renders only after the view gate resolves");
  assert.match(page, /searchParams=\{sp\}/, "the query string reaches the loader and the spec host");
  assert.match(page, /trusted \/>/, "the view spec is trusted output, never raw user input");
  assert.match(page, /generateMetadata/, "tab metadata resolves the translated title");
});

test("positions spec composes shared primitives: list toolbar, table, URL drawer", () => {
  assert.match(view, /route: '\/hrm\/positions'/, "the spec names its own route for the registry");
  assert.match(view, /widgetBlock\('list-toolbar'/, "filters ride the shared list toolbar, never a lone dropdown over a bare table");
  assert.doesNotMatch(view, /widgetBlock\('filter-chips'/, "no second filter treatment beside the toolbar");
  assert.match(view, /paramKey: 'status'/, "segments filter over the status search param");
  assert.match(view, /paramKey: 'effectiveDate'/, "the as-of date is a toolbar control, not URL-only state");
  assert.match(view, /table\(\{/, "the list renders through the shared table block");
  assert.match(view, /variant: 'app'/, "the list uses the shared app table primitives");
  assert.match(view, /badge\(item\('statusLabel'\)/, "status renders through the shared badge cell");
  assert.match(view, /link\(item\('code'\), item\('href'\)\)/, "the code opens the drawer through the row href");
  assert.match(view, /widgetBlock\('hrm-position-drawer'/, "the drawer renders through the shared widget");
  assert.match(view, /module-home-tabs/, "the header carries the route-tab strip");
  assert.match(view, /hrmHiringViewTabs/, "Positions rides the Hiring viewTabs beside recruiting depth");
  assert.match(view, /hrm\.recruiting\.read/, "a positions-only viewer is not offered recruiting depth tabs that access-deny");
  assert.match(sections, /PositionDrawer/, "the drawer stays a shared component, never a copy");
  assert.match(sections, /UrlDrawer/, "the drawer closes by navigation");
  assert.ok(!sections.includes('<table'), "no hand-rolled table remains in the position sections");
});

test("segments filter server-side and rows resolve through the read service", () => {
  assert.match(view, /getVacancyAsOf\(\{/, "segments and rows resolve through the canonical position read service");
  assert.match(view, /getPositionAsOf\(\{/, "the drawer resolves one position through the same service");
  assert.match(view, /sp\.status/, "the active segment comes from the query string");
  assert.match(view, /sp\.position/, "the open position comes from the query string");
  assert.match(view, /segmentOptions/, "filter options resolve in the loader with counts");
  assert.match(view, /currentParams/, "the as-of date survives a segment change");
  assert.match(view, /statusVariant/, "badge presentation resolves in the loader, never in render");
  assert.match(view, /closeHref/, "the drawer closes by navigation to the segment href");
  assert.ok(!/from positions[^_]/.test(view), "loader issues no direct position-table reads");
  assert.ok(!/from position_versions/.test(view), "loader issues no direct version reads");
});

// The header primary action and its create form (Braedon's review: no way to add a position).
test("the header carries Add position first, then the strip, behind the manage ref", () => {
  const add = view.indexOf("widget('link-button'");
  const tabs = view.indexOf("widget('module-home-tabs'");
  assert.ok(add > 0 && tabs > add, "the primary action precedes the tab strip");
  // The shared header action (the Button rendered by the link-button widget
  // every other list page uses), opening the form through the URL so the
  // drawer is shareable and closes by navigation — no bespoke button.
  assert.match(view, /widget\('link-button', \{ href: f\('addHref'\), label: f\('addLabel'\), iconKey: 'plus' \}, f\('canManage'\)\)/);
  assert.match(view, /addHref: hrefFor\(effectiveDate, status, 'new'\)/, "the href keeps the as-of date and segment");
  assert.match(view, /canManage = can\(authz, 'hrm\.position\.manage'\)/, "the ref is the same grant the POST route enforces");
});

test("the create form uses the house form primitives and the real API", () => {
  for (const primitive of ["Button", "Input", "Label", "Select", "Textarea"]) {
    assert.match(form, new RegExp(`\\b${primitive}\\b`), `${primitive} from @openbooks/ui`);
  }
  assert.match(form, /fetch\('\/api\/hrm\/positions', \{\s*method: 'POST'/);
  assert.match(form, /readApiErrorMessage\(res, labels\.failed\)/, "a refusal is shown, never swallowed");
  assert.match(sections, /drawer\.create \? \(\s*<PositionCreateForm/, "the URL drawer hosts the form");
  assert.match(view, /sp\.position === 'new' && canManage/, "only a manager gets the form");
});

test("the create copy ships in every locale", () => {
  for (const locale of ["de", "en", "es", "fr", "ja", "pt-BR", "zh"]) {
    const catalog = JSON.parse(readFileSync(new URL(`../../../../messages/${locale}/hrm.json`, import.meta.url), "utf8")) as {
      positions: { add?: string; create?: Record<string, string> };
    };
    assert.ok(catalog.positions.add, `${locale} carries positions.add`);
    for (const key of ["title", "code", "titleField", "employer", "department", "noDepartment", "plannedFte", "status", "effectiveFrom", "reason", "reasonPlaceholder", "submit", "failed"]) {
      assert.ok(catalog.positions.create?.[key], `${locale} carries positions.create.${key}`);
    }
  }
});
