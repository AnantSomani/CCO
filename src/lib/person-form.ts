import { z } from 'zod';
import { birthdaySchema, startDateSchema } from '@/lib/csv';
import { err, ok, type Result } from '@/lib/result';

// Validation for the dashboard's add/edit-person forms. Deliberately mirrors
// the CSV row schema (src/lib/csv.ts) field-for-field so a person typed into
// the dashboard is validated identically to one imported via CSV. Reuses the
// shared birthday/start-date schemas rather than re-deriving the edge cases.

const trimOrUndef = (v: unknown): unknown => {
  // A FormData field that isn't present comes back as null; treat any
  // non-string (null, File, …) as "absent" so optional fields validate.
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
};

const commonFields = {
  name: z.preprocess(trimOrUndef, z.string({ message: 'name is required' }).min(1)),
  birthday: z.preprocess(trimOrUndef, birthdaySchema.optional()),
  start_date: z.preprocess(trimOrUndef, startDateSchema.optional()),
  team: z.preprocess(trimOrUndef, z.string().min(1).optional()),
  role: z.preprocess(trimOrUndef, z.string().min(1).optional()),
};

const emailField = z.preprocess(
  trimOrUndef,
  z.string({ message: 'email is required' }).toLowerCase().email('email must be valid'),
);

const addSchema = z.object({ email: emailField, ...commonFields });
// Email is a person's identity (the natural key). Editing it in place would
// risk a unique collision, so the dashboard treats email as read-only on edit
// and this schema omits it.
const editSchema = z.object(commonFields);

// The shape the query layer consumes for the mutable fields.
export type PersonFields = {
  name: string;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  startDate: string | null; // YYYY-MM-DD, or null
  team: string | null;
  role: string | null;
};

export type AddPersonValues = PersonFields & { email: string };

const toFields = (d: z.infer<typeof editSchema>): PersonFields => ({
  name: d.name,
  birthdayMonth: d.birthday?.month ?? null,
  birthdayDay: d.birthday?.day ?? null,
  startDate: d.start_date ? d.start_date.toISOString().slice(0, 10) : null,
  team: d.team ?? null,
  role: d.role ?? null,
});

const formatIssues = (error: z.ZodError): string[] =>
  error.issues.map((iss) => `${iss.path.join('.') || '(field)'}: ${iss.message}`);

export const parseAddPerson = (
  input: Record<string, unknown>,
): Result<AddPersonValues, string[]> => {
  const r = addSchema.safeParse(input);
  if (!r.success) return err(formatIssues(r.error));
  const { email, ...rest } = r.data;
  return ok({ email, ...toFields(rest) });
};

export const parseEditPerson = (input: Record<string, unknown>): Result<PersonFields, string[]> => {
  const r = editSchema.safeParse(input);
  if (!r.success) return err(formatIssues(r.error));
  return ok(toFields(r.data));
};
