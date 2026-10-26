import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

interface RouteState {
  nativeCalls: Array<{ asOf?: string; snapshot: Record<string, unknown> }>;
  recorded: Array<Record<string, unknown>>;
  nativeMode: "pool" | "marginLoss" | "marginMixed";
  fileId: string;
  versionId: string;
  bytes: Buffer;
  contentHash: string;
}

const routeState: RouteState = {
  nativeCalls: [],
  recorded: [],
  nativeMode: "pool",
  fileId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  bytes: Buffer.from(
    JSON.stringify([
      {
        awardRef: "issued-card-001",
        amount: "32.00",
        currency: "CAD",
        periodFrom: "2026-07-12",
        periodTo: "2026-07-18",
        issueDate: "2026-07-24",
        paidDate: "2026-07-29",
      },
    ]),
    "utf8",
  ),
  contentHash: "",
};
routeState.contentHash = createHash("sha256").update(routeState.bytes).digest("hex");
(globalThis as typeof globalThis & Record<string, unknown>).openbooksSourceFirstRouteState =
  routeState;

const mockSources = new Map<string, string>([
  [
    "mock:route-factory",
    `
    export function defineRoute(options) {
      return async (request, context) => {
        const params = options.params ? options.params.parse(await context.params) : undefined
        const body = options.body ? options.body.parse(await request.json()) : undefined
        return options.handler({ request, authz: { user: { orgId: 'org-1', id: 'operator-1' } }, params, body })
      }
    }
  `,
  ],
  [
    "mock:file-cabinet",
    `
    const state = globalThis.openbooksSourceFirstRouteState
    export async function getFile(_orgId, fileId) {
      return fileId === state.fileId ? { id: state.fileId, isInactive: false, versions: [{ id: state.versionId, contentHash: state.contentHash, sizeBytes: state.bytes.length }] } : null
    }
    export async function getFileBlob(_orgId, fileId, _viewer, versionId) {
      if (fileId !== state.fileId || versionId !== state.versionId) return null
      return { versionId, bytes: state.bytes, filename: 'issued-awards.json', contentType: 'application/json' }
    }
  `,
  ],
  ["mock:file-viewer", `export function fileViewer() { return {} }`],
  [
    "mock:benefit-api",
    `
    export { parseRetainedSourceRow, parseRetainedSourceArtifact, combineRetainedSourceClaims, sourceEvidenceNativePreviewDigest } from ${JSON.stringify(new URL("../../../../../../engine/src/hrm/benefits/retained-source.ts", import.meta.url).href)}
    const state = globalThis.openbooksSourceFirstRouteState
    export async function getBenefitProgram() { return { revision: 7, currency: "CAD" } }
    export async function reconcileIncentivePeriod(query) {
      if (state.nativeMode === 'marginLoss' || state.nativeMode === 'marginMixed') {
        const snapshot = {
          kind: 'incentive-native-measure-without-award',
          metric: 'project_margin',
          measured: { metric: 'project_margin', value: '-2000.0000' },
          measuredSource: {
            metric: 'project_margin', scope: 'company', digest: 'margin-loss-digest',
            projects: [{ projectId: 'project-loss', shares: [{ employmentId: '55555555-5555-4555-8555-555555555555', weight: '1', value: '-200.0000' }] }],
            carryForward: { '55555555-5555-4555-8555-555555555555': '-200.0000' },
          },
        }
        state.nativeCalls.push({ asOf: query.asOf, snapshot })
        return {
          preview: state.nativeMode === 'marginMixed' ? {
            sourceSnapshot: snapshot, programRevision: 49,
            visibleRecipients: [{ employmentId: '77777777-7777-4777-8777-777777777777', value: '1000.0000' }],
            computation: { measuredValue: '8000.0000', totalAwarded: '1000.0000' },
          } : null,
          nativeMeasureOnly: state.nativeMode === 'marginMixed' ? null : { sourceSnapshot: snapshot, programRevision: 49, measured: { value: '-2000.0000' } },
        }
      }
      const snapshot = { cutoff: query.asOf ?? 'current', sourceRevision: query.asOf === '2026-07-20' ? 'early' : 'late' }
      state.nativeCalls.push({ asOf: query.asOf, snapshot })
      return {
        preview: {
          sourceSnapshot: snapshot,
          visibleRecipients: [],
          programRevision: 49,
          computation: { measuredValue: '100.00', totalAwarded: '80.00' },
        },
        nativeMeasureOnly: null,
      }
    }
    export async function recordSourceEvidencedFirstIncentiveAward(query) {
      state.recorded.push(query)
      return { id: '33333333-3333-4333-8333-333333333333', status: 'draft' }
    }
    export async function activateBenefitProgram() {}
    export async function addProgramMembership() {}
    export async function closeBenefitProgram() {}
    export async function listBenefitApprovalPolicies() { return [] }
    export async function listProgramMemberships() { return [] }
    export async function removeProgramMembership() {}
    export async function updateBenefitProgram() {}
    export async function settleIncentivePeriod() {}
  `,
  ],
  ["mock:database", `export const db = {}`],
  [
    "mock:route-errors",
    `
    import { NextResponse } from ${JSON.stringify(import.meta.resolve("next/server"))}
    export function benefitsErrorResponse(error) { return NextResponse.json({ error: error.message }, { status: 400 }) }
  `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@/lib/api/route", "mock:route-factory"],
  ["@/lib/file-cabinet", "mock:file-cabinet"],
  ["../../../file-cabinet/lib", "mock:file-viewer"],
  ["@openbooks/engine/hrm/benefits", "mock:benefit-api"],
  ["@openbooks/engine/platform/database", "mock:database"],
  ["../../benefits/_lib", "mock:route-errors"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { POST } = (await import("./route")) as {
  POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
};

const PROGRAM_ID = "44444444-4444-4444-8444-444444444444";
const EMPLOYMENT_ID = "55555555-5555-4555-8555-555555555555";
const SOURCE_FIELDS = {
  sourceRowRefPointer: "/awardRef",
  amountPointer: "/amount",
  currencyPointer: "/currency",
  periodFromPointer: "/periodFrom",
  periodToPointer: "/periodTo",
  sourceIssueDatePointer: "/issueDate",
  sourcePaidDatePointer: "/paidDate",
};

function request(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/hrm/benefit-programs/${PROGRAM_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: PROGRAM_ID }) },
  );
}

function selectionBody(
  action: "previewSourceEvidence" | "recordSourceEvidenceFirst",
  asOf: string,
  sourceEvidenceClass:
    "missing-source-identity" | "source-paid-above-native-measure" = "missing-source-identity",
) {
  return {
    action,
    expectedProgramRevision: 7,
    employmentId: EMPLOYMENT_ID,
    periodFrom: "2026-07-12",
    periodTo: "2026-07-18",
    asOf,
    sourceEvidenceClass,
    sourceArtifacts: [
      {
        fileId: routeState.fileId,
        versionId: routeState.versionId,
        rowPointer: "/0",
        sourceFields: SOURCE_FIELDS,
      },
    ],
    ...(action === "recordSourceEvidenceFirst"
      ? {
          requestKey: "66666666-6666-4666-8666-666666666666",
          mappingAttestation: {
            basis: "Reviewed retained award register and employment ledger",
            reason: "Source row carries no native employee identity",
            confirmed: true,
          },
          ...(sourceEvidenceClass === "source-paid-above-native-measure"
            ? {
                governingDecisionAttestation: {
                  basis: "Recorded program decision for this closed period",
                  reason: "Source amount was issued above the negative native measure",
                  confirmed: true,
                },
              }
            : {}),
          reason: "Record the source-issued obligation for the missing identity period",
        }
      : {}),
  };
}

test("source-first route binds record to the reviewed native cutoff and source digest", async () => {
  routeState.nativeMode = "pool";
  routeState.nativeCalls = [];
  routeState.recorded = [];

  const earlyResponse = await request(selectionBody("previewSourceEvidence", "2026-07-20"));
  const earlyPreview = (await earlyResponse.json()) as {
    sourceEvidencePreview: { nativePreview: { digest: string } };
  };
  const lateResponse = await request(selectionBody("previewSourceEvidence", "2026-07-31"));
  const latePreview = (await lateResponse.json()) as {
    sourceEvidencePreview: { nativePreview: { digest: string } };
  };
  assert.equal(earlyResponse.status, 200);
  assert.equal(lateResponse.status, 200);
  assert.notEqual(
    earlyPreview.sourceEvidencePreview.nativePreview.digest,
    latePreview.sourceEvidencePreview.nativePreview.digest,
  );

  const recordResponse = await request({
    ...selectionBody("recordSourceEvidenceFirst", "2026-07-31"),
    expectedNativePreviewDigest: latePreview.sourceEvidencePreview.nativePreview.digest,
  });
  assert.equal(recordResponse.status, 200);
  assert.deepEqual(
    routeState.nativeCalls.map((call) => call.asOf),
    ["2026-07-20", "2026-07-31", "2026-07-31"],
  );
  assert.equal(routeState.recorded.length, 1);
  assert.equal(routeState.recorded[0]?.asOf, "2026-07-31");
  assert.equal(
    routeState.recorded[0]?.expectedNativePreviewDigest,
    latePreview.sourceEvidencePreview.nativePreview.digest,
  );
});

test("source-paid-above-native-measure route binds paid date, governing decision and measure-only digest", async () => {
  routeState.nativeMode = "marginLoss";
  routeState.nativeCalls = [];
  routeState.recorded = [];

  const previewResponse = await request(
    selectionBody("previewSourceEvidence", "2026-07-31", "source-paid-above-native-measure"),
  );
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()) as {
    sourceEvidencePreview: {
      sourcePaidDate?: string;
      nativePreview: {
        digest: string;
        measuredValue: string;
        canRecordFirstObligation: boolean;
        targetCarryForward: string | null;
        nativePoolAvailable: boolean;
      };
    };
  };
  assert.equal(preview.sourceEvidencePreview.sourcePaidDate, "2026-07-29");
  assert.equal(preview.sourceEvidencePreview.nativePreview.nativePoolAvailable, false);
  assert.equal(preview.sourceEvidencePreview.nativePreview.measuredValue, "-2000.0000");
  assert.equal(preview.sourceEvidencePreview.nativePreview.targetCarryForward, "-200.0000");
  assert.equal(preview.sourceEvidencePreview.nativePreview.canRecordFirstObligation, true);

  const digest = preview.sourceEvidencePreview.nativePreview.digest;
  const withoutGoverning: Record<string, unknown> = {
    ...selectionBody("recordSourceEvidenceFirst", "2026-07-31", "source-paid-above-native-measure"),
    expectedNativePreviewDigest: digest,
  };
  delete withoutGoverning.governingDecisionAttestation;
  const refusedGoverning = await request(withoutGoverning);
  assert.equal(refusedGoverning.status, 400);
  assert.equal(routeState.recorded.length, 0);

  const withoutPaidPointer = selectionBody(
    "recordSourceEvidenceFirst",
    "2026-07-31",
    "source-paid-above-native-measure",
  ) as unknown as {
    sourceArtifacts: Array<{ sourceFields: Record<string, string> }>;
  } & Record<string, unknown>;
  const { sourcePaidDatePointer: _omitted, ...fieldsWithoutPaid } =
    withoutPaidPointer.sourceArtifacts[0]!.sourceFields;
  void _omitted;
  withoutPaidPointer.sourceArtifacts = [
    { ...withoutPaidPointer.sourceArtifacts[0]!, sourceFields: fieldsWithoutPaid },
  ];
  const refusedPaid = await request({ ...withoutPaidPointer, expectedNativePreviewDigest: digest });
  assert.equal(refusedPaid.status, 400);
  assert.equal(routeState.recorded.length, 0);

  const recordResponse = await request({
    ...selectionBody("recordSourceEvidenceFirst", "2026-07-31", "source-paid-above-native-measure"),
    expectedNativePreviewDigest: digest,
  });
  assert.equal(recordResponse.status, 200);
  assert.equal(routeState.recorded.length, 1);
  assert.equal(routeState.recorded[0]?.sourceEvidenceClass, "source-paid-above-native-measure");
  assert.equal(routeState.recorded[0]?.sourcePaidDate, "2026-07-29");
  assert.deepEqual(routeState.recorded[0]?.governingDecisionAttestation, {
    basis: "Recorded program decision for this closed period",
    reason: "Source amount was issued above the negative native measure",
    confirmed: true,
  });
  assert.equal(routeState.recorded[0]?.expectedNativePreviewDigest, digest);
  routeState.nativeMode = "pool";
});

test("source-paid preview allows the target loss when other recipients are payable", async () => {
  routeState.nativeMode = "marginMixed";
  const response = await request(
    selectionBody("previewSourceEvidence", "2026-07-31", "source-paid-above-native-measure"),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    sourceEvidencePreview: {
      nativePreview: { canRecordFirstObligation: boolean; nativePoolAvailable: boolean };
    };
  };
  assert.equal(body.sourceEvidencePreview.nativePreview.nativePoolAvailable, true);
  assert.equal(body.sourceEvidencePreview.nativePreview.canRecordFirstObligation, true);
  routeState.nativeMode = "pool";
});
