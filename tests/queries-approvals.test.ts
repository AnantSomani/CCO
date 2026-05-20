import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { getApprovalByEventId, insertApproval } from '@/db/queries/approvals';
import { findOrCreateEvents } from '@/db/queries/events';
import { upsertPeople } from '@/db/queries/people';
import { upsertUser } from '@/db/queries/users';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { createTestDb } from './db';

type Seed = { workspaceId: string; userId: string; eventId: string };

const seed = async (db: Db): Promise<Seed> => {
  const ws = await upsertWorkspace(db, {
    slackTeamId: `T_${Math.random().toString(36).slice(2, 10)}`,
    slackTeamName: 'Acme',
    installedBySlackUser: 'U_INSTALLER',
    botAccessToken: 'xoxb-test',
  });
  const user = await upsertUser(db, {
    workspaceId: ws.id,
    slackUserId: 'U_INSTALLER',
    isAdmin: true,
  });
  await upsertPeople(db, ws.id, [
    {
      name: 'Alice',
      email: 'a@x.com',
      birthdayMonth: 5,
      birthdayDay: 19,
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
      eventDate: '2026-05-19',
      years: null,
    },
  ]);
  const ev = events[0];
  if (!ev) throw new Error('seed event missing');
  return { workspaceId: ws.id, userId: user.id, eventId: ev.id };
};

describe('insertApproval', () => {
  it('inserts an approved decision and returns the row', async () => {
    const db = await createTestDb();
    const { userId, eventId } = await seed(db);
    const approval = await insertApproval(db, {
      eventId,
      approverUserId: userId,
      decision: 'approved',
      chosenSuggestionId: null,
      approvedBudgetCents: 5000,
    });
    expect(approval?.decision).toBe('approved');
    expect(approval?.approvedBudgetCents).toBe(5000);
    const back = await getApprovalByEventId(db, eventId);
    expect(back?.id).toBe(approval?.id);
  });

  it('is idempotent: second insert on same event returns null', async () => {
    const db = await createTestDb();
    const { userId, eventId } = await seed(db);
    const first = await insertApproval(db, {
      eventId,
      approverUserId: userId,
      decision: 'approved',
    });
    const second = await insertApproval(db, {
      eventId,
      approverUserId: userId,
      decision: 'skipped',
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const back = await getApprovalByEventId(db, eventId);
    expect(back?.decision).toBe('approved');
  });
});
