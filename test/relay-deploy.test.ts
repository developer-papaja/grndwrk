import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deployedAt } from '../src/relay/cli.js'

describe('relay deploy', () => {
  it('reads where the relay runs from wrangler’s report, not from its screen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-deploy-'))
    const report = join(dir, 'out.ndjson')
    await writeFile(report, [
      JSON.stringify({ type: 'wrangler-session', version: 1 }),
      JSON.stringify({ type: 'deploy', version: 1, worker_name: 'grndwrk-relay', targets: ['https://grndwrk-relay.anna.workers.dev'] }),
    ].join('\n') + '\n')
    expect(await deployedAt(report)).toBe('https://grndwrk-relay.anna.workers.dev')
    await writeFile(report, JSON.stringify({ type: 'wrangler-session', version: 1 }) + '\n')
    await expect(deployedAt(report)).rejects.toThrow(/did not say where the relay runs/)
    await expect(deployedAt(join(dir, 'missing'))).rejects.toThrow(/workers.dev name/)
    await rm(dir, { recursive: true, force: true })
  })
})
