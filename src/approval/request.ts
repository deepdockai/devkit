import { type Api, baseUrlFor } from '../api/client.ts'
import { CliError } from '../api/errors.ts'
import { parseAnswer } from '../api/schemas.ts'
import type { Runtime } from '../runtime.ts'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The dashboard host for an API host: `api.x` becomes `dash.x`; any other host has none. */
export const dashboardHostFor = (baseUrl: string): string | undefined => {
  const host = new URL(baseUrl).hostname
  return host.startsWith('api.') ? `dash.${host.slice('api.'.length)}` : undefined
}

/**
 * The approval link is printed and opened in a browser, so it must be https on the dashboard host
 * of the API in use (`api.` replaced by `dash.`), or a loopback host for local development. The
 * parsed form is returned: the URL parser drops newlines and percent-encodes what a terminal or
 * opener could misread.
 */
export const approvalUrl = (value: string, baseUrl: string): string => {
  const dashboardHost = dashboardHostFor(baseUrl)
  try {
    const parsed = new URL(value)
    const dashboard = parsed.protocol === 'https:' && parsed.hostname === dashboardHost
    const local =
      LOOPBACK_HOSTS.has(parsed.hostname) && ['http:', 'https:'].includes(parsed.protocol)
    if ((dashboard || local) && parsed.username === '' && parsed.password === '') return parsed.href
  } catch {
    // falls through to the refusal below
  }
  throw new CliError({
    code: 'internal_error',
    message: 'The API sent an approval link this CLI will not print or open.',
    hint: dashboardHost
      ? `Only https links on ${dashboardHost} (or localhost) are accepted for this API.`
      : 'Only localhost links are accepted: this API address does not start with "api.", so no dashboard host can be derived from it.',
  })
}

export type StartedRequest = {
  request: string
  url: string
  pollSecret: string
  expiresAt: string
  requestId?: string
}

export const startLogin = async (api: Api, rt: Runtime): Promise<StartedRequest> => {
  const response = await api.request({
    method: 'POST',
    path: '/public/cli/logins',
    body: { hostname: rt.hostname, cliVersion: rt.version },
  })
  const started = await parseAnswer('requestStart', response.data)
  return {
    request: started.requestId,
    url: approvalUrl(started.approveUrl, baseUrlFor(rt)),
    pollSecret: started.pollSecret,
    expiresAt: started.expiresAt,
    requestId: response.requestId,
  }
}

export const startKeyRequest = async (
  api: Api,
  rt: Runtime,
  input: { secret: string; org: string; name: string; expiresAt: string },
): Promise<StartedRequest> => {
  const response = await api.request({
    method: 'POST',
    path: '/partner/key-requests',
    secret: input.secret,
    org: input.org,
    body: {
      name: input.name,
      expiresAt: input.expiresAt,
      hostname: rt.hostname,
      cliVersion: rt.version,
    },
  })
  const started = await parseAnswer('requestStart', response.data)
  return {
    request: started.requestId,
    url: approvalUrl(started.approveUrl, baseUrlFor(rt)),
    pollSecret: started.pollSecret,
    expiresAt: started.expiresAt,
    requestId: response.requestId,
  }
}
