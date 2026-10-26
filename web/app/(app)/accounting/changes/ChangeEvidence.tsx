import { useTranslations } from "next-intl";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@openbooks/ui";
import {
  effectiveRequirementPerUnit,
  pairBomRevisionLines,
  type BomRevisionField,
  type BomRevisionPair,
} from "@/lib/bom-lines";
import { BomRevisionDiffTable, type BomRevisionDiffRow } from "./BomRevisionDiffTable";
const fieldKeys = new Set([
  "identity",
  "name",
  "id",
  "subsidiaryId",
  "currency",
  "expenseAccountId",
  "liabilityAccountId",
  "presentObligation",
  "outflow",
  "reliablyEstimable",
  "evidence",
  "discounting",
  "discountEvidence",
  "estimate",
  "method",
  "amount",
  "outcomes",
  "probability",
  "minimum",
  "maximum",
  "reportingFramework",
  "periodId",
  "balance",
  "events",
  "recognized",
  "liability",
  "estimatedSettlement",
  "disclosureRequired",
  "priorLiability",
  "currentPeriodCharge",
  "entryId",
  "requiredSubsidiaryIds",
  "existingId",
  "existingObligationIds",
  "ssp",
  "standaloneSellingPrice",
  "recognitionRuleId",
  "deferredAccountId",
  "recognizedAccountId",
  "totalAmount",
  "catchUp",
  "priorRecognized",
  "targetRecognized",
  "remaining",
  "netCredits",
  "newTotal",
  "pool",
  "remainingDistinct",
  "additionsAtStandalonePrice",
  "enforceableRightsEvidence",
  "fxRate",
  "bookId",
  "effectiveOn",
  "scopeReductionPercent",
  "commensurateStandalonePrice",
  "additionalRightOfUse",
  "transfersOwnership",
  "purchaseOptionReasonablyCertain",
  "pvOfPayments",
  "newRou",
  "rouDelta",
  "groupCarryingBefore",
  "groupCarryingAfter",
  "groupValuationDelta",
  "netAssets",
  "nci",
  "parentGain",
  "groupGain",
  "recycledOci",
  "transferredOci",
  "totalGroupGain",
  "retainedFairValue",
  "carryingLiability",
  "carryingRou",
  "stubInterest",
  "stubRou",
  "prepaidCarrying",
  "newLiability",
  "liabilityDelta",
  "removedLiability",
  "removedRou",
  "gain",
  "settlement",
  "settlementPayment",
  "payment",
  "periods",
  "annualRatePercent",
  "paymentTiming",
  "paymentFrequency",
  "assessment",
  "dayCountPolicy",
  "specializedAsset",
  "economicLifeMonths",
  "leaseTermMonths",
  "termThresholdPercent",
  "fairValue",
  "pvThresholdPercent",
  "assemblyItemId",
  "expectedVersion",
  "components",
  "componentItemId",
  "quantityPer",
  "sortOrder",
  "effectiveFrom",
  "effectiveTo",
  "operationSeq",
  "scrapPct",
  "isByproduct",
  "quantityBasis",
  "formulaOutputQuantity",
  "outputCostWeight",
  "routingId",
  "supersedes",
  "candidate",
  "operations",
  "operationName",
  "workCenterId",
  "workCenter",
  "setupMinutes",
  "runMinutesPerUnit",
  "laborMinutesPerUnit",
  "laborTimeSource",
  "backflushAt",
  "qualityGate",
  "sequence",
  "code",
  "version",
  "producedItemId",
  "status",
  "kind",
  "workOrderId",
  "operationId",
  "reasonId",
  "quantity",
  "times",
  "attemptedQty",
  "actualSetupMinutes",
  "actualRunMinutes",
  "actualLaborMinutes",
  "itemId",
  "onDate",
  "batchQuantity",
  "standardCost",
  "baseUnit",
  "controlsBeforeTransfer",
  "passThroughAccountId",
  "controlEvidence",
  "employmentId",
  "grantId",
  "pairId",
  "bookId",
  "eliminationSubsidiaryId",
  "ociAccountId",
  "profitLossAccountId",
  "sourceLineIds",
  "notPlannedOrLikely",
  "nonTrade",
  "qualificationEvidence",
  "sourceChangeId",
  "portion",
  "percent",
  "books",
  "cost",
  "accumulated",
  "salvage",
  "remainingProductionUnits",
  "proceeds",
  "proceedsAccountId",
  "transfer",
  "categoryId",
  "assetNumber",
  "buyerAmount",
  "construction",
  "gainLossAccountId",
  "remainingTerms",
  "separateLease",
  "agreement",
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
  if (typeof value === "boolean")
    return <span>{value ? t("lifecycle.evidence.yes") : t("lifecycle.evidence.no")}</span>;
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
        .filter(
          ([key, v]) =>
            fieldKeys.has(key) &&
            (typeof v === "string" || typeof v === "number" || typeof v === "boolean"),
        )
        .map(([key, v]) => (
          <div key={key}>
            <dt className="text-sm text-slate-500">{label(key)}</dt>
            <dd>
              {typeof v === "boolean"
                ? v
                  ? t("lifecycle.evidence.yes")
                  : t("lifecycle.evidence.no")
                : String(v).replaceAll("_", " ")}
            </dd>
          </div>
        ))}
    </dl>
  );
}

type RecipeLine = Record<string, unknown>;

function asLines(value: unknown): RecipeLine[] {
  return Array.isArray(value)
    ? value.filter(
        (line): line is RecipeLine => !!line && typeof line === "object" && !Array.isArray(line),
      )
    : [];
}

function lineText(value: unknown): string {
  if (value === null || value === undefined) return "…";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value).replaceAll("_", " ");
}

/** Diff cells show an em dash for an absent value. */
function valueText(value: unknown): string {
  return value === null || value === undefined || value === "" ? "—" : lineText(value);
}

/** A manufacturing recipe revision as an old-vs-new diff. Components pair by
 * item (a repeated item pairs by position), so each component appears once with
 * its old and new quantity, unit, scrap, effective requirement and window, and
 * its change kind. Unchanged components stay hidden until the reader shows
 * them. This is presentation: the frozen snapshots are read, never rewritten. */
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
  const pairs = pairBomRevisionLines(
    asLines((before as RecipeLine | null)?.lines),
    asLines((after as RecipeLine | null)?.components),
  );
  const yesNo = (value: unknown) =>
    value === true
      ? t("lifecycle.evidence.yes")
      : value === false
        ? t("lifecycle.evidence.no")
        : valueText(value);
  const readers = {
    quantityPer: (line: RecipeLine) => valueText(line.quantityPer),
    quantityBasis: (line: RecipeLine) => {
      const basis = valueText(line.quantityBasis ?? "per_unit");
      return line.quantityBasis === "per_formula"
        ? `${basis} (${valueText(line.formulaOutputQuantity)})`
        : basis;
    },
    scrapPct: (line: RecipeLine) => valueText(line.scrapPct),
    effective: (line: RecipeLine) => effectiveRequirementPerUnit(line) ?? "—",
    operationSeq: (line: RecipeLine) => valueText(line.operationSeq),
    isByproduct: (line: RecipeLine) => yesNo(line.isByproduct ?? false),
    window: (line: RecipeLine) =>
      `${valueText(line.effectiveFrom)} – ${valueText(line.effectiveTo)}`,
  };
  // The new value, or "old → new" when the field changed; removed and added lines show their one side.
  const cell = (
    pair: BomRevisionPair,
    changed: boolean,
    read: (line: RecipeLine) => string,
  ): string => {
    const next = pair.after ? read(pair.after) : null;
    const prior = pair.before ? read(pair.before) : null;
    if (next === null) return prior ?? "—";
    if (prior === null || !changed) return next;
    return `${prior} → ${next}`;
  };
  const changedField = (pair: BomRevisionPair, ...fields: BomRevisionField[]) =>
    fields.some((field) => pair.changedFields.includes(field));
  const rows: BomRevisionDiffRow[] = pairs.map((pair, index) => {
    const effectiveChanged =
      pair.before !== null &&
      pair.after !== null &&
      readers.effective(pair.before) !== readers.effective(pair.after);
    return {
      key: `${index}:${pair.componentItemId}`,
      kind: pair.kind,
      kindLabel: t(`lifecycle.evidence.bom.${pair.kind}` as never),
      cells: [
        names[pair.componentItemId] ??
          (pair.componentItemId ? pair.componentItemId.slice(0, 8) : "—"),
        cell(pair, changedField(pair, "quantityPer"), readers.quantityPer),
        cell(
          pair,
          changedField(pair, "quantityBasis", "formulaOutputQuantity"),
          readers.quantityBasis,
        ),
        cell(pair, changedField(pair, "scrapPct"), readers.scrapPct),
        cell(pair, effectiveChanged, readers.effective),
        cell(pair, changedField(pair, "operationSeq"), readers.operationSeq),
        cell(pair, changedField(pair, "isByproduct"), readers.isByproduct),
        cell(pair, changedField(pair, "effectiveFrom", "effectiveTo"), readers.window),
      ],
    };
  });
  const headers = [
    label("componentItemId"),
    label("quantityPer"),
    label("quantityBasis"),
    label("scrapPct"),
    t("lifecycle.evidence.bom.effectivePerUnit"),
    label("operationSeq"),
    label("isByproduct"),
    `${label("effectiveFrom")} – ${label("effectiveTo")}`,
    t("lifecycle.evidence.bom.disposition"),
  ];
  const unchangedCount = pairs.filter((pair) => pair.kind === "unchanged").length;
  return (
    <BomRevisionDiffTable
      headers={headers}
      rows={rows}
      unchangedCount={unchangedCount}
      showUnchangedLabel={t("lifecycle.evidence.bom.showUnchanged", { count: unchangedCount })}
      hideUnchangedLabel={t("lifecycle.evidence.bom.hideUnchanged")}
      emptyLabel={t("lifecycle.evidence.bom.noChanges")}
    />
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
  useTranslations("accounting");
  const label = useFieldLabel();
  const root = (evidence && typeof evidence === "object" ? evidence : {}) as Record<
    string,
    unknown
  >;
  const candidate = (
    root.candidate && typeof root.candidate === "object" ? root.candidate : {}
  ) as Record<string, unknown>;
  const operations = Array.isArray(candidate.operations)
    ? (candidate.operations as RoutingOperation[])
    : [];
  const supersedes = Array.isArray(root.supersedes)
    ? (root.supersedes as Record<string, unknown>[])
    : [];
  const workCenterName = (id: unknown): string => {
    const key = String(id ?? "");
    return (key && names[key]) || (key ? key.slice(0, 8) : "…");
  };
  const flags = (op: RoutingOperation): string[] => {
    const out: string[] = [];
    if (op.qualityGate != null && op.qualityGate !== false && op.qualityGate !== "none")
      out.push(`${label("qualityGate")}: ${lineText(op.qualityGate)}`);
    if (op.backflushAt != null) out.push(`${label("backflushAt")}: ${lineText(op.backflushAt)}`);
    if (op.laborTimeSource != null)
      out.push(`${label("laborTimeSource")}: ${lineText(op.laborTimeSource)}`);
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
                    <span key={j} className="text-xs text-slate-500 dark:text-slate-400">
                      {flag}
                    </span>
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
