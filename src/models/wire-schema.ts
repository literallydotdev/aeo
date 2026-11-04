import { jsonSchema } from 'ai';
import { z } from 'zod';

type JsonNode = Record<string, unknown>;

type WireNode = {
  schema: JsonNode;
  decode: (value: unknown) => unknown;
};

const isJsonNode = (value: unknown): value is JsonNode => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const requireJsonNode = (value: unknown): JsonNode => {
  if (!isJsonNode(value)) {
    throw new Error(`Unsupported JSON schema node: ${JSON.stringify(value)}.`);
  }

  return value;
};

const getStringList = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
};

const matchesObject = (schema: JsonNode, value: unknown): boolean => {
  if (!isJsonNode(value)) {
    return false;
  }

  const properties = isJsonNode(schema.properties) ? schema.properties : {};

  if (
    getStringList(schema.required).some((key) => !Object.hasOwn(value, key))
  ) {
    return false;
  }

  if (
    schema.additionalProperties === false &&
    Object.keys(value).some((key) => !Object.hasOwn(properties, key))
  ) {
    return false;
  }

  return Object.entries(properties).every(
    ([key, child]) =>
      !Object.hasOwn(value, key) ||
      !isJsonNode(child) ||
      matches(child, value[key]),
  );
};

const matchesArray = (schema: JsonNode, value: unknown): boolean => {
  const items = schema.items;

  if (!Array.isArray(value)) {
    return false;
  }

  if (!isJsonNode(items)) {
    return true;
  }

  return value.every((item) => matches(items, item));
};

const matches = (schema: JsonNode, value: unknown): boolean => {
  if ('const' in schema && schema.const !== value) {
    return false;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return false;
  }

  const alternatives = schema.anyOf ?? schema.oneOf;

  if (Array.isArray(alternatives)) {
    return alternatives.some(
      (branch) => isJsonNode(branch) && matches(branch, value),
    );
  }

  if (Array.isArray(schema.type)) {
    return schema.type.some((type) => matches({ ...schema, type }, value));
  }

  if (schema.type === 'null') {
    return value === null;
  }

  if (schema.type === 'object') {
    return matchesObject(schema, value);
  }

  if (schema.type === 'array') {
    return matchesArray(schema, value);
  }

  if (schema.type === 'integer') {
    return Number.isInteger(value);
  }

  if (typeof schema.type === 'string') {
    return typeof value === schema.type;
  }

  return true;
};

const convertUnion = (
  schema: JsonNode,
  alternatives: readonly unknown[],
): WireNode => {
  const branches = alternatives.map((branch) =>
    convert(requireJsonNode(branch)),
  );
  const { oneOf: _oneOf, ...rest } = schema;
  const unionSchema = {
    ...rest,
    anyOf: branches.map((branch) => branch.schema),
  };

  return {
    schema: unionSchema,
    decode: (value) => {
      const branch = branches.find((candidate) =>
        matches(candidate.schema, value),
      );

      if (!branch) {
        throw new Error('Invalid structured union shape');
      }

      return branch.decode(value);
    },
  };
};

// Strict providers cannot emit arbitrary object keys. Represent dictionaries
// as explicit entries on the wire and reconstruct them before Zod validates.
const convertDictionary = (valueSchema: JsonNode): WireNode => {
  const item = convert(valueSchema);

  return {
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, value: item.schema },
        required: ['key', 'value'],
        additionalProperties: false,
      },
    },
    decode: (value) => {
      if (!Array.isArray(value)) {
        return value;
      }

      const keys = new Set<string>();

      return Object.fromEntries(
        value.map((entry: unknown) => {
          if (
            !isJsonNode(entry) ||
            Object.keys(entry).length !== 2 ||
            typeof entry.key !== 'string' ||
            !('value' in entry) ||
            keys.has(entry.key)
          ) {
            throw new Error('Invalid or duplicate structured dictionary entry');
          }

          keys.add(entry.key);

          return [entry.key, item.decode(entry.value)];
        }),
      );
    },
  };
};

const convertObject = (schema: JsonNode): WireNode => {
  const rawProperties = isJsonNode(schema.properties) ? schema.properties : {};
  const properties = Object.fromEntries(
    Object.entries(rawProperties).map(([key, child]) => [
      key,
      requireJsonNode(child),
    ]),
  );
  const required = new Set(getStringList(schema.required));
  const children = Object.fromEntries(
    Object.entries(properties).map(([key, child]) => [key, convert(child)]),
  );

  const objectSchema = {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(children).map(([key, child]) => [
        key,
        required.has(key)
          ? child.schema
          : { anyOf: [child.schema, { type: 'null' }] },
      ]),
    ),
    required: Object.keys(properties),
    additionalProperties: false,
  };

  const getChild = (key: string) => {
    return Object.hasOwn(children, key) ? children[key] : undefined;
  };

  return {
    schema: objectSchema,
    decode: (value) => {
      if (!isJsonNode(value)) {
        return value;
      }

      if (Object.keys(value).some((key) => !Object.hasOwn(children, key))) {
        throw new Error('Unknown structured object property');
      }

      return Object.fromEntries(
        Object.entries(value).flatMap(([key, child]) => {
          const childNode = getChild(key);
          const property = properties[key];

          if (
            child === null &&
            childNode &&
            property &&
            !required.has(key) &&
            !matches(property, null)
          ) {
            return [];
          }

          return [[key, childNode ? childNode.decode(child) : child]];
        }),
      );
    },
  };
};

const convert = (original: JsonNode): WireNode => {
  const {
    $schema: _schemaUri,
    default: _default,
    ...schema
  }: JsonNode = original;

  // URI is emitted by z.url(), but is outside the provider's format subset.
  // Original Zod validation still enforces URL syntax after decoding.
  if (schema.format === 'uri') {
    delete schema.format;
  }

  const alternatives = schema.oneOf ?? schema.anyOf;

  if (Array.isArray(alternatives)) {
    return convertUnion(schema, alternatives);
  }

  if (schema.type === 'array' && isJsonNode(schema.items)) {
    const item = convert(schema.items);
    const arraySchema = { ...schema, items: item.schema };

    return {
      schema: arraySchema,
      decode: (value) =>
        Array.isArray(value)
          ? value.map((entry: unknown) => item.decode(entry))
          : value,
    };
  }

  if (schema.type === 'object') {
    if (isJsonNode(schema.additionalProperties) && !schema.properties) {
      return convertDictionary(schema.additionalProperties);
    }

    return convertObject(schema);
  }

  return { schema, decode: (value) => value };
};

/**
 * Why a decoded response was refused, in terms a writer can act on. Only our
 * own rule text and paths travel; never a received value.
 */
export type StructuredSchemaIssue = {
  path: string;
  message: string;
};

const schemaIssues = (error: unknown): StructuredSchemaIssue[] => {
  if (error instanceof z.ZodError) {
    return error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message.slice(0, 300),
    }));
  }

  return [
    {
      path: '',
      message:
        error instanceof Error
          ? error.message.slice(0, 300)
          : 'Invalid structured output',
    },
  ];
};

/**
 * unwrapDoubleEncoded handles a known provider quirk on the wrapped envelope:
 * Opus 5 through the gateway sometimes returns the whole `{ result: ... }`
 * object as a JSON string under a single `input` key (measured 2026-09-12,
 * reviewer turns). The value is the legal answer; only its envelope is wrong,
 * so it is unwrapped before the envelope check. Anything else passes through
 * untouched and fails the check as before.
 */
const unwrapDoubleEncoded = (value: unknown): unknown => {
  if (!isJsonNode(value) || Object.keys(value).length !== 1) {
    return value;
  }

  const { input } = value;

  if (typeof input !== 'string') {
    return value;
  }

  try {
    const inner: unknown = JSON.parse(input);

    return isJsonNode(inner) && 'result' in inner ? inner : value;
  } catch {
    return value;
  }
};

const nestedEnvelope = (payload: unknown): unknown => {
  if (!isJsonNode(payload) || Object.keys(payload).length !== 1) {
    return undefined;
  }

  return 'result' in payload ? payload.result : undefined;
};

/**
 * structuredWireSchema works around SDK 6 and Zod 4 emitting oneOf and
 * top-level unions that strict providers reject. The wire envelope is
 * provider-compatible; the original schema still decides whether a decoded
 * result is valid, including refinements and branch rules. Refinements cannot
 * be expressed on the wire, so a response can satisfy the published contract
 * and still be refused here; `lastFailure` carries that reason out so the
 * caller can ask for a repair rather than guess again.
 */
export const structuredWireSchema = <T>(schema: z.ZodType<T>) => {
  const original = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    reused: 'inline',
  });

  const converted = convert(original);
  const wrapped =
    converted.schema.type !== 'object' || 'anyOf' in converted.schema;
  const wire = wrapped
    ? {
        type: 'object' as const,
        properties: { result: converted.schema },
        required: ['result'],
        additionalProperties: false,
      }
    : converted.schema;

  const readPayload = (value: unknown): unknown => {
    if (!wrapped) {
      return value;
    }

    const envelope = unwrapDoubleEncoded(value);

    if (
      !isJsonNode(envelope) ||
      Object.keys(envelope).length !== 1 ||
      !('result' in envelope)
    ) {
      throw new Error('Structured result envelope is missing or invalid');
    }

    return envelope.result;
  };

  const decode = (value: unknown): T => {
    const payload = readPayload(value);

    try {
      return schema.parse(converted.decode(payload));
    } catch (error) {
      // The same provider also nests the envelope, `{ result: { result } }`
      // (measured 2026-09-12, repair-planner turn). Only a payload that
      // fails as written is retried one level down, so a legal answer that
      // happens to carry a `result` key is never misread.
      const nested = nestedEnvelope(payload);

      if (nested === undefined) {
        throw error;
      }

      return schema.parse(converted.decode(nested));
    }
  };

  let failure: StructuredSchemaIssue[] = [];

  return {
    wire,
    wrapped,
    decode,
    lastFailure: () => failure,
    sdkSchema: jsonSchema<T>(wire, {
      validate(value) {
        try {
          const decoded = decode(value);

          failure = [];

          return { success: true, value: decoded };
        } catch (error) {
          failure = schemaIssues(error);

          return {
            success: false,
            error:
              error instanceof Error
                ? error
                : new Error('Invalid structured output'),
          };
        }
      },
    }),
  };
};
