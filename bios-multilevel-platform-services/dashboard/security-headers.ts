export const API_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

const DASHBOARD_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy":
    "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
};

export function applyDashboardSecurityHeaders(
  headers: Headers,
  contentSecurityPolicy = API_CONTENT_SECURITY_POLICY,
): Headers {
  headers.set("Content-Security-Policy", contentSecurityPolicy);
  for (const [name, value] of Object.entries(DASHBOARD_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}
