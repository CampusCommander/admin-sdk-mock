import { emptyFilter, type SqlFilter } from '../store/sql.ts';

export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterError';
  }
}

export interface TelemetryFilter {
  sql: SqlFilter;
  /** The earliest report time to return, or null for recent reports only. */
  reportsFrom: number | null;
}

const CLAUSE = /^([A-Za-z_]+)(>=|<=|>|<|=)(.+)$/;

function timestamp(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(parsed))
    throw new FilterError(`Invalid reports_timestamp: ${value}`);
  return parsed;
}

/** Parse `field=value` clauses joined by spaces or AND. */
export function parseTelemetryFilter(text: string): TelemetryFilter {
  const result: TelemetryFilter = { sql: emptyFilter(), reportsFrom: null };
  for (const clause of text.split(/\s+(?:AND\s+)?/).filter(Boolean)) {
    const match = CLAUSE.exec(clause);
    if (!match) throw new FilterError(`Invalid filter clause: ${clause}`);
    const [, field, op, raw] = match;
    const value = raw.replace(/^"(.*)"$/, '$1');
    if (field === 'reports_timestamp') {
      if (op !== '>=' && op !== '>')
        throw new FilterError('reports_timestamp supports only >= and >.');
      const time = timestamp(value);
      result.reportsFrom = op === '>' ? time + 1 : time;
      continue;
    }
    if (op !== '=') throw new FilterError(`${field} supports only =.`);
    const column = {
      orgUnitId: 'org_unit_id',
      serialNumber: 'serial_number',
      deviceId: 'device_id',
    }[field];
    if (!column) throw new FilterError(`Unsupported filter field: ${field}`);
    result.sql.where.push(`${column} = ?`);
    result.sql.params.push(
      field === 'orgUnitId' && !value.startsWith('id:') ? `id:${value}` : value,
    );
  }
  return result;
}
