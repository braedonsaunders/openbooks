import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { FinancialProfile } from "@openbooks/schema";
import { db } from "../db.ts";
import { fromUnits, roundDiv, toUnits } from "../money.ts";
import { netsuiteRestlet, type NetSuiteCreds } from "../netsuite.ts";
import { unsealJson } from "../secrets.ts";
import { buildSource, getConnection } from "./connection.ts";
import { loadProjectType } from "../../../web/lib/project-type.ts";
import { resolveProjectFinancials } from "../../../web/lib/project-financials.ts";

interface OracleMapping {
  collectionPath: string;
  projectRefField: string;
  measures: Record<string, string>;
}

interface Difference {
  sourceRef: string;
  projectId: string | null;
  measure: string;
  source: string | null;
  target: string | null;
  difference: string | null;
}

interface ProjectComparison {
  sourceRef: string;
  projectId: string | null;
  projectType: string | null;
  financialProfileEffectiveFrom: string | null;
  exact: boolean;
  sourceMeasures: Record<string, string>;
  targetMeasures: Record<string, string>;
  differences: Record<string, string>;
  targetEvidence: Record<string, string>;
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function nested(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function money(value: unknown): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !String(value).trim()
  ) {
    throw new Error(`oracle returned invalid money value ${String(value)}`);
  }
  return fromUnits(toUnits(String(value)));
}

function cents(value: unknown): bigint {
  const units = toUnits(money(value));
  const negative = units < 0n;
  const rounded = roundDiv(negative ? -units : units, 100n);
  return negative ? -rounded : rounded;
}

function parseMapping(path: string): OracleMapping {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<OracleMapping>;
  if (
    typeof parsed.collectionPath !== "string" ||
    typeof parsed.projectRefField !== "string" ||
    !parsed.measures ||
    typeof parsed.measures !== "object" ||
    !Object.keys(parsed.measures).length
  ) {
    throw new Error(
      "oracle mapping requires collectionPath, projectRefField, and measures",
    );
  }
  for (const [sourceField, targetMeasure] of Object.entries(parsed.measures)) {
    if (!sourceField || typeof targetMeasure !== "string" || !targetMeasure) {
      throw new Error("oracle measure mappings must be non-empty strings");
    }
  }
  return parsed as OracleMapping;
}

async function resolveWithRetry(
  orgId: string,
  projectId: string,
  profile: FinancialProfile,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await resolveProjectFinancials(orgId, projectId, profile);
    } catch (error) {
      lastError = error;
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      if (!["40P01", "40001"].includes(code ?? "") || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const orgId = arg("--org");
  const connectionId = arg("--connection");
  const scriptId = arg("--script");
  const deploymentId = arg("--deploy");
  const mappingPath = arg("--mapping");
  const outputPath = arg("--output");
  const expectedSourceCount = arg("--expected-source-count");
  const asOf = arg("--as-of");
  if (
    !orgId ||
    !connectionId ||
    !scriptId ||
    !deploymentId ||
    !mappingPath
  ) {
    throw new Error(
      "--org, --connection, --script, --deploy, and --mapping are required",
    );
  }
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error("--as-of must be YYYY-MM-DD");
  }
  const mapping = parseMapping(mappingPath);
  const connection = await getConnection(orgId, connectionId);
  if (!connection || connection.source !== "netsuite") {
    throw new Error("the selected tenant connection is not NetSuite");
  }
  const secret = unsealJson<Partial<NetSuiteCreds>>(connection.secrets);
  const account = String(connection.config.account ?? "");
  const host = String(connection.config.host ?? "");
  if (
    !account ||
    !host ||
    !secret?.consumerKey ||
    !secret.consumerSecret ||
    !secret.tokenKey ||
    !secret.tokenSecret
  ) {
    throw new Error("the selected NetSuite connection is missing credentials");
  }
  const credentials: NetSuiteCreds = {
    account,
    host,
    consumerKey: secret.consumerKey,
    consumerSecret: secret.consumerSecret,
    tokenKey: secret.tokenKey,
    tokenSecret: secret.tokenSecret,
  };
  const source = buildSource(connection);
  const oracle = await netsuiteRestlet<unknown>(
    scriptId,
    deploymentId,
    {},
    credentials,
  );
  const rawRows = nested(oracle, mapping.collectionPath);
  if (!Array.isArray(rawRows)) {
    throw new Error(
      `oracle collection ${mapping.collectionPath} is not an array`,
    );
  }
  if (
    expectedSourceCount !== null &&
    rawRows.length !== Number(expectedSourceCount)
  ) {
    throw new Error(
      `oracle returned ${rawRows.length} rows; expected ${expectedSourceCount}`,
    );
  }

  const sourceRefs = rawRows.map((row, index) => {
    const value = nested(row, mapping.projectRefField);
    if (
      (typeof value !== "string" && typeof value !== "number") ||
      !String(value).trim()
    ) {
      throw new Error(`oracle row ${index} has no project identity`);
    }
    return String(value);
  });
  const duplicateRefs = sourceRefs.filter(
    (ref, index) => sourceRefs.indexOf(ref) !== index,
  );
  if (duplicateRefs.length) {
    throw new Error(
      `oracle returned duplicate project identities: ${[
        ...new Set(duplicateRefs),
      ]
        .slice(0, 20)
        .join(", ")}`,
    );
  }
  const target = (await db.execute<{ id: string; source_ref: string }>(sql`
    select id, custom ->> ${source.refKey} as source_ref
      from projects
     where org_id = ${orgId}
       and custom ->> ${source.refKey} is not null
  `));
  const targetByRef = new Map(
    target.rows.map((project) => [project.source_ref, project.id]),
  );
  const differences: Difference[] = [];
  const comparisons: ProjectComparison[] = [];
  let exactProjects = 0;
  const measureDifferences: Record<string, number> = {};
  for (const [index, row] of rawRows.entries()) {
    const sourceRef = sourceRefs[index]!;
    const projectId = targetByRef.get(sourceRef) ?? null;
    if (!projectId) {
      differences.push({
        sourceRef,
        projectId: null,
        measure: "project_presence",
        source: "present",
        target: null,
        difference: null,
      });
      measureDifferences.project_presence =
        (measureDifferences.project_presence ?? 0) + 1;
      comparisons.push({
        sourceRef,
        projectId: null,
        projectType: null,
        financialProfileEffectiveFrom: null,
        exact: false,
        sourceMeasures: {},
        targetMeasures: {},
        differences: { project_presence: "missing" },
        targetEvidence: {},
      });
      continue;
    }
    const projectType = await loadProjectType(
      orgId,
      projectId,
      asOf ?? undefined,
    );
    const financials = await resolveWithRetry(
      orgId,
      projectId,
      projectType.financialProfile as FinancialProfile,
    );
    let exact = true;
    const sourceMeasures: Record<string, string> = {};
    const targetMeasures: Record<string, string> = {};
    const projectDifferences: Record<string, string> = {};
    for (const [sourceField, targetMeasure] of Object.entries(
      mapping.measures,
    )) {
      const sourceValue = money(nested(row, sourceField));
      const targetValue = money(financials.measures[targetMeasure]);
      sourceMeasures[targetMeasure] = sourceValue;
      targetMeasures[targetMeasure] = targetValue;
      const deltaCents = cents(targetValue) - cents(sourceValue);
      if (deltaCents === 0n) continue;
      exact = false;
      projectDifferences[targetMeasure] = fromUnits(deltaCents * 100n);
      measureDifferences[targetMeasure] =
        (measureDifferences[targetMeasure] ?? 0) + 1;
      differences.push({
        sourceRef,
        projectId,
        measure: targetMeasure,
        source: sourceValue,
        target: targetValue,
        difference: fromUnits(deltaCents * 100n),
      });
    }
    comparisons.push({
      sourceRef,
      projectId,
      projectType: projectType.key,
      financialProfileEffectiveFrom:
        projectType.financialProfileEffectiveFrom,
      exact,
      sourceMeasures,
      targetMeasures,
      differences: projectDifferences,
      targetEvidence: Object.fromEntries(
        [
          "actual_cost",
          "labor_cost",
          "calculated_overhead",
          "overhead_adjustment",
          "overhead",
          "committed_cost",
          "billable_value",
          "billable_time_value",
          "billable_cost_value",
          "unbilled_billable",
        ].map((measure) => [measure, money(financials.measures[measure])]),
      ),
    });
    if (exact) exactProjects++;
  }

  const report = {
    status: differences.length ? "different" : "exact",
    sourceProjects: rawRows.length,
    targetSourceBackedProjects: target.rows.length,
    exactProjects,
    projectsWithDifferences: new Set(
      differences.map((difference) => difference.sourceRef),
    ).size,
    fieldDifferences: differences.length,
    measureDifferences,
    differences,
    comparisons,
  };
  if (outputPath) {
    writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(
    JSON.stringify(
      {
        ...report,
        differences: differences.slice(0, 30),
        comparisons: undefined,
        outputPath: outputPath ?? null,
      },
      null,
      2,
    ),
  );
  await source.dispose?.();
  process.exitCode = differences.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
