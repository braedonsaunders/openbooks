export const REPORT_SECTION_VISIBILITY_EVENT = 'openbooks:report-section-visibility'

export type ReportSectionVisibility = 'expand' | 'collapse'

export function setAllReportSections(visibility: ReportSectionVisibility): void {
  window.dispatchEvent(
    new CustomEvent<ReportSectionVisibility>(REPORT_SECTION_VISIBILITY_EVENT, {
      detail: visibility,
    }),
  )
}
