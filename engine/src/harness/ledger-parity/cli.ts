import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import {
  disposeAsset,
  remeasureAsset,
  reverseAssetLifecycleEvent,
} from "../../asset-lifecycle.ts";
import { db, pool, schema } from "../../db.ts";
import { createDocumentCorrectionDraft } from "../../document-correction.ts";
import { requestDocumentVoid } from "../../document-void.ts";
import { buildSchedule, runDepreciation } from "../../depreciation.ts";
import { runRevaluation } from "../../fx-revaluation.ts";
import { submitAndReleaseIfUngated } from "../../flows/submit.ts";
import {
  adjustInventory,
  buildAssembly,
  getOnHand,
  issueInventory,
  postLandedCostVoucher,
  receiveInventory,
  reverseAssemblyBuild,
  reverseInventoryMovement,
  reverseLandedCostVoucher,
  transferInventory,
} from "../../inventory.ts";
import { fromUnits, toUnits } from "../../money.ts";
import {
  createPaymentDocument,
  postPaymentWithApplications,
  reversePaymentForReturn,
  sameCurrencyAllocation,
  updateDraftPayment,
} from "../../payments.ts";
import { postDocument } from "../../posting.ts";
import {
  runAutoElimination,
  runOwnershipConsolidation,
} from "../../consolidation.ts";
import {
  postProjectGlEntry,
  postProjectLaborCost,
  reverseProjectGlEntry,
  reverseProjectLaborCost,
} from "../../project-recognition.ts";
import {
  applyOverheadForTime,
  reverseOverheadForTime,
} from "../../overhead-apply.ts";
import {
  cancelRevenueRecognitionForInvoice,
  runRevenueRecognition,
} from "../../revenue-recognition.ts";
import {
  computeProvisionRun,
  getProvisionRun,
  postProvisionRun,
} from "../../income-tax-provision.ts";
import {
  mirrorSourceDeletion,
} from "../../sync/source-deletions.ts";
import { trueUpResidualGl } from "../../sync/trueup.ts";
import type { MigrationSource } from "../../sync/source.ts";
import {
  computeImportedLineTaxEvidence,
  loadTaxComponentConfig,
  persistLineTaxComponents,
} from "../../tax-persist.ts";
import { type TaxCalculationType, type TaxComponentConfig } from "../../tax.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../../test-fixtures.ts";
import { canonicalizeLines, compareSnapshots } from "./canonical-ledger.ts";
import { ErpNextParityClient } from "./erpnext-client.ts";
import { GL_COVERAGE_MATRIX } from "./matrix.ts";
import { GL_OPERATION_REGISTRY } from "./operations.ts";
import type {
  CanonicalGlLine,
  CanonicalGlSnapshot,
  ErpNextConfig,
  ParityManifest,
} from "./types.ts";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const runtimeDir = join(repoRoot, ".local", "erpnext-parity");
const manifestPath = join(runtimeDir, "manifest.json");
const evidenceDir = join(runtimeDir, "evidence");
const localEnvPath = join(repoRoot, ".env.erpnext");

function loadKeyValues(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

function erpConfig(): ErpNextConfig {
  const file = loadKeyValues(localEnvPath);
  const value = (key: string, fallback?: string): string => {
    const found = process.env[key] ?? file[key] ?? fallback;
    if (!found)
      throw new Error(
        `${key} is required in the environment or ${localEnvPath}`,
      );
    return found;
  };
  return {
    url: value("ERPNEXT_URL", "http://localhost:8080"),
    apiKey: value("ERPNEXT_API_KEY"),
    apiSecret: value("ERPNEXT_API_SECRET"),
    company: value("ERPNEXT_COMPANY", "OpenBooks ERPNext Parity"),
  };
}

function readManifest(): ParityManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `parity tenant is not provisioned; run "npm -w engine run harness:ledger-parity -- provision"`,
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as ParityManifest;
}

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function ensureOpenBooksTaxCode(
  manifest: ParityManifest,
  input: {
    code: string;
    name: string;
    priceIncludesTax?: boolean;
    rate: string;
    calculationType?: TaxCalculationType;
    compoundOnPrevious?: boolean;
    recoverablePercent?: string;
    collectedAccountId?: string | null;
    paidAccountId?: string | null;
    withholdingAccountId?: string | null;
  },
): Promise<string> {
  const existing = (await db.execute<{ id: string }>(sql`
    select id
      from tax_codes
     where org_id = ${manifest.openbooks.orgId}
       and code = ${input.code}
     order by created_at
     limit 1
  `));
  let taxCodeId = existing.rows[0]?.id;
  if (!taxCodeId) {
    taxCodeId = randomUUID();
    await db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, country, region, applies_to,
         collected_account_id, paid_account_id, calculation_type,
         price_includes_tax, compound_on_previous, rounding_scale,
         recoverable_percent, is_active, created_by, updated_by)
      values
        (${taxCodeId}, ${manifest.openbooks.orgId}, ${input.code},
         ${input.name}, 'CA', 'ON', 'both',
         ${input.collectedAccountId ?? manifest.openbooks.accounts.taxOutput},
         ${input.paidAccountId ?? manifest.openbooks.accounts.taxInput},
         ${input.calculationType ?? "standard"},
         ${input.priceIncludesTax ?? false},
         ${input.compoundOnPrevious ?? false}, 2,
         ${input.recoverablePercent ?? "100"}, true,
         ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
    `);
  } else {
    // The parity tenant is disposable test data. Keep its named fixtures
    // authoritative so reruns cannot silently inherit stale calculation
    // behavior from an interrupted earlier harness version.
    await db.execute(sql`
      update tax_codes
         set name = ${input.name},
             calculation_type = ${input.calculationType ?? "standard"},
             price_includes_tax = ${input.priceIncludesTax ?? false},
             compound_on_previous = ${input.compoundOnPrevious ?? false},
             recoverable_percent = ${input.recoverablePercent ?? "100"},
             collected_account_id = ${input.collectedAccountId ?? manifest.openbooks.accounts.taxOutput},
             paid_account_id = ${input.paidAccountId ?? manifest.openbooks.accounts.taxInput},
             withholding_account_id = ${input.withholdingAccountId ?? null},
             updated_by = ${manifest.openbooks.actorId},
             updated_at = now()
       where id = ${taxCodeId} and org_id = ${manifest.openbooks.orgId}
    `);
  }
  const rates = (await db.execute<{ id: string }>(sql`
    select id
      from tax_rates
     where org_id = ${manifest.openbooks.orgId}
       and tax_code_id = ${taxCodeId}
       and effective_from = '2026-01-01'
     limit 1
  `));
  if (!rates.rows[0]) {
    await db.execute(sql`
      insert into tax_rates
        (org_id, tax_code_id, rate_percent, effective_from, created_by, updated_by)
      values
        (${manifest.openbooks.orgId}, ${taxCodeId}, ${input.rate}, '2026-01-01',
         ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
    `);
  }
  return taxCodeId;
}

async function ensureErpTaxAccount(
  client: ErpNextParityClient,
  manifest: ParityManifest,
  key: string,
  accountName: string,
  parentAccount: string,
): Promise<string> {
  const saved = manifest.erpnext.accounts[key];
  if (saved) {
    const existing = await client.list<{ name: string }>(
      "Account",
      ["name"],
      [["name", "=", saved]],
      "name asc",
      1,
    );
    if (existing[0]) return existing[0].name;
  }
  const fullName = `${accountName} - ${manifest.erpnext.abbreviation}`;
  const account = await ensureErpMaster<{ name: string }>(
    client,
    "Account",
    fullName,
    {
      account_name: accountName,
      company: manifest.erpnext.company,
      parent_account: parentAccount,
      account_type: "Tax",
      root_type: "Liability",
      report_type: "Balance Sheet",
      account_currency: "CAD",
      is_group: 0,
    },
  );
  manifest.erpnext.accounts[key] = account.name;
  return account.name;
}

async function ensureTaxParityConfig(
  client: ErpNextParityClient,
  manifest: ParityManifest,
): Promise<{
  taxCodeId: string;
  inclusiveTaxCodeId: string;
  compoundTaxGroupId: string;
  compoundConfigs: TaxComponentConfig[];
  withholdingTaxCodeId: string;
  reverseChargeTaxCodeId: string;
  erpTaxInputAccount: string;
  erpTaxInputCompoundAccount: string;
  erpTaxOutputAccount: string;
  erpTaxOutputCompoundAccount: string;
  erpWithholdingAccount: string;
}> {
  let erpTaxAccount = manifest.erpnext.accounts.tax;
  if (!erpTaxAccount) {
    const taxAccounts = await client.list<{ name: string }>(
      "Account",
      ["name"],
      [
        ["company", "=", manifest.erpnext.company],
        ["is_group", "=", 0],
        ["account_type", "=", "Tax"],
      ],
      "name asc",
      20,
    );
    if (!taxAccounts[0]) throw new Error("ERPNext has no leaf Tax account");
    erpTaxAccount = taxAccounts[0].name;
    manifest.erpnext.accounts.tax = erpTaxAccount;
  }

  const erpTaxBase = await client.get<{
    parent_account: string;
  }>("Account", erpTaxAccount);
  if (!erpTaxBase.parent_account) {
    throw new Error("ERPNext tax account has no parent account");
  }
  const erpTaxInputAccount = await ensureErpTaxAccount(
    client,
    manifest,
    "taxInput",
    "Parity Tax Input",
    erpTaxBase.parent_account,
  );
  const erpTaxOutputAccount = await ensureErpTaxAccount(
    client,
    manifest,
    "taxOutput",
    "Parity Tax Output",
    erpTaxBase.parent_account,
  );
  const erpTaxInputCompoundAccount = await ensureErpTaxAccount(
    client,
    manifest,
    "taxInputCompound",
    "Parity Compound Tax Input",
    erpTaxBase.parent_account,
  );
  const erpTaxOutputCompoundAccount = await ensureErpTaxAccount(
    client,
    manifest,
    "taxOutputCompound",
    "Parity Compound Tax Output",
    erpTaxBase.parent_account,
  );
  const erpWithholdingAccount = await ensureErpTaxAccount(
    client,
    manifest,
    "withholding",
    "Parity Tax Withholding",
    erpTaxBase.parent_account,
  );

  manifest.accountMap.openbooks[manifest.openbooks.accounts.taxInput!] =
    "TAX_INPUT";
  manifest.accountMap.openbooks[manifest.openbooks.accounts.taxOutput!] =
    "TAX_OUTPUT";
  manifest.accountMap.openbooks[manifest.openbooks.accounts.withholding!] =
    "WITHHOLDING";
  manifest.accountMap.erpnext[erpTaxInputAccount] = "TAX_INPUT";
  manifest.accountMap.erpnext[erpTaxInputCompoundAccount] = "TAX_INPUT";
  manifest.accountMap.erpnext[erpTaxOutputAccount] = "TAX_OUTPUT";
  manifest.accountMap.erpnext[erpTaxOutputCompoundAccount] = "TAX_OUTPUT";
  manifest.accountMap.erpnext[erpWithholdingAccount] = "WITHHOLDING";
  if (!manifest.erpnext.accounts.roundOff) {
    const roundOffAccounts = await client.list<{ name: string }>(
      "Account",
      ["name"],
      [
        ["company", "=", manifest.erpnext.company],
        ["is_group", "=", 0],
        ["account_number", "=", "5212"],
      ],
      "name asc",
      1,
    );
    if (roundOffAccounts[0])
      manifest.erpnext.accounts.roundOff = roundOffAccounts[0].name;
  }
  if (manifest.erpnext.accounts.roundOff) {
    manifest.accountMap.erpnext[manifest.erpnext.accounts.roundOff] =
      "ROUNDING";
  }
  saveJson(manifestPath, manifest);

  const taxCodeId = await ensureOpenBooksTaxCode(manifest, {
    code: "PARITY-HST-13",
    name: "Parity Ontario HST 13%",
    priceIncludesTax: false,
    rate: "13",
  });
  const inclusiveTaxCodeId = await ensureOpenBooksTaxCode(manifest, {
    code: "PARITY-HST-13-INCLUSIVE",
    name: "Parity Ontario HST 13% Inclusive",
    priceIncludesTax: true,
    rate: "13",
  });
  const compoundFirstCodeId = await ensureOpenBooksTaxCode(manifest, {
    code: "PARITY-COMPOUND-BASE-5",
    name: "Parity compound base tax 5%",
    rate: "5",
  });
  const compoundSecondCodeId = await ensureOpenBooksTaxCode(manifest, {
    code: "PARITY-COMPOUND-SECOND-9.5",
    name: "Parity compound second tax 9.5%",
    rate: "9.5",
    compoundOnPrevious: true,
  });
  const groupRows = (await db.execute<{ id: string }>(sql`
    select id from tax_groups
     where org_id = ${manifest.openbooks.orgId} and code = 'PARITY-COMPOUND'
     limit 1
  `));
  const compoundTaxGroupId = groupRows.rows[0]?.id ?? randomUUID();
  await db.execute(sql`
    insert into tax_groups (id, org_id, code, name, price_includes_tax, is_active)
    values (${compoundTaxGroupId}, ${manifest.openbooks.orgId}, 'PARITY-COMPOUND',
            'Parity compound tax', false, true)
    on conflict (id) do update
      set name = excluded.name, price_includes_tax = false, is_active = true
  `);
  await db.execute(sql`
    delete from tax_group_members where tax_group_id = ${compoundTaxGroupId}
  `);
  await db.execute(sql`
    insert into tax_group_members (tax_group_id, tax_code_id, sequence)
    values (${compoundTaxGroupId}, ${compoundFirstCodeId}, 1),
           (${compoundTaxGroupId}, ${compoundSecondCodeId}, 2)
  `);
  const firstConfig = await loadTaxComponentConfig(
    manifest.openbooks.orgId,
    compoundFirstCodeId,
    "2026-07-15",
  );
  const secondConfig = await loadTaxComponentConfig(
    manifest.openbooks.orgId,
    compoundSecondCodeId,
    "2026-07-15",
  );
  if (!firstConfig[0] || !secondConfig[0]) {
    throw new Error("OpenBooks compound tax configuration is incomplete");
  }
  const compoundConfigs = [
    { ...firstConfig[0], sequence: 1 },
    { ...secondConfig[0], sequence: 2 },
  ];
  const withholdingTaxCodeId = await ensureOpenBooksTaxCode(manifest, {
    code: "PARITY-WITHHOLDING-10",
    name: "Parity withholding tax 10%",
    rate: "10",
    calculationType: "withholding",
    collectedAccountId: null,
    paidAccountId: null,
    withholdingAccountId: manifest.openbooks.accounts.withholding,
  });
  const reverseChargeTaxCodeId = await ensureOpenBooksTaxCode(manifest, {
    code: "PARITY-REVERSE-CHARGE-13",
    name: "Parity reverse charge tax 13%",
    rate: "13",
    calculationType: "reverse_charge",
  });
  saveJson(manifestPath, manifest);
  return {
    taxCodeId,
    inclusiveTaxCodeId,
    compoundTaxGroupId,
    compoundConfigs,
    withholdingTaxCodeId,
    reverseChargeTaxCodeId,
    erpTaxInputAccount,
    erpTaxInputCompoundAccount,
    erpTaxOutputAccount,
    erpTaxOutputCompoundAccount,
    erpWithholdingAccount,
  };
}

async function ensureOpenBooksEmployeeAndCard(
  manifest: ParityManifest,
): Promise<{ employeeId: string; paymentCardId: string }> {
  let employeeId = manifest.openbooks.employeeId;
  if (!employeeId) {
    const existing = (await db.execute<{ id: string }>(sql`
      select p.id
        from parties p
        join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
       where p.org_id = ${manifest.openbooks.orgId}
         and p.display_name = 'Parity Employee'
       limit 1
    `));
    employeeId = existing.rows[0]?.id;
    if (!employeeId) {
      employeeId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into parties
            (id, org_id, kind, display_name, subsidiary_id, is_active, created_by, updated_by)
          values
            (${employeeId}, ${manifest.openbooks.orgId}, 'person', 'Parity Employee',
             ${manifest.openbooks.subsidiaryId}, true,
             ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
        `);
        await tx.execute(sql`
          insert into employee_roles
            (org_id, party_id, employee_number, expense_account_id, is_active,
             created_by, updated_by)
          values
            (${manifest.openbooks.orgId}, ${employeeId}, 'PARITY-EMP-1',
             ${manifest.openbooks.accounts.adjustment}, true,
             ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
        `);
      });
    }
    manifest.openbooks.employeeId = employeeId;
  }

  let paymentCardId = manifest.openbooks.paymentCardId;
  if (!paymentCardId) {
    const existing = (await db.execute<{ id: string }>(sql`
      select id
        from payment_cards
       where org_id = ${manifest.openbooks.orgId}
         and label = 'Parity Corporate Card'
       limit 1
    `));
    paymentCardId = existing.rows[0]?.id;
    if (!paymentCardId) {
      paymentCardId = randomUUID();
      await db.execute(sql`
        insert into payment_cards
          (id, org_id, holder_party_id, liability_account_id, label, last_four,
           network, is_active, created_by, updated_by)
        values
          (${paymentCardId}, ${manifest.openbooks.orgId}, ${employeeId},
           ${manifest.openbooks.accounts.ap}, 'Parity Corporate Card', '4242',
           'Test', true, ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
      `);
    }
    manifest.openbooks.paymentCardId = paymentCardId;
  }
  saveJson(manifestPath, manifest);
  return { employeeId, paymentCardId };
}

async function ensureParityProjects(
  client: ErpNextParityClient,
  manifest: ParityManifest,
): Promise<{ openbooksProjectId: string; erpnextProject: string }> {
  let openbooksProjectId = manifest.openbooks.projectId;
  if (!openbooksProjectId) {
    const existing = (await db.execute<{ id: string }>(sql`
      select id from projects
       where org_id = ${manifest.openbooks.orgId} and name = 'Parity Project'
       limit 1
    `));
    openbooksProjectId = existing.rows[0]?.id;
    if (!openbooksProjectId) {
      openbooksProjectId = randomUUID();
      await db.execute(sql`
        insert into projects
          (id, org_id, code, name, customer_id, status, subsidiary_id,
           is_active, created_by, updated_by)
        values
          (${openbooksProjectId}, ${manifest.openbooks.orgId}, 'PARITY-PROJECT',
           'Parity Project', ${manifest.openbooks.customerId}, 'active',
           ${manifest.openbooks.subsidiaryId}, true,
           ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
      `);
    }
    manifest.openbooks.projectId = openbooksProjectId;
  }

  let erpnextProject = manifest.erpnext.project;
  if (!erpnextProject) {
    const existing = await client.list<{ name: string }>(
      "Project",
      ["name"],
      [
        ["company", "=", manifest.erpnext.company],
        ["project_name", "=", "Parity Project"],
      ],
      "name asc",
      1,
    );
    erpnextProject = existing[0]?.name;
    if (!erpnextProject) {
      const created = await client.create<{ name: string }>("Project", {
        project_name: "Parity Project",
        company: manifest.erpnext.company,
        customer: manifest.erpnext.customer,
        status: "Open",
        expected_start_date: "2026-01-01",
        expected_end_date: "2026-12-31",
      });
      erpnextProject = created.name;
    }
    manifest.erpnext.project = erpnextProject;
  }
  saveJson(manifestPath, manifest);
  return { openbooksProjectId, erpnextProject };
}

async function ensureInventoryParityConfig(
  client: ErpNextParityClient,
  manifest: ParityManifest,
): Promise<{
  openbooks: NonNullable<ParityManifest["openbooks"]["inventory"]>;
  erpnext: NonNullable<ParityManifest["erpnext"]["inventory"]>;
}> {
  let openbooks = manifest.openbooks.inventory;
  if (!openbooks) {
    const itemRows = (await db.execute<{ id: string }>(sql`
      select i.id
        from items i
        join item_inventory_profiles p on p.item_id = i.id
       where i.org_id = ${manifest.openbooks.orgId}
         and i.code = 'PARITY-STOCK'
       limit 1
    `));
    let itemId = itemRows.rows[0]?.id;
    if (!itemId) {
      itemId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into items
            (id, org_id, kind, code, name, income_account_id, expense_account_id,
             unit, is_active, created_by, updated_by)
          values
            (${itemId}, ${manifest.openbooks.orgId}, 'inventory', 'PARITY-STOCK',
             'Parity Stock Item', ${manifest.openbooks.accounts.revenue},
             ${manifest.openbooks.accounts.cogs}, 'ea', true,
             ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
        `);
        await tx.execute(sql`
          insert into item_inventory_profiles
            (org_id, item_id, costing_method, tracking, asset_account_id,
             cogs_account_id, adjustment_account_id, variance_account_id,
             received_not_billed_account_id, base_unit, allow_negative_inventory,
             created_by, updated_by)
          values
            (${manifest.openbooks.orgId}, ${itemId}, 'fifo', 'none',
             ${manifest.openbooks.accounts.invAsset}, ${manifest.openbooks.accounts.cogs},
             ${manifest.openbooks.accounts.clearing}, ${manifest.openbooks.accounts.adjustment},
             ${manifest.openbooks.accounts.clearing}, 'ea', false,
             ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
        `);
      });
    }
    const locations = (await db.execute<{ id: string }>(sql`
      select id
        from stock_locations
       where org_id = ${manifest.openbooks.orgId}
         and is_active
       order by code
       limit 2
    `));
    if (!locations.rows[0] || !locations.rows[1]) {
      throw new Error("OpenBooks parity tenant needs two stock locations");
    }
    openbooks = {
      itemId,
      stockLocationId: locations.rows[0].id,
      stockLocation2Id: locations.rows[1].id,
    };
    manifest.openbooks.inventory = openbooks;
  }

  let erpnext = manifest.erpnext.inventory;
  if (!erpnext) {
    await client.update("Company", manifest.erpnext.company, {
      enable_perpetual_inventory: 1,
    });
    const item = await ensureErpMaster<{ name: string }>(
      client,
      "Item",
      "PARITY-STOCK",
      {
        item_code: "PARITY-STOCK",
        item_name: "Parity Stock Item",
        item_group: "Products",
        stock_uom: "Unit",
        is_stock_item: 1,
        include_item_in_manufacturing: 1,
        valuation_method: "FIFO",
      },
    );
    const warehouses = await client.list<{
      name: string;
      warehouse_name: string;
      parent_warehouse: string | null;
    }>(
      "Warehouse",
      ["name", "warehouse_name", "parent_warehouse"],
      [
        ["company", "=", manifest.erpnext.company],
        ["is_group", "=", 0],
      ],
      "name asc",
      100,
    );
    const warehouse =
      warehouses.find((row) => row.warehouse_name === "Stores") ??
      warehouses[0];
    if (!warehouse?.parent_warehouse) {
      throw new Error(
        "ERPNext parity company needs a leaf warehouse with a parent",
      );
    }
    const warehouse2 = await ensureErpMaster<{ name: string }>(
      client,
      "Warehouse",
      `Parity Transit - ${manifest.erpnext.abbreviation}`,
      {
        warehouse_name: "Parity Transit",
        company: manifest.erpnext.company,
        parent_warehouse: warehouse.parent_warehouse,
        is_group: 0,
      },
    );
    const adjustmentAccounts = await client.list<{ name: string }>(
      "Account",
      ["name"],
      [
        ["company", "=", manifest.erpnext.company],
        ["is_group", "=", 0],
        ["account_type", "=", "Stock Adjustment"],
      ],
      "name asc",
      20,
    );
    if (!adjustmentAccounts[0]) {
      throw new Error("ERPNext parity company has no Stock Adjustment account");
    }
    erpnext = {
      item: item.name,
      warehouse: warehouse.name,
      warehouse2: warehouse2.name,
      stockAdjustmentAccount: adjustmentAccounts[0].name,
    };
    manifest.erpnext.inventory = erpnext;
  }

  manifest.accountMap.openbooks[manifest.openbooks.accounts.clearing!] =
    "STOCK_ADJUSTMENT";
  manifest.accountMap.erpnext[erpnext.stockAdjustmentAccount] =
    "STOCK_ADJUSTMENT";
  saveJson(manifestPath, manifest);
  return { openbooks, erpnext };
}

async function createAdvancedOpenBooksInventoryItem(
  manifest: ParityManifest,
  code: string,
  name: string,
): Promise<string> {
  const itemId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into items
        (id, org_id, kind, code, name, income_account_id, expense_account_id,
         unit, is_active, created_by, updated_by)
      values
        (${itemId}, ${manifest.openbooks.orgId}, 'inventory', ${code}, ${name},
         ${manifest.openbooks.accounts.revenue}, ${manifest.openbooks.accounts.cogs},
         'ea', true, ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
    `);
    await tx.execute(sql`
      insert into item_inventory_profiles
        (org_id, item_id, costing_method, tracking, asset_account_id,
         cogs_account_id, adjustment_account_id, variance_account_id,
         received_not_billed_account_id, base_unit, allow_negative_inventory,
         created_by, updated_by)
      values
        (${manifest.openbooks.orgId}, ${itemId}, 'fifo', 'none',
         ${manifest.openbooks.accounts.invAsset}, ${manifest.openbooks.accounts.cogs},
         ${manifest.openbooks.accounts.clearing}, ${manifest.openbooks.accounts.adjustment},
         ${manifest.openbooks.accounts.clearing}, 'ea', false,
         ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
    `);
  });
  return itemId;
}

async function createAdvancedErpInventoryItem(
  client: ErpNextParityClient,
  code: string,
  name: string,
): Promise<string> {
  const item = await client.create<{ name: string }>("Item", {
    item_code: code,
    item_name: name,
    item_group: "Products",
    stock_uom: "Unit",
    is_stock_item: 1,
    include_item_in_manufacturing: 1,
    valuation_method: "FIFO",
  });
  return item.name;
}

async function assertAdvancedInventoryState(
  client: ErpNextParityClient,
  manifest: ParityManifest,
  input: {
    openbooksItemId: string;
    erpnextItem: string;
    openbooksLocationId: string;
    erpnextWarehouse: string;
    quantity: string;
    value: string;
    checkpoint: string;
  },
): Promise<void> {
  const [ours, bins, stockLedger] = await Promise.all([
    getOnHand(
      manifest.openbooks.orgId,
      input.openbooksItemId,
      input.openbooksLocationId,
    ),
    client.list<{
      actual_qty: string | number;
      stock_value: string | number;
      valuation_rate: string | number;
    }>(
      "Bin",
      ["actual_qty", "stock_value", "valuation_rate"],
      [
        ["item_code", "=", input.erpnextItem],
        ["warehouse", "=", input.erpnextWarehouse],
      ],
      "name asc",
      1,
    ),
    client.list<{
      actual_qty: string | number;
      stock_value_difference: string | number;
    }>(
      "Stock Ledger Entry",
      [
        "actual_qty",
        "stock_value_difference",
      ],
      [
        ["item_code", "=", input.erpnextItem],
        ["warehouse", "=", input.erpnextWarehouse],
        ["is_cancelled", "=", 0],
      ],
      "posting_date asc, posting_time asc, creation asc",
      500,
    ),
  ]);
  const theirBin = bins[0];
  const erpLedgerValue = stockLedger.reduce(
    (total, row) =>
      total + toUnits(String(row.stock_value_difference ?? 0)),
    0n,
  );
  const actual = {
    openbooksQuantity: toUnits(ours.quantity),
    erpnextQuantity: toUnits(String(theirBin?.actual_qty ?? 0)),
    openbooksValue: toUnits(ours.value),
    erpnextValue: erpLedgerValue,
  };
  const expectedQuantity = toUnits(input.quantity);
  const expectedValue = toUnits(input.value);
  if (
    actual.openbooksQuantity !== expectedQuantity ||
    actual.erpnextQuantity !== expectedQuantity ||
    actual.openbooksValue !== expectedValue ||
    actual.erpnextValue !== expectedValue
  ) {
    throw new Error(
      `${input.checkpoint} inventory state mismatch: ${JSON.stringify(
        Object.fromEntries(
          Object.entries(actual).map(([key, value]) => [key, fromUnits(value)]),
        ),
      )}`,
    );
  }
  const binQuantity = toUnits(String(theirBin?.actual_qty ?? 0));
  const binValue = toUnits(String(theirBin?.stock_value ?? 0));
  if (
    binValue !== actual.erpnextValue
  ) {
    const diagnosticDir = join(runtimeDir, "diagnostics");
    mkdirSync(diagnosticDir, { recursive: true });
    saveJson(
      join(diagnosticDir, `${input.checkpoint}-erpnext-bin-drift.json`),
      {
        checkpoint: input.checkpoint,
        note: "ERPNext Bin cache differs from its latest Stock Ledger Entry",
        bin: {
          quantity: fromUnits(binQuantity),
          value: fromUnits(binValue),
        },
        stockLedger: {
          value: fromUnits(actual.erpnextValue),
          activeRows: stockLedger.length,
        },
      },
    );
    console.warn(
      `WARN ${input.checkpoint} ERPNext Bin cache=${fromUnits(binQuantity)}/${fromUnits(binValue)} ledger=${fromUnits(actual.erpnextQuantity)}/${fromUnits(actual.erpnextValue)}`,
    );
  }
  console.log(
    `PASS ${input.checkpoint} quantity=${fromUnits(expectedQuantity)} value=${fromUnits(expectedValue)}`,
  );
}

async function ensureAdvancedInventoryAccountMap(
  client: ErpNextParityClient,
  manifest: ParityManifest,
): Promise<{ receivedNotBilled: string; valuationExpense: string }> {
  const [receivedNotBilled, valuationExpense] = await Promise.all([
    client.list<{ name: string }>(
      "Account",
      ["name"],
      [
        ["company", "=", manifest.erpnext.company],
        ["account_type", "=", "Stock Received But Not Billed"],
        ["is_group", "=", 0],
      ],
      "name asc",
      1,
    ),
    client.list<{ name: string }>(
      "Account",
      ["name"],
      [
        ["company", "=", manifest.erpnext.company],
        ["account_type", "=", "Expenses Included In Valuation"],
        ["is_group", "=", 0],
      ],
      "name asc",
      1,
    ),
  ]);
  if (!receivedNotBilled[0] || !valuationExpense[0]) {
    throw new Error(
      "ERPNext parity company needs Stock Received But Not Billed and Expenses Included In Valuation accounts",
    );
  }
  manifest.accountMap.openbooks[manifest.openbooks.accounts.clearing!] =
    "STOCK_ADJUSTMENT";
  manifest.accountMap.openbooks[manifest.openbooks.accounts.freight!] =
    "EXPENSE";
  manifest.accountMap.erpnext[receivedNotBilled[0].name] = "STOCK_ADJUSTMENT";
  manifest.accountMap.erpnext[valuationExpense[0].name] = "EXPENSE";
  saveJson(manifestPath, manifest);
  return {
    receivedNotBilled: receivedNotBilled[0].name,
    valuationExpense: valuationExpense[0].name,
  };
}

async function one<T extends Record<string, unknown> = Record<string, unknown>>(
  query: ReturnType<typeof sql>,
) {
  const result = (await db.execute<T>(query));
  if (!result.rows[0]) throw new Error("expected one row");
  return result.rows[0];
}

async function ensureErpMaster<T extends { name: string }>(
  client: ErpNextParityClient,
  doctype: string,
  name: string,
  create: Record<string, unknown>,
): Promise<T> {
  const existing = await client.list<T>(
    doctype,
    ["name"],
    [["name", "=", name]],
    "name asc",
    1,
  );
  if (existing[0]) return client.get<T>(doctype, existing[0].name);
  return client.create(doctype, create) as Promise<T>;
}

async function provision(): Promise<void> {
  mkdirSync(runtimeDir, { recursive: true });
  if (existsSync(manifestPath)) {
    const current = readManifest();
    const org = await one<{ name: string }>(
      sql`select name from orgs where id = ${current.openbooks.orgId}`,
    );
    console.log(
      `already provisioned: ${org.name} (${current.openbooks.orgId})`,
    );
    return;
  }

  const config = erpConfig();
  const client = new ErpNextParityClient(config);
  const companies = await client.list<{ name: string; abbr: string }>(
    "Company",
    ["name", "abbr"],
    [["name", "=", config.company]],
    "name asc",
    1,
  );
  const company = companies[0];
  if (!company)
    throw new Error(`ERPNext company "${config.company}" does not exist`);
  const [customerGroups, supplierGroups, territories] = await Promise.all([
    client.list<{ name: string }>(
      "Customer Group",
      ["name"],
      [["is_group", "=", 0]],
      "name asc",
      50,
    ),
    client.list<{ name: string }>(
      "Supplier Group",
      ["name"],
      [["is_group", "=", 0]],
      "name asc",
      50,
    ),
    client.list<{ name: string }>(
      "Territory",
      ["name"],
      [["is_group", "=", 0]],
      "name asc",
      50,
    ),
  ]);
  if (!customerGroups[0] || !supplierGroups[0] || !territories[0]) {
    throw new Error(
      "ERPNext setup did not create leaf party groups and a leaf territory",
    );
  }

  const customer = await ensureErpMaster<{ name: string }>(
    client,
    "Customer",
    "Parity Customer",
    {
      customer_name: "Parity Customer",
      customer_type: "Company",
      customer_group: customerGroups[0].name,
      territory: territories[0].name,
    },
  );
  const supplier = await ensureErpMaster<{ name: string }>(
    client,
    "Supplier",
    "Parity Supplier",
    {
      supplier_name: "Parity Supplier",
      supplier_type: "Company",
      supplier_group: supplierGroups[0].name,
    },
  );
  const serviceItem = await ensureErpMaster<{ name: string }>(
    client,
    "Item",
    "PARITY-SERVICE",
    {
      item_code: "PARITY-SERVICE",
      item_name: "Parity Service",
      item_group: "Services",
      stock_uom: "Unit",
      is_stock_item: 0,
      include_item_in_manufacturing: 0,
    },
  );

  const erpAccounts = await client.list<{
    name: string;
    account_number: string | null;
    account_type: string | null;
    parent_account: string | null;
  }>(
    "Account",
    ["name", "account_number", "account_type", "parent_account"],
    [
      ["company", "=", config.company],
      ["is_group", "=", 0],
    ],
    "name asc",
    500,
  );
  const byNumber = new Map(
    erpAccounts.map((account) => [account.account_number ?? "", account.name]),
  );
  const byType = new Map(
    erpAccounts.map((account) => [account.account_type ?? "", account.name]),
  );
  const account = (number: string, type?: string): string => {
    const found = byNumber.get(number) ?? (type ? byType.get(type) : undefined);
    if (!found)
      throw new Error(
        `ERPNext account ${number}${type ? `/${type}` : ""} is missing`,
      );
    return found;
  };
  let bank2 = erpAccounts.find(
    (row) => row.name === `Parity Savings - ${company.abbr}`,
  )?.name;
  if (!bank2) {
    const bankParent = erpAccounts.find(
      (row) => row.account_type === "Bank",
    )?.parent_account;
    if (!bankParent)
      throw new Error("ERPNext default bank account has no parent account");
    const created = await client.create<{ name: string }>("Account", {
      account_name: "Parity Savings",
      company: config.company,
      parent_account: bankParent,
      account_type: "Bank",
      root_type: "Asset",
      report_type: "Balance Sheet",
      account_currency: "CAD",
      is_group: 0,
    });
    bank2 = created.name;
  }
  const costCenters = await client.list<{ name: string }>(
    "Cost Center",
    ["name"],
    [
      ["company", "=", config.company],
      ["is_group", "=", 0],
    ],
    "name asc",
    50,
  );
  if (!costCenters[0]) throw new Error("ERPNext has no leaf cost center");

  // OpenBooks stays on the repository's existing remote PostgreSQL/Redis. Only
  // one tenant is created; no database or application stack is provisioned.
  const scratch = await createScratchOrg();
  const actors = await seedFlowActors(scratch.orgId);
  const bank2Id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update orgs
         set name = ${config.company},
             env_kind = 'sandbox',
             settings = jsonb_set(
               jsonb_set(
                 jsonb_set(settings, '{controlAccounts,taxPaid}', to_jsonb(${scratch.accounts.taxInput}::text), true),
                 '{controlAccounts,taxCollected}', to_jsonb(${scratch.accounts.taxOutput}::text), true
               ),
               '{controlAccounts,employeePayable}', to_jsonb(${scratch.accounts.ap}::text), true
             )
       where id = ${scratch.orgId}
    `);
    await tx.execute(sql`
      update subsidiaries set name = ${config.company}
       where id = ${scratch.subsidiaryId} and org_id = ${scratch.orgId}
    `);
    await tx.execute(sql`
      update parties set display_name = 'Parity Customer'
       where id = ${scratch.customerId} and org_id = ${scratch.orgId}
    `);
    await tx.execute(sql`
      update parties set display_name = 'Parity Supplier'
       where id = ${scratch.vendorId} and org_id = ${scratch.orgId}
    `);
    await tx.execute(sql`
      insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate,
         reconcilable, required_dimensions, custom, subsidiary_include_children)
      values
        (${bank2Id}, ${scratch.orgId}, '1001', 'Parity Savings', 'asset_bank',
         false, true, false, true, '[]'::jsonb, '{}'::jsonb, true)
    `);
  });

  const openbooksSemantic: Record<string, string> = {
    [scratch.accounts.bank]: "BANK",
    [bank2Id]: "BANK_2",
    [scratch.accounts.ar]: "AR",
    [scratch.accounts.ap]: "AP",
    [scratch.accounts.revenue]: "REVENUE",
    [scratch.accounts.adjustment]: "EXPENSE",
    [scratch.accounts.invAsset]: "INVENTORY",
    [scratch.accounts.cogs]: "COGS",
    [scratch.accounts.taxInput]: "TAX_CLEARING",
    [scratch.accounts.taxOutput]: "TAX_CLEARING",
    [scratch.accounts.deferred]: "DEFERRED_REVENUE",
    [scratch.accounts.fxGainLoss]: "FX_GAIN_LOSS",
  };
  const erpSemantic: Record<string, string> = {
    [byType.get("Bank") ?? account("1110", "Cash")]: "BANK",
    [bank2]: "BANK_2",
    [account("1310", "Receivable")]: "AR",
    [account("2110", "Payable")]: "AP",
    [account("4120")]: "REVENUE",
    [account("5201")]: "EXPENSE",
    [account("1410", "Stock")]: "INVENTORY",
    [account("5111", "Cost of Goods Sold")]: "COGS",
    [account("", "Tax")]: "TAX_CLEARING",
    [account("5219")]: "FX_GAIN_LOSS",
  };

  const manifest: ParityManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    companyName: config.company,
    currency: "CAD",
    fiscalYear: 2026,
    openbooks: {
      orgId: scratch.orgId,
      subsidiaryId: scratch.subsidiaryId,
      periodId: scratch.periodId,
      bookId: scratch.bookId,
      actorId: actors.adminId,
      customerId: scratch.customerId,
      vendorId: scratch.vendorId,
      accounts: { ...scratch.accounts, bank2: bank2Id },
    },
    erpnext: {
      company: config.company,
      abbreviation: company.abbr,
      customer: customer.name,
      supplier: supplier.name,
      serviceItem: serviceItem.name,
      accounts: {
        bank: byType.get("Bank") ?? account("1110", "Cash"),
        bank2,
        ar: account("1310", "Receivable"),
        ap: account("2110", "Payable"),
        revenue: account("4120"),
        expense: account("5201"),
        inventory: account("1410", "Stock"),
        cogs: account("5111", "Cost of Goods Sold"),
        tax: account("", "Tax"),
        fxGainLoss: account("5219"),
      },
      costCenter: costCenters[0].name,
    },
    accountMap: { openbooks: openbooksSemantic, erpnext: erpSemantic },
  };
  saveJson(manifestPath, manifest);
  console.log(`provisioned OpenBooks tenant ${manifest.openbooks.orgId}`);
  console.log(`ERPNext company ${manifest.erpnext.company}`);
  console.log(`manifest ${manifestPath}`);
}

async function openbooksVoucherSnapshot(
  manifest: ParityManifest,
  documentId: string,
  checkpoint: string,
  options: { includeProject?: boolean; includeControlParty?: boolean } = {},
): Promise<CanonicalGlSnapshot> {
  const rows = (await db.execute<{
      account_id: string;
      amount: string;
      project_id: string | null;
      party_id: string | null;
    }>(sql`
    select l.account_id, l.amount::text, l.project_id, l.party_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where e.org_id = ${manifest.openbooks.orgId}
       and e.source_document_id = ${documentId}
       and e.status in ('posted', 'reversed')
     order by e.created_at, l.line_number
  `));
  const lines: CanonicalGlLine[] = rows.rows.map((row) => {
    const mapped = manifest.accountMap.openbooks[row.account_id];
    if (!mapped)
      throw new Error(`unmapped OpenBooks account ${row.account_id}`);
    let project: string | undefined;
    if (options.includeProject && row.project_id) {
      if (row.project_id !== manifest.openbooks.projectId) {
        throw new Error(`unmapped OpenBooks project ${row.project_id}`);
      }
      project = "PROJECT";
    }
    let party: string | undefined;
    if (
      options.includeControlParty &&
      row.party_id &&
      (mapped === "AR" || mapped === "AP")
    ) {
      if (row.party_id === manifest.openbooks.customerId) party = "CUSTOMER";
      else if (row.party_id === manifest.openbooks.vendorId) party = "SUPPLIER";
      else throw new Error(`unmapped OpenBooks control party ${row.party_id}`);
    }
    return {
      account: mapped,
      amount: fromUnits(toUnits(row.amount)),
      project,
      party,
    };
  });
  return {
    source: "openbooks",
    company: manifest.companyName,
    checkpoint,
    lines: canonicalizeLines(lines),
  };
}

async function openbooksEntriesSnapshot(
  manifest: ParityManifest,
  entryIds: readonly (string | null)[],
  checkpoint: string,
  options: { includeProject?: boolean } = {},
): Promise<CanonicalGlSnapshot> {
  const ids = entryIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) {
    return {
      source: "openbooks",
      company: manifest.companyName,
      checkpoint,
      lines: [],
    };
  }
  const rows = (await db.execute<{ account_id: string; amount: string; project_id: string | null }>(sql`
    select l.account_id, l.amount::text, l.project_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where e.org_id = ${manifest.openbooks.orgId}
       and e.id = any(${`{${ids.join(",")}}`}::uuid[])
       and e.status in ('posted', 'reversed')
     order by e.created_at, l.line_number
  `));
  const lines = rows.rows.map((row): CanonicalGlLine => {
    const mapped = manifest.accountMap.openbooks[row.account_id];
    if (!mapped)
      throw new Error(`unmapped OpenBooks account ${row.account_id}`);
    let project: string | undefined;
    if (options.includeProject && row.project_id) {
      if (row.project_id !== manifest.openbooks.projectId) {
        throw new Error(`unmapped OpenBooks project ${row.project_id}`);
      }
      project = "PROJECT";
    }
    return { account: mapped, amount: fromUnits(toUnits(row.amount)), project };
  });
  return {
    source: "openbooks",
    company: manifest.companyName,
    checkpoint,
    lines: canonicalizeLines(lines),
  };
}

async function erpVoucherSnapshot(
  client: ErpNextParityClient,
  manifest: ParityManifest,
  voucherType: string,
  voucherNo: string,
  checkpoint: string,
  options: {
    includeProject?: boolean;
    includeControlParty?: boolean;
    company?: string;
  } = {},
): Promise<CanonicalGlSnapshot> {
  const rows = await client.list<{
    account: string;
    debit: string | number;
    credit: string | number;
    project: string | null;
    party: string | null;
  }>(
    "GL Entry",
    ["account", "debit", "credit", "project", "party"],
    [
      ["company", "=", options.company ?? manifest.erpnext.company],
      ["voucher_type", "=", voucherType],
      ["voucher_no", "=", voucherNo],
      ["is_cancelled", "=", 0],
    ],
    "creation asc",
    500,
  );
  const lines: CanonicalGlLine[] = rows.map((row) => {
    const mapped = manifest.accountMap.erpnext[row.account];
    if (!mapped) throw new Error(`unmapped ERPNext account ${row.account}`);
    const amount =
      toUnits(String(row.debit ?? 0)) - toUnits(String(row.credit ?? 0));
    let project: string | undefined;
    if (options.includeProject && row.project) {
      if (row.project !== manifest.erpnext.project) {
        throw new Error(`unmapped ERPNext project ${row.project}`);
      }
      project = "PROJECT";
    }
    let party: string | undefined;
    if (
      options.includeControlParty &&
      row.party &&
      (mapped === "AR" || mapped === "AP")
    ) {
      if (row.party === manifest.erpnext.customer) party = "CUSTOMER";
      else if (row.party === manifest.erpnext.supplier) party = "SUPPLIER";
      else throw new Error(`unmapped ERPNext control party ${row.party}`);
    }
    return { account: mapped, amount: fromUnits(amount), project, party };
  });
  return {
    source: "erpnext",
    company: manifest.companyName,
    checkpoint,
    lines: canonicalizeLines(lines),
  };
}

async function erpGlSnapshot(
  client: ErpNextParityClient,
  manifest: ParityManifest,
  filters: unknown[],
  checkpoint: string,
): Promise<CanonicalGlSnapshot> {
  const rows = await client.list<{
    account: string;
    debit: string | number;
    credit: string | number;
  }>(
    "GL Entry",
    ["account", "debit", "credit"],
    [
      ["company", "=", manifest.erpnext.company],
      ["is_cancelled", "=", 0],
      ...filters,
    ],
    "creation asc",
    500,
  );
  const lines = rows.map((row): CanonicalGlLine => {
    const mapped = manifest.accountMap.erpnext[row.account];
    if (!mapped) throw new Error(`unmapped ERPNext account ${row.account}`);
    return {
      account: mapped,
      amount: fromUnits(
        toUnits(String(row.debit ?? 0)) - toUnits(String(row.credit ?? 0)),
      ),
    };
  });
  return {
    source: "erpnext",
    company: manifest.companyName,
    checkpoint,
    lines: canonicalizeLines(lines),
  };
}

async function createOpenBooksJournalDraft(
  manifest: ParityManifest,
  marker: string,
): Promise<string> {
  const [document] = await db
    .insert(schema.documents)
    .values({
      orgId: manifest.openbooks.orgId,
      subsidiaryId: manifest.openbooks.subsidiaryId,
      kind: "journal",
      documentNumber: `PARITY-JE-${marker}`,
      documentDate: "2026-07-15",
      currency: "CAD",
      status: "draft",
      subtotal: "123.45",
      taxTotal: "0",
      total: "123.45",
      memo: `ERPNext parity journal ${marker}`,
      createdBy: manifest.openbooks.actorId,
    })
    .returning({ id: schema.documents.id });
  await db.insert(schema.documentLines).values([
    {
      orgId: manifest.openbooks.orgId,
      documentId: document!.id,
      lineNumber: 1,
      accountId: manifest.openbooks.accounts.adjustment,
      amount: "123.45",
      quantity: "1",
      unitPrice: "123.45",
      description: "Parity expense",
      createdBy: manifest.openbooks.actorId,
    },
    {
      orgId: manifest.openbooks.orgId,
      documentId: document!.id,
      lineNumber: 2,
      accountId: manifest.openbooks.accounts.bank,
      amount: "-123.45",
      quantity: "1",
      unitPrice: "-123.45",
      description: "Parity bank",
      createdBy: manifest.openbooks.actorId,
    },
  ]);
  return document!.id;
}

async function createOpenBooksDocumentDraft(
  manifest: ParityManifest,
  input: {
    kind: string;
    marker: string;
    partyId: string;
    accountId: string;
    amount: string;
  },
): Promise<string> {
  const [document] = await db
    .insert(schema.documents)
    .values({
      orgId: manifest.openbooks.orgId,
      subsidiaryId: manifest.openbooks.subsidiaryId,
      kind: input.kind,
      documentNumber: `PARITY-${input.kind.toUpperCase()}-${input.marker}`,
      partyId: input.partyId,
      documentDate: "2026-07-15",
      dueDate: "2026-07-30",
      currency: "CAD",
      status: "draft",
      subtotal: input.amount,
      taxTotal: "0",
      total: input.amount,
      memo: `ERPNext parity ${input.kind} ${input.marker}`,
      createdBy: manifest.openbooks.actorId,
    })
    .returning({ id: schema.documents.id });
  await db.insert(schema.documentLines).values({
    orgId: manifest.openbooks.orgId,
    documentId: document!.id,
    lineNumber: 1,
    accountId: input.accountId,
    amount: input.amount,
    quantity: "1",
    unitPrice: input.amount,
    description: `Parity ${input.kind}`,
    createdBy: manifest.openbooks.actorId,
  });
  return document!.id;
}

async function createOpenBooksTaxedDocumentDraft(
  manifest: ParityManifest,
  input: {
    kind:
      "customer_invoice" | "vendor_bill" | "customer_credit" | "vendor_credit";
    marker: string;
    partyId: string;
    accountId: string;
    taxCodeId?: string;
    taxGroupId?: string;
    taxConfigs?: TaxComponentConfig[];
    netAmount?: string;
    taxAmount?: string;
    totalAmount?: string;
    taxInputAmount?: string;
  },
): Promise<string> {
  const netAmount = input.netAmount ?? "100.00";
  const taxAmount = input.taxAmount ?? "13.00";
  const totalAmount = input.totalAmount ?? "113.00";
  const taxInputAmount = input.taxInputAmount ?? netAmount;
  const [document] = await db
    .insert(schema.documents)
    .values({
      orgId: manifest.openbooks.orgId,
      subsidiaryId: manifest.openbooks.subsidiaryId,
      kind: input.kind,
      documentNumber: `PARITY-TAX-${input.kind.toUpperCase()}-${input.marker}`,
      partyId: input.partyId,
      documentDate: "2026-07-15",
      dueDate: "2026-07-30",
      currency: "CAD",
      status: "draft",
      subtotal: netAmount,
      taxTotal: taxAmount,
      total: totalAmount,
      memo: `ERPNext parity taxed ${input.kind} ${input.marker}`,
      createdBy: manifest.openbooks.actorId,
    })
    .returning({ id: schema.documents.id });
  const [line] = await db
    .insert(schema.documentLines)
    .values({
      orgId: manifest.openbooks.orgId,
      documentId: document!.id,
      lineNumber: 1,
      accountId: input.accountId,
      amount: netAmount,
      quantity: "1",
      unitPrice: taxInputAmount,
      taxInputAmount,
      taxAmount,
      taxCodeId: input.taxCodeId,
      taxGroupId: input.taxGroupId,
      description: `Parity taxed ${input.kind}`,
      createdBy: manifest.openbooks.actorId,
    })
    .returning({ id: schema.documentLines.id });
  if (Boolean(input.taxCodeId) === Boolean(input.taxGroupId)) {
    throw new Error(
      "OpenBooks parity tax document requires exactly one tax code or group",
    );
  }
  const configs =
    input.taxConfigs ??
    (await loadTaxComponentConfig(
      manifest.openbooks.orgId,
      input.taxCodeId!,
      "2026-07-15",
    ));
  if (configs.length === 0)
    throw new Error("OpenBooks parity tax configuration is missing");
  await persistLineTaxComponents(
    manifest.openbooks.orgId,
    line!.id,
    computeImportedLineTaxEvidence(taxInputAmount, taxAmount, configs),
    manifest.openbooks.actorId,
  );
  return document!.id;
}

async function approveAndPost(
  manifest: ParityManifest,
  documentId: string,
): Promise<string> {
  await db
    .update(schema.documents)
    .set({ status: "approved", updatedBy: manifest.openbooks.actorId })
    .where(eq(schema.documents.id, documentId));
  return postDocument(documentId, {
    control: {
      ar: manifest.openbooks.accounts.ar!,
      ap: manifest.openbooks.accounts.ap!,
      bank: manifest.openbooks.accounts.bank!,
      taxPaid: manifest.openbooks.accounts.taxInput,
      taxCollected: manifest.openbooks.accounts.taxOutput,
      employeePayable: manifest.openbooks.accounts.ap,
      fxRealizedGainLoss: manifest.openbooks.accounts.fxGainLoss,
    },
  });
}

async function openItemLineId(documentId: string): Promise<string> {
  const row = await one<{ id: string }>(sql`
    select l.id
      from documents d
      join journal_lines l on l.entry_id = d.posted_entry_id and l.is_open_item
     where d.id = ${documentId}
  `);
  return row.id;
}

async function assertOutstanding(
  client: ErpNextParityClient,
  manifest: ParityManifest,
  input: {
    checkpoint: string;
    openbooksDocumentId: string;
    erpnextDoctype: "Sales Invoice" | "Purchase Invoice";
    erpnextName: string;
    expected: string;
  },
): Promise<void> {
  const ours = await one<{ open_balance: string }>(sql`
    select open_balance::text from documents
     where id = ${input.openbooksDocumentId} and org_id = ${manifest.openbooks.orgId}
  `);
  const theirs = await client.get<{ outstanding_amount: string | number }>(
    input.erpnextDoctype,
    input.erpnextName,
  );
  const expected = toUnits(input.expected);
  if (
    toUnits(ours.open_balance) !== expected ||
    toUnits(String(theirs.outstanding_amount)) !== expected
  ) {
    throw new Error(
      `${input.checkpoint} outstanding mismatch: OpenBooks=${ours.open_balance}, ERPNext=${theirs.outstanding_amount}, expected=${input.expected}`,
    );
  }
  console.log(`PASS ${input.checkpoint} outstanding=${fromUnits(expected)}`);
}

async function assertForeignOutstanding(
  client: ErpNextParityClient,
  manifest: ParityManifest,
  input: {
    checkpoint: string;
    openbooksDocumentId: string;
    erpnextName: string;
    expectedTransaction: string;
    expectedBase: string;
  },
): Promise<void> {
  const ours = await one<{
    open_balance: string;
    transaction_open: string;
  }>(sql`
    select document.open_balance::text,
           (
             abs(control.txn_amount) - coalesce((
               select sum(application.target_transaction_amount)
                 from applications application
                where application.to_line_id = control.id
                  and application.unapplied_at is null
             ), 0)
           )::text as transaction_open
      from documents document
      join journal_lines control
        on control.entry_id = document.posted_entry_id
       and control.is_open_item
     where document.id = ${input.openbooksDocumentId}
  `);
  const theirs = await client.get<{ outstanding_amount: string | number }>(
    "Sales Invoice",
    input.erpnextName,
  );
  const expectedTransaction = toUnits(input.expectedTransaction);
  const expectedBase = toUnits(input.expectedBase);
  const ok =
    toUnits(ours.transaction_open) === expectedTransaction &&
    toUnits(String(theirs.outstanding_amount)) === expectedTransaction &&
    toUnits(ours.open_balance) === expectedBase;
  const evidence = {
    checkpoint: input.checkpoint,
    openbooks: {
      transactionOutstanding: fromUnits(toUnits(ours.transaction_open)),
      baseCarryingOutstanding: fromUnits(toUnits(ours.open_balance)),
    },
    erpnext: {
      transactionOutstanding: fromUnits(
        toUnits(String(theirs.outstanding_amount)),
      ),
    },
    expected: {
      transactionOutstanding: fromUnits(expectedTransaction),
      baseCarryingOutstanding: fromUnits(expectedBase),
    },
    comparison: { ok },
  };
  saveJson(join(evidenceDir, `${input.checkpoint}-outstanding.json`), evidence);
  if (!ok) {
    throw new Error(
      `${input.checkpoint} foreign outstanding mismatch: ${JSON.stringify(evidence)}`,
    );
  }
  console.log(
    `PASS ${input.checkpoint} outstanding=${fromUnits(expectedTransaction)} ${manifest.currency === "CAD" ? "USD" : ""} / base=${fromUnits(expectedBase)} CAD`,
  );
}

function assertComparison(
  checkpoint: string,
  openbooks: CanonicalGlSnapshot,
  erpnext: CanonicalGlSnapshot,
): void {
  const comparison = compareSnapshots(openbooks, erpnext);
  const evidence = { checkpoint, openbooks, erpnext, comparison };
  saveJson(join(evidenceDir, `${checkpoint}.json`), evidence);
  if (!comparison.ok) {
    throw new Error(
      `${checkpoint} failed:\n${JSON.stringify(comparison, null, 2)}`,
    );
  }
  console.log(`PASS ${checkpoint}`);
}

function remapSnapshotAccounts(
  snapshot: CanonicalGlSnapshot,
  accountMap: Readonly<Record<string, string>>,
): CanonicalGlSnapshot {
  return {
    ...snapshot,
    lines: canonicalizeLines(
      snapshot.lines.map((line) => ({
        ...line,
        account: accountMap[line.account] ?? line.account,
      })),
    ),
  };
}

async function runJournal(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const documentId = await createOpenBooksJournalDraft(manifest, marker);
  const erpDraft = await client.create<{ name: string }>("Journal Entry", {
    voucher_type: "Journal Entry",
    company: manifest.erpnext.company,
    posting_date: "2026-07-15",
    user_remark: `ERPNext parity journal ${marker}`,
    accounts: [
      {
        account: manifest.erpnext.accounts.expense,
        debit_in_account_currency: 123.45,
        credit_in_account_currency: 0,
        cost_center: manifest.erpnext.costCenter,
      },
      {
        account: manifest.erpnext.accounts.bank,
        debit_in_account_currency: 0,
        credit_in_account_currency: 123.45,
      },
    ],
  });

  assertComparison(
    `journal-${marker}-draft`,
    await openbooksVoucherSnapshot(manifest, documentId, "draft"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpDraft.name,
      "draft",
    ),
  );

  await db
    .update(schema.documents)
    .set({ status: "approved", updatedBy: manifest.openbooks.actorId })
    .where(eq(schema.documents.id, documentId));
  await postDocument(documentId, {
    control: {
      ar: manifest.openbooks.accounts.ar!,
      ap: manifest.openbooks.accounts.ap!,
      bank: manifest.openbooks.accounts.bank!,
      taxPaid: manifest.openbooks.accounts.taxInput,
      taxCollected: manifest.openbooks.accounts.taxOutput,
    },
  });
  await client.submit("Journal Entry", erpDraft.name);
  assertComparison(
    `journal-${marker}-submit`,
    await openbooksVoucherSnapshot(manifest, documentId, "submit"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpDraft.name,
      "submit",
    ),
  );

  await requestDocumentVoid({
    documentId,
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    reason: "ERPNext differential lifecycle cancellation",
    reversalDate: "2026-07-15",
    source: "api",
  });
  await client.cancel("Journal Entry", erpDraft.name);
  assertComparison(
    `journal-${marker}-cancel`,
    await openbooksVoucherSnapshot(manifest, documentId, "cancel"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpDraft.name,
      "cancel",
    ),
  );
}

async function runDocumentCorrections(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const cases = [
    {
      label: "sales",
      kind: "customer_invoice",
      partyId: manifest.openbooks.customerId,
      accountId: manifest.openbooks.accounts.revenue,
      erpnextType: "Sales Invoice",
      originalAmount: "101.23",
      correctedAmount: "117.89",
      erpOriginal: {
        company: manifest.erpnext.company,
        customer: manifest.erpnext.customer,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        currency: "CAD",
        disable_rounded_total: 1,
        debit_to: manifest.erpnext.accounts.ar,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 101.23,
            income_account: manifest.erpnext.accounts.revenue,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
      },
      erpCorrected: {
        company: manifest.erpnext.company,
        customer: manifest.erpnext.customer,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        currency: "CAD",
        disable_rounded_total: 1,
        debit_to: manifest.erpnext.accounts.ar,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 117.89,
            income_account: manifest.erpnext.accounts.revenue,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
      },
    },
    {
      label: "purchase",
      kind: "vendor_bill",
      partyId: manifest.openbooks.vendorId,
      accountId: manifest.openbooks.accounts.adjustment,
      erpnextType: "Purchase Invoice",
      originalAmount: "83.17",
      correctedAmount: "91.04",
      erpOriginal: {
        company: manifest.erpnext.company,
        supplier: manifest.erpnext.supplier,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        bill_no: `PARITY-CORR-${marker}`,
        bill_date: "2026-07-15",
        currency: "CAD",
        disable_rounded_total: 1,
        credit_to: manifest.erpnext.accounts.ap,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 83.17,
            expense_account: manifest.erpnext.accounts.expense,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
      },
      erpCorrected: {
        company: manifest.erpnext.company,
        supplier: manifest.erpnext.supplier,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        bill_no: `PARITY-CORR-${marker}-1`,
        bill_date: "2026-07-15",
        currency: "CAD",
        disable_rounded_total: 1,
        credit_to: manifest.erpnext.accounts.ap,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 91.04,
            expense_account: manifest.erpnext.accounts.expense,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
      },
    },
  ] as const;

  for (const correction of cases) {
    const sourceDocumentId = await createOpenBooksDocumentDraft(manifest, {
      kind: correction.kind,
      marker: `${marker}-${correction.label}-CORRECTION`,
      partyId: correction.partyId,
      accountId: correction.accountId!,
      amount: correction.originalAmount,
    });
    const erpOriginal = await client.create<{ name: string }>(
      correction.erpnextType,
      correction.erpOriginal,
    );
    await approveAndPost(manifest, sourceDocumentId);
    await client.submit(correction.erpnextType, erpOriginal.name);
    assertComparison(
      `gl-correction-${correction.label}-${marker}-original-submit`,
      await openbooksVoucherSnapshot(
        manifest,
        sourceDocumentId,
        "original-submit",
        { includeControlParty: true },
      ),
      await erpVoucherSnapshot(
        client,
        manifest,
        correction.erpnextType,
        erpOriginal.name,
        "original-submit",
        { includeControlParty: true },
      ),
    );

    const replacement = await createDocumentCorrectionDraft({
      orgId: manifest.openbooks.orgId,
      sourceDocumentId,
      replacementDocumentNumber: `PARITY-${correction.kind.toUpperCase()}-${marker}-${correction.label}-CORRECTION-1`,
      actorId: manifest.openbooks.actorId,
      reason: "ERPNext differential append-only amount correction",
    });
    await db.execute(sql`
      update document_lines
         set amount = ${correction.correctedAmount},
             unit_price = ${correction.correctedAmount},
             updated_at = now(),
             updated_by = ${manifest.openbooks.actorId}
       where document_id = ${replacement.replacementDocumentId}
    `);
    await db.execute(sql`
      update documents
         set subtotal = ${correction.correctedAmount},
             total = ${correction.correctedAmount},
             updated_at = now(),
             updated_by = ${manifest.openbooks.actorId}
       where id = ${replacement.replacementDocumentId}
    `);

    await requestDocumentVoid({
      documentId: sourceDocumentId,
      orgId: manifest.openbooks.orgId,
      actorId: manifest.openbooks.actorId,
      reason: "ERPNext differential append-only amount correction",
      reversalDate: "2026-07-15",
      source: "api",
    });
    await client.cancel(correction.erpnextType, erpOriginal.name);
    assertComparison(
      `gl-correction-${correction.label}-${marker}-original-cancel`,
      await openbooksVoucherSnapshot(
        manifest,
        sourceDocumentId,
        "original-cancel",
        { includeControlParty: true },
      ),
      await erpVoucherSnapshot(
        client,
        manifest,
        correction.erpnextType,
        erpOriginal.name,
        "original-cancel",
        { includeControlParty: true },
      ),
    );

    const erpReplacement = await client.create<{ name: string }>(
      correction.erpnextType,
      {
        ...correction.erpCorrected,
        amended_from: erpOriginal.name,
      },
    );
    assertComparison(
      `gl-correction-${correction.label}-${marker}-replacement-draft`,
      await openbooksVoucherSnapshot(
        manifest,
        replacement.replacementDocumentId,
        "replacement-draft",
        { includeControlParty: true },
      ),
      await erpVoucherSnapshot(
        client,
        manifest,
        correction.erpnextType,
        erpReplacement.name,
        "replacement-draft",
        { includeControlParty: true },
      ),
    );
    const release = await submitAndReleaseIfUngated(
      correction.kind,
      replacement.replacementDocumentId,
      manifest.openbooks.actorId,
    );
    if (!release.autoApproved) {
      throw new Error(
        `${correction.kind} correction did not complete its approval release`,
      );
    }
    await postDocument(replacement.replacementDocumentId, {
      control: {
        ar: manifest.openbooks.accounts.ar!,
        ap: manifest.openbooks.accounts.ap!,
        bank: manifest.openbooks.accounts.bank!,
        taxPaid: manifest.openbooks.accounts.taxInput,
        taxCollected: manifest.openbooks.accounts.taxOutput,
      },
    });
    await client.submit(correction.erpnextType, erpReplacement.name);
    assertComparison(
      `gl-correction-${correction.label}-${marker}-replacement-submit`,
      await openbooksVoucherSnapshot(
        manifest,
        replacement.replacementDocumentId,
        "replacement-submit",
        { includeControlParty: true },
      ),
      await erpVoucherSnapshot(
        client,
        manifest,
        correction.erpnextType,
        erpReplacement.name,
        "replacement-submit",
        { includeControlParty: true },
      ),
    );

    await requestDocumentVoid({
      documentId: replacement.replacementDocumentId,
      orgId: manifest.openbooks.orgId,
      actorId: manifest.openbooks.actorId,
      reason: "ERPNext differential correction cleanup reversal",
      reversalDate: "2026-07-15",
      source: "api",
    });
    await client.cancel(correction.erpnextType, erpReplacement.name);
    assertComparison(
      `gl-correction-${correction.label}-${marker}-replacement-cancel`,
      await openbooksVoucherSnapshot(
        manifest,
        replacement.replacementDocumentId,
        "replacement-cancel",
        { includeControlParty: true },
      ),
      await erpVoucherSnapshot(
        client,
        manifest,
        correction.erpnextType,
        erpReplacement.name,
        "replacement-cancel",
        { includeControlParty: true },
      ),
    );
  }
}

async function runCore(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);

  const customerInvoiceId = await createOpenBooksDocumentDraft(manifest, {
    kind: "customer_invoice",
    marker,
    partyId: manifest.openbooks.customerId,
    accountId: manifest.openbooks.accounts.revenue!,
    amount: "100.00",
  });
  const erpSalesInvoice = await client.create<{ name: string }>(
    "Sales Invoice",
    {
      company: manifest.erpnext.company,
      customer: manifest.erpnext.customer,
      posting_date: "2026-07-15",
      due_date: "2026-07-30",
      currency: "CAD",
      debit_to: manifest.erpnext.accounts.ar,
      items: [
        {
          item_code: manifest.erpnext.serviceItem,
          qty: 1,
          rate: 100,
          income_account: manifest.erpnext.accounts.revenue,
          cost_center: manifest.erpnext.costCenter,
        },
      ],
    },
  );
  assertComparison(
    `sales-invoice-${marker}-draft`,
    await openbooksVoucherSnapshot(manifest, customerInvoiceId, "draft", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Sales Invoice",
      erpSalesInvoice.name,
      "draft",
      { includeControlParty: true },
    ),
  );
  await approveAndPost(manifest, customerInvoiceId);
  await client.submit("Sales Invoice", erpSalesInvoice.name);
  assertComparison(
    `sales-invoice-${marker}-submit`,
    await openbooksVoucherSnapshot(manifest, customerInvoiceId, "submit", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Sales Invoice",
      erpSalesInvoice.name,
      "submit",
      { includeControlParty: true },
    ),
  );
  await assertOutstanding(client, manifest, {
    checkpoint: `sales-invoice-${marker}-submit`,
    openbooksDocumentId: customerInvoiceId,
    erpnextDoctype: "Sales Invoice",
    erpnextName: erpSalesInvoice.name,
    expected: "100",
  });

  const vendorBillId = await createOpenBooksDocumentDraft(manifest, {
    kind: "vendor_bill",
    marker,
    partyId: manifest.openbooks.vendorId,
    accountId: manifest.openbooks.accounts.adjustment!,
    amount: "80.00",
  });
  const erpPurchaseInvoice = await client.create<{ name: string }>(
    "Purchase Invoice",
    {
      company: manifest.erpnext.company,
      supplier: manifest.erpnext.supplier,
      posting_date: "2026-07-15",
      due_date: "2026-07-30",
      bill_no: `PARITY-${marker}`,
      bill_date: "2026-07-15",
      currency: "CAD",
      credit_to: manifest.erpnext.accounts.ap,
      items: [
        {
          item_code: manifest.erpnext.serviceItem,
          qty: 1,
          rate: 80,
          expense_account: manifest.erpnext.accounts.expense,
          cost_center: manifest.erpnext.costCenter,
        },
      ],
    },
  );
  assertComparison(
    `purchase-invoice-${marker}-draft`,
    await openbooksVoucherSnapshot(manifest, vendorBillId, "draft", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Purchase Invoice",
      erpPurchaseInvoice.name,
      "draft",
      { includeControlParty: true },
    ),
  );
  await approveAndPost(manifest, vendorBillId);
  await client.submit("Purchase Invoice", erpPurchaseInvoice.name);
  assertComparison(
    `purchase-invoice-${marker}-submit`,
    await openbooksVoucherSnapshot(manifest, vendorBillId, "submit", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Purchase Invoice",
      erpPurchaseInvoice.name,
      "submit",
      { includeControlParty: true },
    ),
  );
  await assertOutstanding(client, manifest, {
    checkpoint: `purchase-invoice-${marker}-submit`,
    openbooksDocumentId: vendorBillId,
    erpnextDoctype: "Purchase Invoice",
    erpnextName: erpPurchaseInvoice.name,
    expected: "80",
  });

  const customerPayment = await createPaymentDocument({
    orgId: manifest.openbooks.orgId,
    kind: "customer_payment",
    createdBy: manifest.openbooks.actorId,
    partyId: manifest.openbooks.customerId,
    bankAccountId: manifest.openbooks.accounts.bank,
    documentDate: "2026-07-15",
    currency: "CAD",
    memo: `ERPNext parity receipt ${marker}`,
  });
  const customerAllocation = sameCurrencyAllocation(
    await openItemLineId(customerInvoiceId),
    "100.00",
  );
  await updateDraftPayment(
    customerPayment.id,
    {
      bankAccountId: manifest.openbooks.accounts.bank,
      allocations: [customerAllocation],
      referenceNumber: `PARITY-RCPT-${marker}`,
    },
    manifest.openbooks.actorId,
    manifest.openbooks.orgId,
  );
  const erpCustomerPayment = await client.create<{ name: string }>(
    "Payment Entry",
    {
      payment_type: "Receive",
      company: manifest.erpnext.company,
      posting_date: "2026-07-15",
      party_type: "Customer",
      party: manifest.erpnext.customer,
      paid_from: manifest.erpnext.accounts.ar,
      paid_to: manifest.erpnext.accounts.bank,
      paid_amount: 100,
      received_amount: 100,
      source_exchange_rate: 1,
      target_exchange_rate: 1,
      reference_no: `PARITY-RCPT-${marker}`,
      reference_date: "2026-07-15",
      references: [
        {
          reference_doctype: "Sales Invoice",
          reference_name: erpSalesInvoice.name,
          allocated_amount: 100,
        },
      ],
    },
  );
  assertComparison(
    `customer-payment-${marker}-draft`,
    await openbooksVoucherSnapshot(manifest, customerPayment.id, "draft", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Payment Entry",
      erpCustomerPayment.name,
      "draft",
      { includeControlParty: true },
    ),
  );
  await db
    .update(schema.documents)
    .set({ status: "approved", updatedBy: manifest.openbooks.actorId })
    .where(eq(schema.documents.id, customerPayment.id));
  await postPaymentWithApplications(
    customerPayment.id,
    [customerAllocation],
    manifest.openbooks.actorId,
  );
  await client.submit("Payment Entry", erpCustomerPayment.name);
  assertComparison(
    `customer-payment-${marker}-submit`,
    await openbooksVoucherSnapshot(manifest, customerPayment.id, "submit", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Payment Entry",
      erpCustomerPayment.name,
      "submit",
      { includeControlParty: true },
    ),
  );
  await assertOutstanding(client, manifest, {
    checkpoint: `customer-payment-${marker}-allocated`,
    openbooksDocumentId: customerInvoiceId,
    erpnextDoctype: "Sales Invoice",
    erpnextName: erpSalesInvoice.name,
    expected: "0",
  });

  const vendorPayment = await createPaymentDocument({
    orgId: manifest.openbooks.orgId,
    kind: "vendor_payment",
    createdBy: manifest.openbooks.actorId,
    partyId: manifest.openbooks.vendorId,
    bankAccountId: manifest.openbooks.accounts.bank,
    documentDate: "2026-07-15",
    currency: "CAD",
    memo: `ERPNext parity supplier payment ${marker}`,
  });
  const vendorAllocation = sameCurrencyAllocation(
    await openItemLineId(vendorBillId),
    "80.00",
  );
  await updateDraftPayment(
    vendorPayment.id,
    {
      bankAccountId: manifest.openbooks.accounts.bank,
      allocations: [vendorAllocation],
      referenceNumber: `PARITY-PAY-${marker}`,
    },
    manifest.openbooks.actorId,
    manifest.openbooks.orgId,
  );
  const erpVendorPayment = await client.create<{ name: string }>(
    "Payment Entry",
    {
      payment_type: "Pay",
      company: manifest.erpnext.company,
      posting_date: "2026-07-15",
      party_type: "Supplier",
      party: manifest.erpnext.supplier,
      paid_from: manifest.erpnext.accounts.bank,
      paid_to: manifest.erpnext.accounts.ap,
      paid_amount: 80,
      received_amount: 80,
      source_exchange_rate: 1,
      target_exchange_rate: 1,
      reference_no: `PARITY-PAY-${marker}`,
      reference_date: "2026-07-15",
      references: [
        {
          reference_doctype: "Purchase Invoice",
          reference_name: erpPurchaseInvoice.name,
          allocated_amount: 80,
        },
      ],
    },
  );
  assertComparison(
    `vendor-payment-${marker}-draft`,
    await openbooksVoucherSnapshot(manifest, vendorPayment.id, "draft", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Payment Entry",
      erpVendorPayment.name,
      "draft",
      { includeControlParty: true },
    ),
  );
  await db
    .update(schema.documents)
    .set({ status: "approved", updatedBy: manifest.openbooks.actorId })
    .where(eq(schema.documents.id, vendorPayment.id));
  await postPaymentWithApplications(
    vendorPayment.id,
    [vendorAllocation],
    manifest.openbooks.actorId,
  );
  await client.submit("Payment Entry", erpVendorPayment.name);
  assertComparison(
    `vendor-payment-${marker}-submit`,
    await openbooksVoucherSnapshot(manifest, vendorPayment.id, "submit", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Payment Entry",
      erpVendorPayment.name,
      "submit",
      { includeControlParty: true },
    ),
  );
  await assertOutstanding(client, manifest, {
    checkpoint: `vendor-payment-${marker}-allocated`,
    openbooksDocumentId: vendorBillId,
    erpnextDoctype: "Purchase Invoice",
    erpnextName: erpPurchaseInvoice.name,
    expected: "0",
  });

  for (const payment of [
    {
      openbooksId: customerPayment.id,
      erpnextName: erpCustomerPayment.name,
      invoiceId: customerInvoiceId,
      invoiceType: "Sales Invoice" as const,
      invoiceName: erpSalesInvoice.name,
      expected: "100",
      label: "customer-payment",
    },
    {
      openbooksId: vendorPayment.id,
      erpnextName: erpVendorPayment.name,
      invoiceId: vendorBillId,
      invoiceType: "Purchase Invoice" as const,
      invoiceName: erpPurchaseInvoice.name,
      expected: "80",
      label: "vendor-payment",
    },
  ]) {
    await requestDocumentVoid({
      documentId: payment.openbooksId,
      orgId: manifest.openbooks.orgId,
      actorId: manifest.openbooks.actorId,
      reason: "ERPNext differential payment cancellation",
      reversalDate: "2026-07-15",
      source: "api",
    });
    await client.cancel("Payment Entry", payment.erpnextName);
    assertComparison(
      `${payment.label}-${marker}-cancel`,
      await openbooksVoucherSnapshot(manifest, payment.openbooksId, "cancel", {
        includeControlParty: true,
      }),
      await erpVoucherSnapshot(
        client,
        manifest,
        "Payment Entry",
        payment.erpnextName,
        "cancel",
        { includeControlParty: true },
      ),
    );
    await assertOutstanding(client, manifest, {
      checkpoint: `${payment.label}-${marker}-unallocated`,
      openbooksDocumentId: payment.invoiceId,
      erpnextDoctype: payment.invoiceType,
      erpnextName: payment.invoiceName,
      expected: payment.expected,
    });
  }

  for (const invoice of [
    {
      openbooksId: customerInvoiceId,
      erpnextType: "Sales Invoice",
      erpnextName: erpSalesInvoice.name,
      label: "sales-invoice",
    },
    {
      openbooksId: vendorBillId,
      erpnextType: "Purchase Invoice",
      erpnextName: erpPurchaseInvoice.name,
      label: "purchase-invoice",
    },
  ]) {
    await requestDocumentVoid({
      documentId: invoice.openbooksId,
      orgId: manifest.openbooks.orgId,
      actorId: manifest.openbooks.actorId,
      reason: "ERPNext differential invoice cancellation",
      reversalDate: "2026-07-15",
      source: "api",
    });
    await client.cancel(invoice.erpnextType, invoice.erpnextName);
    assertComparison(
      `${invoice.label}-${marker}-cancel`,
      await openbooksVoucherSnapshot(manifest, invoice.openbooksId, "cancel", {
        includeControlParty: true,
      }),
      await erpVoucherSnapshot(
        client,
        manifest,
        invoice.erpnextType,
        invoice.erpnextName,
        "cancel",
        { includeControlParty: true },
      ),
    );
  }
}

async function runSecondary(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);

  const creditCases = [
    {
      label: "sales-credit",
      openbooksKind: "customer_credit",
      partyId: manifest.openbooks.customerId,
      openbooksAccount: manifest.openbooks.accounts.revenue,
      amount: "30.00",
      erpnextType: "Sales Invoice",
      erpnextDoc: {
        company: manifest.erpnext.company,
        customer: manifest.erpnext.customer,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        currency: "CAD",
        debit_to: manifest.erpnext.accounts.ar,
        is_return: 1,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: -1,
            rate: 30,
            income_account: manifest.erpnext.accounts.revenue,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
      },
    },
    {
      label: "purchase-credit",
      openbooksKind: "vendor_credit",
      partyId: manifest.openbooks.vendorId,
      openbooksAccount: manifest.openbooks.accounts.adjustment,
      amount: "20.00",
      erpnextType: "Purchase Invoice",
      erpnextDoc: {
        company: manifest.erpnext.company,
        supplier: manifest.erpnext.supplier,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        bill_no: `PARITY-CREDIT-${marker}`,
        bill_date: "2026-07-15",
        currency: "CAD",
        credit_to: manifest.erpnext.accounts.ap,
        is_return: 1,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: -1,
            rate: 20,
            expense_account: manifest.erpnext.accounts.expense,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
      },
    },
  ] as const;

  for (const credit of creditCases) {
    const openbooksId = await createOpenBooksDocumentDraft(manifest, {
      kind: credit.openbooksKind,
      marker,
      partyId: credit.partyId,
      accountId: credit.openbooksAccount!,
      amount: credit.amount,
    });
    const erpDraft = await client.create<{ name: string }>(
      credit.erpnextType,
      credit.erpnextDoc,
    );
    assertComparison(
      `${credit.label}-${marker}-draft`,
      await openbooksVoucherSnapshot(manifest, openbooksId, "draft", {
        includeControlParty: true,
      }),
      await erpVoucherSnapshot(
        client,
        manifest,
        credit.erpnextType,
        erpDraft.name,
        "draft",
        { includeControlParty: true },
      ),
    );
    await approveAndPost(manifest, openbooksId);
    await client.submit(credit.erpnextType, erpDraft.name);
    assertComparison(
      `${credit.label}-${marker}-submit`,
      await openbooksVoucherSnapshot(manifest, openbooksId, "submit", {
        includeControlParty: true,
      }),
      await erpVoucherSnapshot(
        client,
        manifest,
        credit.erpnextType,
        erpDraft.name,
        "submit",
        { includeControlParty: true },
      ),
    );
    await requestDocumentVoid({
      documentId: openbooksId,
      orgId: manifest.openbooks.orgId,
      actorId: manifest.openbooks.actorId,
      reason: "ERPNext differential credit cancellation",
      reversalDate: "2026-07-15",
      source: "api",
    });
    await client.cancel(credit.erpnextType, erpDraft.name);
    assertComparison(
      `${credit.label}-${marker}-cancel`,
      await openbooksVoucherSnapshot(manifest, openbooksId, "cancel", {
        includeControlParty: true,
      }),
      await erpVoucherSnapshot(
        client,
        manifest,
        credit.erpnextType,
        erpDraft.name,
        "cancel",
        { includeControlParty: true },
      ),
    );
  }

  const [transfer] = await db
    .insert(schema.documents)
    .values({
      orgId: manifest.openbooks.orgId,
      subsidiaryId: manifest.openbooks.subsidiaryId,
      kind: "transfer",
      documentNumber: `PARITY-TRANSFER-${marker}`,
      documentDate: "2026-07-15",
      currency: "CAD",
      status: "draft",
      subtotal: "50",
      taxTotal: "0",
      total: "50",
      memo: `ERPNext parity transfer ${marker}`,
      createdBy: manifest.openbooks.actorId,
    })
    .returning({ id: schema.documents.id });
  await db.insert(schema.documentLines).values([
    {
      orgId: manifest.openbooks.orgId,
      documentId: transfer!.id,
      lineNumber: 1,
      accountId: manifest.openbooks.accounts.bank2,
      amount: "50",
      quantity: "1",
      unitPrice: "50",
      description: "Transfer destination",
      createdBy: manifest.openbooks.actorId,
    },
    {
      orgId: manifest.openbooks.orgId,
      documentId: transfer!.id,
      lineNumber: 2,
      accountId: manifest.openbooks.accounts.bank,
      amount: "0",
      quantity: "1",
      unitPrice: "0",
      description: "Transfer source",
      createdBy: manifest.openbooks.actorId,
    },
  ]);
  const erpTransfer = await client.create<{ name: string }>("Payment Entry", {
    payment_type: "Internal Transfer",
    company: manifest.erpnext.company,
    posting_date: "2026-07-15",
    paid_from: manifest.erpnext.accounts.bank,
    paid_to: manifest.erpnext.accounts.bank2,
    paid_amount: 50,
    received_amount: 50,
    source_exchange_rate: 1,
    target_exchange_rate: 1,
    reference_no: `PARITY-TRANSFER-${marker}`,
    reference_date: "2026-07-15",
  });
  assertComparison(
    `transfer-${marker}-draft`,
    await openbooksVoucherSnapshot(manifest, transfer!.id, "draft"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Payment Entry",
      erpTransfer.name,
      "draft",
    ),
  );
  await approveAndPost(manifest, transfer!.id);
  await client.submit("Payment Entry", erpTransfer.name);
  assertComparison(
    `transfer-${marker}-submit`,
    await openbooksVoucherSnapshot(manifest, transfer!.id, "submit"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Payment Entry",
      erpTransfer.name,
      "submit",
    ),
  );
  await requestDocumentVoid({
    documentId: transfer!.id,
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    reason: "ERPNext differential transfer cancellation",
    reversalDate: "2026-07-15",
    source: "api",
  });
  await client.cancel("Payment Entry", erpTransfer.name);
  assertComparison(
    `transfer-${marker}-cancel`,
    await openbooksVoucherSnapshot(manifest, transfer!.id, "cancel"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Payment Entry",
      erpTransfer.name,
      "cancel",
    ),
  );

  const semanticCases = [
    {
      label: "check",
      openbooksKind: "check",
      partyId: manifest.openbooks.vendorId,
      accountId: manifest.openbooks.accounts.adjustment,
      amount: "15.25",
      erpDebit: manifest.erpnext.accounts.expense,
      erpCredit: manifest.erpnext.accounts.bank,
    },
    {
      label: "deposit",
      openbooksKind: "deposit",
      partyId: manifest.openbooks.customerId,
      accountId: manifest.openbooks.accounts.revenue,
      amount: "12.75",
      erpDebit: manifest.erpnext.accounts.bank,
      erpCredit: manifest.erpnext.accounts.revenue,
    },
  ] as const;
  for (const item of semanticCases) {
    const openbooksId = await createOpenBooksDocumentDraft(manifest, {
      kind: item.openbooksKind,
      marker,
      partyId: item.partyId,
      accountId: item.accountId!,
      amount: item.amount,
    });
    const erpJournal = await client.create<{ name: string }>("Journal Entry", {
      voucher_type: "Journal Entry",
      company: manifest.erpnext.company,
      posting_date: "2026-07-15",
      user_remark: `ERPNext parity ${item.label} ${marker}`,
      accounts: [
        {
          account: item.erpDebit,
          debit_in_account_currency: item.amount,
          credit_in_account_currency: 0,
          cost_center:
            item.label === "check" ? manifest.erpnext.costCenter : undefined,
        },
        {
          account: item.erpCredit,
          debit_in_account_currency: 0,
          credit_in_account_currency: item.amount,
          cost_center:
            item.label === "deposit" ? manifest.erpnext.costCenter : undefined,
        },
      ],
    });
    assertComparison(
      `${item.label}-${marker}-draft`,
      await openbooksVoucherSnapshot(manifest, openbooksId, "draft", {
        includeControlParty: true,
      }),
      await erpVoucherSnapshot(
        client,
        manifest,
        "Journal Entry",
        erpJournal.name,
        "draft",
      ),
    );
    await approveAndPost(manifest, openbooksId);
    await client.submit("Journal Entry", erpJournal.name);
    assertComparison(
      `${item.label}-${marker}-submit`,
      await openbooksVoucherSnapshot(manifest, openbooksId, "submit"),
      await erpVoucherSnapshot(
        client,
        manifest,
        "Journal Entry",
        erpJournal.name,
        "submit",
      ),
    );
    await requestDocumentVoid({
      documentId: openbooksId,
      orgId: manifest.openbooks.orgId,
      actorId: manifest.openbooks.actorId,
      reason: `ERPNext differential ${item.label} cancellation`,
      reversalDate: "2026-07-15",
      source: "api",
    });
    await client.cancel("Journal Entry", erpJournal.name);
    assertComparison(
      `${item.label}-${marker}-cancel`,
      await openbooksVoucherSnapshot(manifest, openbooksId, "cancel"),
      await erpVoucherSnapshot(
        client,
        manifest,
        "Journal Entry",
        erpJournal.name,
        "cancel",
      ),
    );
  }
}

async function runTax(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const {
    taxCodeId,
    inclusiveTaxCodeId,
    compoundTaxGroupId,
    compoundConfigs,
    withholdingTaxCodeId,
    reverseChargeTaxCodeId,
    erpTaxInputAccount,
    erpTaxInputCompoundAccount,
    erpTaxOutputAccount,
    erpTaxOutputCompoundAccount,
    erpWithholdingAccount,
  } = await ensureTaxParityConfig(client, manifest);
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);

  type TaxParityCase = {
    label: string;
    openbooksKind:
      "customer_invoice" | "vendor_bill" | "customer_credit" | "vendor_credit";
    partyId: string;
    accountId: string;
    taxCodeId?: string;
    taxGroupId?: string;
    taxConfigs?: TaxComponentConfig[];
    netAmount: string;
    taxAmount: string;
    totalAmount: string;
    taxInputAmount: string;
    erpnextType: "Sales Invoice" | "Purchase Invoice";
    erpnextDoc: Record<string, unknown>;
  };

  const cases: TaxParityCase[] = [
    {
      label: "sales-tax-exclusive",
      openbooksKind: "customer_invoice" as const,
      partyId: manifest.openbooks.customerId,
      accountId: manifest.openbooks.accounts.revenue!,
      taxCodeId,
      netAmount: "100.00",
      taxAmount: "13.00",
      totalAmount: "113.00",
      taxInputAmount: "100.00",
      erpnextType: "Sales Invoice" as const,
      erpnextDoc: {
        company: manifest.erpnext.company,
        customer: manifest.erpnext.customer,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        currency: "CAD",
        debit_to: manifest.erpnext.accounts.ar,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 100,
            income_account: manifest.erpnext.accounts.revenue,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
        taxes: [
          {
            charge_type: "On Net Total",
            account_head: erpTaxOutputAccount,
            description: "HST 13%",
            rate: 13,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
      },
    },
    {
      label: "purchase-tax-exclusive",
      openbooksKind: "vendor_bill" as const,
      partyId: manifest.openbooks.vendorId,
      accountId: manifest.openbooks.accounts.adjustment!,
      taxCodeId,
      netAmount: "100.00",
      taxAmount: "13.00",
      totalAmount: "113.00",
      taxInputAmount: "100.00",
      erpnextType: "Purchase Invoice" as const,
      erpnextDoc: {
        company: manifest.erpnext.company,
        supplier: manifest.erpnext.supplier,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        bill_no: `PARITY-TAX-${marker}`,
        bill_date: "2026-07-15",
        currency: "CAD",
        credit_to: manifest.erpnext.accounts.ap,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 100,
            expense_account: manifest.erpnext.accounts.expense,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
        taxes: [
          {
            charge_type: "On Net Total",
            account_head: erpTaxInputAccount,
            description: "HST 13%",
            rate: 13,
            cost_center: manifest.erpnext.costCenter,
            category: "Total",
            add_deduct_tax: "Add",
          },
        ],
      },
    },
    {
      label: "sales-tax-inclusive",
      openbooksKind: "customer_invoice" as const,
      partyId: manifest.openbooks.customerId,
      accountId: manifest.openbooks.accounts.revenue!,
      taxCodeId: inclusiveTaxCodeId,
      netAmount: "100.00",
      taxAmount: "13.00",
      totalAmount: "113.00",
      taxInputAmount: "113.00",
      erpnextType: "Sales Invoice" as const,
      erpnextDoc: {
        company: manifest.erpnext.company,
        customer: manifest.erpnext.customer,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        currency: "CAD",
        debit_to: manifest.erpnext.accounts.ar,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 113,
            income_account: manifest.erpnext.accounts.revenue,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
        taxes: [
          {
            charge_type: "On Net Total",
            account_head: erpTaxOutputAccount,
            description: "HST 13% Inclusive",
            rate: 13,
            included_in_print_rate: 1,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
      },
    },
    {
      label: "purchase-tax-inclusive",
      openbooksKind: "vendor_bill" as const,
      partyId: manifest.openbooks.vendorId,
      accountId: manifest.openbooks.accounts.adjustment!,
      taxCodeId: inclusiveTaxCodeId,
      netAmount: "100.00",
      taxAmount: "13.00",
      totalAmount: "113.00",
      taxInputAmount: "113.00",
      erpnextType: "Purchase Invoice" as const,
      erpnextDoc: {
        company: manifest.erpnext.company,
        supplier: manifest.erpnext.supplier,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        bill_no: `PARITY-TAX-INCLUSIVE-${marker}`,
        bill_date: "2026-07-15",
        currency: "CAD",
        credit_to: manifest.erpnext.accounts.ap,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 113,
            expense_account: manifest.erpnext.accounts.expense,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
        taxes: [
          {
            charge_type: "On Net Total",
            account_head: erpTaxInputAccount,
            description: "HST 13% Inclusive",
            rate: 13,
            included_in_print_rate: 1,
            cost_center: manifest.erpnext.costCenter,
            category: "Total",
            add_deduct_tax: "Add",
          },
        ],
      },
    },
    {
      label: "sales-tax-rounding-half-cent",
      openbooksKind: "customer_invoice" as const,
      partyId: manifest.openbooks.customerId,
      accountId: manifest.openbooks.accounts.revenue!,
      taxCodeId,
      netAmount: "0.05",
      taxAmount: "0.01",
      totalAmount: "0.06",
      taxInputAmount: "0.05",
      erpnextType: "Sales Invoice" as const,
      erpnextDoc: {
        company: manifest.erpnext.company,
        customer: manifest.erpnext.customer,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        currency: "CAD",
        debit_to: manifest.erpnext.accounts.ar,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 0.05,
            income_account: manifest.erpnext.accounts.revenue,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
        taxes: [
          {
            charge_type: "On Net Total",
            account_head: erpTaxOutputAccount,
            description: "HST 13% Rounding",
            rate: 13,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
      },
    },
    {
      label: "purchase-tax-rounding-half-cent",
      openbooksKind: "vendor_bill" as const,
      partyId: manifest.openbooks.vendorId,
      accountId: manifest.openbooks.accounts.adjustment!,
      taxCodeId,
      netAmount: "0.05",
      taxAmount: "0.01",
      totalAmount: "0.06",
      taxInputAmount: "0.05",
      erpnextType: "Purchase Invoice" as const,
      erpnextDoc: {
        company: manifest.erpnext.company,
        supplier: manifest.erpnext.supplier,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        bill_no: `PARITY-TAX-ROUNDING-${marker}`,
        bill_date: "2026-07-15",
        currency: "CAD",
        credit_to: manifest.erpnext.accounts.ap,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 0.05,
            expense_account: manifest.erpnext.accounts.expense,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
        taxes: [
          {
            charge_type: "On Net Total",
            account_head: erpTaxInputAccount,
            description: "HST 13% Rounding",
            rate: 13,
            cost_center: manifest.erpnext.costCenter,
            category: "Total",
            add_deduct_tax: "Add",
          },
        ],
      },
    },
    {
      label: "sales-tax-return",
      openbooksKind: "customer_credit" as const,
      partyId: manifest.openbooks.customerId,
      accountId: manifest.openbooks.accounts.revenue!,
      taxCodeId,
      netAmount: "25.00",
      taxAmount: "3.25",
      totalAmount: "28.25",
      taxInputAmount: "25.00",
      erpnextType: "Sales Invoice" as const,
      erpnextDoc: {
        company: manifest.erpnext.company,
        customer: manifest.erpnext.customer,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        currency: "CAD",
        debit_to: manifest.erpnext.accounts.ar,
        is_return: 1,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: -1,
            rate: 25,
            income_account: manifest.erpnext.accounts.revenue,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
        taxes: [
          {
            charge_type: "On Net Total",
            account_head: erpTaxOutputAccount,
            description: "HST 13% Return",
            rate: 13,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
      },
    },
    {
      label: "purchase-tax-return",
      openbooksKind: "vendor_credit" as const,
      partyId: manifest.openbooks.vendorId,
      accountId: manifest.openbooks.accounts.adjustment!,
      taxCodeId,
      netAmount: "20.00",
      taxAmount: "2.60",
      totalAmount: "22.60",
      taxInputAmount: "20.00",
      erpnextType: "Purchase Invoice" as const,
      erpnextDoc: {
        company: manifest.erpnext.company,
        supplier: manifest.erpnext.supplier,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        bill_no: `PARITY-TAX-RETURN-${marker}`,
        bill_date: "2026-07-15",
        currency: "CAD",
        credit_to: manifest.erpnext.accounts.ap,
        is_return: 1,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: -1,
            rate: 20,
            expense_account: manifest.erpnext.accounts.expense,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
        taxes: [
          {
            charge_type: "On Net Total",
            account_head: erpTaxInputAccount,
            description: "HST 13% Return",
            rate: 13,
            cost_center: manifest.erpnext.costCenter,
            category: "Total",
            add_deduct_tax: "Add",
          },
        ],
      },
    },
    {
      label: "sales-tax-compound",
      openbooksKind: "customer_invoice",
      partyId: manifest.openbooks.customerId,
      accountId: manifest.openbooks.accounts.revenue!,
      taxGroupId: compoundTaxGroupId,
      taxConfigs: compoundConfigs,
      netAmount: "100.00",
      taxAmount: "14.98",
      totalAmount: "114.98",
      taxInputAmount: "100.00",
      erpnextType: "Sales Invoice",
      erpnextDoc: {
        company: manifest.erpnext.company,
        customer: manifest.erpnext.customer,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        currency: "CAD",
        debit_to: manifest.erpnext.accounts.ar,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 100,
            income_account: manifest.erpnext.accounts.revenue,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
        taxes: [
          {
            charge_type: "On Net Total",
            account_head: erpTaxOutputAccount,
            description: "Base tax 5%",
            rate: 5,
            cost_center: manifest.erpnext.costCenter,
          },
          {
            charge_type: "On Previous Row Total",
            row_id: 1,
            account_head: erpTaxOutputCompoundAccount,
            description: "Compound tax 9.5%",
            rate: 9.5,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
      },
    },
    {
      label: "purchase-tax-compound",
      openbooksKind: "vendor_bill",
      partyId: manifest.openbooks.vendorId,
      accountId: manifest.openbooks.accounts.adjustment!,
      taxGroupId: compoundTaxGroupId,
      taxConfigs: compoundConfigs,
      netAmount: "100.00",
      taxAmount: "14.98",
      totalAmount: "114.98",
      taxInputAmount: "100.00",
      erpnextType: "Purchase Invoice",
      erpnextDoc: {
        company: manifest.erpnext.company,
        supplier: manifest.erpnext.supplier,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        bill_no: `PARITY-TAX-COMPOUND-${marker}`,
        bill_date: "2026-07-15",
        currency: "CAD",
        credit_to: manifest.erpnext.accounts.ap,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 100,
            expense_account: manifest.erpnext.accounts.expense,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
        taxes: [
          {
            charge_type: "On Net Total",
            account_head: erpTaxInputAccount,
            description: "Base tax 5%",
            rate: 5,
            cost_center: manifest.erpnext.costCenter,
            category: "Total",
            add_deduct_tax: "Add",
          },
          {
            charge_type: "On Previous Row Total",
            row_id: 1,
            account_head: erpTaxInputCompoundAccount,
            description: "Compound tax 9.5%",
            rate: 9.5,
            cost_center: manifest.erpnext.costCenter,
            category: "Total",
            add_deduct_tax: "Add",
          },
        ],
      },
    },
    {
      label: "purchase-tax-withholding",
      openbooksKind: "vendor_bill",
      partyId: manifest.openbooks.vendorId,
      accountId: manifest.openbooks.accounts.adjustment!,
      taxCodeId: withholdingTaxCodeId,
      netAmount: "100.00",
      taxAmount: "-10.00",
      totalAmount: "90.00",
      taxInputAmount: "100.00",
      erpnextType: "Purchase Invoice",
      erpnextDoc: {
        company: manifest.erpnext.company,
        supplier: manifest.erpnext.supplier,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        bill_no: `PARITY-TAX-WITHHOLDING-${marker}`,
        bill_date: "2026-07-15",
        currency: "CAD",
        credit_to: manifest.erpnext.accounts.ap,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 100,
            expense_account: manifest.erpnext.accounts.expense,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
        taxes: [
          {
            charge_type: "On Net Total",
            account_head: erpWithholdingAccount,
            description: "Withholding 10%",
            rate: 10,
            cost_center: manifest.erpnext.costCenter,
            category: "Total",
            add_deduct_tax: "Deduct",
          },
        ],
      },
    },
    {
      label: "purchase-tax-reverse-charge",
      openbooksKind: "vendor_bill",
      partyId: manifest.openbooks.vendorId,
      accountId: manifest.openbooks.accounts.adjustment!,
      taxCodeId: reverseChargeTaxCodeId,
      netAmount: "100.00",
      taxAmount: "0.00",
      totalAmount: "100.00",
      taxInputAmount: "100.00",
      erpnextType: "Purchase Invoice",
      erpnextDoc: {
        company: manifest.erpnext.company,
        supplier: manifest.erpnext.supplier,
        posting_date: "2026-07-15",
        due_date: "2026-07-30",
        bill_no: `PARITY-TAX-REVERSE-${marker}`,
        bill_date: "2026-07-15",
        currency: "CAD",
        credit_to: manifest.erpnext.accounts.ap,
        items: [
          {
            item_code: manifest.erpnext.serviceItem,
            qty: 1,
            rate: 100,
            expense_account: manifest.erpnext.accounts.expense,
            cost_center: manifest.erpnext.costCenter,
          },
        ],
        taxes: [
          {
            charge_type: "On Net Total",
            account_head: erpTaxInputAccount,
            description: "Reverse charge input 13%",
            rate: 13,
            cost_center: manifest.erpnext.costCenter,
            category: "Total",
            add_deduct_tax: "Add",
          },
          {
            charge_type: "On Net Total",
            account_head: erpTaxOutputAccount,
            description: "Reverse charge output 13%",
            rate: 13,
            cost_center: manifest.erpnext.costCenter,
            category: "Total",
            add_deduct_tax: "Deduct",
          },
        ],
      },
    },
  ];

  const requestedCase = process.argv[3];
  const selectedCases = requestedCase
    ? cases.filter((testCase) => testCase.label === requestedCase)
    : cases;
  if (requestedCase && selectedCases.length === 0) {
    throw new Error(`unknown tax case "${requestedCase}"`);
  }
  for (const testCase of selectedCases) {
    const openbooksId = await createOpenBooksTaxedDocumentDraft(manifest, {
      kind: testCase.openbooksKind,
      marker: `${testCase.label}-${marker}`,
      partyId: testCase.partyId,
      accountId: testCase.accountId,
      taxCodeId: testCase.taxCodeId,
      taxGroupId: testCase.taxGroupId,
      taxConfigs: testCase.taxConfigs,
      netAmount: testCase.netAmount,
      taxAmount: testCase.taxAmount,
      totalAmount: testCase.totalAmount,
      taxInputAmount: testCase.taxInputAmount,
    });
    const erpDocument = await client.create<{ name: string }>(
      testCase.erpnextType,
      { ...testCase.erpnextDoc, disable_rounded_total: 1 },
    );
    assertComparison(
      `${testCase.label}-${marker}-draft`,
      await openbooksVoucherSnapshot(manifest, openbooksId, "draft"),
      await erpVoucherSnapshot(
        client,
        manifest,
        testCase.erpnextType,
        erpDocument.name,
        "draft",
        { includeControlParty: true },
      ),
    );

    await approveAndPost(manifest, openbooksId);
    await client.submit(testCase.erpnextType, erpDocument.name);
    assertComparison(
      `${testCase.label}-${marker}-submit`,
      await openbooksVoucherSnapshot(manifest, openbooksId, "submit", {
        includeControlParty: true,
      }),
      await erpVoucherSnapshot(
        client,
        manifest,
        testCase.erpnextType,
        erpDocument.name,
        "submit",
        { includeControlParty: true },
      ),
    );
    if (
      testCase.openbooksKind === "customer_invoice" ||
      testCase.openbooksKind === "vendor_bill"
    ) {
      await assertOutstanding(client, manifest, {
        checkpoint: `${testCase.label}-${marker}-submit`,
        openbooksDocumentId: openbooksId,
        erpnextDoctype: testCase.erpnextType,
        erpnextName: erpDocument.name,
        expected: testCase.totalAmount,
      });
    }

    await requestDocumentVoid({
      documentId: openbooksId,
      orgId: manifest.openbooks.orgId,
      actorId: manifest.openbooks.actorId,
      reason: "ERPNext differential tax cancellation",
      reversalDate: "2026-07-15",
      source: "api",
    });
    await client.cancel(testCase.erpnextType, erpDocument.name);
    assertComparison(
      `${testCase.label}-${marker}-cancel`,
      await openbooksVoucherSnapshot(manifest, openbooksId, "cancel", {
        includeControlParty: true,
      }),
      await erpVoucherSnapshot(
        client,
        manifest,
        testCase.erpnextType,
        erpDocument.name,
        "cancel",
        { includeControlParty: true },
      ),
    );
  }
}

async function runPostingRules(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const { employeeId, paymentCardId } =
    await ensureOpenBooksEmployeeAndCard(manifest);
  const { openbooksProjectId, erpnextProject } = await ensureParityProjects(
    client,
    manifest,
  );
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const cases = [
    {
      label: "employee-expense",
      kind: "expense_report",
      amount: "75.00",
      card: false,
    },
    { label: "card-charge", kind: "card_charge", amount: "60.00", card: true },
    { label: "card-refund", kind: "card_refund", amount: "-15.00", card: true },
  ] as const;

  for (const testCase of cases) {
    const openbooksId = await createOpenBooksDocumentDraft(manifest, {
      kind: testCase.kind,
      marker,
      partyId: employeeId,
      accountId: manifest.openbooks.accounts.adjustment!,
      amount: testCase.amount,
    });
    if (testCase.card) {
      await db
        .update(schema.documents)
        .set({ paymentCardId, updatedBy: manifest.openbooks.actorId })
        .where(eq(schema.documents.id, openbooksId));
    }

    const signedUnits = toUnits(testCase.amount);
    const positive = signedUnits >= 0n;
    const amount = fromUnits(positive ? signedUnits : -signedUnits);
    const erpJournal = await client.create<{ name: string }>("Journal Entry", {
      voucher_type: "Journal Entry",
      company: manifest.erpnext.company,
      posting_date: "2026-07-15",
      user_remark: `ERPNext semantic parity ${testCase.label} ${marker}`,
      accounts: [
        {
          account: manifest.erpnext.accounts.expense,
          debit_in_account_currency: positive ? amount : 0,
          credit_in_account_currency: positive ? 0 : amount,
          cost_center: manifest.erpnext.costCenter,
        },
        {
          account: manifest.erpnext.accounts.ap,
          debit_in_account_currency: positive ? 0 : amount,
          credit_in_account_currency: positive ? amount : 0,
          party_type: "Supplier",
          party: manifest.erpnext.supplier,
        },
      ],
    });
    assertComparison(
      `${testCase.label}-${marker}-draft`,
      await openbooksVoucherSnapshot(manifest, openbooksId, "draft"),
      await erpVoucherSnapshot(
        client,
        manifest,
        "Journal Entry",
        erpJournal.name,
        "draft",
      ),
    );
    await approveAndPost(manifest, openbooksId);
    await client.submit("Journal Entry", erpJournal.name);
    assertComparison(
      `${testCase.label}-${marker}-submit`,
      await openbooksVoucherSnapshot(manifest, openbooksId, "submit"),
      await erpVoucherSnapshot(
        client,
        manifest,
        "Journal Entry",
        erpJournal.name,
        "submit",
      ),
    );
    if (testCase.kind === "expense_report") {
      const employeePayment = await createPaymentDocument({
        orgId: manifest.openbooks.orgId,
        kind: "vendor_payment",
        createdBy: manifest.openbooks.actorId,
        partyId: employeeId,
        bankAccountId: manifest.openbooks.accounts.bank,
        documentDate: "2026-07-15",
        currency: "CAD",
        memo: `ERPNext parity employee reimbursement ${marker}`,
      });
      const employeeAllocation = sameCurrencyAllocation(
        await openItemLineId(openbooksId),
        amount,
      );
      await updateDraftPayment(
        employeePayment.id,
        {
          bankAccountId: manifest.openbooks.accounts.bank,
          allocations: [employeeAllocation],
          referenceNumber: `PARITY-EMP-PAY-${marker}`,
        },
        manifest.openbooks.actorId,
        manifest.openbooks.orgId,
      );
      const erpEmployeePayment = await client.create<{ name: string }>(
        "Payment Entry",
        {
          payment_type: "Pay",
          company: manifest.erpnext.company,
          posting_date: "2026-07-15",
          party_type: "Supplier",
          party: manifest.erpnext.supplier,
          paid_from: manifest.erpnext.accounts.bank,
          paid_to: manifest.erpnext.accounts.ap,
          paid_amount: 75,
          received_amount: 75,
          source_exchange_rate: 1,
          target_exchange_rate: 1,
          reference_no: `PARITY-EMP-PAY-${marker}`,
          reference_date: "2026-07-15",
          references: [
            {
              reference_doctype: "Journal Entry",
              reference_name: erpJournal.name,
              account: manifest.erpnext.accounts.ap,
              allocated_amount: 75,
            },
          ],
        },
      );
      assertComparison(
        `${testCase.label}-payment-${marker}-draft`,
        await openbooksVoucherSnapshot(manifest, employeePayment.id, "draft"),
        await erpVoucherSnapshot(
          client,
          manifest,
          "Payment Entry",
          erpEmployeePayment.name,
          "draft",
        ),
      );
      await db
        .update(schema.documents)
        .set({ status: "approved", updatedBy: manifest.openbooks.actorId })
        .where(eq(schema.documents.id, employeePayment.id));
      await postPaymentWithApplications(
        employeePayment.id,
        [employeeAllocation],
        manifest.openbooks.actorId,
      );
      await client.submit("Payment Entry", erpEmployeePayment.name);
      assertComparison(
        `${testCase.label}-payment-${marker}-submit`,
        await openbooksVoucherSnapshot(manifest, employeePayment.id, "submit"),
        await erpVoucherSnapshot(
          client,
          manifest,
          "Payment Entry",
          erpEmployeePayment.name,
          "submit",
        ),
      );
      await requestDocumentVoid({
        documentId: employeePayment.id,
        orgId: manifest.openbooks.orgId,
        actorId: manifest.openbooks.actorId,
        reason: "ERPNext differential employee-payment cancellation",
        reversalDate: "2026-07-15",
        source: "api",
      });
      await client.cancel("Payment Entry", erpEmployeePayment.name);
      assertComparison(
        `${testCase.label}-payment-${marker}-cancel`,
        await openbooksVoucherSnapshot(manifest, employeePayment.id, "cancel"),
        await erpVoucherSnapshot(
          client,
          manifest,
          "Payment Entry",
          erpEmployeePayment.name,
          "cancel",
        ),
      );
    }
    await requestDocumentVoid({
      documentId: openbooksId,
      orgId: manifest.openbooks.orgId,
      actorId: manifest.openbooks.actorId,
      reason: "ERPNext differential posting-rule cancellation",
      reversalDate: "2026-07-15",
      source: "api",
    });
    await client.cancel("Journal Entry", erpJournal.name);
    assertComparison(
      `${testCase.label}-${marker}-cancel`,
      await openbooksVoucherSnapshot(manifest, openbooksId, "cancel"),
      await erpVoucherSnapshot(
        client,
        manifest,
        "Journal Entry",
        erpJournal.name,
        "cancel",
      ),
    );
  }

  const projectChargeId = await createOpenBooksDocumentDraft(manifest, {
    kind: "project_charge",
    marker,
    partyId: manifest.openbooks.customerId,
    accountId: manifest.openbooks.accounts.adjustment!,
    amount: "40.00",
  });
  await db
    .update(schema.documentLines)
    .set({
      projectId: openbooksProjectId,
      recoveryAccountId: manifest.openbooks.accounts.revenue,
      updatedBy: manifest.openbooks.actorId,
    })
    .where(eq(schema.documentLines.documentId, projectChargeId));
  const erpProjectJournal = await client.create<{ name: string }>(
    "Journal Entry",
    {
      voucher_type: "Journal Entry",
      company: manifest.erpnext.company,
      posting_date: "2026-07-15",
      user_remark: `ERPNext semantic parity project charge ${marker}`,
      accounts: [
        {
          account: manifest.erpnext.accounts.expense,
          debit_in_account_currency: "40.00",
          credit_in_account_currency: 0,
          cost_center: manifest.erpnext.costCenter,
          project: erpnextProject,
        },
        {
          account: manifest.erpnext.accounts.revenue,
          debit_in_account_currency: 0,
          credit_in_account_currency: "40.00",
          cost_center: manifest.erpnext.costCenter,
        },
      ],
    },
  );
  assertComparison(
    `project-charge-${marker}-draft`,
    await openbooksEntriesSnapshot(manifest, [], "draft", {
      includeProject: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpProjectJournal.name,
      "draft",
      { includeProject: true },
    ),
  );
  await approveAndPost(manifest, projectChargeId);
  await client.submit("Journal Entry", erpProjectJournal.name);
  assertComparison(
    `project-charge-${marker}-submit`,
    await openbooksVoucherSnapshot(manifest, projectChargeId, "submit", {
      includeProject: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpProjectJournal.name,
      "submit",
      { includeProject: true },
    ),
  );
  await requestDocumentVoid({
    documentId: projectChargeId,
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    reason: "ERPNext differential project-charge cancellation",
    reversalDate: "2026-07-15",
    source: "api",
  });
  await client.cancel("Journal Entry", erpProjectJournal.name);
  assertComparison(
    `project-charge-${marker}-cancel`,
    await openbooksVoucherSnapshot(manifest, projectChargeId, "cancel", {
      includeProject: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpProjectJournal.name,
      "cancel",
      { includeProject: true },
    ),
  );
}

async function assertInventoryOnHand(
  client: ErpNextParityClient,
  manifest: ParityManifest,
  config: Awaited<ReturnType<typeof ensureInventoryParityConfig>>,
  expected: { warehouse: string; warehouse2: string },
  checkpoint: string,
): Promise<void> {
  const [openbooks1, openbooks2, erp1, erp2] = await Promise.all([
    getOnHand(
      manifest.openbooks.orgId,
      config.openbooks.itemId,
      config.openbooks.stockLocationId,
    ),
    getOnHand(
      manifest.openbooks.orgId,
      config.openbooks.itemId,
      config.openbooks.stockLocation2Id,
    ),
    client.list<{ actual_qty: string | number }>(
      "Bin",
      ["actual_qty"],
      [
        ["item_code", "=", config.erpnext.item],
        ["warehouse", "=", config.erpnext.warehouse],
      ],
      "name asc",
      1,
    ),
    client.list<{ actual_qty: string | number }>(
      "Bin",
      ["actual_qty"],
      [
        ["item_code", "=", config.erpnext.item],
        ["warehouse", "=", config.erpnext.warehouse2],
      ],
      "name asc",
      1,
    ),
  ]);
  const quantities = {
    openbooks1: toUnits(openbooks1.quantity),
    openbooks2: toUnits(openbooks2.quantity),
    erpnext1: toUnits(String(erp1[0]?.actual_qty ?? 0)),
    erpnext2: toUnits(String(erp2[0]?.actual_qty ?? 0)),
  };
  const expected1 = toUnits(expected.warehouse);
  const expected2 = toUnits(expected.warehouse2);
  if (
    quantities.openbooks1 !== expected1 ||
    quantities.erpnext1 !== expected1 ||
    quantities.openbooks2 !== expected2 ||
    quantities.erpnext2 !== expected2
  ) {
    throw new Error(
      `${checkpoint} inventory quantity mismatch: ${JSON.stringify(
        Object.fromEntries(
          Object.entries(quantities).map(([key, value]) => [
            key,
            fromUnits(value),
          ]),
        ),
      )}`,
    );
  }
  console.log(
    `PASS ${checkpoint} on-hand=${fromUnits(expected1)}/${fromUnits(expected2)}`,
  );
}

async function runInventory(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const config = await ensureInventoryParityConfig(client, manifest);
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  await assertInventoryOnHand(
    client,
    manifest,
    config,
    { warehouse: "0", warehouse2: "0" },
    `inventory-${marker}-opening`,
  );

  const erpReceipt = await client.create<{ name: string }>("Stock Entry", {
    company: manifest.erpnext.company,
    stock_entry_type: "Material Receipt",
    posting_date: "2026-07-15",
    posting_time: "09:00:00",
    remarks: `Parity inventory receipt ${marker}`,
    items: [
      {
        item_code: config.erpnext.item,
        t_warehouse: config.erpnext.warehouse,
        qty: "10",
        basic_rate: "7.25",
        expense_account: config.erpnext.stockAdjustmentAccount,
        cost_center: manifest.erpnext.costCenter,
      },
    ],
  });
  assertComparison(
    `inventory-receipt-${marker}-draft`,
    await openbooksEntriesSnapshot(manifest, [], "draft"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpReceipt.name,
      "draft",
    ),
  );
  const receipt = await receiveInventory(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      itemId: config.openbooks.itemId,
      stockLocationId: config.openbooks.stockLocationId,
      quantity: "10",
      unitCost: "7.25",
      subsidiaryId: manifest.openbooks.subsidiaryId,
      offsetAccountId: manifest.openbooks.accounts.clearing,
      date: "2026-07-15",
      memo: `Parity inventory receipt ${marker}`,
    },
  );
  await client.submit("Stock Entry", erpReceipt.name);
  assertComparison(
    `inventory-receipt-${marker}-submit`,
    await openbooksEntriesSnapshot(manifest, [receipt.entryId], "submit"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpReceipt.name,
      "submit",
    ),
  );
  await assertInventoryOnHand(
    client,
    manifest,
    config,
    { warehouse: "10", warehouse2: "0" },
    `inventory-receipt-${marker}-submit`,
  );

  const erpIssue = await client.create<{ name: string }>("Stock Entry", {
    company: manifest.erpnext.company,
    stock_entry_type: "Material Issue",
    posting_date: "2026-07-15",
    posting_time: "10:00:00",
    remarks: `Parity inventory issue ${marker}`,
    items: [
      {
        item_code: config.erpnext.item,
        s_warehouse: config.erpnext.warehouse,
        qty: "3",
        expense_account: config.erpnext.stockAdjustmentAccount,
        cost_center: manifest.erpnext.costCenter,
      },
    ],
  });
  assertComparison(
    `inventory-issue-${marker}-draft`,
    await openbooksEntriesSnapshot(manifest, [], "draft"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpIssue.name,
      "draft",
    ),
  );
  const issue = await issueInventory(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      itemId: config.openbooks.itemId,
      stockLocationId: config.openbooks.stockLocationId,
      quantity: "3",
      subsidiaryId: manifest.openbooks.subsidiaryId,
      offsetAccountId: manifest.openbooks.accounts.clearing,
      date: "2026-07-15",
      memo: `Parity inventory issue ${marker}`,
    },
  );
  await client.submit("Stock Entry", erpIssue.name);
  assertComparison(
    `inventory-issue-${marker}-submit`,
    await openbooksEntriesSnapshot(manifest, [issue.entryId], "submit"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpIssue.name,
      "submit",
    ),
  );
  await assertInventoryOnHand(
    client,
    manifest,
    config,
    { warehouse: "7", warehouse2: "0" },
    `inventory-issue-${marker}-submit`,
  );

  const erpTransfer = await client.create<{ name: string }>("Stock Entry", {
    company: manifest.erpnext.company,
    stock_entry_type: "Material Transfer",
    posting_date: "2026-07-15",
    posting_time: "11:00:00",
    remarks: `Parity inventory transfer ${marker}`,
    items: [
      {
        item_code: config.erpnext.item,
        s_warehouse: config.erpnext.warehouse,
        t_warehouse: config.erpnext.warehouse2,
        qty: "2",
      },
    ],
  });
  assertComparison(
    `inventory-transfer-${marker}-draft`,
    await openbooksEntriesSnapshot(manifest, [], "draft"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpTransfer.name,
      "draft",
    ),
  );
  const transfer = await transferInventory(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      itemId: config.openbooks.itemId,
      fromStockLocationId: config.openbooks.stockLocationId,
      toStockLocationId: config.openbooks.stockLocation2Id,
      quantity: "2",
      subsidiaryId: manifest.openbooks.subsidiaryId,
      date: "2026-07-15",
      memo: `Parity inventory transfer ${marker}`,
    },
  );
  await client.submit("Stock Entry", erpTransfer.name);
  assertComparison(
    `inventory-transfer-${marker}-submit`,
    await openbooksEntriesSnapshot(manifest, [transfer.entryId], "submit"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpTransfer.name,
      "submit",
    ),
  );
  await assertInventoryOnHand(
    client,
    manifest,
    config,
    { warehouse: "5", warehouse2: "2" },
    `inventory-transfer-${marker}-submit`,
  );

  await client.cancel("Stock Entry", erpTransfer.name);
  const reverseTransfer = await reverseInventoryMovement(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      movementId: transfer.fromMovementId,
      reversalDate: "2026-07-16",
      reason: `Controlled reversal of parity transfer ${marker}`,
    },
  );
  assertComparison(
    `inventory-transfer-${marker}-cancel`,
    await openbooksEntriesSnapshot(
      manifest,
      [transfer.entryId, reverseTransfer.entryId],
      "cancel",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpTransfer.name,
      "cancel",
    ),
  );

  await client.cancel("Stock Entry", erpIssue.name);
  const reverseIssue = await reverseInventoryMovement(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      movementId: issue.movementId,
      reversalDate: "2026-07-16",
      reason: `Controlled reversal of parity issue ${marker}`,
    },
  );
  assertComparison(
    `inventory-issue-${marker}-cancel`,
    await openbooksEntriesSnapshot(
      manifest,
      [issue.entryId, reverseIssue.entryId],
      "cancel",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpIssue.name,
      "cancel",
    ),
  );

  await client.cancel("Stock Entry", erpReceipt.name);
  const reverseReceipt = await reverseInventoryMovement(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      movementId: receipt.movementId,
      reversalDate: "2026-07-16",
      reason: `Controlled reversal of parity receipt ${marker}`,
    },
  );
  assertComparison(
    `inventory-receipt-${marker}-cancel`,
    await openbooksEntriesSnapshot(
      manifest,
      [receipt.entryId, reverseReceipt.entryId],
      "cancel",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpReceipt.name,
      "cancel",
    ),
  );
  await assertInventoryOnHand(
    client,
    manifest,
    config,
    { warehouse: "0", warehouse2: "0" },
    `inventory-${marker}-cancelled`,
  );
}

async function runInventoryAdvanced(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const config = await ensureInventoryParityConfig(client, manifest);
  const advancedAccounts = await ensureAdvancedInventoryAccountMap(
    client,
    manifest,
  );
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);

  // -----------------------------------------------------------------------
  // Stock Reconciliation: count a zero-balance item up to four units.
  // -----------------------------------------------------------------------
  const reconciliationCode = `PARITY-RECON-${marker}`;
  const [reconciliationOpenBooksItem, reconciliationErpItem] =
    await Promise.all([
      createAdvancedOpenBooksInventoryItem(
        manifest,
        reconciliationCode,
        "Parity Reconciliation Item",
      ),
      createAdvancedErpInventoryItem(
        client,
        reconciliationCode,
        "Parity Reconciliation Item",
      ),
    ]);
  const erpReconciliation = await client.create<{ name: string }>(
    "Stock Reconciliation",
    {
      company: manifest.erpnext.company,
      purpose: "Stock Reconciliation",
      posting_date: "2026-07-15",
      posting_time: "12:00:00",
      expense_account: config.erpnext.stockAdjustmentAccount,
      cost_center: manifest.erpnext.costCenter,
      items: [
        {
          item_code: reconciliationErpItem,
          warehouse: config.erpnext.warehouse,
          qty: "4",
          valuation_rate: "7.25",
        },
      ],
    },
  );
  assertComparison(
    `inventory-advanced-reconciliation-${marker}-draft`,
    await openbooksEntriesSnapshot(manifest, [], "draft"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Reconciliation",
      erpReconciliation.name,
      "draft",
    ),
  );
  const reconciliation = await adjustInventory(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      itemId: reconciliationOpenBooksItem,
      stockLocationId: config.openbooks.stockLocationId,
      quantityDelta: "4",
      unitCost: "7.25",
      subsidiaryId: manifest.openbooks.subsidiaryId,
      date: "2026-07-15",
      memo: `Parity stock reconciliation ${marker}`,
    },
  );
  await client.submit("Stock Reconciliation", erpReconciliation.name);
  assertComparison(
    `inventory-advanced-reconciliation-${marker}-submit`,
    await openbooksEntriesSnapshot(
      manifest,
      [reconciliation.entryId],
      "submit",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Reconciliation",
      erpReconciliation.name,
      "submit",
    ),
  );
  await assertAdvancedInventoryState(client, manifest, {
    openbooksItemId: reconciliationOpenBooksItem,
    erpnextItem: reconciliationErpItem,
    openbooksLocationId: config.openbooks.stockLocationId,
    erpnextWarehouse: config.erpnext.warehouse,
    quantity: "4",
    value: "29",
    checkpoint: `inventory-advanced-reconciliation-${marker}-state`,
  });
  await client.cancel("Stock Reconciliation", erpReconciliation.name);
  const reconciliationReversal = await reverseInventoryMovement(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      movementId: reconciliation.movementId,
      reversalDate: "2026-07-16",
      reason: `Controlled reversal of parity stock reconciliation ${marker}`,
    },
  );
  assertComparison(
    `inventory-advanced-reconciliation-${marker}-cancel`,
    await openbooksEntriesSnapshot(
      manifest,
      [reconciliation.entryId, reconciliationReversal.entryId],
      "cancel",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Reconciliation",
      erpReconciliation.name,
      "cancel",
    ),
  );
  await assertAdvancedInventoryState(client, manifest, {
    openbooksItemId: reconciliationOpenBooksItem,
    erpnextItem: reconciliationErpItem,
    openbooksLocationId: config.openbooks.stockLocationId,
    erpnextWarehouse: config.erpnext.warehouse,
    quantity: "0",
    value: "0",
    checkpoint: `inventory-advanced-reconciliation-${marker}-cancelled-state`,
  });

  // -----------------------------------------------------------------------
  // Manufacture: consume four raw units at $4.25 into two finished units.
  // -----------------------------------------------------------------------
  const rawCode = `PARITY-RAW-${marker}`;
  const finishedCode = `PARITY-FG-${marker}`;
  const [
    rawOpenBooksItem,
    finishedOpenBooksItem,
    rawErpItem,
    finishedErpItem,
  ] = await Promise.all([
    createAdvancedOpenBooksInventoryItem(
      manifest,
      rawCode,
      "Parity Raw Material",
    ),
    createAdvancedOpenBooksInventoryItem(
      manifest,
      finishedCode,
      "Parity Finished Good",
    ),
    createAdvancedErpInventoryItem(client, rawCode, "Parity Raw Material"),
    createAdvancedErpInventoryItem(client, finishedCode, "Parity Finished Good"),
  ]);
  await db.execute(sql`
    insert into bom_components (
      org_id, assembly_item_id, component_item_id, quantity_per, sort_order,
      created_by, updated_by
    ) values (
      ${manifest.openbooks.orgId}, ${finishedOpenBooksItem}, ${rawOpenBooksItem},
      2, 10, ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId}
    )`);
  const erpRawReceipt = await client.create<{ name: string }>("Stock Entry", {
    company: manifest.erpnext.company,
    stock_entry_type: "Material Receipt",
    posting_date: "2026-07-15",
    posting_time: "13:00:00",
    remarks: `Parity manufacture raw receipt ${marker}`,
    items: [
      {
        item_code: rawErpItem,
        t_warehouse: config.erpnext.warehouse,
        qty: "6",
        basic_rate: "4.25",
        expense_account: config.erpnext.stockAdjustmentAccount,
        cost_center: manifest.erpnext.costCenter,
      },
    ],
  });
  const rawReceipt = await receiveInventory(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      itemId: rawOpenBooksItem,
      stockLocationId: config.openbooks.stockLocationId,
      quantity: "6",
      unitCost: "4.25",
      subsidiaryId: manifest.openbooks.subsidiaryId,
      offsetAccountId: manifest.openbooks.accounts.clearing,
      date: "2026-07-15",
      memo: `Parity manufacture raw receipt ${marker}`,
    },
  );
  await client.submit("Stock Entry", erpRawReceipt.name);
  assertComparison(
    `inventory-advanced-manufacture-${marker}-raw-receipt`,
    await openbooksEntriesSnapshot(
      manifest,
      [rawReceipt.entryId],
      "raw-receipt",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpRawReceipt.name,
      "raw-receipt",
    ),
  );

  const erpManufacture = await client.create<{ name: string }>("Stock Entry", {
    company: manifest.erpnext.company,
    purpose: "Manufacture",
    stock_entry_type: "Manufacture",
    posting_date: "2026-07-15",
    posting_time: "14:00:00",
    remarks: `Parity manufacture ${marker}`,
    items: [
      {
        item_code: rawErpItem,
        s_warehouse: config.erpnext.warehouse,
        qty: "4",
        basic_rate: "4.25",
        cost_center: manifest.erpnext.costCenter,
      },
      {
        item_code: finishedErpItem,
        t_warehouse: config.erpnext.warehouse,
        qty: "2",
        is_finished_item: 1,
        cost_center: manifest.erpnext.costCenter,
      },
    ],
  });
  assertComparison(
    `inventory-advanced-manufacture-${marker}-draft`,
    await openbooksEntriesSnapshot(manifest, [], "draft"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpManufacture.name,
      "draft",
    ),
  );
  const manufacture = await buildAssembly(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      assemblyItemId: finishedOpenBooksItem,
      quantity: "2",
      stockLocationId: config.openbooks.stockLocationId,
      subsidiaryId: manifest.openbooks.subsidiaryId,
      date: "2026-07-15",
      memo: `Parity manufacture ${marker}`,
    },
  );
  await client.submit("Stock Entry", erpManufacture.name);
  assertComparison(
    `inventory-advanced-manufacture-${marker}-submit`,
    await openbooksEntriesSnapshot(
      manifest,
      [manufacture.entryId],
      "submit",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpManufacture.name,
      "submit",
    ),
  );
  await Promise.all([
    assertAdvancedInventoryState(client, manifest, {
      openbooksItemId: rawOpenBooksItem,
      erpnextItem: rawErpItem,
      openbooksLocationId: config.openbooks.stockLocationId,
      erpnextWarehouse: config.erpnext.warehouse,
      quantity: "2",
      value: "8.50",
      checkpoint: `inventory-advanced-manufacture-${marker}-raw-state`,
    }),
    assertAdvancedInventoryState(client, manifest, {
      openbooksItemId: finishedOpenBooksItem,
      erpnextItem: finishedErpItem,
      openbooksLocationId: config.openbooks.stockLocationId,
      erpnextWarehouse: config.erpnext.warehouse,
      quantity: "2",
      value: "17",
      checkpoint: `inventory-advanced-manufacture-${marker}-finished-state`,
    }),
  ]);
  await client.cancel("Stock Entry", erpManufacture.name);
  const manufactureReversal = await reverseAssemblyBuild(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      movementId: manufacture.movementId,
      reversalDate: "2026-07-16",
      reason: `Controlled reversal of parity manufacture ${marker}`,
    },
  );
  assertComparison(
    `inventory-advanced-manufacture-${marker}-cancel`,
    await openbooksEntriesSnapshot(
      manifest,
      [manufacture.entryId, manufactureReversal.entryId],
      "cancel",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpManufacture.name,
      "cancel",
    ),
  );
  await Promise.all([
    assertAdvancedInventoryState(client, manifest, {
      openbooksItemId: rawOpenBooksItem,
      erpnextItem: rawErpItem,
      openbooksLocationId: config.openbooks.stockLocationId,
      erpnextWarehouse: config.erpnext.warehouse,
      quantity: "6",
      value: "25.50",
      checkpoint: `inventory-advanced-manufacture-${marker}-cancelled-raw-state`,
    }),
    assertAdvancedInventoryState(client, manifest, {
      openbooksItemId: finishedOpenBooksItem,
      erpnextItem: finishedErpItem,
      openbooksLocationId: config.openbooks.stockLocationId,
      erpnextWarehouse: config.erpnext.warehouse,
      quantity: "0",
      value: "0",
      checkpoint: `inventory-advanced-manufacture-${marker}-cancelled-finished-state`,
    }),
  ]);
  await client.cancel("Stock Entry", erpRawReceipt.name);
  const rawReceiptReversal = await reverseInventoryMovement(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      movementId: rawReceipt.movementId,
      reversalDate: "2026-07-16",
      reason: `Controlled reversal of parity manufacture receipt ${marker}`,
    },
  );
  assertComparison(
    `inventory-advanced-manufacture-${marker}-receipt-cancel`,
    await openbooksEntriesSnapshot(
      manifest,
      [rawReceipt.entryId, rawReceiptReversal.entryId],
      "receipt-cancel",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Stock Entry",
      erpRawReceipt.name,
      "receipt-cancel",
    ),
  );

  // -----------------------------------------------------------------------
  // Landed Cost Voucher: capitalize $5 on a $72.50 purchase receipt.
  // ERPNext rewrites the active Purchase Receipt GL; OpenBooks retains the
  // original receipt plus an append-only capitalization journal.
  // -----------------------------------------------------------------------
  const landedCode = `PARITY-LCV-${marker}`;
  const [landedOpenBooksItem, landedErpItem] = await Promise.all([
    createAdvancedOpenBooksInventoryItem(
      manifest,
      landedCode,
      "Parity Landed Cost Item",
    ),
    createAdvancedErpInventoryItem(client, landedCode, "Parity Landed Cost Item"),
  ]);
  const erpPurchaseReceipt = await client.create<{ name: string }>(
    "Purchase Receipt",
    {
      supplier: manifest.erpnext.supplier,
      company: manifest.erpnext.company,
      posting_date: "2026-07-15",
      currency: "CAD",
      items: [
        {
          item_code: landedErpItem,
          warehouse: config.erpnext.warehouse,
          qty: "10",
          rate: "7.25",
          cost_center: manifest.erpnext.costCenter,
        },
      ],
    },
  );
  const landedReceipt = await receiveInventory(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      itemId: landedOpenBooksItem,
      stockLocationId: config.openbooks.stockLocationId,
      quantity: "10",
      unitCost: "7.25",
      subsidiaryId: manifest.openbooks.subsidiaryId,
      offsetAccountId: manifest.openbooks.accounts.clearing,
      date: "2026-07-15",
      memo: `Parity landed-cost receipt ${marker}`,
    },
  );
  await client.submit("Purchase Receipt", erpPurchaseReceipt.name);
  assertComparison(
    `inventory-advanced-landed-cost-${marker}-receipt`,
    await openbooksEntriesSnapshot(
      manifest,
      [landedReceipt.entryId],
      "receipt",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Purchase Receipt",
      erpPurchaseReceipt.name,
      "receipt",
    ),
  );
  const erpLandedCost = await client.create<{ name: string }>(
    "Landed Cost Voucher",
    {
      company: manifest.erpnext.company,
      posting_date: "2026-07-15",
      distribute_charges_based_on: "Amount",
      purchase_receipts: [
        {
          receipt_document_type: "Purchase Receipt",
          receipt_document: erpPurchaseReceipt.name,
          supplier: manifest.erpnext.supplier,
          posting_date: "2026-07-15",
          grand_total: "72.50",
        },
      ],
      taxes: [
        {
          description: "Parity freight",
          expense_account: advancedAccounts.valuationExpense,
          amount: "5.00",
        },
      ],
    },
  );
  assertComparison(
    `inventory-advanced-landed-cost-${marker}-draft`,
    await openbooksEntriesSnapshot(manifest, [], "draft"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Landed Cost Voucher",
      erpLandedCost.name,
      "draft",
    ),
  );
  const landedVoucher = await postLandedCostVoucher(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      amount: "5",
      basis: "value",
      freightAccountId: manifest.openbooks.accounts.freight!,
      subsidiaryId: manifest.openbooks.subsidiaryId,
      voucherDate: "2026-07-15",
      memo: `Parity landed-cost voucher ${marker}`,
      targets: [
        {
          itemId: landedOpenBooksItem,
          stockLocationId: config.openbooks.stockLocationId,
        },
      ],
    },
  );
  await client.submit("Landed Cost Voucher", erpLandedCost.name);
  assertComparison(
    `inventory-advanced-landed-cost-${marker}-submit`,
    await openbooksEntriesSnapshot(
      manifest,
      [landedReceipt.entryId, landedVoucher.entryId],
      "submit",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Purchase Receipt",
      erpPurchaseReceipt.name,
      "submit",
    ),
  );
  await assertAdvancedInventoryState(client, manifest, {
    openbooksItemId: landedOpenBooksItem,
    erpnextItem: landedErpItem,
    openbooksLocationId: config.openbooks.stockLocationId,
    erpnextWarehouse: config.erpnext.warehouse,
    quantity: "10",
    value: "77.50",
    checkpoint: `inventory-advanced-landed-cost-${marker}-state`,
  });
  await client.cancel("Landed Cost Voucher", erpLandedCost.name);
  const landedCostReversal = await reverseLandedCostVoucher(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      voucherId: landedVoucher.id,
      reversalDate: "2026-07-16",
      reason: `Controlled reversal of parity landed cost ${marker}`,
    },
  );
  assertComparison(
    `inventory-advanced-landed-cost-${marker}-cancel`,
    await openbooksEntriesSnapshot(
      manifest,
      [
        landedReceipt.entryId,
        landedVoucher.entryId,
        landedCostReversal.entryId,
      ],
      "cancel",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Purchase Receipt",
      erpPurchaseReceipt.name,
      "cancel",
    ),
  );
  await assertAdvancedInventoryState(client, manifest, {
    openbooksItemId: landedOpenBooksItem,
    erpnextItem: landedErpItem,
    openbooksLocationId: config.openbooks.stockLocationId,
    erpnextWarehouse: config.erpnext.warehouse,
    quantity: "10",
    value: "72.50",
    checkpoint: `inventory-advanced-landed-cost-${marker}-cancelled-state`,
  });
  await client.cancel("Purchase Receipt", erpPurchaseReceipt.name);
  const landedReceiptReversal = await reverseInventoryMovement(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    {
      movementId: landedReceipt.movementId,
      reversalDate: "2026-07-16",
      reason: `Controlled reversal of parity landed-cost receipt ${marker}`,
    },
  );
  assertComparison(
    `inventory-advanced-landed-cost-${marker}-receipt-cancel`,
    await openbooksEntriesSnapshot(
      manifest,
      [landedReceipt.entryId, landedReceiptReversal.entryId],
      "receipt-cancel",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Purchase Receipt",
      erpPurchaseReceipt.name,
      "receipt-cancel",
    ),
  );
  await assertAdvancedInventoryState(client, manifest, {
    openbooksItemId: landedOpenBooksItem,
    erpnextItem: landedErpItem,
    openbooksLocationId: config.openbooks.stockLocationId,
    erpnextWarehouse: config.erpnext.warehouse,
    quantity: "0",
    value: "0",
    checkpoint: `inventory-advanced-landed-cost-${marker}-receipt-cancelled-state`,
  });
}

async function ensureDepreciationParitySetup(
  client: ErpNextParityClient,
  manifest: ParityManifest,
): Promise<{
  openbooks: {
    assetAccountId: string;
    accumulatedDepreciationAccountId: string;
    depreciationExpenseAccountId: string;
    gainLossAccountId: string;
  };
  erpnext: {
    assetAccount: string;
    accumulatedDepreciationAccount: string;
    depreciationExpenseAccount: string;
    gainLossAccount: string;
    category: string;
    item: string;
    location: string;
  };
}> {
  const ensureOpenBooksAccount = async (
    number: string,
    name: string,
    type: string,
  ): Promise<string> => {
    const existing = (await db.execute<{ id: string }>(sql`
      select id from accounts
       where org_id = ${manifest.openbooks.orgId} and number = ${number}
       limit 1
    `));
    if (existing.rows[0]) return existing.rows[0].id;
    const id = randomUUID();
    await db.execute(sql`
      insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate,
         reconcilable, required_dimensions, custom, subsidiary_include_children)
      values
        (${id}, ${manifest.openbooks.orgId}, ${number}, ${name}, ${type},
         false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
    `);
    return id;
  };
  const openbooks = {
    assetAccountId: await ensureOpenBooksAccount(
      "1801",
      "Parity Fixed Assets",
      "asset_fixed",
    ),
    accumulatedDepreciationAccountId: await ensureOpenBooksAccount(
      "1802",
      "Parity Accumulated Depreciation",
      "asset_fixed",
    ),
    depreciationExpenseAccountId: await ensureOpenBooksAccount(
      "6801",
      "Parity Depreciation Expense",
      "expense",
    ),
    gainLossAccountId: await ensureOpenBooksAccount(
      "6802",
      "Parity Asset Gain or Loss",
      "expense",
    ),
  };

  const calendar = await one<{ id: string }>(sql`
    select id from fiscal_calendars
     where org_id = ${manifest.openbooks.orgId} and is_default
     limit 1
  `);
  for (const period of [
    {
      number: 8,
      name: "2026-08",
      starts: "2026-08-01",
      ends: "2026-08-31",
    },
    {
      number: 9,
      name: "2026-09",
      starts: "2026-09-01",
      ends: "2026-09-30",
    },
  ]) {
    await db.execute(sql`
      insert into accounting_periods
        (org_id, fiscal_year, period_number, name, starts_on, ends_on,
         is_adjustment, fiscal_calendar_id)
      select ${manifest.openbooks.orgId}, 2026, ${period.number}, ${period.name},
             ${period.starts}, ${period.ends}, false, ${calendar.id}
       where not exists (
         select 1 from accounting_periods
          where org_id = ${manifest.openbooks.orgId}
            and starts_on = ${period.starts}
            and ends_on = ${period.ends}
            and not is_adjustment
       )
    `);
  }

  const erpAccounts = await client.list<{
    name: string;
    account_number: string | null;
  }>(
    "Account",
    ["name", "account_number"],
    [
      ["company", "=", manifest.erpnext.company],
      ["is_group", "=", 0],
    ],
    "name asc",
    500,
  );
  const erpByNumber = new Map(
    erpAccounts.map((account) => [account.account_number ?? "", account.name]),
  );
  const assetAccount = erpByNumber.get("1720");
  const accumulatedDepreciationAccount = erpByNumber.get("1780");
  const depreciationExpenseAccount = erpByNumber.get("5203");
  const gainLossAccount = erpByNumber.get("5222");
  if (
    !assetAccount ||
    !accumulatedDepreciationAccount ||
    !depreciationExpenseAccount ||
    !gainLossAccount
  ) {
    throw new Error(
      "ERPNext asset accounts 1720, 1780, 5203, and 5222 are required",
    );
  }

  const categoryName = "Parity Depreciation Assets";
  const categories = await client.list<{ name: string }>(
    "Asset Category",
    ["name"],
    [["name", "=", categoryName]],
    "name asc",
    1,
  );
  const category =
    categories[0] ??
    (await client.create<{ name: string }>("Asset Category", {
      asset_category_name: categoryName,
      accounts: [
        {
          company_name: manifest.erpnext.company,
          fixed_asset_account: assetAccount,
          accumulated_depreciation_account: accumulatedDepreciationAccount,
          depreciation_expense_account: depreciationExpenseAccount,
        },
      ],
    }));
  const itemCode = "PARITY-DEPR-ASSET";
  const items = await client.list<{ name: string }>(
    "Item",
    ["name"],
    [["name", "=", itemCode]],
    "name asc",
    1,
  );
  const item =
    items[0] ??
    (await client.create<{ name: string }>("Item", {
      item_code: itemCode,
      item_name: "Parity Depreciable Asset",
      item_group: "Products",
      stock_uom: "Unit",
      is_stock_item: 0,
      is_fixed_asset: 1,
      asset_category: category.name,
      auto_create_assets: 0,
    }));
  const locationName = "Parity HQ";
  const locations = await client.list<{ name: string }>(
    "Location",
    ["name"],
    [["name", "=", locationName]],
    "name asc",
    1,
  );
  const location =
    locations[0] ??
    (await client.create<{ name: string }>("Location", {
      location_name: locationName,
      is_group: 0,
    }));

  manifest.openbooks.accounts.fixedAsset = openbooks.assetAccountId;
  manifest.openbooks.accounts.accumulatedDepreciation =
    openbooks.accumulatedDepreciationAccountId;
  manifest.openbooks.accounts.depreciationExpense =
    openbooks.depreciationExpenseAccountId;
  manifest.openbooks.accounts.assetGainLoss = openbooks.gainLossAccountId;
  manifest.erpnext.accounts.fixedAsset = assetAccount;
  manifest.erpnext.accounts.accumulatedDepreciation =
    accumulatedDepreciationAccount;
  manifest.erpnext.accounts.depreciationExpense =
    depreciationExpenseAccount;
  manifest.erpnext.accounts.assetGainLoss = gainLossAccount;
  manifest.accountMap.openbooks[openbooks.assetAccountId] = "FIXED_ASSET";
  manifest.accountMap.openbooks[openbooks.accumulatedDepreciationAccountId] =
    "ACCUMULATED_DEPRECIATION";
  manifest.accountMap.openbooks[openbooks.depreciationExpenseAccountId] =
    "DEPRECIATION_EXPENSE";
  manifest.accountMap.openbooks[openbooks.gainLossAccountId] =
    "ASSET_GAIN_LOSS";
  manifest.accountMap.erpnext[assetAccount] = "FIXED_ASSET";
  manifest.accountMap.erpnext[accumulatedDepreciationAccount] =
    "ACCUMULATED_DEPRECIATION";
  manifest.accountMap.erpnext[depreciationExpenseAccount] =
    "DEPRECIATION_EXPENSE";
  manifest.accountMap.erpnext[gainLossAccount] = "ASSET_GAIN_LOSS";
  saveJson(manifestPath, manifest);

  return {
    openbooks,
    erpnext: {
      assetAccount,
      accumulatedDepreciationAccount,
      depreciationExpenseAccount,
      gainLossAccount,
      category: category.name,
      item: item.name,
      location: location.name,
    },
  };
}

async function runDepreciationParity(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const setup = await ensureDepreciationParitySetup(client, manifest);
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);

  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id,
       accumulated_depreciation_account_id, depreciation_expense_account_id,
       default_method, default_life_months, default_convention,
       tax_attributes, is_active, created_by, updated_by)
    values
      (${categoryId}, ${manifest.openbooks.orgId}, ${`Parity Depreciation ${marker}`},
       ${setup.openbooks.assetAccountId},
       ${setup.openbooks.accumulatedDepreciationAccountId},
       ${setup.openbooks.depreciationExpenseAccountId},
       'straight_line', 3, 'full_month', '{}'::jsonb, true,
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, in_service_on, acquisition_cost, salvage_value,
       depreciation_method, useful_life_months, depreciation_convention,
       custom, created_by, updated_by)
    values
      (${assetId}, ${manifest.openbooks.orgId}, ${manifest.openbooks.subsidiaryId},
       ${categoryId}, ${`PARITY-DEP-${marker}`}, ${`Parity Asset ${marker}`},
       'in_service', '2026-07-01', '2026-07-01', 300, 0,
       'straight_line', 3, 'full_month', '{}'::jsonb,
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);
  await buildSchedule(
    assetId,
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    manifest.openbooks.bookId,
  );

  const erpAsset = await client.create<{ name: string }>("Asset", {
    asset_name: `Parity Depreciation ${marker}`,
    item_code: setup.erpnext.item,
    company: manifest.erpnext.company,
    asset_category: setup.erpnext.category,
    location: setup.erpnext.location,
    asset_type: "Existing Asset",
    purchase_date: "2026-07-01",
    available_for_use_date: "2026-07-01",
    gross_purchase_amount: 300,
    purchase_amount: 300,
    net_purchase_amount: 300,
    opening_accumulated_depreciation: 0,
    calculate_depreciation: 1,
    finance_books: [
      {
        depreciation_method: "Straight Line",
        frequency_of_depreciation: 1,
        total_number_of_depreciations: 3,
        depreciation_start_date: "2026-07-31",
        expected_value_after_useful_life: 0,
      },
    ],
  });
  await client.submit("Asset", erpAsset.name);
  const erpSchedules = await client.list<{
    name: string;
    status: string;
  }>(
    "Asset Depreciation Schedule",
    ["name", "status"],
    [["asset", "=", erpAsset.name]],
    "creation asc",
    10,
  );
  if (erpSchedules.length !== 1) {
    throw new Error(
      `ERPNext produced ${erpSchedules.length} depreciation schedules, expected one`,
    );
  }
  const erpScheduleName = erpSchedules[0]!.name;
  const erpSchedule = await client.get<{
    depreciation_schedule: Array<{
      schedule_date: string;
      depreciation_amount: string | number;
      accumulated_depreciation_amount: string | number;
      journal_entry?: string | null;
    }>;
  }>("Asset Depreciation Schedule", erpScheduleName);
  const openbooksSchedule = (await db.execute<{
      schedule_date: string;
      depreciation_amount: string;
      accumulated_depreciation_amount: string;
    }>(sql`
    select p.ends_on::text as schedule_date,
           line.planned_amount::text as depreciation_amount,
           sum(line.planned_amount) over (
             order by line.sequence rows unbounded preceding
           )::text as accumulated_depreciation_amount
      from depreciation_schedule_lines line
      join depreciation_schedules schedule on schedule.id = line.schedule_id
      join accounting_periods p on p.id = line.period_id
     where schedule.asset_id = ${assetId}
       and schedule.book_id = ${manifest.openbooks.bookId}
     order by line.sequence
  `));
  const normalizedErpSchedule = erpSchedule.depreciation_schedule.map(
    (row) => ({
      schedule_date: row.schedule_date,
      depreciation_amount: fromUnits(
        toUnits(String(row.depreciation_amount)),
      ),
      accumulated_depreciation_amount: fromUnits(
        toUnits(String(row.accumulated_depreciation_amount)),
      ),
    }),
  );
  const normalizedOpenBooksSchedule = openbooksSchedule.rows.map((row) => ({
    schedule_date: row.schedule_date,
    depreciation_amount: fromUnits(toUnits(row.depreciation_amount)),
    accumulated_depreciation_amount: fromUnits(
      toUnits(row.accumulated_depreciation_amount),
    ),
  }));
  const scheduleCheckpoint = `depreciation-${marker}-schedule`;
  const scheduleOk =
    JSON.stringify(normalizedOpenBooksSchedule) ===
    JSON.stringify(normalizedErpSchedule);
  saveJson(join(evidenceDir, `${scheduleCheckpoint}.json`), {
    checkpoint: scheduleCheckpoint,
    openbooks: normalizedOpenBooksSchedule,
    erpnext: normalizedErpSchedule,
    comparison: { ok: scheduleOk },
  });
  if (!scheduleOk) {
    throw new Error(
      `${scheduleCheckpoint} failed:\n${JSON.stringify(
        { openbooks: normalizedOpenBooksSchedule, erpnext: normalizedErpSchedule },
        null,
        2,
      )}`,
    );
  }
  console.log(`PASS ${scheduleCheckpoint}`);

  for (const checkpoint of [
    { date: "2026-07-31", label: "period-1" },
    { date: "2026-08-31", label: "period-2" },
    { date: "2026-09-30", label: "period-3" },
  ]) {
    const openbooksRun = await runDepreciation(
      manifest.openbooks.orgId,
      checkpoint.date,
      manifest.openbooks.actorId,
      assetId,
      [manifest.openbooks.subsidiaryId],
      manifest.openbooks.bookId,
    );
    if (openbooksRun.posted !== 1 || openbooksRun.entries.length !== 1) {
      throw new Error(
        `${checkpoint.label}: OpenBooks posted ${openbooksRun.posted}, expected exactly one period`,
      );
    }
    const erpPosted = await client.call<{
      depreciation_schedule: Array<{
        schedule_date: string;
        journal_entry?: string | null;
      }>;
    }>("erpnext.assets.doctype.asset.depreciation.make_depreciation_entry", {
      depr_schedule_name: erpScheduleName,
      date: checkpoint.date,
    });
    const erpLine = erpPosted.depreciation_schedule.find(
      (row) => row.schedule_date === checkpoint.date,
    );
    if (!erpLine?.journal_entry) {
      throw new Error(
        `${checkpoint.label}: ERPNext did not retain a depreciation journal`,
      );
    }
    assertComparison(
      `depreciation-${marker}-${checkpoint.label}-post`,
      await openbooksEntriesSnapshot(
        manifest,
        [openbooksRun.entries[0]!.entryId],
        checkpoint.label,
      ),
      await erpVoucherSnapshot(
        client,
        manifest,
        "Journal Entry",
        erpLine.journal_entry,
        checkpoint.label,
      ),
    );
  }

  const openbooksRetry = await runDepreciation(
    manifest.openbooks.orgId,
    "2026-09-30",
    manifest.openbooks.actorId,
    assetId,
    [manifest.openbooks.subsidiaryId],
    manifest.openbooks.bookId,
  );
  await client.call(
    "erpnext.assets.doctype.asset.depreciation.make_depreciation_entry",
    { depr_schedule_name: erpScheduleName, date: "2026-09-30" },
  );
  const finalEvidence = (await db.execute<{
      postings: number;
      accumulated: string;
      asset_status: string;
    }>(sql`
    select count(*)::int as postings,
           coalesce(sum(posted_amount), 0)::text as accumulated,
           min(a.status) as asset_status
      from depreciation_schedule_lines line
      join depreciation_schedules schedule on schedule.id = line.schedule_id
      join fixed_assets a on a.id = schedule.asset_id
     where schedule.asset_id = ${assetId}
       and line.posted_amount is not null
  `));
  const erpFinal = await client.get<{
    depreciation_schedule: Array<{ journal_entry?: string | null }>;
  }>("Asset Depreciation Schedule", erpScheduleName);
  const erpPostingCount = new Set(
    erpFinal.depreciation_schedule
      .map((line) => line.journal_entry)
      .filter(Boolean),
  ).size;
  const idempotencyCheckpoint = `depreciation-${marker}-idempotency`;
  const idempotencyOk =
    openbooksRetry.posted === 0 &&
    finalEvidence.rows[0]?.postings === 3 &&
    toUnits(finalEvidence.rows[0]?.accumulated ?? "0") === toUnits("300") &&
    finalEvidence.rows[0]?.asset_status === "fully_depreciated" &&
    erpPostingCount === 3;
  saveJson(join(evidenceDir, `${idempotencyCheckpoint}.json`), {
    checkpoint: idempotencyCheckpoint,
    openbooks: {
      retryPosted: openbooksRetry.posted,
      ...finalEvidence.rows[0],
    },
    erpnext: { postingCount: erpPostingCount },
    comparison: { ok: idempotencyOk },
  });
  if (!idempotencyOk) {
    throw new Error(`${idempotencyCheckpoint} failed`);
  }
  console.log(`PASS ${idempotencyCheckpoint}`);
}

async function runAssetLifecycleParity(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const setup = await ensureDepreciationParitySetup(client, manifest);
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const categoryId = randomUUID();
  const assetId = randomUUID();

  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id,
       accumulated_depreciation_account_id, depreciation_expense_account_id,
       gain_loss_account_id, default_method, default_life_months,
       default_convention, tax_attributes, is_active, created_by, updated_by)
    values
      (${categoryId}, ${manifest.openbooks.orgId}, ${`Parity Lifecycle ${marker}`},
       ${setup.openbooks.assetAccountId},
       ${setup.openbooks.accumulatedDepreciationAccountId},
       ${setup.openbooks.depreciationExpenseAccountId},
       ${setup.openbooks.gainLossAccountId},
       'straight_line', 12, 'full_month', '{}'::jsonb, true,
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, in_service_on, acquisition_cost, salvage_value, custom,
       created_by, updated_by)
    values
      (${assetId}, ${manifest.openbooks.orgId}, ${manifest.openbooks.subsidiaryId},
       ${categoryId}, ${`PARITY-LIFE-${marker}`}, ${`Parity Lifecycle ${marker}`},
       'in_service', '2026-07-01', '2026-07-01', 1000, 0, '{}'::jsonb,
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);

  const erpAsset = await client.create<{ name: string }>("Asset", {
    asset_name: `Parity Lifecycle ${marker}`,
    item_code: setup.erpnext.item,
    company: manifest.erpnext.company,
    asset_category: setup.erpnext.category,
    location: setup.erpnext.location,
    asset_type: "Existing Asset",
    purchase_date: "2026-07-01",
    available_for_use_date: "2026-07-01",
    gross_purchase_amount: 1000,
    purchase_amount: 1000,
    net_purchase_amount: 1000,
    value_after_depreciation: 1000,
    calculate_depreciation: 0,
  });
  await client.submit("Asset", erpAsset.name);
  const openbooksCapitalization = await db.execute(sql`
    select count(*)::int as entries from asset_events
     where org_id = ${manifest.openbooks.orgId}
       and asset_id = ${assetId}
       and journal_entry_id is not null
  `);
  const erpCapitalization = await client.list<{ name: string }>(
    "GL Entry",
    ["name"],
    [
      ["company", "=", manifest.erpnext.company],
      ["against_voucher_type", "=", "Asset"],
      ["against_voucher", "=", erpAsset.name],
      ["is_cancelled", "=", 0],
    ],
    "creation asc",
    100,
  );
  const capitalizationCheckpoint = `asset-lifecycle-${marker}-existing-capitalization`;
  const capitalizationOk =
    Number((openbooksCapitalization.rows[0] as { entries: number }).entries) ===
      0 && erpCapitalization.length === 0;
  saveJson(join(evidenceDir, `${capitalizationCheckpoint}.json`), {
    checkpoint: capitalizationCheckpoint,
    scope: "existing/opening asset registration; acquisition-document capitalization is separately pending in the transaction matrix",
    openbooks: { journalEntries: 0, status: "in_service" },
    erpnext: { glEntries: erpCapitalization.length, status: "Submitted" },
    comparison: { ok: capitalizationOk },
  });
  if (!capitalizationOk) {
    throw new Error(`${capitalizationCheckpoint} failed`);
  }
  console.log(`PASS ${capitalizationCheckpoint}`);

  const remeasurement = await remeasureAsset(
    manifest.openbooks.orgId,
    assetId,
    {
      newCarryingValue: "800",
      date: "2026-07-30",
      actorId: manifest.openbooks.actorId,
    },
  );
  const openbooksRemeasureEvent = await one<{ id: string }>(sql`
    select id from asset_events
     where org_id = ${manifest.openbooks.orgId}
       and asset_id = ${assetId}
       and journal_entry_id = ${remeasurement.entryId}
  `);
  const erpAdjustment = await client.create<{ name: string }>(
    "Asset Value Adjustment",
    {
      asset: erpAsset.name,
      company: manifest.erpnext.company,
      date: "2026-07-30",
      new_asset_value: 800,
      difference_account: setup.erpnext.gainLossAccount,
      cost_center: manifest.erpnext.costCenter,
    },
  );
  const erpSubmittedAdjustment = await client.submit<{
    name: string;
    journal_entry: string;
  }>("Asset Value Adjustment", erpAdjustment.name);
  const remeasurementCheckpoint = `asset-lifecycle-${marker}-impairment`;
  assertComparison(
    remeasurementCheckpoint,
    remapSnapshotAccounts(
      await openbooksEntriesSnapshot(
        manifest,
        [remeasurement.entryId],
        "impairment",
      ),
      { ACCUMULATED_DEPRECIATION: "ASSET_CARRYING_VALUE" },
    ),
    remapSnapshotAccounts(
      await erpVoucherSnapshot(
        client,
        manifest,
        "Journal Entry",
        erpSubmittedAdjustment.journal_entry,
        "impairment",
      ),
      { FIXED_ASSET: "ASSET_CARRYING_VALUE" },
    ),
  );

  const remeasurementReversal = await reverseAssetLifecycleEvent(
    manifest.openbooks.orgId,
    openbooksRemeasureEvent.id,
    {
      date: "2026-07-30",
      actorId: manifest.openbooks.actorId,
      reason: "ERPNext differential impairment cancellation",
    },
  );
  await client.cancel("Asset Value Adjustment", erpAdjustment.name);
  assertComparison(
    `asset-lifecycle-${marker}-impairment-cancel`,
    await openbooksEntriesSnapshot(
      manifest,
      [remeasurement.entryId, remeasurementReversal.reversalEntryId],
      "impairment-cancel",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpSubmittedAdjustment.journal_entry,
      "impairment-cancel",
    ),
  );

  const disposal = await disposeAsset(manifest.openbooks.orgId, assetId, {
    writeOff: true,
    date: "2026-07-30",
    actorId: manifest.openbooks.actorId,
  });
  const openbooksDisposalEvent = await one<{ id: string }>(sql`
    select id from asset_events
     where org_id = ${manifest.openbooks.orgId}
       and asset_id = ${assetId}
       and journal_entry_id = ${disposal.entryId}
  `);
  await client.call(
    "erpnext.assets.doctype.asset.depreciation.scrap_asset",
    { asset_name: erpAsset.name, scrap_date: "2026-07-30" },
  );
  const scrappedAsset = await client.get<{
    journal_entry_for_scrap: string;
    status: string;
  }>("Asset", erpAsset.name);
  if (!scrappedAsset.journal_entry_for_scrap) {
    throw new Error("ERPNext scrap did not retain its disposal journal");
  }
  assertComparison(
    `asset-lifecycle-${marker}-writeoff`,
    await openbooksEntriesSnapshot(
      manifest,
      [disposal.entryId],
      "writeoff",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      scrappedAsset.journal_entry_for_scrap,
      "writeoff",
    ),
  );

  const disposalReversal = await reverseAssetLifecycleEvent(
    manifest.openbooks.orgId,
    openbooksDisposalEvent.id,
    {
      date: "2026-07-30",
      actorId: manifest.openbooks.actorId,
      reason: "ERPNext differential asset restoration",
    },
  );
  await client.call(
    "erpnext.assets.doctype.asset.depreciation.restore_asset",
    { asset_name: erpAsset.name },
  );
  assertComparison(
    `asset-lifecycle-${marker}-restore`,
    await openbooksEntriesSnapshot(
      manifest,
      [disposal.entryId, disposalReversal.reversalEntryId],
      "restore",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      scrappedAsset.journal_entry_for_scrap,
      "restore",
    ),
  );

  const retry = await reverseAssetLifecycleEvent(
    manifest.openbooks.orgId,
    openbooksDisposalEvent.id,
    {
      date: "2026-07-30",
      actorId: manifest.openbooks.actorId,
      reason: "ERPNext differential asset restoration",
    },
  );
  const finalOpenBooks = await one<{
    status: string;
    reversals: number;
  }>(sql`
    select asset.status,
           count(event.id) filter (where event.kind = 'reversed')::int as reversals
      from fixed_assets asset
      left join asset_events event on event.asset_id = asset.id
     where asset.id = ${assetId}
     group by asset.id
  `);
  const finalErp = await client.get<{ status: string }>("Asset", erpAsset.name);
  const idempotencyCheckpoint = `asset-lifecycle-${marker}-reversal-idempotency`;
  const idempotencyOk =
    retry.created === false &&
    finalOpenBooks.status === "in_service" &&
    finalOpenBooks.reversals === 2 &&
    finalErp.status !== "Scrapped";
  saveJson(join(evidenceDir, `${idempotencyCheckpoint}.json`), {
    checkpoint: idempotencyCheckpoint,
    openbooks: { ...finalOpenBooks, retryCreated: retry.created },
    erpnext: finalErp,
    comparison: { ok: idempotencyOk },
  });
  if (!idempotencyOk) {
    throw new Error(`${idempotencyCheckpoint} failed`);
  }
  console.log(`PASS ${idempotencyCheckpoint}`);
}

async function runFxRevaluationParity(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);

  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values ('USD', 'US Dollar', 2)
    on conflict (code) do nothing
  `);
  await db.execute(sql`
    insert into fx_rates
      (org_id, from_currency, to_currency, rate_type, as_of, rate, source,
       created_by, updated_by)
    select ${manifest.openbooks.orgId}, 'USD', 'CAD', 'spot', '2026-07-15',
           1.25, ${`ERPNext parity opening ${marker}`},
           ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId}
     where not exists (
       select 1 from fx_rates
        where org_id = ${manifest.openbooks.orgId}
          and from_currency = 'USD' and to_currency = 'CAD'
          and rate_type = 'spot' and as_of = '2026-07-15'
          and rate = 1.25
     )
  `);
  await db.execute(sql`
    insert into fx_rates
      (org_id, from_currency, to_currency, rate_type, as_of, rate, source,
       created_by, updated_by)
    select ${manifest.openbooks.orgId}, 'USD', 'CAD', 'spot', '2026-07-31',
           1.30, ${`ERPNext parity close ${marker}`},
           ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId}
     where not exists (
       select 1 from fx_rates
        where org_id = ${manifest.openbooks.orgId}
          and from_currency = 'USD' and to_currency = 'CAD'
          and rate_type = 'spot' and as_of = '2026-07-31'
          and rate = 1.30
     )
  `);
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         settings,
         '{controlAccounts,fxUnrealizedGainLoss}',
         to_jsonb(${manifest.openbooks.accounts.fxGainLoss}::text),
         true
       )
     where id = ${manifest.openbooks.orgId}
  `);

  const sourceEntryId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${sourceEntryId}, ${manifest.openbooks.orgId}, ${manifest.openbooks.bookId},
         ${manifest.openbooks.subsidiaryId}, ${`FX-OPEN-${marker}`},
         '2026-07-15', ${manifest.openbooks.periodId},
         'Foreign bank opening exposure', 'draft', 'manual',
         ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
    `);
    await tx.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
         currency, txn_amount, fx_rate, memo)
      values
        (${manifest.openbooks.orgId}, ${sourceEntryId}, 1,
         ${manifest.openbooks.accounts.bank}, ${manifest.openbooks.subsidiaryId},
         125, 'USD', 100, 1.25, 'USD bank exposure'),
        (${manifest.openbooks.orgId}, ${sourceEntryId}, 2,
         ${manifest.openbooks.accounts.adjustment}, ${manifest.openbooks.subsidiaryId},
         -125, 'CAD', -125, 1, 'Opening offset')
    `);
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_at = now(),
             posted_by = ${manifest.openbooks.actorId}
       where id = ${sourceEntryId}
    `);
  });

  const erpAccounts = await client.list<{
    name: string;
    account_type: string | null;
    is_group: number;
    parent_account: string | null;
    account_currency: string;
  }>(
    "Account",
    [
      "name",
      "account_type",
      "is_group",
      "parent_account",
      "account_currency",
    ],
    [["company", "=", manifest.erpnext.company]],
    "name asc",
    500,
  );
  const existingUsd = erpAccounts.find(
    (account) =>
      account.name.startsWith(`Parity USD Bank ${marker}`) &&
      account.account_currency === "USD",
  );
  const bankParent = erpAccounts.find(
    (account) => account.is_group === 1 && account.account_type === "Bank",
  )?.name;
  if (!bankParent) throw new Error("ERPNext has no bank account group");
  const erpUsdBank =
    existingUsd ??
    (await client.create<{
      name: string;
      account_currency: string;
    }>("Account", {
      account_name: `Parity USD Bank ${marker}`,
      company: manifest.erpnext.company,
      parent_account: bankParent,
      account_type: "Bank",
      root_type: "Asset",
      report_type: "Balance Sheet",
      account_currency: "USD",
      is_group: 0,
    }));
  manifest.accountMap.erpnext[erpUsdBank.name] = "BANK";
  saveJson(manifestPath, manifest);
  await client.update("Company", manifest.erpnext.company, {
    unrealized_exchange_gain_loss_account:
      manifest.erpnext.accounts.fxGainLoss,
  });

  const currencyRates = await client.list<{ name: string }>(
    "Currency Exchange",
    ["name"],
    [
      ["date", "=", "2026-07-31"],
      ["from_currency", "=", "USD"],
      ["to_currency", "=", "CAD"],
    ],
    "creation asc",
    10,
  );
  if (!currencyRates[0]) {
    await client.create("Currency Exchange", {
      date: "2026-07-31",
      from_currency: "USD",
      to_currency: "CAD",
      exchange_rate: 1.3,
      for_buying: 1,
      for_selling: 1,
    });
  }

  const erpSource = await client.create<{ name: string }>("Journal Entry", {
    voucher_type: "Journal Entry",
    company: manifest.erpnext.company,
    posting_date: "2026-07-15",
    multi_currency: 1,
    user_remark: `Foreign bank opening exposure ${marker}`,
    accounts: [
      {
        account: erpUsdBank.name,
        account_currency: "USD",
        exchange_rate: 1.25,
        debit_in_account_currency: 100,
        credit_in_account_currency: 0,
        cost_center: manifest.erpnext.costCenter,
      },
      {
        account: manifest.erpnext.accounts.expense,
        account_currency: "CAD",
        exchange_rate: 1,
        debit_in_account_currency: 0,
        credit_in_account_currency: 125,
        cost_center: manifest.erpnext.costCenter,
      },
    ],
  });
  await client.submit("Journal Entry", erpSource.name);

  const erpRevaluation = await client.create<{ name: string }>(
    "Exchange Rate Revaluation",
    {
      posting_date: "2026-07-31",
      company: manifest.erpnext.company,
      rounding_loss_allowance: 0,
      accounts: [
        {
          account: erpUsdBank.name,
          account_currency: "USD",
          balance_in_account_currency: 100,
          new_balance_in_account_currency: 100,
          current_exchange_rate: 1.25,
          new_exchange_rate: 1.3,
          balance_in_base_currency: 125,
          new_balance_in_base_currency: 130,
          gain_loss: 5,
          zero_balance: 0,
        },
      ],
    },
  );
  await client.submit("Exchange Rate Revaluation", erpRevaluation.name);
  const journalResult = await client.call<{
    message?: { revaluation_jv?: string | null };
    revaluation_jv?: string | null;
  }>("run_doc_method", {
    dt: "Exchange Rate Revaluation",
    dn: erpRevaluation.name,
    method: "make_jv_entries",
    args: {},
  });
  const erpRevaluationJournal =
    journalResult.revaluation_jv ?? journalResult.message?.revaluation_jv;
  if (!erpRevaluationJournal) {
    throw new Error("ERPNext did not create the revaluation journal");
  }
  await client.submit("Journal Entry", erpRevaluationJournal);

  const openbooksRun = await runRevaluation(
    manifest.openbooks.orgId,
    manifest.openbooks.periodId,
    manifest.openbooks.actorId,
    [manifest.openbooks.subsidiaryId],
  );
  if (openbooksRun.posted.length !== 1) {
    throw new Error(
      `OpenBooks posted ${openbooksRun.posted.length} revaluations, expected one`,
    );
  }
  const openbooksRevaluation = openbooksRun.posted[0]!;
  assertComparison(
    `fx-revaluation-${marker}-period-end`,
    await openbooksEntriesSnapshot(
      manifest,
      [openbooksRevaluation.entryId],
      "period-end",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpRevaluationJournal,
      "period-end",
    ),
  );

  await client.call("run_doc_method", {
    dt: "Exchange Rate Revaluation",
    dn: erpRevaluation.name,
    method: "make_reverse_journal",
    args: {},
  });
  const erpReversals = await client.list<{ name: string }>(
    "Journal Entry",
    ["name"],
    [
      ["reversal_of", "=", erpRevaluationJournal],
      ["docstatus", "=", 0],
    ],
    "creation desc",
    10,
  );
  if (erpReversals.length !== 1) {
    throw new Error(
      `ERPNext produced ${erpReversals.length} draft revaluation reversals`,
    );
  }
  await client.update("Journal Entry", erpReversals[0]!.name, {
    posting_date: "2026-08-01",
  });
  await client.submit("Journal Entry", erpReversals[0]!.name);
  assertComparison(
    `fx-revaluation-${marker}-next-period-reversal`,
    await openbooksEntriesSnapshot(
      manifest,
      [openbooksRevaluation.reversalEntryId],
      "next-period-reversal",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpReversals[0]!.name,
      "next-period-reversal",
    ),
  );

  const retry = await runRevaluation(
    manifest.openbooks.orgId,
    manifest.openbooks.periodId,
    manifest.openbooks.actorId,
    [manifest.openbooks.subsidiaryId],
  );
  const idempotencyCheckpoint = `fx-revaluation-${marker}-idempotency`;
  const idempotencyOk =
    retry.posted.length === 0 &&
    retry.skipped.some((row) => /already revalued/.test(row.reason));
  saveJson(join(evidenceDir, `${idempotencyCheckpoint}.json`), {
    checkpoint: idempotencyCheckpoint,
    openbooks: retry,
    erpnext: {
      revaluationJournal: erpRevaluationJournal,
      reversalJournal: erpReversals[0]!.name,
    },
    comparison: { ok: idempotencyOk },
  });
  if (!idempotencyOk) throw new Error(`${idempotencyCheckpoint} failed`);
  console.log(`PASS ${idempotencyCheckpoint}`);
}

async function runFxSettlementParity(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values ('USD', 'US Dollar', 2)
    on conflict (code) do nothing
  `);
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         settings,
         '{controlAccounts,fxRealizedGainLoss}',
         to_jsonb(${manifest.openbooks.accounts.fxGainLoss}::text),
         true
       )
     where id = ${manifest.openbooks.orgId}
  `);
  await client.update("Accounts Settings", "Accounts Settings", {
    allow_multi_currency_invoices_against_single_party_account: 1,
  });
  const erpAccounts = await client.list<{
    name: string;
    account_number: string | null;
    is_group: number;
  }>(
    "Account",
    ["name", "account_number", "is_group"],
    [["company", "=", manifest.erpnext.company]],
    "name asc",
    500,
  );
  const receivableParent = erpAccounts.find(
    (account) => account.account_number === "1300" && account.is_group === 1,
  )?.name;
  if (!receivableParent) {
    throw new Error("ERPNext has no receivables account group");
  }
  const erpUsdReceivable = await client.create<{ name: string }>("Account", {
    account_name: `Parity USD Receivable ${marker}`,
    company: manifest.erpnext.company,
    parent_account: receivableParent,
    account_type: "Receivable",
    root_type: "Asset",
    report_type: "Balance Sheet",
    account_currency: "USD",
    is_group: 0,
  });
  manifest.accountMap.erpnext[erpUsdReceivable.name] = "AR";
  saveJson(manifestPath, manifest);

  const invoiceId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, due_date, currency, fx_rate, status,
       subtotal, tax_total, total, is_final_invoice, custom, extra_dims,
       created_by, updated_by)
    values
      (${invoiceId}, ${manifest.openbooks.orgId}, 'customer_invoice',
       ${`PARITY-FX-INV-${marker}`}, ${manifest.openbooks.customerId},
       ${manifest.openbooks.subsidiaryId}, '2026-07-15', '2026-07-15',
       '2026-07-30', 'USD', 1.25, 'draft', 100, 0, 100, false,
       '{}'::jsonb, '{}'::jsonb, ${manifest.openbooks.actorId},
       ${manifest.openbooks.actorId})
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price,
       amount, tax_amount, tax_input_amount, tax_overridden, is_billable,
       quantity_fulfilled, quantity_billed, custom, extra_dims,
       created_by, updated_by)
    values
      (${manifest.openbooks.orgId}, ${invoiceId}, 1,
       ${manifest.openbooks.accounts.revenue}, 1, 100, 100, 0, 100, false,
       false, 0, 0, '{}'::jsonb, '{}'::jsonb,
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);
  const invoiceDraft = await one<{ status: string; line_count: number }>(sql`
    select d.status, count(line.id)::int as line_count
      from documents d
      left join document_lines line
        on line.org_id = d.org_id and line.document_id = d.id
     where d.org_id = ${manifest.openbooks.orgId}
       and d.id = ${invoiceId}
     group by d.status
  `);
  if (invoiceDraft.status !== "draft" || invoiceDraft.line_count !== 1) {
    throw new Error(
      "FX settlement invoice lines must be inserted while the document is draft",
    );
  }
  await approveAndPost(manifest, invoiceId);

  const erpInvoice = await client.create<{ name: string }>("Sales Invoice", {
    company: manifest.erpnext.company,
    customer: manifest.erpnext.customer,
    set_posting_time: 1,
    posting_date: "2026-07-15",
    due_date: "2026-07-30",
    currency: "USD",
    conversion_rate: 1.25,
    plc_conversion_rate: 1.25,
    disable_rounded_total: 1,
    debit_to: erpUsdReceivable.name,
    items: [
      {
        item_code: manifest.erpnext.serviceItem,
        qty: 1,
        rate: 100,
        income_account: manifest.erpnext.accounts.revenue,
        cost_center: manifest.erpnext.costCenter,
      },
    ],
  });
  await client.submit("Sales Invoice", erpInvoice.name);
  assertComparison(
    `fx-settlement-${marker}-invoice`,
    await openbooksVoucherSnapshot(manifest, invoiceId, "invoice", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Sales Invoice",
      erpInvoice.name,
      "invoice",
      { includeControlParty: true },
    ),
  );

  const payments: Array<{
    openbooksId: string;
    erpnextName: string;
    amount: string;
    expectedOutstanding: string;
    label: string;
  }> = [];
  for (const paymentCase of [
    {
      label: "partial",
      date: "2026-07-20",
      foreignAmount: "40",
      baseAmount: "52",
      rate: "1.30",
      expectedOutstanding: "60",
      expectedBaseOutstanding: "75",
    },
    {
      label: "final",
      date: "2026-07-25",
      foreignAmount: "60",
      baseAmount: "72",
      rate: "1.20",
      expectedOutstanding: "0",
      expectedBaseOutstanding: "0",
    },
  ]) {
    const targetLineId = await openItemLineId(invoiceId);
    const payment = await createPaymentDocument({
      orgId: manifest.openbooks.orgId,
      kind: "customer_payment",
      createdBy: manifest.openbooks.actorId,
      partyId: manifest.openbooks.customerId,
      bankAccountId: manifest.openbooks.accounts.bank,
      subsidiaryId: manifest.openbooks.subsidiaryId,
      documentDate: paymentCase.date,
      currency: "USD",
      fxRate: paymentCase.rate,
      memo: `FX ${paymentCase.label} settlement ${marker}`,
    });
    const allocation = sameCurrencyAllocation(
      targetLineId,
      paymentCase.foreignAmount,
    );
    await updateDraftPayment(
      payment.id,
      {
        allocations: [allocation],
        bankAccountId: manifest.openbooks.accounts.bank,
        referenceNumber: `FX-${paymentCase.label}-${marker}`,
      },
      manifest.openbooks.actorId,
      manifest.openbooks.orgId,
    );
    await db.execute(sql`
      update documents
         set status = 'approved', submitted_by = ${manifest.openbooks.actorId},
             submitted_at = now(), updated_by = ${manifest.openbooks.actorId}
       where id = ${payment.id}
    `);
    await postPaymentWithApplications(
      payment.id,
      [allocation],
      manifest.openbooks.actorId,
    );

    const suggested = await client.call<Record<string, unknown>>(
      "erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry",
      {
        dt: "Sales Invoice",
        dn: erpInvoice.name,
        party_amount: Number(paymentCase.foreignAmount),
        bank_account: manifest.erpnext.accounts.bank,
        bank_amount: Number(paymentCase.baseAmount),
        reference_date: paymentCase.date,
      },
    );
    const {
      name: _name,
      owner: _owner,
      creation: _creation,
      modified: _modified,
      modified_by: _modifiedBy,
      docstatus: _docstatus,
      doctype: _doctype,
      ...paymentPayload
    } = suggested;
    const partyCarryingBase = Number(paymentCase.foreignAmount) * 1.25;
    const realizedDifference =
      partyCarryingBase - Number(paymentCase.baseAmount);
    const erpPayment = await client.create<{ name: string }>("Payment Entry", {
      ...paymentPayload,
      posting_date: paymentCase.date,
      reference_date: paymentCase.date,
      reference_no: `FX-${paymentCase.label}-${marker}`,
      // The party leg is consumed at the invoice's retained historical rate.
      // The bank amount is the settlement advice; their difference is explicit
      // realized FX instead of silently revaluing the remaining receivable.
      source_exchange_rate: 1.25,
      target_exchange_rate: 1,
      paid_amount: Number(paymentCase.foreignAmount),
      received_amount: Number(paymentCase.baseAmount),
      deductions:
        realizedDifference === 0
          ? []
          : [
              {
                account: manifest.erpnext.accounts.fxGainLoss,
                cost_center: manifest.erpnext.costCenter,
                amount: realizedDifference,
                is_exchange_gain_loss: 1,
              },
            ],
    });
    await client.submit("Payment Entry", erpPayment.name);
    assertComparison(
      `fx-settlement-${marker}-${paymentCase.label}-post`,
      await openbooksVoucherSnapshot(
        manifest,
        payment.id,
        `${paymentCase.label}-post`,
        { includeControlParty: true },
      ),
      await erpVoucherSnapshot(
        client,
        manifest,
        "Payment Entry",
        erpPayment.name,
        `${paymentCase.label}-post`,
        { includeControlParty: true },
      ),
    );
    await assertForeignOutstanding(client, manifest, {
      checkpoint: `fx-settlement-${marker}-${paymentCase.label}`,
      openbooksDocumentId: invoiceId,
      erpnextName: erpInvoice.name,
      expectedTransaction: paymentCase.expectedOutstanding,
      expectedBase: paymentCase.expectedBaseOutstanding,
    });
    payments.push({
      openbooksId: payment.id,
      erpnextName: erpPayment.name,
      amount: paymentCase.foreignAmount,
      expectedOutstanding: paymentCase.expectedOutstanding,
      label: paymentCase.label,
    });
  }

  for (const [index, payment] of [...payments].reverse().entries()) {
    await reversePaymentForReturn(
      payment.openbooksId,
      manifest.openbooks.orgId,
      "ERPNext differential FX payment cancellation",
      manifest.openbooks.actorId,
      index === 0 ? "2026-07-25" : "2026-07-20",
    );
    await client.cancel("Payment Entry", payment.erpnextName);
    assertComparison(
      `fx-settlement-${marker}-${payment.label}-cancel`,
      await openbooksVoucherSnapshot(
        manifest,
        payment.openbooksId,
        `${payment.label}-cancel`,
        { includeControlParty: true },
      ),
      await erpVoucherSnapshot(
        client,
        manifest,
        "Payment Entry",
        payment.erpnextName,
        `${payment.label}-cancel`,
        { includeControlParty: true },
      ),
    );
    await assertForeignOutstanding(client, manifest, {
      checkpoint: `fx-settlement-${marker}-${payment.label}-cancel`,
      openbooksDocumentId: invoiceId,
      erpnextName: erpInvoice.name,
      expectedTransaction: index === 0 ? "60" : "100",
      expectedBase: index === 0 ? "75" : "125",
    });
  }
  await requestDocumentVoid({
    documentId: invoiceId,
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    reason: "ERPNext differential FX invoice cleanup",
    reversalDate: "2026-07-30",
    source: "api",
  });
  await client.cancel("Sales Invoice", erpInvoice.name);
  assertComparison(
    `fx-settlement-${marker}-invoice-cancel`,
    await openbooksVoucherSnapshot(manifest, invoiceId, "invoice-cancel", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Sales Invoice",
      erpInvoice.name,
      "invoice-cancel",
      { includeControlParty: true },
    ),
  );
}

async function runRevenueRecognitionParity(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);

  manifest.accountMap.openbooks[manifest.openbooks.accounts.recognized!] =
    "REVENUE";
  const erpAccounts = await client.list<{
    name: string;
    account_number: string | null;
    root_type: string;
    is_group: number;
  }>(
    "Account",
    ["name", "account_number", "root_type", "is_group"],
    [["company", "=", manifest.erpnext.company]],
    "name asc",
    500,
  );
  const currentLiabilities = erpAccounts.find(
    (account) =>
      account.account_number === "2100-2400" && account.is_group === 1,
  )?.name;
  if (!currentLiabilities) {
    throw new Error("ERPNext has no current-liabilities account group");
  }
  const erpDeferred = await client.create<{ name: string }>("Account", {
    account_name: `Parity Deferred Revenue ${marker}`,
    company: manifest.erpnext.company,
    parent_account: currentLiabilities,
    root_type: "Liability",
    report_type: "Balance Sheet",
    is_group: 0,
  });
  manifest.accountMap.erpnext[erpDeferred.name] = "DEFERRED_REVENUE";
  saveJson(manifestPath, manifest);

  await client.update("Accounts Settings", "Accounts Settings", {
    book_deferred_entries_based_on: "Months",
    book_deferred_entries_via_journal_entry: 0,
    submit_journal_entries: 0,
  });
  const templateItem = await client.get<{
    item_group: string;
    stock_uom: string;
  }>("Item", manifest.erpnext.serviceItem);
  const erpItem = await client.create<{ name: string }>("Item", {
    item_code: `PARITY-REV-${marker}`,
    item_name: `Parity deferred service ${marker}`,
    item_group: templateItem.item_group,
    stock_uom: templateItem.stock_uom,
    is_stock_item: 0,
    include_item_in_manufacturing: 0,
    enable_deferred_revenue: 1,
    no_of_months: 3,
    deferred_revenue_account: erpDeferred.name,
    item_defaults: [
      {
        company: manifest.erpnext.company,
        income_account: manifest.erpnext.accounts.revenue,
        deferred_revenue_account: erpDeferred.name,
      },
    ],
  });

  const recognitionRuleId = randomUUID();
  const itemId = randomUUID();
  await db.execute(sql`
    insert into recognition_rules
      (id, org_id, code, name, method, is_forecast, recognition_periods,
       start_date_source, end_date_source, period_offset, start_offset_days,
       initial_amount_percent, deferred_account_id, recognized_account_id,
       is_active, created_by, updated_by)
    values
      (${recognitionRuleId}, ${manifest.openbooks.orgId},
       ${`PARITY-REV-${marker}`}, ${`Parity revenue ${marker}`},
       'straight_line_even', false, 3, 'obligation', 'term', 0, 0, 0,
       ${manifest.openbooks.accounts.deferred},
       ${manifest.openbooks.accounts.recognized}, true,
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);
  await db.execute(sql`
    insert into items
      (id, org_id, kind, name, show_on_timesheet, is_active, custom,
       create_plans_on, revenue_allocation, income_account_id,
       recognition_rule_id, deferred_account_id, created_by, updated_by)
    values
      (${itemId}, ${manifest.openbooks.orgId}, 'service',
       ${`Parity deferred service ${marker}`}, false, true, '{}'::jsonb,
       'billing', 'normal', ${manifest.openbooks.accounts.recognized},
       ${recognitionRuleId}, ${manifest.openbooks.accounts.deferred},
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);

  const invoiceId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, due_date, currency, fx_rate, status,
       subtotal, tax_total, total, is_final_invoice, custom, extra_dims,
       created_by, updated_by)
    values
      (${invoiceId}, ${manifest.openbooks.orgId}, 'customer_invoice',
       ${`PARITY-REV-INV-${marker}`}, ${manifest.openbooks.customerId},
       ${manifest.openbooks.subsidiaryId}, '2026-07-01', '2026-07-01',
       '2026-07-31', 'CAD', 1, 'draft', 300, 0, 300, false,
       '{}'::jsonb, '{}'::jsonb, ${manifest.openbooks.actorId},
       ${manifest.openbooks.actorId})
  `);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, quantity,
       unit_price, amount, tax_amount, tax_input_amount, tax_overridden,
       is_billable, quantity_fulfilled, quantity_billed, custom, extra_dims,
       created_by, updated_by)
    values
      (${randomUUID()}, ${manifest.openbooks.orgId}, ${invoiceId}, 1,
       ${itemId}, ${manifest.openbooks.accounts.recognized}, 1, 300, 300, 0,
       300, false, false, 0, 0,
       '{"recognitionStartsOn":"2026-07-01","recognitionEndsOn":"2026-09-30"}'::jsonb,
       '{}'::jsonb, ${manifest.openbooks.actorId},
       ${manifest.openbooks.actorId})
  `);
  const erpInvoice = await client.create<{ name: string }>("Sales Invoice", {
    company: manifest.erpnext.company,
    customer: manifest.erpnext.customer,
    set_posting_time: 1,
    posting_date: "2026-07-01",
    due_date: "2026-07-31",
    currency: "CAD",
    disable_rounded_total: 1,
    debit_to: manifest.erpnext.accounts.ar,
    items: [
      {
        item_code: erpItem.name,
        qty: 1,
        rate: 300,
        income_account: manifest.erpnext.accounts.revenue,
        cost_center: manifest.erpnext.costCenter,
        enable_deferred_revenue: 1,
        deferred_revenue_account: erpDeferred.name,
        service_start_date: "2026-07-01",
        service_end_date: "2026-09-30",
      },
    ],
  });
  assertComparison(
    `revenue-recognition-${marker}-invoice-draft`,
    await openbooksVoucherSnapshot(manifest, invoiceId, "invoice-draft", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Sales Invoice",
      erpInvoice.name,
      "invoice-draft",
      { includeControlParty: true },
    ),
  );
  await db
    .update(schema.documents)
    .set({ status: "approved", updatedBy: manifest.openbooks.actorId })
    .where(eq(schema.documents.id, invoiceId));
  await postDocument(invoiceId, {
    control: {
      ar: manifest.openbooks.accounts.ar!,
      ap: manifest.openbooks.accounts.ap!,
      bank: manifest.openbooks.accounts.bank!,
    },
  });
  await client.submit("Sales Invoice", erpInvoice.name);
  assertComparison(
    `revenue-recognition-${marker}-invoice-submit`,
    await openbooksVoucherSnapshot(manifest, invoiceId, "invoice-submit", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Sales Invoice",
      erpInvoice.name,
      "invoice-submit",
      { includeControlParty: true },
    ),
  );

  const obligation = (await db.execute<{ id: string }>(sql`
    select obligation.id
      from performance_obligations obligation
      join document_lines line on line.id = obligation.document_line_id
     where line.document_id = ${invoiceId}
     limit 1
  `));
  const obligationId = obligation.rows[0]?.id;
  if (!obligationId) {
    throw new Error("OpenBooks did not create a performance obligation");
  }
  const schedule = (await db.execute<{ period_start: string; planned: string }>(sql`
    select period.starts_on::text as period_start,
           line.planned_amount::text as planned
      from recognition_schedule_lines line
      join recognition_schedules schedule on schedule.id = line.schedule_id
      join accounting_periods period on period.id = line.period_id
     where schedule.obligation_id = ${obligationId}
     order by line.sequence
  `));
  const expectedSchedule = [
    { period_start: "2026-07-01", planned: "100.0000" },
    { period_start: "2026-08-01", planned: "100.0000" },
    { period_start: "2026-09-01", planned: "100.0000" },
  ];
  const scheduleOk =
    JSON.stringify(schedule.rows) === JSON.stringify(expectedSchedule);
  saveJson(
    join(
      evidenceDir,
      `revenue-recognition-${marker}-schedule-construction.json`,
    ),
    {
      checkpoint: `revenue-recognition-${marker}-schedule-construction`,
      openbooks: schedule.rows,
      erpnextPolicy: {
        basis: "Months",
        serviceStart: "2026-07-01",
        serviceEnd: "2026-09-30",
        total: "300.0000",
      },
      expected: expectedSchedule,
      comparison: { ok: scheduleOk },
    },
  );
  if (!scheduleOk) throw new Error("revenue-recognition schedule mismatch");
  console.log(`PASS revenue-recognition-${marker}-schedule-construction`);

  const periodRuns: Array<{
    pdaName: string;
    sourceEntryId: string;
    period: string;
  }> = [];
  for (const period of [
    { label: "2026-07", start: "2026-07-01", end: "2026-07-31" },
    { label: "2026-08", start: "2026-08-01", end: "2026-08-31" },
    { label: "2026-09", start: "2026-09-01", end: "2026-09-30" },
  ]) {
    const openbooks = await runRevenueRecognition(
      manifest.openbooks.orgId,
      period.end,
      manifest.openbooks.actorId,
      obligationId,
    );
    if (openbooks.posted !== 1 || openbooks.totalAmount !== "100.0000") {
      throw new Error(
        `${period.label} OpenBooks recognition was not exactly 100.0000`,
      );
    }
    const pda = await client.create<{ name: string }>(
      "Process Deferred Accounting",
      {
        company: manifest.erpnext.company,
        type: "Income",
        account: erpDeferred.name,
        posting_date: period.end,
        start_date: period.start,
        end_date: period.end,
      },
    );
    await client.submit("Process Deferred Accounting", pda.name);
    assertComparison(
      `revenue-recognition-${marker}-${period.label}-post`,
      await openbooksEntriesSnapshot(
        manifest,
        [openbooks.entries[0]!.entryId],
        `${period.label}-post`,
      ),
      await erpGlSnapshot(
        client,
        manifest,
        [
          ["against_voucher_type", "=", "Process Deferred Accounting"],
          ["against_voucher", "=", pda.name],
        ],
        `${period.label}-post`,
      ),
    );
    periodRuns.push({
      pdaName: pda.name,
      sourceEntryId: openbooks.entries[0]!.entryId,
      period: period.label,
    });
  }

  const rerun = await runRevenueRecognition(
    manifest.openbooks.orgId,
    "2026-09-30",
    manifest.openbooks.actorId,
    obligationId,
  );
  if (rerun.posted !== 0 || rerun.totalAmount !== "0") {
    throw new Error("OpenBooks revenue recognition rerun was not idempotent");
  }
  saveJson(
    join(evidenceDir, `revenue-recognition-${marker}-idempotency.json`),
    {
      checkpoint: `revenue-recognition-${marker}-idempotency`,
      openbooks: rerun,
      comparison: { ok: true },
    },
  );
  console.log(`PASS revenue-recognition-${marker}-idempotency`);

  const creditId = await createOpenBooksDocumentDraft(manifest, {
    kind: "customer_credit",
    marker: `${marker}-RECOGNIZED`,
    partyId: manifest.openbooks.customerId,
    accountId: manifest.openbooks.accounts.recognized!,
    amount: "300.00",
  });
  const erpCredit = await client.create<{ name: string }>("Sales Invoice", {
    company: manifest.erpnext.company,
    customer: manifest.erpnext.customer,
    set_posting_time: 1,
    posting_date: "2026-09-30",
    due_date: "2026-09-30",
    currency: "CAD",
    debit_to: manifest.erpnext.accounts.ar,
    is_return: 1,
    return_against: erpInvoice.name,
    disable_rounded_total: 1,
    items: [
      {
        item_code: erpItem.name,
        qty: -1,
        rate: 300,
        income_account: manifest.erpnext.accounts.revenue,
        cost_center: manifest.erpnext.costCenter,
      },
    ],
  });
  assertComparison(
    `revenue-recognition-${marker}-credit-draft`,
    await openbooksVoucherSnapshot(manifest, creditId, "credit-draft", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Sales Invoice",
      erpCredit.name,
      "credit-draft",
      { includeControlParty: true },
    ),
  );
  await approveAndPost(manifest, creditId);
  await client.submit("Sales Invoice", erpCredit.name);
  assertComparison(
    `revenue-recognition-${marker}-credit-submit`,
    await openbooksVoucherSnapshot(manifest, creditId, "credit-submit", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Sales Invoice",
      erpCredit.name,
      "credit-submit",
      { includeControlParty: true },
    ),
  );
  await requestDocumentVoid({
    documentId: creditId,
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    reason: "ERPNext differential deferred-revenue credit cancellation",
    reversalDate: "2026-09-30",
    source: "api",
  });
  await client.cancel("Sales Invoice", erpCredit.name);
  assertComparison(
    `revenue-recognition-${marker}-credit-cancel`,
    await openbooksVoucherSnapshot(manifest, creditId, "credit-cancel", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Sales Invoice",
      erpCredit.name,
      "credit-cancel",
      { includeControlParty: true },
    ),
  );

  const cancelled = await cancelRevenueRecognitionForInvoice({
    documentId: invoiceId,
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    reason: "ERPNext differential deferred-revenue contract cancellation",
    reversalDate: "2026-09-30",
  });
  if (cancelled.status !== "cancelled") {
    throw new Error("OpenBooks revenue cancellation unexpectedly needs approval");
  }
  for (const period of [...periodRuns].reverse()) {
    await client.cancel("Process Deferred Accounting", period.pdaName);
  }
  const recognitionReversals = (await db.execute<{
      journal_entry_id: string;
      reversal_journal_entry_id: string;
    }>(sql`
    select line.journal_entry_id, line.reversal_journal_entry_id
      from recognition_schedule_lines line
      join recognition_schedules schedule on schedule.id = line.schedule_id
     where schedule.obligation_id = ${obligationId}
       and line.journal_entry_id is not null
  `));
  const reversalBySource = new Map(
    recognitionReversals.rows.map((row) => [
      row.journal_entry_id,
      row.reversal_journal_entry_id,
    ]),
  );
  for (const period of periodRuns) {
    assertComparison(
      `revenue-recognition-${marker}-${period.period}-cancel`,
      await openbooksEntriesSnapshot(
        manifest,
        [
          period.sourceEntryId,
          reversalBySource.get(period.sourceEntryId) ?? null,
        ],
        `${period.period}-cancel`,
      ),
      await erpGlSnapshot(
        client,
        manifest,
        [
          ["against_voucher_type", "=", "Process Deferred Accounting"],
          ["against_voucher", "=", period.pdaName],
        ],
        `${period.period}-cancel`,
      ),
    );
  }
  await client.cancel("Sales Invoice", erpInvoice.name);
  assertComparison(
    `revenue-recognition-${marker}-invoice-cancel`,
    await openbooksVoucherSnapshot(manifest, invoiceId, "invoice-cancel", {
      includeControlParty: true,
    }),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Sales Invoice",
      erpInvoice.name,
      "invoice-cancel",
      { includeControlParty: true },
    ),
  );
  const cancellationRetry = await cancelRevenueRecognitionForInvoice({
    documentId: invoiceId,
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    reason: "ERPNext differential deferred-revenue contract cancellation",
    reversalDate: "2026-09-30",
  });
  const cancellationIdempotent =
    cancellationRetry.invoiceReversalEntryId ===
      cancelled.invoiceReversalEntryId &&
    JSON.stringify(
      [...cancellationRetry.recognitionReversalEntryIds].sort(),
    ) ===
      JSON.stringify([...cancelled.recognitionReversalEntryIds].sort());
  saveJson(
    join(
      evidenceDir,
      `revenue-recognition-${marker}-cancellation-idempotency.json`,
    ),
    {
      checkpoint: `revenue-recognition-${marker}-cancellation-idempotency`,
      first: cancelled,
      retry: cancellationRetry,
      comparison: { ok: cancellationIdempotent },
    },
  );
  if (!cancellationIdempotent) {
    throw new Error("revenue-recognition cancellation was not idempotent");
  }
  console.log(
    `PASS revenue-recognition-${marker}-cancellation-idempotency`,
  );
}

async function runProjectRecognitionParity(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  if (!manifest.openbooks.projectId || !manifest.erpnext.project) {
    throw new Error("project parity fixtures are not provisioned");
  }

  const erpAccounts = await client.list<{
    name: string;
    account_number: string | null;
    is_group: number;
  }>(
    "Account",
    ["name", "account_number", "is_group"],
    [["company", "=", manifest.erpnext.company]],
    "name asc",
    500,
  );
  const currentAssets = erpAccounts.find(
    (account) =>
      account.account_number === "1100-1600" && account.is_group === 1,
  )?.name;
  const currentLiabilities = erpAccounts.find(
    (account) =>
      account.account_number === "2100-2400" && account.is_group === 1,
  )?.name;
  if (!currentAssets || !currentLiabilities) {
    throw new Error("ERPNext project parity account parents are missing");
  }
  const erpLaborWip = await client.create<{ name: string }>("Account", {
    account_name: `Parity Labor WIP ${marker}`,
    company: manifest.erpnext.company,
    parent_account: currentAssets,
    root_type: "Asset",
    report_type: "Balance Sheet",
    is_group: 0,
  });
  const erpLaborClearing = await client.create<{ name: string }>("Account", {
    account_name: `Parity Labor Clearing ${marker}`,
    company: manifest.erpnext.company,
    parent_account: currentLiabilities,
    root_type: "Liability",
    report_type: "Balance Sheet",
    is_group: 0,
  });
  const equipmentRecoveryId = randomUUID();
  await db.execute(sql`
    insert into accounts
      (id, org_id, number, name, type, is_summary, is_active, eliminate,
       reconcilable, required_dimensions, custom, subsidiary_include_children,
       created_by, updated_by)
    values
      (${equipmentRecoveryId}, ${manifest.openbooks.orgId},
       ${`49${marker.slice(-7)}`}, ${`Equipment recovery ${marker}`},
       'income_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb,
       true, ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);

  manifest.accountMap.openbooks[manifest.openbooks.accounts.invAsset!] =
    "LABOR_WIP";
  manifest.accountMap.openbooks[manifest.openbooks.accounts.clearing!] =
    "LABOR_CLEARING";
  manifest.accountMap.openbooks[manifest.openbooks.accounts.adjustment!] =
    "OVERHEAD";
  manifest.accountMap.erpnext[erpLaborWip.name] = "LABOR_WIP";
  manifest.accountMap.erpnext[erpLaborClearing.name] = "LABOR_CLEARING";
  manifest.accountMap.erpnext[manifest.erpnext.accounts.expense!] = "OVERHEAD";
  manifest.accountMap.openbooks[manifest.openbooks.accounts.cogs!] =
    "EQUIPMENT_COST";
  manifest.accountMap.openbooks[equipmentRecoveryId] = "EQUIPMENT_RECOVERY";
  manifest.accountMap.erpnext[manifest.erpnext.accounts.cogs!] =
    "EQUIPMENT_COST";
  manifest.accountMap.erpnext[manifest.erpnext.accounts.revenue!] =
    "EQUIPMENT_RECOVERY";
  saveJson(manifestPath, manifest);

  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         jsonb_set(
           settings,
           '{controlAccounts}',
             coalesce(settings->'controlAccounts', '{}'::jsonb)
             || jsonb_build_object(
               'laborWip', ${manifest.openbooks.accounts.invAsset}::text,
               'laborClearing', ${manifest.openbooks.accounts.clearing}::text
             ),
           true
         ),
         '{overheadApplication}',
         jsonb_build_object(
           'mode', 'net_zero_pair',
           'accountId', ${manifest.openbooks.accounts.adjustment}::text
         ),
         true
       ),
       updated_at = now(), updated_by = ${manifest.openbooks.actorId}
     where id = ${manifest.openbooks.orgId}
  `);

  const employeeId = randomUUID();
  const departmentId = randomUUID();
  const timeEntryIds = [randomUUID(), randomUUID()];
  await db.execute(sql`
    insert into parties
      (id, org_id, kind, display_name, subsidiary_id, is_active, custom,
       created_by, updated_by)
    values
      (${employeeId}, ${manifest.openbooks.orgId}, 'employee',
       ${`Parity project worker ${marker}`},
       ${manifest.openbooks.subsidiaryId}, true, '{}'::jsonb,
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);
  await db.execute(sql`
    insert into departments
      (id, org_id, code, name, is_active, subsidiary_id,
       subsidiary_include_children, custom, created_by, updated_by)
    values
      (${departmentId}, ${manifest.openbooks.orgId},
       ${`PARITY-${marker.slice(-8)}`}, ${`Parity labor ${marker}`}, true,
       ${manifest.openbooks.subsidiaryId}, true, '{}'::jsonb,
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);
  await db.execute(sql`
    insert into overhead_rates
      (id, org_id, department_id, method, rate_kind, rate_percent,
       effective_from, effective_to, created_by, updated_by)
    values
      (${randomUUID()}, ${manifest.openbooks.orgId}, ${departmentId},
       'standard', 'per_hour', 12.5, '2026-07-15', '2026-07-15',
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);
  await db.execute(sql`
    insert into time_entries
      (id, org_id, employee_party_id, worked_on, hours, project_id,
       department_id, status, cost_rate, cost_rate_currency,
       cost_rate_subsidiary_id, costing_basis, is_billable, custom,
       created_by, updated_by)
    values
      (${timeEntryIds[0]}, ${manifest.openbooks.orgId}, ${employeeId},
       '2026-07-15', 2, ${manifest.openbooks.projectId}, ${departmentId},
       'approved', 25, 'CAD', ${manifest.openbooks.subsidiaryId}, 'actual',
       true, '{}'::jsonb, ${manifest.openbooks.actorId},
       ${manifest.openbooks.actorId}),
      (${timeEntryIds[1]}, ${manifest.openbooks.orgId}, ${employeeId},
       '2026-07-15', 3, ${manifest.openbooks.projectId}, ${departmentId},
       'approved', 25, 'CAD', ${manifest.openbooks.subsidiaryId}, 'actual',
       true, '{}'::jsonb, ${manifest.openbooks.actorId},
       ${manifest.openbooks.actorId})
  `);

  const laborRace = await Promise.all([
    postProjectLaborCost(
      manifest.openbooks.orgId,
      manifest.openbooks.actorId,
      timeEntryIds,
    ),
    postProjectLaborCost(
      manifest.openbooks.orgId,
      manifest.openbooks.actorId,
      timeEntryIds,
    ),
  ]);
  const laborEntries = laborRace.flat();
  if (
    laborEntries.length !== 1 ||
    laborRace.map((result) => result.length).sort().join(",") !== "0,1"
  ) {
    throw new Error("project labor source claim was not exactly once");
  }
  const laborEntryId = laborEntries[0]!;
  const erpLabor = await client.create<{ name: string }>("Journal Entry", {
    company: manifest.erpnext.company,
    voucher_type: "Journal Entry",
    posting_date: "2026-07-15",
    user_remark: `Parity project labor ${marker}`,
    accounts: [
      {
        account: erpLaborWip.name,
        debit_in_account_currency: 125,
        project: manifest.erpnext.project,
        cost_center: manifest.erpnext.costCenter,
      },
      {
        account: erpLaborClearing.name,
        credit_in_account_currency: 125,
      },
    ],
  });
  await client.submit("Journal Entry", erpLabor.name);
  assertComparison(
    `project-recognition-${marker}-labor-post`,
    await openbooksEntriesSnapshot(
      manifest,
      [laborEntryId],
      "labor-post",
      { includeProject: true },
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpLabor.name,
      "labor-post",
      { includeProject: true },
    ),
  );

  const overheadRace = await Promise.all([
    applyOverheadForTime(
      manifest.openbooks.orgId,
      manifest.openbooks.actorId,
      timeEntryIds,
    ),
    applyOverheadForTime(
      manifest.openbooks.orgId,
      manifest.openbooks.actorId,
      timeEntryIds,
    ),
  ]);
  const overheadPosted = overheadRace.filter((result) => result.entryId);
  if (
    overheadPosted.length !== 1 ||
    overheadPosted[0]!.total !== "62.5000"
  ) {
    throw new Error("project overhead source claim was not exactly once");
  }
  const overheadEntryId = overheadPosted[0]!.entryId!;
  const erpOverhead = await client.create<{ name: string }>("Journal Entry", {
    company: manifest.erpnext.company,
    voucher_type: "Journal Entry",
    posting_date: "2026-07-15",
    user_remark: `Parity project overhead ${marker}`,
    accounts: [
      {
        account: manifest.erpnext.accounts.expense,
        debit_in_account_currency: 62.5,
        project: manifest.erpnext.project,
        cost_center: manifest.erpnext.costCenter,
      },
      {
        account: manifest.erpnext.accounts.expense,
        credit_in_account_currency: 62.5,
        cost_center: manifest.erpnext.costCenter,
      },
    ],
  });
  await client.submit("Journal Entry", erpOverhead.name);
  assertComparison(
    `project-recognition-${marker}-overhead-post`,
    await openbooksEntriesSnapshot(
      manifest,
      [overheadEntryId],
      "overhead-post",
      { includeProject: true },
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpOverhead.name,
      "overhead-post",
      { includeProject: true },
    ),
  );

  const directEntryId = await postProjectGlEntry({
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    origin: "manual",
    entryNumber: `PARITY-PROJECT-RECLASS-${marker}`,
    postingDate: "2026-07-15",
    memo: "Project cost dimensional reclassification",
    subsidiaryId: manifest.openbooks.subsidiaryId,
    currency: "CAD",
    lines: [
      {
        accountId: manifest.openbooks.accounts.adjustment!,
        amount: "50",
        projectId: manifest.openbooks.projectId,
      },
      {
        accountId: manifest.openbooks.accounts.adjustment!,
        amount: "-50",
      },
    ],
  });
  if (!directEntryId) throw new Error("direct project reclass did not post");
  const erpDirect = await client.create<{ name: string }>("Journal Entry", {
    company: manifest.erpnext.company,
    voucher_type: "Journal Entry",
    posting_date: "2026-07-15",
    user_remark: `Parity project reclass ${marker}`,
    accounts: [
      {
        account: manifest.erpnext.accounts.expense,
        debit_in_account_currency: 50,
        project: manifest.erpnext.project,
        cost_center: manifest.erpnext.costCenter,
      },
      {
        account: manifest.erpnext.accounts.expense,
        credit_in_account_currency: 50,
        cost_center: manifest.erpnext.costCenter,
      },
    ],
  });
  await client.submit("Journal Entry", erpDirect.name);
  assertComparison(
    `project-recognition-${marker}-direct-reclass-post`,
    await openbooksEntriesSnapshot(
      manifest,
      [directEntryId],
      "direct-reclass-post",
      { includeProject: true },
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpDirect.name,
      "direct-reclass-post",
      { includeProject: true },
    ),
  );

  const equipmentItemId = randomUUID();
  const equipmentUnitId = randomUUID();
  const equipmentDocumentId = randomUUID();
  await db.execute(sql`
    insert into items
      (id, org_id, kind, code, name, default_cost, default_rate,
       expense_account_id, cost_recovery_account_id, income_account_id,
       is_active, custom, created_by, updated_by)
    values
      (${equipmentItemId}, ${manifest.openbooks.orgId}, 'equipment_charge',
       ${`EQ-${marker.slice(-8)}`}, ${`Parity equipment ${marker}`},
       75.25, 100, ${manifest.openbooks.accounts.cogs},
       ${equipmentRecoveryId}, ${manifest.openbooks.accounts.revenue},
       true, '{}'::jsonb, ${manifest.openbooks.actorId},
       ${manifest.openbooks.actorId})
  `);
  await db.execute(sql`
    insert into equipment_units
      (id, org_id, subsidiary_id, unit_number, name, status, charge_item_id,
       purchase_price, created_by, updated_by)
    values
      (${equipmentUnitId}, ${manifest.openbooks.orgId},
       ${manifest.openbooks.subsidiaryId}, ${`EQ-${marker.slice(-8)}`},
       ${`Parity equipment unit ${marker}`}, 'active', ${equipmentItemId},
       75000, ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, document_date, posting_date,
       currency, status, project_id, subsidiary_id, subtotal, tax_total,
       total, custom, extra_dims, created_by, updated_by)
    values
      (${equipmentDocumentId}, ${manifest.openbooks.orgId}, 'project_charge',
       ${`PARITY-EQUIPMENT-${marker}`}, '2026-07-15', '2026-07-15', 'CAD',
       'approved', ${manifest.openbooks.projectId},
       ${manifest.openbooks.subsidiaryId}, 75.25, 0, 75.25,
       '{}'::jsonb, '{}'::jsonb, ${manifest.openbooks.actorId},
       ${manifest.openbooks.actorId})
  `);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, amount, project_id, equipment_unit_id, recovery_account_id,
       cost_rate, bill_rate, cost_amount, bill_amount, is_billable, custom,
       extra_dims, created_by, updated_by)
    values
      (${randomUUID()}, ${manifest.openbooks.orgId}, ${equipmentDocumentId}, 1,
       ${equipmentItemId}, ${manifest.openbooks.accounts.cogs},
       'Parity equipment usage', 1, 75.25, ${manifest.openbooks.projectId},
       ${equipmentUnitId}, ${equipmentRecoveryId}, 75.25, 100, 75.25, 100,
       true, '{}'::jsonb, '{}'::jsonb, ${manifest.openbooks.actorId},
       ${manifest.openbooks.actorId})
  `);
  await postDocument(equipmentDocumentId, {
    control: {
      ar: manifest.openbooks.accounts.ar!,
      ap: manifest.openbooks.accounts.ap!,
      bank: manifest.openbooks.accounts.bank!,
    },
  });
  const erpEquipment = await client.create<{ name: string }>("Journal Entry", {
    company: manifest.erpnext.company,
    voucher_type: "Journal Entry",
    posting_date: "2026-07-15",
    user_remark: `Parity equipment usage ${marker}`,
    accounts: [
      {
        account: manifest.erpnext.accounts.cogs,
        debit_in_account_currency: 75.25,
        project: manifest.erpnext.project,
        cost_center: manifest.erpnext.costCenter,
      },
      {
        account: manifest.erpnext.accounts.revenue,
        credit_in_account_currency: 75.25,
        cost_center: manifest.erpnext.costCenter,
      },
    ],
  });
  await client.submit("Journal Entry", erpEquipment.name);
  assertComparison(
    `project-recognition-${marker}-equipment-post`,
    await openbooksVoucherSnapshot(
      manifest,
      equipmentDocumentId,
      "equipment-post",
      { includeProject: true },
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpEquipment.name,
      "equipment-post",
      { includeProject: true },
    ),
  );

  const idempotentLabor = await postProjectLaborCost(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    timeEntryIds,
  );
  const idempotentOverhead = await applyOverheadForTime(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    timeEntryIds,
  );
  const idempotencyOk =
    idempotentLabor.length === 0 && idempotentOverhead.entryId === null;
  saveJson(
    join(evidenceDir, `project-recognition-${marker}-idempotency.json`),
    {
      checkpoint: `project-recognition-${marker}-idempotency`,
      labor: idempotentLabor,
      overhead: idempotentOverhead,
      comparison: { ok: idempotencyOk },
    },
  );
  if (!idempotencyOk) {
    throw new Error("project cost posting was not idempotent");
  }
  console.log(`PASS project-recognition-${marker}-idempotency`);

  const directReversal = await reverseProjectGlEntry(
    manifest.openbooks.orgId,
    manifest.openbooks.actorId,
    directEntryId,
    "ERPNext differential project reclass cancellation",
    "2026-07-15",
  );
  await client.cancel("Journal Entry", erpDirect.name);
  assertComparison(
    `project-recognition-${marker}-direct-reclass-cancel`,
    await openbooksEntriesSnapshot(
      manifest,
      [directEntryId, directReversal],
      "direct-reclass-cancel",
      { includeProject: true },
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpDirect.name,
      "direct-reclass-cancel",
      { includeProject: true },
    ),
  );

  await Promise.all([
    reverseProjectLaborCost(
      manifest.openbooks.orgId,
      manifest.openbooks.actorId,
      [timeEntryIds[0]!],
      "ERPNext differential project labor cancellation",
      "2026-07-15",
    ),
    reverseProjectLaborCost(
      manifest.openbooks.orgId,
      manifest.openbooks.actorId,
      [timeEntryIds[1]!],
      "ERPNext differential project labor cancellation",
      "2026-07-15",
    ),
  ]);
  await client.cancel("Journal Entry", erpLabor.name);
  const laborReversal = (await db.execute<{ id: string }>(sql`
    select id from journal_entries
     where org_id = ${manifest.openbooks.orgId}
       and reverses_entry_id = ${laborEntryId}
  `));
  assertComparison(
    `project-recognition-${marker}-labor-cancel`,
    await openbooksEntriesSnapshot(
      manifest,
      [laborEntryId, laborReversal.rows[0]?.id ?? null],
      "labor-cancel",
      { includeProject: true },
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpLabor.name,
      "labor-cancel",
      { includeProject: true },
    ),
  );

  await Promise.all([
    reverseOverheadForTime(
      manifest.openbooks.orgId,
      manifest.openbooks.actorId,
      [timeEntryIds[0]!],
      "ERPNext differential project overhead cancellation",
      "2026-07-15",
    ),
    reverseOverheadForTime(
      manifest.openbooks.orgId,
      manifest.openbooks.actorId,
      [timeEntryIds[1]!],
      "ERPNext differential project overhead cancellation",
      "2026-07-15",
    ),
  ]);
  await client.cancel("Journal Entry", erpOverhead.name);
  const overheadReversal = (await db.execute<{ id: string }>(sql`
    select id from journal_entries
     where org_id = ${manifest.openbooks.orgId}
       and reverses_entry_id = ${overheadEntryId}
  `));
  assertComparison(
    `project-recognition-${marker}-overhead-cancel`,
    await openbooksEntriesSnapshot(
      manifest,
      [overheadEntryId, overheadReversal.rows[0]?.id ?? null],
      "overhead-cancel",
      { includeProject: true },
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpOverhead.name,
      "overhead-cancel",
      { includeProject: true },
    ),
  );

  await requestDocumentVoid({
    documentId: equipmentDocumentId,
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    reason: "ERPNext differential equipment charge cancellation",
    reversalDate: "2026-07-15",
    source: "api",
  });
  await client.cancel("Journal Entry", erpEquipment.name);
  assertComparison(
    `project-recognition-${marker}-equipment-cancel`,
    await openbooksVoucherSnapshot(
      manifest,
      equipmentDocumentId,
      "equipment-cancel",
      { includeProject: true },
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpEquipment.name,
      "equipment-cancel",
      { includeProject: true },
    ),
  );
  const equipmentLineage = (await db.execute<{
      reverses_entry_id: string | null;
      equipment_unit_id: string | null;
      amount: string;
    }>(sql`
    select entry.reverses_entry_id, line.equipment_unit_id,
           line.amount::text
      from journal_entries entry
      join journal_lines line on line.entry_id = entry.id
     where entry.source_document_id = ${equipmentDocumentId}
     order by entry.created_at, line.line_number
  `));
  const sourceEquipment = equipmentLineage.rows
    .filter((row) => !row.reverses_entry_id)
    .map((row) => ({
      equipment: row.equipment_unit_id,
      amount: fromUnits(toUnits(row.amount)),
    }));
  const reversedEquipment = equipmentLineage.rows
    .filter((row) => row.reverses_entry_id)
    .map((row) => ({
      equipment: row.equipment_unit_id,
      amount: fromUnits(-toUnits(row.amount)),
    }));
  const equipmentLineageOk =
    sourceEquipment.length === 2 &&
    sourceEquipment.every((row) => row.equipment === equipmentUnitId) &&
    JSON.stringify(sourceEquipment) === JSON.stringify(reversedEquipment);
  saveJson(
    join(
      evidenceDir,
      `project-recognition-${marker}-equipment-lineage.json`,
    ),
    {
      checkpoint: `project-recognition-${marker}-equipment-lineage`,
      source: sourceEquipment,
      reversal: reversedEquipment,
      comparison: { ok: equipmentLineageOk },
    },
  );
  if (!equipmentLineageOk) {
    throw new Error("equipment attribution was not preserved on reversal");
  }
  console.log(`PASS project-recognition-${marker}-equipment-lineage`);
}

async function runConsolidationParity(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const suffix = marker.slice(-5);
  const childId = randomUUID();
  const eliminationId = randomUUID();
  await db.execute(sql`
    update subsidiaries
       set is_active = false, updated_at = now(),
           updated_by = ${manifest.openbooks.actorId}
     where org_id = ${manifest.openbooks.orgId} and is_elimination
  `);
  await db.execute(sql`
    update accounts
       set eliminate = false, updated_at = now(),
           updated_by = ${manifest.openbooks.actorId}
     where org_id = ${manifest.openbooks.orgId} and eliminate
  `);
  await db.execute(sql`
    insert into subsidiaries
      (id, org_id, parent_id, name, base_currency, country, tax_ids,
       is_elimination, is_active, custom, created_by, updated_by)
    values
      (${childId}, ${manifest.openbooks.orgId},
       ${manifest.openbooks.subsidiaryId}, ${`Parity Child ${marker}`},
       'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb,
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId}),
      (${eliminationId}, ${manifest.openbooks.orgId},
       ${manifest.openbooks.subsidiaryId}, ${`Parity Eliminations ${marker}`},
       'CAD', 'CA', '{}'::jsonb, true, true, '{}'::jsonb,
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);

  const group = await client.create<{ name: string }>("Company", {
    company_name: `Parity Group ${marker}`,
    abbr: `G${suffix}`,
    default_currency: "CAD",
    country: "Canada",
    is_group: 1,
  });
  const erpParent = await client.create<{ name: string }>("Company", {
    company_name: `Parity Parent ${marker}`,
    abbr: `P${suffix}`,
    default_currency: "CAD",
    country: "Canada",
    create_chart_of_accounts_based_on: "Standard Template",
    chart_of_accounts: "Standard",
  });
  const erpChild = await client.create<{ name: string }>("Company", {
    company_name: `Parity Child ${marker}`,
    abbr: `C${suffix}`,
    default_currency: "CAD",
    country: "Canada",
    create_chart_of_accounts_based_on: "Standard Template",
    chart_of_accounts: "Standard",
  });
  const erpElimination = await client.create<{ name: string }>("Company", {
    company_name: `Parity Eliminations ${marker}`,
    abbr: `E${suffix}`,
    default_currency: "CAD",
    country: "Canada",
    create_chart_of_accounts_based_on: "Standard Template",
    chart_of_accounts: "Standard",
  });

  const companyAccounts = async (company: string) =>
    client.list<{
      name: string;
      account_number: string | null;
      root_type: string;
      is_group: number;
      account_type: string;
    }>(
      "Account",
      [
        "name",
        "account_number",
        "root_type",
        "is_group",
        "account_type",
      ],
      [["company", "=", company]],
      "name asc",
      500,
    );
  const accountSets = {
    parent: await companyAccounts(erpParent.name),
    child: await companyAccounts(erpChild.name),
    elimination: await companyAccounts(erpElimination.name),
  };
  const createErpLeaf = async (
    company: string,
    accounts: Awaited<ReturnType<typeof companyAccounts>>,
    name: string,
    rootType: "Asset" | "Liability" | "Equity" | "Income" | "Expense",
  ) => {
    const parent = accounts.find(
      (account) => account.is_group === 1 && account.root_type === rootType,
    )?.name;
    if (!parent) throw new Error(`${company} has no ${rootType} account group`);
    return client.create<{ name: string }>("Account", {
      account_name: `${name} ${marker}`,
      company,
      parent_account: parent,
      root_type: rootType,
      report_type:
        rootType === "Income" || rootType === "Expense"
          ? "Profit and Loss"
          : "Balance Sheet",
      is_group: 0,
    });
  };
  const erpDueFrom = {
    parent: await createErpLeaf(
      erpParent.name,
      accountSets.parent,
      "Parity Due From",
      "Asset",
    ),
    child: await createErpLeaf(
      erpChild.name,
      accountSets.child,
      "Parity Due From",
      "Asset",
    ),
    elimination: await createErpLeaf(
      erpElimination.name,
      accountSets.elimination,
      "Parity Due From",
      "Asset",
    ),
  };
  const erpDueTo = {
    parent: await createErpLeaf(
      erpParent.name,
      accountSets.parent,
      "Parity Due To",
      "Liability",
    ),
    child: await createErpLeaf(
      erpChild.name,
      accountSets.child,
      "Parity Due To",
      "Liability",
    ),
    elimination: await createErpLeaf(
      erpElimination.name,
      accountSets.elimination,
      "Parity Due To",
      "Liability",
    ),
  };
  const childCash = accountSets.child.find(
    (account) =>
      account.is_group === 0 &&
      (account.account_number === "1110" || account.account_type === "Cash"),
  )?.name;
  const parentCash = accountSets.parent.find(
    (account) =>
      account.is_group === 0 &&
      (account.account_number === "1110" || account.account_type === "Cash"),
  )?.name;
  if (!childCash || !parentCash) {
    throw new Error("ERPNext parent/child company has no cash account");
  }

  const dueFromId = randomUUID();
  const dueToId = randomUUID();
  const accountDefs: Array<[string, string, string, string, boolean]> = [
    [dueFromId, `18${suffix}`, "Due from affiliate", "asset_current_other", true],
    [dueToId, `28${suffix}`, "Due to affiliate", "liability_current_other", true],
  ];
  for (const [id, number, name, type, eliminate] of accountDefs) {
    await db.execute(sql`
      insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate,
         reconcilable, required_dimensions, custom,
         subsidiary_include_children, created_by, updated_by)
      values
        (${id}, ${manifest.openbooks.orgId}, ${number}, ${name}, ${type},
         false, true, ${eliminate}, false, '[]'::jsonb, '{}'::jsonb, true,
         ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
    `);
  }
  manifest.accountMap.openbooks[dueFromId] = "DUE_FROM";
  manifest.accountMap.openbooks[dueToId] = "DUE_TO";
  for (const account of Object.values(erpDueFrom))
    manifest.accountMap.erpnext[account.name] = "DUE_FROM";
  for (const account of Object.values(erpDueTo))
    manifest.accountMap.erpnext[account.name] = "DUE_TO";
  manifest.accountMap.openbooks[manifest.openbooks.accounts.bank!] = "CASH";
  manifest.accountMap.erpnext[parentCash] = "CASH";
  manifest.accountMap.erpnext[childCash] = "CASH";
  saveJson(manifestPath, manifest);

  const parentEntry = await postProjectGlEntry({
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    origin: "intercompany",
    entryNumber: `IC-PARENT-${marker}`,
    postingDate: "2026-07-15",
    memo: "Intercompany parent funding",
    subsidiaryId: manifest.openbooks.subsidiaryId,
    currency: "CAD",
    lines: [
      { accountId: dueFromId, amount: "120" },
      { accountId: manifest.openbooks.accounts.bank!, amount: "-120" },
    ],
  });
  const childEntry = await postProjectGlEntry({
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    origin: "intercompany",
    entryNumber: `IC-CHILD-${marker}`,
    postingDate: "2026-07-15",
    memo: "Intercompany child funding",
    subsidiaryId: childId,
    currency: "CAD",
    lines: [
      { accountId: manifest.openbooks.accounts.bank!, amount: "120" },
      { accountId: dueToId, amount: "-120" },
    ],
  });
  if (!parentEntry || !childEntry) throw new Error("intercompany source failed");
  const erpParentEntry = await client.create<{ name: string }>(
    "Journal Entry",
    {
      company: erpParent.name,
      voucher_type: "Inter Company Journal Entry",
      posting_date: "2026-07-15",
      accounts: [
        {
          account: erpDueFrom.parent.name,
          debit_in_account_currency: 120,
        },
        {
          account: parentCash,
          credit_in_account_currency: 120,
        },
      ],
    },
  );
  await client.submit("Journal Entry", erpParentEntry.name);
  const erpChildEntry = await client.create<{ name: string }>(
    "Journal Entry",
    {
      company: erpChild.name,
      voucher_type: "Inter Company Journal Entry",
      inter_company_journal_entry_reference: erpParentEntry.name,
      posting_date: "2026-07-15",
      accounts: [
        { account: childCash, debit_in_account_currency: 120 },
        {
          account: erpDueTo.child.name,
          credit_in_account_currency: 120,
        },
      ],
    },
  );
  await client.submit("Journal Entry", erpChildEntry.name);
  assertComparison(
    `consolidation-${marker}-parent-entity`,
    await openbooksEntriesSnapshot(manifest, [parentEntry], "parent-entity"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpParentEntry.name,
      "parent-entity",
      { company: erpParent.name },
    ),
  );
  assertComparison(
    `consolidation-${marker}-child-entity`,
    await openbooksEntriesSnapshot(manifest, [childEntry], "child-entity"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpChildEntry.name,
      "child-entity",
      { company: erpChild.name },
    ),
  );

  const firstElimination = await runAutoElimination(
    manifest.openbooks.orgId,
    manifest.openbooks.periodId,
    manifest.openbooks.actorId,
  );
  if (!firstElimination.entryId || firstElimination.lineCount !== 2) {
    throw new Error("OpenBooks auto-elimination did not create two lines");
  }
  const erpElimFirst = await client.create<{ name: string }>("Journal Entry", {
    company: erpElimination.name,
    voucher_type: "Journal Entry",
    posting_date: "2026-07-31",
    accounts: [
      {
        account: erpDueTo.elimination.name,
        debit_in_account_currency: 120,
      },
      {
        account: erpDueFrom.elimination.name,
        credit_in_account_currency: 120,
      },
    ],
  });
  await client.submit("Journal Entry", erpElimFirst.name);
  assertComparison(
    `consolidation-${marker}-elimination`,
    await openbooksEntriesSnapshot(
      manifest,
      [firstElimination.entryId],
      "elimination",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpElimFirst.name,
      "elimination",
      { company: erpElimination.name },
    ),
  );

  const secondElimination = await runAutoElimination(
    manifest.openbooks.orgId,
    manifest.openbooks.periodId,
    manifest.openbooks.actorId,
  );
  await client.cancel("Journal Entry", erpElimFirst.name);
  const erpElimReplacement = await client.create<{ name: string }>(
    "Journal Entry",
    {
      company: erpElimination.name,
      voucher_type: "Journal Entry",
      posting_date: "2026-07-31",
      accounts: [
        {
          account: erpDueTo.elimination.name,
          debit_in_account_currency: 120,
        },
        {
          account: erpDueFrom.elimination.name,
          credit_in_account_currency: 120,
        },
      ],
    },
  );
  await client.submit("Journal Entry", erpElimReplacement.name);
  const elimLineage = (await db.execute<{ id: string }>(sql`
    select id
      from journal_entries
     where org_id = ${manifest.openbooks.orgId}
       and subsidiary_id = ${eliminationId}
       and origin = 'intercompany'
     order by created_at
  `));
  assertComparison(
    `consolidation-${marker}-elimination-rerun`,
    await openbooksEntriesSnapshot(
      manifest,
      elimLineage.rows.map((row) => row.id),
      "elimination-rerun",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpElimReplacement.name,
      "elimination-rerun",
      { company: erpElimination.name },
    ),
  );
  if (!secondElimination.entryId) {
    throw new Error("OpenBooks elimination rerun did not replace the entry");
  }

  const ownershipKeys = [
    ["investment", "asset_current_other", "Asset"],
    ["equityIncome", "income_other", "Income"],
    ["nciEquity", "equity", "Equity"],
    ["nciIncome", "expense_other", "Expense"],
    ["goodwill", "asset_fixed", "Asset"],
    ["fairValue", "asset_fixed", "Asset"],
    ["childEquity", "equity", "Equity"],
  ] as const;
  const ownershipOb = new Map<string, string>();
  const ownershipErp = new Map<string, string>();
  for (let index = 0; index < ownershipKeys.length; index++) {
    const [key, type, root] = ownershipKeys[index]!;
    const id = randomUUID();
    ownershipOb.set(key, id);
    await db.execute(sql`
      insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate,
         reconcilable, required_dimensions, custom,
         subsidiary_include_children, created_by, updated_by)
      values
        (${id}, ${manifest.openbooks.orgId},
         ${`7${index}${suffix}`}, ${`Ownership ${key} ${marker}`}, ${type},
         false, true, false, false, '[]'::jsonb, '{}'::jsonb, true,
         ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
    `);
    const erpAccount = await createErpLeaf(
      erpElimination.name,
      accountSets.elimination,
      `Ownership ${key}`,
      root,
    );
    ownershipErp.set(key, erpAccount.name);
    const semantic = `OWN_${key.toUpperCase()}`;
    manifest.accountMap.openbooks[id] = semantic;
    manifest.accountMap.erpnext[erpAccount.name] = semantic;
  }
  saveJson(manifestPath, manifest);

  const capitalEntry = await postProjectGlEntry({
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    origin: "manual",
    entryNumber: `OWN-CAP-${marker}`,
    postingDate: "2026-07-01",
    memo: "Child opening equity",
    subsidiaryId: childId,
    currency: "CAD",
    lines: [
      { accountId: manifest.openbooks.accounts.bank!, amount: "1000" },
      { accountId: ownershipOb.get("childEquity")!, amount: "-1000" },
    ],
  });
  const profitEntry = await postProjectGlEntry({
    orgId: manifest.openbooks.orgId,
    actorId: manifest.openbooks.actorId,
    origin: "manual",
    entryNumber: `OWN-PROFIT-${marker}`,
    postingDate: "2026-07-15",
    memo: "Child period profit",
    subsidiaryId: childId,
    currency: "CAD",
    lines: [
      { accountId: manifest.openbooks.accounts.bank!, amount: "100" },
      { accountId: manifest.openbooks.accounts.revenue!, amount: "-100" },
    ],
  });
  if (!capitalEntry || !profitEntry) throw new Error("ownership source failed");
  const interestId = randomUUID();
  await db.execute(sql`
    insert into subsidiary_ownership_interests
      (id, org_id, parent_subsidiary_id, subsidiary_id, effective_from,
       ownership_percent, method, acquisition_date, acquisition_cost,
       fair_value_net_assets, acquisition_rate, nci_measurement,
       investment_account_id, equity_income_account_id,
       nci_equity_account_id, nci_income_account_id, goodwill_account_id,
       fair_value_adjustment_account_id, created_by, updated_by)
    values
      (${interestId}, ${manifest.openbooks.orgId},
       ${manifest.openbooks.subsidiaryId}, ${childId}, '2026-07-01', 80,
       'full', '2026-07-01', 900, 1000, 1, 'proportionate',
       ${ownershipOb.get("investment")!}, ${ownershipOb.get("equityIncome")!},
       ${ownershipOb.get("nciEquity")!}, ${ownershipOb.get("nciIncome")!},
       ${ownershipOb.get("goodwill")!}, ${ownershipOb.get("fairValue")!},
       ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
  `);
  const ownership = await runOwnershipConsolidation(
    manifest.openbooks.orgId,
    manifest.openbooks.periodId,
    manifest.openbooks.actorId,
  );
  const erpAcquisition = await client.create<{ name: string }>(
    "Journal Entry",
    {
      company: erpElimination.name,
      voucher_type: "Journal Entry",
      posting_date: "2026-07-31",
      accounts: [
        {
          account: ownershipErp.get("childEquity"),
          debit_in_account_currency: 1000,
        },
        {
          account: ownershipErp.get("goodwill"),
          debit_in_account_currency: 100,
        },
        {
          account: ownershipErp.get("investment"),
          credit_in_account_currency: 900,
        },
        {
          account: ownershipErp.get("nciEquity"),
          credit_in_account_currency: 200,
        },
      ],
    },
  );
  const erpNci = await client.create<{ name: string }>("Journal Entry", {
    company: erpElimination.name,
    voucher_type: "Journal Entry",
    posting_date: "2026-07-31",
    accounts: [
      {
        account: ownershipErp.get("nciIncome"),
        debit_in_account_currency: 20,
      },
      {
        account: ownershipErp.get("nciEquity"),
        credit_in_account_currency: 20,
      },
    ],
  });
  await client.submit("Journal Entry", erpAcquisition.name);
  await client.submit("Journal Entry", erpNci.name);
  const erpOwnershipSnapshots = await Promise.all([
    erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpAcquisition.name,
      "ownership",
      { company: erpElimination.name },
    ),
    erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpNci.name,
      "ownership",
      { company: erpElimination.name },
    ),
  ]);
  assertComparison(
    `consolidation-${marker}-ownership`,
    await openbooksEntriesSnapshot(manifest, ownership.entryIds, "ownership"),
    {
      source: "erpnext",
      company: manifest.companyName,
      checkpoint: "ownership",
      lines: canonicalizeLines(
        erpOwnershipSnapshots.flatMap((snapshot) => snapshot.lines),
      ),
    },
  );
  const ownershipRerun = await runOwnershipConsolidation(
    manifest.openbooks.orgId,
    manifest.openbooks.periodId,
    manifest.openbooks.actorId,
  );
  await client.cancel("Journal Entry", erpAcquisition.name);
  await client.cancel("Journal Entry", erpNci.name);
  const erpAcquisition2 = await client.create<{ name: string }>(
    "Journal Entry",
    {
      company: erpElimination.name,
      voucher_type: "Journal Entry",
      posting_date: "2026-07-31",
      accounts: [
        {
          account: ownershipErp.get("childEquity"),
          debit_in_account_currency: 1000,
        },
        {
          account: ownershipErp.get("goodwill"),
          debit_in_account_currency: 100,
        },
        {
          account: ownershipErp.get("investment"),
          credit_in_account_currency: 900,
        },
        {
          account: ownershipErp.get("nciEquity"),
          credit_in_account_currency: 200,
        },
      ],
    },
  );
  const erpNci2 = await client.create<{ name: string }>("Journal Entry", {
    company: erpElimination.name,
    voucher_type: "Journal Entry",
    posting_date: "2026-07-31",
    accounts: [
      {
        account: ownershipErp.get("nciIncome"),
        debit_in_account_currency: 20,
      },
      {
        account: ownershipErp.get("nciEquity"),
        credit_in_account_currency: 20,
      },
    ],
  });
  await client.submit("Journal Entry", erpAcquisition2.name);
  await client.submit("Journal Entry", erpNci2.name);
  const erpOwnershipRerun = await Promise.all([
    erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpAcquisition2.name,
      "ownership-rerun",
      { company: erpElimination.name },
    ),
    erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpNci2.name,
      "ownership-rerun",
      { company: erpElimination.name },
    ),
  ]);
  assertComparison(
    `consolidation-${marker}-ownership-rerun`,
    await openbooksEntriesSnapshot(
      manifest,
      [...ownership.entryIds, ...ownershipRerun.entryIds],
      "ownership-rerun",
    ),
    {
      source: "erpnext",
      company: manifest.companyName,
      checkpoint: "ownership-rerun",
      lines: canonicalizeLines(
        erpOwnershipRerun.flatMap((snapshot) => snapshot.lines),
      ),
    },
  );
}

async function runIncomeTaxProvisionParity(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const suffix = marker.slice(-5);

  const accountDefinitions = [
    ["TAX_EXPENSE", "Income Tax Expense", "expense", "Expense"],
    ["TAX_PAYABLE", "Income Tax Payable", "liability_current_other", "Liability"],
    ["DTA", "Deferred Tax Asset", "asset_current_other", "Asset"],
    ["DTL", "Deferred Tax Liability", "liability_long_term", "Liability"],
    ["VALUATION_ALLOWANCE", "Valuation Allowance", "asset_current_other", "Asset"],
  ] as const;
  const openbooksAccounts = new Map<string, string>();
  const erpAccounts = new Map<string, string>();
  const erpChart = await client.list<{
    name: string;
    root_type: string;
    is_group: number;
  }>(
    "Account",
    ["name", "root_type", "is_group"],
    [["company", "=", manifest.erpnext.company]],
    "name asc",
    500,
  );

  for (let index = 0; index < accountDefinitions.length; index++) {
    const [semantic, label, openbooksType, erpRoot] =
      accountDefinitions[index]!;
    const openbooksId = randomUUID();
    await db.execute(sql`
      insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate,
         reconcilable, required_dimensions, custom,
         subsidiary_include_children, created_by, updated_by)
      values
        (${openbooksId}, ${manifest.openbooks.orgId},
         ${`96${index}${suffix}`}, ${`${label} ${marker}`}, ${openbooksType},
         false, true, false, false, '[]'::jsonb, '{}'::jsonb, true,
         ${manifest.openbooks.actorId}, ${manifest.openbooks.actorId})
    `);
    const parent = erpChart.find(
      (account) =>
        account.is_group === 1 && account.root_type === erpRoot,
    )?.name;
    if (!parent) {
      throw new Error(
        `ERPNext parity company has no ${erpRoot} account group`,
      );
    }
    const erpAccount = await client.create<{ name: string }>("Account", {
      account_name: `${label} ${marker}`,
      company: manifest.erpnext.company,
      parent_account: parent,
      root_type: erpRoot,
      report_type:
        erpRoot === "Expense" ? "Profit and Loss" : "Balance Sheet",
      is_group: 0,
    });
    openbooksAccounts.set(semantic, openbooksId);
    erpAccounts.set(semantic, erpAccount.name);
    manifest.accountMap.openbooks[openbooksId] = semantic;
    manifest.accountMap.erpnext[erpAccount.name] = semantic;
  }
  saveJson(manifestPath, manifest);

  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         settings,
         '{controlAccounts}',
         coalesce(settings->'controlAccounts', '{}'::jsonb) ||
         ${JSON.stringify({
           incomeTaxExpense: openbooksAccounts.get("TAX_EXPENSE"),
           incomeTaxPayable: openbooksAccounts.get("TAX_PAYABLE"),
           deferredTaxAsset: openbooksAccounts.get("DTA"),
           deferredTaxLiability: openbooksAccounts.get("DTL"),
           valuationAllowance: openbooksAccounts.get("VALUATION_ALLOWANCE"),
         })}::jsonb
       ),
       updated_at = now(),
       updated_by = ${manifest.openbooks.actorId}
     where id = ${manifest.openbooks.orgId}
  `);
  await db.execute(sql`
    update income_tax_rates
       set is_active = false,
           updated_at = now(), updated_by = ${manifest.openbooks.actorId}
     where org_id = ${manifest.openbooks.orgId}
       and jurisdiction = 'ERPNext parity provision'
       and is_active
  `);
  await db.execute(sql`
    insert into income_tax_rates
      (org_id, jurisdiction, rate_percent, effective_from,
       created_by, updated_by)
    values
      (${manifest.openbooks.orgId}, 'ERPNext parity provision', '26.5',
       '2026-01-01', ${manifest.openbooks.actorId},
       ${manifest.openbooks.actorId})
  `);

  type ProvisionPayload = {
    pretaxBookIncome: string;
    currentTax: string;
    totalExpense: string;
    movement: {
      dtaGross: string;
      dtlGross: string;
      valuationAllowance: string;
    };
  };
  const provisionAmounts = (payload: ProvisionPayload) => [
    ["TAX_PAYABLE", -toUnits(payload.currentTax)],
    ["DTA", toUnits(payload.movement.dtaGross)],
    ["DTL", -toUnits(payload.movement.dtlGross)],
    ["VALUATION_ALLOWANCE", -toUnits(payload.movement.valuationAllowance)],
    ["TAX_EXPENSE", toUnits(payload.totalExpense)],
  ] as const;
  const erpJournalAccounts = (payload: ProvisionPayload) =>
    provisionAmounts(payload)
      .filter(([, amount]) => amount !== 0n)
      .map(([semantic, amount]) => ({
        account: erpAccounts.get(semantic),
        ...(amount > 0n
          ? { debit_in_account_currency: fromUnits(amount) }
          : { credit_in_account_currency: fromUnits(-amount) }),
      }));
  const compute = async (
    taxableDifference: string,
    permanentDifference: string,
  ) => {
    const runId = await computeProvisionRun(
      manifest.openbooks.orgId,
      2026,
      {
        permanentDifferences: [
          {
            description: "Parity permanent difference",
            amount: permanentDifference,
          },
        ],
        valuationAllowance: "10",
        additionalDifferences: [
          {
            category: "fixed_assets",
            description: "Parity taxable temporary difference",
            difference: taxableDifference,
            source: "manual",
          },
          {
            category: "provisions",
            description: "Parity deductible temporary difference",
            difference: "-80",
            source: "manual",
          },
        ],
      },
      manifest.openbooks.actorId,
    );
    const run = await getProvisionRun(manifest.openbooks.orgId, runId);
    if (!run) throw new Error("computed tax provision disappeared");
    return { runId, payload: run.payload as unknown as ProvisionPayload };
  };

  // The shared parity tenant already contains prior fixture activity. Measure
  // that pretax balance first, then offset it to an exact $1,000 taxable base
  // so ERPNext's currency-scale journal and the 4dp ledger compare
  // without hiding a sub-cent difference.
  const probe = await compute("200", "0");
  const permanentDifference = fromUnits(
    toUnits("1000") - toUnits(probe.payload.pretaxBookIncome),
  );
  const first = await compute("200", permanentDifference);
  const firstRetryDraft = await compute("200", permanentDifference);
  if (firstRetryDraft.runId !== first.runId) {
    throw new Error("identical tax provision computation was not idempotent");
  }
  const erpFirst = await client.create<{ name: string }>("Journal Entry", {
    company: manifest.erpnext.company,
    voucher_type: "Journal Entry",
    posting_date: "2026-07-31",
    user_remark: `Income tax provision ${marker} v1`,
    accounts: erpJournalAccounts(first.payload),
  });
  assertComparison(
    `income-tax-provision-${marker}-draft-no-gl`,
    await openbooksEntriesSnapshot(manifest, [], "draft-no-gl"),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpFirst.name,
      "draft-no-gl",
    ),
  );
  const firstPosted = await postProvisionRun(
    manifest.openbooks.orgId,
    first.runId,
    manifest.openbooks.actorId,
  );
  await client.submit("Journal Entry", erpFirst.name);
  assertComparison(
    `income-tax-provision-${marker}-post`,
    await openbooksEntriesSnapshot(
      manifest,
      [firstPosted.entryId],
      "tax-provision-post",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpFirst.name,
      "tax-provision-post",
    ),
  );
  const firstPostRetry = await postProvisionRun(
    manifest.openbooks.orgId,
    first.runId,
    manifest.openbooks.actorId,
  );
  const firstJournalCount = await one<{ count: number }>(sql`
    select count(*)::int as count
      from journal_entries
     where org_id = ${manifest.openbooks.orgId}
       and id = ${firstPosted.entryId}
  `);
  const retryOk =
    firstPostRetry.entryId === firstPosted.entryId &&
    firstJournalCount.count === 1;
  saveJson(
    join(
      evidenceDir,
      `income-tax-provision-${marker}-post-idempotency.json`,
    ),
    {
      checkpoint: `income-tax-provision-${marker}-post-idempotency`,
      firstEntryId: firstPosted.entryId,
      retryEntryId: firstPostRetry.entryId,
      journalCount: firstJournalCount.count,
      comparison: { ok: retryOk },
    },
  );
  if (!retryOk) throw new Error("tax provision post retry was not idempotent");
  console.log(`PASS income-tax-provision-${marker}-post-idempotency`);

  const second = await compute("300", permanentDifference);
  const erpSecond = await client.create<{ name: string }>("Journal Entry", {
    company: manifest.erpnext.company,
    voucher_type: "Journal Entry",
    posting_date: "2026-07-31",
    user_remark: `Income tax provision ${marker} v2`,
    accounts: erpJournalAccounts(second.payload),
  });
  await client.cancel("Journal Entry", erpFirst.name);
  const secondPosted = await postProvisionRun(
    manifest.openbooks.orgId,
    second.runId,
    manifest.openbooks.actorId,
  );
  await client.submit("Journal Entry", erpSecond.name);
  const reversal = await one<{
    id: string;
    source_status: string;
    source_run_status: string;
    mirror_lines: number;
    source_lines: number;
  }>(sql`
    select reversal.id,
           source.status as source_status,
           source_run.status as source_run_status,
           count(*) filter (
             where reverse_line.account_id = source_line.account_id
               and reverse_line.subsidiary_id = source_line.subsidiary_id
               and reverse_line.amount = -source_line.amount
               and reverse_line.txn_amount = -source_line.txn_amount
           )::int as mirror_lines,
           count(*)::int as source_lines
      from journal_entries source
      join tax_provision_runs source_run
        on source_run.org_id = source.org_id
       and source_run.journal_entry_id = source.id
      join journal_entries reversal
        on reversal.org_id = source.org_id
       and reversal.reverses_entry_id = source.id
       and reversal.status = 'posted'
      join journal_lines source_line on source_line.entry_id = source.id
      join journal_lines reverse_line
        on reverse_line.entry_id = reversal.id
       and reverse_line.line_number = source_line.line_number
     where source.org_id = ${manifest.openbooks.orgId}
       and source.id = ${firstPosted.entryId}
     group by reversal.id, source.status, source_run.status
  `);
  assertComparison(
    `income-tax-provision-${marker}-reversal`,
    await openbooksEntriesSnapshot(
      manifest,
      [firstPosted.entryId, reversal.id],
      "tax-provision-reversal",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpFirst.name,
      "tax-provision-reversal",
    ),
  );
  const lineageOk =
    reversal.source_status === "reversed" &&
    reversal.source_run_status === "superseded" &&
    reversal.mirror_lines === reversal.source_lines;
  saveJson(
    join(evidenceDir, `income-tax-provision-${marker}-lineage.json`),
    {
      checkpoint: `income-tax-provision-${marker}-lineage`,
      ...reversal,
      comparison: { ok: lineageOk },
    },
  );
  if (!lineageOk) {
    throw new Error("tax provision replacement lineage is incomplete");
  }
  console.log(`PASS income-tax-provision-${marker}-lineage`);
  assertComparison(
    `income-tax-provision-${marker}-replacement`,
    await openbooksEntriesSnapshot(
      manifest,
      [secondPosted.entryId],
      "tax-provision-replacement",
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Journal Entry",
      erpSecond.name,
      "tax-provision-replacement",
    ),
  );
  const secondRetry = await postProvisionRun(
    manifest.openbooks.orgId,
    second.runId,
    manifest.openbooks.actorId,
  );
  const replacementRetryOk = secondRetry.entryId === secondPosted.entryId;
  saveJson(
    join(
      evidenceDir,
      `income-tax-provision-${marker}-replacement-idempotency.json`,
    ),
    {
      checkpoint: `income-tax-provision-${marker}-replacement-idempotency`,
      firstEntryId: secondPosted.entryId,
      retryEntryId: secondRetry.entryId,
      comparison: { ok: replacementRetryOk },
    },
  );
  if (!replacementRetryOk) {
    throw new Error("replacement tax provision retry was not idempotent");
  }
  console.log(
    `PASS income-tax-provision-${marker}-replacement-idempotency`,
  );
}

async function runSyncCorrectionsParity(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const amount = "77.77";

  const documentId = await createOpenBooksDocumentDraft(manifest, {
    kind: "customer_invoice",
    marker: `${marker}-SOURCE-DELETION`,
    partyId: manifest.openbooks.customerId,
    accountId: manifest.openbooks.accounts.revenue!,
    amount,
  });
  const erpInvoice = await client.create<{ name: string }>("Sales Invoice", {
    company: manifest.erpnext.company,
    customer: manifest.erpnext.customer,
    posting_date: "2026-07-15",
    due_date: "2026-07-30",
    currency: "CAD",
    disable_rounded_total: 1,
    debit_to: manifest.erpnext.accounts.ar,
    items: [
      {
        item_code: manifest.erpnext.serviceItem,
        qty: 1,
        rate: Number(amount),
        income_account: manifest.erpnext.accounts.revenue,
        cost_center: manifest.erpnext.costCenter,
      },
    ],
  });
  await db.execute(sql`
    update documents
       set custom = custom || ${JSON.stringify({
         erpId: erpInvoice.name,
       })}::jsonb,
           updated_at = now(), updated_by = ${manifest.openbooks.actorId}
     where org_id = ${manifest.openbooks.orgId} and id = ${documentId}
  `);
  await approveAndPost(manifest, documentId);
  await client.submit("Sales Invoice", erpInvoice.name);
  assertComparison(
    `sync-correction-${marker}-source-before-delete`,
    await openbooksVoucherSnapshot(
      manifest,
      documentId,
      "source-before-delete",
      { includeControlParty: true },
    ),
    remapSnapshotAccounts(
      await erpVoucherSnapshot(
        client,
        manifest,
        "Sales Invoice",
        erpInvoice.name,
        "source-before-delete",
        { includeControlParty: true },
      ),
      { EQUIPMENT_RECOVERY: "REVENUE" },
    ),
  );
  const deleted = await mirrorSourceDeletion({
    orgId: manifest.openbooks.orgId,
    source: "erpnext",
    sourceRef: erpInvoice.name,
  });
  if (!deleted.deleted || deleted.documentId !== documentId) {
    throw new Error("source tombstone did not void the matching document");
  }
  await client.cancel("Sales Invoice", erpInvoice.name);
  assertComparison(
    `sync-correction-${marker}-source-deletion`,
    await openbooksVoucherSnapshot(
      manifest,
      documentId,
      "source-deletion",
      { includeControlParty: true },
    ),
    await erpVoucherSnapshot(
      client,
      manifest,
      "Sales Invoice",
      erpInvoice.name,
      "source-deletion",
      { includeControlParty: true },
    ),
  );
  const repeatDeletion = await mirrorSourceDeletion({
    orgId: manifest.openbooks.orgId,
    source: "erpnext",
    sourceRef: erpInvoice.name,
  });
  const deletionEvidence = await one<{
    reversals: number;
    audits: number;
    source_status: string;
    document_status: string;
  }>(sql`
    select
      (
        select count(*)::int
          from journal_entries reversal
         where reversal.org_id = document.org_id
           and reversal.reverses_entry_id = document.posted_entry_id
      ) as reversals,
      (
        select count(*)::int
          from audit_log audit
         where audit.org_id = document.org_id
           and audit.table_name = 'documents'
           and audit.row_id = document.id
           and audit.request_id = 'mirror'
      ) as audits,
      source.status as source_status,
      document.status as document_status
      from documents document
      join journal_entries source on source.id = document.posted_entry_id
     where document.org_id = ${manifest.openbooks.orgId}
       and document.id = ${documentId}
  `);
  const deletionOk =
    !repeatDeletion.deleted &&
    deletionEvidence.reversals === 1 &&
    deletionEvidence.audits === 1 &&
    deletionEvidence.source_status === "reversed" &&
    deletionEvidence.document_status === "voided";
  saveJson(
    join(evidenceDir, `sync-correction-${marker}-source-idempotency.json`),
    {
      checkpoint: `sync-correction-${marker}-source-idempotency`,
      repeatDeletion,
      ...deletionEvidence,
      comparison: { ok: deletionOk },
    },
  );
  if (!deletionOk) {
    throw new Error("source-deletion retry or audit lineage is incomplete");
  }
  console.log(`PASS sync-correction-${marker}-source-idempotency`);

  const scratch = await createScratchOrg();
  const trueupActor = (await seedFlowActors(scratch.orgId)).adminId;
  try {
    await db.execute(sql`
      update accounts
         set custom = jsonb_set(custom, '{parityRef}', '"A"'::jsonb)
       where org_id = ${scratch.orgId} and id = ${scratch.accounts.adjustment}
    `);
    await db.execute(sql`
      update accounts
         set custom = jsonb_set(custom, '{parityRef}', '"B"'::jsonb)
       where org_id = ${scratch.orgId} and id = ${scratch.accounts.clearing}
    `);

    const suffix = marker.slice(-5);
    const erpCompany = await client.create<{ name: string }>("Company", {
      company_name: `Parity Trueup ${marker}`,
      abbr: `T${suffix}`,
      default_currency: "CAD",
      country: "Canada",
      create_chart_of_accounts_based_on: "Standard Template",
      chart_of_accounts: "Standard",
    });
    const erpChart = await client.list<{
      name: string;
      root_type: string;
      is_group: number;
    }>(
      "Account",
      ["name", "root_type", "is_group"],
      [["company", "=", erpCompany.name]],
      "name asc",
      500,
    );
    const createLeaf = async (
      label: string,
      rootType: "Asset" | "Liability",
    ) => {
      const parent = erpChart.find(
        (account) =>
          account.is_group === 1 && account.root_type === rootType,
      )?.name;
      if (!parent) throw new Error(`true-up company has no ${rootType} root`);
      return client.create<{ name: string }>("Account", {
        account_name: `${label} ${marker}`,
        company: erpCompany.name,
        parent_account: parent,
        root_type: rootType,
        report_type: "Balance Sheet",
        is_group: 0,
      });
    };
    const erpDebit = await createLeaf("Trueup Debit", "Asset");
    const erpCredit = await createLeaf("Trueup Credit", "Liability");
    const trueupManifest = structuredClone(manifest);
    trueupManifest.companyName = erpCompany.name;
    trueupManifest.erpnext.company = erpCompany.name;
    trueupManifest.openbooks.orgId = scratch.orgId;
    trueupManifest.openbooks.subsidiaryId = scratch.subsidiaryId;
    trueupManifest.openbooks.actorId = trueupActor;
    trueupManifest.accountMap.openbooks = {
      [scratch.accounts.adjustment]: "TRUEUP_DEBIT",
      [scratch.accounts.clearing]: "TRUEUP_CREDIT",
    };
    trueupManifest.accountMap.erpnext = {
      [erpDebit.name]: "TRUEUP_DEBIT",
      [erpCredit.name]: "TRUEUP_CREDIT",
    };
    let sourceRows = [
      { accountRef: "A", month: "2026-07", amount: "100.0000" },
      { accountRef: "B", month: "2026-07", amount: "-100.0000" },
    ];
    const source = {
      name: "erpnext-parity-trueup",
      refKey: "parityRef",
      baseCurrency: "CAD",
      monthlyActivity: async () => sourceRows,
    } as unknown as MigrationSource;
    const firstTrueup = await trueUpResidualGl(scratch.orgId, source, {
      actorId: trueupActor,
      syncRunId: `parity-${marker}`,
    });
    const firstTrueupEntry = await one<{ id: string }>(sql`
      select id
        from journal_entries
       where org_id = ${scratch.orgId}
         and entry_number like 'TRUEUP-2026-07-%'
       order by created_at
       limit 1
    `);
    const erpTrueup = await client.create<{ name: string }>("Journal Entry", {
      company: erpCompany.name,
      voucher_type: "Journal Entry",
      posting_date: "2026-07-31",
      accounts: [
        { account: erpDebit.name, debit_in_account_currency: 100 },
        { account: erpCredit.name, credit_in_account_currency: 100 },
      ],
    });
    await client.submit("Journal Entry", erpTrueup.name);
    assertComparison(
      `sync-correction-${marker}-trueup`,
      await openbooksEntriesSnapshot(
        trueupManifest,
        [firstTrueupEntry.id],
        "migration-trueup",
      ),
      await erpVoucherSnapshot(
        client,
        trueupManifest,
        "Journal Entry",
        erpTrueup.name,
        "migration-trueup",
        { company: erpCompany.name },
      ),
    );
    const trueupRetry = await trueUpResidualGl(scratch.orgId, source, {
      actorId: trueupActor,
      syncRunId: `parity-${marker}`,
    });
    const trueupRetryOk =
      firstTrueup.entries === 1 &&
      firstTrueup.lines === 2 &&
      trueupRetry.entries === 0 &&
      trueupRetry.lines === 0;
    saveJson(
      join(evidenceDir, `sync-correction-${marker}-trueup-idempotency.json`),
      {
        checkpoint: `sync-correction-${marker}-trueup-idempotency`,
        first: firstTrueup,
        retry: trueupRetry,
        comparison: { ok: trueupRetryOk },
      },
    );
    if (!trueupRetryOk) {
      throw new Error("migration true-up retry posted duplicate GL");
    }
    console.log(`PASS sync-correction-${marker}-trueup-idempotency`);

    sourceRows = [
      { accountRef: "A", month: "2026-07", amount: "130.0000" },
      { accountRef: "B", month: "2026-07", amount: "-130.0000" },
    ];
    const changedTrueup = await trueUpResidualGl(scratch.orgId, source, {
      actorId: trueupActor,
      syncRunId: `parity-${marker}-changed`,
    });
    const changedEntry = await one<{ id: string }>(sql`
      select id
        from journal_entries
       where org_id = ${scratch.orgId}
         and entry_number like 'TRUEUP-2026-07-%'
       order by created_at desc
       limit 1
    `);
    const erpChanged = await client.create<{ name: string }>("Journal Entry", {
      company: erpCompany.name,
      voucher_type: "Journal Entry",
      posting_date: "2026-07-31",
      accounts: [
        { account: erpDebit.name, debit_in_account_currency: 30 },
        { account: erpCredit.name, credit_in_account_currency: 30 },
      ],
    });
    await client.submit("Journal Entry", erpChanged.name);
    assertComparison(
      `sync-correction-${marker}-trueup-delta`,
      await openbooksEntriesSnapshot(
        trueupManifest,
        [changedEntry.id],
        "migration-trueup-delta",
      ),
      await erpVoucherSnapshot(
        client,
        trueupManifest,
        "Journal Entry",
        erpChanged.name,
        "migration-trueup-delta",
        { company: erpCompany.name },
      ),
    );
    if (changedTrueup.entries !== 1 || changedTrueup.lines !== 2) {
      throw new Error("changed source ledger did not post one exact delta");
    }
  } finally {
    await dropScratchOrg(scratch.orgId);
  }
}


async function status(): Promise<void> {
  const manifest = readManifest();
  const config = erpConfig();
  const client = new ErpNextParityClient(config);
  const org = await one<{
    name: string;
    base_currency: string;
    env_kind: string;
  }>(sql`
    select name, base_currency, env_kind from orgs where id = ${manifest.openbooks.orgId}
  `);
  const company = await client.get<{ name: string; default_currency: string }>(
    "Company",
    manifest.erpnext.company,
  );
  console.log(
    JSON.stringify(
      {
        openbooks: { ...org, orgId: manifest.openbooks.orgId },
        erpnext: {
          name: company.name,
          currency: company.default_currency,
          url: config.url,
        },
        evidenceDir,
      },
      null,
      2,
    ),
  );
}

async function report(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const evidenceFiles = existsSync(evidenceDir)
    ? readdirSync(evidenceDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
    : [];
  const failedEvidence: string[] = [];
  const resolvedFindings: { file: string; resolution: string | null }[] = [];
  for (const name of evidenceFiles) {
    const evidence = JSON.parse(
      readFileSync(join(evidenceDir, name), "utf8"),
    ) as {
      comparison?: { ok?: boolean };
      resolved?: boolean;
      resolution?: string;
    };
    if (evidence.comparison?.ok !== true) {
      if (evidence.resolved) {
        resolvedFindings.push({
          file: name,
          resolution: evidence.resolution ?? null,
        });
      } else {
        failedEvidence.push(name);
      }
    }
  }

  const openbooksIntegrity = await one<{
    entries: string;
    unbalanced_entries: string;
    net: string;
  }>(sql`
    select count(*)::text as entries,
           count(*) filter (where balance <> 0)::text as unbalanced_entries,
           coalesce(sum(balance), 0)::text as net
      from (
        select e.id, coalesce(sum(l.amount), 0) as balance
          from journal_entries e
          left join journal_lines l on l.entry_id = e.id
         where e.org_id = ${manifest.openbooks.orgId}
         group by e.id
      ) entries
  `);
  const erpRows = await client.list<{
    voucher_type: string;
    voucher_no: string;
    debit: string | number;
    credit: string | number;
  }>(
    "GL Entry",
    ["voucher_type", "voucher_no", "debit", "credit"],
    [
      ["company", "=", manifest.erpnext.company],
      ["is_cancelled", "=", 0],
    ],
    "creation asc",
    5_000,
  );
  const erpByVoucher = new Map<string, bigint>();
  let erpNet = 0n;
  for (const row of erpRows) {
    const amount =
      toUnits(String(row.debit ?? 0)) - toUnits(String(row.credit ?? 0));
    const key = `${row.voucher_type}|${row.voucher_no}`;
    erpByVoucher.set(key, (erpByVoucher.get(key) ?? 0n) + amount);
    erpNet += amount;
  }
  const operationStatus = Object.fromEntries(
    ["verified", "partial", "pending", "product-specific"].map((status) => [
      status,
      GL_OPERATION_REGISTRY.filter((operation) => operation.status === status)
        .length,
    ]),
  );
  const matrixStatus = Object.fromEntries(
    ["direct", "semantic", "openbooks-only", "erpnext-only", "pending"].map(
      (status) => [
        status,
        GL_COVERAGE_MATRIX.filter((row) => row.disposition === status).length,
      ],
    ),
  );
  const operations = GL_OPERATION_REGISTRY.map((operation) => ({
    ...operation,
    evidenceFiles: evidenceFiles.filter((name) =>
      operation.evidencePrefixes.some((prefix) => name.startsWith(prefix)),
    ),
  }));
  const verifiedWithoutEvidence = operations
    .filter(
      (operation) =>
        (operation.status === "verified" ||
          operation.status === "product-specific") &&
        operation.evidenceFiles.length === 0,
    )
    .map((operation) => operation.openbooksOperation);
  const exhaustive =
    failedEvidence.length === 0 &&
    verifiedWithoutEvidence.length === 0 &&
    GL_OPERATION_REGISTRY.every(
      (operation) =>
        operation.status === "verified" ||
        operation.status === "product-specific",
    ) &&
    GL_COVERAGE_MATRIX.every((row) => row.disposition !== "pending");
  const output = {
    generatedAt: new Date().toISOString(),
    exhaustive,
    exhaustiveReason: exhaustive
      ? null
      : "Pending/partial operations, missing evidence, or unresolved failures remain.",
    company: manifest.companyName,
    tenant: {
      openbooksOrgId: manifest.openbooks.orgId,
      erpnextCompany: manifest.erpnext.company,
    },
    evidence: {
      directory: evidenceDir,
      passingFiles:
        evidenceFiles.length - failedEvidence.length - resolvedFindings.length,
      failingFiles: failedEvidence,
      resolvedFindings,
      checkpoints: evidenceFiles,
      verifiedWithoutEvidence,
    },
    sourceIntegrity: {
      openbooks: openbooksIntegrity,
      erpnext: {
        activeGlRows: erpRows.length,
        unbalancedActiveVouchers: [...erpByVoucher.values()].filter(
          (amount) => amount !== 0n,
        ).length,
        net: fromUnits(erpNet),
      },
    },
    operationStatus,
    matrixStatus,
    operations,
  };
  const path = join(runtimeDir, "coverage-report.json");
  saveJson(path, output);
  console.log(JSON.stringify({ path, ...output }, null, 2));
}

function runPspNativeInvariants(): void {
  const testFile = join(
    repoRoot,
    "engine",
    "src",
    "psp-settlement.integration.test.ts",
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-force-exit", testFile],
    {
      cwd: repoRoot,
      env: { ...process.env, NODE_OPTIONS: "--trace-deprecation" },
      encoding: "utf8",
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(
      `PSP native invariant suite failed with exit status ${result.status ?? "unknown"}`,
    );
  }
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const checkpoint = `psp-settlement-${marker}-native`;
  saveJson(join(evidenceDir, `${checkpoint}.json`), {
    checkpoint,
    productSpecific: true,
    suite: "engine/src/psp-settlement.integration.test.ts",
    comparison: { ok: true },
    assertions: [
      "concurrent import creates one atomic batch and one immutable evidence-line set",
      "concurrent posting retries return one balanced journal entry",
      "fees, refunds, disputes, dispute reversals, and FX adjustments post exactly",
      "controlled reversal mirrors every amount, transaction amount, account, currency, and FX rate",
      "void lifecycle records actor, reason, timestamps, journal lineage, and audit events",
      "reversed journal history rejects mutation",
      "cross-currency settlement without explicit conversion evidence fails closed",
      "closed banking period rejects posting without partial GL",
    ],
  });
  console.log(`PASS ${checkpoint}`);
}

function runBankingNativeInvariants(): void {
  const testFile = join(
    repoRoot,
    "engine",
    "src",
    "banking.integration.test.ts",
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-force-exit", testFile],
    {
      cwd: repoRoot,
      env: { ...process.env, NODE_OPTIONS: "--trace-deprecation" },
      encoding: "utf8",
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(
      `banking native invariant suite failed with exit status ${result.status ?? "unknown"}`,
    );
  }
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const checkpoint = `bank-reconciliation-${marker}-native`;
  saveJson(join(evidenceDir, `${checkpoint}.json`), {
    checkpoint,
    productSpecific: true,
    suite: "engine/src/banking.integration.test.ts",
    comparison: { ok: true },
    assertions: [
      "concurrent statement imports deduplicate exactly once per tenant and account",
      "concurrent reconciliation starts create exactly one open session",
      "manual and automatic matches require exact transaction-currency cross-footing",
      "cross-tenant, wrong-account, wrong-currency, and post-cutoff journal lines fail closed",
      "sign-off rejects unmatched lines and records mandatory exclusion evidence",
      "concurrent sign-off retries return one permanent reconciliation result",
      "signed-off journal stamps, matches, statement truth, and exclusion decisions are immutable",
      "exclusion, restoration, and sign-off actor evidence is append-only in the audit log",
    ],
  });
  console.log(`PASS ${checkpoint}`);
}

function runGlReplayNativeInvariants(): void {
  const testFiles = [
    join(repoRoot, "engine", "src", "gl-regeneration.integration.test.ts"),
    join(repoRoot, "engine", "src", "document-correction.integration.test.ts"),
  ];
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-force-exit", ...testFiles],
    {
      cwd: repoRoot,
      env: { ...process.env, NODE_OPTIONS: "--trace-deprecation" },
      encoding: "utf8",
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(
      `GL replay native invariant suite failed with exit status ${result.status ?? "unknown"}`,
    );
  }
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const checkpoint = `gl-replay-${marker}-native`;
  saveJson(join(evidenceDir, `${checkpoint}.json`), {
    checkpoint,
    productSpecific: true,
    suite: [
      "engine/src/gl-regeneration.integration.test.ts",
      "engine/src/document-correction.integration.test.ts",
    ],
    comparison: { ok: true },
    assertions: [
      "historical replay requires an explicit migration context",
      "unchanged projections are deterministic and idempotent",
      "memo-only source edits never rewrite ledger evidence",
      "base-amount, transaction-currency, FX-rate, scope, account, or dimension changes fail closed",
      "a rejected source amendment rolls back its document and lines atomically",
      "posted journal ids and every financial field remain byte-for-byte unchanged",
      "one idempotent correction draft is linked to each retained posted source",
      "a correction cannot be submitted until the controlled source void completes",
      "the exact original entry, exact reversal, and replacement entry form a permanent chain",
      "correction reason, actor, timestamp, audit envelope, and link are immutable",
    ],
  });
  console.log(`PASS ${checkpoint}`);
}

function runInventoryAdvancedNativeInvariants(): void {
  const testFile = join(
    repoRoot,
    "engine",
    "src",
    "inventory.integration.test.ts",
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-force-exit", testFile],
    {
      cwd: repoRoot,
      env: { ...process.env, NODE_OPTIONS: "--trace-deprecation" },
      encoding: "utf8",
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(
      `advanced inventory native invariant suite failed with exit status ${result.status ?? "unknown"}`,
    );
  }
  const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const checkpoint = `inventory-advanced-${marker}-native`;
  saveJson(join(evidenceDir, `${checkpoint}.json`), {
    checkpoint,
    openbooksNative: true,
    suite: "engine/src/inventory.integration.test.ts",
    comparison: { ok: true },
    assertions: [
      "FIFO, moving-average, and standard-cost receipts and issues keep GL equal to exact layer value",
      "negative stock is opt-in, provisionally costed, and later receipts post exact true-up evidence",
      "minimum 0.0001 landed-cost units and value, quantity, weight, and manual vouchers never create subledger rounding drift",
      "concurrent transfers and assembly builds serialize availability and cannot oversell",
      "a downstream transfer-order posting failure rolls back movements, layers, order state, and GL atomically",
      "lot consumption is limited to the selected tenant-owned lot even when aggregate item stock is sufficient",
      "serial receipt, transfer, shipment, and controlled reversal retain an enforced location/status lifecycle",
      "posted receipt, issue, and transfer corrections are append-only, concurrency-idempotent, and fully linked",
    ],
    remaining:
      "ERPNext differential Stock Reconciliation, Manufacture Stock Entry, and Landed Cost Voucher comparisons",
  });
  console.log(`PASS ${checkpoint}`);
}

async function cleanupInterruptedTaxReturns(): Promise<void> {
  const manifest = readManifest();
  const client = new ErpNextParityClient(erpConfig());
  const openbooks = (await db.execute<{ id: string }>(sql`
    select id
      from documents
     where org_id = ${manifest.openbooks.orgId}
       and kind = 'customer_credit'
       and status = 'posted'
       and document_number like 'PARITY-TAX-CUSTOMER_CREDIT-sales-tax-return-%'
     order by created_at
  `));
  for (const document of openbooks.rows) {
    await requestDocumentVoid({
      documentId: document.id,
      orgId: manifest.openbooks.orgId,
      actorId: manifest.openbooks.actorId,
      reason: "Cleanup interrupted ERPNext parity discovery run",
      reversalDate: "2026-07-15",
      source: "api",
    });
  }

  const erpnext = await client.list<{ name: string }>(
    "Sales Invoice",
    ["name"],
    [
      ["company", "=", manifest.erpnext.company],
      ["is_return", "=", 1],
      ["docstatus", "=", 1],
    ],
    "creation asc",
    100,
  );
  for (const invoice of erpnext)
    await client.cancel("Sales Invoice", invoice.name);
  console.log(
    JSON.stringify(
      {
        openbooksControlledReversals: openbooks.rows.length,
        erpnextCancellations: erpnext.length,
      },
      null,
      2,
    ),
  );
}

function matrix(): void {
  for (const row of GL_COVERAGE_MATRIX) {
    console.log(
      `${row.disposition.padEnd(14)} ${row.capability} :: ${row.checkpoints.join(", ")}`,
    );
  }
}

try {
  switch (process.argv[2]) {
    case "provision":
      await provision();
      break;
    case "status":
      await status();
      break;
    case "run-journal":
      await runJournal();
      break;
    case "run-core":
      await runCore();
      break;
    case "run-secondary":
      await runSecondary();
      break;
    case "run-tax":
      await runTax();
      break;
    case "run-posting-rules":
      await runPostingRules();
      break;
    case "run-inventory":
      await runInventory();
      break;
    case "run-inventory-advanced":
      await runInventoryAdvanced();
      break;
    case "run-psp-native":
      runPspNativeInvariants();
      break;
    case "run-banking-native":
      runBankingNativeInvariants();
      break;
    case "run-gl-replay-native":
      runGlReplayNativeInvariants();
      break;
    case "run-document-corrections":
      await runDocumentCorrections();
      break;
    case "run-depreciation":
      await runDepreciationParity();
      break;
    case "run-asset-lifecycle":
      await runAssetLifecycleParity();
      break;
    case "run-fx-revaluation":
      await runFxRevaluationParity();
      break;
    case "run-fx-settlement":
      await runFxSettlementParity();
      break;
    case "run-revenue-recognition":
      await runRevenueRecognitionParity();
      break;
    case "run-project-recognition":
      await runProjectRecognitionParity();
      break;
    case "run-consolidation":
      await runConsolidationParity();
      break;
    case "run-income-tax-provision":
      await runIncomeTaxProvisionParity();
      break;
    case "run-sync-corrections":
      await runSyncCorrectionsParity();
      break;
    case "run-inventory-advanced-native":
      runInventoryAdvancedNativeInvariants();
      break;
    case "report":
      await report();
      break;
    case "cleanup-interrupted-tax-returns":
      await cleanupInterruptedTaxReturns();
      break;
    case "matrix":
      matrix();
      break;
    default:
      console.error(
        "usage: harness:ledger-parity -- provision|status|run-journal|run-core|run-secondary|run-document-corrections|run-depreciation|run-asset-lifecycle|run-fx-revaluation|run-fx-settlement|run-revenue-recognition|run-project-recognition|run-consolidation|run-income-tax-provision|run-sync-corrections|run-tax [case]|run-posting-rules|run-inventory|run-inventory-advanced|run-inventory-advanced-native|run-psp-native|run-banking-native|run-gl-replay-native|report|matrix|cleanup-interrupted-tax-returns",
      );
      process.exitCode = 2;
  }
} finally {
  await pool.end();
}
