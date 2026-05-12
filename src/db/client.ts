import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../lib/env';
import * as schema from './schema';

// Supabase pooled connection (port 6543, transaction mode via pgBouncer).
// `prepare: false` is required: pgBouncer transaction mode does not support
// prepared statements. drizzle-kit migrations use DIRECT_URL instead.
const queryClient = postgres(env.DATABASE_URL, { prepare: false });

export type Db = PostgresJsDatabase<typeof schema>;

export const db: Db = drizzle(queryClient, { schema });
