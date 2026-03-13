import { describe, expect, it } from 'vitest'
import { buildHashPath, parseHashPath } from './useHashRoute'

describe('hash route helpers', () => {
  it('parses query params from a hash path', () => {
    expect(parseHashPath('#/connectors/slack?window=7d&root=true')).toEqual({
      path: '/connectors/slack',
      query: {
        window: '7d',
        root: 'true',
      },
    })
  })

  it('builds a hash path with only defined query params', () => {
    expect(buildHashPath('/', { window: '24h', root: true, empty: undefined })).toBe('/?window=24h&root=true')
  })
})
