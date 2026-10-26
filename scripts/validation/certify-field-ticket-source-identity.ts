/**
 * Certify one native Field Ticket to one exact external source ticket.
 *
 * The binding is a human-reviewed crosswalk: the operator selects the exact
 * native ticket and revision, the exact source ticket in a retained File
 * Cabinet source file (pinned file, version and SHA-256), and the explicit
 * reference map, and attests to the mapping with a reason. The governed
 * engine command re-reads the actual retained bytes, verifies the parsed
 * row membership and every native fact under lock, and projects only the
 * source identity metadata onto the native ticket.
 *
 * File membership alone does not prove lineage, and artifact hashes alone
 * do not certify identity: the attestation supplies the mapping authority.
 * Certification never certifies hours, amounts or roles, and missing source
 * charges are admitted afterwards only through the governed importer.
 *
 * Usage: npx tsx scripts/validation/certify-field-ticket-source-identity.ts
 *   --org=<uuid> --actor=<target-org user UUID>
 *   --ticket=<native field ticket UUID> --revision=<current revision token>
 *   --source-system=<stable connector id> --source-ticket=<source ticket id>
 *   --source-file=<Cabinet file UUID> --source-version=<file version UUID>
 *   --sha256=<pinned file SHA-256> --request-id=<uuid>
 *   --attestation=<operator attestation> --reason=<certification reason>
 *   --refs=<JSON explicit reference map>
 *   [--apply --production]
 *
 * Without --apply the command prints the reviewed binding and the native
 * ticket's current scoped revision, and writes nothing.
 */
import {
  certifyFieldTicketSourceIdentity,
  listFieldTicketSourceCertificationCandidates,
  type FieldTicketSourceReferenceMapInput,
} from "@openbooks/engine/projects/field-ticket-source-certification";
import { assertImportOrgId } from "./field-ticket-import.ts";
import { resolveTargetOrg } from "./target-org.ts";
import { retry } from "./retry.ts";

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split("=");
      return [key!, value.length ? value.join("=") : "true"];
    }),
);
const required = (key: string): string => {
  const value = args.get(key)?.trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
};

const ORG = assertImportOrgId(
  args.get("org") ??
    process.env.TARGET_ORG ??
    process.env.SANDBOX_ORG ??
    (() => {
      throw new Error("--org, TARGET_ORG, or SANDBOX_ORG is required");
    })(),
);
const APPLY = args.get("apply") === "true";
if (args.has("identity-bindings")) {
  throw new Error(
    "source identity admission is held through manifests; certify one reviewed ticket through this command instead",
  );
}

function parseReferenceMap(raw: string): FieldTicketSourceReferenceMapInput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error("--refs must be the explicit reference map as JSON", { cause });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--refs must be the explicit reference map as a JSON object");
  }
  const map = value as Record<string, unknown>;
  const text = (key: string): string | null => {
    const field = map[key];
    if (field === null || field === undefined) return null;
    if (typeof field !== "string") throw new Error(`--refs.${key} must be a string or null`);
    return field;
  };
  const jobRef = text("jobRef");
  const projectId = text("projectId");
  if (!jobRef || !projectId)
    throw new Error("--refs must name the source job reference and its reviewed native project");
  return {
    jobRef,
    customerRef: text("customerRef"),
    foremanRef: text("foremanRef"),
    superintendentRef: text("superintendentRef"),
    projectId,
    customerPartyId: text("customerPartyId"),
    foremanPartyId: text("foremanPartyId"),
    superintendentPartyId: text("superintendentPartyId"),
  };
}

const input = {
  orgId: ORG,
  actorId: required("actor"),
  requestId: required("request-id"),
  nativeDocumentId: required("ticket"),
  expectedNativeRevision: required("revision"),
  sourceSystem: required("source-system"),
  sourceTicketId: required("source-ticket"),
  sourceFileId: required("source-file"),
  sourceVersionId: required("source-version"),
  sourceFileSha256: required("sha256"),
  attestation: required("attestation"),
  reason: required("reason"),
  explicitReferenceMap: parseReferenceMap(required("refs")),
};

(async () => {
  await resolveTargetOrg(ORG);
  if (!APPLY) {
    const { tickets } = await retry(() =>
      listFieldTicketSourceCertificationCandidates({
        orgId: ORG,
        actorId: input.actorId,
      }),
    );
    const candidate = tickets.find(
      (ticket) => ticket.nativeDocumentId === input.nativeDocumentId.toLowerCase(),
    );
    console.log(
      JSON.stringify(
        {
          mode: "plan",
          writes: 0,
          candidate: candidate ?? null,
          reviewedBinding: {
            nativeDocumentId: input.nativeDocumentId,
            expectedNativeRevision: input.expectedNativeRevision,
            sourceSystem: input.sourceSystem,
            sourceTicketId: input.sourceTicketId,
            sourceFileId: input.sourceFileId,
            sourceVersionId: input.sourceVersionId,
            sourceFileSha256: input.sourceFileSha256,
            basis: "human_reviewed_crosswalk_operator_attestation",
          },
          remedy: "review the binding, then re-run with --apply to certify",
        },
        null,
        2,
      ),
    );
    return;
  }
  const record = await retry(() => certifyFieldTicketSourceIdentity(input));
  console.log(JSON.stringify({ mode: "apply", record }, null, 2));
})().catch((error) => {
  const chain: string[] = [];
  for (let cause = error; cause; cause = cause.cause) {
    if (cause?.message) chain.push(String(cause.message).replace(/\s+/g, " ").slice(0, 300));
  }
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});
