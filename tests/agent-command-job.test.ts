import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createAgentRun, getAgentRun } from '@/db/queries/agent-operations';
import { agentActions, workspaces } from '@/db/schema';
import { runAgentCommand } from '@/jobs/agent-command';
import { ok } from '@/lib/result';
import { createTestDb } from './db';
import { recordingSlackClientFactory } from './slack-stub';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000051';

describe('runAgentCommand', () => {
  it('persists proposals and sends separate response and confirmation DMs', async () => {
    const db = await createTestDb();
    await db.insert(workspaces).values({
      id: WORKSPACE_ID,
      slackTeamId: 'T_JOB',
      slackTeamName: 'Job Test',
      botAccessTokenEnc: 'stub',
      installedBySlackUser: 'U_ADMIN',
    });
    const { run } = await createAgentRun(db, {
      workspaceId: WORKSPACE_ID,
      requestedBySlackUser: 'U_ADMIN',
      requestText: 'set budget to $75',
      idempotencyKey: 'job-run',
    });
    const recorder: Parameters<typeof recordingSlackClientFactory>[0] = {};
    const runAdminAgent = vi.fn().mockResolvedValue(
      ok({
        replyText: 'I prepared the budget change.',
        proposedActions: [
          {
            kind: 'set_default_budget',
            summary: 'Set budget to $75',
            payload: { amountCents: 7500 },
            estimatedCostCents: null,
          },
        ],
        toolCalls: [{ name: 'propose_set_default_budget', input: { amount_usd: 75 } }],
        model: 'test-model',
        rounds: 2,
      }),
    );

    const result = await runAgentCommand({
      db,
      getSlackClient: recordingSlackClientFactory(recorder),
      getAnthropicClient: () => ({}) as Anthropic,
      runAdminAgent,
      runId: run.id,
    });

    const storedRun = await getAgentRun(db, run.id);
    const actions = await db.select().from(agentActions);
    expect(result).toEqual({ ok: true, value: { actionsCreated: 1 } });
    expect(storedRun?.status).toBe('completed');
    expect(storedRun?.toolCalls).toHaveLength(1);
    expect(actions[0]?.status).toBe('pending_confirmation');
    expect(recorder.posts).toHaveLength(2);
    expect(recorder.posts?.[1]?.blocks).toBeDefined();
  });
});
