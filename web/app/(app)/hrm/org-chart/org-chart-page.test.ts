import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract coverage for /hrm/org-chart without booting Next: source
 * assertions over the page shell, the loader/spec split, and the tree
 * widget contract (as-of, vacancies, directory, card-stack fallback).
 */

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const sections = readFileSync(new URL("./sections.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/org-chart-home.ts", import.meta.url), "utf8");

test("org chart page carries the dual gate with a 404", () => {
  assert.match(loader, /hrm\.employment\.read/, "employment readers see the tree");
  assert.match(loader, /hrm\.self\.read/, "self-service logins see the tree");
  assert.match(loader, /isFeatureEnabled\(gate\.user\.orgId, 'hrmOrgChart'\)/, "the page enforces the org-chart switch with a 404");
  assert.match(page, /loadOrgChartPage\(sp\)/, "the page renders only after the view gate resolves");
  assert.match(page, /searchParams=\{sp\}/, "the query string reaches the loader and the spec host");
  assert.match(page, /trusted \/>/, "the view spec is trusted output, never raw user input");
  assert.match(page, /generateMetadata/, "tab metadata resolves the translated title");
});

test("org chart spec composes tiles, the tree widget, and the directory table", () => {
  assert.match(view, /route: '\/hrm\/org-chart'/, "the spec names its own route for the registry");
  assert.match(view, /statTile\(\{/, "headcount, vacancies, and layers render through shared stat tiles");
  assert.match(view, /widgetBlock\('org-chart-tree'/, "the tree renders through the single tree widget");
  assert.match(view, /table\(\{/, "the directory renders through the shared table block");
  assert.match(view, /variant: 'app'/, "the directory uses the shared app table primitives");
  assert.match(view, /widgetBlock\('hrm-org-chart-person'/, "the person drawer renders through the shared widget");
  assert.match(view, /module-home-tabs/, "the header carries the route-tab strip");
  assert.match(sections, /UrlDrawer/, "the person drawer closes by navigation");
});

test("the tree resolves as-of through the read services, names only", () => {
  assert.match(loader, /loadOrgChart\(\{/, "the tree resolves through the canonical org-chart read");
  assert.match(loader, /loadDirectory\(\{/, "the directory resolves through the same service");
  assert.match(loader, /sp\.asOf/, "the as-of day comes from the query string");
  assert.match(loader, /sp\.person/, "the open person comes from the query string");
  assert.ok(!/salary|compensation|pay_rate|base_pay|hourly|payRange/i.test(loader), "the loader never resolves pay or private fields");
  assert.ok(!/from worker_employments/.test(loader), "loader issues no direct employment-table reads");
});

test("the tree widget collapses, searches, and stacks on narrow screens", () => {
  assert.match(sections, /aria-expanded/, "collapse buttons expose their state to assistive tech");
  assert.match(sections, /border-dashed/, "vacancy nodes render dashed");
  assert.match(sections, /sm:hidden/, "the card stack is the narrow-screen reading order");
  assert.match(sections, /personBaseHref/, "node clicks navigate the person param — hrefs arrive loader-resolved");
  assert.ok(!sections.includes('orgId') && !sections.includes('actorId'), "no org, user, or Authz crosses into the widget");
});
