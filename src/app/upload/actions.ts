'use server';

import { cookies } from 'next/headers';
import { db } from '@/db/client';
import { upsertPeople } from '@/db/queries/people';
import { parseRoster, type RowError } from '@/lib/csv';
import { log } from '@/lib/log';
import { UPLOAD_COOKIE_NAME, verifyUploadCookie } from '@/lib/upload-cookie';

export type ActionResult =
  | { kind: 'success'; inserted: number; updated: number }
  | { kind: 'parse_error'; message: string }
  | { kind: 'row_errors'; errors: RowError[] }
  | { kind: 'auth_error' }
  | { kind: 'no_file' };

export const uploadAction = async (
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> => {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(UPLOAD_COOKIE_NAME);
  if (!cookie) return { kind: 'auth_error' };
  const verified = verifyUploadCookie(cookie.value);
  if (!verified.ok) {
    log.warn('upload cookie verification failed', { reason: verified.error });
    return { kind: 'auth_error' };
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { kind: 'no_file' };

  const csvText = await file.text();
  const parseResult = parseRoster(csvText);
  if (!parseResult.ok) return { kind: 'parse_error', message: parseResult.error };
  if (parseResult.value.errors.length > 0) {
    return { kind: 'row_errors', errors: parseResult.value.errors };
  }

  const counts = await upsertPeople(db, verified.value.workspaceId, parseResult.value.rows);
  log.info('roster uploaded', {
    workspaceId: verified.value.workspaceId,
    inserted: counts.inserted,
    updated: counts.updated,
  });
  return { kind: 'success', inserted: counts.inserted, updated: counts.updated };
};
