import assert from "node:assert/strict";
import test from "node:test";
import { getTracer } from "next/dist/server/lib/trace/tracer";
import { AppRenderSpan } from "next/dist/server/lib/trace/constants";
import { startTelemetry, stopTelemetry } from "@openbooks/engine/src/platform/telemetry.ts";
import { createRenderProfile } from "./render-profile";

test("native Next render completion reaches the local profile without a collector and excludes request data", async () => {
  const profile = createRenderProfile();
  assert.equal(await startTelemetry({}), false);
  assert.equal(await startTelemetry({ OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "none" }, [profile.processor]), true);
  try {
    const tracer = getTracer();
    const pending = tracer.startSpan(AppRenderSpan.getBodyResult, {
      startTime: [1, 0],
      attributes: {
        "next.span_type": AppRenderSpan.getBodyResult,
        "next.route": "/(app)/parties/[id]/page",
        "http.url": "https://example.test/parties/private-id?token=secret",
      },
    });
    pending.recordException(new Error("private-id secret"));
    pending.setStatus({ code: 2, message: "private-id secret" });
    assert.deepEqual(profile.summarize(), { routes: [], droppedRenders: 0 }, "unfinished renders never count");
    pending.end([1, 250_000_000]);
    for (const ms of [50, 100]) {
      const span = tracer.startSpan(AppRenderSpan.getBodyResult, {
        startTime: [2, 0],
        attributes: { "next.span_type": AppRenderSpan.getBodyResult, "next.route": "/(app)/parties/[id]/page" },
      });
      span.end([2, ms * 1_000_000]);
    }
    const unrelated = tracer.startSpan(AppRenderSpan.getBodyResult, {
      attributes: { "next.span_type": "AppRender.fetch", "next.route": "/private-id" },
    });
    unrelated.end();
    const malformed = tracer.startSpan(AppRenderSpan.getBodyResult, {
      attributes: { "next.span_type": AppRenderSpan.getBodyResult, "next.route": "/parties?token=secret" },
    });
    malformed.end();
    const result = profile.summarize();
    assert.deepEqual(result, {
      routes: [{ route: "/parties/[id]", renders: 3, failedRenders: 1, durationMs: { mean: 133.33, p95: 250, max: 250, total: 400 } }],
      droppedRenders: 0,
    });
    assert.doesNotMatch(JSON.stringify(result), /secret|private-id|http|exception/);
    assert.deepEqual(profile.summarize(), { routes: [], droppedRenders: 0 });

    // A second enabled call keeps the existing processor/provider, not a
    // duplicate observer that would double-count each completed render.
    assert.equal(await startTelemetry({}, [profile.processor]), true);
    for (let i = 0; i < 10_001; i += 1) {
      const span = tracer.startSpan(AppRenderSpan.getBodyResult, {
        startTime: [3, 0],
        attributes: { "next.span_type": AppRenderSpan.getBodyResult, "next.route": "/(app)/dashboard/page" },
      });
      span.end([3, 1_000_000]);
    }
    assert.deepEqual(profile.summarize(), {
      routes: [{ route: "/dashboard", renders: 10_000, failedRenders: 0, durationMs: { mean: 1, p95: 1, max: 1, total: 10_000 } }],
      droppedRenders: 1,
    });
    const nextWindow = tracer.startSpan(AppRenderSpan.getBodyResult, {
      startTime: [4, 0],
      attributes: { "next.span_type": AppRenderSpan.getBodyResult, "next.route": "/(app)/dashboard/page" },
    });
    nextWindow.end([4, 2_000_000]);
    assert.equal(profile.summarize().routes[0]?.renders, 1, "bounded collection resumes in the next window");
  } finally {
    await stopTelemetry();
  }
});
