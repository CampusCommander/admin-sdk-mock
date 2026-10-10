/**
 * Render the generated sections of docs/reference/ from their sources: the configuration
 * schema, the CLI help text, and the route table. `npm run docs` writes them, and
 * generate.test.ts fails when a page on disk differs from its source.
 */
import { HELP } from '../cli/help.ts';
import { CONFIG_SCHEMA } from '../config/config.ts';
import type { Route } from '../http/types.ts';
import type { Mock } from '../mock.ts';
import { buildRoutes } from '../routes.ts';

type Schema = Record<string, unknown>;

export interface GeneratedSection {
  /** The page, relative to the package root. */
  file: string;
  /** The marker name: `<!-- generated:start <name> -->`. */
  name: string;
  content: string;
}

/** Escape the characters that would end a table cell or row, or open an HTML tag. */
const cell = (text: string): string =>
  text.replaceAll('|', '\\|').replaceAll('<', '\\<').replaceAll('\n', ' ');

/** Follow a `#/$defs/` reference. Keys beside the reference win over the target's keys. */
function resolve(root: Schema, schema: Schema): Schema {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  const target = (root.$defs as Record<string, Schema>)[
    ref.replace('#/$defs/', '')
  ];
  const { $ref: _ref, ...siblings } = schema;
  return { ...target, ...siblings };
}

/** The type column: `string`, `integer 0–65535`, `one of: keep, reset`, `null or object`. */
function typeOf(root: Schema, raw: Schema): string {
  const schema = resolve(root, raw);
  if (Array.isArray(schema.enum)) return `one of: ${schema.enum.join(', ')}`;
  if (Array.isArray(schema.anyOf))
    return (schema.anyOf as Schema[])
      .map((option) => typeOf(root, option))
      .join(' or ');
  const type = String(schema.type ?? 'any');
  if (type === 'array')
    return `array of ${typeOf(root, (schema.items ?? {}) as Schema)}`;
  const { minimum, maximum } = schema;
  return minimum !== undefined && maximum !== undefined
    ? `${type} ${String(minimum)}–${String(maximum)}`
    : type;
}

/** The default column: the schema default, `required`, or `none`. */
function defaultOf(schema: Schema, required: boolean): string {
  if (!('default' in schema)) return required ? 'required' : 'none';
  const value = schema.default;
  return `\`${typeof value === 'string' ? value : JSON.stringify(value)}\``;
}

/** Append one row per property below `prefix`, depth first, in schema order. */
function addRows(
  root: Schema,
  raw: Schema,
  prefix: string,
  out: string[],
): void {
  const schema = resolve(root, raw);
  const forms = Array.isArray(schema.anyOf)
    ? (schema.anyOf as Schema[]).map((option) => resolve(root, option))
    : [schema];
  for (const form of forms) {
    if (form.type === 'array') {
      addRows(root, (form.items ?? {}) as Schema, `${prefix}[]`, out);
      continue;
    }
    const required = (form.required ?? []) as string[];
    const properties = (form.properties ?? {}) as Record<string, Schema>;
    for (const [key, child] of Object.entries(properties)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      const resolved = resolve(root, child);
      out.push(
        `| \`${path}\` | ${cell(typeOf(root, child))} | ${defaultOf(resolved, required.includes(key))} | ${cell(String(resolved.description ?? ''))} |`,
      );
      addRows(root, child, path, out);
    }
  }
}

/** A table of every configuration key path, with its type, default, and description. */
export function renderConfigReference(schema: Schema): string {
  const out = [
    '| Key | Type | Default | Description |',
    '| --- | --- | --- | --- |',
  ];
  addRows(schema, schema, '', out);
  return out.join('\n');
}

/** One section per command, the top-level usage first, each usage in a text block. */
export function renderCliReference(
  help: Readonly<Record<string, string>>,
): string {
  const names = ['', ...Object.keys(help).filter((name) => name !== '')];
  return names
    .map(
      (name) =>
        `## ${name === '' ? 'admin-sdk-mock' : name}\n\n\`\`\`text\n${help[name]}\n\`\`\``,
    )
    .join('\n\n');
}

/** Marks for an optional part while routePath checks for leftover regex syntax. */
const OPEN = '\u0000';
const CLOSE = '\u0001';

/**
 * The path pattern of a route: anchors removed, named groups shown as `{name}`, an
 * alternation shown as its first form, an optional group in brackets, and `\/` and `\.`
 * unescaped. It throws when any other regex syntax would remain in the path.
 */
export function routePath(pattern: RegExp): string {
  const path = pattern.source
    .replace(/^\^|\$$/g, '')
    .replace(/\(\?<(\w+)>[^()]*\)/g, '{$1}')
    .replace(
      /\(\?:([^()|]*)(?:\|[^()]*)?\)(\?)?/g,
      (_group, first: string, optional: string | undefined) =>
        optional ? `${OPEN}${first}${CLOSE}` : first,
    );
  if (/[()[\]\\?*+|]/.test(path.replace(/\\[/.]/g, '')))
    throw new Error(
      `The docs cannot render the route pattern ${pattern.source}.`,
    );
  return path
    .replace(/\\([/.])/g, '$1')
    .replaceAll(OPEN, '[')
    .replaceAll(CLOSE, ']');
}

/** The scopes column: each scope without the Google auth prefix, or `none`. */
const scopesOf = (scopes: readonly string[]): string =>
  scopes.length === 0
    ? 'none'
    : scopes
        .map(
          (scope) =>
            `\`${scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '')}\``,
        )
        .join(', ');

/**
 * A table of every route: its ID, HTTP methods, hosts, path, accepted scopes, and whether
 * the delegated subject must be a super administrator, sorted by route ID.
 */
export function renderApiCoverage(
  routes: readonly Pick<
    Route,
    'id' | 'methods' | 'hosts' | 'pattern' | 'scopes' | 'admin'
  >[],
): string {
  const rows = [...routes]
    .sort((a, b) => a.id.localeCompare(b.id, 'en'))
    .map(
      (route) =>
        `| \`${route.id}\` | ${route.methods.join(', ')} | ${route.hosts.map((host) => `\`${host}\``).join(', ')} | \`${routePath(route.pattern)}\` | ${scopesOf(route.scopes)} | ${route.admin ? 'yes' : 'no'} |`,
    );
  return [
    '| Route | Methods | Hosts | Path | Scopes | Super admin |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** Replace the text between `<!-- generated:start <name> -->` and its end marker. */
export function replaceGenerated(
  markdown: string,
  name: string,
  content: string,
): string {
  const start = `<!-- generated:start ${name} -->`;
  const end = `<!-- generated:end ${name} -->`;
  const from = markdown.indexOf(start);
  const to = from === -1 ? -1 : markdown.indexOf(end, from);
  if (to === -1)
    throw new Error(
      `The page has no generated:start ${name} and generated:end ${name} markers.`,
    );
  return `${markdown.slice(0, from + start.length)}\n\n${content.trim()}\n\n${markdown.slice(to)}`;
}

/** The three generated sections and the pages that hold them. */
export function generatedSections(): GeneratedSection[] {
  // buildRoutes reads the mock only inside route handlers, and rendering calls none.
  const routes = buildRoutes(undefined as unknown as Mock);
  return [
    {
      file: 'docs/reference/configuration.md',
      name: 'configuration',
      content: renderConfigReference(CONFIG_SCHEMA),
    },
    {
      file: 'docs/reference/cli.md',
      name: 'cli',
      content: renderCliReference(HELP),
    },
    {
      file: 'docs/reference/api-coverage.md',
      name: 'api-coverage',
      content: renderApiCoverage(routes),
    },
  ];
}
