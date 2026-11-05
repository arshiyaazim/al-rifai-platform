import type {Pool, PoolClient, QueryResultRow} from 'pg';
import {createPool} from '../../db/postgres.mjs';

export type Actor = {id: string; username?: string; role: 'ADMIN' | 'USER'; displayName?: string};

export class DomainError extends Error {
  status: number;
  constructor(code: string, status = 400, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.status = status;
  }
}

let instance: Pool | undefined;

export function pool(): Pool {
  if (!instance) {
    instance = createPool({role: 'review', readOnly: false, applicationName: 'al-rifai-standalone'}) as Pool;
  }
  return instance;
}

export async function rows<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool().query<T>(sql, params);
  return result.rows;
}

export async function row<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const result = await pool().query<T>(sql, params);
  return result.rows[0] ?? null;
}

/** Run `fn` in a transaction, rolling back on any throw. */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ── validation helpers ──────────────────────────────────────────────────────
export function text(value: unknown, field: string, {max = 200, min = 1} = {}): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < min || trimmed.length > max) throw new DomainError(`INVALID_${field.toUpperCase()}`);
  return trimmed;
}

export function optionalText(value: unknown, field: string, max = 500): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) throw new DomainError(`INVALID_${field.toUpperCase()}`);
  return value.trim();
}

export function isoDate(value: unknown, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new DomainError(`INVALID_${field.toUpperCase()}`);
  const time = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== raw) {
    throw new DomainError(`INVALID_${field.toUpperCase()}`);
  }
  return raw;
}

export function shift(value: unknown, field = 'shift'): 'D' | 'N' {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (raw !== 'D' && raw !== 'N') throw new DomainError(`INVALID_${field.toUpperCase()}`);
  return raw;
}

/** Local 01XXXXXXXXX → +8801XXXXXXXXX. Never invents digits. */
export function mobile(value: unknown, field = 'mobile'): string {
  const digits = typeof value === 'string' ? value.replace(/[^0-9]/g, '') : '';
  if (/^01[3-9][0-9]{8}$/.test(digits)) return `+88${digits}`;
  if (/^8801[3-9][0-9]{8}$/.test(digits)) return `+${digits}`;
  throw new DomainError(`INVALID_${field.toUpperCase()}`);
}

export function optionalMobile(value: unknown, field = 'mobile'): string | null {
  if (value === undefined || value === null || value === '') return null;
  return mobile(value, field);
}

export function moneyMinor(value: unknown, field = 'amount'): number {
  const raw = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isSafeInteger(raw) || raw <= 0) throw new DomainError(`INVALID_${field.toUpperCase()}`);
  return raw;
}

/** Parse a Taka string ("1,250.50") into integer paisa. */
export function takaToMinor(value: unknown, field = 'amount'): number {
  const raw = typeof value === 'number' ? value.toFixed(2) : String(value ?? '').replace(/,/g, '').trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) throw new DomainError(`INVALID_${field.toUpperCase()}`);
  return Math.round(Number(raw) * 100);
}
