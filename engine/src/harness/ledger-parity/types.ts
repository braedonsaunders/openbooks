export type CanonicalDimension = {
  party?: string | null;
  project?: string | null;
  costCenter?: string | null;
};

/**
 * One canonical GL row. `amount` is an exact four-decimal, debit-positive
 * functional-currency amount. Account keys are semantic and deliberately
 * independent of either product's generated ids or display names.
 */
export interface CanonicalGlLine extends CanonicalDimension {
  account: string;
  amount: string;
}

export interface CanonicalGlSnapshot {
  source: "openbooks" | "erpnext";
  company: string;
  checkpoint: string;
  lines: CanonicalGlLine[];
}

export interface GlDifference {
  key: string;
  openbooks: string;
  erpnext: string;
  delta: string;
}

export interface GlComparison {
  ok: boolean;
  openbooksBalanced: boolean;
  erpnextBalanced: boolean;
  differences: GlDifference[];
}

export interface ErpNextConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  company: string;
}

export interface ParityManifest {
  schemaVersion: 1;
  createdAt: string;
  companyName: string;
  currency: "CAD";
  fiscalYear: 2026;
  openbooks: {
    orgId: string;
    subsidiaryId: string;
    periodId: string;
    bookId: string;
    actorId: string;
    customerId: string;
    vendorId: string;
    employeeId?: string;
    paymentCardId?: string;
    projectId?: string;
    inventory?: {
      itemId: string;
      stockLocationId: string;
      stockLocation2Id: string;
    };
    accounts: Record<string, string>;
  };
  erpnext: {
    company: string;
    abbreviation: string;
    customer: string;
    supplier: string;
    serviceItem: string;
    project?: string;
    inventory?: {
      item: string;
      warehouse: string;
      warehouse2: string;
      stockAdjustmentAccount: string;
    };
    accounts: Record<string, string>;
    costCenter: string;
  };
  accountMap: {
    openbooks: Record<string, string>;
    erpnext: Record<string, string>;
  };
}
