import { Instrument_Serif, Inter } from 'next/font/google';
import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import { listPeople } from '@/db/queries/people';
import { ThetaDashboard } from './theta-dashboard';
import { getThetaWorkspaceId } from './theta-workspace';

// Fonts mirrored from thetasoftware.com: Instrument Serif for display, Inter
// for body — the same pairing the marketing site uses.
const inter = Inter({ subsets: ['latin'], display: 'swap' });
const instrumentSerif = Instrument_Serif({ subsets: ['latin'], weight: '400', display: 'swap' });

// Dev-only preview of the Theta proxy dashboard, backed by the real (sandbox)
// Supabase `people` table and themed to match Theta's brand.
export const dynamic = 'force-dynamic';

export default async function ThetaPreviewPage(): Promise<React.ReactElement> {
  if (process.env.NODE_ENV === 'production') notFound();
  const workspaceId = await getThetaWorkspaceId();
  const people = await listPeople(db, workspaceId);
  return (
    <ThetaDashboard
      sansClass={inter.className}
      serifClass={instrumentSerif.className}
      people={people.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        birthdayMonth: p.birthdayMonth,
        birthdayDay: p.birthdayDay,
        startDate: p.startDate,
        team: p.team,
        optedOut: p.optedOut,
      }))}
    />
  );
}
