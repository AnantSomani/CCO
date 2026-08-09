import { describe, expect, it } from 'vitest';
import { createAgentRun, getAgentAction, insertAgentActions } from '@/db/queries/agent-operations';
import { users, workspaces } from '@/db/schema';
import { handleApproveAgentAction } from '@/slack/handlers/agent-actions';
import type { BlockActionsPayload } from '@/slack/schemas';
import { createTestDb } from './db';
import { recordingEmitter, recordingSlackClientFactory } from './slack-stub';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000041';

const payload = (userId: string, actionId: string): BlockActionsPayload => ({
  type: 'block_actions',
  team: { id: 'T_ACTION' },
  user: { id: userId },
  channel: { id: 'D_ADMIN' },
  message: { ts: '123.456' },
  trigger_id: 'trigger',
  actions: [{ action_id: 'approve_agent_action', value: JSON.stringify({ actionId }) }],
});

const seed = async () => {
  const db = await createTestDb();
  await db.insert(workspaces).values({
    id: WORKSPACE_ID,
    slackTeamId: 'T_ACTION',
    slackTeamName: 'Action Test',
    botAccessTokenEnc: 'stub',
    installedBySlackUser: 'U_ADMIN',
  });
  await db.insert(users).values([
    { workspaceId: WORKSPACE_ID, slackUserId: 'U_ADMIN', isAdmin: true },
    { workspaceId: WORKSPACE_ID, slackUserId: 'U_MEMBER', isAdmin: false },
  ]);
  const { run } = await createAgentRun(db, {
    workspaceId: WORKSPACE_ID,
    requestedBySlackUser: 'U_ADMIN',
    requestText: 'set budget to $75',
    idempotencyKey: 'handler-run',
  });
  const [action] = await insertAgentActions(db, run, [
    {
      kind: 'set_default_budget',
      summary: 'Set budget to $75',
      payload: { amountCents: 7500 },
      estimatedCostCents: null,
    },
  ]);
  if (!action) throw new Error('missing action');
  return { db, action };
};

describe('agent action handlers', () => {
  it('allows an admin to approve exactly once and emits execution', async () => {
    const { db, action } = await seed();
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const ctx = {
      db,
      getSlackClient: recordingSlackClientFactory({}),
      emitter: recordingEmitter(events),
    };

    const first = await handleApproveAgentAction(ctx, payload('U_ADMIN', action.id));
    const second = await handleApproveAgentAction(ctx, payload('U_ADMIN', action.id));

    expect(first).toEqual({ ok: true, value: { status: 'approved' } });
    expect(second).toEqual({ ok: true, value: { status: 'already_decided' } });
    expect(events).toHaveLength(1);
    expect((await getAgentAction(db, action.id))?.status).toBe('approved');
  });

  it('blocks a non-admin from approving', async () => {
    const { db, action } = await seed();
    const result = await handleApproveAgentAction(
      {
        db,
        getSlackClient: recordingSlackClientFactory({}),
        emitter: recordingEmitter([]),
      },
      payload('U_MEMBER', action.id),
    );

    expect(result.ok).toBe(false);
    expect((await getAgentAction(db, action.id))?.status).toBe('pending_confirmation');
  });
});
