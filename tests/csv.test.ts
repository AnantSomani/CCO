import { describe, expect, it } from 'vitest';
import { parseRoster } from '@/lib/csv';

describe('parseRoster', () => {
  it('parses a happy path with all columns', () => {
    const csv = [
      'name,email,birthday,start_date,team,role',
      'Alice Apple,alice@example.com,03-15,2020-06-01,Eng,Engineer',
      'Bob Berry,bob@example.com,12/31,2022-01-15,Sales,AE',
    ].join('\n');
    const result = parseRoster(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.errors).toEqual([]);
    expect(result.value.rows).toHaveLength(2);
    const alice = result.value.rows[0];
    expect(alice).toMatchObject({
      name: 'Alice Apple',
      email: 'alice@example.com',
      birthdayMonth: 3,
      birthdayDay: 15,
      team: 'Eng',
      role: 'Engineer',
    });
    expect(alice?.startDate?.toISOString()).toBe('2020-06-01T00:00:00.000Z');
    const bob = result.value.rows[1];
    expect(bob).toMatchObject({
      name: 'Bob Berry',
      email: 'bob@example.com',
      birthdayMonth: 12,
      birthdayDay: 31,
    });
  });

  it('parses with only required columns', () => {
    const csv = ['name,email', 'Alice,alice@example.com', 'Bob,bob@example.com'].join('\n');
    const result = parseRoster(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.errors).toEqual([]);
    expect(result.value.rows).toHaveLength(2);
    expect(result.value.rows[0]).toEqual({
      name: 'Alice',
      email: 'alice@example.com',
      birthdayMonth: null,
      birthdayDay: null,
      startDate: null,
      team: null,
      role: null,
    });
  });

  it('lowercases emails', () => {
    const csv = ['name,email', 'Alice,Alice@Example.COM'].join('\n');
    const result = parseRoster(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows[0]?.email).toBe('alice@example.com');
  });

  it('rejects when a required column is missing (hard error)', () => {
    const csv = ['name,birthday', 'Alice,03-15'].join('\n');
    const result = parseRoster(csv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/missing required column.*email/);
  });

  it('rejects bad birthday format with row number', () => {
    const csv = ['name,email,birthday', 'Alice,alice@example.com,not-a-date'].join('\n');
    const result = parseRoster(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toEqual([]);
    expect(result.value.errors).toHaveLength(1);
    expect(result.value.errors[0]?.rowNumber).toBe(1);
    expect(result.value.errors[0]?.errors[0]).toMatch(/birthday/);
  });

  it('rejects bad start_date format with row number', () => {
    const csv = ['name,email,start_date', 'Alice,alice@example.com,06/01/2020'].join('\n');
    const result = parseRoster(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toEqual([]);
    expect(result.value.errors[0]?.rowNumber).toBe(1);
    expect(result.value.errors[0]?.errors[0]).toMatch(/start_date|YYYY-MM-DD/);
  });

  it('rejects an impossible calendar date (Feb 30)', () => {
    const csv = ['name,email,start_date', 'Alice,alice@example.com,2024-02-30'].join('\n');
    const result = parseRoster(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toEqual([]);
    expect(result.value.errors[0]?.errors[0]).toMatch(/invalid calendar date/);
  });

  it('rejects duplicate email within the file (flags both rows)', () => {
    const csv = [
      'name,email',
      'Alice,dup@example.com',
      'Bob,bob@example.com',
      'Alice2,DUP@example.com',
    ].join('\n');
    const result = parseRoster(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toEqual([]);
    const dupRows = result.value.errors.filter((e) =>
      e.errors.some((msg) => /duplicate email/.test(msg)),
    );
    expect(dupRows.map((e) => e.rowNumber).sort()).toEqual([1, 3]);
  });

  it('tolerates whitespace and case in headers', () => {
    const csv = [' Name , Email , Start Date ', 'Alice,alice@example.com,2020-06-01'].join('\n');
    const result = parseRoster(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.errors).toEqual([]);
    expect(result.value.rows[0]?.name).toBe('Alice');
    expect(result.value.rows[0]?.startDate?.toISOString()).toBe('2020-06-01T00:00:00.000Z');
  });

  it('treats empty optional cells as null', () => {
    const csv = ['name,email,birthday,start_date', 'Alice,alice@example.com,,'].join('\n');
    const result = parseRoster(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.errors).toEqual([]);
    expect(result.value.rows[0]?.birthdayMonth).toBeNull();
    expect(result.value.rows[0]?.startDate).toBeNull();
  });

  it('reports errors on multiple rows in row order', () => {
    const csv = [
      'name,email,birthday',
      'Alice,alice@example.com,bad',
      'Bob,bob@example.com,03-15',
      'Carol,carol@example.com,99-99',
    ].join('\n');
    const result = parseRoster(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toEqual([]);
    expect(result.value.errors.map((e) => e.rowNumber)).toEqual([1, 3]);
  });
});
