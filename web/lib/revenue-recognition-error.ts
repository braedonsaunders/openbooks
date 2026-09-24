import { NextResponse } from 'next/server'
import {
  RevenueRecognitionError,
  StaleRecognitionPreviewError,
} from '../../engine/src/revenue/recognition.ts'

/**
 * Named revenue-recognition refusals (closed period, unconfigured accounts,
 * inverted dates, the legacy rebuild block) stay 422 with the engine
 * message — the same discipline as cancel-recognition (422) and close
 * revaluation (422). A stale confirmation stays 409 naming the remedy
 * (preview again). Only unexpected defects stay a generic 500.
 */
export function revenueRecognitionErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof StaleRecognitionPreviewError) {
    return NextResponse.json({ error: 'stale_preview' }, { status: 409 })
  }
  if (error instanceof RevenueRecognitionError) {
    return NextResponse.json({ error: error.message }, { status: 422 })
  }
  console.error(fallback, error)
  return NextResponse.json({ error: fallback }, { status: 500 })
}
