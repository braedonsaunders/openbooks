"use server";

import type { ReactNode } from "react";
import {
  getBenefitsProgramWorkspace,
  resolveBenefitsProgram,
  BenefitsError,
} from "@openbooks/engine/hrm/benefits";
import { db } from "@openbooks/engine/platform/database";
import { requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import {
  isBenefitsProgramDrawerSelection,
  benefitsProgramCloseHref,
} from "../../../../lib/hrm/benefits-drawer-route";
import { loadBenefits } from "../../../../lib/hrm/benefits";
import { BlockList } from "../../../../components/viewspec/blocks";
import { ProgramWorkspace } from "./ProgramWorkspace";
import { benefitsProgramRecordBlocks } from "./view";

/** Every selection reauthorizes the native program and its scoped evidence. */
export async function loadBenefitProgramDrawer(
  query: string,
): Promise<{ content?: ReactNode; error?: string }> {
  const authz = await requirePermission("hrm.benefits.read");
  await requireFeatureEnabled(authz.user.orgId, "hrm");
  if (typeof query !== "string" || query.length > 8192)
    return { error: "The program selection is invalid. Reopen Programs." };
  const params = new URLSearchParams(query);
  const programId = params.get("program");
  if (!programId || !isBenefitsProgramDrawerSelection(params))
    return { error: "The program selection is invalid. Reopen Programs." };
  const sp = Object.fromEntries(params);
  const pageOffset = (key: string) => {
    const value = sp[key] ?? "1";
    const page = Number(value);
    if (
      !/^[1-9]\d*$/.test(value) ||
      !Number.isSafeInteger(page) ||
      !Number.isSafeInteger((page - 1) * 100)
    )
      throw new BenefitsError(
        "REFUSED",
        "The requested program page is invalid. Reopen the program.",
      );
    return (page - 1) * 100;
  };
  try {
    const participantOffset = pageOffset("participantsPage");
    const activityOffset = pageOffset("activityPage");
    const resolved = await resolveBenefitsProgram(db, authz.user.orgId, authz.user.id, programId);
    if (resolved.program.nativeKind !== "employer") {
      const workspace = await getBenefitsProgramWorkspace(
        db,
        authz.user.orgId,
        authz.user.id,
        programId,
        { participantOffset, activityOffset },
      );
      if (workspace.program.nativeKind === "entitlement")
        await requireFeatureEnabled(authz.user.orgId, "payroll");
      return { content: <ProgramWorkspace authz={authz} workspace={workspace} sp={sp} /> };
    }
    const data = await loadBenefits(authz, sp);
    const refusal =
      data.refusal ?? data.programsRefusal ?? data.awardsRefusal ?? data.optionsRefusal;
    if (refusal) return { error: refusal.message };
    data.programCloseHref = benefitsProgramCloseHref(params);
    if (!data.programDrawer && !data.programEditOpen)
      return { error: "This program is unavailable. Reopen Programs." };
    return {
      content: (
        <BlockList blocks={benefitsProgramRecordBlocks(data)} scope={data} searchParams={sp} />
      ),
    };
  } catch (error) {
    if (error instanceof BenefitsError) return { error: error.message };
    throw error;
  }
}
