import { CliError } from './errors.ts'

// ArkType is imported lazily: local commands (--help, --version, auth status, skill, usage
// errors) never reach this module's loader, so they never pay for parsing the validation library.
// biome-ignore lint/nursery/useExplicitType: every schema type below is inferred from this return value
const build = async () => {
  const { type } = await import('arktype')
  const orgInfo = type({ slug: 'string | null', name: 'string', role: 'string' })
  const pendingStatus = type({ status: "'pending' | 'denied' | 'expired'" })
  return {
    isInvalid: (value: unknown): boolean => value instanceof type.errors,
    orgs: orgInfo.array(),
    requestStart: type({
      requestId: 'string',
      approveUrl: 'string',
      pollSecret: 'string',
      expiresAt: 'string',
    }),
    loginPoll: pendingStatus.or(
      type({
        status: "'approved'",
        'id?': 'string',
        key: 'string',
        expiresAt: 'string',
        user: { 'firstName?': 'string | null', email: 'string' },
        organisations: orgInfo.array(),
        'environment?': 'string',
      }),
    ),
    keyPoll: pendingStatus.or(
      type({
        status: "'approved'",
        key: {
          id: 'string',
          name: 'string',
          keyPrefix: 'string',
          key: 'string',
          createdAt: 'string',
          expiresAt: 'string',
        },
      }),
    ),
    cliKeys: type({
      id: 'string',
      hostname: 'string',
      createdAt: 'string',
      expiresAt: 'string',
      'revokedAt?': 'string | null',
    }).array(),
  }
}

type Schemas = Awaited<ReturnType<typeof build>>
type SchemaName = Exclude<keyof Schemas, 'isInvalid'>

let loading: Promise<Schemas> | undefined

const load = (): Promise<Schemas> => {
  loading ??= build()
  return loading
}

/**
 * Validates an API answer at the edge. The failure message names the schema only: ArkType's own
 * summary quotes the offending value, and for a key answer that value would be the key.
 */
export const parseAnswer = async <K extends SchemaName>(
  name: K,
  value: unknown,
): Promise<Schemas[K]['infer']> => {
  const schemas = await load()
  const schema = schemas[name] as unknown as (input: unknown) => unknown
  const result = schema(value)
  if (schemas.isInvalid(result)) {
    throw new CliError({
      code: 'internal_error',
      message: `The API answered in a shape this CLI does not know (${name}).`,
      hint: 'Update the CLI with `npx @deepdockai/cli@latest`, or retry later.',
    })
  }
  return result as Schemas[K]['infer']
}

export type Answer<K extends SchemaName> = Schemas[K]['infer']
