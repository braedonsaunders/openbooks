/**
 * Staged sample-company provisioning failures (OM-14).
 *
 * Every unexpected failure inside createSampleCompany is reported by the
 * pipeline STAGE that produced it — template generation, clone/copy of the
 * template's posted history, finalization, or document-numbering
 * reconciliation — with a stable machine-readable code and an
 * operator-facing message. The message is a fixed per-stage string: it never
 * carries SQL text, constraint names, or other internal detail — except a
 * deterministic guard refusal (Postgres P0001), whose guard-authored message
 * already names its remedy and replaces the stage's retry text, because
 * retrying a deterministic refusal cannot help (OM-13c). The full
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
 * What actually exists after each stage fails. Template fails before any
 * company row is committed (a failed template attempt is wiped), and a
 * failed clone's shell is compensated before the refusal is reported
 * (service compensateFailedClone) — so "nothing was created" is the truth
 * for both. When the clone-shell cleanup itself is refused, the error is a
 * precondition refusal naming the shell and its remedy, never this message.
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

  constructor(
    stage: SampleCompanyProvisioningStage,
    options?: { cause?: unknown; message?: string },
  ) {
    super(options?.message ?? sampleCompanyStageMessage(stage), options);
    this.stage = stage;
    this.code = SAMPLE_COMPANY_STAGE_CODES[stage];
  }
}

/**
 * A deterministic database refusal: Postgres raise_exception (code P0001),
 * the channel every trigger guard uses to refuse with a message that names
 * its remedy. Retrying cannot help against a deterministic guard, so the
 * refusal must carry the guard's own message — never the stage's "you can
 * retry" text. Only the guard-authored first line passes through (driver
 * DETAIL/HINT fields stay server-side); anything without a P0001 code keeps
 * the fixed per-stage message with no internal detail.
 */
export function guardRefusalMessage(error: unknown): string | undefined {
  const probe = error as {
    code?: unknown;
    message?: unknown;
    cause?: { code?: unknown; message?: unknown } | null;
  } | null;
  // The message must come from the level that carries the P0001 code: a
  // driver wrapper's own message ("db execute failed") is internal detail,
  // not the guard's refusal.
  const level =
    probe?.code === "P0001"
      ? probe
      : probe?.cause?.code === "P0001"
        ? probe.cause
        : undefined;
  if (!level) return undefined;
  const raw = typeof level.message === "string" ? level.message : undefined;
  const firstLine = raw?.split("\n", 1)[0]?.trim();
  return firstLine ? firstLine : undefined;
}

/**
 * A provisioning precondition that cannot proceed — e.g. a previous attempt
 * that could not be removed, so provisioning again would strand a second
 * org. Unlike unexpected stage failures these carry their specific message
 * (naming the stranded org and its remedy) past the stage wrapper:
 * relabelling them into the fixed per-stage string would hide both.
 */
export class SampleCompanyPreconditionError extends SampleCompanyError {
  override readonly name = "SampleCompanyPreconditionError";
}

/**
 * Run one provisioning stage, converting any unexpected failure into the
 * stage's named refusal. An already-staged refusal passes through untouched
 * so nested stages cannot relabel each other, as does a precondition refusal
 * whose specific message names a stranded org and its remedy. Any other
 * original error is logged with its full detail and retained as `cause`;
 * only the fixed per-stage message ever reaches the API body.
 */
export async function runProvisioningStage<T>(
  stage: SampleCompanyProvisioningStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SampleCompanyProvisioningError) throw error;
    if (error instanceof SampleCompanyPreconditionError) throw error;
    // OM-13c: a deterministic guard refusal already names its remedy, and
    // retrying it cannot help — surface the guard's message instead of the
    // stage's "you can retry" text. The code stays the stable per-stage
    // code and the full cause stays server-side on `cause`.
    const refusal = guardRefusalMessage(error);
    console.error(`[sample-company] ${stage} stage failed`, error);
    throw new SampleCompanyProvisioningError(stage, {
      cause: error,
      ...(refusal !== undefined ? { message: refusal } : {}),
    });
  }
}
