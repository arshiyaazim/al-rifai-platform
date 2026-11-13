import {NextResponse,type NextRequest} from "next/server";
import {validationIdentity} from "@/lib/validation-auth.mjs";
import {
  isCashPortalPath,
  isUnifiedAuthPublicPath,
  prefersDocumentNavigation,
  sanitizeReturnTo,
  unifiedAuthMode,
} from "@/lib/unified-auth-policy";
import {sessionIdentityFromCookieHeader} from "@/lib/unified-auth-db";

const HEALTH_PATH="/api/health";
// Public marketing surface. These paths render no business data and are the only
// unauthenticated application routes besides the Cash portal.
const PUBLIC_SITE_PATHS=new Set(["/","/signup"]);
const PASSWORD_CHANGE_PATHS=new Set(["/login","/api/auth/session","/api/auth/password","/api/auth/logout","/api/cash/logout"]);
const unauthorized=()=>new NextResponse("Private validation authentication required",{status:401,headers:{"WWW-Authenticate":'Basic realm="Al-Rifai private validation", charset="UTF-8"',"Cache-Control":"no-store"}});
const passwordChangeRequired=()=>new NextResponse(
 JSON.stringify({error:"PASSWORD_CHANGE_REQUIRED"}),
 {status:403,headers:{"Cache-Control":"no-store","Content-Type":"application/json"}},
);
// Unified-auth denial must never trigger a browser Basic credential dialog.
// API/subresource callers get JSON 401; document navigations are redirected.
const jsonUnauthorized=()=>new NextResponse(
 JSON.stringify({error:"AUTHENTICATION_REQUIRED"}),
 {status:401,headers:{"Cache-Control":"no-store","Content-Type":"application/json"}},
);

export async function proxy(request:NextRequest){
 const pathname=request.nextUrl.pathname;
 const forwarded=new Headers(request.headers);
 for(const key of [...forwarded.keys()])if(key.startsWith("oai-authenticated-")||key==="x-middleware-subrequest")forwarded.delete(key);
 const pass=()=>NextResponse.next({request:{headers:forwarded}});
 if(pathname===HEALTH_PATH)return pass();
 // The public company site is reachable without a credential; it carries no
 // client, personnel or financial data.
 if(PUBLIC_SITE_PATHS.has(pathname))return pass();
 // Basic credentials are for API/machine access. A valid Basic header passes
 // this proxy, but workspace pages call pageUser() and still require a unified
 // session, so a Basic credential alone does not open them.
 if(validationIdentity(request.headers.get("authorization")))return pass();
 const mode=unifiedAuthMode(process.env.ALRIFAI_UNIFIED_AUTH_MODE);
 // Keep the existing Cash Portal boundary when unified auth is off.
 if(mode==="off")return isCashPortalPath(pathname)?pass():unauthorized();
 // 'shadow' proves the credentials on /login but does not authorise any
 // protected route. 'on' additionally accepts a validated Cash session.
 if(mode==="on"){
  const identity=await sessionIdentityFromCookieHeader(request.headers.get("cookie"));
  if(identity){
   if(identity.mustChangePassword&&!PASSWORD_CHANGE_PATHS.has(pathname)){
    if(pathname.startsWith("/api/"))return passwordChangeRequired();
    const url=request.nextUrl.clone();
    url.pathname="/login";
    url.search="?next=%2Fdashboard&passwordChangeRequired=1";
    return NextResponse.redirect(url,302);
   }
   return pass();
  }
 }
 // Sign-in surface must stay reachable without a session (shadow and on).
 if(isUnifiedAuthPublicPath(pathname))return pass();
 // The public Cash Portal remains independently accessible when no unified
 // session exists; valid forced-change sessions were handled above.
 if(isCashPortalPath(pathname))return pass();
 if(mode==="on"){
  // Only 'on' may answer a browser navigation with the sign-in page. In
  // 'shadow' protected routes keep the fail-closed 401 challenge
  // (WWW-Authenticate) instead of redirecting to /login: a shadow session does
  // not authorise workspace pages yet, and machine clients need the explicit
  // authentication failure rather than an HTML sign-in page.
  if(prefersDocumentNavigation(request.headers)){
   const target=sanitizeReturnTo(pathname+(request.nextUrl.search||""));
   const url=request.nextUrl.clone();
   url.pathname="/login";
   url.search=`?next=${encodeURIComponent(target)}`;
   return NextResponse.redirect(url,302);
  }
  // The application has its own login/session. Do not emit a competing Basic
  // challenge for API and background requests.
  return jsonUnauthorized();
 }
 // Everything else keeps the fail-closed 401 so no client silently proceeds
 // unauthenticated.
 return unauthorized();
}
// candidate-api requests are excluded from this proxy by the matcher below; the
// candidate host handles their authentication. Keeping their request bodies out
// of Next proxy cloning also avoids early denial/cancellation issues.
export const config={matcher:["/((?!candidate-api(?:/|$)|_next/static|_next/image|favicon.svg|file.svg|globe.svg|window.svg).*)"]};
