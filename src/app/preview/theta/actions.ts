'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
  deletePerson,
  insertPerson,
  setOptedOutById,
  updatePerson,
  upsertPeople,
} from '@/db/queries/people';
import { parseRoster } from '@/lib/csv';
import { parseAddPerson, parseEditPerson } from '@/lib/person-form';
import { getThetaWorkspaceId } from './theta-workspace';

// Server actions for the Theta preview dashboard. These persist to the real
// `people` table (scoped to the Theta workspace) via the same queries the
// Slack-gated dashboard uses. NOTE: no auth yet — this route is dev-only
// (404 in production). The real tenant dashboard gates via Supabase Auth.

export type ThetaResult =
  | { kind: 'idle' }
  | { kind: 'success'; message: string }
  | { kind: 'validation_error'; errors: string[] }
  | { kind: 'duplicate_email' }
  | { kind: 'not_found' };

const PATH = '/preview/theta';

const formRecord = (formData: FormData): Record<string, unknown> => ({
  name: formData.get('name'),
  email: formData.get('email'),
  birthday: formData.get('birthday'),
  start_date: formData.get('start_date'),
  team: formData.get('team'),
  role: formData.get('role'),
});

export const addThetaPerson = async (
  _prev: ThetaResult | null,
  formData: FormData,
): Promise<ThetaResult> => {
  const workspaceId = await getThetaWorkspaceId();
  const parsed = parseAddPerson(formRecord(formData));
  if (!parsed.ok) return { kind: 'validation_error', errors: parsed.error };
  const { email, ...fields } = parsed.value;
  const person = await insertPerson(db, workspaceId, email, fields);
  if (!person) return { kind: 'duplicate_email' };
  revalidatePath(PATH);
  return { kind: 'success', message: `Added ${person.name}.` };
};

export const updateThetaPerson = async (
  _prev: ThetaResult | null,
  formData: FormData,
): Promise<ThetaResult> => {
  const workspaceId = await getThetaWorkspaceId();
  const personId = formData.get('personId');
  if (typeof personId !== 'string' || !personId) {
    return { kind: 'validation_error', errors: ['(row): missing person id'] };
  }
  const parsed = parseEditPerson(formRecord(formData));
  if (!parsed.ok) return { kind: 'validation_error', errors: parsed.error };
  const person = await updatePerson(db, workspaceId, personId, parsed.value);
  if (!person) return { kind: 'not_found' };
  revalidatePath(PATH);
  return { kind: 'success', message: `Saved ${person.name}.` };
};

export const importThetaCsv = async (
  _prev: ThetaResult | null,
  formData: FormData,
): Promise<ThetaResult> => {
  const workspaceId = await getThetaWorkspaceId();
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { kind: 'validation_error', errors: ['Choose a CSV file first.'] };
  }
  const parsed = parseRoster(await file.text());
  if (!parsed.ok) return { kind: 'validation_error', errors: [parsed.error] };
  if (parsed.value.errors.length > 0) {
    return {
      kind: 'validation_error',
      errors: parsed.value.errors
        .slice(0, 5)
        .map((e) => `row ${e.rowNumber}: ${e.errors.join('; ')}`),
    };
  }
  const counts = await upsertPeople(db, workspaceId, parsed.value.rows);
  revalidatePath(PATH);
  return {
    kind: 'success',
    message: `Imported CSV — ${counts.inserted} added, ${counts.updated} updated.`,
  };
};

// Single-button forms → revalidate and return void.
export const deleteThetaPerson = async (formData: FormData): Promise<void> => {
  const workspaceId = await getThetaWorkspaceId();
  const personId = formData.get('personId');
  if (typeof personId !== 'string' || !personId) return;
  await deletePerson(db, workspaceId, personId);
  revalidatePath(PATH);
};

export const toggleThetaOptOut = async (formData: FormData): Promise<void> => {
  const workspaceId = await getThetaWorkspaceId();
  const personId = formData.get('personId');
  const optedOut = formData.get('optedOut') === 'true';
  if (typeof personId !== 'string' || !personId) return;
  await setOptedOutById(db, workspaceId, personId, optedOut);
  revalidatePath(PATH);
};
