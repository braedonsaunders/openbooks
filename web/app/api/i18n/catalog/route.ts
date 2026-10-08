import { NextResponse, type NextRequest } from "next/server";
import { isLocale } from "../../../../i18n/config";
import { localeMessages, serializeCatalog } from "../../../../i18n/catalog";

export const runtime = "nodejs";

/**
 * The client message catalog for one locale. Public: it holds only the
 * application's interface strings, and the sign-in page needs it before any
 * session exists. A request naming the current content version is immutable
 * and cached by the browser; any other version answers with the current
 * catalog uncached, so a client built against an older catalog still renders.
 */
export async function GET(request: NextRequest) {
  const locale = request.nextUrl.searchParams.get("locale");
  if (!isLocale(locale)) return NextResponse.json({ error: "unsupported_locale" }, { status: 404 });
  const { version, body } = serializeCatalog(await localeMessages(locale));
  const current = request.nextUrl.searchParams.get("v") === version;
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": current ? "public, max-age=31536000, immutable" : "no-store",
      ETag: `"${version}"`,
    },
  });
}
