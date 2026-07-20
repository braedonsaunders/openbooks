import {
  automationGraphSchema,
  lintAutomationGraph,
  profileFieldIds,
  type AutomationGraph,
  type FlowSubjectProfile,
} from "@openbooks/forms-core";
import { getFlowAdapter } from "./registry.ts";
import { DOCUMENT_FLOW_KINDS } from "./subject-profiles.ts";

// Document approval release (pending_approval → approved | draft) is owned by
// the engine (decideGate → adapter.releaseApproval), never by an authored
// change_status node. Authoring one is redundant and — alongside another gating
// flow — could release a document early, so it is rejected at author time.
const ENGINE_MANAGED_RELEASE_STATUSES = new Set(["approved", "draft"]);

/**
 * Validate + lint a flow graph against its subject's profile — the ONE gate
 * every flow write (create/update/enable) should pass through. Combines the
 * zod graph schema with lintAutomationGraph (structure, vocabulary, writable
 * fields, worker-trigger compatibility) so the web API layer has a single
 * call.
 */
export function lintFlowGraphForSubject(
  subjectKind: string,
  graph: unknown,
  profileOverride?: FlowSubjectProfile,
): { ok: true; graph: AutomationGraph; errors: [] } | { ok: false; errors: string[] } {
  const adapter = getFlowAdapter(subjectKind);
  if (!adapter) return { ok: false, errors: [`unknown flow subject kind "${subjectKind}"`] };

  const parsed = automationGraphSchema.safeParse(graph);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "graph"}: ${i.message}`),
    };
  }

  const profile = profileOverride ?? adapter.profile;
  const errors = lintAutomationGraph(parsed.data, profileFieldIds(profile), profile);

  if (DOCUMENT_FLOW_KINDS.includes(subjectKind)) {
    for (const node of parsed.data.nodes) {
      if (
        node.data.kind === "action" &&
        node.data.action.action === "change_status" &&
        ENGINE_MANAGED_RELEASE_STATUSES.has(node.data.action.to)
      ) {
        errors.push(
          `node "${node.id}": change_status to "${node.data.action.to}" is not allowed — ` +
            `document approval release is engine-enforced; remove this node`,
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, graph: parsed.data, errors: [] };
}
