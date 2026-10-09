export interface SqlFilter {
  where: string[];
  params: (string | number)[];
}

export const emptyFilter = (): SqlFilter => ({ where: [], params: [] });

export const whereClause = (filter: SqlFilter): string =>
  filter.where.length > 0 ? `WHERE ${filter.where.join(' AND ')}` : '';

/** Escape LIKE wildcards. Use with `ESCAPE '\'`. */
export const escapeLike = (value: string): string =>
  value.replace(/[\\%_]/g, (character) => `\\${character}`);

export const likeContains = (value: string): string => `%${escapeLike(value)}%`;
export const likePrefix = (value: string): string => `${escapeLike(value)}%`;

/** Match `path` and every OU below it. The root matches everything. */
export function subtree(column: string, path: string, filter: SqlFilter): void {
  if (path === '/') return;
  filter.where.push(`(${column} = ? OR substr(${column}, 1, ?) = ?)`);
  filter.params.push(path, path.length + 1, `${path}/`);
}
