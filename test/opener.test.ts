import { describe, expect, it } from 'vitest'
import { openTarget } from '../src/opener.js'

describe('openTarget', () => {
  it('opens only a web address or a full path, so nothing passes for an option', async () => {
    await expect(openTarget('-a Calculator')).rejects.toThrow('Not an address or a full path')
    await expect(openTarget('docs/README.md')).rejects.toThrow('Not an address or a full path')
    await expect(openTarget('javascript:alert(1)')).rejects.toThrow('Not an address or a full path')
  })
})
