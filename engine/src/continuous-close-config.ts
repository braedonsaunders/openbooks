import { fromUnits, toUnits } from "./money.ts";

export const CONTINUOUS_CLOSE_AGENT_KEYS = ["accounting", "finance"] as const;
export type ContinuousCloseAgentKey = (typeof CONTINUOUS_CLOSE_AGENT_KEYS)[number];

export type AgentModelTier = "fast" | "smart";

/**
 * Model-driven work is independently controllable from deterministic controls.
 * The model may investigate, explain, and recommend; it never posts or mutates
 * accounting records.
 */
export type ContinuousCloseAnalysisSettings = {
  rootCauseAnalysis: boolean;
  recommendations: boolean;
  narrative: boolean;
  modelTier: AgentModelTier;
  maxToolSteps: number;
};

export function defaultContinuousCloseAnalysisSettings(): ContinuousCloseAnalysisSettings {
  return {
    rootCauseAnalysis: true,
    recommendations: true,
    narrative: true,
    modelTier: "smart",
    maxToolSteps: 16,
  };
}

/** Canonicalize persisted/API analysis controls and clamp the agent loop. */
export function normalizeContinuousCloseAnalysisSettings(raw: unknown): ContinuousCloseAnalysisSettings {
  const row = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const maxToolSteps = row.maxToolSteps === undefined ? 16 : Number(row.maxToolSteps);
  if (!Number.isInteger(maxToolSteps) || maxToolSteps < 4 || maxToolSteps > 30) {
    throw new Error("invalid agent tool step limit");
  }
  return {
    rootCauseAnalysis: row.rootCauseAnalysis !== false,
    recommendations: row.recommendations !== false,
    narrative: row.narrative !== false,
    modelTier: row.modelTier === "fast" ? "fast" : "smart",
    maxToolSteps,
  };
}

export type DetectorParameterSpec = {
  key: string;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  unit: "days" | "count" | "percent" | "multiple" | "points";
};

export type ContinuousCloseDetectorSpec = {
  detectorKey: string;
  agentKey: ContinuousCloseAgentKey;
  supportsMateriality: boolean;
  parameters: readonly DetectorParameterSpec[];
};

/**
 * The detector registry is the single source of truth for runtime execution,
 * tenant configuration validation, and the admin configuration UI.
 */
export const CONTINUOUS_CLOSE_DETECTOR_SPECS = [
  {
    detectorKey: "unmatched_bank_activity",
    agentKey: "accounting",
    supportsMateriality: true,
    parameters: [
      {
        key: "criticalAgeDays",
        defaultValue: 30,
        min: 1,
        max: 365,
        step: 1,
        unit: "days",
      },
      {
        key: "criticalItemCount",
        defaultValue: 50,
        min: 1,
        max: 10_000,
        step: 1,
        unit: "count",
      },
      {
        key: "criticalMaterialityMultiple",
        defaultValue: 5,
        min: 1,
        max: 100,
        step: 1,
        unit: "multiple",
      },
    ],
  },
  {
    detectorKey: "reconciliation_difference",
    agentKey: "accounting",
    supportsMateriality: true,
    parameters: [],
  },
  {
    detectorKey: "stale_accounting_documents",
    agentKey: "accounting",
    supportsMateriality: true,
    parameters: [
      {
        key: "staleAfterDays",
        defaultValue: 7,
        min: 1,
        max: 365,
        step: 1,
        unit: "days",
      },
      {
        key: "criticalItemCount",
        defaultValue: 20,
        min: 1,
        max: 10_000,
        step: 1,
        unit: "count",
      },
      {
        key: "criticalMaterialityMultiple",
        defaultValue: 5,
        min: 1,
        max: 100,
        step: 1,
        unit: "multiple",
      },
    ],
  },
  {
    detectorKey: "missing_approved_budget",
    agentKey: "finance",
    supportsMateriality: false,
    parameters: [],
  },
  {
    detectorKey: "unfavorable_budget_variance",
    agentKey: "finance",
    supportsMateriality: true,
    parameters: [
      {
        key: "minimumVariancePercent",
        defaultValue: 10,
        min: 0,
        max: 1_000,
        step: 1,
        unit: "percent",
      },
      {
        key: "criticalVariancePercent",
        defaultValue: 25,
        min: 0,
        max: 1_000,
        step: 1,
        unit: "percent",
      },
    ],
  },
  {
    detectorKey: "period_revenue_decline",
    agentKey: "finance",
    supportsMateriality: true,
    parameters: [
      {
        key: "minimumDeclinePercent",
        defaultValue: 10,
        min: 0,
        max: 100,
        step: 1,
        unit: "percent",
      },
      {
        key: "criticalDeclinePercent",
        defaultValue: 25,
        min: 0,
        max: 100,
        step: 1,
        unit: "percent",
      },
    ],
  },
  {
    detectorKey: "gross_margin_decline",
    agentKey: "finance",
    supportsMateriality: true,
    parameters: [
      {
        key: "minimumDropPoints",
        defaultValue: 5,
        min: 0,
        max: 100,
        step: 1,
        unit: "points",
      },
      {
        key: "criticalDropPoints",
        defaultValue: 10,
        min: 0,
        max: 100,
        step: 1,
        unit: "points",
      },
    ],
  },
] as const satisfies readonly ContinuousCloseDetectorSpec[];

export type ContinuousCloseDetectorKey = (typeof CONTINUOUS_CLOSE_DETECTOR_SPECS)[number]["detectorKey"];

export type ContinuousCloseDetectorPolicy = {
  detectorKey: ContinuousCloseDetectorKey;
  enabled: boolean;
  /** Null inherits the agent-level materiality threshold. */
  materialityThreshold: string | null;
  parameters: Record<string, number>;
};

export function detectorSpecsForAgent(agentKey: ContinuousCloseAgentKey): ContinuousCloseDetectorSpec[] {
  return CONTINUOUS_CLOSE_DETECTOR_SPECS.filter((spec) => spec.agentKey === agentKey);
}

export function defaultContinuousCloseDetectors(agentKey: ContinuousCloseAgentKey): ContinuousCloseDetectorPolicy[] {
  return detectorSpecsForAgent(agentKey).map((spec) => ({
    detectorKey: spec.detectorKey as ContinuousCloseDetectorKey,
    enabled: true,
    materialityThreshold: null,
    parameters: Object.fromEntries(spec.parameters.map((parameter) => [parameter.key, parameter.defaultValue])),
  }));
}

/** Canonicalize untrusted API or persisted JSON against the detector registry. */
export function normalizeContinuousCloseDetectors(agentKey: ContinuousCloseAgentKey, raw: unknown): ContinuousCloseDetectorPolicy[] {
  const input = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      if (typeof row.detectorKey === "string") input.set(row.detectorKey, row);
    }
  } else if (raw && typeof raw === "object") {
    for (const [detectorKey, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        input.set(detectorKey, value as Record<string, unknown>);
      }
    }
  }

  return detectorSpecsForAgent(agentKey).map((spec) => {
    const row = input.get(spec.detectorKey) ?? {};
    const rawMateriality = row.materialityThreshold;
    let materialityThreshold: string | null = null;
    if (spec.supportsMateriality && rawMateriality !== undefined && rawMateriality !== null && String(rawMateriality).trim() !== "") {
      try {
        const units = toUnits(String(rawMateriality).trim());
        if (units < 0n) throw new Error("negative");
        materialityThreshold = fromUnits(units);
      } catch {
        throw new Error(`invalid materiality threshold for ${spec.detectorKey}`);
      }
    }

    const rawParameters = row.parameters && typeof row.parameters === "object" && !Array.isArray(row.parameters) ? (row.parameters as Record<string, unknown>) : {};
    const parameters = Object.fromEntries(
      spec.parameters.map((parameter) => {
        const value = rawParameters[parameter.key] === undefined ? parameter.defaultValue : Number(rawParameters[parameter.key]);
        if (!Number.isFinite(value) || !Number.isInteger(value) || value < parameter.min || value > parameter.max) {
          throw new Error(`invalid detector parameter ${spec.detectorKey}.${parameter.key}`);
        }
        return [parameter.key, value];
      }),
    );
    const orderedPairs: [string, string][] = [
      ["minimumVariancePercent", "criticalVariancePercent"],
      ["minimumDeclinePercent", "criticalDeclinePercent"],
      ["minimumDropPoints", "criticalDropPoints"],
    ];
    for (const [minimum, critical] of orderedPairs) {
      if (parameters[minimum] !== undefined && parameters[critical] !== undefined && parameters[critical] < parameters[minimum]) {
        throw new Error(`invalid detector parameter order ${spec.detectorKey}.${critical}`);
      }
    }
    return {
      detectorKey: spec.detectorKey as ContinuousCloseDetectorKey,
      enabled: row.enabled !== false,
      materialityThreshold,
      parameters,
    };
  });
}

export function serializeContinuousCloseDetectors(detectors: readonly ContinuousCloseDetectorPolicy[]): Record<string, Omit<ContinuousCloseDetectorPolicy, "detectorKey">> {
  return Object.fromEntries(detectors.map(({ detectorKey, ...policy }) => [detectorKey, policy]));
}

export function effectiveDetectorMateriality(detector: ContinuousCloseDetectorPolicy, agentThreshold: string): string {
  return detector.materialityThreshold ?? agentThreshold;
}

export function enabledDetectorKeys(detectors: readonly ContinuousCloseDetectorPolicy[]): ContinuousCloseDetectorKey[] {
  return detectors.filter((detector) => detector.enabled).map((detector) => detector.detectorKey);
}
