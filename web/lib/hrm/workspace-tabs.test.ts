import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contract for the HRM workspace strips. The helpers are
 * server-only (translations, grants, feature switches), so this file
 * pins the maintained sources: child routes highlight a parent job,
 * nested surfaces stay viewTabs, and a tab never lands on a 404.
 */
const workspace = readFileSync(new URL("./workspace-tabs.ts", import.meta.url), "utf8");
const groupTabs = readFileSync(new URL("../../components/module-home/group-tabs.ts", import.meta.url), "utf8");

test("child HRM routes highlight their parent job on the group strip", () => {
  const rules = [
    ["/hrm/compensation", "/hrm/compensation"],
    ["/hrm/benefits", "/hrm/compensation"],
    ["/hrm/positions", "/hrm/recruiting"],
    ["/hrm/recruiting", "/hrm/recruiting"],
    ["/hrm/org-chart", "/entities/employees"],
    ["/hrm/processes", "/entities/employees"],
    ["/hrm/documents", "/entities/employees"],
    ["/hrm/qualifications", "/entities/employees"],
    ["/hrm/surveys", "/hrm/performance"],
    ["/hrm/performance", "/hrm/performance"],
    ["/hrm/leave", "/hrm/leave"],
    ["/hrm/compliance", "/hrm/compliance"],
    ["/hrm/change-requests", "/hrm"],
    ["/entities/employees", "/entities/employees"],
    ["/hrm", "/hrm"],
  ] as const;
  for (const [prefix, parent] of rules) {
    assert.match(
      workspace,
      new RegExp(
        `prefix: '${prefix.replace(/\//g, "\\/")}', parent: '${parent.replace(/\//g, "\\/")}'`,
      ),
      `${prefix} lights ${parent}`,
    );
  }
  assert.match(groupTabs, /hrmStripParentHref\(activeHref\)/, "the group strip uses the parent map, never a missing peer");
});

test("People viewTabs keep documents, qualifications, processes, and the org chart findable", () => {
  assert.match(workspace, /export async function hrmPeopleViewTabs/, "People tabs are one helper");
  assert.match(workspace, /hrmDocuments/, "Documents hide while the documents switch is off");
  assert.match(workspace, /hrm\.documents\.read/, "Documents hide without the documents read grant");
  assert.match(workspace, /hrmCertifications/, "Qualifications hide while the certifications switch is off");
  assert.match(workspace, /hrm\.certifications\.read/, "Qualifications hide without the certifications read grant");
  assert.match(workspace, /hrmOrgChart/, "Org chart hides while its switch is off");
  assert.match(workspace, /hrm\.process\.read/, "Processes hide without the process read grant");
  assert.match(workspace, /\/entities\/employees/, "the native roster stays the People landing");
});

test("Hiring viewTabs prepend Positions and do not import the recruiting page", () => {
  assert.match(workspace, /export async function hrmHiringViewTabs/, "Hiring tabs are one helper");
  assert.match(workspace, /hrm\.position\.read/, "Positions hides without the position read grant");
  assert.match(workspace, /onPositions \? false : depth\.active === true/, "recruiting depth tabs go inactive on Positions");
  assert.doesNotMatch(workspace, /from ['"].*recruiting/, "the helper never imports the recruiting page");
});

test("Talent viewTabs keep Surveys next to the review-cycle surfaces", () => {
  assert.match(workspace, /export async function hrmTalentViewTabs/, "Talent tabs are one helper");
  assert.match(workspace, /hrmSurveys/, "Surveys hide while the surveys switch is off");
  assert.match(workspace, /hrm\.surveys\.manage/, "Surveys hide without the surveys manage grant");
  assert.match(workspace, /\/hrm\/performance\?tab=calibration/, "Calibration stays a Talent view");
  assert.match(workspace, /\/hrm\/performance\?tab=talent/, "Succession stays a Talent view");
  assert.match(workspace, /\/hrm\/performance\?tab=retention/, "Retention stays a Talent view");
  assert.match(workspace, /href: '\/hrm\/surveys'/, "Surveys is a Talent viewTab, never a vanished peer");
});

test("Rewards viewTabs keep compensation, benefit windows, enrolments, and equity findable", () => {
  assert.match(workspace, /export async function hrmRewardsViewTabs/, "Rewards tabs are one helper");
  assert.match(workspace, /hrmCompensation/, "Compensation hides while the compensation switch is off");
  assert.match(workspace, /hrm\.compensation\.read/, "Compensation hides without the compensation read grant");
  assert.match(workspace, /hrm\.benefits\.read/, "Windows and Enrolments hide without the benefits read grant");
  assert.match(workspace, /hrmPayTransparency/, "Equity hides while pay transparency is off");
  assert.match(workspace, /\/hrm\/benefits\?view=enrolments/, "Enrolments stays a tab, never a status segment");
  assert.match(workspace, /\/hrm\/compensation\/equity/, "Equity stays a Rewards view");
});
