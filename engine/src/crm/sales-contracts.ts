export type SalesMetric = "closed_won" | "net_invoiced";
export type SalesPage =
  "overview" | "representatives" | "teams" | "quotas" | "territories";
export type SalesScope = {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
};
export type Position = [number, number];
export type AreaGeometry =
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };
export type BoundarySelection = {
  country: string;
  level: "ADM0" | "ADM1" | "ADM2";
  id: string;
  name: string;
  version: string;
  geometry: AreaGeometry;
};
export type TerritoryGeography = {
  version: 1;
  includes: BoundarySelection[];
  excludes: BoundarySelection[];
  polygons: { id: string; name: string; geometry: AreaGeometry }[];
};
export const EMPTY_TERRITORY_GEOGRAPHY: TerritoryGeography = {
  version: 1,
  includes: [],
  excludes: [],
  polygons: [],
};
export type SalesRepTrend = {
  months: string[];
  points: {
    month: string;
    currency: string;
    metric: SalesMetric;
    amount: string;
  }[];
};
export type SalesRecord = {
  id: string;
  name: string;
  revision: number;
  updated_at?: string;
  subsidiary_id: string | null;
  is_active?: boolean;
  manager_employee_id?: string | null;
  default_employee_id?: string | null;
  employee_id?: string | null;
  sales_team_id?: string | null;
  manager_name?: string | null;
  employee_name?: string | null;
  team_name?: string | null;
  member_count?: number;
  members?: {
    employeeId: string;
    role: "manager" | "member";
    validFrom: string;
    validTo: string | null;
  }[];
  description?: string | null;
  priority?: number;
  rules?: import("./crm-math.ts").TerritoryRule[];
  match_mode?: "all" | "any";
  geography?: TerritoryGeography;
  effective_from?: string;
  lifecycle?: string;
  period_start?: string;
  period_end?: string;
  currency?: string;
  amount?: string;
  actual?: string;
  metric?: SalesMetric;
  parent_quota_id?: string | null;
  supersedes_id?: string | null;
  reason?: string | null;
  created_by?: string | null;
  approved_by?: string | null;
  is_sales_rep?: boolean;
  sales_rep_since?: string | null;
  employee_number?: string | null;
  job_title?: string | null;
  department_name?: string | null;
  repTrend?: SalesRepTrend;
  repSummary?: {
    customers: number | null;
    openOpportunities: number | null;
    teams: number;
    quotas: number;
  };
};
export type SalesOption = {
  id: string;
  name: string;
  subsidiary_id: string | null;
};
export type SalesCustomerLocation = {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  employeeId: string | null;
  territoryId: string | null;
};
export type SalesWorkspaceData = {
  departments: SalesOption[];
  customerLocations: SalesCustomerLocation[];
  customerLocationStats: { total: number; located: number };
  mapTerritories: SalesRecord[];
  reports: { quota: string; evidence: string };
  quotaOptions: (SalesOption & {
    lifecycle: string;
    sales_team_id: string | null;
  })[];
  page: SalesPage;
  rows: SalesRecord[];
  total: number;
  currentPage: number;
  perPage: number;
  employees: SalesOption[];
  representatives: SalesOption[];
  teams: SalesOption[];
  subsidiaries: SalesOption[];
  currencies: { code: string; name: string }[];
  baseCurrency: string;
  multiCurrency: boolean;
  mapEnabled: boolean;
  canManage: boolean;
  canApprove: boolean;
  selected: SalesRecord | null;
  creating: boolean;
  periodStart: string;
  periodEnd: string;
  summary: {
    currency: string;
    metric: SalesMetric;
    quota: string;
    actual: string;
  }[];
  counts: {
    representatives: number;
    teams: number;
    territories: number;
    draftQuotas: number;
    unattributed: number;
    undated: number;
  };
};
export type SalesCommand =
  | {
      action: "representative";
      employeeId: string;
      enabled: boolean;
      since: string;
      expectedRevision: string;
    }
  | {
      action: "team";
      id?: string;
      expectedRevision?: number;
      name: string;
      subsidiaryId: string;
      managerEmployeeId: string | null;
      isActive: boolean;
      members: {
        employeeId: string;
        role: "manager" | "member";
        validFrom: string;
      }[];
    }
  | {
      action: "territory";
      id?: string;
      expectedRevision?: number;
      name: string;
      subsidiaryId: string;
      managerEmployeeId: string | null;
      defaultEmployeeId: string | null;
      salesTeamId: string | null;
      description: string;
      priority: number;
      rules: import("./crm-math.ts").TerritoryRule[];
      matchMode: "all" | "any";
      geography: TerritoryGeography;
      effectiveFrom: string;
      lifecycle: "draft" | "active" | "archived";
      previewRevision?: string;
    }
  | {
      action: "quota";
      id?: string;
      expectedRevision?: number;
      name: string;
      subsidiaryId: string;
      employeeId: string | null;
      salesTeamId: string | null;
      parentQuotaId: string | null;
      supersedesId: string | null;
      reason: string;
      periodStart: string;
      periodEnd: string;
      currency: string;
      amount: string;
      metric: SalesMetric;
    }
  | {
      action: "quota-transition";
      id: string;
      expectedRevision: number;
      lifecycle: "draft" | "pending_approval" | "approved" | "closed";
      reason: string;
    };
