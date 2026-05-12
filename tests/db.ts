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
  const testDb = drizzle(pg, { schema });
  await migrate(testDb, { migrationsFolder: './drizzle' });
  return testDb as unknown as Db;
};
