import "server-only";
import { AppRenderSpan } from "next/dist/server/lib/trace/constants";
import { normalizeAppPath } from "next/dist/shared/lib/router/utils/app-paths";
import type { SpanProcessor } from "@openbooks/engine/src/platform/telemetry.ts";

const MAX_COMPLETED_RENDERS = 10_000;

export interface RenderProfileSummary {
  /** Completed native render spans, independent of idle-closed database profiles. */
  routes: Array<{
    route: string;
    renders: number;
    failedRenders: number;
    durationMs: { mean: number; p95: number; max: number; total: number };
  }>;
  /** Completed renders omitted after the bounded window fills. */
  droppedRenders: number;
}

/**
 * Next ends AppRender.getBodyResult after streamed React content is ready.
 * Keep only its compiled route pattern and duration, never request URLs,
 * span names, exceptions, headers, attributes or tenant identifiers.
 */
export function createRenderProfile() {
  let routes = new Map<string, { durations: number[]; failedRenders: number }>();
  let completed = 0;
  let droppedRenders = 0;
  const processor: SpanProcessor = {
    onStart() {},
    onEnd(span) {
      if (span.attributes["next.span_type"] !== AppRenderSpan.getBodyResult) return;
      const route = span.attributes["next.route"];
      if (typeof route !== "string" || !route.startsWith("/") || route.length > 500 ||
          /[?#%\s]/.test(route)) return;
      const [seconds, nanos] = span.duration;
      const durationMs = seconds * 1_000 + nanos / 1_000_000;
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      if (completed >= MAX_COMPLETED_RENDERS) {
        droppedRenders += 1;
        return;
      }
      const pattern = normalizeAppPath(route);
      let window = routes.get(pattern);
      if (!window) {
        window = { durations: [], failedRenders: 0 };
        routes.set(pattern, window);
      }
      window.durations.push(durationMs);
      if (span.status.code === 2) window.failedRenders += 1;
      completed += 1;
    },
    async forceFlush() {},
    async shutdown() {},
  };

  function summarize(): RenderProfileSummary {
    const round = (value: number) => Math.round(value * 100) / 100;
    const result: RenderProfileSummary = {
      routes: [...routes].map(([route, { durations, failedRenders }]) => {
        durations.sort((a, b) => a - b);
        const total = durations.reduce((sum, duration) => sum + duration, 0);
        return {
          route,
          renders: durations.length,
          failedRenders,
          durationMs: {
            mean: round(total / durations.length),
            p95: round(durations[Math.ceil(durations.length * 0.95) - 1]!),
            max: round(durations[durations.length - 1]!),
            total: round(total),
          },
        };
      }).sort((a, b) => b.durationMs.total - a.durationMs.total || a.route.localeCompare(b.route)),
      droppedRenders,
    };
    routes = new Map();
    completed = 0;
    droppedRenders = 0;
    return result;
  }

  return { processor, summarize };
}
