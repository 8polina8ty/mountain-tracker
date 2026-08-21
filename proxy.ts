import createMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { refreshSupabaseSession } from "@/Lib/supabase/proxy";
import { routing } from "@/i18n/routing";

const handleI18nRouting = createMiddleware(routing);

const legacyRussianPublicPath =
  /^\/(?:map(?:\/.*)?|mountain(?:\/.*)?|ranking(?:\/.*)?|users(?:\/.*)?)$/;

export default async function proxy(request: NextRequest) {
  if (legacyRussianPublicPath.test(request.nextUrl.pathname)) {
    const localizedUrl = request.nextUrl.clone();
    localizedUrl.pathname = `/ru${request.nextUrl.pathname}`;

    return NextResponse.redirect(localizedUrl, 308);
  }

  if (request.nextUrl.pathname.startsWith("/api/projects")) {
    return refreshSupabaseSession(request);
  }

  return refreshSupabaseSession(request, (sessionRequest) =>
    handleI18nRouting(sessionRequest),
  );
}

export const config = {
  matcher: [
    "/api/projects/:path*",
    "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
  ],
};
