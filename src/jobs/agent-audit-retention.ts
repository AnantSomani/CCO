import { subDays } from 'date-fns';
import type { Db } from '@/db/client';
import { deleteExpiredAgentRuns } from '@/db/queries/agent-operations';
import { inngest } from './client';

const RETENTION_DAYS = 90;

export const runAgentAuditRetention = async (
  db: Db,
  now = new Date(),
): Promise<{ deleted: number }> => {
  const before = subDays(now, RETENTION_DAYS);
  return { deleted: await deleteExpiredAgentRuns(db, before) };
};

export const agentAuditRetention = inngest.createFunction(
  {
    id: 'agent-audit-retention',
    retries: 2,
    triggers: [{ cron: '0 4 * * *' }],
  },
  async ({ step }) =>
    step.run('delete-expired-agent-audit-data', async () => {
      const { db } = await import('@/db/client');
      return runAgentAuditRetention(db);
    }),
);
