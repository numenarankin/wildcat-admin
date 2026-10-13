import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseUrl } from "@/lib/env";
import { accessFromRows, isMissingFunction } from "@/lib/auth/platform-admin-access";
import { ALL_ADMIN_PAGES, pagesAllowPath } from "@/lib/admin/pages";

/**
 * Proxy (Next.js 16's renamed Middleware). Runs before every matched request to:
 *  1. refresh the Supabase auth session cookie,
 *  2. send signed-out visitors to /auth, and
 *  3. answer a signed-in account that is not on `platform_admins`, or one on
 *     it opening a page not on its list (`platform_admins.pages`), with a real
 *     404, so the app does not advertise itself nor its other pages.
 *
 * Optimistic only, as in the customer app: `requireAdminPage()` on every page
 * and the admin check in every /api/admin route are the boundary.
 */

// Sign-in and the invite landing: the two things a stranger may open.
const PUBLIC_PATHS = ["/auth", "/invite"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// A path that matches no route, so Next serves `app/not-found.tsx` with a real
// 404 status while the address bar keeps the URL they typed. A leading
// underscore can never become a route (`_folder` is private in the app router).
const NOT_FOUND_PATH = "/_404";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = getSupabaseUrl();
  const key =
    process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (!user && !isPublic(pathname) && !isApi) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/auth";
    redirectUrl.search = "";
    if (pathname !== "/") {
      redirectUrl.searchParams.set("next", pathname + request.nextUrl.search);
    }
    return NextResponse.redirect(redirectUrl);
  }

  if (user && !isApi && !isPublic(pathname)) {
    const { data: rows, error } = await supabase.rpc("platform_admin_access");
    let access = accessFromRows(rows);
    if (error && isMissingFunction(error)) {
      // Migration 2026101300100 not applied yet: the pre-page-level gate.
      const { data: admin } = await supabase.rpc("is_platform_admin");
      access = { isAdmin: admin === true, isSeed: false, pages: [...ALL_ADMIN_PAGES] };
    }
    if (!access.isAdmin || !pagesAllowPath(access.pages, pathname)) {
      const notFoundUrl = request.nextUrl.clone();
      notFoundUrl.pathname = NOT_FOUND_PATH;
      notFoundUrl.search = "";
      return NextResponse.rewrite(notFoundUrl);
    }
  }

  return response;
}

export const config = {
  // Everything except Next internals and static asset files.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
