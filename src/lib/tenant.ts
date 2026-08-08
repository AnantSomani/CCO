// Subdomain multitenancy: map an incoming Host header to a tenant slug.
// `theta.tryconfetti.xyz` → `theta`. The apex domain, `www`, and operational
// subdomains (including the existing `dashboard.tryconfetti.xyz` dev tunnel)
// are NOT tenants — they fall through to the marketing/install/dev surfaces.
// Pure and side-effect-free so it is trivially testable; the slug → workspace
// lookup lives in the query layer, not here.

const APEX = 'tryconfetti.xyz';

// Labels that must never be treated as a customer tenant.
const RESERVED_SLUGS = new Set(['www', 'app', 'dashboard', 'api', 'dev', 'staging', 'admin']);

// A conservative slug shape: lowercase alphanumeric with internal hyphens,
// 1–32 chars. Matches what the provisioning script is allowed to assign.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const isValidTenantSlug = (slug: string): boolean => SLUG_RE.test(slug);

export const tenantSlugFromHost = (host: string | null | undefined): string | null => {
  if (!host) return null;
  const hostname = (host.split(':')[0] ?? '').toLowerCase().trim();
  if (!hostname) return null;

  let subdomainPart: string;
  if (hostname.endsWith(`.${APEX}`)) {
    subdomainPart = hostname.slice(0, -(APEX.length + 1));
  } else if (hostname.endsWith('.localhost')) {
    // Dev convenience: `theta.localhost:3000` resolves to tenant `theta`.
    subdomainPart = hostname.slice(0, -'.localhost'.length);
  } else {
    return null;
  }

  // Only the left-most label is the tenant slug (`theta.staging.tryconfetti.xyz`
  // → `theta`); reject anything that doesn't match the allowed slug shape.
  const slug = subdomainPart.split('.')[0] ?? '';
  if (!slug || RESERVED_SLUGS.has(slug) || !isValidTenantSlug(slug)) return null;
  return slug;
};
