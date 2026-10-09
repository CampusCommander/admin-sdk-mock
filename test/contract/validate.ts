export interface Schema {
  type?: string;
  $ref?: string;
  format?: string;
  enum?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: Schema;
  items?: Schema;
}

interface Resource {
  resources?: Record<string, Resource>;
  methods?: Record<string, { response?: Schema }>;
}

export interface Discovery extends Resource {
  schemas: Record<string, Schema>;
}

/** Validate a response against a discovery schema. Undeclared properties are errors. */
export function validate(
  doc: Discovery,
  schema: Schema,
  value: unknown,
  path = '$',
): string[] {
  if (schema.$ref) {
    const target = doc.schemas[schema.$ref];
    return target
      ? validate(doc, target, value, path)
      : [`${path}: unknown schema ${schema.$ref}`];
  }
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        return [`${path}: expected object`];
      const errors: string[] = [];
      for (const [key, item] of Object.entries(value)) {
        const property =
          schema.properties?.[key] ?? schema.additionalProperties;
        if (!property) errors.push(`${path}.${key}: not in schema`);
        else errors.push(...validate(doc, property, item, `${path}.${key}`));
      }
      return errors;
    }
    case 'array':
      return Array.isArray(value)
        ? value.flatMap((item, index) =>
            validate(doc, schema.items ?? {}, item, `${path}[${index}]`),
          )
        : [`${path}: expected array`];
    case 'string':
      if (typeof value !== 'string') return [`${path}: expected string`];
      if (
        (schema.format === 'int64' || schema.format === 'uint64') &&
        !/^-?\d+$/.test(value)
      )
        return [`${path}: expected an integer string`];
      if (
        (schema.format === 'date-time' ||
          schema.format === 'google-datetime') &&
        Number.isNaN(Date.parse(value))
      )
        return [`${path}: expected a date-time`];
      if (schema.enum && !schema.enum.includes(value))
        return [`${path}: ${value} is not in the enum`];
      return [];
    case 'integer':
      return Number.isInteger(value) ? [] : [`${path}: expected integer`];
    case 'number':
      return typeof value === 'number' ? [] : [`${path}: expected number`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}: expected boolean`];
    case 'any':
    case undefined:
      return [];
    default:
      return [`${path}: unknown schema type ${schema.type}`];
  }
}

/** The response schema of a method, for example `['customers', 'telemetry', 'devices', 'list']`. */
export function methodSchema(doc: Discovery, path: readonly string[]): Schema {
  let node: Resource = doc;
  for (const name of path.slice(0, -1)) {
    const next = node.resources?.[name];
    if (!next) throw new Error(`No resource ${name} in ${path.join('.')}.`);
    node = next;
  }
  const response = node.methods?.[path.at(-1)!]?.response;
  if (!response) throw new Error(`No response schema for ${path.join('.')}.`);
  return response;
}
