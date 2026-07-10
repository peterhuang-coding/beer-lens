/**
 * Minimal debug API protection.
 *
 * - If DEBUG_API_TOKEN is not configured, only allow localhost.
 * - If DEBUG_API_TOKEN is configured, require header: x-debug-token matching the token.
 * - Uses a header-based check (not Host/x-forwarded-for) for the localhost fallback
 *   to avoid spoofing via proxy headers.
 */

export function isDebugRequestAllowed(request: Request): boolean {
  const token = process.env.DEBUG_API_TOKEN;

  if (!token) {
    // No token configured — only allow localhost via raw connection info
    // Use URL hostname which comes from the actual connection, not a header
    try {
      const url = new URL(request.url);
      const hostname = url.hostname;
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
    } catch {
      return false;
    }
  }

  // Token configured — require matching header
  const provided = request.headers.get("x-debug-token");
  return provided === token;
}
