import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { createCabinetFile } from "../platform/file-ingestion.ts";
import { installEngineSeams } from "../composition/install.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import {
  applyHistoricalTranslationContribution,
  proposeHistoricalTranslationContribution,
} from "../journal/historical-translation-evidence.ts";
import { assertFixtureDatabase } from "./fixtures.ts";

export interface HistoricalContributionFixtureInput {
  orgId: string;
  actorId: string;
  sourceLineId: string;
  measurementCurrency: string;
  presentationCurrency: string;
  historicalDate: string;
  amount: string;
  rate: string;
}

/** Prepare a native assessment backed by an immutable Cabinet version. */
export async function proposeHistoricalContributionFixture(
  input: HistoricalContributionFixtureInput,
): Promise<string> {
  await assertFixtureDatabase();
  installEngineSeams();
  return withOrgTransaction(input.orgId, async () => {
    const folderId = randomUUID();
    await db.execute(sql`insert into folders(id,org_id,name,is_private,owner_id)
      values(${folderId},${input.orgId},'Contribution evidence',true,${input.actorId})`);
    const bytes = Buffer.from(JSON.stringify(input));
    const file = await createCabinetFile({
      orgId: input.orgId,
      folderId,
      filename: "contribution.json",
      contentType: "application/json",
      bytes,
      createdBy: input.actorId,
      auditActorId: input.actorId,
      executor: db,
    });
    if (!file.currentVersionId)
      throw new Error("Contribution evidence requires a retained file version.");
    const proposed = await proposeHistoricalTranslationContribution({
      ...input,
      reason: "Retain the original contribution schedule for financial reporting",
      idempotencyKey: randomUUID(),
      instruction: {
        sourceLineId: input.sourceLineId,
        measurementCurrency: input.measurementCurrency,
        presentationCurrency: input.presentationCurrency,
        kind: "contribution",
        layers: [
          {
            amount: input.amount,
            rate: input.rate,
            historicalDate: input.historicalDate,
            provenance: "Original contribution schedule",
            originalLayerId: null,
            source: {
              fileId: file.id,
              versionId: file.currentVersionId,
              contentHash: createHash("sha256").update(bytes).digest("hex"),
            },
          },
        ],
      },
    });
    return proposed.changeId;
  });
}

/** Reporting fixtures retain documentary basis through the native tenant Flow. */
export async function recordHistoricalContributionFixture(
  input: HistoricalContributionFixtureInput,
): Promise<void> {
  await withOrgTransaction(input.orgId, async () => {
    const changeId = await proposeHistoricalContributionFixture(input);
    await submitFinancialChange(input.orgId, changeId, input.actorId);
    await applyHistoricalTranslationContribution({ ...input, changeId });
  });
}
