'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { db } from '@/db/client';
import { deletePerson, insertPerson, setOptedOutById, updatePerson } from '@/db/queries/people';
import { log } from '@/lib/log';
import { parseAddPerson, parseEditPerson } from '@/lib/person-form';
import { err, ok, type Result } from '@/lib/result';
import { UPLOAD_COOKIE_NAME, verifyUploadCookie } from '@/lib/upload-cookie';

// Server actions backing the admin dashboard. Each one re-verifies the
// HMAC-signed workspace cookie (same gate as /upload) before touching the DB,
// so authorization is enforced per-action, not just at page load. All queries
// are workspace-scoped, so a submitted person id can never reach another
// workspace's data.

export type DashboardActionResult =
  | { kind: 'idle' }
  | { kind: 'success'; message: string }
  | { kind: 'auth_error' }
  | { kind: 'validation_error'; errors: string[] }
  | { kind: 'duplicate_email' }
  | { kind: 'not_found' };

const requireWorkspaceId = async (): Promise<Result<string, 'auth_error'>> => {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(UPLOAD_COOKIE_NAME);
  if (!cookie) return err('auth_error');
  const verified = verifyUploadCookie(cookie.value);
  if (!verified.ok) {
    log.warn('dashboard cookie verification failed', { reason: verified.error });
    return err('auth_error');
  }
  return ok(verified.value.workspaceId);
};

const formToRecord = (formData: FormData): Record<string, unknown> => ({
  name: formData.get('name'),
  email: formData.get('email'),
  birthday: formData.get('birthday'),
  start_date: formData.get('start_date'),
  team: formData.get('team'),
  role: formData.get('role'),
});

export const addPersonAction = async (
  _prev: DashboardActionResult | null,
  formData: FormData,
): Promise<DashboardActionResult> => {
  const ws = await requireWorkspaceId();
  if (!ws.ok) return { kind: 'auth_error' };

  const parsed = parseAddPerson(formToRecord(formData));
  if (!parsed.ok) return { kind: 'validation_error', errors: parsed.error };

  const { email, ...fields } = parsed.value;
  const person = await insertPerson(db, ws.value, email, fields);
  if (!person) return { kind: 'duplicate_email' };

  log.info('dashboard: person added', { workspaceId: ws.value, personId: person.id });
  revalidatePath('/dashboard');
  return { kind: 'success', message: `Added ${person.name}.` };
};

export const updatePersonAction = async (
  _prev: DashboardActionResult | null,
  formData: FormData,
): Promise<DashboardActionResult> => {
  const ws = await requireWorkspaceId();
  if (!ws.ok) return { kind: 'auth_error' };

  const personId = formData.get('personId');
  if (typeof personId !== 'string' || !personId) {
    return { kind: 'validation_error', errors: ['(row): missing person id'] };
  }

  const parsed = parseEditPerson(formToRecord(formData));
  if (!parsed.ok) return { kind: 'validation_error', errors: parsed.error };

  const person = await updatePerson(db, ws.value, personId, parsed.value);
  if (!person) return { kind: 'not_found' };

  log.info('dashboard: person updated', { workspaceId: ws.value, personId });
  revalidatePath('/dashboard');
  return { kind: 'success', message: `Saved ${person.name}.` };
};

// Delete + opt-out are single-button forms; they revalidate and return void.
export const deletePersonAction = async (formData: FormData): Promise<void> => {
  const ws = await requireWorkspaceId();
  if (!ws.ok) return;
  const personId = formData.get('personId');
  if (typeof personId !== 'string' || !personId) return;
  const deleted = await deletePerson(db, ws.value, personId);
  if (deleted) {
    log.info('dashboard: person deleted', { workspaceId: ws.value, personId });
    revalidatePath('/dashboard');
  }
};

export const toggleOptOutAction = async (formData: FormData): Promise<void> => {
  const ws = await requireWorkspaceId();
  if (!ws.ok) return;
  const personId = formData.get('personId');
  const optedOut = formData.get('optedOut') === 'true';
  if (typeof personId !== 'string' || !personId) return;
  const changed = await setOptedOutById(db, ws.value, personId, optedOut);
  if (changed) {
    log.info('dashboard: opt-out toggled', { workspaceId: ws.value, personId, optedOut });
    revalidatePath('/dashboard');
  }
};
