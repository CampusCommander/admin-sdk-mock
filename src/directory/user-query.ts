import {
  emptyFilter,
  likePrefix,
  subtree,
  type SqlFilter,
} from '../store/sql.ts';
import { QueryError } from './device-query.ts';

const CLAUSE =
  /([A-Za-z0-9_-][A-Za-z0-9_.-]*)(=|:)('(?:[^'\\]|\\.)*'|\S*)|('(?:[^'\\]|\\.)*'|\S+)/g;

/** A custom field that a query names: schemaName.fieldName. */
export type CustomLookup = (
  schemaName: string,
  fieldName: string,
) => { indexed: number; multiValued?: boolean } | undefined;

const unquote = (value: string): string =>
  value.length >= 2 && value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1).replace(/\\(.)/g, '$1')
    : value;

/** A `schemaName.fieldName` term matches the stored value of a searchable field. */
function addCustomClause(
  filter: SqlFilter,
  name: string,
  op: '=' | ':',
  value: string,
  lookup: CustomLookup,
): void {
  const parts = name.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '')
    throw new QueryError(`Unsupported query field: ${name}`);
  const [schema, field] = parts;
  const known = lookup(schema, field);
  if (!known) throw new QueryError(`Unsupported query field: ${name}`);
  if (known.indexed !== 1)
    throw new QueryError(`The field ${name} is not searchable.`);
  const where = ['schema_name = ?', 'field_name = ?'];
  const multi = known.multiValued === true;
  const target = multi ? 'entry.value' : 'search_text';
  const predicate =
    op === '='
      ? `lower(${target}) = lower(?)`
      : value.endsWith('*')
        ? `cc_word_prefix(${target}, ?)`
        : `cc_contains_words(${target}, ?)`;
  const params: (string | number)[] = [
    schema,
    field,
    op === ':' && value.endsWith('*') ? value.slice(0, -1) : value,
  ];
  // A list holds its entries as a JSON array. Each entry is its own value.
  where.push(
    multi
      ? `json_valid(search_text) AND EXISTS (SELECT 1 FROM json_each(search_text) AS entry WHERE ${predicate})`
      : predicate,
  );
  filter.where.push(
    `id IN (SELECT user_id FROM user_custom_values WHERE ${where.join(' AND ')})`,
  );
  filter.params.push(...params);
}

function addClause(
  filter: SqlFilter,
  field: string,
  op: '=' | ':',
  value: string,
  aliases: string,
  custom?: CustomLookup,
): void {
  if (custom && field.includes('.')) {
    addCustomClause(filter, field, op, value, custom);
    return;
  }
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
          `(primary_email = lower(?) OR id IN (SELECT user_id FROM ${aliases} WHERE alias = lower(?)))`,
        );
        filter.params.push(value, value);
        return;
      }
      if (value.endsWith('*')) {
        const prefix = likePrefix(value.slice(0, -1).toLowerCase());
        filter.where.push(
          `(primary_email LIKE ? ESCAPE '\\' OR id IN (SELECT user_id FROM ${aliases} WHERE alias LIKE ? ESCAPE '\\'))`,
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
export function parseUserQuery(
  query: string,
  aliases = 'user_aliases',
  custom?: CustomLookup,
): SqlFilter {
  const filter = emptyFilter();
  for (const match of query.matchAll(CLAUSE)) {
    if (match[1] !== undefined)
      addClause(
        filter,
        match[1],
        match[2] as '=' | ':',
        unquote(match[3]),
        aliases,
        custom,
      );
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
