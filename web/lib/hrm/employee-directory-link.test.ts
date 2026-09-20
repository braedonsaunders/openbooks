import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EMPLOYEE_LIST_DEPARTMENT_PARAM,
  EMPLOYEE_LIST_PATH,
  EMPLOYEE_LIST_UNASSIGNED_DEPARTMENT,
  employeeDirectoryLinkForDepartment,
} from "./employee-directory-link.ts";

const DEPARTMENT_ID = "11111111-1111-4111-8111-111111111111";

test("a department id links to the employee list with the department filter", () => {
  assert.equal(
    employeeDirectoryLinkForDepartment(DEPARTMENT_ID),
    `/entities/employees?department=${DEPARTMENT_ID}`,
    "exact href the departments board drills through",
  );
});

test("null links to the unassigned roster", () => {
  assert.equal(
    employeeDirectoryLinkForDepartment(null),
    "/entities/employees?department=unassigned",
    "the Unassigned row drills through with the unassigned value",
  );
});

test("filter values are encoded and empty ids are refused", () => {
  assert.equal(
    employeeDirectoryLinkForDepartment("a b&c"),
    "/entities/employees?department=a%20b%26c",
    "values cross encoded, never raw",
  );
  assert.throws(
    () => employeeDirectoryLinkForDepartment(""),
    /needs a department id or null/,
    "an empty id refuses instead of linking the wrong roster",
  );
  assert.throws(
    () => employeeDirectoryLinkForDepartment("   "),
    /needs a department id or null/,
    "a blank id refuses instead of linking the wrong roster",
  );
});

test("the link contract matches the list's own filter contract", () => {
  // The helper must not drift from the list it links to: the parameter it
  // writes is the quick filter's paramKey, and the unassigned value is the
  // where builder's. Both are quoted here so a rename on either side
  // breaks this test and forces a joint review.
  const sources = readFileSync(new URL("../list/entity-sources.ts", import.meta.url), "utf8");
  assert.ok(
    sources.includes("paramKey: 'department'"),
    "the employee source still reads the department quick filter from ?department=",
  );
  assert.ok(
    sources.includes("filterKey: 'department'"),
    "the employee source still maps that parameter to the department predicate",
  );
  const builder = readFileSync(
    new URL("../customization/entity-list-query/employment-directory.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    builder.includes('UNASSIGNED_DEPARTMENT = "unassigned"'),
    "the where builder still names the unassigned value this link writes",
  );
  assert.equal(EMPLOYEE_LIST_PATH, "/entities/employees");
  assert.equal(EMPLOYEE_LIST_DEPARTMENT_PARAM, "department");
  assert.equal(EMPLOYEE_LIST_UNASSIGNED_DEPARTMENT, "unassigned");
});
