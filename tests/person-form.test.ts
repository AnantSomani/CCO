import { describe, expect, it } from 'vitest';
import { parseAddPerson, parseEditPerson } from '@/lib/person-form';

describe('parseAddPerson', () => {
  it('parses a full valid person', () => {
    const r = parseAddPerson({
      name: '  Jordan Lee ',
      email: 'Jordan@Acme.com',
      birthday: '03-15',
      start_date: '2021-06-01',
      team: 'Eng',
      role: 'Engineer',
    });
    expect(r).toEqual({
      ok: true,
      value: {
        name: 'Jordan Lee',
        email: 'jordan@acme.com',
        birthdayMonth: 3,
        birthdayDay: 15,
        startDate: '2021-06-01',
        team: 'Eng',
        role: 'Engineer',
      },
    });
  });

  it('treats blank optional fields as null', () => {
    const r = parseAddPerson({
      name: 'Sam',
      email: 'sam@acme.com',
      birthday: '',
      start_date: '',
      team: '   ',
      role: '',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.birthdayMonth).toBeNull();
      expect(r.value.startDate).toBeNull();
      expect(r.value.team).toBeNull();
    }
  });

  it('requires name and a valid email', () => {
    const r = parseAddPerson({ name: '', email: 'not-an-email' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.some((e) => e.includes('name'))).toBe(true);
      expect(r.error.some((e) => e.includes('email'))).toBe(true);
    }
  });

  it('rejects a malformed birthday', () => {
    const r = parseAddPerson({ name: 'Sam', email: 'sam@acme.com', birthday: '13-40' });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error.some((e) => e.includes('birthday') || e.includes('month'))).toBe(true);
  });

  it('accepts MM/DD as well as MM-DD (CSV parity)', () => {
    const r = parseAddPerson({ name: 'Sam', email: 'sam@acme.com', birthday: '3/9' });
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.value.birthdayMonth, r.value.birthdayDay]).toEqual([3, 9]);
  });
});

describe('parseEditPerson', () => {
  it('parses mutable fields without requiring an email', () => {
    const r = parseEditPerson({ name: 'Sam', birthday: '12-31', start_date: '2020-01-02' });
    expect(r).toEqual({
      ok: true,
      value: {
        name: 'Sam',
        birthdayMonth: 12,
        birthdayDay: 31,
        startDate: '2020-01-02',
        team: null,
        role: null,
      },
    });
  });

  it('rejects an invalid calendar start date', () => {
    const r = parseEditPerson({ name: 'Sam', start_date: '2021-02-30' });
    expect(r.ok).toBe(false);
  });
});
