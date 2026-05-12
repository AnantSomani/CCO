import type { Db } from '@/db/client';
import { findOrCreateEvents, type NewEventInput } from '@/db/queries/events';
import { findAnniversaryCandidates, findBirthdayCandidates } from '@/db/queries/people';
import { listAllWorkspaces, type WorkspaceListItem } from '@/db/queries/workspaces';
import { type CalendarDate, todayInWorkspaceTz } from '@/lib/dates';
import { log as defaultLog } from '@/lib/log';
import { inngest } from './client';

// Calendar-date arithmetic via UTC. DST-safe by construction (UTC has no DST),
// and target dates are pure (year, month, day) tuples so workspace-local
// reasoning stays correct.
const addDays = (today: CalendarDate, days: number): CalendarDate => {
  const utc = new Date(Date.UTC(today.year, today.month - 1, today.day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
};

const formatYmd = (d: CalendarDate): string =>
  `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

type Logger = { info: (msg: string, meta?: Record<string, unknown>) => void };

type RunArgs = {
  db: Db;
  log?: Logger;
  // Pinned in tests; production passes the real clock per-workspace tz.
  todayFor?: (ws: WorkspaceListItem) => CalendarDate;
};

export type DailyScanSummary = {
  workspaceId: string;
  birthdayCandidates: number;
  anniversaryCandidates: number;
  created: number;
};

export const runDailyScan = async ({
  db,
  log = defaultLog,
  todayFor = (ws) => todayInWorkspaceTz(ws.timezone),
}: RunArgs): Promise<DailyScanSummary[]> => {
  const workspaces = await listAllWorkspaces(db);
  const summaries: DailyScanSummary[] = [];

  for (const ws of workspaces) {
    const today = todayFor(ws);
    const birthdayTarget = addDays(today, 7);
    const anniversaryTarget = addDays(today, 14);

    const birthdayPeople = await findBirthdayCandidates(
      db,
      ws.id,
      birthdayTarget.month,
      birthdayTarget.day,
    );
    const anniversaryPeople = await findAnniversaryCandidates(
      db,
      ws.id,
      anniversaryTarget.month,
      anniversaryTarget.day,
      formatYmd(today),
    );

    const candidates: NewEventInput[] = [
      ...birthdayPeople.map(
        (p): NewEventInput => ({
          workspaceId: ws.id,
          personId: p.id,
          kind: 'birthday',
          eventDate: formatYmd(birthdayTarget),
          years: null,
        }),
      ),
      ...anniversaryPeople
        .filter((p): p is typeof p & { startDate: string } => p.startDate !== null)
        .map((p): NewEventInput => {
          // startDate is "YYYY-MM-DD" from the Postgres date type.
          const startYear = Number(p.startDate.slice(0, 4));
          return {
            workspaceId: ws.id,
            personId: p.id,
            kind: 'anniversary',
            eventDate: formatYmd(anniversaryTarget),
            years: anniversaryTarget.year - startYear,
          };
        }),
    ];

    const created = await findOrCreateEvents(db, candidates);

    log.info('daily scan complete', {
      workspaceId: ws.id,
      candidates: candidates.length,
      created: created.length,
    });

    summaries.push({
      workspaceId: ws.id,
      birthdayCandidates: birthdayPeople.length,
      anniversaryCandidates: anniversaryPeople.length,
      created: created.length,
    });
  }

  return summaries;
};

// Inngest wrapper. Cron `0 14 * * *` = 14:00 UTC daily.
// TODO: per-workspace local-time cron is a v2 polish (PROJECT.md week 2 note).
// v1 runs once at 14:00 UTC and lets per-workspace tz logic inside
// runDailyScan handle local-calendar arithmetic.
export const dailyScan = inngest.createFunction(
  {
    id: 'daily-scan',
    triggers: [{ cron: '0 14 * * *' }, { event: 'confetti/scan.manual' }],
  },
  async () => {
    const { db } = await import('@/db/client');
    const summaries = await runDailyScan({ db });
    return { summaries };
  },
);
