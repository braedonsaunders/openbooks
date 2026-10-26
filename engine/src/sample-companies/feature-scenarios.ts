import { mul, sum } from "../money/money.ts";
import { sampleCompanyFeatures, sampleRosterCopy } from "./features.ts";
import { scenarioRecordId, type DemoContext } from "./scenarios.ts";
import { INDUSTRY_OPERATIONS, type AddDemoRecord } from "./industry-operations.ts";
import { CAP_TABLE_EMPLOYEES, storyDate } from "./cap-table-story.ts";

/** Editable native configuration; regulated facts and external credentials are deliberately absent. */
export function extendedFeatureRecords(c: DemoContext, add: AddDemoRecord): void {
  const f = sampleCompanyFeatures(c.industryKey);
  const id = (table: string, key = "main") => scenarioRecordId(c, table, key);
  add(
    "accounts",
    {
      number: "1097",
      name: "Operating receipts and disbursements",
      type: "asset_bank",
      subsidiary_id: c.subsidiaryId,
      currency_restriction: c.currency,
      reconcilable: true,
      is_active: true,
    },
    "operations-bank",
  );
  for (const [number, key, name] of [
    ["1094", "settlement-bank", "Supplier payments and customer receipts"],
    ["1096", "reserve-bank", "Operating reserve savings"],
    ["1095", "payroll-bank", "Payroll funding account"],
  ] as const)
    add(
      "accounts",
      {
        number,
        name,
        type: "asset_bank",
        subsidiary_id: c.subsidiaryId,
        currency_restriction: c.currency,
        reconcilable: true,
        is_active: true,
      },
      key,
    );
  const card = add(
    "accounts",
    {
      number: "2198",
      name: "Operations purchasing card",
      type: "liability_card",
      subsidiary_id: c.subsidiaryId,
      currency_restriction: c.currency,
      reconcilable: true,
      is_active: true,
    },
    "operations-card",
  );
  add("payment_cards", {
    holder_party_id: c.employeeId,
    liability_account_id: card,
    label: "Operations purchasing card — synthetic",
    last_four: "0000",
    network: "demo",
    is_active: true,
  });
  if (f.hrmTraining || f.hrmShiftPlanning) {
    const schedule = add("work_schedules", {
      name: sampleRosterCopy(c.industryKey).scheduleName,
      employee_party_id: c.employeeId,
      pattern: "cycle",
      cycle_days: 7,
      cycle_anchor: "2026-01-04",
      effective_from: c.date,
    });
    for (let n = 0; n < 7; n++)
      add(
        "work_schedule_days",
        { schedule_id: schedule, day_index: n, hours: n > 0 && n < 6 ? "8.00" : "0.00" },
        `weekday-${n}`,
      );
  }
  if (f.consignment)
    add(
      "stock_locations",
      {
        location_id: id("locations"),
        code: "DEMO-CONSIGN",
        kind: "warehouse",
        inventory_ownership: "vendor",
        owner_party_id: id("parties", "operations-vendor-1"),
      },
      "consignment",
    );
  if (f.einvoicing)
    add("einvoice_settings", {
      subsidiary_id: c.subsidiaryId,
      default_profile: "en16931-ubl",
      address_line1: "125 Market Street",
      city: "Redbrook",
      contact_name: "Accounts receivable",
      contact_email: "billing@example.invalid",
    });
  if (f.salesManagement) {
    const representative = add(
      "parties",
      {
        kind: "person",
        display_name: "Morgan Chen",
        subsidiary_id: c.subsidiaryId,
        is_active: true,
      },
      "commercial-representative",
    );
    add(
      "employee_roles",
      {
        party_id: representative,
        employee_number: "DEMO-SALES-001",
        job_title: "Commercial accounts representative",
        is_sales_rep: true,
        sales_rep_since: c.date,
      },
      "commercial-representative",
    );
    const team = add("crm_sales_teams", {
      key: "demo-commercial",
      name: "Commercial accounts",
      subsidiary_id: c.subsidiaryId,
    });
    add("crm_sales_team_members", {
      team_id: team,
      employee_id: representative,
      role: "member",
      valid_from: c.date,
    });
    for (const [index, name] of [
      "Local accounts",
      "Regional partners",
      "National accounts",
    ].entries()) {
      add(
        "crm_sales_quotas",
        {
          sales_team_id: team,
          subsidiary_id: c.subsidiaryId,
          name: `${name} operating target`,
          period_start: c.date,
          period_end: `${c.year}-12-31`,
          currency: c.currency,
          amount: ["75000.00", "125000.00", "250000.00"][index]!,
          reason: "Synthetic commercial planning target awaiting independent review",
        },
        `commercial-${index}`,
      );
      if (f.geographicTerritories)
        add(
          "crm_sales_territories",
          {
            key: `demo-territory-${index}`,
            name,
            sales_team_id: team,
            subsidiary_id: c.subsidiaryId,
            effective_from: c.date,
            is_active: false,
            description: "Draft coverage area; define supported geography before activation.",
          },
          `commercial-${index}`,
        );
    }
  }
  if (f.promotions)
    for (const [index, name] of [
      "New customer introduction",
      "Seasonal replenishment",
      "Volume commitment",
    ].entries())
      add(
        "promotions",
        {
          code: `DEMO-OFFER-${index + 1}`,
          name,
          kind: "percent",
          percent_value: ["5.00", "7.50", "10.00"][index]!,
          currency: null,
          description: "Draft commercial offer for review before activation.",
        },
        `offer-${index}`,
      );
  if (f.storedValue) {
    const liability = add(
      "accounts",
      {
        number: "2397",
        name: "Customer stored value liability",
        type: "liability_current_other",
        is_active: true,
      },
      "stored-value",
    );
    for (const kind of ["gift_card", "store_credit"])
      add(
        "stored_value_programs",
        {
          name: kind === "gift_card" ? "Customer gift credit" : "Customer return credit",
          kind,
          liability_account_id: liability,
          currency: c.currency,
          breakage_policy: "none",
          is_active: false,
        },
        kind,
      );
  }
  if (f.internalBilling)
    add("internal_billing_rules", {
      code: "DEMO-COST-TRANSFER",
      name: "Shared operations cost transfer",
      method: "cost_transfer",
      debit_account_id: c.accounts.expense,
      credit_account_id: c.accounts.expense,
      effective_from: c.date,
      is_active: false,
      description: "Review source and destination departments before using a cost transfer.",
    });
  if (f.salesChannels)
    add("sales_channels", {
      kind: "shopify",
      name: "Trade counter storefront — disconnected",
      currency: c.currency,
      subsidiary_id: c.subsidiaryId,
      external_account: `demo-${c.orgId}.example.invalid`,
      status: "draft",
    });
  if (f.itemVariants) {
    const family = add("item_families", {
      code: "DEMO-MOUNT",
      name: "Mounting kit range",
      kind: "inventory",
      default_unit: "ea",
      default_rate: "95.00",
    });
    add("item_family_options", {
      family_id: family,
      position: 1,
      name: "Finish",
      values: ["Zinc", "Black", "Stainless"],
    });
    for (const finish of ["Zinc", "Black", "Stainless"])
      add(
        "items",
        {
          code: `DEMO-MOUNT-${finish.toUpperCase()}`,
          name: `${finish} mounting kit`,
          kind: "inventory",
          unit: "ea",
          family_id: family,
          option_values: { Finish: finish },
          income_account_id: c.accounts.revenue,
          expense_account_id: c.accounts.expense,
          default_rate: "95.00",
        },
        `variant-${finish}`,
      );
  }
  if (f.shippingHub)
    for (const [index, name] of [
      "Small parts carton",
      "Assembly carton",
      "Trade replenishment carton",
    ].entries())
      add(
        "package_presets",
        {
          name,
          length: ["20.00", "40.00", "60.00"][index]!,
          width: "30.00",
          height: "20.00",
          weight: ["1.00", "4.00", "8.00"][index]!,
          dim_unit: "cm",
          weight_unit: "kg",
          is_default: false,
        },
        `package-${index}`,
      );
  if (f.demandPlanning)
    for (const key of ["component", "finished"])
      add(
        "demand_item_policies",
        {
          item_id: id("items", key),
          lead_time_days: 7,
          review_cycle_days: 7,
          service_level: "0.9500",
          moq_qty: "10.00",
          case_pack_qty: "5.00",
          preferred_supplier_id: id("parties", "operations-vendor-1"),
          forecast_method: "average",
          history_weeks: 26,
        },
        key,
      );
  if (f.quoteToCash)
    add(
      "subscription_plans",
      {
        name: "Demonstration annual platform agreement",
        amount: "2400.00",
        currency_code: c.currency,
        interval: "monthly",
        item_id: id("items", "operations-service-1"),
        income_account_id: c.accounts.revenue,
        is_active: true,
      },
      "operations-plan",
    );
  if (f.quoteToCash)
    add("quote_to_cash_settings", {
      max_discount_percent: "10.00",
      auto_activate_on_sign: false,
      default_billing_timing: "advance",
      default_start_rule: "first_of_next_month",
      signature_expiry_days: 14,
    });
  if (f.consolidatedBilling) {
    const group = add("consolidation_groups", {
      code: "DEMO-PAYER",
      name: "Enterprise shared-services billing",
      payer_party_id: id("parties", "operations-customer-1"),
      billing_subsidiary_id: c.subsidiaryId,
      cadence: "monthly",
      grouping: "by_child",
      is_active: false,
    });
    for (let n = 2; n <= 4; n++)
      add(
        "customer_billing_relationships",
        {
          child_party_id: id("parties", `operations-customer-${n}`),
          bill_to_party_id: id("parties", "operations-customer-1"),
          payer_party_id: id("parties", "operations-customer-1"),
          consolidation_group_id: group,
          effective_from: c.date,
        },
        `billing-child-${n}`,
      );
  }
  if (f.billingHistoryImport)
    add("billing_import_runs", {
      provider: "chargebee",
      external_account: `synthetic-${c.orgId}`,
      mode: "opening_balances",
      cutover_on: c.date,
      history_depth_months: 12,
      config: {
        description:
          "Synthetic migration planning; supply a reviewed source export before preflight.",
      },
    });
  if (f.autopay)
    for (let n = 1; n <= 3; n++)
      add(
        "autopay_enrollments",
        {
          party_id: id("parties", `operations-customer-${n}`),
          status: "paused",
          charge_on_issue: false,
        },
        `customer-${n}`,
      );
  if (f.customerPortal)
    add("customer_portal_settings", {
      effective_from: c.date,
      portal_name: `${c.companyName} customer centre`,
      sections: {
        invoices: true,
        paymentMethods: false,
        subscriptions: true,
        usage: true,
        orders: true,
        returns: false,
        giftCards: false,
      },
      return_window_days: 30,
    });
  if (f.revenueContracts)
    for (let n = 1; n <= 3; n++)
      add(
        "revenue_contracts",
        {
          customer_id: id("parties", `operations-customer-${n}`),
          contract_number: `DEMO-RC-${n}`,
          subsidiary_id: c.subsidiaryId,
          currency: c.currency,
          starts_on: c.date,
          ends_on: `${c.year + 1}-12-31`,
          total_transaction_price: ["28800.00", "48000.00", "96000.00"][n - 1]!,
          memo: "Draft platform and support agreement; review obligations and allocation before activation.",
        },
        `contract-${n}`,
      );
  if (f.rebateManagement) {
    const receivable = add(
      "accounts",
      {
        number: "1396",
        name: "Vendor rebates receivable",
        type: "asset_current_other",
        is_active: true,
      },
      "rebate-receivable",
    );
    const payable = add(
      "accounts",
      {
        number: "2396",
        name: "Customer rebates payable",
        type: "liability_current_other",
        is_active: true,
      },
      "rebate-payable",
    );
    const allowances = add(
      "accounts",
      { number: "4396", name: "Customer volume rebates", type: "income", is_active: true },
      "rebate-allowances",
    );
    const differences = add(
      "accounts",
      {
        number: "7396",
        name: "Rebate settlement exchange differences",
        type: "expense_other",
        is_active: true,
      },
      "rebate-differences",
    );
    const reason = "Draft volume terms awaiting independent commercial approval";
    add(
      "rebate_agreements",
      {
        code: "DEMO-SUPPLIER-VOLUME",
        name: `${INDUSTRY_OPERATIONS[c.industryKey]!.vendors[0]} annual purchase volume rebate`,
        status: "draft",
        subsidiary_id: c.subsidiaryId,
        side: "vendor",
        activity: "purchase",
        party_id: id("parties", "operations-vendor-1"),
        currency: c.currency,
        effective_from: `${c.year}-01-01`,
        effective_to: `${c.year}-12-31`,
        method: "percent",
        tier_basis: "amount",
        tiers: [
          { threshold: "0", rate: "1.5" },
          { threshold: "50000", rate: "2.5" },
          { threshold: "150000", rate: "4" },
        ],
        stacking: "best",
        selection_group: "supplier-volume",
        accrual_account_id: receivable,
        offset_account_id: c.accounts.expense,
        fx_account_id: differences,
        tax_treatment: "outside_scope",
        reason,
      },
      "supplier-volume",
    );
    add(
      "rebate_agreements",
      {
        code: "DEMO-CUSTOMER-GROWTH",
        name: `${INDUSTRY_OPERATIONS[c.industryKey]!.customers[0]} growth rebate`,
        status: "draft",
        subsidiary_id: c.subsidiaryId,
        side: "customer",
        activity: "sale",
        party_id: id("parties", "operations-customer-1"),
        currency: c.currency,
        effective_from: `${c.year}-01-01`,
        effective_to: `${c.year}-12-31`,
        method: "percent",
        tier_basis: "amount",
        tiers: [
          { threshold: "25000", rate: "1" },
          { threshold: "75000", rate: "2" },
        ],
        stacking: "best",
        selection_group: "customer-growth",
        accrual_account_id: payable,
        offset_account_id: allowances,
        fx_account_id: differences,
        tax_treatment: "outside_scope",
        reason,
      },
      "customer-growth",
    );
  }
  if (f.posRegister) {
    const drawer = add(
      "accounts",
      {
        number: "1092",
        name: "Trade counter cash drawer",
        type: "asset_current_other",
        subsidiary_id: c.subsidiaryId,
        currency_restriction: c.currency,
        is_active: true,
      },
      "pos-drawer",
    );
    const cards = add(
      "accounts",
      {
        number: "1093",
        name: "Card settlements clearing",
        type: "asset_current_other",
        subsidiary_id: c.subsidiaryId,
        currency_restriction: c.currency,
        is_active: true,
      },
      "pos-card-clearing",
    );
    const walkIn = add(
      "parties",
      { kind: "company", display_name: "Counter sales customer", is_active: true },
      "pos-walk-in",
    );
    add("customer_roles", { party_id: walkIn }, "pos-walk-in");
    add("pos_registers", {
      code: "DEMO-COUNTER-1",
      name: "Trade counter register",
      subsidiary_id: c.subsidiaryId,
      location_id: id("locations"),
      default_customer_id: walkIn,
      cash_account_id: drawer,
      card_account_id: cards,
      accepts_stored_value: f.storedValue === true,
      receipt_header: `${c.companyName}\nTrade counter`,
      receipt_footer: "Keep this receipt for returns within 30 days.",
      denominations: ["100", "50", "20", "10", "5", "1", "0.25", "0.10", "0.05"],
      is_active: true,
    });
  }
  if (f.multiBookAccounting)
    add(
      "accounting_books",
      {
        code: "DEMO-TAX",
        name: "Income tax basis book",
        is_primary: false,
        posts_gl: true,
        is_active: true,
      },
      "tax-book",
    );
  if (f.expenseAmortization) {
    const prepaid = add(
      "accounts",
      { number: "1291", name: "Prepaid insurance", type: "asset_current_other", is_active: true },
      "prepaid-insurance",
    );
    const insurance = add(
      "accounts",
      { number: "6491", name: "Insurance premiums", type: "expense", is_active: true },
      "insurance-expense",
    );
    add(
      "expense_amortization_templates",
      {
        code: "DEMO-ANNUAL-POLICY",
        name: "Annual policy over twelve months",
        description: "Releases a prepaid annual premium to expense in equal monthly amounts.",
        effective_from: `${c.year}-01-01`,
        method: "straight_line",
        term_source: "template",
        period_count: 12,
        deferral_account_id: prepaid,
        destination_account_id: insurance,
        period_offset: 0,
        is_active: true,
      },
      "annual-policy",
    );
  }
  if (f.equity) {
    add(
      "accounts",
      {
        number: "1091",
        name: "Financing proceeds account",
        type: "asset_bank",
        subsidiary_id: c.subsidiaryId,
        currency_restriction: c.currency,
        reconcilable: true,
        is_active: true,
      },
      "financing-bank",
    );
    for (const [number, key, name, type] of [
      ["3011", "common-stock", "Common stock", "equity"],
      ["3021", "preferred-stock", "Preferred stock", "equity"],
      ["3101", "apic", "Additional paid-in capital", "equity"],
      ["3111", "apic-share-based", "Paid-in capital — share-based compensation", "equity"],
      ["3201", "treasury-stock", "Treasury stock", "equity"],
      [
        "2601",
        "convertible-instruments",
        "SAFEs and convertible instruments",
        "liability_current_other",
      ],
      ["6411", "stock-compensation", "Stock-based compensation", "expense"],
      ["6421", "note-interest", "Convertible note interest", "expense"],
      [
        "2611",
        "accrued-note-interest",
        "Accrued convertible note interest",
        "liability_current_other",
      ],
      ["2621", "early-exercise-deposits", "Early-exercise deposits", "liability_current_other"],
    ] as const)
      add("accounts", { number, name, type, is_active: true }, key);
    for (const [key, name] of [
      ["founder-1", "Avery Quinn"],
      ["founder-2", "Rowan Ellis"],
    ] as const)
      add("parties", { kind: "person", display_name: name, is_active: true }, key);
    for (const [key, kind, name] of [
      ["seed-investor", "company", "Northbridge Seed Partners"],
      ["angel-investor", "person", "Priya Raman"],
      ["note-investor", "company", "Cascade Angel Syndicate"],
      ["seed-lead", "company", "Granite Peak Ventures"],
      ["series-a-lead", "company", "Meridian Growth Partners"],
      ["venture-lender", "company", "Harbor Bank Venture Lending"],
    ] as const)
      add("parties", { kind, display_name: name, is_active: true }, key);
    // Option and RSU holders are employees of the legal entity; one has left the company.
    for (const [index, holder] of CAP_TABLE_EMPLOYEES.entries()) {
      const party = add(
        "parties",
        { kind: "person", display_name: holder.name, is_active: true },
        holder.key,
      );
      add(
        "employee_roles",
        {
          party_id: party,
          employee_number: `NSC-${1001 + index}`,
          job_title: holder.title,
          hired_on: storyDate(c.year, holder.hired),
          ...(holder.left
            ? { terminated_on: storyDate(c.year, holder.left), is_active: false }
            : {}),
        },
        holder.key,
      );
    }
  }
  if (f.serviceDispatch) serviceDispatchRecords(c, add);
  if (f.contractCosts) {
    const asset = add(
      "accounts",
      {
        number: "1898",
        name: "Deferred customer acquisition costs",
        type: "asset_other",
        is_active: true,
      },
      "contract-cost",
    );
    add("contract_cost_policies", {
      effective_from: c.date,
      capitalize_commissions: true,
      capitalize_fulfilment: false,
      practical_expedient: true,
      basis: "contract_term",
      customer_life_source: "manual",
      asset_account_id: asset,
      amortization_expense_account_id: c.accounts.expense,
    });
  }
}

/** The technicians, sites, qualifications and estimates a field-service desk works from. */
export const SERVICE_TECHNICIANS = [
  {
    key: "technician-1",
    name: "Marcus Reyes",
    title: "Lead HVAC service technician",
    number: "DEMO-TECH-001",
    licensed: true,
  },
  {
    key: "technician-2",
    name: "Priya Nair",
    title: "HVAC service technician",
    number: "DEMO-TECH-002",
    licensed: true,
  },
  {
    key: "technician-3",
    name: "Caleb Morgan",
    title: "Refrigeration technician",
    number: "DEMO-TECH-003",
    licensed: false,
  },
] as const;

export const SERVICE_SITES = [
  {
    customer: 1,
    label: "Clubhouse mechanical room",
    line1: "48 Maplewood Drive",
    city: "Redbrook",
    postal: "12401",
  },
  {
    customer: 2,
    label: "Main Street clinic",
    line1: "210 Main Street",
    city: "Redbrook",
    postal: "12402",
  },
  {
    customer: 3,
    label: "Cedar Lane apartments",
    line1: "17 Cedar Lane",
    city: "Westfield",
    postal: "12406",
  },
  {
    customer: 4,
    label: "Fellowship hall",
    line1: "5 Hillcrest Road",
    city: "Westfield",
    postal: "12407",
  },
] as const;

function serviceDispatchRecords(c: DemoContext, add: AddDemoRecord): void {
  const id = (table: string, key = "main") => scenarioRecordId(c, table, key);
  for (const site of SERVICE_SITES) {
    add(
      "addresses",
      {
        party_id: id("parties", `operations-customer-${site.customer}`),
        label: site.label,
        line1: site.line1,
        city: site.city,
        region: "NY",
        postal_code: site.postal,
        country: "US",
      },
      `service-site-${site.customer}`,
    );
  }
  const gas = add(
    "hrm_qualification_types",
    {
      code: "DEMO-GAS-FITTER",
      name: "Gas fitter licence",
      category: "license",
      issuing_body: "Synthetic state licensing board",
      validity_months: 36,
    },
    "gas-fitter",
  );
  const refrigerant = add(
    "hrm_qualification_types",
    {
      code: "DEMO-EPA-608",
      name: "Refrigerant handling certification",
      category: "certification",
      issuing_body: "Synthetic certification program",
    },
    "refrigerant",
  );
  for (const technician of SERVICE_TECHNICIANS) {
    const party = add(
      "parties",
      {
        kind: "person",
        display_name: technician.name,
        subsidiary_id: c.subsidiaryId,
        is_active: true,
      },
      technician.key,
    );
    add(
      "employee_roles",
      {
        party_id: party,
        employee_number: technician.number,
        job_title: technician.title,
        hired_on: `${c.year - 3}-03-01`,
      },
      technician.key,
    );
    const employment = add(
      "worker_employments",
      {
        worker_party_id: party,
        employer_subsidiary_id: c.subsidiaryId,
        employment_number: technician.number,
        service_start: `${c.year - 3}-03-01`,
        service_start_provenance: "documented",
      },
      technician.key,
    );
    add(
      "worker_employment_versions",
      {
        employment_id: employment,
        version_no: 1,
        status: "active",
        effective_from: `${c.year - 3}-03-01`,
      },
      technician.key,
    );
    add(
      "hrm_worker_qualifications",
      {
        employment_id: employment,
        type_id: refrigerant,
        identifier: `${technician.number}-608`,
        issued_on: `${c.year - 3}-04-15`,
        notes: "Synthetic certification; evidence is reviewed before verification.",
      },
      `${technician.key}-refrigerant`,
    );
    if (technician.licensed)
      add(
        "hrm_worker_qualifications",
        {
          employment_id: employment,
          type_id: gas,
          identifier: `${technician.number}-GAS`,
          issued_on: `${c.year - 2}-01-10`,
          expires_on: `${c.year + 1}-01-09`,
          notes: "Synthetic licence; evidence is reviewed before verification.",
        },
        `${technician.key}-gas`,
      );
  }
  add(
    "items",
    {
      code: "DEMO-SVC-LABOUR",
      name: "Service technician labour",
      kind: "service",
      unit: "hour",
      income_account_id: c.accounts.revenue,
      expense_account_id: c.accounts.expense,
      default_rate: "125.00",
      show_on_timesheet: true,
    },
    "service-labour",
  );
  for (const [key, customer, number, memo, lines] of [
    [
      "service-estimate-rooftop",
      2,
      "DEMO-EST-101",
      "Rooftop unit replacement for the Main Street clinic",
      [
        [
          "operations-service-3",
          "Remove the failed rooftop unit and install a 5-ton high-efficiency replacement",
          "1.00",
          "9800.00",
        ],
        ["operations-service-4", "Add a whole-building air purification module", "1.00", "1450.00"],
      ],
    ],
    [
      "service-estimate-ductless",
      3,
      "DEMO-EST-102",
      "Ductless heat pump for the Cedar Lane community room",
      [
        [
          "operations-service-3",
          "Supply and install a 24,000 BTU ductless heat pump",
          "1.00",
          "6400.00",
        ],
        ["operations-service-2", "First-year maintenance visit", "1.00", "275.00"],
      ],
    ],
  ] as const) {
    const amount = sum(lines.map(([, , quantity, unitPrice]) => mul(quantity, unitPrice)));
    const document = add(
      "documents",
      {
        kind: "quote",
        document_number: number,
        party_id: id("parties", `operations-customer-${customer}`),
        subsidiary_id: c.subsidiaryId,
        document_date: c.date,
        currency: c.currency,
        memo,
        subtotal: amount,
        total: amount,
      },
      key,
    );
    lines.forEach(([item, description, quantity, unitPrice], index) =>
      add(
        "document_lines",
        {
          document_id: document,
          line_number: index + 1,
          item_id: id("items", item),
          account_id: c.accounts.revenue,
          description,
          quantity,
          unit_price: unitPrice,
          amount: mul(quantity, unitPrice),
          subsidiary_id: c.subsidiaryId,
        },
        `${key}-${index + 1}`,
      ),
    );
  }
}
