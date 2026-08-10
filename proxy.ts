import createMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { routing } from "@/i18n/routing";

const handleI18nRouting = createMiddleware(routing);

const legacyRussianPublicPath =
  /^\/(?:map(?:\/.*)?|mountain(?:\/.*)?|ranking(?:\/.*)?|users(?:\/.*)?)$/;

export default function proxy(request: NextRequest) {
  if (legacyRussianPublicPath.test(request.nextUrl.pathname)) {
    const localizedUrl = request.nextUrl.clone();
    localizedUrl.pathname = `/ru${request.nextUrl.pathname}`;

    return NextResponse.redirect(localizedUrl, 308);
  }

  return handleI18nRouting(request);
}

export const config = {
  matcher: "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
};
