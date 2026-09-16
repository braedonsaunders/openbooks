import "server-only";
import { applicationTool } from "../application/tool-catalog";
import { signApplicationCommand } from "../assistant/application-proposals";
import type { Authz } from "../authz";

/**
 * Finding proposals resolved into governed review cards.
 *
 * Packs persist `{ tool, input, label }` under `summary.proposedCommand`
 * (engine findingSummaryWithProposal). This module resolves that carrier into
 * the EXACT proposal shape the chat's ApplicationCommandCard consumes, minting
 * the confirm token for the current viewer (tokens bind actor + tenant +
 * input + expiry, so they are never stored). Anything unresolvable fails
 * closed to null — the finding still renders, just without Apply — mirroring
 * the checks POST /api/assistant/application-command enforces at apply time.
 */

export interface FindingProposalCommand {
  toolName: string;
  title: string;
  destructive: boolean;
  input: Record<string, unknown>;
  confirmToken: string;
}

type ProposalCarrier = {
  tool: string;
  input: Record<string, unknown>;
  label: string;
};

/** The well-formed carrier, or null when the summary carries no proposal. */
export function carriedProposal(summary: Record<string, unknown>): ProposalCarrier | null {
  const raw = summary.proposedCommand;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { tool, input, label } = raw as {
    tool?: unknown;
    input?: unknown;
    label?: unknown;
  };
  if (typeof tool !== "string" || !tool) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (label !== undefined && (typeof label !== "string" || !label)) return null;
  return { tool, input: input as Record<string, unknown>, label: label as string };
}

export function findingProposalCommand(
  authz: Authz,
  summary: Record<string, unknown>,
): FindingProposalCommand | null {
  const carried = carriedProposal(summary);
  if (!carried) return null;
  const definition = applicationTool(carried.tool);
  if (!definition || definition.readOnly || definition.assistantConfirmation !== "always") return null;
  if (!definition.visibleTo(authz)) return null;
  const parsed = definition.inputSchema.safeParse(carried.input);
  if (!parsed.success) return null;
  const input = parsed.data as Record<string, unknown>;
  return {
    toolName: definition.name,
    title: carried.label || definition.title,
    destructive: definition.destructive,
    input,
    confirmToken: signApplicationCommand(definition.name, input, authz),
  };
}
