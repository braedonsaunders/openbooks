/**
 * Staged sample-company provisioning failures (OM-14).
 *
 * Every unexpected failure inside createSampleCompany is reported by the
 * pipeline STAGE that produced it — template generation, clone/copy of the
 * template's posted history, finalization, or document-numbering
 * reconciliation — with a stable machine-readable code and an
 * operator-facing message. The message is a fixed per-stage string: it never
 * carries SQL text, constraint names, or other internal detail. The full
 * cause is logged server-side (the house console.error shape) and kept on
 * `cause` for operators with log access, but it is never serialized to the
 * API response.
 *
 * Known validation refusals (unknown industry, no access to the source
 * organization) are NOT staged: they keep their specific messages and are
 * thrown before any stage runs.
 */
export class SampleCompanyError extends Error {
  // Typed as string (not the literal) so staged subclasses can narrow the
  // name to their own refusal without retyping the base.
  readonly name: string = "SampleCompanyError";
}

export type SampleCompanyProvisioningStage =
  | "template"
  | "clone"
  | "finalize"
  | "numbering";

export const SAMPLE_COMPANY_STAGE_CODES: Record<
  SampleCompanyProvisioningStage,
  string
> = {
  template: "sample-company-template-failed",
  clone: "sample-company-clone-failed",
  finalize: "sample-company-finalize-failed",
  numbering: "sample-company-numbering-failed",
};

const SAMPLE_COMPANY_STAGE_PHRASES: Record<
  SampleCompanyProvisioningStage,
  string
> = {
  template: "preparing the verified template failed",
  clone: "copying the template's posted history failed",
  finalize: "finalizing the new company failed",
  numbering: "reconciling document numbering failed",
};

export function sampleCompanyStageMessage(
  stage: SampleCompanyProvisioningStage,
): string {
  return (
    `Sample company could not be created: ${SAMPLE_COMPANY_STAGE_PHRASES[stage]}. ` +
    "Nothing was created; you can retry."
  );
}

export class SampleCompanyProvisioningError extends SampleCompanyError {
  override readonly name = "SampleCompanyProvisioningError";
  readonly stage: SampleCompanyProvisioningStage;
  readonly code: string;

  constructor(stage: SampleCompanyProvisioningStage, options?: { cause?: unknown }) {
    super(sampleCompanyStageMessage(stage), options);
    this.stage = stage;
    this.code = SAMPLE_COMPANY_STAGE_CODES[stage];
  }
}

/**
 * Run one provisioning stage, converting any unexpected failure into the
 * stage's named refusal. An already-staged refusal passes through untouched
 * so nested stages cannot relabel each other. The original error is logged
 * with its full detail and retained as `cause`; only the fixed per-stage
 * message ever reaches the API body.
 */
export async function runProvisioningStage<T>(
  stage: SampleCompanyProvisioningStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SampleCompanyProvisioningError) throw error;
    console.error(`[sample-company] ${stage} stage failed`, error);
    throw new SampleCompanyProvisioningError(stage, { cause: error });
  }
}
