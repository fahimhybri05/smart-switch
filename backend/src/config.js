/** Public base URL of this API (no trailing slash) — used to build hook
 * URLs and the OpenAPI `servers` entry. */
export function publicApiUrl() {
  return (process.env.PUBLIC_API_URL || 'https://api.smart-switch.shop').replace(/\/+$/, '');
}
