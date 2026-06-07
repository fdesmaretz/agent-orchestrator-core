const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  const normalizedPath = parsed.pathname.replace(/\/+$/, "") || "/";
  const port = parsed.port ? `:${parsed.port}` : "";

  return `${parsed.protocol}//${parsed.hostname}${port}${normalizedPath}`;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function getConfiguredApiToken(): string | undefined {
  const token = process.env.ORCHESTRATOR_API_TOKEN?.trim();
  return token || undefined;
}

export function getAllowedBaseUrls(): string[] {
  const rawValue = process.env.ALLOWED_BASE_URLS?.trim();
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
    .map(normalizeUrl);
}

export function isDynamicBaseUrlRestrictionEnabled(): boolean {
  const value = process.env.ENFORCE_BASE_URL_ALLOWLIST?.trim().toLowerCase();
  return value ? TRUTHY_VALUES.has(value) : false;
}

export function isBaseUrlAllowed(baseUrl: string): boolean {
  if (!isDynamicBaseUrlRestrictionEnabled()) {
    return true;
  }

  const allowedBaseUrls = getAllowedBaseUrls();
  if (allowedBaseUrls.length === 0) {
    return false;
  }

  return allowedBaseUrls.includes(normalizeUrl(baseUrl));
}
