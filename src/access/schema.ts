import { z } from 'zod';
import { reportKeySchema } from '../report/contracts';
import { ApiError } from '../api/errors';

const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const reportAudienceSchema = z.enum([
  'client_private',
  'unlisted_public',
]);

export type ReportAudience = z.infer<typeof reportAudienceSchema>;

export const clientIdentitySchema = z
  .object({
    integrationInstance: identity,
    environment: z.enum(['dev', 'prod']),
    externalClientId: identity,
  })
  .strict();

const operatorAccessSchema = z.object({ kind: z.literal('operator') }).strict();

/**
 * An integration token names the calling application; every request names
 * the client it acts for in the expectation headers, and the grant table
 * decides whether that client may touch the report.
 */
const integrationAccessSchema = clientIdentitySchema
  .omit({ externalClientId: true })
  .extend({ kind: z.literal('integration') })
  .strict();

/** What a token stores. */
export const tokenAccessSchema = z.discriminatedUnion('kind', [
  operatorAccessSchema,
  integrationAccessSchema,
]);

export type TokenAccess = z.infer<typeof tokenAccessSchema>;

/**
 * What a request acts as once the token and the expectation headers agree:
 * an operator, or an integration resolved to one client.
 */
const requestClientAccessSchema = clientIdentitySchema
  .extend({ kind: z.literal('client') })
  .strict();

const requestAccessSchema = z.discriminatedUnion('kind', [
  operatorAccessSchema,
  requestClientAccessSchema,
  integrationAccessSchema,
]);

export type RequestClientAccess = z.infer<typeof requestClientAccessSchema>;
type RequestAccess = { kind: 'operator' } | RequestClientAccess;

export const clientGrantInputSchema = clientIdentitySchema
  .extend({
    reportKey: reportKeySchema,
    status: z.enum(['active', 'suspended']),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export const clientGrantLookupSchema = clientGrantInputSchema.omit({
  status: true,
  expectedRevision: true,
});

/**
 * The access a request runs with. An unresolved integration token has no
 * client yet; the API handler resolves it before any route sees the token.
 * Missing access is supported only for old operator records/fixtures.
 */
export const tokenAccess = (token: {
  access?: TokenAccess | RequestClientAccess;
}): RequestAccess => {
  const access = requestAccessSchema.parse(
    token.access ?? { kind: 'operator' },
  );

  if (access.kind === 'integration') {
    throw new ApiError(
      'not_found',
      'Integration credential requires an expected client',
    );
  }

  return access;
};
