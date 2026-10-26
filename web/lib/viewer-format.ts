"use client";

import { useLocale, useTimeZone } from "next-intl";
import { formatCivilDate, viewerDate, viewerDateTime, viewerNumber } from "./format";

/** Viewer formatting bound to the locale and organization time zone in the
 * current NextIntl request context. */
export function useViewerFormat() {
  const locale = useLocale();
  const configuredTimeZone = useTimeZone();
  if (!configuredTimeZone)
    throw new Error("The viewer time zone is missing from the request formatting context");
  const timeZone = configuredTimeZone;
  return {
    locale,
    timeZone,
    date: (value: Date | string, options?: Intl.DateTimeFormatOptions) =>
      viewerDate(value, locale, timeZone, options),
    dateTime: (value: Date | string, options?: Intl.DateTimeFormatOptions) =>
      viewerDateTime(value, locale, timeZone, options),
    /** A civil `YYYY-MM-DD` date; never shifted by the viewer's time zone. */
    civilDate: (isoDate: string) => formatCivilDate(isoDate, locale),
    number: (value: number, options?: Intl.NumberFormatOptions) =>
      viewerNumber(value, locale, options),
  };
}
