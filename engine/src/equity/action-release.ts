/**
 * The engine-owned release of an Equity action Flow decision, registered
 * for the equity_action subject at boot (composition/install.ts). It runs
 * inside decideGate's transaction, so a refusal — the action no longer
 * applies to the current history, the requester no longer holds the duty,
 * a self decision — rolls the gate decision back with it.
 */
import { applyEquityAccountPolicy, type RecordAccountPolicyInput } from "./account-policy.ts";
import { applyCompensationRun } from "./compensation-run.ts";
import { applySecurityEvent, type RecordEventInput } from "./events.ts";
import { releaseEquityAction, type EquityAction, type EquityActionApplier } from "./governance.ts";
import { applyInterestRun } from "./interest-run.ts";
import {
  applyMfnElection,
  applyMfnReversal,
  type ElectMfnInput,
  type ReverseMfnInput,
} from "./mfn.ts";
import {
  applyRoundAmendment,
  applyRoundVoid,
  type AmendRoundInput,
  type VoidRoundInput,
} from "./rounds.ts";
import {
  applyReserveChange,
  applyShareClassAmendment,
  applySplit,
  type AmendShareClassInput,
  type ChangePlanReserveInput,
  type RecordSplitInput,
} from "./structure.ts";

const event: EquityActionApplier = (payload, actorId, orgId) =>
  applySecurityEvent({
    ...(payload as unknown as RecordEventInput),
    orgId,
    actorId,
  });

const APPLIERS: Readonly<Record<EquityAction, EquityActionApplier>> = {
  void: event,
  reverse: event,
  repurchase: event,
  repay: event,
  cancel_convertible: event,
  class_amendment: (payload, actorId, orgId) =>
    applyShareClassAmendment({
      ...(payload as unknown as AmendShareClassInput),
      orgId,
      actorId,
    }),
  split: (payload, actorId, orgId) =>
    applySplit({ ...(payload as unknown as RecordSplitInput), orgId, actorId }),
  reserve_change: (payload, actorId, orgId) =>
    applyReserveChange({
      ...(payload as unknown as ChangePlanReserveInput),
      orgId,
      actorId,
    }),
  mfn_election: (payload, actorId, orgId) =>
    applyMfnElection({
      ...(payload as unknown as ElectMfnInput),
      orgId,
      actorId,
    }),
  mfn_reversal: (payload, actorId, orgId) =>
    applyMfnReversal({
      ...(payload as unknown as ReverseMfnInput),
      orgId,
      actorId,
    }),
  round_amendment: (payload, actorId, orgId) =>
    applyRoundAmendment({
      ...(payload as unknown as AmendRoundInput),
      orgId,
      actorId,
    }),
  round_void: (payload, actorId, orgId) =>
    applyRoundVoid({
      ...(payload as unknown as VoidRoundInput),
      orgId,
      actorId,
    }),
  compensation_run: (payload, actorId, orgId) =>
    applyCompensationRun({
      orgId,
      actorId,
      subsidiaryId: String(payload.subsidiaryId),
      throughDate: String(payload.throughDate),
    }),
  interest_run: (payload, actorId, orgId) =>
    applyInterestRun({
      orgId,
      actorId,
      subsidiaryId: String(payload.subsidiaryId),
      throughDate: String(payload.throughDate),
    }),
  account_policy: (payload, actorId, orgId) =>
    applyEquityAccountPolicy({
      ...(payload as unknown as RecordAccountPolicyInput),
      orgId,
      actorId,
    }),
};

/** Structural args, assignable to the registered release handler type. */
export async function releaseEquityActionFlowApproval(args: {
  subjectId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  approvalRunId?: string;
  ctx: { orgId: string; userId?: string | null };
}): Promise<void> {
  await releaseEquityAction(args, APPLIERS);
}
