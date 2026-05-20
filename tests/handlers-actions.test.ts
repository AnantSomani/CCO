import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { getApprovalByEventId } from '@/db/queries/approvals';
import { findOrCreateEvents, getEventById, setEventApprovalMessage } from '@/db/queries/events';
import { upsertPeople } from '@/db/queries/people';
import { insertSuggestions } from '@/db/queries/suggestions';
import { upsertUser } from '@/db/queries/users';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { handleApproveEvent, handleModifyEvent, handleSkipEvent } from '@/slack/handlers/actions';
import {
  ACTION_APPROVE_EVENT,
  ACTION_MODIFY_EVENT,
  ACTION_SKIP_EVENT,
  EVENT_NAME_DAY_OF_SCHEDULED,
} from '@/slack/ids';
import type { BlockActionsPayload } from '@/slack/schemas';
import { createTestDb } from './db';
import {
  type RecordingSlackClient,
  recordingEmitter,
  recordingSlackClientFactory,
  type SentEvent,
} from './slack-stub';

type Seed = {
  db: Db;
  workspaceId: string;
  slackTeamId: string;
  slackUserId: string;
  eventId: string;
  suggestionIds: string[];
};

const seed = async (): Promise<Seed> => {
  const db = await createTestDb();
  const slackTeamId = `T_${Math.random().toString(36).slice(2, 10)}`;
  const ws = await upsertWorkspace(db, {
    slackTeamId,
    slackTeamName: 'Acme',
    installedBySlackUser: 'U_ADMIN',
    botAccessToken: 'xoxb-test',
  });
  await upsertUser(db, { workspaceId: ws.id, slackUserId: 'U_ADMIN', isAdmin: true });
  await upsertPeople(db, ws.id, [
    {
      name: 'Alice Park',
      email: 'a@x.com',
      birthdayMonth: 5,
      birthdayDay: 25,
      startDate: null,
      team: 'Eng',
      role: 'Engineer',
    },
  ]);
  const person = await db.query.people.findFirst();
  if (!person) throw new Error('seed person missing');
  const events = await findOrCreateEvents(db, [
    {
      workspaceId: ws.id,
      personId: person.id,
      kind: 'birthday',
      eventDate: '2026-05-25',
      years: null,
    },
  ]);
  const ev = events[0];
  if (!ev) throw new Error('seed event missing');
  const sugs = await insertSuggestions(db, ev.id, [
    {
      gestureSummary: 'Card from team + gift card',
      gestureDetails: {},
      estimatedCostCents: 4500,
      rank: 1,
    },
    {
      gestureSummary: 'Surprise cake at standup',
      gestureDetails: {},
      estimatedCostCents: 6500,
      rank: 2,
    },
  ]);
  // Stash approval-DM coordinates so chat.update has a target.
  await setEventApprovalMessage(db, ev.id, 'D_DM_1', '111.222');
  return {
    db,
    workspaceId: ws.id,
    slackTeamId,
    slackUserId: 'U_ADMIN',
    eventId: ev.id,
    suggestionIds: sugs.map((s) => s.id),
  };
};

const buttonPayload = (
  s: Seed,
  actionId: string,
  value: Record<string, unknown>,
): BlockActionsPayload => ({
  type: 'block_actions',
  team: { id: s.slackTeamId },
  user: { id: s.slackUserId },
  channel: { id: 'D_DM_1' },
  message: { ts: '111.222' },
  trigger_id: 'TRIG_1',
  actions: [{ action_id: actionId, value: JSON.stringify(value) }],
});

describe('handleApproveEvent', () => {
  it('writes an approval, flips status, schedules day-of, and updates the DM', async () => {
    const s = await seed();
    const slack: RecordingSlackClient = {};
    const sent: SentEvent[] = [];
    const result = await handleApproveEvent(
      {
        db: s.db,
        getSlackClient: recordingSlackClientFactory(slack),
        emitter: recordingEmitter(sent),
      },
      buttonPayload(s, ACTION_APPROVE_EVENT, {
        eventId: s.eventId,
        suggestionId: s.suggestionIds[0],
      }),
    );
    expect(result.ok && result.value.status).toBe('approved');

    const approval = await getApprovalByEventId(s.db, s.eventId);
    expect(approval?.decision).toBe('approved');
    expect(approval?.chosenSuggestionId).toBe(s.suggestionIds[0]);
    expect(approval?.approvedBudgetCents).toBe(4500);

    const ev = await getEventById(s.db, s.eventId);
    expect(ev?.status).toBe('approved');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe(EVENT_NAME_DAY_OF_SCHEDULED);
    // 2026-05-25T14:00:00Z
    expect(sent[0]?.ts).toBe(Date.UTC(2026, 4, 25, 14, 0, 0));
    expect(sent[0]?.data).toEqual({ eventId: s.eventId });

    expect(slack.chatUpdates).toHaveLength(1);
    expect(slack.chatUpdates?.[0]?.text).toContain('Approved');
  });

  it('is idempotent: second approve on the same event is a no-op (already_decided)', async () => {
    const s = await seed();
    const slack: RecordingSlackClient = {};
    const sent: SentEvent[] = [];
    const ctx = {
      db: s.db,
      getSlackClient: recordingSlackClientFactory(slack),
      emitter: recordingEmitter(sent),
    };
    const payload = buttonPayload(s, ACTION_APPROVE_EVENT, {
      eventId: s.eventId,
      suggestionId: s.suggestionIds[0],
    });
    await handleApproveEvent(ctx, payload);
    const second = await handleApproveEvent(ctx, payload);
    expect(second.ok && second.value.status).toBe('already_decided');
    expect(sent).toHaveLength(1); // no double-schedule
  });
});

describe('handleSkipEvent', () => {
  it('writes a skipped approval and updates the DM', async () => {
    const s = await seed();
    const slack: RecordingSlackClient = {};
    const sent: SentEvent[] = [];
    const result = await handleSkipEvent(
      {
        db: s.db,
        getSlackClient: recordingSlackClientFactory(slack),
        emitter: recordingEmitter(sent),
      },
      buttonPayload(s, ACTION_SKIP_EVENT, { eventId: s.eventId }),
    );
    expect(result.ok && result.value.status).toBe('skipped');
    const approval = await getApprovalByEventId(s.db, s.eventId);
    expect(approval?.decision).toBe('skipped');
    const ev = await getEventById(s.db, s.eventId);
    expect(ev?.status).toBe('skipped');
    expect(sent).toHaveLength(0); // skip does NOT schedule day-of
    expect(slack.chatUpdates?.[0]?.text).toContain('Skipped');
  });
});

describe('handleModifyEvent', () => {
  it('opens a modal with the modify view; does not write an approval', async () => {
    const s = await seed();
    const slack: RecordingSlackClient = {};
    const sent: SentEvent[] = [];
    const result = await handleModifyEvent(
      {
        db: s.db,
        getSlackClient: recordingSlackClientFactory(slack),
        emitter: recordingEmitter(sent),
      },
      buttonPayload(s, ACTION_MODIFY_EVENT, { eventId: s.eventId }),
    );
    expect(result.ok && result.value.status).toBe('modal_opened');
    expect(slack.viewsOpens).toHaveLength(1);
    expect(slack.viewsOpens?.[0]?.trigger_id).toBe('TRIG_1');
    expect(await getApprovalByEventId(s.db, s.eventId)).toBeNull();
    expect(sent).toHaveLength(0);
  });
});
