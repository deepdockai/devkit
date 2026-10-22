import { describe, expect, it } from 'vitest'
import { requestedSlug, resolveOrg, selectableOrgs } from '../../src/config/orgSelection.ts'
import { emptyConfig } from '../../src/config/store.ts'

const orgs = [
  { slug: 'muster-it', name: 'Muster IT', role: 'admin' },
  { slug: null, name: 'No Slug GmbH', role: 'member' },
]

describe('requestedSlug', () => {
  const config = { ...emptyConfig(), defaultOrg: 'stored' }

  it('takes the flag, then DEEPDOCK_ORG, then the stored default', () => {
    expect(requestedSlug('flag', { DEEPDOCK_ORG: 'env' }, config)).toBe('flag')
    expect(requestedSlug(undefined, { DEEPDOCK_ORG: 'env' }, config)).toBe('env')
    expect(requestedSlug(undefined, {}, config)).toBe('stored')
    expect(requestedSlug(undefined, {}, emptyConfig())).toBeUndefined()
    expect(requestedSlug('', { DEEPDOCK_ORG: '' }, emptyConfig())).toBeUndefined()
  })
})

describe('resolveOrg', () => {
  it('finds a member organisation', () => {
    expect(resolveOrg('muster-it', orgs)).toEqual({
      slug: 'muster-it',
      name: 'Muster IT',
      role: 'admin',
    })
  })

  it('lists only organisations that have a slug', () => {
    expect(selectableOrgs(orgs).map((org) => org.slug)).toEqual(['muster-it'])
    expect(() => resolveOrg(undefined, orgs)).toThrow('No organisation chosen.')
  })

  it('separates "none chosen" from "not a member"', () => {
    expect(() => resolveOrg(undefined, orgs)).toThrowError(
      expect.objectContaining({ code: 'org_required', organisations: ['muster-it'] }),
    )
    expect(() => resolveOrg('other', orgs)).toThrowError(
      expect.objectContaining({ code: 'invalid_usage' }),
    )
  })
})
