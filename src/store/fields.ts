import { SCHEMA_NAMES } from './schema-names.ts';

/** `true` selects the whole field. A map selects named subfields. */
export type FieldTree = Map<string, FieldTree | true>;

export class FieldsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldsError';
  }
}

const NAME = /[A-Za-z0-9_*]/;

function merge(target: FieldTree, source: FieldTree): void {
  for (const [key, value] of source) {
    const existing = target.get(key);
    if (existing === true) continue;
    if (value === true) target.set(key, true);
    else if (existing) merge(existing, value);
    else target.set(key, value);
  }
}

function insert(
  tree: FieldTree,
  segments: readonly string[],
  sub: FieldTree | undefined,
): void {
  let node = tree;
  for (let index = 0; index < segments.length; index++) {
    const key = segments[index];
    const last = index === segments.length - 1;
    const existing = node.get(key);
    if (existing === true) return;
    if (last && !sub) {
      node.set(key, true);
      return;
    }
    let child = existing;
    if (!child) {
      child = new Map();
      node.set(key, child);
    }
    if (last && sub) {
      merge(child, sub);
      return;
    }
    node = child;
  }
}

/** Parse Google's partial response syntax: `a,b/c,d(e,f)`. */
export function parseFields(text: string): FieldTree {
  const source = text.replace(/\s+/g, '');
  let index = 0;
  const fail = (): never => {
    throw new FieldsError(`Invalid field selection ${text}`);
  };
  const name = (): string => {
    const start = index;
    while (index < source.length && NAME.test(source[index])) index++;
    if (index === start) fail();
    return source.slice(start, index);
  };
  const list = (tree: FieldTree): void => {
    for (;;) {
      const segments = [name()];
      while (source[index] === '/') {
        index++;
        segments.push(name());
      }
      let sub: FieldTree | undefined;
      if (source[index] === '(') {
        index++;
        sub = new Map();
        list(sub);
        if (source[index] !== ')') fail();
        index++;
      }
      insert(tree, segments, sub);
      if (source[index] !== ',') return;
      index++;
    }
  };
  const tree: FieldTree = new Map();
  if (source === '') fail();
  list(tree);
  if (index !== source.length) fail();
  return tree;
}

/** Keep only the selected fields. Arrays apply the selection to each element. */
export function applyFields(value: unknown, tree: FieldTree): unknown {
  if (Array.isArray(value)) return value.map((item) => applyFields(item, tree));
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const wildcard = tree.get('*');
  if (wildcard)
    for (const [key, item] of Object.entries(source))
      out[key] = wildcard === true ? item : applyFields(item, wildcard);
  for (const [key, sub] of tree) {
    if (key === '*' || !Object.hasOwn(source, key)) continue;
    out[key] = sub === true ? source[key] : applyFields(source[key], sub);
  }
  return out;
}

/**
 * The first selected name that no Google schema declares. Google rejects such a
 * selection with `400` whether or not the response carries the field.
 */
export function unknownField(tree: FieldTree): string | null {
  for (const [key, sub] of tree) {
    if (key !== '*' && !SCHEMA_NAMES.has(key)) return key;
    if (sub !== true) {
      const found = unknownField(sub);
      if (found !== null) return found;
    }
  }
  return null;
}
