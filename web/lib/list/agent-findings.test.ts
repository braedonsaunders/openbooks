import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FINDING_SINCE_WINDOWS,
  FINDING_SORTS,
  findingsSinceIso,
  parseAgentFindingsParams,
} from "./agent-findings.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// The list source is the workbench's single URL ↔ inbox contract: every
// filter the shared filter components can set must parse here, and the
// paging/sort must reach loadAgentInbox — never a second parse in the page.
test("defaults rank the inbox with sane paging", () => {
  const q = parseAgentFindingsParams({});
  assert.equal(q.sort, "rank");
  assert.equal(q.dir, "desc");
  assert.equal(q.page, 1);
  assert.equal(q.perPage, 25);
  assert.equal(q.filters.limit, 25);
  assert.equal(q.filters.offset, 0);
  assert.equal(q.filters.sort, "rank");
  assert.equal(q.filters.dir, "desc");
  assert.equal(q.filters.packs, undefined);
  assert.equal(q.filters.severities, undefined);
  assert.equal(q.filters.statuses, undefined);
  assert.equal(q.filters.query, undefined);
  assert.equal(q.filters.hasProposal, undefined);
  assert.equal(q.filters.subsidiaryId, undefined);
  assert.equal(q.filters.since, undefined);
});

test("sort and direction validate with fallback to rank desc", () => {
  assert.equal(parseAgentFindingsParams({ sort: "materiality", dir: "asc" }).sort, "materiality");
  assert.equal(parseAgentFindingsParams({ sort: "materiality", dir: "asc" }).dir, "asc");
  assert.equal(parseAgentFindingsParams({ sort: "severity" }).filters.sort, "severity");
  assert.equal(parseAgentFindingsParams({ sort: "nope" }).sort, "rank");
  assert.equal(parseAgentFindingsParams({ sort: "detected", dir: "sideways" }).dir, "desc");
  for (const sort of FINDING_SORTS) {
    assert.equal(parseAgentFindingsParams({ sort }).sort, sort);
  }
});

test("paging clamps and offsets like every other list", () => {
  const q = parseAgentFindingsParams({ page: "3", perPage: "10" });
  assert.equal(q.page, 3);
  assert.equal(q.filters.offset, 20);
  assert.equal(parseAgentFindingsParams({ page: "abc" }).page, 1);
  assert.equal(parseAgentFindingsParams({ perPage: "500" }).perPage, 100);
});

test("packs filter to known keys and drop junk", () => {
  const q = parseAgentFindingsParams({ packs: "accounting,tax,nope" });
  assert.deepEqual(q.filters.packs, ["accounting", "tax"]);
  assert.equal(parseAgentFindingsParams({ packs: "nope" }).filters.packs, undefined);
  assert.equal(parseAgentFindingsParams({}).filters.packs, undefined);
});

test("severity and status accept only inbox literals", () => {
  assert.deepEqual(parseAgentFindingsParams({ severity: "critical" }).filters.severities, ["critical"]);
  assert.equal(parseAgentFindingsParams({ severity: "nope" }).filters.severities, undefined);
  assert.deepEqual(parseAgentFindingsParams({ status: "resolved" }).filters.statuses, ["resolved"]);
  assert.equal(parseAgentFindingsParams({ status: "nope" }).filters.statuses, undefined);
});

test("subsidiary must be a uuid, proposals and assignment map exactly", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  assert.equal(parseAgentFindingsParams({ subsidiary: id }).filters.subsidiaryId, id);
  assert.equal(parseAgentFindingsParams({ subsidiary: "root" }).filters.subsidiaryId, undefined);
  assert.equal(parseAgentFindingsParams({ proposals: "true" }).filters.hasProposal, true);
  assert.equal(parseAgentFindingsParams({ proposals: "false" }).filters.hasProposal, undefined);
  assert.equal(parseAgentFindingsParams({ assigned: "mine" }).filters.assignedToMe, true);
  assert.equal(parseAgentFindingsParams({ assigned: "unassigned" }).filters.unassignedOnly, true);
  assert.equal(parseAgentFindingsParams({ assigned: "overdue" }).filters.overdueOnly, true);
  assert.equal(parseAgentFindingsParams({ assigned: "everyone" }).filters.assignedToMe, undefined);
});

test("query passes through, since maps stable keys to instants", () => {
  assert.equal(parseAgentFindingsParams({ q: "  bank  " }).filters.query, "  bank  ");
  const now = Date.parse("2026-09-16T12:00:00Z");
  assert.equal(
    findingsSinceIso("day", now),
    new Date(now - FINDING_SINCE_WINDOWS.day).toISOString(),
  );
  assert.equal(
    findingsSinceIso("week", now),
    new Date(now - FINDING_SINCE_WINDOWS.week).toISOString(),
  );
  assert.equal(findingsSinceIso(undefined, now), undefined);
  assert.equal(parseAgentFindingsParams({ since: "hour" }).filters.since, undefined);
  const day = parseAgentFindingsParams({ since: "day" }).filters.since;
  assert.ok(day && !Number.isNaN(Date.parse(day)), "day maps to a real instant");
});

// The local severity/status mirrors must stay the inbox's literals: the
// module deliberately avoids a runtime import of the read model (drizzle
// pool) so this pure contract stays unit-testable without a database.
test("literal mirrors stay in sync with the inbox read model", () => {
  const inbox = read("../agents/inbox.ts");
  for (const severity of ["info", "warning", "critical"]) {
    assert.match(inbox, new RegExp(`"${severity}"`));
  }
  for (const status of ["open", "in_review", "resolved", "dismissed"]) {
    assert.match(inbox, new RegExp(`"${status}"`));
  }
  assert.match(inbox, /sort\?: FindingSort/);
  assert.match(inbox, /dir\?: FindingDir/);
  for (const sort of FINDING_SORTS) {
    assert.ok(["rank", "detected", "materiality", "severity"].includes(sort));
  }
});
