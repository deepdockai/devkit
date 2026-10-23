import type { StyleName, Styler } from './styles.ts'

export type Cell = string | { text: string; style: StyleName }

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Text from the API goes to a terminal: drop control characters so it cannot move the cursor. */
export const stripControl = (value: string): string =>
  Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)
    })
    .join('')

/** The columns a human view shows, in order. Anything else in an answer stays out of the view. */
export type Columns = readonly string[]

export const DEVICE_COLUMNS: Columns = [
  'id',
  'label',
  'hostname',
  'os',
  'clientVersion',
  'status',
  'lastSeenAt',
  'claimedAt',
  'updateAvailable',
  'systems',
]
export const SYSTEM_COLUMNS: Columns = [
  'system',
  'name',
  'version',
  'status',
  'actions',
  'description',
]
export const INCIDENT_COLUMNS: Columns = [
  'id',
  'system',
  'action',
  'device',
  'deviceId',
  'status',
  'state',
  'reason',
  'openedAt',
  'closedAt',
]
export const KEY_COLUMNS: Columns = [
  'id',
  'name',
  'keyPrefix',
  'createdAt',
  'expiresAt',
  'revokedAt',
  'lastUsedAt',
]
export const ACTION_COLUMNS: Columns = ['name', 'kind', 'fields', 'description', 'state', 'status']
export const DEVICE_SYSTEM_COLUMNS: Columns = [
  'systems',
  'system',
  'name',
  'action',
  'version',
  'status',
  'state',
  'actions',
  'reason',
  'pausedReason',
  'since',
  'pausedAt',
]

export const NOTHING_TO_SHOW = '(nothing to show in this view; use --json for the full answer)'

const cellText = (cell: Cell): string => stripControl(typeof cell === 'string' ? cell : cell.text)

export const renderTable = (header: string[], rows: Cell[][], style: Styler): string => {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => cellText(row[column] ?? '').length)),
  )
  const line = (cells: Cell[], isHeader: boolean): string =>
    cells
      .map((cell, column) => {
        const plain = cellText(cell)
        const padded = column === cells.length - 1 ? plain : plain.padEnd(widths[column] ?? 0)
        if (isHeader) return style('bold', padded)
        if (typeof cell === 'string') return padded
        return style(cell.style, padded)
      })
      .join('   ')
      .trimEnd()
  const headerLine = line(header, true)
  return [headerLine, ...rows.map((row) => line(row, false))].join('\n')
}

const columnTitle = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toUpperCase()

const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

const GOOD = new Set(['connected', 'active', 'running', 'ok'])
const WARN = new Set(['offline', 'paused', 'outdated', 'unavailable', 'degraded'])
const BAD = new Set(['revoked', 'failed', 'denied', 'expired'])

/** Colour for a value whose word carries the meaning; the word stays, so colour is never alone. */
const cellFor = (key: string, value: unknown): Cell => {
  const text = scalar(value)
  if (text === '') return text
  if (key === 'reason' || key === 'pausedReason') return words(text)
  if (key === 'revokedAt') return { text, style: 'red' }
  if (key === 'name' || key === 'action') return { text, style: 'bold' }
  if (key.endsWith('At') || key === 'since') return { text, style: 'dim' }
  if (key === 'status' || key === 'state') {
    if (GOOD.has(text)) return { text, style: 'green' }
    if (WARN.has(text)) return { text, style: 'yellow' }
    if (BAD.has(text)) return { text, style: 'red' }
  }
  return text
}

/** A table of the allowed columns that the answer has; an unknown shape never fails. */
export const genericTable = (items: unknown[], style: Styler, allow: Columns): string => {
  const records = items.filter(isRecord)
  const shown = allow.filter((key) =>
    records.some((record) => key in record && isScalar(record[key])),
  )
  if (shown.length === 0) return NOTHING_TO_SHOW
  return renderTable(
    shown.map(columnTitle),
    records.map((record) => shown.map((key) => cellFor(key, record[key]))),
    style,
  )
}

export const relativeTime = (iso: unknown, now: Date): string => {
  if (typeof iso !== 'string') return 'never'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const seconds = Math.round((now.getTime() - then) / 1000)
  if (seconds < 60) return 'just now'
  const units: [string, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]
  for (const [unit, size] of units) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size)
      return `${count} ${unit}${count === 1 ? '' : 's'} ago`
    }
  }
  return 'just now'
}

export const field = (record: Record<string, unknown>, key: string): string => scalar(record[key])

export const deviceStatusCell = (status: string): Cell => {
  if (status === 'connected') return { text: status, style: 'green' }
  if (status === 'offline' || status === 'paused') return { text: status, style: 'yellow' }
  return status
}

export const systemsLabel = (device: Record<string, unknown>): string => {
  const systems = Array.isArray(device.systems) ? device.systems.filter(isRecord) : []
  if (systems.length === 0) return '(none reported)'
  return systems
    .map((system) => [field(system, 'system'), field(system, 'version')].filter(Boolean).join(' '))
    .join(', ')
}

export const deviceTable = (devices: unknown[], now: Date, style: Styler): string => {
  const records = devices.filter(isRecord)
  // Without the fields the columns are named after, show whatever keys the API sent.
  if (!records.some((device) => 'id' in device && 'status' in device))
    return genericTable(records, style, DEVICE_COLUMNS)
  return renderTable(
    ['ID', 'LABEL', 'STATUS', 'SYSTEMS', 'LAST SEEN'],
    records.map((device) => [
      field(device, 'id'),
      { text: field(device, 'label'), style: 'bold' },
      deviceStatusCell(field(device, 'status')),
      systemsLabel(device),
      { text: relativeTime(device.lastSeenAt, now), style: 'dim' },
    ]),
    style,
  )
}

const isScalar = (value: unknown): boolean =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)

const visibleEntries = (record: Record<string, unknown>, allow: Columns): [string, unknown][] =>
  allow.flatMap((key): [string, unknown][] => (key in record ? [[key, record[key]]] : []))

const blockLines = (
  record: Record<string, unknown>,
  style: Styler,
  indent: number,
  allow: Columns,
): string[] => {
  const pad = ' '.repeat(indent)
  const lines: string[] = []
  for (const [key, value] of visibleEntries(record, allow)) {
    if (isScalar(value)) {
      if (scalar(value) !== '') lines.push(`${pad}${key}: ${stripControl(scalar(value))}`)
    } else if (Array.isArray(value)) {
      const records = value.filter(isRecord)
      if (records.length === 0) {
        const items = value.filter(isScalar).map(scalar).filter(Boolean)
        if (items.length > 0) lines.push(`${pad}${key}: ${stripControl(items.join(', '))}`)
      } else {
        lines.push(`${pad}${key}:`)
        const flat = records.every((entry) =>
          visibleEntries(entry, allow).every(([, v]) => isScalar(v)),
        )
        if (flat) {
          lines.push(
            ...genericTable(records, style, allow)
              .split('\n')
              .map((line) => `${pad}  ${line}`),
          )
        } else {
          for (const entry of records)
            lines.push(...blockLines(entry, style, indent + 2, allow), '')
        }
      }
    } else if (isRecord(value)) {
      lines.push(`${pad}${key}:`, ...blockLines(value, style, indent + 2, allow))
    }
  }
  return lines
}

/** Renders a JSON value showing only the allowed keys it has; an unknown shape never fails. */
export const genericView = (data: unknown, style: Styler, allow: Columns): string => {
  if (isScalar(data)) return stripControl(scalar(data))
  if (isRecord(data)) return blockLines(data, style, 0, allow).join('\n')
  if (!Array.isArray(data)) return ''
  const records = data.filter(isRecord)
  if (records.length === 0)
    return data
      .filter(isScalar)
      .map((item) => stripControl(scalar(item)))
      .join('\n')
  const flat = records.every((entry) => visibleEntries(entry, allow).every(([, v]) => isScalar(v)))
  if (flat) return genericTable(records, style, allow)
  return records.map((entry) => blockLines(entry, style, 0, allow).join('\n')).join('\n\n')
}

/** How many scalar values anywhere in `data` equal `word` (for "N actions are paused"). */
export const countValue = (data: unknown, word: string): number => {
  if (data === word) return 1
  if (Array.isArray(data))
    return data.reduce<number>((sum, item) => sum + countValue(item, word), 0)
  if (isRecord(data))
    return Object.values(data).reduce<number>((sum, item) => sum + countValue(item, word), 0)
  return 0
}

/** "org:admin" is the identity provider's word; a person reads "Admin". */
export const roleLabel = (role: string): string => {
  const bare = role.replace(/^org:/, '').replace(/[_-]+/g, ' ')
  return bare === '' ? role : bare.charAt(0).toUpperCase() + bare.slice(1)
}

type OrgLike = { slug: string | null; name: string; role: string }

/** Organisations as a table: name first, slug dimmed, role in words, the default first and marked. */
export const orgTable = (
  orgs: OrgLike[],
  defaultSlug: string | undefined,
  style: Styler,
): string => {
  const isDefault = (org: OrgLike): boolean => org.slug !== null && org.slug === defaultSlug
  const ordered = [...orgs].sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)))
  return renderTable(
    ['NAME', 'SLUG', 'ROLE', ''],
    ordered.map((org): Cell[] => [
      { text: org.name, style: 'bold' },
      { text: org.slug ?? '(no slug)', style: 'dim' },
      roleLabel(org.role),
      isDefault(org) ? { text: 'default', style: 'green' } : '',
    ]),
    style,
  )
}

/** "structure_changed" is a code; the human view says "structure changed". */
export const words = (code: string): string => code.replace(/_/g, ' ')

export const systemsTable = (items: unknown[], style: Styler): string => {
  const records = items.filter(isRecord)
  if (!records.some((item) => 'system' in item)) return genericTable(records, style, SYSTEM_COLUMNS)
  return renderTable(
    ['SYSTEM', 'NAME', 'ACTIONS'],
    records.map((item): Cell[] => {
      const actions = Array.isArray(item.actions) ? item.actions.filter(isRecord) : undefined
      const writes = actions?.filter((action) => action.kind === 'write').length ?? 0
      const counted = actions
        ? `${actions.length} (${actions.length - writes} read, ${writes} write)`
        : ''
      return [{ text: field(item, 'system'), style: 'bold' }, field(item, 'label'), counted]
    }),
    style,
  )
}
