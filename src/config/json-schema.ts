type Schema = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const child = (path: string, key: string | number): string =>
  typeof key === 'number'
    ? `${path}[${key}]`
    : path === ''
      ? key
      : `${path}.${key}`;

const TYPE_TEST: Readonly<Record<string, (value: unknown) => boolean>> = {
  object: isObject,
  array: Array.isArray,
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => typeof value === 'number' && Number.isInteger(value),
};

const ARTICLE: Readonly<Record<string, string>> = {
  object: 'an object',
  array: 'an array',
  string: 'a string',
  boolean: 'true or false',
  null: 'null',
  number: 'a number',
  integer: 'an integer',
};

/**
 * Validate a value against the JSON Schema subset that schema/config.schema.json uses:
 * type, properties, required, additionalProperties false, enum, minimum, maximum,
 * items, anyOf, and $ref to #/$defs. Errors come in document order, each naming its path.
 */
export function validateSchema(root: Schema, value: unknown): string[] {
  const errors: string[] = [];
  const resolve = (schema: Schema): Schema => {
    const ref = schema.$ref;
    if (typeof ref !== 'string') return schema;
    const name = ref.replace(/^#\/\$defs\//, '');
    const target = (root.$defs as Record<string, Schema> | undefined)?.[name];
    if (!target) throw new Error(`Unknown schema reference ${ref}.`);
    return {
      ...target,
      ...Object.fromEntries(
        Object.entries(schema).filter(([key]) => key !== '$ref'),
      ),
    };
  };
  const check = (
    raw: Schema,
    input: unknown,
    path: string,
    out: string[],
  ): void => {
    const schema = resolve(raw);
    const label = path === '' ? 'The configuration' : path;
    if (Array.isArray(schema.anyOf)) {
      const matches = (schema.anyOf as Schema[]).some((option) => {
        const trial: string[] = [];
        check(option, input, path, trial);
        return trial.length === 0;
      });
      if (!matches) out.push(`${label} must match one of the allowed forms.`);
      return;
    }
    if (Array.isArray(schema.enum)) {
      if (!(schema.enum as unknown[]).includes(input))
        out.push(
          `${label} must be one of: ${(schema.enum as unknown[]).join(', ')}.`,
        );
      return;
    }
    const type = schema.type as string | undefined;
    if (type && !TYPE_TEST[type](input)) {
      out.push(`${label} must be ${ARTICLE[type]}.`);
      return;
    }
    if (typeof input === 'number') {
      if (typeof schema.minimum === 'number' && input < schema.minimum)
        out.push(`${label} must be at least ${schema.minimum}.`);
      if (typeof schema.maximum === 'number' && input > schema.maximum)
        out.push(`${label} must be at most ${schema.maximum}.`);
    }
    if (Array.isArray(input) && isObject(schema.items))
      input.forEach((item, index) =>
        check(schema.items as Schema, item, child(path, index), out),
      );
    if (isObject(input)) {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of (schema.required ?? []) as string[])
        if (!Object.hasOwn(input, key))
          out.push(`${child(path, key)} is required.`);
      for (const [key, inner] of Object.entries(input)) {
        if (Object.hasOwn(properties, key))
          check(properties[key], inner, child(path, key), out);
        else if (schema.additionalProperties === false)
          out.push(`${child(path, key)} is not an allowed key.`);
      }
    }
  };
  check(root, value, '', errors);
  return errors;
}
