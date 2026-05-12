'use client';

import { useActionState } from 'react';
import { type ActionResult, uploadAction } from './actions';

const containerStyle: React.CSSProperties = { marginTop: '1.5rem' };

const messageStyle = (color: string): React.CSSProperties => ({
  marginTop: '1rem',
  padding: '0.75rem 1rem',
  borderRadius: 4,
  background: color,
  color: '#fff',
});

const ResultDisplay = ({ state }: { state: ActionResult }): React.ReactElement => {
  if (state.kind === 'success') {
    return (
      <div style={messageStyle('#137a3f')}>
        Inserted <strong>{state.inserted}</strong>, updated <strong>{state.updated}</strong>.
      </div>
    );
  }
  if (state.kind === 'parse_error') {
    return <div style={messageStyle('#a11d1d')}>{state.message}</div>;
  }
  if (state.kind === 'row_errors') {
    return (
      <div style={{ ...messageStyle('#a11d1d'), maxHeight: 320, overflow: 'auto' }}>
        <p style={{ margin: '0 0 0.5rem' }}>
          Fix these rows and re-upload (no rows were committed):
        </p>
        <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
          {state.errors.map((e) => (
            <li key={e.rowNumber}>
              Row {e.rowNumber}: {e.errors.join('; ')}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (state.kind === 'no_file') {
    return <div style={messageStyle('#a11d1d')}>Pick a CSV file to upload.</div>;
  }
  return (
    <div style={messageStyle('#a11d1d')}>
      Session expired. <a href="/">Re-install Confetti</a> and come back.
    </div>
  );
};

export const UploadForm = (): React.ReactElement => {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    uploadAction,
    null,
  );
  return (
    <div style={containerStyle}>
      <form action={action} encType="multipart/form-data">
        <input type="file" name="file" accept=".csv,text/csv" required />
        <button
          type="submit"
          disabled={pending}
          style={{
            marginLeft: '0.75rem',
            padding: '0.5rem 1rem',
            background: '#4a154b',
            color: '#fff',
            border: 0,
            borderRadius: 4,
            cursor: pending ? 'wait' : 'pointer',
          }}
        >
          {pending ? 'Uploading…' : 'Upload'}
        </button>
      </form>
      {state && <ResultDisplay state={state} />}
    </div>
  );
};
