import {
  flowGraphSubjectScopeSchema,
  type AssigneeTarget,
  type AutomationGraph,
  type FlowSubjectProfile,
} from "@openbooks/forms-core";

/**
 * One-step approval setup — the four-click path to a governed record kind.
 *
 * Building an approval by hand meant a blank canvas, a manual drag from the
 * trigger handle to the gate handle, and approver rows that defaulted to a
 * broadcast nobody meant. This builder produces the complete graph instead:
 * an `on_submit` trigger, an optional total-threshold condition, and one
 * approval gate, all wired trigger → [condition] → gate. The caller persists
 * it through the native flow save path (lint + audited write), so a quick
 * approval is exactly as valid as a hand-built one.
 */

export type QuickApprovalApprover =
  { type: "user"; userId: string } | { type: "role"; role: string };

export type QuickApprovalInput = {
  approver: QuickApprovalApprover;
  /** Gate only submissions whose amount exceeds this. Omitted: gate everything. */
  threshold?: number;
  title?: string;
  /** Default true: the submitter can never sign off their own record. */
  preventSelfApproval?: boolean;
  /**
   * Legal entities this approval applies to. Omitted: the approval applies
   * organization-wide. When present it must name at least one entity, and
   * the generated graph carries it as its typed subject scope so admission
   * is decided before the flow can gate any other entity's records.
   */
  subsidiaryIds?: readonly string[];
};

export type QuickSetupRefusalCode =
  "bad-threshold" | "no-amount-field" | "unknown-role" | "unknown-user" | "bad-subject-scope";

export type QuickSetupResult =
  | { ok: true; graph: AutomationGraph; amountField: string | null }
  | { ok: false; code: QuickSetupRefusalCode; message: string };

/**
 * Description marker tagging flows the quick setup created, so the setup
 * dialog can find "its" flow again (to show state, or to disable it on
 * removal). A stable machine token — never translated copy — because the
 * lookup matches it exactly.
 */
export const QUICK_APPROVAL_FLOW_DESCRIPTION = "quick-approval";

/** Amount fields a threshold condition can compare, most canonical first. */
const AMOUNT_FIELD_PREFERENCE = [
  "total",
  "grossTotal",
  "amount",
  "netTotal",
  "subtotal",
  "openBalance",
  "lineCount",
];

/**
 * The subject's threshold-comparable number field, or null when the subject
 * exposes no amount (a threshold then has nothing to compare — the caller
 * must refuse it, not silently gate everything).
 */
export function quickApprovalAmountField(profile: FlowSubjectProfile): string | null {
  const numbers = new Set(
    profile.fields.filter((field) => field.type === "number").map((field) => field.key),
  );
  for (const key of AMOUNT_FIELD_PREFERENCE) {
    if (numbers.has(key)) return key;
  }
  return null;
}

function toAssignee(
  approver: QuickApprovalApprover,
  users: Set<string> | undefined,
  profile: FlowSubjectProfile,
): { assignee: AssigneeTarget } | { code: QuickSetupRefusalCode; message: string } {
  if (approver.type === "role") {
    if (!profile.roles?.includes(approver.role)) {
      return {
        code: "unknown-role",
        message:
          `role "${approver.role}" is not available for ${profile.label} — ` +
          `pick one of: ${(profile.roles ?? []).join(", ") || "(no roles)"}`,
      };
    }
    return { assignee: { type: "role", role: approver.role } };
  }
  if (!approver.userId.trim()) {
    return {
      code: "unknown-user",
      message: "choose a specific approver — the approver cannot be blank",
    };
  }
  if (users && !users.has(approver.userId)) {
    return {
      code: "unknown-user",
      message: `that approver is not an active member of this organization — pick an active user`,
    };
  }
  return { assignee: { type: "user", userId: approver.userId } };
}

/**
 * Build the complete, wired approval graph for a subject profile. Pure:
 * persistence (lint + audited write) stays with the caller so engine tests
 * and the web save path share this shape without sharing a transaction.
 */
export function buildQuickApprovalGraph(
  profile: FlowSubjectProfile,
  input: QuickApprovalInput,
  knownUserIds?: Set<string>,
): QuickSetupResult {
  const assignee = toAssignee(input.approver, knownUserIds, profile);
  if ("code" in assignee) return { ok: false, ...assignee };

  let amountField: string | null = null;
  if (input.threshold !== undefined) {
    if (!Number.isFinite(input.threshold) || input.threshold < 0) {
      return {
        ok: false,
        code: "bad-threshold",
        message: "the threshold must be zero or more — leave it blank to gate every submission",
      };
    }
    amountField = quickApprovalAmountField(profile);
    if (!amountField) {
      return {
        ok: false,
        code: "no-amount-field",
        message:
          `${profile.label} exposes no amount to compare — ` +
          `leave the threshold blank to gate every submission`,
      };
    }
  }

  let subjectScope: AutomationGraph["subjectScope"];
  if (input.subsidiaryIds !== undefined) {
    // The shared graph schema is the one authority on a legal-entity
    // limit — uuid shape, the entity cap, case canonicalization and
    // case-variant uniqueness all refuse here exactly as they do in the
    // ordinary flow editor, never through a second local check.
    const parsed = flowGraphSubjectScopeSchema.safeParse({
      subsidiaryIds: [...input.subsidiaryIds],
    });
    if (!parsed.success) {
      return {
        ok: false,
        code: "bad-subject-scope",
        message:
          "choose at least one legal entity for this approval, without repeats — " +
          "leave the legal entity blank to apply organization-wide",
      };
    }
    subjectScope = parsed.data;
  }

  const preventSelfApproval = input.preventSelfApproval ?? true;
  const gate = {
    title: input.title?.trim() || "Approval",
    assignees: [assignee.assignee],
    mode: "any" as const,
    preventSelfApproval,
  };

  if (!amountField) {
    return {
      ok: true,
      amountField: null,
      graph: {
        schemaVersion: 1,
        ...(subjectScope ? { subjectScope } : {}),
        nodes: [
          {
            id: "trigger",
            position: { x: 0, y: 0 },
            data: { kind: "trigger", trigger: { trigger: "on_submit" } },
          },
          { id: "gate", position: { x: 260, y: 0 }, data: { kind: "gate", gate } },
        ],
        edges: [{ id: "e1", source: "trigger", target: "gate", sourceHandle: "next" }],
      },
    };
  }

  return {
    ok: true,
    amountField,
    graph: {
      schemaVersion: 1,
      ...(subjectScope ? { subjectScope } : {}),
      nodes: [
        {
          id: "trigger",
          position: { x: 0, y: 0 },
          data: { kind: "trigger", trigger: { trigger: "on_submit" } },
        },
        {
          id: "condition",
          position: { x: 260, y: 0 },
          data: {
            kind: "condition",
            label: `Over ${input.threshold}`,
            rule: {
              op: "gt",
              field: amountField,
              value: input.threshold,
              valueType: "number" as const,
            },
          },
        },
        { id: "gate", position: { x: 520, y: 0 }, data: { kind: "gate", gate } },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "condition", sourceHandle: "next" },
        { id: "e2", source: "condition", target: "gate", sourceHandle: "then" },
      ],
    },
  };
}
