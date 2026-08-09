import { describe, expect, it, vi } from 'vitest';
import { runAdminAgent } from '@/agent/admin-agent';
import type { Workspace } from '@/db/queries/workspaces';
import { messageWithToolUses, scriptedAnthropic } from './anthropic-stub';
import { createTestDb } from './db';

const workspace: Workspace = {
  id: '00000000-0000-4000-8000-000000000021',
  slackTeamId: 'T_AGENT',
  slackTeamName: 'Acme',
  installedBySlackUser: 'U_ADMIN',
  celebrationChannelId: null,
  defaultBudgetCents: 10_000,
  timezone: 'America/New_York',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('runAdminAgent', () => {
  it('labels the workspace budget as a per-event total', async () => {
    const db = await createTestDb();
    const anthropic = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          { id: 'tool-settings', name: 'get_workspace_settings', input: {} },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-final',
            name: 'finalize_response',
            input: { reply_text: 'The total per-event budget is $100.' },
          },
        ]),
      },
    ]);

    const result = await runAdminAgent({
      anthropic: anthropic.client,
      db,
      workspace,
      rawText: 'what is our current budget?',
      userId: 'U_ADMIN',
      log,
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(anthropic.calls[1]?.messages)).toContain(
      '\\"budgetScope\\":\\"per_event_total\\"',
    );
    expect(JSON.stringify(anthropic.calls[1]?.messages)).toContain(
      '\\"defaultPerEventBudgetCents\\":10000',
    );
  });

  it('returns a grounded budget proposal without applying it', async () => {
    const db = await createTestDb();
    const anthropic = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-budget',
            name: 'propose_set_default_budget',
            input: { amount_usd: 75, summary: 'Set the default celebration budget to $75' },
          },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-final',
            name: 'finalize_response',
            input: { reply_text: 'I prepared the $75 budget change for approval.' },
          },
        ]),
      },
    ]);

    const result = await runAdminAgent({
      anthropic: anthropic.client,
      db,
      workspace,
      rawText: 'set our default budget to $75',
      userId: 'U_ADMIN',
      log,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedActions).toEqual([
      {
        kind: 'set_default_budget',
        summary: 'Set the default celebration budget to $75',
        payload: { amountCents: 7500 },
        estimatedCostCents: null,
      },
    ]);
  });

  it('rejects a budget amount not present in the user request', async () => {
    const db = await createTestDb();
    const anthropic = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-budget',
            name: 'propose_set_default_budget',
            input: { amount_usd: 75, summary: 'Set budget to $75' },
          },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-final',
            name: 'finalize_response',
            input: { reply_text: 'Please confirm the exact amount.' },
          },
        ]),
      },
    ]);

    const result = await runAdminAgent({
      anthropic: anthropic.client,
      db,
      workspace,
      rawText: 'set our budget to $50',
      userId: 'U_ADMIN',
      log,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedActions).toEqual([]);
    expect(JSON.stringify(anthropic.calls[1]?.messages)).toContain(
      'not explicitly present in the user request',
    );
  });

  it('creates a sandbox food-order proposal under budget', async () => {
    const db = await createTestDb();
    const anthropic = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-order',
            name: 'propose_sandbox_food_order',
            input: {
              restaurant: 'Local Pizza',
              itemsDescription: 'Five large pizzas',
              headcount: 20,
              deliveryAt: '2026-08-12T11:00:00-07:00',
              deliveryAddress: '123 Market St, San Francisco, CA',
              estimatedCostCents: 9000,
              summary: 'Sandbox pizza order for 20 people',
            },
          },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-final',
            name: 'finalize_response',
            input: { reply_text: 'I prepared a sandbox order for approval.' },
          },
        ]),
      },
    ]);

    const result = await runAdminAgent({
      anthropic: anthropic.client,
      db,
      workspace,
      rawText:
        'Plan a sandbox pizza order from Local Pizza for 20 people at 123 Market St, San Francisco, CA on August 12 at 11am PT for about $90.',
      userId: 'U_ADMIN',
      log,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedActions[0]?.kind).toBe('sandbox_food_order');
    expect(result.value.proposedActions[0]?.estimatedCostCents).toBe(9000);
  });
});
