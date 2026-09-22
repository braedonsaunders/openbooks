import { NextResponse } from 'next/server'

/** Named drill refusals stay 4xx with the engine token; only defects 500. */
export function reportDrillErrorResponse(error: unknown): NextResponse {
  if (error instanceof Error && error.name === 'ReportBookSelectionError') {
    return NextResponse.json({ error: error.message }, { status: 422 })
  }
  if (error instanceof Error) {
    if (error.message === 'report_not_found' || error.message === 'report_entity_not_found' || error.message === 'scenario_not_found') {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    if (error.message === 'report_drill_scope_invalid') {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    // A refused entity is an authorization outcome, not a server fault.
    if (error.message === 'report_entity_forbidden') {
      return NextResponse.json({ error: 'you do not have access to this data' }, { status: 403 })
    }
  }
  console.error('Report drill failed', error)
  return NextResponse.json({ error: 'report_drill_failed' }, { status: 500 })
}
