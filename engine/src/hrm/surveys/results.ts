/**
 * HR-19 survey results: pure aggregation over loaded responses.
 *
 * No imports from any engine module — the service loads rows and hands
 * them here, so unit tests exercise the exact arithmetic the results page
 * and the report entity serve (never double a pure function).
 *
 * Anonymity contract, enforced by shape:
 * - eNPS = promoters (9–10) minus detractors (0–6) on the 0–10 question,
 *   as integer percentage points.
 * - Driver scores = mean of scale answers grouped by driver_key.
 * - Heatmap = driver × segment means. A cell with fewer than
 *   min_group_size responses returns null with suppressed: true — never
 *   a number, never a count that singles someone out.
 * - Comment lists carry no respondent link, ever.
 */

export interface ResultAnswer {
  questionId: string;
  kind: string;
  driverKey: string | null;
  /** Numeric value for scale/enps/single-index; null for text/multi. */
  value: number | null;
  /** Raw option(s) for single/multi; text for text. */
  raw: unknown;
  segment: string | null;
}

export interface QuestionAggregate {
  questionId: string;
  kind: string;
  responses: number;
  mean: number | null;
  distribution: { value: string; count: number }[];
}

export interface EnpsResult {
  score: number | null;
  promoters: number;
  passives: number;
  detractors: number;
  responses: number;
}

export function computeEnps(values: number[]): EnpsResult {
  const valid = values.filter((v) => Number.isInteger(v) && v >= 0 && v <= 10);
  if (valid.length === 0) {
    return { score: null, promoters: 0, passives: 0, detractors: 0, responses: 0 };
  }
  const promoters = valid.filter((v) => v >= 9).length;
  const detractors = valid.filter((v) => v <= 6).length;
  const passives = valid.length - promoters - detractors;
  return {
    score: Math.round((promoters / valid.length) * 100) - Math.round((detractors / valid.length) * 100),
    promoters,
    passives,
    detractors,
    responses: valid.length,
  };
}

export function aggregateQuestion(
  questionId: string,
  kind: string,
  answers: ResultAnswer[],
): QuestionAggregate {
  const mine = answers.filter((a) => a.questionId === questionId);
  const distribution = new Map<string, number>();
  const numerics: number[] = [];
  for (const answer of mine) {
    if (answer.value !== null && Number.isFinite(answer.value)) numerics.push(answer.value);
    const key =
      answer.raw === null || answer.raw === undefined
        ? "—"
        : Array.isArray(answer.raw)
          ? answer.raw.map((v) => String(v)).sort().join(" + ") || "—"
          : String(answer.raw);
    // Text answers aggregate by presence only in counts — the comment
    // list (separate reader, group-gated) carries the words.
    distribution.set(answer.kind === "text" ? "answered" : key, (distribution.get(answer.kind === "text" ? "answered" : key) ?? 0) + 1);
  }
  return {
    questionId,
    kind,
    responses: mine.length,
    mean:
      numerics.length > 0 ? Math.round((numerics.reduce((a, b) => a + b, 0) / numerics.length) * 100) / 100 : null,
    distribution: [...distribution.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** Mean scale score per driver key (drivers group scale questions). */
export function driverScores(answers: ResultAnswer[]): { driver: string; mean: number; responses: number }[] {
  const byDriver = new Map<string, number[]>();
  for (const answer of answers) {
    if (!answer.driverKey || answer.kind !== "scale" || answer.value === null) continue;
    const list = byDriver.get(answer.driverKey) ?? [];
    list.push(answer.value);
    byDriver.set(answer.driverKey, list);
  }
  return [...byDriver.entries()]
    .map(([driver, values]) => ({
      driver,
      mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
      responses: values.length,
    }))
    .sort((a, b) => a.driver.localeCompare(b.driver));
}

export interface HeatmapCell {
  mean: number | null;
  responses: number;
  suppressed: boolean;
}

export interface Heatmap {
  drivers: string[];
  segments: string[];
  cells: Record<string, Record<string, HeatmapCell>>;
}

/**
 * Driver × segment heatmap with minimum-group suppression. Cells below
 * min_group_size return null + suppressed: true — never a number that
 * could be traced to one respondent.
 */
export function heatmap(
  answers: ResultAnswer[],
  minGroupSize: number,
): Heatmap {
  const drivers = [...new Set(answers.filter((a) => a.driverKey && a.kind === "scale").map((a) => a.driverKey!))].sort();
  const segments = [...new Set(answers.map((a) => a.segment).filter((s): s is string => !!s))].sort();
  const cells: Record<string, Record<string, HeatmapCell>> = {};
  for (const driver of drivers) {
    cells[driver] = {};
    for (const segment of segments) {
      const values = answers
        .filter((a) => a.driverKey === driver && a.segment === segment && a.value !== null)
        .map((a) => a.value!);
      if (values.length < minGroupSize) {
        cells[driver]![segment] = { mean: null, responses: values.length, suppressed: true };
      } else {
        cells[driver]![segment] = {
          mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
          responses: values.length,
          suppressed: false,
        };
      }
    }
  }
  return { drivers, segments, cells };
}
