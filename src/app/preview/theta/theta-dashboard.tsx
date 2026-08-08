'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  addThetaPerson,
  deleteThetaPerson,
  importThetaCsv,
  type ThetaResult,
  toggleThetaOptOut,
  updateThetaPerson,
} from './actions';

// DB-backed Theta dashboard, themed to mirror thetasoftware.com: warm cream
// canvas, warm-black ink, Instrument Serif display type, Inter body, and pill
// buttons. The roster renders from server props (source of truth = Supabase);
// every mutation goes through a server action.

export type PersonView = {
  id: string;
  name: string;
  email: string;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  startDate: string | null;
  team: string | null;
  optedOut: boolean;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

const fmtBirthday = (m: number | null, d: number | null): string =>
  m && d ? `${MONTHS[m - 1]} ${d}` : '—';
const fmtStart = (s: string | null): string => {
  if (!s) return '—';
  const [y, m, d] = s.split('-').map(Number);
  return y && m && d ? `${MONTHS[m - 1]} ${d}, ${y}` : s;
};
const yearsAt = (s: string | null): string => {
  if (!s) return '';
  const y = Number(s.split('-')[0]);
  const n = new Date().getFullYear() - y;
  return n > 0 ? `${n} yr${n === 1 ? '' : 's'}` : '';
};
const birthdayValue = (m: number | null, d: number | null): string =>
  m && d ? `${pad2(m)}-${pad2(d)}` : '';

// ── Theta brand tokens (sampled from thetasoftware.com) ──────────────────────
const CREAM = '#faf9f5';
const INK = '#26241e';
const MUTED = '#78736a';
const BORDER = '#e7e3d9';
const FILL = '#f2efe8';

const card: React.CSSProperties = {
  border: `1px solid ${BORDER}`,
  borderRadius: 16,
  background: '#fff',
};
const input: React.CSSProperties = {
  padding: '0.5rem 0.7rem',
  border: `1px solid ${BORDER}`,
  borderRadius: 10,
  font: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
  background: '#fff',
  color: INK,
};
const btn: React.CSSProperties = {
  padding: '0.45rem 0.95rem',
  border: `1px solid ${BORDER}`,
  borderRadius: 9999,
  background: '#fff',
  color: INK,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '0.85rem',
};
const primary: React.CSSProperties = {
  ...btn,
  background: INK,
  color: CREAM,
  borderColor: INK,
  fontWeight: 500,
};
const cell: React.CSSProperties = {
  padding: '0.8rem 0.9rem',
  borderBottom: `1px solid ${FILL}`,
  textAlign: 'left',
  verticalAlign: 'middle',
};
const th: React.CSSProperties = {
  ...cell,
  fontSize: '0.72rem',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: MUTED,
  fontWeight: 500,
  borderBottom: `1px solid ${BORDER}`,
};
const chip: React.CSSProperties = {
  fontSize: '0.72rem',
  padding: '0.12rem 0.55rem',
  borderRadius: 9999,
  background: FILL,
  color: MUTED,
  whiteSpace: 'nowrap',
};
const labelStyle: React.CSSProperties = { fontSize: '0.78rem', color: MUTED };

const Message = ({ state }: { state: ThetaResult }): React.ReactElement | null => {
  if (state.kind === 'success') {
    return <span style={{ color: '#4a6b3f', marginLeft: '0.75rem' }}>{state.message}</span>;
  }
  if (state.kind === 'duplicate_email') {
    return (
      <span style={{ color: '#a13d2d', marginLeft: '0.75rem' }}>
        That email is already on the roster.
      </span>
    );
  }
  if (state.kind === 'not_found') {
    return (
      <span style={{ color: '#a13d2d', marginLeft: '0.75rem' }}>
        That person no longer exists — refresh.
      </span>
    );
  }
  if (state.kind === 'validation_error') {
    return (
      <ul style={{ color: '#a13d2d', margin: '0.5rem 0 0', paddingLeft: '1.2rem' }}>
        {state.errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    );
  }
  return null;
};

const AddForm = (): React.ReactElement => {
  const [state, action, pending] = useActionState<ThetaResult, FormData>(addThetaPerson, {
    kind: 'idle',
  });
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.kind === 'success') ref.current?.reset();
  }, [state]);

  return (
    <form ref={ref} action={action}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '0.6rem',
          alignItems: 'end',
        }}
      >
        <label style={labelStyle}>
          Name*
          <input style={input} name="name" placeholder="Jordan Lee" />
        </label>
        <label style={labelStyle}>
          Email*
          <input style={input} name="email" type="email" placeholder="jordan@thetasoftware.com" />
        </label>
        <label style={labelStyle}>
          Birthday
          <input style={input} name="birthday" placeholder="MM-DD" />
        </label>
        <label style={labelStyle}>
          Start date
          <input style={input} name="start_date" type="date" />
        </label>
        <label style={labelStyle}>
          Team
          <input style={input} name="team" placeholder="Engineering" />
        </label>
        <button style={primary} type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add person'}
        </button>
      </div>
      <div>
        <Message state={state} />
      </div>
    </form>
  );
};

const CsvForm = (): React.ReactElement => {
  const [state, action, pending] = useActionState<ThetaResult, FormData>(importThetaCsv, {
    kind: 'idle',
  });
  return (
    <form action={action} style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
      <input
        type="file"
        name="file"
        accept=".csv"
        style={{ font: 'inherit', fontSize: '0.8rem', maxWidth: 190, color: MUTED }}
      />
      <button style={btn} type="submit" disabled={pending}>
        {pending ? 'Importing…' : '↑ Import CSV'}
      </button>
      <Message state={state} />
    </form>
  );
};

const EditRow = ({
  person,
  onDone,
}: {
  person: PersonView;
  onDone: () => void;
}): React.ReactElement => {
  const [state, action, pending] = useActionState<ThetaResult, FormData>(updateThetaPerson, {
    kind: 'idle',
  });
  useEffect(() => {
    if (state.kind === 'success') onDone();
  }, [state, onDone]);

  return (
    <tr style={{ background: CREAM }}>
      <td style={cell} colSpan={6}>
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
            <label style={labelStyle}>
              Name
              <input style={input} name="name" defaultValue={person.name} />
            </label>
            <label style={labelStyle}>
              Birthday
              <input
                style={input}
                name="birthday"
                placeholder="MM-DD"
                defaultValue={birthdayValue(person.birthdayMonth, person.birthdayDay)}
              />
            </label>
            <label style={labelStyle}>
              Start date
              <input
                style={input}
                name="start_date"
                type="date"
                defaultValue={person.startDate ?? ''}
              />
            </label>
            <label style={labelStyle}>
              Team
              <input style={input} name="team" defaultValue={person.team ?? ''} />
            </label>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <button style={primary} type="submit" disabled={pending}>
                {pending ? 'Saving…' : 'Save'}
              </button>
              <button style={btn} type="button" onClick={onDone} disabled={pending}>
                Cancel
              </button>
            </div>
          </div>
          <Message state={state} />
        </form>
      </td>
    </tr>
  );
};

const DisplayRow = ({
  person,
  onEdit,
}: {
  person: PersonView;
  onEdit: () => void;
}): React.ReactElement => (
  <tr style={person.optedOut ? { opacity: 0.5 } : undefined}>
    <td style={cell}>
      <div style={{ fontWeight: 600 }}>{person.name}</div>
      <div style={{ fontSize: '0.78rem', color: MUTED }}>{person.email}</div>
    </td>
    <td style={cell}>{fmtBirthday(person.birthdayMonth, person.birthdayDay)}</td>
    <td style={cell}>
      {fmtStart(person.startDate)}
      {yearsAt(person.startDate) && (
        <span style={{ ...chip, marginLeft: 6 }}>{yearsAt(person.startDate)}</span>
      )}
    </td>
    <td style={cell}>{person.team ?? '—'}</td>
    <td style={cell}>
      <span
        style={{
          ...chip,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          color: person.optedOut ? MUTED : INK,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 9999,
            background: person.optedOut ? 'transparent' : '#4a6b3f',
            border: person.optedOut ? `1px solid ${MUTED}` : 'none',
          }}
        />
        {person.optedOut ? 'Opted out' : 'Active'}
      </span>
    </td>
    <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
      <button style={btn} type="button" onClick={onEdit}>
        Edit
      </button>{' '}
      <form action={toggleThetaOptOut} style={{ display: 'inline' }}>
        <input type="hidden" name="personId" value={person.id} />
        <input type="hidden" name="optedOut" value={person.optedOut ? 'false' : 'true'} />
        <button style={btn} type="submit">
          {person.optedOut ? 'Opt in' : 'Opt out'}
        </button>
      </form>{' '}
      <form action={deleteThetaPerson} style={{ display: 'inline' }}>
        <input type="hidden" name="personId" value={person.id} />
        <button style={{ ...btn, color: '#a13d2d' }} type="submit">
          Delete
        </button>
      </form>
    </td>
  </tr>
);

const Stat = ({
  n,
  label,
  serifClass,
}: {
  n: number;
  label: string;
  serifClass: string;
}): React.ReactElement => (
  <div style={{ textAlign: 'right' }}>
    <div className={serifClass} style={{ fontSize: '2rem', lineHeight: 1, color: INK }}>
      {n}
    </div>
    <div style={{ fontSize: '0.72rem', color: MUTED, marginTop: 2 }}>{label}</div>
  </div>
);

export const ThetaDashboard = ({
  people,
  sansClass,
  serifClass,
}: {
  people: PersonView[];
  sansClass: string;
  serifClass: string;
}): React.ReactElement => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const active = people.filter((p) => !p.optedOut).length;
  const withBirthday = people.filter((p) => p.birthdayMonth && !p.optedOut).length;

  return (
    <div
      className={sansClass}
      style={{ colorScheme: 'light', background: CREAM, minHeight: '100vh', color: INK }}
    >
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '2.75rem 1.5rem' }}>
        {/* header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
            paddingBottom: '1.5rem',
            borderBottom: `1px solid ${BORDER}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.55rem' }}>
            <span style={{ fontSize: '1.4rem' }}>🎉</span>
            <span className={serifClass} style={{ fontSize: '1.6rem', color: INK }}>
              Confetti
            </span>
            <span style={{ fontSize: '0.85rem', color: MUTED }}>Theta Software</span>
          </div>
          <div style={{ display: 'flex', gap: '1.75rem' }}>
            <Stat n={people.length} label="People" serifClass={serifClass} />
            <Stat n={active} label="Active" serifClass={serifClass} />
            <Stat n={withBirthday} label="Birthdays set" serifClass={serifClass} />
          </div>
        </div>

        {/* title */}
        <h1
          className={serifClass}
          style={{
            fontSize: '2.6rem',
            fontWeight: 400,
            letterSpacing: '-0.01em',
            margin: '2rem 0 0.5rem',
          }}
        >
          Your team’s moments
        </h1>
        <p style={{ color: MUTED, maxWidth: 640, margin: 0 }}>
          Add birthdays and work anniversaries and Confetti quietly handles the rest. Everything
          here is saved to your workspace.
        </p>

        {/* add + import */}
        <div style={{ ...card, padding: '1.35rem', marginTop: '1.75rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem',
              flexWrap: 'wrap',
              gap: '0.5rem',
            }}
          >
            <strong className={serifClass} style={{ fontSize: '1.3rem', fontWeight: 400 }}>
              Add a teammate
            </strong>
            <CsvForm />
          </div>
          <AddForm />
        </div>

        {/* roster */}
        <div style={{ ...card, marginTop: '1.5rem', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>Birthday</th>
                <th style={th}>Anniversary</th>
                <th style={th}>Team</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {people.length === 0 ? (
                <tr>
                  <td style={{ ...cell, color: MUTED }} colSpan={6}>
                    No one on the roster yet. Add someone above or import a CSV.
                  </td>
                </tr>
              ) : (
                people.map((p) =>
                  editingId === p.id ? (
                    <EditRow key={p.id} person={p} onDone={() => setEditingId(null)} />
                  ) : (
                    <DisplayRow key={p.id} person={p} onEdit={() => setEditingId(p.id)} />
                  ),
                )
              )}
            </tbody>
          </table>
        </div>

        <p style={{ fontSize: '0.75rem', color: MUTED, marginTop: '1.25rem' }}>
          Saved to the sandbox Supabase database. Per-tenant login comes next.
        </p>
      </div>
    </div>
  );
};
