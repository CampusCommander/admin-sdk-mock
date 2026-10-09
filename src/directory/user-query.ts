import {
  emptyFilter,
  likePrefix,
  subtree,
  type SqlFilter,
} from '../store/sql.ts';
import { QueryError } from './device-query.ts';

const CLAUSE =
  /([A-Za-z]+)(=|:)('(?:[^'\\]|\\.)*'|\S*)|('(?:[^'\\]|\\.)*'|\S+)/g;

const unquote = (value: string): string =>
  value.length >= 2 && value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1).replace(/\\(.)/g, '$1')
    : value;

function addClause(
  filter: SqlFilter,
  field: string,
  op: '=' | ':',
  value: string,
): void {
  const text = (column: string) => {
    if (op === '=') {
      filter.where.push(`lower(${column}) = lower(?)`);
      filter.params.push(value);
    } else if (value.endsWith('*')) {
      filter.where.push(`cc_word_prefix(${column}, ?)`);
      filter.params.push(value.slice(0, -1));
    } else {
      filter.where.push(`cc_contains_words(${column}, ?)`);
      filter.params.push(value);
    }
  };
  const flag = (column: string) => {
    const lower = value.toLowerCase();
    if (op !== '=' || (lower !== 'true' && lower !== 'false'))
      throw new QueryError(`${field} accepts only =true or =false.`);
    filter.where.push(`${column} = ?`);
    filter.params.push(lower === 'true' ? 1 : 0);
  };
  switch (field) {
    case 'name':
      return text('full_name');
    case 'givenName':
      return text('given_name');
    case 'familyName':
      return text('family_name');
    case 'email':
      if (op === '=') {
        filter.where.push(
          '(primary_email = lower(?) OR id IN (SELECT user_id FROM user_aliases WHERE alias = lower(?)))',
        );
        filter.params.push(value, value);
        return;
      }
      if (value.endsWith('*')) {
        const prefix = likePrefix(value.slice(0, -1).toLowerCase());
        filter.where.push(
          "(primary_email LIKE ? ESCAPE '\\' OR id IN (SELECT user_id FROM user_aliases WHERE alias LIKE ? ESCAPE '\\'))",
        );
        filter.params.push(prefix, prefix);
        return;
      }
      return text('primary_email');
    case 'isAdmin':
      return flag('is_admin');
    case 'isSuspended':
      return flag('suspended');
    case 'externalId':
      if (op === '=') {
        filter.where.push('external_id = ?');
        filter.params.push(value);
        return;
      }
      return text('external_id');
    case 'orgUnitPath': {
      if (op !== '=') throw new QueryError('orgUnitPath accepts only =.');
      const path =
        value === '' ? '/' : value.startsWith('/') ? value : `/${value}`;
      subtree('org_unit_path', path, filter);
      return;
    }
    default:
      throw new QueryError(`Unsupported query field: ${field}`);
  }
}

/** Translate the documented user search syntax into SQL. Clauses combine with AND. */
export function parseUserQuery(query: string): SqlFilter {
  const filter = emptyFilter();
  for (const match of query.matchAll(CLAUSE)) {
    if (match[1] !== undefined)
      addClause(filter, match[1], match[2] as '=' | ':', unquote(match[3]));
    else {
      const value = unquote(match[4]);
      filter.where.push(
        '(cc_contains_words(given_name, ?) OR cc_contains_words(family_name, ?) OR cc_contains_words(primary_email, ?))',
      );
      filter.params.push(value, value, value);
    }
  }
  return filter;
}
