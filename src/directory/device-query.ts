import {
  emptyFilter,
  likeContains,
  likePrefix,
  type SqlFilter,
} from '../store/sql.ts';

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

const DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/;
const DAY_MS = 86_400_000;
const LIKE = "LIKE ? ESCAPE '\\'";

function instant(text: string): { start: number; end: number } {
  const match = DATE.exec(text);
  if (!match) throw new QueryError(`Invalid date: ${text}`);
  const [, year, month, day, hour, minute, second] = match;
  if (hour !== undefined) {
    const time = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
    return { start: time, end: time + 1000 };
  }
  const start = Date.UTC(+year, +month - 1, +day);
  return { start, end: start + DAY_MS };
}

/** `D`, `..D`, `D..`, and `D1..D2`. The end of a range includes its whole day. */
export function dateRange(value: string): { from?: number; to?: number } {
  const index = value.indexOf('..');
  if (index === -1) {
    const { start, end } = instant(value);
    return { from: start, to: end };
  }
  const left = value.slice(0, index);
  const right = value.slice(index + 2);
  if (!left && !right) throw new QueryError(`Invalid date range: ${value}`);
  return {
    ...(left ? { from: instant(left).start } : {}),
    ...(right ? { to: instant(right).end } : {}),
  };
}

function range(column: string, value: string, filter: SqlFilter): void {
  const { from, to } = dateRange(value);
  if (from !== undefined) {
    filter.where.push(`${column} >= ?`);
    filter.params.push(from);
  }
  if (to !== undefined) {
    filter.where.push(`${column} < ?`);
    filter.params.push(to);
  }
}

const STATUS: Record<string, string> = {
  provisioned: "status = 'ACTIVE'",
  disabled: "status = 'DISABLED'",
  deprovisioned: "status = 'DEPROVISIONED'",
  managed: "status != 'DEPROVISIONED'",
};

const FREE_TEXT_COLUMNS = [
  'serial_number',
  'annotated_asset_id',
  'annotated_user',
  'annotated_location',
  'notes',
  'model',
];

function addTerm(filter: SqlFilter, key: string | null, value: string): void {
  const contains = (column: string) => {
    filter.where.push(`${column} ${LIKE}`);
    filter.params.push(likeContains(value));
  };
  switch (key) {
    case null:
      filter.where.push(
        `(${FREE_TEXT_COLUMNS.map((column) => `${column} ${LIKE}`).join(' OR ')})`,
      );
      filter.params.push(...FREE_TEXT_COLUMNS.map(() => likeContains(value)));
      return;
    case 'id':
      if (value.length < 3)
        throw new QueryError(
          'A serial number search needs at least three characters.',
        );
      return contains('serial_number');
    case 'asset_id':
      return contains('annotated_asset_id');
    case 'user':
      return contains('annotated_user');
    case 'location':
      return contains('annotated_location');
    case 'note':
      return contains('notes');
    case 'public_model_name':
      return contains('model');
    case 'recent_user':
      filter.where.push(
        'EXISTS (SELECT 1 FROM json_each(recent_users) WHERE json_each.value = ?)',
      );
      filter.params.push(value.toLowerCase());
      return;
    case 'status': {
      const clause = STATUS[value.toLowerCase()];
      if (!clause) throw new QueryError(`Invalid status: ${value}`);
      filter.where.push(clause);
      return;
    }
    case 'wifi_mac':
      filter.where.push('mac_address = ?');
      filter.params.push(value.toLowerCase());
      return;
    case 'ethernet_mac':
      filter.where.push('ethernet_mac_address = ?');
      filter.params.push(value.toLowerCase());
      return;
    case 'boot_mode': {
      const mode = value.toLowerCase();
      if (mode !== 'verified' && mode !== 'dev')
        throw new QueryError(`Invalid boot mode: ${value}`);
      filter.where.push('boot_mode = ?');
      filter.params.push(mode === 'dev' ? 'Dev' : 'Verified');
      return;
    }
    case 'register':
      return range('last_enrollment_time', value, filter);
    case 'sync':
      return range('last_sync', value, filter);
    case 'last_user_activity':
      return range('last_user_activity', value, filter);
    case 'aue':
      return range('aue', value, filter);
    case 'chrome_version':
      if (value.endsWith(';prefix')) {
        filter.where.push(`os_version ${LIKE}`);
        filter.params.push(likePrefix(value.slice(0, -';prefix'.length)));
        return;
      }
      return contains('os_version');
    default:
      throw new QueryError(`Unsupported query operator: ${key}`);
  }
}

const TOKEN = /([A-Za-z_]+):"([^"]*)"|"([^"]*)"|(\S+)/g;

/** Translate the documented Chrome device search operators into SQL. Terms combine with AND. */
export function parseDeviceQuery(query: string): SqlFilter {
  const filter = emptyFilter();
  for (const match of query.matchAll(TOKEN)) {
    if (match[1] !== undefined)
      addTerm(filter, match[1].toLowerCase(), match[2]);
    else if (match[3] !== undefined) addTerm(filter, null, match[3]);
    else {
      const token = match[4];
      const colon = token.indexOf(':');
      if (colon > 0)
        addTerm(
          filter,
          token.slice(0, colon).toLowerCase(),
          token.slice(colon + 1),
        );
      else addTerm(filter, null, token);
    }
  }
  return filter;
}
