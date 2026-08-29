import { describe, expect, it, vi } from 'vitest';
import { createAgentRun, insertAgentActions } from '@/db/queries/agent-operations';
import {
  getOrCreateDoorDashExecution,
  updateDoorDashExecution,
} from '@/db/queries/doordash-executions';
import { getWorkspaceBySlackTeamId } from '@/db/queries/workspaces';
import { users, workspaces } from '@/db/schema';
import { ok } from '@/lib/result';
import type { SlackClient } from '@/slack/client';
import {
  getAgentAcknowledgement,
  handleSlashCommand,
  shouldRunCommandAgent,
} from '@/slack/handlers/commands';
import { createTestDb } from './db';

const basePayload = {
  team_id: 'T123',
  team_domain: 'acme',
  user_id: 'U123',
  user_name: 'arul',
  command: '/confetti',
  text: '',
  response_url: 'https://example.com/response',
  trigger_id: 'trigger-1',
} as const;

const slackClientStub: SlackClient = {
  postMessage: async () => ok({ ts: '1', channel: 'C1' }),
  chatUpdate: async () => ok({ ts: '1' }),
  viewsOpen: async () => ok({ viewId: 'V1' }),
  conversationsInfo: async (channel) => ok({ id: channel, name: 'celebrations', is_member: true }),
  usersInfo: async (slackUserId) =>
    ok({
      id: slackUserId,
      name: null,
      realName: null,
      title: null,
      pronouns: null,
      timezone: null,
    }),
};

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const seedWorkspace = async (db: Awaited<ReturnType<typeof createTestDb>>) => {
  await db.insert(workspaces).values({
    id: '00000000-0000-4000-8000-000000000001',
    slackTeamId: 'T123',
    slackTeamName: 'Acme',
    botAccessTokenEnc: 'stub',
    installedBySlackUser: 'U123',
    celebrationChannelId: null,
    defaultBudgetCents: 5000,
    timezone: 'America/New_York',
  });
  await db.insert(users).values({
    workspaceId: '00000000-0000-4000-8000-000000000001',
    slackUserId: 'U123',
    isAdmin: true,
  });
};

describe('handleSlashCommand', () => {
  it('keeps explicit hello on the static path', async () => {
    const db = await createTestDb();
    await seedWorkspace(db);

    const reply = await handleSlashCommand(
      {
        db,
        getSlackClient: async () => ok(slackClientStub),
        log: silentLog,
      },
      { ...basePayload, text: 'hello' },
    );

    expect(reply.responseType).toBe('ephemeral');
    expect(reply.text).toContain('installed in Acme');
  });

  it('keeps explicit channel changes on the static path', async () => {
    const db = await createTestDb();
    await seedWorkspace(db);

    const reply = await handleSlashCommand(
      {
        db,
        getSlackClient: async () => ok(slackClientStub),
        log: silentLog,
      },
      { ...basePayload, text: 'channel <#C999|celebrations>' },
    );

    const workspace = await getWorkspaceBySlackTeamId(db, 'T123');

    expect(reply.text).toContain('Celebration channel set to');
    expect(workspace?.celebrationChannelId).toBe('C999');
  });

  it('blocks non-admin users from changing settings', async () => {
    const db = await createTestDb();
    await seedWorkspace(db);
    await db.insert(users).values({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      slackUserId: 'U_MEMBER',
      isAdmin: false,
    });

    const reply = await handleSlashCommand(
      {
        db,
        getSlackClient: async () => ok(slackClientStub),
        log: silentLog,
      },
      { ...basePayload, user_id: 'U_MEMBER', text: 'budget 100' },
    );

    expect(reply.text).toContain('Only a Confetti workspace admin');
    expect((await getWorkspaceBySlackTeamId(db, 'T123'))?.defaultBudgetCents).toBe(5000);
  });

  it('lists DoorDash preview recovery without mutating carts', async () => {
    const db = await createTestDb();
    await seedWorkspace(db);
    const reply = await handleSlashCommand(
      {
        db,
        getSlackClient: async () => ok(slackClientStub),
        log: silentLog,
      },
      { ...basePayload, text: 'recover' },
    );
    expect(reply.text).toMatch(/no DoorDash preview carts waiting for recovery/i);
  });

  it('lists a DoorDash preview that failed before a cart UUID was saved', async () => {
    const db = await createTestDb();
    await seedWorkspace(db);
    const created = await createAgentRun(db, {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      requestedBySlackUser: 'U123',
      requestText: 'preview pizza',
      idempotencyKey: 'recover-null-cart',
    });
    const [action] = await insertAgentActions(db, created.run, [
      {
        kind: 'doordash_order_preview',
        summary: 'Preview pizza',
        payload: {
          storeId: 'store-1',
          restaurant: 'Round Table Pizza',
          menuId: 'menu-1',
          items: [{ itemId: 'item-1', itemName: 'Gourmet Veggie', quantity: 2 }],
          deliveryAddress: '123 Market St',
          estimatedCostCents: 3200,
        },
        estimatedCostCents: 3200,
      },
    ]);
    if (!action) throw new Error('missing action');
    const execution = await getOrCreateDoorDashExecution(db, {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      actionId: action.id,
      storeId: 'store-1',
      approvedMaxCents: 3200,
    });
    await updateDoorDashExecution(db, {
      executionId: execution.id,
      workspaceId: '00000000-0000-4000-8000-000000000001',
      status: 'needs_review',
      checkpoint: 'creating_cart',
      errorCode: 'doordash_cart_items_need_review',
    });

    const reply = await handleSlashCommand(
      {
        db,
        getSlackClient: async () => ok(slackClientStub),
        log: silentLog,
      },
      { ...basePayload, text: 'recover' },
    );

    expect(reply.text).toContain(action.id);
    expect(reply.text).toContain('no cart yet');
    expect(reply.text).toContain('doordash_cart_items_need_review');
  });
});

describe('shouldRunCommandAgent', () => {
  it('keeps known commands synchronous and routes natural language asynchronously', () => {
    expect(shouldRunCommandAgent('hello')).toBe(false);
    expect(shouldRunCommandAgent('recover')).toBe(false);
    expect(shouldRunCommandAgent('budget 75')).toBe(false);
    expect(shouldRunCommandAgent('channel <#C999|celebrations>')).toBe(false);
    expect(shouldRunCommandAgent('what is our budget?')).toBe(true);
    expect(shouldRunCommandAgent('summarize our roster')).toBe(true);
  });
});

describe('getAgentAcknowledgement', () => {
  it('returns contextual acknowledgements', () => {
    expect(getAgentAcknowledgement('plan a pizza order')).toContain('sandbox order');
    expect(getAgentAcknowledgement('plan a pizza order', 'doordash')).toContain(
      'live DoorDash options',
    );
    expect(getAgentAcknowledgement('plan a pizza order', 'doordash')).toContain(
      'no order will be submitted',
    );
    expect(getAgentAcknowledgement('plan a team offsite')).toContain('event plan');
    expect(getAgentAcknowledgement('what is our current budget?')).toContain('answer');
    expect(getAgentAcknowledgement('set our default budget to $75')).toContain('require approval');
  });
});
