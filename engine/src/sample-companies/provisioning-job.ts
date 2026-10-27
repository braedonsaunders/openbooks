import { randomUUID } from "node:crypto";
import { sampleCompanyFeatures } from "./features.ts";
import {
  sampleCompanyFailureBody,
  type SampleCompanyFailureBody,
  type SampleCompanyProvisioningStage,
} from "./provisioning-failures.ts";
import {
  createSampleCompany,
  type CreateSampleCompanyResult,
  type SampleCompanyProvisionDeps,
} from "./service.ts";

/** Who asked for which industry. Features derive from the industry, never the request. */
export interface SampleCompanyProvisioningRequest {
  industryKey: string;
  memberUserId: string;
  sourceOrgId: string;
  memberName: string;
}

/**
 * Progress a background run publishes: the stage now running, and — once the
 * run has failed — the operator-facing failure body for that run.
 */
export interface SampleCompanyProvisioningProgress {
  stage: SampleCompanyProvisioningStage | null;
  failure?: SampleCompanyFailureBody;
}

/**
 * Run one sample-company provisioning request outside the web request that
 * started it. The domain pipeline is unchanged — the same access check,
 * per-member lock, resume, compensation and staged refusals apply — and each
 * stage is published as it starts. A failure publishes the same staged body
 * the synchronous API returned, with a support reference that matches the
 * server log entry, and then rethrows so the run is recorded as failed.
 *
 * Progress is advisory: a publishing failure is logged and never stops or
 * relabels the provisioning work.
 */
export async function runSampleCompanyProvisioning(
  request: SampleCompanyProvisioningRequest,
  publish: (progress: SampleCompanyProvisioningProgress) => Promise<void>,
  deps: Omit<SampleCompanyProvisionDeps, "onStage"> = {},
): Promise<CreateSampleCompanyResult> {
  let current: SampleCompanyProvisioningStage | null = null;
  const report = async (progress: SampleCompanyProvisioningProgress) => {
    try {
      await publish(progress);
    } catch (error) {
      console.error("[sample-company] progress could not be published", error);
    }
  };
  try {
    return await createSampleCompany(
      {
        industryKey: request.industryKey,
        memberUserId: request.memberUserId,
        sourceOrgId: request.sourceOrgId,
        memberName: request.memberName,
        features: sampleCompanyFeatures(request.industryKey),
      },
      {
        ...deps,
        onStage: async (stage) => {
          current = stage;
          await report({ stage });
        },
      },
    );
  } catch (error) {
    const requestId = randomUUID();
    const failure = sampleCompanyFailureBody(error, requestId);
    console.error("[sample-company] provisioning failed", {
      requestId,
      stage: failure.stage ?? current,
      error: (error as { cause?: unknown } | null)?.cause ?? error,
    });
    await report({ stage: current, failure });
    throw error;
  }
}
