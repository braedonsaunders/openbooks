import {
  automationGraphSchema,
  lintAutomationGraph,
  profileFieldIds,
  type AutomationGraph,
} from "@openbooks/forms-core";
import { getFlowAdapter } from "./registry.ts";

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

  const profile = adapter.profile;
  const errors = lintAutomationGraph(parsed.data, profileFieldIds(profile), profile);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, graph: parsed.data, errors: [] };
}
