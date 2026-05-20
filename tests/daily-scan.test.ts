import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { upsertPeople } from '@/db/queries/people';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { events, people, workspaces } from '@/db/schema';
import { runDailyScan } from '@/jobs/daily-scan';
import { type CalendarDate, todayInWorkspaceTz } from '@/lib/dates';
import { EVENT_NAME_EVENT_CREATED } from '@/slack/ids';
import { createTestDb } from './db';

const TODAY: CalendarDate = { year: 2026, month: 5, day: 12 };
const pinned = (today: CalendarDate) => () => today;
const noopLog = { info: (): void => {} };

const seedWorkspace = async (db: Db, tz = 'UTC'): Promise<string> => {
  const ws = await upsertWorkspace(db, {
    slackTeamId: `T_${Math.random().toString(36).slice(2, 10)}`,
    slackTeamName: 'Acme',
    installedBySlackUser: 'U_INSTALLER',
    botAccessToken: 'xoxb-test',
  });
  if (tz !== 'America/New_York') {
    await db.update(workspaces).set({ timezone: tz }).where(eq(workspaces.id, ws.id));
  }
  return ws.id;
};

const utc = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));

describe('runDailyScan', () => {
  it('picks up a birthday exactly 7 days out', async () => {
    const db = await createTestDb();
    const wsId = await seedWorkspace(db);
    await upsertPeople(db, wsId, [
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
    await runDailyScan({ db, log: noopLog, todayFor: pinned(TODAY) });
    const all = await db.select().from(events).where(eq(events.workspaceId, wsId));
    expect(all).toHaveLength(1);
    expect(all[0]?.kind).toBe('birthday');
    expect(all[0]?.eventDate).toBe('2026-05-19');
    expect(all[0]?.years).toBeNull();
  });

  it('does NOT pick up birthdays at +6 or +8 days (off-by-one guard)', async () => {
    const db = await createTestDb();
    const wsId = await seedWorkspace(db);
    await upsertPeople(db, wsId, [
      {
        name: 'Six',
        email: 'six@x.com',
        birthdayMonth: 5,
        birthdayDay: 18,
        startDate: null,
        team: null,
        role: null,
      },
      {
        name: 'Eight',
        email: 'eight@x.com',
        birthdayMonth: 5,
        birthdayDay: 20,
        startDate: null,
        team: null,
        role: null,
      },
    ]);
    await runDailyScan({ db, log: noopLog, todayFor: pinned(TODAY) });
    expect(await db.select().from(events).where(eq(events.workspaceId, wsId))).toHaveLength(0);
  });

  it('picks up an anniversary 14 days out with past start_date', async () => {
    const db = await createTestDb();
    const wsId = await seedWorkspace(db);
    await upsertPeople(db, wsId, [
      {
        name: 'Bob',
        email: 'b@x.com',
        birthdayMonth: null,
        birthdayDay: null,
        startDate: utc(2020, 5, 26),
        team: null,
        role: null,
      },
    ]);
    await runDailyScan({ db, log: noopLog, todayFor: pinned(TODAY) });
    const all = await db.select().from(events).where(eq(events.workspaceId, wsId));
    expect(all).toHaveLength(1);
    expect(all[0]?.kind).toBe('anniversary');
    expect(all[0]?.eventDate).toBe('2026-05-26');
    expect(all[0]?.years).toBe(6);
  });

  it('does NOT pick up an anniversary when start_date is in the future', async () => {
    const db = await createTestDb();
    const wsId = await seedWorkspace(db);
    await upsertPeople(db, wsId, [
      {
        name: 'Future',
        email: 'f@x.com',
        birthdayMonth: null,
        birthdayDay: null,
        startDate: utc(2030, 5, 26),
        team: null,
        role: null,
      },
    ]);
    await runDailyScan({ db, log: noopLog, todayFor: pinned(TODAY) });
    expect(await db.select().from(events).where(eq(events.workspaceId, wsId))).toHaveLength(0);
  });

  it('filters opted-out people at the query layer', async () => {
    const db = await createTestDb();
    const wsId = await seedWorkspace(db);
    await upsertPeople(db, wsId, [
      {
        name: 'OptOut',
        email: 'o@x.com',
        birthdayMonth: 5,
        birthdayDay: 19,
        startDate: null,
        team: null,
        role: null,
      },
    ]);
    await db.update(people).set({ optedOut: true }).where(eq(people.email, 'o@x.com'));
    await runDailyScan({ db, log: noopLog, todayFor: pinned(TODAY) });
    expect(await db.select().from(events).where(eq(events.workspaceId, wsId))).toHaveLength(0);
  });

  it('is idempotent: second run creates no new events', async () => {
    const db = await createTestDb();
    const wsId = await seedWorkspace(db);
    await upsertPeople(db, wsId, [
      {
        name: 'A',
        email: 'a@x.com',
        birthdayMonth: 5,
        birthdayDay: 19,
        startDate: null,
        team: null,
        role: null,
      },
    ]);
    const r1 = await runDailyScan({ db, log: noopLog, todayFor: pinned(TODAY) });
    const r2 = await runDailyScan({ db, log: noopLog, todayFor: pinned(TODAY) });
    expect(r1[0]?.created).toBe(1);
    expect(r2[0]?.created).toBe(0);
    expect(await db.select().from(events).where(eq(events.workspaceId, wsId))).toHaveLength(1);
  });

  it('emits confetti/event.created only for newly-created events', async () => {
    const db = await createTestDb();
    const wsId = await seedWorkspace(db);
    await upsertPeople(db, wsId, [
      {
        name: 'A',
        email: 'a@x.com',
        birthdayMonth: 5,
        birthdayDay: 19,
        startDate: null,
        team: null,
        role: null,
      },
    ]);
    const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
    const emitter = {
      send: async (e: { name: string; data: Record<string, unknown> }) => {
        sent.push(e);
        return undefined;
      },
    };
    await runDailyScan({ db, log: noopLog, todayFor: pinned(TODAY), emitter });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe(EVENT_NAME_EVENT_CREATED);
    // Second run: no new events, no new emits.
    await runDailyScan({ db, log: noopLog, todayFor: pinned(TODAY), emitter });
    expect(sent).toHaveLength(1);
  });

  it('evaluates "today" in workspace tz, not UTC', async () => {
    const db = await createTestDb();
    const wsId = await seedWorkspace(db, 'America/Los_Angeles');
    await upsertPeople(db, wsId, [
      {
        name: 'A',
        email: 'a@x.com',
        birthdayMonth: 5,
        birthdayDay: 19,
        startDate: null,
        team: null,
        role: null,
      },
    ]);
    // 2026-05-13T05:00:00Z = 2026-05-12 22:00 LA. Today in LA = May 12,
    // not May 13. Birthday on May 19 must be picked up (exactly +7 LA-days).
    const pinnedNow = new Date('2026-05-13T05:00:00Z');
    await runDailyScan({
      db,
      log: noopLog,
      todayFor: (ws) => todayInWorkspaceTz(ws.timezone, pinnedNow),
    });
    const all = await db.select().from(events).where(eq(events.workspaceId, wsId));
    expect(all).toHaveLength(1);
    expect(all[0]?.eventDate).toBe('2026-05-19');
  });
});
