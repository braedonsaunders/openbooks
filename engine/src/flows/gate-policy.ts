import { automationGraphSchema } from "@openbooks/forms-core";

/** Only an explicit policy frozen on the submitting run permits self-approval. */
export function pinnedGateAllowsSelfApproval(context: unknown, nodeId: string): boolean {
  if (!context || typeof context !== "object") return false;
  const policy = (context as { submissionPolicy?: unknown }).submissionPolicy;
  if (!policy || typeof policy !== "object") return false;
  const parsed = automationGraphSchema.safeParse((policy as { graph?: unknown }).graph);
  if (!parsed.success) return false;
  const node = parsed.data.nodes.find((candidate) => candidate.id === nodeId);
  return node?.data.kind === "gate" && node.data.gate.preventSelfApproval === false;
}
