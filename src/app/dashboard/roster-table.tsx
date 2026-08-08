'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { Person } from '@/db/queries/people';
import {
  addPersonAction,
  type DashboardActionResult,
  deletePersonAction,
  toggleOptOutAction,
  updatePersonAction,
} from './actions';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number): string => String(n).padStart(2, '0');

const formatBirthday = (month: number | null, day: number | null): string =>
  month && day ? `${MONTHS[month - 1]} ${day}` : '—';

// startDate is a YYYY-MM-DD string; format without constructing a Date (which
// would apply the local timezone and can shift the calendar day).
const formatStartDate = (startDate: string | null): string => {
  if (!startDate) return '—';
  const [y, m, d] = startDate.split('-').map(Number);
  if (!y || !m || !d) return startDate;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

const birthdayInputValue = (month: number | null, day: number | null): string =>
  month && day ? `${pad2(month)}-${pad2(day)}` : '';

const cell: React.CSSProperties = { padding: '0.5rem 0.75rem', borderBottom: '1px solid #eee' };
const th: React.CSSProperties = {
  ...cell,
  textAlign: 'left',
  fontWeight: 600,
  borderBottom: '2px solid #ddd',
};
const input: React.CSSProperties = {
  padding: '0.35rem 0.5rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  font: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
};
const btn: React.CSSProperties = {
  padding: '0.35rem 0.7rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  background: '#fff',
  cursor: 'pointer',
  font: 'inherit',
};
const primaryBtn: React.CSSProperties = {
  ...btn,
  background: '#4f46e5',
  color: '#fff',
  borderColor: '#4f46e5',
};

const ErrorList = ({ state }: { state: DashboardActionResult }): React.ReactElement | null => {
  if (state.kind === 'validation_error') {
    return (
      <ul style={{ color: '#b91c1c', margin: '0.5rem 0', paddingLeft: '1.2rem' }}>
        {state.errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    );
  }
  if (state.kind === 'duplicate_email') {
    return <p style={{ color: '#b91c1c' }}>That email is already on the roster.</p>;
  }
  if (state.kind === 'auth_error') {
    return <p style={{ color: '#b91c1c' }}>Session expired — reinstall or reopen from Slack.</p>;
  }
  if (state.kind === 'not_found') {
    return <p style={{ color: '#b91c1c' }}>That person no longer exists — refresh the page.</p>;
  }
  return null;
};

const AddPersonForm = (): React.ReactElement => {
  const [state, action, pending] = useActionState<DashboardActionResult, FormData>(
    addPersonAction,
    { kind: 'idle' },
  );
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the inputs after a successful add so the next person starts fresh.
  useEffect(() => {
    if (state.kind === 'success') formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} style={{ margin: '1rem 0 2rem' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '0.5rem',
          alignItems: 'end',
        }}
      >
        <label>
          Name*
          <input style={input} name="name" placeholder="Jordan Lee" />
        </label>
        <label>
          Email*
          <input style={input} name="email" type="email" placeholder="jordan@acme.com" />
        </label>
        <label>
          Birthday
          <input style={input} name="birthday" placeholder="MM-DD" />
        </label>
        <label>
          Start date
          <input style={input} name="start_date" type="date" />
        </label>
        <label>
          Team
          <input style={input} name="team" placeholder="Eng" />
        </label>
        <label>
          Role
          <input style={input} name="role" placeholder="Engineer" />
        </label>
      </div>
      <div style={{ marginTop: '0.75rem' }}>
        <button style={primaryBtn} type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add person'}
        </button>
        {state.kind === 'success' && (
          <span style={{ color: '#15803d', marginLeft: '0.75rem' }}>{state.message}</span>
        )}
      </div>
      <ErrorList state={state} />
    </form>
  );
};

const EditRow = ({
  person,
  onDone,
}: {
  person: Person;
  onDone: () => void;
}): React.ReactElement => {
  const [state, action, pending] = useActionState<DashboardActionResult, FormData>(
    updatePersonAction,
    { kind: 'idle' },
  );

  useEffect(() => {
    if (state.kind === 'success') onDone();
  }, [state, onDone]);

  return (
    <tr>
      <td style={cell} colSpan={7}>
        <form action={action}>
          <input type="hidden" name="personId" value={person.id} />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: '0.5rem',
              alignItems: 'end',
            }}
          >
            <label>
              Name*
              <input style={input} name="name" defaultValue={person.name} />
            </label>
            <label>
              Email (read-only)
              <input style={{ ...input, background: '#f3f4f6' }} value={person.email} readOnly />
            </label>
            <label>
              Birthday
              <input
                style={input}
                name="birthday"
                placeholder="MM-DD"
                defaultValue={birthdayInputValue(person.birthdayMonth, person.birthdayDay)}
              />
            </label>
            <label>
              Start date
              <input
                style={input}
                name="start_date"
                type="date"
                defaultValue={person.startDate ?? ''}
              />
            </label>
            <label>
              Team
              <input style={input} name="team" defaultValue={person.team ?? ''} />
            </label>
            <label>
              Role
              <input style={input} name="role" defaultValue={person.role ?? ''} />
            </label>
          </div>
          <div style={{ marginTop: '0.6rem', display: 'flex', gap: '0.5rem' }}>
            <button style={primaryBtn} type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </button>
            <button style={btn} type="button" onClick={onDone} disabled={pending}>
              Cancel
            </button>
          </div>
          <ErrorList state={state} />
        </form>
      </td>
    </tr>
  );
};

const DisplayRow = ({
  person,
  onEdit,
}: {
  person: Person;
  onEdit: () => void;
}): React.ReactElement => (
  <tr style={person.optedOut ? { opacity: 0.55 } : undefined}>
    <td style={cell}>{person.name}</td>
    <td style={cell}>{person.email}</td>
    <td style={cell}>{formatBirthday(person.birthdayMonth, person.birthdayDay)}</td>
    <td style={cell}>{formatStartDate(person.startDate)}</td>
    <td style={cell}>{person.team ?? '—'}</td>
    <td style={cell}>{person.optedOut ? 'Opted out' : 'Active'}</td>
    <td style={{ ...cell, whiteSpace: 'nowrap' }}>
      <button style={btn} type="button" onClick={onEdit}>
        Edit
      </button>{' '}
      <form action={toggleOptOutAction} style={{ display: 'inline' }}>
        <input type="hidden" name="personId" value={person.id} />
        <input type="hidden" name="optedOut" value={person.optedOut ? 'false' : 'true'} />
        <button style={btn} type="submit">
          {person.optedOut ? 'Opt in' : 'Opt out'}
        </button>
      </form>{' '}
      <form action={deletePersonAction} style={{ display: 'inline' }}>
        <input type="hidden" name="personId" value={person.id} />
        <button style={{ ...btn, color: '#b91c1c' }} type="submit">
          Delete
        </button>
      </form>
    </td>
  </tr>
);

export const RosterTable = ({ people }: { people: Person[] }): React.ReactElement => {
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div>
      <AddPersonForm />
      {people.length === 0 ? (
        <p style={{ color: '#666' }}>
          No one on the roster yet. Add someone above, or bulk-import via{' '}
          <a href="/upload">CSV upload</a>.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', font: 'inherit' }}>
          <thead>
            <tr>
              <th style={th}>Name</th>
              <th style={th}>Email</th>
              <th style={th}>Birthday</th>
              <th style={th}>Start date</th>
              <th style={th}>Team</th>
              <th style={th}>Status</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) =>
              editingId === person.id ? (
                <EditRow key={person.id} person={person} onDone={() => setEditingId(null)} />
              ) : (
                <DisplayRow
                  key={person.id}
                  person={person}
                  onEdit={() => setEditingId(person.id)}
                />
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
};
