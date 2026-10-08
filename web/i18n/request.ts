import { getRequestConfig } from "next-intl/server";
import { resolveLocale, resolveTimeZone } from "../lib/locale";
import { localeMessages } from "./catalog";

export default getRequestConfig(async () => {
  const [locale, timeZone] = await Promise.all([resolveLocale(), resolveTimeZone()]);
  return {
    locale,
    messages: await localeMessages(locale),
    // Viewer dates and times use the tenant's configured civil-time zone,
    // consistent with business-date and financial workflow rules.
    timeZone,
  };
});
