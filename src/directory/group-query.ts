import { emptyFilter, escapeLike, type SqlFilter } from '../store/sql.ts';
import { QueryError } from './device-query.ts';

const CLAUSE =
  /([A-Za-z]+)(=|:)('(?:[^'\\]|\\.)*'\*?|\S*)|('(?:[^'\\]|\\.)*'|\S+)/g;

// A quoted value may carry a trailing `*` outside the quotes, as in name:'Art C'*.
const unquote = (value: string): string => {
  const quoted = /^'((?:[^'\\]|\\.)*)'(\*?)$/.exec(value);
  return quoted ? `${quoted[1].replace(/\\(.)/g, '$1')}${quoted[2]}` : value;
};

/**
 * Translate the documented group search into SQL over the `groups` columns.
 * `email` and `name` take `=` or `:prefix*`. `memberKey` takes `=` and stands alone.
 */
export function parseGroupQuery(query: string): {
  filter: SqlFilter;
  memberKey: string | null;
} {
  const filter = emptyFilter();
  let memberKey: string | null = null;
  let named = false;
  for (const match of query.matchAll(CLAUSE)) {
    if (match[1] === undefined)
      throw new QueryError(`Unsupported query: ${match[4]}`);
    const field = match[1];
    const value = unquote(match[3]);
    if (field === 'memberKey') {
      if (match[2] !== '=') throw new QueryError('memberKey accepts only =.');
      memberKey = value;
      continue;
    }
    if (field !== 'email' && field !== 'name')
      throw new QueryError(`Unsupported query field: ${field}`);
    named = true;
    if (match[2] === '=') {
      filter.where.push(
        field === 'email' ? 'email = lower(?)' : 'lower(name) = lower(?)',
      );
      filter.params.push(value);
    } else if (value.endsWith('*')) {
      filter.where.push(`lower(${field}) LIKE ? ESCAPE '\\'`);
      filter.params.push(`${escapeLike(value.slice(0, -1).toLowerCase())}%`);
    } else throw new QueryError(`${field} accepts only = or :prefix*.`);
  }
  if (memberKey !== null && named)
    throw new QueryError('memberKey cannot be combined with email or name.');
  return { filter, memberKey };
}
