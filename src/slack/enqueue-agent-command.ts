import type { Db } from '@/db/client';
import {
  countRecentAgentRuns,
  createAgentRun,
  failAgentRun,
  getAgentRunByIdempotencyKey,
} from '@/db/queries/agent-operations';
import { isWorkspaceAdmin } from '@/db/queries/users';
import { getWorkspaceBySlackTeamId } from '@/db/queries/workspaces';
import { err, ok, type Result } from '@/lib/result';
import { EVENT_NAME_AGENT_COMMAND_REQUESTED } from '@/slack/ids';

const MAX_REQUEST_CHARS = 1000;
const MAX_RUNS_PER_MINUTE = 5;

type EventEmitter = {
  send: (event: { name: string; data: Record<string, unknown> }) => Promise<unknown>;
};

export type EnqueueAgentCommandResult =
  | { status: 'queued'; runId: string }
  | { status: 'duplicate'; runId: string }
  | { status: 'unauthorized' }
  | { status: 'rate_limited' }
  | { status: 'unknown_workspace' };

export const enqueueAgentCommand = async (
  db: Db,
  emitter: EventEmitter,
  input: {
    slackTeamId: string;
    slackUserId: string;
    requestText: string;
    idempotencyKey: string;
  },
): Promise<Result<EnqueueAgentCommandResult, string>> => {
  const requestText = input.requestText.trim();
  if (!requestText || requestText.length > MAX_REQUEST_CHARS) {
    return err(`request must contain 1-${MAX_REQUEST_CHARS} characters`);
  }

  const workspace = await getWorkspaceBySlackTeamId(db, input.slackTeamId);
  if (!workspace) return ok({ status: 'unknown_workspace' });

  const isAdmin = await isWorkspaceAdmin(db, workspace.id, input.slackUserId);
  if (!isAdmin) return ok({ status: 'unauthorized' });

  const duplicate = await getAgentRunByIdempotencyKey(db, input.idempotencyKey);
  if (duplicate) return ok({ status: 'duplicate', runId: duplicate.id });

  const recent = await countRecentAgentRuns(
    db,
    workspace.id,
    input.slackUserId,
    new Date(Date.now() - 60_000),
  );
  if (recent >= MAX_RUNS_PER_MINUTE) return ok({ status: 'rate_limited' });

  const created = await createAgentRun(db, {
    workspaceId: workspace.id,
    requestedBySlackUser: input.slackUserId,
    requestText,
    idempotencyKey: input.idempotencyKey,
  });
  if (!created.created) return ok({ status: 'duplicate', runId: created.run.id });

  try {
    await emitter.send({
      name: EVENT_NAME_AGENT_COMMAND_REQUESTED,
      data: { runId: created.run.id },
    });
  } catch (error) {
    await failAgentRun(db, created.run.id, 'enqueue_failed');
    return err(error instanceof Error ? error.message : String(error));
  }

  return ok({ status: 'queued', runId: created.run.id });
};
