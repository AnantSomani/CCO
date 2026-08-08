import { cookies } from 'next/headers';
import { db } from '@/db/client';
import { listPeople } from '@/db/queries/people';
import { UPLOAD_COOKIE_NAME, verifyUploadCookie } from '@/lib/upload-cookie';
import { RosterTable } from './roster-table';

export const dynamic = 'force-dynamic';

const pageStyle: React.CSSProperties = {
  fontFamily: 'sans-serif',
  padding: '3rem',
  maxWidth: 1040,
  margin: '0 auto',
  lineHeight: 1.5,
};

export default async function DashboardPage(): Promise<React.ReactElement> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(UPLOAD_COOKIE_NAME);
  const auth = cookie ? verifyUploadCookie(cookie.value) : null;
  if (!auth?.ok) {
    return (
      <main style={pageStyle}>
        <h1>Install Confetti first</h1>
        <p>Then return here from the success page to manage your team.</p>
        <p>
          <a href="/">← back to install</a>
        </p>
      </main>
    );
  }

  const people = await listPeople(db, auth.value.workspaceId);

  return (
    <main style={pageStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Your team</h1>
        <a href="/upload" style={{ fontSize: '0.9rem' }}>
          Bulk import via CSV →
        </a>
      </div>
      <p style={{ color: '#444' }}>
        Add birthdays and work anniversaries so Confetti can celebrate them. Opted-out people stay
        on the roster but are never surfaced.
      </p>
      <RosterTable people={people} />
    </main>
  );
}
