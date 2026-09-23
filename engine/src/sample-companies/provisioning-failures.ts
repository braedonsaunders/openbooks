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

/**
 * What actually exists after each stage fails. Template and clone fail
 * before any company row is committed (a failed template attempt is wiped;
 * a failed clone never commits), so "nothing was created" is the truth.
 * Finalize and numbering fail AFTER the clone committed, and the partial
 * company is deliberately left resumable — the refusal must say so, or the
 * operator reads "nothing was created" while a company with their name on
 * it exists and their retry silently adopts it.
 */
const SAMPLE_COMPANY_STAGE_OUTCOMES: Record<
  SampleCompanyProvisioningStage,
  string
> = {
  template: "Nothing was created; you can retry.",
  clone: "Nothing was created; you can retry.",
  finalize:
    "The company was created but its setup did not finish; retry resumes it from where it stopped.",
  numbering:
    "The company was created but its document numbering was not finished; retry resumes numbering.",
};

export function sampleCompanyStageMessage(
  stage: SampleCompanyProvisioningStage,
): string {
  return (
    `Sample company could not be created: ${SAMPLE_COMPANY_STAGE_PHRASES[stage]}. ` +
    SAMPLE_COMPANY_STAGE_OUTCOMES[stage]
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
