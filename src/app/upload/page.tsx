import { cookies } from 'next/headers';
import { UPLOAD_COOKIE_NAME, verifyUploadCookie } from '@/lib/upload-cookie';
import { UploadForm } from './upload-form';

export const dynamic = 'force-dynamic';

const pageStyle: React.CSSProperties = {
  fontFamily: 'sans-serif',
  padding: '3rem',
  maxWidth: 720,
  margin: '0 auto',
  lineHeight: 1.5,
};

export default async function UploadPage(): Promise<React.ReactElement> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(UPLOAD_COOKIE_NAME);
  const auth = cookie ? verifyUploadCookie(cookie.value) : null;
  if (!auth?.ok) {
    return (
      <main style={pageStyle}>
        <h1>Install Confetti first</h1>
        <p>Then return here from the success page to upload your roster.</p>
        <p>
          <a href="/">← back to install</a>
        </p>
      </main>
    );
  }
  return (
    <main style={pageStyle}>
      <h1>Upload roster CSV</h1>
      <p style={{ color: '#444' }}>
        Required columns: <code>name</code>, <code>email</code>. Optional: <code>birthday</code>{' '}
        (MM-DD or MM/DD), <code>start_date</code> (YYYY-MM-DD), <code>team</code>, <code>role</code>
        .
      </p>
      <p style={{ color: '#666', fontSize: '0.9rem' }}>
        Re-uploading is safe — it updates existing people by email and preserves opt-outs.
      </p>
      <UploadForm />
    </main>
  );
}
