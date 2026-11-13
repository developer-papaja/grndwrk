import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { openOnMac } from '../src/server/comments'
import { noteTab, subscribe } from '../src/server/events'

/** Enough of a response for server-sent events: what was written, and close. */
function fakeTab() {
  const res = new EventEmitter() as EventEmitter & { written: string; writeHead: () => unknown; write: (s: string) => boolean }
  res.written = ''
  res.writeHead = () => res
  res.write = (s: string) => ((res.written += s), true)
  return res
}

describe('Write on the Mac with the map tab in the background', () => {
  it('waits for the tab to come back instead of opening another', async () => {
    // A tab in the background says it is still open, without a connection.
    noteTab()
    expect(await openOnMac('n_abc123', 'http://localhost:7777')).toBe('browser')
    // The person looks at the map: the tab connects and opens the comment.
    const tab = fakeTab()
    subscribe(tab as unknown as ServerResponse)
    expect(tab.written).toContain('"type":"node:open","id":"n_abc123"')
    // Only once: the next tab to connect gets nothing.
    tab.emit('close')
    const other = fakeTab()
    subscribe(other as unknown as ServerResponse)
    expect(other.written).not.toContain('node:open')
    other.emit('close')
  })
})
