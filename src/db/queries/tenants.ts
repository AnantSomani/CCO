import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { tenants } from '@/db/schema';

export type Tenant = { id: string; workspaceId: string; slug: string };

const toTenant = (row: typeof tenants.$inferSelect): Tenant => ({
  id: row.id,
  workspaceId: row.workspaceId,
  slug: row.slug,
});

// Read path for subdomain routing: resolve a slug (from tenantSlugFromHost) to
// the workspace it belongs to. Returns null for an unknown slug so the request
// can fall through to a 404 rather than leaking which slugs exist.
export const getWorkspaceIdBySlug = async (db: Db, slug: string): Promise<string | null> => {
  const rows = await db
    .select({ workspaceId: tenants.workspaceId })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  return rows[0]?.workspaceId ?? null;
};

// Provisioning path: assign (or re-point) a workspace's slug. Idempotent on
// workspace_id so re-running the provisioning script is safe. Throws only if
// the slug is already taken by a *different* workspace (the slug unique
// constraint) — the caller surfaces that as "slug already in use".
export const upsertTenant = async (db: Db, workspaceId: string, slug: string): Promise<Tenant> => {
  const rows = await db
    .insert(tenants)
    .values({ workspaceId, slug })
    .onConflictDoUpdate({ target: tenants.workspaceId, set: { slug } })
    .returning();
  // biome-ignore lint/style/noNonNullAssertion: an insert...returning always yields the row.
  return toTenant(rows[0]!);
};
