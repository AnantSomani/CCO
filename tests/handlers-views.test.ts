import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { getApprovalByEventId } from '@/db/queries/approvals';
import { findOrCreateEvents, getEventById, setEventApprovalMessage } from '@/db/queries/events';
import { upsertPeople } from '@/db/queries/people';
import { insertSuggestions } from '@/db/queries/suggestions';
import { upsertUser } from '@/db/queries/users';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { handleModifySubmit } from '@/slack/handlers/views';
import {
  BLOCK_MODIFY_BUDGET,
  BLOCK_MODIFY_GESTURE,
  CALLBACK_MODIFY_GESTURE,
  EVENT_NAME_DAY_OF_SCHEDULED,
  INPUT_BUDGET,
  INPUT_GESTURE,
} from '@/slack/ids';
import type { ViewSubmissionPayload } from '@/slack/schemas';
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
      team: null,
      role: null,
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
  await insertSuggestions(db, ev.id, [
    {
      gestureSummary: 'Card',
      gestureDetails: {},
      estimatedCostCents: 1500,
      rank: 1,
    },
  ]);
  await setEventApprovalMessage(db, ev.id, 'D_DM', '111.222');
  return { db, workspaceId: ws.id, slackTeamId, slackUserId: 'U_ADMIN', eventId: ev.id };
};

const buildPayload = (
  s: Seed,
  values: { gesture: string | null; budget: string | null },
): ViewSubmissionPayload => ({
  type: 'view_submission',
  team: { id: s.slackTeamId },
  user: { id: s.slackUserId },
  view: {
    callback_id: CALLBACK_MODIFY_GESTURE,
    private_metadata: JSON.stringify({ eventId: s.eventId }),
    state: {
      values: {
        [BLOCK_MODIFY_GESTURE]: {
          [INPUT_GESTURE]: { type: 'plain_text_input', value: values.gesture },
        },
        [BLOCK_MODIFY_BUDGET]: {
          [INPUT_BUDGET]: { type: 'number_input', value: values.budget },
        },
      },
    },
  },
});

describe('handleModifySubmit', () => {
  it('persists a modified approval, schedules day-of, updates the DM', async () => {
    const s = await seed();
    const slack: RecordingSlackClient = {};
    const sent: SentEvent[] = [];
    const result = await handleModifySubmit(
      {
        db: s.db,
        getSlackClient: recordingSlackClientFactory(slack),
        emitter: recordingEmitter(sent),
      },
      buildPayload(s, { gesture: 'Send them flowers', budget: '42.50' }),
    );
    expect(result.ok && result.value.status).toBe('approved_modified');
    const approval = await getApprovalByEventId(s.db, s.eventId);
    expect(approval?.decision).toBe('modified');
    expect(approval?.customGestureText).toBe('Send them flowers');
    expect(approval?.approvedBudgetCents).toBe(4250);
    const ev = await getEventById(s.db, s.eventId);
    expect(ev?.status).toBe('approved');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe(EVENT_NAME_DAY_OF_SCHEDULED);
    expect(slack.chatUpdates?.[0]?.text).toContain('modified');
  });

  it('returns validation_error when gesture is empty', async () => {
    const s = await seed();
    const result = await handleModifySubmit(
      {
        db: s.db,
        getSlackClient: recordingSlackClientFactory({}),
        emitter: recordingEmitter([]),
      },
      buildPayload(s, { gesture: '', budget: '50' }),
    );
    expect(result.ok && result.value.status).toBe('validation_error');
    expect(await getApprovalByEventId(s.db, s.eventId)).toBeNull();
  });

  it('returns validation_error when budget is not parseable', async () => {
    const s = await seed();
    const result = await handleModifySubmit(
      {
        db: s.db,
        getSlackClient: recordingSlackClientFactory({}),
        emitter: recordingEmitter([]),
      },
      buildPayload(s, { gesture: 'Cake', budget: 'lots' }),
    );
    expect(result.ok && result.value.status).toBe('validation_error');
    expect(await getApprovalByEventId(s.db, s.eventId)).toBeNull();
  });

  it('returns already_decided when an approval already exists', async () => {
    const s = await seed();
    const ctx = {
      db: s.db,
      getSlackClient: recordingSlackClientFactory({}),
      emitter: recordingEmitter([]),
    };
    const payload = buildPayload(s, { gesture: 'Cake', budget: '50' });
    await handleModifySubmit(ctx, payload);
    const second = await handleModifySubmit(ctx, payload);
    expect(second.ok && second.value.status).toBe('already_decided');
  });
});
