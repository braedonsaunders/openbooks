import assert from "node:assert/strict";
import test from "node:test";
import {
  grantedRestrictionWithinCoverage,
  grantedScopeSetWithinCoverage,
  restrictionScopeAdditions,
  restrictionSubsidiaryScope,
  subsidiaryScopeWithinCeiling,
  unionSubsidiaryScopes,
  type SubsidiaryGrantCoverage,
  type SubsidiaryTreeNode,
} from "./actor-subsidiaries.ts";

// Pure delegation-ceiling comparison over already-resolved subsidiary sets.
// Explicit null is unrestricted; a finite list is never equivalent to all;
// empty grants nothing; unknown fails closed.
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

test("unrestricted grant fits only an unrestricted ceiling", () => {
  assert.equal(subsidiaryScopeWithinCeiling(null, null), true);
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A, B]), null), false);
  assert.equal(subsidiaryScopeWithinCeiling(new Set(), null), false);
  assert.equal(subsidiaryScopeWithinCeiling(undefined, null), false);
});

test("finite list covering every current entity is not all", () => {
  // Even when the granted list enumerates the ceiling's full contents, an
  // all-grant (null) against a finite ceiling refuses: future entities fall
  // inside `all` but outside the list.
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A, B]), null), false);
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A]), new Set([A, B])), false);
});

test("unrestricted ceiling grants any known scope", () => {
  assert.equal(subsidiaryScopeWithinCeiling(null, new Set([A])), true);
  assert.equal(subsidiaryScopeWithinCeiling(null, new Set()), true);
  assert.equal(subsidiaryScopeWithinCeiling(null, undefined), false);
});

test("finite grant must sit inside a finite ceiling; empty grants nothing", () => {
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A, B]), new Set([A])), true);
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A]), new Set([A, B])), false);
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A]), new Set()), true);
  assert.equal(subsidiaryScopeWithinCeiling(new Set(), new Set()), true);
  assert.equal(subsidiaryScopeWithinCeiling(undefined, new Set([A])), false);
  assert.equal(subsidiaryScopeWithinCeiling(undefined, new Set()), false);
});

test("unknown granted scope never fits", () => {
  assert.equal(subsidiaryScopeWithinCeiling(null, undefined), false);
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A]), undefined), false);
  assert.equal(subsidiaryScopeWithinCeiling(undefined, undefined), false);
});

test("union: unknown wins over unrestricted in either order", () => {
  assert.equal(unionSubsidiaryScopes([null, undefined]), undefined);
  assert.equal(unionSubsidiaryScopes([undefined, null]), undefined);
  assert.equal(unionSubsidiaryScopes([new Set([A]), undefined, null]), undefined);
  assert.equal(unionSubsidiaryScopes([null]), null);
  assert.equal(unionSubsidiaryScopes([new Set([A]), null]), null);
  assert.deepEqual(unionSubsidiaryScopes([new Set([A]), new Set([B])]), new Set([A, B]));
  assert.deepEqual(unionSubsidiaryScopes([]), new Set());
});

const ROOT = "11111111-1111-1111-1111-111111111111";
const CHILD = "22222222-2222-2222-2222-222222222222";
const LEAF = "33333333-3333-3333-3333-333333333333";
const TREE: SubsidiaryTreeNode[] = [
  { id: ROOT, parentId: null },
  { id: CHILD, parentId: ROOT },
  { id: LEAF, parentId: CHILD },
];

test("restriction resolution: only explicit null is legacy-all; malformed fails closed", () => {
  assert.equal(restrictionSubsidiaryScope(null, TREE), null);
  assert.equal(restrictionSubsidiaryScope({ mode: "all" }, TREE), null);
  assert.equal(restrictionSubsidiaryScope(undefined, TREE), undefined);
  assert.deepEqual(
    restrictionSubsidiaryScope({ mode: "list", subsidiaryIds: [ROOT.toUpperCase()] }, TREE),
    new Set([ROOT]),
  );
  assert.deepEqual(
    restrictionSubsidiaryScope({ mode: "subtree", subsidiaryId: CHILD }, TREE),
    new Set([CHILD, LEAF]),
  );
  assert.equal(restrictionSubsidiaryScope({ mode: "list", subsidiaryIds: "nope" } as never, TREE), undefined);
  assert.equal(restrictionSubsidiaryScope({ mode: "list", subsidiaryIds: [42] } as never, TREE), undefined);
  assert.equal(restrictionSubsidiaryScope({ mode: "subtree", subsidiaryId: 42 } as never, TREE), undefined);
  assert.equal(restrictionSubsidiaryScope({ mode: "island" } as never, TREE), undefined);
});

test("edit additions: narrowing adds nothing; finite to all is unbounded", () => {
  const empty = new Set<string>();
  assert.deepEqual(restrictionScopeAdditions(null, { mode: "list", subsidiaryIds: [ROOT] }, TREE), empty);
  assert.deepEqual(restrictionScopeAdditions({ mode: "all" }, { mode: "all" }, TREE), empty);
  assert.deepEqual(
    restrictionScopeAdditions({ mode: "list", subsidiaryIds: [ROOT] }, { mode: "list", subsidiaryIds: [ROOT] }, TREE),
    empty,
  );
  assert.deepEqual(
    restrictionScopeAdditions({ mode: "list", subsidiaryIds: [ROOT] }, { mode: "list", subsidiaryIds: [ROOT, CHILD] }, TREE),
    new Set([CHILD]),
  );
  assert.equal(restrictionScopeAdditions({ mode: "list", subsidiaryIds: [ROOT] }, { mode: "all" }, TREE), null);
  assert.equal(restrictionScopeAdditions(undefined, { mode: "list", subsidiaryIds: [ROOT] }, TREE), undefined);
  assert.equal(restrictionScopeAdditions(null, undefined, TREE), undefined);
});

test("edit additions: subtree targets are open-ended, not today's enumeration", () => {
  const empty = new Set<string>();
  // list[LEAF] -> subtree(LEAF) matches exactly today but grants LEAF's
  // future children: widening, so only an unrestricted ceiling passes.
  assert.equal(
    restrictionScopeAdditions({ mode: "list", subsidiaryIds: [LEAF] }, { mode: "subtree", subsidiaryId: LEAF }, TREE),
    null,
  );
  // Same-root and parent-to-child subtree moves grant no future the old
  // policy did not already cover.
  assert.deepEqual(
    restrictionScopeAdditions({ mode: "subtree", subsidiaryId: CHILD }, { mode: "subtree", subsidiaryId: CHILD }, TREE),
    empty,
  );
  assert.deepEqual(
    restrictionScopeAdditions({ mode: "subtree", subsidiaryId: CHILD }, { mode: "subtree", subsidiaryId: LEAF }, TREE),
    empty,
  );
  // Child-to-parent subtree grants the parent's future children.
  assert.equal(
    restrictionScopeAdditions({ mode: "subtree", subsidiaryId: LEAF }, { mode: "subtree", subsidiaryId: CHILD }, TREE),
    null,
  );
  // Subtree -> closed list is exact: future children leave the grant.
  assert.deepEqual(
    restrictionScopeAdditions({ mode: "subtree", subsidiaryId: ROOT }, { mode: "list", subsidiaryIds: [ROOT, CHILD] }, TREE),
    empty,
  );
});

const listLeaf: SubsidiaryGrantCoverage = {
  actorRestrictions: [{ mode: "list", subsidiaryIds: [LEAF] }],
  subsidiaries: TREE,
};
const subtreeChild: SubsidiaryGrantCoverage = {
  actorRestrictions: [{ mode: "subtree", subsidiaryId: CHILD }],
  subsidiaries: TREE,
};
const allActor: SubsidiaryGrantCoverage = {
  actorRestrictions: [{ mode: "all" }],
  subsidiaries: TREE,
};

test("coverage: all needs actor all; finite-all-today is not all", () => {
  assert.equal(grantedRestrictionWithinCoverage(listLeaf, { mode: "all" }), false);
  assert.equal(grantedRestrictionWithinCoverage(listLeaf, null), false);
  assert.equal(grantedRestrictionWithinCoverage(allActor, { mode: "all" }), true);
  assert.equal(
    grantedRestrictionWithinCoverage(
      { actorRestrictions: [{ mode: "list", subsidiaryIds: [ROOT, CHILD, LEAF] }], subsidiaries: TREE },
      { mode: "all" },
    ),
    false,
  );
});

test("coverage: finite-list actor cannot grant an open subtree that matches today", () => {
  // list[LEAF] resolves exactly to subtree(LEAF) today, but the subtree
  // grants LEAF's future children: the grant refuses.
  assert.equal(
    grantedRestrictionWithinCoverage(listLeaf, { mode: "subtree", subsidiaryId: LEAF }),
    false,
  );
  assert.equal(
    grantedRestrictionWithinCoverage(listLeaf, { mode: "list", subsidiaryIds: [LEAF] }),
    true,
  );
});

test("coverage: subtree admin delegates freely within its own subtree", () => {
  assert.equal(
    grantedRestrictionWithinCoverage(subtreeChild, { mode: "subtree", subsidiaryId: LEAF }),
    true,
  );
  assert.equal(
    grantedRestrictionWithinCoverage(subtreeChild, { mode: "subtree", subsidiaryId: CHILD }),
    true,
  );
  assert.equal(
    grantedRestrictionWithinCoverage(subtreeChild, { mode: "list", subsidiaryIds: [CHILD, LEAF] }),
    true,
  );
  assert.equal(
    grantedRestrictionWithinCoverage(subtreeChild, { mode: "subtree", subsidiaryId: ROOT }),
    false,
  );
  assert.equal(
    grantedRestrictionWithinCoverage(subtreeChild, { mode: "list", subsidiaryIds: [ROOT] }),
    false,
  );
});

test("coverage: absent or malformed actor rows never confer authority", () => {
  const unknownActor: SubsidiaryGrantCoverage = {
    actorRestrictions: [undefined as never],
    subsidiaries: TREE,
  };
  const malformedActor: SubsidiaryGrantCoverage = {
    actorRestrictions: [{ mode: "island" } as never],
    subsidiaries: TREE,
  };
  for (const coverage of [unknownActor, malformedActor]) {
    assert.equal(grantedRestrictionWithinCoverage(coverage, { mode: "all" }), false);
    assert.equal(grantedRestrictionWithinCoverage(coverage, null), false);
    assert.equal(
      grantedRestrictionWithinCoverage(coverage, { mode: "list", subsidiaryIds: [LEAF] }),
      false,
    );
    assert.equal(
      grantedRestrictionWithinCoverage(coverage, { mode: "subtree", subsidiaryId: LEAF }),
      false,
    );
    assert.equal(grantedScopeSetWithinCoverage(coverage, new Set()), false);
  }
  // A valid all-row still confers alongside an unknown sibling; the unknown
  // row itself contributes nothing.
  assert.equal(
    grantedRestrictionWithinCoverage(
      { actorRestrictions: [{ mode: "all" }, undefined as never], subsidiaries: TREE },
      { mode: "all" },
    ),
    true,
  );
  assert.equal(
    grantedRestrictionWithinCoverage(
      { actorRestrictions: [{ mode: "all" }, undefined as never], subsidiaries: TREE },
      { mode: "list", subsidiaryIds: [LEAF] },
    ),
    false,
  );
});

test("coverage: unknown and malformed grants fail closed", () => {
  assert.equal(grantedRestrictionWithinCoverage(allActor, undefined), false);
  assert.equal(grantedRestrictionWithinCoverage(allActor, { mode: "island" } as never), false);
  assert.equal(
    grantedRestrictionWithinCoverage(allActor, { mode: "list", subsidiaryIds: "nope" } as never),
    false,
  );
  assert.equal(grantedScopeSetWithinCoverage(allActor, undefined), false);
  assert.equal(grantedScopeSetWithinCoverage({ actorRestrictions: [], subsidiaries: TREE }, new Set()), true);
  assert.equal(grantedScopeSetWithinCoverage({ actorRestrictions: [], subsidiaries: TREE }, new Set([LEAF])), false);
});
