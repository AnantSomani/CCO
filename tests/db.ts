import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';

// Creates a fresh in-memory Postgres for one test file. Runs all SQL migrations
// from ./drizzle so the test schema mirrors production exactly.
// Cast to Db is safe: pglite and postgres-js drizzle clients are structurally
// identical for the query-builder methods we use.
export const createTestDb = async (): Promise<Db> => {
  const pg = new PGlite();
  // Supabase provisions these platform roles in every real database; bare
  // pglite does not. Migrations that GRANT to / CREATE POLICY ... TO them
  // (e.g. waitlist_signups → anon) would otherwise fail with
  // `role "..." does not exist`. Seed them so the test schema mirrors prod.
  await pg.exec(`
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  const testDb = drizzle(pg, { schema });
  await migrate(testDb, { migrationsFolder: './drizzle' });
  return testDb as unknown as Db;
};
