import { useTranslations } from "next-intl";
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
const fieldKeys = new Set([
  'identity', 'name', 'id', 'subsidiaryId', 'currency', 'expenseAccountId', 'liabilityAccountId', 'presentObligation', 'outflow', 'reliablyEstimable', 'evidence', 'discounting', 'discountEvidence', 'estimate', 'method', 'amount', 'outcomes', 'probability', 'minimum', 'maximum', 'reportingFramework', 'periodId', 'balance', 'events', 'recognized', 'liability', 'estimatedSettlement', 'disclosureRequired', 'priorLiability', 'currentPeriodCharge', 'entryId', 'requiredSubsidiaryIds',
  'existingId', 'existingObligationIds', 'ssp', 'standaloneSellingPrice', 'recognitionRuleId',
  'deferredAccountId', 'recognizedAccountId', 'totalAmount', 'catchUp', 'priorRecognized',
  'targetRecognized', 'remaining', 'netCredits', 'newTotal', 'pool',
  'remainingDistinct', 'additionsAtStandalonePrice', 'enforceableRightsEvidence', 'fxRate', 'bookId',
  'effectiveOn', 'scopeReductionPercent', 'commensurateStandalonePrice', 'additionalRightOfUse', 'transfersOwnership',
  'purchaseOptionReasonablyCertain', 'pvOfPayments', 'newRou', 'rouDelta', 'groupCarryingBefore',
  'groupCarryingAfter', 'groupValuationDelta', 'netAssets', 'nci', 'parentGain',
  'groupGain', 'recycledOci', 'transferredOci', 'totalGroupGain', 'retainedFairValue',
  'carryingLiability', 'carryingRou', 'stubInterest', 'stubRou', 'prepaidCarrying',
  'newLiability', 'liabilityDelta', 'removedLiability', 'removedRou', 'gain',
  'settlement', 'settlementPayment', 'payment', 'periods', 'annualRatePercent',
  'paymentTiming', 'paymentFrequency', 'assessment', 'dayCountPolicy', 'specializedAsset',
  'economicLifeMonths', 'leaseTermMonths', 'termThresholdPercent', 'fairValue', 'pvThresholdPercent',
  'assemblyItemId', 'expectedVersion', 'components', 'componentItemId', 'quantityPer', 'sortOrder',
  'effectiveFrom', 'effectiveTo', 'operationSeq', 'scrapPct', 'isByproduct', 'quantityBasis',
  'formulaOutputQuantity', 'outputCostWeight', 'routingId', 'supersedes', 'candidate',
  'operations', 'operationName', 'workCenterId', 'workCenter', 'setupMinutes', 'runMinutesPerUnit',
  'laborMinutesPerUnit', 'laborTimeSource', 'backflushAt', 'qualityGate', 'sequence', 'code',
  'version', 'producedItemId', 'status', 'kind', 'workOrderId', 'operationId', 'reasonId',
  'quantity', 'times', 'attemptedQty', 'actualSetupMinutes', 'actualRunMinutes', 'actualLaborMinutes',
  'itemId', 'onDate', 'batchQuantity', 'standardCost', 'baseUnit', 'controlsBeforeTransfer',
  'passThroughAccountId', 'controlEvidence', 'employmentId', 'grantId', 'pairId', 'bookId',
  'eliminationSubsidiaryId', 'ociAccountId', 'profitLossAccountId', 'sourceLineIds',
  'notPlannedOrLikely', 'nonTrade', 'qualificationEvidence', 'sourceChangeId', 'portion',
  'percent', 'books', 'cost', 'accumulated', 'salvage', 'remainingProductionUnits', 'proceeds',
  'proceedsAccountId', 'transfer', 'categoryId', 'assetNumber', 'buyerAmount', 'construction',
  'gainLossAccountId', 'remainingTerms', 'separateLease', 'agreement',
]);

/** A catalog label for a known proposal field; any other key renders
 * humanized (never the catch-all "additional detail" label), so a new
 * proposal shape stays readable before its labels land. */
export function humanizeFieldKey(key: string): string {
  // Sentence case like the catalog labels ("Settlement estimate"), never
  // the catch-all — a new proposal shape stays readable before its labels
  // land. Known acronyms keep their catalog labels; only genuinely unknown
  // keys pass through here.
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .split(" ")
    .filter((part) => part.length > 0)
    .join(" ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function useFieldLabel(): (key: string) => string {
  const t = useTranslations("accounting");
  return (key: string) =>
    fieldKeys.has(key) && t.has(`lifecycle.evidence.fields.${key}` as never)
      ? t(`lifecycle.evidence.fields.${key}` as never)
      : humanizeFieldKey(key);
}

/** Review the complete frozen proposal, including nested assessment inputs.
 * This is record evidence, not a regenerated report or a live calculation. */
export function ChangeEvidence({
  value,
  names = {},
}: {
  value: unknown;
  names?: Record<string, string>;
}) {
  const t = useTranslations("accounting");
  const label = useFieldLabel();
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">{t("lifecycle.evidence.notSupplied")}</span>;
  if (typeof value === "boolean") return <span>{value ? t("lifecycle.evidence.yes") : t("lifecycle.evidence.no")}</span>;
  if (typeof value === "string" || typeof value === "number")
    return (
      <span className="break-words">
        {names[String(value)] ?? String(value).replaceAll("_", " ")}
      </span>
    );
  if (Array.isArray(value))
    return (
      <div className="space-y-3">
        {value.map((v, i) => (
          <div key={i} className="rounded border p-3">
            <ChangeEvidence value={v} names={names} />
          </div>
        ))}
      </div>
    );
  if (typeof value === "object")
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("lifecycle.evidence.assessment")}</TableHead>
            <TableHead>{t("lifecycle.evidence.approvedProposal")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(value)
            .filter(([key]) => key !== "idempotencyKey")
            .map(([key, v]) => (
              <TableRow key={key}>
                <TableCell className="align-top">{label(key)}</TableCell>
                <TableCell>
                  <ChangeEvidence value={v} names={names} />
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    );
  return null;
}


export function ChangeFacts({ value }: { value: Record<string, unknown> }) {
  const t = useTranslations("accounting");
  const label = useFieldLabel();
  return (
    <dl className="grid grid-cols-2 gap-2">
      {Object.entries(value)
        .filter(([key, v]) => fieldKeys.has(key) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
        .map(([key, v]) => (
          <div key={key}>
            <dt className="text-sm text-slate-500">{label(key)}</dt>
            <dd>{typeof v === "boolean" ? v ? t("lifecycle.evidence.yes") : t("lifecycle.evidence.no") : String(v).replaceAll("_", " ")}</dd>
          </div>
        ))}
    </dl>
  );
}

type RecipeLine = Record<string, unknown>;

function asLines(value: unknown): RecipeLine[] {
  return Array.isArray(value) ? value.filter((line): line is RecipeLine => !!line && typeof line === "object" && !Array.isArray(line)) : [];
}

function lineKey(line: RecipeLine): string {
  return `${String(line.componentItemId ?? "")}|${line.operationSeq == null ? "" : String(line.operationSeq)}|${line.isByproduct === true ? "by" : "in"}`;
}

function lineText(value: unknown): string {
  if (value === null || value === undefined) return "…";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value).replaceAll("_", " ");
}

/** A manufacturing recipe revision as an old-vs-new diff: every proposed
 * line with its disposition, changed lines carrying their old → new values,
 * and removed lines retained below — the approver never decodes component
 * ids by hand. */
export function BomRevisionEvidence({
  before,
  after,
  names = {},
}: {
  /** The frozen pre-revision snapshot (`before_state`, with `lines`). */
  before: unknown;
  /** The frozen proposal (`payload`, with `components`). */
  after: unknown;
  names?: Record<string, string>;
}) {
  const t = useTranslations("accounting");
  const label = useFieldLabel();
  const beforeLines = asLines((before as RecipeLine | null)?.lines);
  const afterLines = asLines((after as RecipeLine | null)?.components);
  const beforeByKey = new Map(beforeLines.map((line) => [lineKey(line), line]));
  const seen = new Set<string>();
  // Proposed lines first (added / changed / unchanged), then the removed
  // lines they supersede — the whole recipe stays on one screen.
  const rows: { line: RecipeLine; disposition: "added" | "changed" | "unchanged" | "removed"; changes: string[] }[] =
    afterLines.map((line) => {
      const key = lineKey(line);
      seen.add(key);
      const old = beforeByKey.get(key);
      if (!old) return { line, disposition: "added" as const, changes: [] };
      const changes: string[] = [];
      for (const field of ["quantityPer", "quantityBasis", "formulaOutputQuantity", "scrapPct", "outputCostWeight", "effectiveFrom", "effectiveTo"] as const) {
        if (String(old[field] ?? "") !== String(line[field] ?? "")) {
          changes.push(`${label(field)}: ${lineText(old[field])} → ${lineText(line[field])}`);
        }
      }
      return { line, disposition: changes.length > 0 ? ("changed" as const) : ("unchanged" as const), changes };
    });
  for (const line of beforeLines) {
    if (!seen.has(lineKey(line))) rows.push({ line, disposition: "removed", changes: [] });
  }
  const componentName = (line: RecipeLine): string => {
    const id = String(line.componentItemId ?? "");
    return names[id] ?? (id ? id.slice(0, 8) : lineText(null));
  };
  const window = (line: RecipeLine): string =>
    `${lineText(line.effectiveFrom)} → ${lineText(line.effectiveTo)}`;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{label("componentItemId")}</TableHead>
          <TableHead>{label("quantityPer")}</TableHead>
          <TableHead>{label("quantityBasis")}</TableHead>
          <TableHead>{label("scrapPct")}</TableHead>
          <TableHead>{label("operationSeq")}</TableHead>
          <TableHead>{label("isByproduct")}</TableHead>
          <TableHead>{label("effectiveFrom")} → {label("effectiveTo")}</TableHead>
          <TableHead>{t("lifecycle.evidence.bom.disposition")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={i}>
            <TableCell className="break-words">{componentName(row.line)}</TableCell>
            <TableCell className="tabular-nums">{lineText(row.line.quantityPer)}</TableCell>
            <TableCell>{lineText(row.line.quantityBasis ?? "per_unit")}</TableCell>
            <TableCell className="tabular-nums">{lineText(row.line.scrapPct)}</TableCell>
            <TableCell className="tabular-nums">{row.line.operationSeq == null ? "…" : String(row.line.operationSeq)}</TableCell>
            <TableCell>{row.line.isByproduct === true ? t("lifecycle.evidence.yes") : t("lifecycle.evidence.no")}</TableCell>
            <TableCell className="whitespace-nowrap">{window(row.line)}</TableCell>
            <TableCell>
              <span className="flex flex-col gap-1">
                <Badge variant={row.disposition === "unchanged" ? "secondary" : row.disposition === "removed" ? "destructive" : "default"}>
                  {t(`lifecycle.evidence.bom.${row.disposition}` as never)}
                </Badge>
                {row.changes.map((change, j) => (
                  <span key={j} className="text-xs text-slate-500 dark:text-slate-400">{change}</span>
                ))}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type RoutingOperation = {
  sequence?: unknown;
  name?: unknown;
  workCenterId?: unknown;
  setupMinutes?: unknown;
  runMinutesPerUnit?: unknown;
  laborMinutesPerUnit?: unknown;
  qualityGate?: unknown;
  backflushAt?: unknown;
  laborTimeSource?: unknown;
};

/** A routing revision as its proposed operations: sequence, operation,
 * work center, and times — with the superseded revisions it replaces. */
export function RoutingRevisionEvidence({
  evidence,
  names = {},
}: {
  /** The frozen activation evidence (`before_state`: candidate/active/supersedes). */
  evidence: unknown;
  names?: Record<string, string>;
}) {
  const t = useTranslations("accounting");
  const label = useFieldLabel();
  const root = (evidence && typeof evidence === "object" ? evidence : {}) as Record<string, unknown>;
  const candidate = (root.candidate && typeof root.candidate === "object" ? root.candidate : {}) as Record<string, unknown>;
  const operations = Array.isArray(candidate.operations)
    ? (candidate.operations as RoutingOperation[])
    : [];
  const supersedes = Array.isArray(root.supersedes) ? (root.supersedes as Record<string, unknown>[]) : [];
  const workCenterName = (id: unknown): string => {
    const key = String(id ?? "");
    return (key && names[key]) || (key ? key.slice(0, 8) : "…");
  };
  const flags = (op: RoutingOperation): string[] => {
    const out: string[] = [];
    if (op.qualityGate != null && op.qualityGate !== false && op.qualityGate !== "none")
      out.push(`${label("qualityGate")}: ${lineText(op.qualityGate)}`);
    if (op.backflushAt != null) out.push(`${label("backflushAt")}: ${lineText(op.backflushAt)}`);
    if (op.laborTimeSource != null) out.push(`${label("laborTimeSource")}: ${lineText(op.laborTimeSource)}`);
    return out;
  };
  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{label("sequence")}</TableHead>
            <TableHead>{label("operationName")}</TableHead>
            <TableHead>{label("workCenter")}</TableHead>
            <TableHead>{label("setupMinutes")}</TableHead>
            <TableHead>{label("runMinutesPerUnit")}</TableHead>
            <TableHead>{label("laborMinutesPerUnit")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {operations.map((op, i) => (
            <TableRow key={i}>
              <TableCell className="tabular-nums">{lineText(op.sequence)}</TableCell>
              <TableCell>
                <span className="flex flex-col gap-1">
                  <span className="break-words">{lineText(op.name)}</span>
                  {flags(op).map((flag, j) => (
                    <span key={j} className="text-xs text-slate-500 dark:text-slate-400">{flag}</span>
                  ))}
                </span>
              </TableCell>
              <TableCell className="break-words">{workCenterName(op.workCenterId)}</TableCell>
              <TableCell className="tabular-nums">{lineText(op.setupMinutes)}</TableCell>
              <TableCell className="tabular-nums">{lineText(op.runMinutesPerUnit)}</TableCell>
              <TableCell className="tabular-nums">{lineText(op.laborMinutesPerUnit)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {supersedes.length > 0 ? (
        <div className="space-y-1">
          <h4 className="text-sm font-semibold">{label("supersedes")}</h4>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {supersedes.map((row, i) => (
              <li key={i}>
                {names[String(row.id ?? "")] ?? `${label("version")} ${lineText(row.version)}`} ·{" "}
                {lineText(row.effectiveFrom)} → {lineText(row.effectiveTo)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
