import { describe, expect, it } from 'vitest'
import * as web from '../relay/src/crypto.js'
import * as node from '../src/relay/keys.js'

describe('relay keys on Node and in the Worker', () => {
  it('derive the same keys and ids', async () => {
    const k = node.randomKey()
    expect(node.phoneSignKey(k)).toBe(await web.phoneSignKey(k))
    expect(node.phoneSealKey(k)).toBe(await web.phoneSealKey(k))
    expect(node.teamAuthKey(k)).toBe(await web.teamAuthKey(k))
    expect(node.teamSealKey(k)).toBe(await web.teamSealKey(k))
    expect(node.ownerAuthKey(k)).toBe(await web.ownerAuthKey(k))
    expect(node.relayDeviceId(k)).toBe(await web.relayDeviceId(k))
    expect(node.inviteId(k)).toBe(await web.inviteId(k))
  })
  it('open what the other sealed, and only in the same place', async () => {
    const k = node.randomKey()
    const fromNode = node.seal(k, 'inbox:a', Buffer.from('hello'))
    expect(new TextDecoder().decode(await web.open(k, 'inbox:a', new Uint8Array(fromNode)))).toBe('hello')
    expect(await web.open(k, 'inbox:b', new Uint8Array(fromNode))).toBeUndefined()
    const fromWeb = await web.seal(k, 'outbox:a', new TextEncoder().encode('back'))
    expect(node.open(k, 'outbox:a', Buffer.from(fromWeb))?.toString()).toBe('back')
    expect(node.open(k, 'outbox:b', Buffer.from(fromWeb))).toBeUndefined()
    expect(node.openJson(k, 'x', node.sealJson(k, 'x', { a: 1 }))).toEqual({ a: 1 })
  })
})
