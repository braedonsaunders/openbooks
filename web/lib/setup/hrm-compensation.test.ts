import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHrmCompensationInput } from "./hrm-compensation.ts";

describe("normalizeHrmCompensationInput", () => {
  test("other entities pass through untouched", () => {
    const body = { code: "ENG" };
    assert.equal(normalizeHrmCompensationInput("hrm-job-families", body), body);
  });

  test("weight slots fold into equal_value_criteria", () => {
    assert.deepEqual(
      normalizeHrmCompensationInput("hrm-job-levels", {
        code: "IC3",
        skillsWeight: "3",
        responsibilityWeight: "2.5",
      }),
      {
        code: "IC3",
        equalValueCriteria: [
          { criterion: "skills", weight: "3" },
          { criterion: "responsibility", weight: "2.5" },
        ],
      },
    );
  });

  test("empty slots fold to an empty criteria list (the write refuses it by name)", () => {
    assert.deepEqual(normalizeHrmCompensationInput("hrm-job-levels", { code: "IC3", skillsWeight: "" }), {
      code: "IC3",
      equalValueCriteria: [],
    });
  });

  test("no slots leaves the body alone", () => {
    const body = { code: "IC3", name: "Three" };
    assert.equal(normalizeHrmCompensationInput("hrm-job-levels", body), body);
  });
});
