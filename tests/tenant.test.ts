import { describe, expect, it } from 'vitest';
import { isValidTenantSlug, tenantSlugFromHost } from '@/lib/tenant';

describe('tenantSlugFromHost', () => {
  it('extracts the slug from a tenant subdomain', () => {
    expect(tenantSlugFromHost('theta.tryconfetti.xyz')).toBe('theta');
    expect(tenantSlugFromHost('THETA.TryConfetti.xyz')).toBe('theta');
    expect(tenantSlugFromHost('theta.tryconfetti.xyz:443')).toBe('theta');
  });

  it('supports <slug>.localhost in dev', () => {
    expect(tenantSlugFromHost('theta.localhost:3000')).toBe('theta');
  });

  it('returns null for the apex, www, and operational subdomains', () => {
    expect(tenantSlugFromHost('tryconfetti.xyz')).toBeNull();
    expect(tenantSlugFromHost('www.tryconfetti.xyz')).toBeNull();
    // The existing dev tunnel host must not be mistaken for a tenant.
    expect(tenantSlugFromHost('dashboard.tryconfetti.xyz')).toBeNull();
    expect(tenantSlugFromHost('api.tryconfetti.xyz')).toBeNull();
  });

  it('returns null for unrelated hosts and junk', () => {
    expect(tenantSlugFromHost('example.com')).toBeNull();
    expect(tenantSlugFromHost('localhost:3000')).toBeNull();
    expect(tenantSlugFromHost(null)).toBeNull();
    expect(tenantSlugFromHost('')).toBeNull();
  });

  it('takes only the left-most label of a deeper subdomain', () => {
    expect(tenantSlugFromHost('theta.staging.tryconfetti.xyz')).toBe('theta');
  });

  it('rejects malformed slugs', () => {
    expect(tenantSlugFromHost('-bad.tryconfetti.xyz')).toBeNull();
    expect(tenantSlugFromHost('has_underscore.tryconfetti.xyz')).toBeNull();
  });
});

describe('isValidTenantSlug', () => {
  it('accepts simple slugs and rejects bad shapes', () => {
    expect(isValidTenantSlug('theta')).toBe(true);
    expect(isValidTenantSlug('theta-software')).toBe(true);
    expect(isValidTenantSlug('a')).toBe(true);
    expect(isValidTenantSlug('-lead')).toBe(false);
    expect(isValidTenantSlug('trail-')).toBe(false);
    expect(isValidTenantSlug('UPPER')).toBe(false);
    expect(isValidTenantSlug('under_score')).toBe(false);
  });
});
