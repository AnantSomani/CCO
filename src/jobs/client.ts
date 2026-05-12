import { Inngest } from 'inngest';
import { env } from '@/lib/env';

// `isDev` flips signature verification + dev-server auto-discovery.
// When NODE_ENV=production (Vercel), Inngest uses INNGEST_SIGNING_KEY against
// Inngest Cloud. Locally we use the `inngest-cli dev` server.
export const inngest = new Inngest({
  id: 'confetti',
  isDev: env.NODE_ENV !== 'production',
});
