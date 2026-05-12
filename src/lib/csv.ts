import Papa from 'papaparse';
import { z } from 'zod';
import { err, ok, type Result } from './result';

// Roster CSV parser. All-or-nothing: hard structural errors (missing required
// column, papaparse failure) → Result.err. Per-row validation issues and
// duplicate-email collisions → Result.ok with rows: [] and errors populated,
// so the caller can show "fix these N rows" without partial commits.

const REQUIRED_HEADERS = ['name', 'email'] as const;

export type ParsedRow = {
  name: string;
  email: string;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  startDate: Date | null;
  team: string | null;
  role: string | null;
};

export type RowError = { rowNumber: number; errors: string[] };
export type ParseResult = { rows: ParsedRow[]; errors: RowError[] };

const trimOrUndef = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  return t === '' ? undefined : t;
};

const birthdaySchema = z
  .string()
  .trim()
  .superRefine((s, ctx) => {
    if (!/^\d{1,2}[-/]\d{1,2}$/.test(s)) {
      ctx.addIssue({ code: 'custom', message: 'birthday must be MM-DD or MM/DD' });
    }
  })
  .transform((s) => {
    const [m, d] = s.split(/[-/]/).map(Number) as [number, number];
    return { month: m, day: d };
  })
  .superRefine(({ month, day }, ctx) => {
    if (month < 1 || month > 12) {
      ctx.addIssue({ code: 'custom', message: `invalid month: ${month}` });
      return;
    }
    const max = month === 2 ? 29 : [4, 6, 9, 11].includes(month) ? 30 : 31;
    if (day < 1 || day > max) {
      ctx.addIssue({ code: 'custom', message: `invalid day: ${day} for month ${month}` });
    }
  });

const startDateSchema = z
  .string()
  .trim()
  .superRefine((s, ctx) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      ctx.addIssue({ code: 'custom', message: 'start_date must be YYYY-MM-DD' });
    }
  })
  .transform((s) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return { y, m, d };
  })
  .superRefine(({ y, m, d }, ctx) => {
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
      ctx.addIssue({ code: 'custom', message: 'invalid calendar date' });
    }
  })
  .transform(({ y, m, d }) => new Date(Date.UTC(y, m - 1, d)));

const rowSchema = z.object({
  name: z.preprocess(trimOrUndef, z.string({ message: 'name is required' }).min(1)),
  email: z.preprocess(
    trimOrUndef,
    z.string({ message: 'email is required' }).toLowerCase().email('email must be valid'),
  ),
  birthday: z.preprocess(trimOrUndef, birthdaySchema.optional()),
  start_date: z.preprocess(trimOrUndef, startDateSchema.optional()),
  team: z.preprocess(trimOrUndef, z.string().min(1).optional()),
  role: z.preprocess(trimOrUndef, z.string().min(1).optional()),
});

const transformHeader = (h: string): string => h.trim().toLowerCase().replace(/\s+/g, '_');

export const parseRoster = (csvText: string): Result<ParseResult, string> => {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader,
  });

  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    return err(`csv parse error: ${first?.message ?? 'unknown'}`);
  }

  const fields = parsed.meta.fields ?? [];
  const missing = REQUIRED_HEADERS.filter((h) => !fields.includes(h));
  if (missing.length > 0) return err(`missing required column(s): ${missing.join(', ')}`);

  // Unknown columns: Zod's z.object strips them silently — extra CSV columns
  // are ignored, not rejected.

  const validated: Array<{ rowNumber: number; data: ParsedRow }> = [];
  const errors: RowError[] = [];

  for (let i = 0; i < parsed.data.length; i++) {
    const raw = parsed.data[i];
    if (!raw) continue;
    const rowNumber = i + 1;
    const result = rowSchema.safeParse(raw);
    if (!result.success) {
      errors.push({
        rowNumber,
        errors: result.error.issues.map(
          (iss) => `${iss.path.join('.') || '(row)'}: ${iss.message}`,
        ),
      });
      continue;
    }
    const d = result.data;
    validated.push({
      rowNumber,
      data: {
        name: d.name,
        email: d.email,
        birthdayMonth: d.birthday?.month ?? null,
        birthdayDay: d.birthday?.day ?? null,
        startDate: d.start_date ?? null,
        team: d.team ?? null,
        role: d.role ?? null,
      },
    });
  }

  // Duplicate-email check: flag every row that shares an email with another.
  const emailRows = new Map<string, number[]>();
  for (const { rowNumber, data } of validated) {
    const list = emailRows.get(data.email) ?? [];
    list.push(rowNumber);
    emailRows.set(data.email, list);
  }
  for (const [email, rowNumbers] of emailRows) {
    if (rowNumbers.length > 1) {
      for (const rowNumber of rowNumbers) {
        const others = rowNumbers.filter((r) => r !== rowNumber);
        errors.push({
          rowNumber,
          errors: [`duplicate email in file: ${email} (also on row(s) ${others.join(', ')})`],
        });
      }
    }
  }

  if (errors.length > 0) {
    errors.sort((a, b) => a.rowNumber - b.rowNumber);
    return ok({ rows: [], errors });
  }
  return ok({ rows: validated.map((v) => v.data), errors: [] });
};
