import type { Db } from '@/db/client';
import {
  claimDueReminder,
  getArtifactById,
  getSessionById,
  listDueReminders,
} from '@/db/queries/agent-sessions';
import { getWorkspaceById } from '@/db/queries/workspaces';
import { log as defaultLog } from '@/lib/log';
import { err, ok, type Result } from '@/lib/result';
import type { GetSlackClient } from '@/slack/client';
import { EVENT_NAME_AGENT_REMINDER_DUE } from '@/slack/ids';
import { inngest } from './client';

type Logger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export const runAgentReminder = async ({
  db,
  getSlackClient,
  artifactId,
  workspaceId,
  log = defaultLog,
  now = new Date(),
}: {
  db: Db;
  getSlackClient: GetSlackClient;
  artifactId: string;
  workspaceId: string;
  log?: Logger;
  now?: Date;
}): Promise<Result<{ delivered: boolean }, string>> => {
  const existing = await getArtifactById(db, artifactId, workspaceId);
  if (!existing) return ok({ delivered: false });
  if (existing.status === 'completed' || existing.status === 'cancelled') {
    return ok({ delivered: false });
  }
  if (existing.kind !== 'reminder' || existing.status !== 'scheduled') {
    return ok({ delivered: false });
  }

  const claimed = await claimDueReminder(db, artifactId, workspaceId, now);
  if (!claimed) return ok({ delivered: false });

  const workspace = await getWorkspaceById(db, workspaceId);
  if (!workspace) return err(`workspace not found: ${workspaceId}`);
  const session = await getSessionById(db, claimed.sessionId, workspaceId);
  const slack = await getSlackClient(workspace.id);
  if (!slack.ok) return err(`slack client unavailable: ${slack.error}`);

  const title = typeof claimed.slots.title === 'string' ? claimed.slots.title : 'your reminder';
  const note = typeof claimed.slots.note === 'string' ? `\n${claimed.slots.note}` : '';
  const sent = await slack.value.postMessage({
    channel: session?.slackUserId ?? workspace.installedBySlackUser,
    text: `Reminder: ${title}${note}`,
  });
  if (!sent.ok) return err(`reminder DM failed: ${sent.error}`);

  log.info('agent reminder delivered', {
    artifactId,
    workspaceId,
  });
  return ok({ delivered: true });
};

export const agentReminder = inngest.createFunction(
  {
    id: 'agent-reminder',
    retries: 2,
    triggers: [{ event: EVENT_NAME_AGENT_REMINDER_DUE }],
    singleton: { key: 'event.data.artifactId', mode: 'skip' },
  },
  async ({ event, step }) => {
    const data = event.data as { artifactId?: string; workspaceId?: string };
    if (!data.artifactId || !data.workspaceId) return { ok: false, error: 'missing reminder ids' };
    const result = await step.run('deliver-agent-reminder', async () => {
      const { db } = await import('@/db/client');
      const { getSlackClient } = await import('@/slack/client');
      return runAgentReminder({
        db,
        getSlackClient,
        artifactId: data.artifactId as string,
        workspaceId: data.workspaceId as string,
      });
    });
    if (!result.ok) throw new Error(result.error);
    return { ok: true, ...result.value };
  },
);

export const agentReminderSweep = inngest.createFunction(
  {
    id: 'agent-reminder-sweep',
    retries: 1,
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async ({ step }) =>
    step.run('claim-due-reminders', async () => {
      const { db } = await import('@/db/client');
      const { getSlackClient } = await import('@/slack/client');
      const due = await listDueReminders(db);
      const results = [];
      for (const artifact of due) {
        results.push(
          await runAgentReminder({
            db,
            getSlackClient,
            artifactId: artifact.id,
            workspaceId: artifact.workspaceId,
          }),
        );
      }
      return { checked: due.length, results };
    }),
);
