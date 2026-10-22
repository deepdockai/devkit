import { usageError } from './api/errors.ts'

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SYSTEM_NAME = /^[A-Za-z0-9._-]{1,64}$/
const KEY_ID = /^[A-Za-z0-9_-]{1,100}$/

export const deviceIdArg = (value: string): string => {
  if (!DEVICE_ID.test(value)) {
    throw usageError(
      `"${value}" is not a full device id.`,
      'Copy the whole id from `deepdock devices list`; short ids and labels are not accepted.',
    )
  }
  return value
}

export const systemArg = (value: string): string => {
  if (!SYSTEM_NAME.test(value)) {
    throw usageError(`"${value}" is not a system name.`, 'List them with `deepdock systems list`.')
  }
  return value
}

export const keyIdArg = (value: string): string => {
  if (!KEY_ID.test(value)) {
    throw usageError(`"${value}" is not an API key id.`, 'List them with `deepdock keys list`.')
  }
  return value
}

export const EXPIRY_DAYS: Readonly<Record<string, number>> = { '7d': 7, '30d': 30, '90d': 90 }

export const expiryArg = (value: string | undefined): number => {
  const days = value === undefined ? undefined : EXPIRY_DAYS[value]
  if (days === undefined) {
    throw usageError(
      value === undefined ? 'The key needs an expiry.' : `"${value}" is not an allowed expiry.`,
      'Allowed: 7d, 30d, 90d; 90 days is the maximum from the CLI.',
    )
  }
  return days
}
