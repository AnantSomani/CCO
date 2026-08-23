import { runAdminAgent as defaultRunAdminAgent, type RunAdminAgent } from '@/agent/admin-agent';
import {
  getAnthropicClient as defaultGetAnthropicClient,
  type GetAnthropicClient,
} from '@/agent/anthropic-client';
import { sessionCommandKind } from '@/agent/session-types';
import type { Db } from '@/db/client';
import {
  completeAgentRun,
  failAgentRun,
  getAgentRun,
  insertAgentActions,
  markAgentRunRunning,
  setAgentActionConfirmationMessage,
  setAgentRunResponseMessage,
} from '@/db/queries/agent-operations';
import {
  appendSessionTurn,
  cancelOpenArtifacts,
  closeSession,
  getOpenArtifact,
  getSessionById,
  listRecentTurns,
  setSessionStatus,
  setSessionThread,
  summarizeArtifact,
} from '@/db/queries/agent-sessions';
import { getWorkspaceById } from '@/db/queries/workspaces';
import { createDdCliClient } from '@/integrations/doordash/dd-cli-client';
import { env } from '@/lib/env';
import { log as defaultLog } from '@/lib/log';
import { err, ok, type Result } from '@/lib/result';
import { buildAgentActionConfirmation } from '@/slack/blocks/agent-action';
import type { GetSlackClient } from '@/slack/client';
import { EVENT_NAME_AGENT_COMMAND_REQUESTED } from '@/slack/ids';
import { inngest } from './client';

type Logger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

type RunAgentCommandArgs = {
  db: Db;
  getSlackClient: GetSlackClient;
  runAdminAgent?: RunAdminAgent;
  getAnthropicClient?: GetAnthropicClient;
  runId: string;
  log?: Logger;
};

export const runAgentCommand = async ({
  db,
  getSlackClient,
  runAdminAgent = defaultRunAdminAgent,
  getAnthropicClient = defaultGetAnthropicClient,
  runId,
  log = defaultLog,
}: RunAgentCommandArgs): Promise<Result<{ actionsCreated: number }, string>> => {
  const run = await getAgentRun(db, runId);
  if (!run) return err(`agent run not found: ${runId}`);
  if (run.status === 'completed' || run.responseMessageTs) return ok({ actionsCreated: 0 });

  const workspace = await getWorkspaceById(db, run.workspaceId);
  if (!workspace) return err(`workspace not found: ${run.workspaceId}`);
  await markAgentRunRunning(db, run.id);

  const session = run.sessionId ? await getSessionById(db, run.sessionId, run.workspaceId) : null;
  const turns = session ? await listRecentTurns(db, session.id, session.workspaceId) : [];
  const artifact = session ? await getOpenArtifact(db, session.id, session.workspaceId) : null;
  const command = sessionCommandKind(run.requestText);

  if (session && command) {
    const reply = await handleSessionCommand(db, session.id, session.workspaceId, command);
    return completeWithReply(db, getSlackClient, run, workspace.id, reply, log, 0);
  }

  const result = await runAdminAgent({
    anthropic: getAnthropicClient(),
    db,
    doorDash: env.DOORDASH_EXECUTOR === 'dd-cli' ? createDdCliClient() : undefined,
    workspace,
    rawText: run.requestText,
    userId: run.requestedBySlackUser,
    log,
    session: session
      ? {
          id: session.id,
          turns: turns
            .filter((turn) => turn.text !== run.requestText)
            .map((turn) => ({
              role: turn.role,
              text: turn.text,
            })),
          artifact,
        }
      : undefined,
  });
  if (!result.ok) {
    log.error('admin agent failed', {
      runId: run.id,
      workspaceId: workspace.id,
      error: result.error,
    });
    return completeWithReply(
      db,
      getSlackClient,
      run,
      workspace.id,
      agentFailureReply(result.error),
      log,
      0,
    );
  }

  const actions = await insertAgentActions(db, run, result.value.proposedActions);
  const slack = await getSlackClient(workspace.id);
  if (!slack.ok) {
    await failAgentRun(db, run.id, 'slack_unavailable');
    return err(`slack client unavailable: ${slack.error}`);
  }

  if (!run.responseMessageTs) {
    const sent = await slack.value.postMessage({
      channel: run.requestedBySlackUser,
      text: result.value.replyText,
    });
    if (!sent.ok) {
      await failAgentRun(db, run.id, 'response_dm_failed');
      return err(`response DM failed: ${sent.error}`);
    }
    await setAgentRunResponseMessage(db, run.id, sent.value.channel, sent.value.ts);
    if (session) {
      await setSessionThread(
        db,
        session.id,
        session.workspaceId,
        sent.value.channel,
        sent.value.ts,
      );
    }
  }

  for (const action of actions) {
    if (action.confirmationMessageTs) continue;
    const confirmation = buildAgentActionConfirmation(action);
    const sent = await slack.value.postMessage({
      channel: run.requestedBySlackUser,
      text: confirmation.text,
      blocks: confirmation.blocks,
    });
    if (!sent.ok) {
      await failAgentRun(db, run.id, 'confirmation_dm_failed');
      return err(`confirmation DM failed: ${sent.error}`);
    }
    await setAgentActionConfirmationMessage(db, action.id, sent.value.channel, sent.value.ts);
  }

  if (session) {
    await appendSessionTurn(db, {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      role: 'assistant',
      text: result.value.replyText,
    });
    await setSessionStatus(
      db,
      session.id,
      session.workspaceId,
      actions.length > 0 ? 'pending_approval' : 'waiting_for_user',
    );
  }

  await completeAgentRun(
    db,
    run.id,
    result.value.replyText,
    result.value.model,
    result.value.toolCalls,
  );
  log.info('admin agent run completed', {
    runId: run.id,
    workspaceId: workspace.id,
    requestedBySlackUser: run.requestedBySlackUser,
    actionCount: actions.length,
    rounds: result.value.rounds,
  });
  return ok({ actionsCreated: actions.length });
};

const handleSessionCommand = async (
  db: Db,
  sessionId: string,
  workspaceId: string,
  command: 'cancel' | 'restart' | 'summary',
): Promise<string> => {
  if (command === 'summary') {
    const artifact = await getOpenArtifact(db, sessionId, workspaceId);
    return summarizeArtifact(artifact);
  }
  if (command === 'cancel') {
    await closeSession(db, sessionId, workspaceId);
    return 'Cancelled. I cleared the active draft and will not keep asking about it.';
  }
  await cancelOpenArtifacts(db, sessionId, workspaceId);
  await setSessionStatus(db, sessionId, workspaceId, 'active');
  return 'Starting over. Tell me what you want to plan next.';
};

const completeWithReply = async (
  db: Db,
  getSlackClient: GetSlackClient,
  run: NonNullable<Awaited<ReturnType<typeof getAgentRun>>>,
  workspaceId: string,
  replyText: string,
  log: Logger,
  actionsCreated: number,
): Promise<Result<{ actionsCreated: number }, string>> => {
  const slack = await getSlackClient(workspaceId);
  if (!slack.ok) {
    await failAgentRun(db, run.id, 'slack_unavailable');
    return err(`slack client unavailable: ${slack.error}`);
  }
  if (!run.responseMessageTs) {
    const sent = await slack.value.postMessage({
      channel: run.requestedBySlackUser,
      text: replyText,
    });
    if (!sent.ok) {
      await failAgentRun(db, run.id, 'response_dm_failed');
      return err(`response DM failed: ${sent.error}`);
    }
    await setAgentRunResponseMessage(db, run.id, sent.value.channel, sent.value.ts);
    if (run.sessionId) {
      await setSessionThread(db, run.sessionId, run.workspaceId, sent.value.channel, sent.value.ts);
    }
  }
  if (run.sessionId) {
    await appendSessionTurn(db, {
      sessionId: run.sessionId,
      workspaceId: run.workspaceId,
      role: 'assistant',
      text: replyText,
    });
  }
  await completeAgentRun(db, run.id, replyText, AGENT_COMMAND_MODEL, []);
  log.info('admin agent run completed', {
    runId: run.id,
    workspaceId,
    requestedBySlackUser: run.requestedBySlackUser,
    actionCount: actionsCreated,
    rounds: 1,
  });
  return ok({ actionsCreated });
};

const AGENT_COMMAND_MODEL = 'session-command';

const agentFailureReply = (error: string): string => {
  if (/timed out/i.test(error)) {
    return 'That request timed out. I kept your draft and did not place an order. Send the next detail, or say `what do you have so far`.';
  }
  return "I couldn't finish that request. Your draft is still here if I already saved details. Please try again or say `what do you have so far`.";
};

export const agentCommand = inngest.createFunction(
  {
    id: 'agent-command',
    retries: 2,
    timeouts: { finish: '3m' },
    triggers: [{ event: EVENT_NAME_AGENT_COMMAND_REQUESTED }],
    singleton: { key: 'event.data.runId', mode: 'skip' },
    onFailure: async ({ event }) => {
      const original = event.data.event;
      const data = original.data as { runId?: string };
      if (!data.runId) return;
      const { db } = await import('@/db/client');
      const { getSlackClient } = await import('@/slack/client');
      const run = await getAgentRun(db, data.runId);
      if (!run) return;
      await failAgentRun(db, run.id, 'retries_exhausted');
      const slack = await getSlackClient(run.workspaceId);
      if (!slack.ok) return;
      await slack.value.postMessage({
        channel: run.requestedBySlackUser,
        text: "I couldn't complete that request after retrying. Nothing was changed.",
      });
    },
  },
  async ({ event, step }) => {
    const data = event.data as { runId?: string };
    if (!data.runId) return { ok: false, error: 'missing runId' };
    const result = await step.run('run-admin-agent-command', async () => {
      const { db } = await import('@/db/client');
      const { getSlackClient } = await import('@/slack/client');
      return runAgentCommand({ db, getSlackClient, runId: data.runId as string });
    });
    if (!result.ok) throw new Error(result.error);
    return { ok: true, ...result.value };
  },
);
