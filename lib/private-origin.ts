// Next's internal standalone URL need not equal the browser's loopback origin.
// Use the actual Host header, restricted to loopback; never trust forwarded headers.
export function privateSameOrigin(request:Request):boolean {
 const host=request.headers.get("host") || "";
 if(!/^(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}$/.test(host))return false;
 return request.headers.get("origin")==="http://"+host;
}
