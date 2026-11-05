import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname } from 'node:path'
import { BadInput, NotFound, ReadOnly, type NodeStore } from '../store/nodes.js'
import { readProject, KICKOFF_STEPS, writeFields, writeKickoff, writePages } from '../store/project.js'
import { MAX_IMAGE_BYTES, readImage, removeFiles, saveImage } from '../store/files.js'
import { markAnswered, readReadiness, setFocusLater } from '../store/readiness.js'
import { createStory, listStories, readDraft, readOutput, updateStory } from '../store/stories.js'
import { listScreens, placeShot, updateScreen, type ScreenEdit } from '../store/screens.js'
import { createPersona, deletePersona, listPersonas, settleAudienceName, updatePersona } from '../store/personas.js'
import { createSegment, deleteSegment, listSegments, updateSegment } from '../store/segments.js'
import { listShots, readShot } from '../store/shots.js'
import { rememberedApp } from '../store/local.js'
import { LinkRefused } from '../store/fs.js'
import { today } from '../store/frontmatter.js'
import { docOnDisk, listDocs, readDoc } from './docs.js'
import { PERSONA_CHOICES, PERSONA_LISTS, PERSONA_SECTIONS, type NodeInput, type PersonaInSegment } from '../shared/types.js'
import { noteTab, subscribe, type NodeSync } from './events.js'
import type { Pairings } from './pairing.js'
import type { Sites } from './sites.js'
import { openTarget } from '../opener.js'
import { testedInMap } from './feedback.js'
import type { RelaySync } from '../relay/sync.js'
import { ownRelay } from '../relay/config.js'

interface Ctx {
  gwDir: string
  store: NodeStore
  nodes: NodeSync
  /** Phones asking to send comments, when `--lan` is on. */
  pairings?: Pairings
  /** Where the product runs behind the comment proxy, when `--app` is on. */
  runtime?: { app?: string }
  /** Local sites asking to send comments from the Comment button they load. */
  sites?: Sites
  /** This project's mailbox at the team's relay, when it has one. */
  relay?: RelaySync
}

/** Handles /api/*. Returns false when the request is not an API route. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return false
  const method = req.method ?? 'GET'
  const nodeMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)$/)
  const filesMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/files$/)

  try {
    // Images come as their own bytes, not JSON. A cross site page cannot send
    // an image content type without asking first, which we never allow.
    if (filesMatch && method === 'POST') {
      const id = decodeURIComponent(filesMatch[1])
      // A thought, a screen or a persona: pictures in notes, and in thread replies and answers.
      const known = (await ctx.store.get(id).then(() => true, () => false)) ||
        (await listScreens(ctx.gwDir)).some((s) => s.id === id) ||
        (await listPersonas(ctx.gwDir)).some((p) => p.id === id)
      if (!known) throw new NotFound(id)
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim()
      const data = await readRaw(req, MAX_IMAGE_BYTES)
      try {
        return send(res, 201, await saveImage(ctx.gwDir, id, type, data))
      } catch (err) {
        throw new BadInput(err instanceof Error ? err.message : String(err))
      }
    }

    if ((method === 'POST' || method === 'PATCH') && !isJson(req)) return send(res, 415, { error: 'Send JSON' })

    // Colleagues through the relay: who has joined, open invites, and inviting someone by name.
    if (url.pathname === '/api/relay' && method === 'GET') {
      if (!ctx.relay) return send(res, 200, { connected: false, deployed: !!(await ownRelay()) })
      return send(res, 200, { connected: true, ...(await ctx.relay.summary()) })
    }
    if (url.pathname === '/api/relay/invites' && method === 'POST') {
      if (!ctx.relay) throw new BadInput('This project has no relay yet. Run grndwrk relay add, or relay join with a team link')
      const { name } = (await readBody(req)) as { name?: unknown }
      try {
        return send(res, 201, await ctx.relay.invite(typeof name === 'string' ? name : ''))
      } catch (err) {
        throw new BadInput(err instanceof Error ? err.message : String(err))
      }
    }
    const joinMatch = url.pathname.match(/^\/api\/relay\/joins\/([a-f0-9]{32})$/)
    if (joinMatch && method === 'POST') {
      if (!ctx.relay) throw new NotFound(joinMatch[1])
      const { allow } = (await readBody(req)) as { allow?: unknown }
      if (typeof allow !== 'boolean') throw new BadInput('Say whether to allow it: { allow }')
      await ctx.relay.answerJoin(joinMatch[1], allow)
      return send(res, 200, { connected: true, ...(await ctx.relay.summary()) })
    }
    const relayMatch = url.pathname.match(/^\/api\/relay\/(phones|invites)\/([a-f0-9]{32})$/)
    if (relayMatch && method === 'DELETE') {
      if (!ctx.relay) throw new NotFound(relayMatch[2])
      await (relayMatch[1] === 'phones' ? ctx.relay.removePhone(relayMatch[2]) : ctx.relay.removeInvite(relayMatch[2]))
      return send(res, 200, { connected: true, ...(await ctx.relay.summary()) })
    }

    const testedMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/tested$/)
    if (testedMatch && method === 'POST') {
      const id = decodeURIComponent(testedMatch[1])
      const state = await testedInMap(ctx.store, id, await readBody(req))
      return send(res, 200, { state, node: await ctx.store.get(id) })
    }

    // A map tab in the background, saying it is still open.
    if (url.pathname === '/api/tab' && method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'Only from the map' })
      noteTab()
      res.writeHead(204).end()
      return true
    }
    if (url.pathname === '/api/events' && method === 'GET') {
      subscribe(res)
      return true
    }
    // Phones asking to send comments, answered by the person at the Mac. Only on this machine.
    if (url.pathname === '/api/pair' && method === 'GET') {
      return send(res, 200, ctx.pairings?.list() ?? [])
    }
    const pairMatch = url.pathname.match(/^\/api\/pair\/(pair_[a-f0-9]{12})$/)
    if (pairMatch && method === 'POST') {
      const body = (await readBody(req)) as { allow?: unknown }
      if (!(await ctx.pairings?.answer(pairMatch[1], body.allow === true))) throw new NotFound(pairMatch[1])
      return send(res, 200, { ok: true })
    }
    // Local sites asking to send comments, answered in the map. Only from the map's own page.
    if (url.pathname === '/api/sites' && method === 'GET') {
      return send(res, 200, { asking: ctx.sites?.list() ?? [], allowed: (await ctx.sites?.allowedList()) ?? [] })
    }
    if (url.pathname === '/api/sites' && method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'Only from the map' })
      const body = (await readBody(req)) as { origin?: unknown; allow?: unknown; remove?: unknown }
      const origin = typeof body.origin === 'string' ? body.origin : ''
      const done = body.remove === true ? await ctx.sites?.remove(origin) : await ctx.sites?.answer(origin, body.allow === true)
      if (!done) throw new NotFound(origin)
      return send(res, 200, { allowed: (await ctx.sites?.allowedList()) ?? [] })
    }
    // Where to open a screen: the proxy with the Comment button, or the address --app was given last time.
    if (url.pathname === '/api/runtime' && method === 'GET') {
      const remembered = await rememberedApp(ctx.gwDir, (await readProject(ctx.gwDir)).data.app)
      return send(res, 200, { app: ctx.runtime?.app ?? (typeof remembered === 'string' ? remembered : null), proxied: !!ctx.runtime?.app })
    }
    if (url.pathname === '/api/shots' && method === 'GET') {
      return send(res, 200, await listShots(ctx.gwDir))
    }
    // Put a picture on a screen, from the map: { file: "ios/App-2.jpg", screen: "p_home" }, or screen "" to take it off.
    if (url.pathname === '/api/shots/place' && method === 'POST') {
      const input = (await readBody(req)) as { file?: unknown; screen?: unknown }
      if (typeof input.file !== 'string' || typeof input.screen !== 'string') throw new BadInput('Say which picture and which screen')
      if (!(await listShots(ctx.gwDir)).some((s) => s.file === input.file)) throw new NotFound(input.file)
      if (!(await placeShot(ctx.gwDir, input.file, input.screen))) throw new NotFound(input.screen)
      return send(res, 200, await listScreens(ctx.gwDir))
    }
    // The documents that steer Claude in the product, with what the last check found in each; readable and editable from the map.
    if (url.pathname === '/api/docs' && method === 'GET') {
      return send(res, 200, await listDocs(ctx.gwDir, (await readReadiness(ctx.gwDir)).foundations))
    }
    if (url.pathname === '/api/docs/file' && method === 'GET') {
      return send(res, 200, await readDoc(ctx.gwDir, (await readReadiness(ctx.gwDir)).foundations, url.searchParams.get('path') ?? ''))
    }
    // Open a document in the person's own editor: grndwrk shows them, it does not write them.
    if (url.pathname === '/api/docs/open' && method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'Only from the map' })
      const b = (await readBody(req)) as { path?: unknown }
      const full = await docOnDisk(ctx.gwDir, (await readReadiness(ctx.gwDir)).foundations, typeof b.path === 'string' ? b.path : '')
      await openTarget(full)
      return send(res, 200, { opened: true })
    }
    if (url.pathname === '/api/stories' && method === 'GET') {
      return send(res, 200, await listStories(ctx.gwDir))
    }
    // A story written or changed in the map: from a thought, or its title, status, text or "Not now".
    if (url.pathname === '/api/stories' && method === 'POST') {
      const b = (await readBody(req)) as { title?: unknown; from?: unknown; body?: unknown }
      try {
        const story = await createStory(ctx.gwDir, {
          title: typeof b.title === 'string' ? b.title : '',
          from: Array.isArray(b.from) ? b.from.filter((x): x is string => typeof x === 'string') : [],
          ...(typeof b.body === 'string' ? { body: b.body.slice(0, 20_000) } : {}),
        })
        return send(res, 201, story)
      } catch (err) {
        if (err instanceof LinkRefused) throw err
        throw new BadInput(err instanceof Error ? err.message : String(err))
      }
    }
    const storyMatch = url.pathname.match(/^\/api\/stories\/(s_[A-Za-z0-9_-]{1,60})$/)
    if (storyMatch && method === 'PATCH') {
      const b = (await readBody(req)) as Record<string, unknown>
      const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
      let story
      try {
        story = await updateStory(ctx.gwDir, storyMatch[1], {
          title: text(b.title),
          status: text(b.status),
          body: typeof b.body === 'string' ? b.body.slice(0, 20_000) : undefined,
          later: b.later === null ? null : text(b.later),
        })
      } catch (err) {
        if (err instanceof LinkRefused) throw err
        throw new BadInput(err instanceof Error ? err.message : String(err))
      }
      if (!story) throw new NotFound(storyMatch[1])
      return send(res, 200, story)
    }
    if (url.pathname === '/api/screens' && method === 'GET') {
      return send(res, 200, await listScreens(ctx.gwDir))
    }
    const screenMatch = url.pathname.match(/^\/api\/screens\/([A-Za-z0-9_-]{1,64})$/)
    if (screenMatch && method === 'PATCH') {
      const screen = await updateScreen(ctx.gwDir, screenMatch[1], parseScreenEdit(await readBody(req)))
      if (!screen) throw new NotFound(screenMatch[1])
      return send(res, 200, screen)
    }
    if (url.pathname === '/api/personas' && method === 'GET') {
      return send(res, 200, await listPersonas(ctx.gwDir))
    }
    if (url.pathname === '/api/personas' && method === 'POST') {
      const b = (await readBody(req)) as { name?: unknown; summary?: unknown }
      try {
        const persona = await createPersona(ctx.gwDir, { name: typeof b.name === 'string' ? b.name : '', ...(typeof b.summary === 'string' ? { summary: b.summary.slice(0, 2_000) } : {}) })
        return send(res, 201, persona)
      } catch (err) {
        if (err instanceof LinkRefused) throw err
        throw new BadInput(err instanceof Error ? err.message : String(err))
      }
    }
    // A name on screens that is no persona: made one, merged into one, or taken off every screen.
    if (url.pathname === '/api/personas/settle' && method === 'POST') {
      const b = (await readBody(req)) as { name?: unknown; to?: unknown }
      const name = typeof b.name === 'string' ? b.name.trim().slice(0, 200) : ''
      const to = b.to === 'new' || b.to === 'remove' ? b.to : typeof b.to === 'string' && /^pe_[A-Za-z0-9_-]{1,60}$/.test(b.to) ? { persona: b.to } : null
      if (!name || !to) throw new BadInput('name and to (new, remove or a persona id) are needed')
      try {
        return send(res, 200, { persona: await settleAudienceName(ctx.gwDir, name, to) })
      } catch (err) {
        if (err instanceof LinkRefused) throw err
        throw new BadInput(err instanceof Error ? err.message : String(err))
      }
    }
    const personaMatch = url.pathname.match(/^\/api\/personas\/(pe_[A-Za-z0-9_-]{1,60})$/)
    if (personaMatch && method === 'PATCH') {
      const b = (await readBody(req)) as Record<string, unknown>
      const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)
      let persona
      try {
        const words = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 60) : undefined)
        persona = await updatePersona(ctx.gwDir, personaMatch[1], {
          name: text(b.name, 200),
          summary: text(b.summary, 2_000),
          ...Object.fromEntries(Object.keys(PERSONA_CHOICES).map((k) => [k, text(b[k], 60)])),
          ...Object.fromEntries(PERSONA_LISTS.map((k) => [k, words(b[k])])),
          ...(b.segments && typeof b.segments === 'object' && !Array.isArray(b.segments) ? { segments: segmentsInput(b.segments as Record<string, unknown>) } : {}),
          ...Object.fromEntries(PERSONA_SECTIONS.map((k) => [k, text(b[k], 20_000)])),
          ...(typeof b.confirmed === 'boolean' ? { confirmed: b.confirmed } : {}),
          body: text(b.body, 50_000),
        })
      } catch (err) {
        if (err instanceof LinkRefused) throw err
        throw new BadInput(err instanceof Error ? err.message : String(err))
      }
      if (!persona) throw new NotFound(personaMatch[1])
      return send(res, 200, persona)
    }
    if (personaMatch && method === 'DELETE') {
      if (!(await deletePersona(ctx.gwDir, personaMatch[1]))) throw new NotFound(personaMatch[1])
      res.writeHead(204).end()
      return true
    }
    if (url.pathname === '/api/segments' && method === 'GET') {
      return send(res, 200, await listSegments(ctx.gwDir))
    }
    if (url.pathname === '/api/segments' && method === 'POST') {
      const b = (await readBody(req)) as { name?: unknown }
      try {
        return send(res, 201, await createSegment(ctx.gwDir, { name: typeof b.name === 'string' ? b.name : '' }))
      } catch (err) {
        if (err instanceof LinkRefused) throw err
        throw new BadInput(err instanceof Error ? err.message : String(err))
      }
    }
    const segmentMatch = url.pathname.match(/^\/api\/segments\/(sg_[A-Za-z0-9_-]{1,60})$/)
    if (segmentMatch && method === 'PATCH') {
      const b = (await readBody(req)) as Record<string, unknown>
      const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
      let segment
      try {
        segment = await updateSegment(ctx.gwDir, segmentMatch[1], {
          name: text(b.name, 200),
          type: text(b.type, 60),
          industry: text(b.industry, 200),
          size_min: num(b.size_min),
          size_max: num(b.size_max),
          admins: Array.isArray(b.admins) ? b.admins.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 60) : undefined,
          body: text(b.body, 50_000),
        })
      } catch (err) {
        if (err instanceof LinkRefused) throw err
        throw new BadInput(err instanceof Error ? err.message : String(err))
      }
      if (!segment) throw new NotFound(segmentMatch[1])
      return send(res, 200, segment)
    }
    if (segmentMatch && method === 'DELETE') {
      if (!(await deleteSegment(ctx.gwDir, segmentMatch[1]))) throw new NotFound(segmentMatch[1])
      res.writeHead(204).end()
      return true
    }
    const draftMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)$/)
    if (draftMatch && method === 'GET') {
      return send(res, 200, { text: await readDraft(ctx.gwDir, decodeURIComponent(draftMatch[1])) })
    }
    const outputMatch = url.pathname.match(/^\/api\/outputs\/([^/]+)$/)
    if (outputMatch && method === 'GET') {
      const text = await readOutput(ctx.gwDir, decodeURIComponent(outputMatch[1]))
      return send(res, 200, { text })
    }
    if (url.pathname === '/api/readiness' && method === 'GET') {
      return send(res, 200, await readReadiness(ctx.gwDir))
    }
    const focusMatch = url.pathname.match(/^\/api\/focus\/([a-z0-9_]{1,40})$/)
    if (focusMatch && method === 'PATCH') {
      const input = (await readBody(req)) as { later?: unknown }
      if (typeof input.later !== 'boolean') throw new BadInput('later must be true or false')
      await setFocusLater(ctx.gwDir, focusMatch[1], input.later)
      return send(res, 200, await readReadiness(ctx.gwDir))
    }
    const gapMatch = url.pathname.match(/^\/api\/gaps\/([A-Za-z0-9_-]{1,64})$/)
    if (gapMatch && method === 'PATCH') {
      const input = (await readBody(req)) as { answered_by?: unknown; enough?: unknown }
      if (typeof input.answered_by !== 'string') throw new BadInput('answered_by must be a node id')
      await ctx.store.get(input.answered_by)
      if (!(await markAnswered(ctx.gwDir, gapMatch[1], input.answered_by, input.enough === true))) throw new NotFound(gapMatch[1])
      return send(res, 200, await readReadiness(ctx.gwDir))
    }
    if (url.pathname === '/api/project' && method === 'GET') {
      const { data, body, pages } = await readProject(ctx.gwDir)
      // folder: the project's folder name, shown when project.md has no name.
      return send(res, 200, { ...data, body, pages, folder: basename(dirname(ctx.gwDir)) })
    }
    if (url.pathname === '/api/project' && method === 'PATCH') {
      const input = (await readBody(req)) as { pages?: unknown; kickoff?: unknown; start?: unknown; purpose?: unknown; name?: unknown; initials?: unknown; color?: unknown }
      if (input.name !== undefined || input.initials !== undefined || input.color !== undefined) {
        // The project's badge on the rail: its name, up to three letters, and a color. Empty goes back to the default.
        const fields: Record<string, string> = {}
        const plain = (v: unknown, what: string, max: number) => {
          if (typeof v !== 'string') throw new BadInput(`${what} must be text`)
          return v.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max)
        }
        if (input.name !== undefined) fields.name = plain(input.name, 'name', 80)
        if (input.initials !== undefined) fields.initials = [...plain(input.initials, 'initials', 12).replace(/\s/g, '')].slice(0, 3).join('')
        if (input.color !== undefined) {
          const color = plain(input.color, 'color', 7).toLowerCase()
          if (color && !/^#[0-9a-f]{6}$/.test(color)) throw new BadInput('color must look like #3b82f6')
          fields.color = color
        }
        await writeFields(ctx.gwDir, fields)
      } else if (input.start !== undefined || input.purpose !== undefined) {
        const fields: Record<string, string> = {}
        if (input.start !== undefined) {
          if (input.start !== 'new' && input.start !== 'existing') throw new BadInput('start must be new or existing')
          fields.start = input.start
        }
        if (input.purpose !== undefined) {
          if (typeof input.purpose !== 'string') throw new BadInput('purpose must be text')
          fields.purpose = input.purpose.trim().replace(/\s*\n\s*/g, ' ').slice(0, 500)
        }
        await writeFields(ctx.gwDir, fields)
      } else if (input.kickoff !== undefined) {
        const k = input.kickoff
        if (!k || typeof k !== 'object' || Array.isArray(k)) throw new BadInput('kickoff must map steps to a date or null')
        const changes: Record<string, string | null> = {}
        for (const [step, date] of Object.entries(k)) {
          if (!(KICKOFF_STEPS as readonly string[]).includes(step)) throw new BadInput(`Unknown kickoff step: ${step}`)
          if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new BadInput('A kickoff date must look like 2026-10-08')
          changes[step] = date
        }
        await writeKickoff(ctx.gwDir, changes)
      } else {
        if (!Array.isArray(input.pages) || !input.pages.every((p) => typeof p === 'string')) {
          throw new BadInput('pages must be a list of names')
        }
        await writePages(ctx.gwDir, input.pages)
      }
      const { data, body, pages } = await readProject(ctx.gwDir)
      // folder: the project's folder name, shown when project.md has no name.
      return send(res, 200, { ...data, body, pages, folder: basename(dirname(ctx.gwDir)) })
    }
    if (url.pathname === '/api/nodes' && method === 'GET') {
      return send(res, 200, await ctx.store.list())
    }
    if (url.pathname === '/api/nodes' && method === 'POST') {
      const change = await ctx.store.create(await readBody(req))
      await ctx.nodes.sync()
      return send(res, 201, change.upserted[0])
    }
    if (nodeMatch && method === 'PATCH') {
      const change = await ctx.store.update(decodeURIComponent(nodeMatch[1]), await readBody(req))
      await ctx.nodes.sync()
      return send(res, 200, change.upserted[0])
    }
    if (nodeMatch && method === 'DELETE') {
      const id = decodeURIComponent(nodeMatch[1])
      await ctx.store.delete(id)
      await removeFiles(ctx.gwDir, id)
      await ctx.nodes.sync()
      res.writeHead(204).end()
      return true
    }
    return send(res, 404, { error: 'Not found' })
  } catch (err) {
    // Say in the terminal why a write failed, so problems can be traced.
    if (method !== 'GET') console.error(`${method} ${url.pathname} failed: ${err instanceof Error ? err.message : err}`)
    if (err instanceof BadInput) return send(res, 400, { error: err.message })
    if (err instanceof NotFound) return send(res, 404, { error: `No node ${err.message}` })
    if (err instanceof ReadOnly) return send(res, 409, { error: err.message })
    if (err instanceof LinkRefused) return send(res, 409, { error: err.message })
    console.error(err)
    return send(res, 500, { error: 'Something went wrong' })
  }
}

/**
 * Requiring a JSON content type means a page on another site cannot write
 * here with a plain form post; the browser would have to ask first, and we never answer yes.
 */
function isJson(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').startsWith('application/json')
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<NodeInput> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new BadInput('Body too large')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error()
    if (body.links !== undefined && !Array.isArray(body.links)) throw new BadInput('links must be a list')
    return body
  } catch (err) {
    if (err instanceof BadInput) throw err
    throw new BadInput('Invalid JSON')
  }
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new BadInput('Images can be at most 10 MB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Serve /files/<node id>/<name> and /shots/<platform>/<name>, and nothing else from disk. */
export async function handleFiles(req: IncomingMessage, res: ServerResponse, gwDir: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const shot = url.pathname.match(/^\/shots\/(web|ios)\/([^/]+)$/)
  if (shot && req.method === 'GET') {
    const found = await readShot(gwDir, shot[1], decodeURIComponent(shot[2]))
    if (!found) res.writeHead(404).end()
    else res.writeHead(200, { 'Content-Type': found.type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }).end(found.data)
    return true
  }
  const m = url.pathname.match(/^\/files\/([^/]+)\/([^/]+)$/)
  if (!m || req.method !== 'GET') return false
  const image = await readImage(gwDir, decodeURIComponent(m[1]), decodeURIComponent(m[2]))
  if (!image) {
    res.writeHead(404).end()
    return true
  }
  res.writeHead(200, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }).end(image.data)
  return true
}

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  return true
}

/** Only the words and the notes can change from the map. Ids, links and code paths belong to /sitemap. */
function parseScreenEdit(input: unknown): ScreenEdit {
  const o = (input ?? {}) as Record<string, unknown>
  const out: ScreenEdit = {}
  const words = (v: unknown, name: string) => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new BadInput(`${name} must be a list of text`)
    return v.map((x: string) => x.trim()).filter(Boolean).slice(0, 50)
  }
  if (o.purpose !== undefined) {
    if (typeof o.purpose !== 'string') throw new BadInput('purpose must be text')
    out.purpose = o.purpose.trim().replace(/\s*\n\s*/g, ' ')
  }
  if (o.audience !== undefined) out.audience = words(o.audience, 'audience')
  if (o.tasks !== undefined) out.tasks = words(o.tasks, 'tasks')
  if (o.body !== undefined) {
    if (typeof o.body !== 'string') throw new BadInput('body must be text')
    out.body = o.body
  }
  if (o.features !== undefined) out.features = [...new Set(words(o.features, 'features'))]
  if (o.hidden !== undefined) {
    if (typeof o.hidden !== 'boolean') throw new BadInput('hidden must be true or false')
    out.hidden = o.hidden ? today() : ''
  }
  return out
}

/** A persona's `segments` as the map sends them: per segment id, how common and the titles. */
function segmentsInput(o: Record<string, unknown>): Record<string, PersonaInSegment> {
  const out: Record<string, PersonaInSegment> = {}
  for (const [id, v] of Object.entries(o).slice(0, 100)) {
    if (!/^sg_[A-Za-z0-9_-]{1,60}$/.test(id) || !v || typeof v !== 'object') continue
    const x = v as Record<string, unknown>
    out[id] = {
      how: typeof x.how === 'string' ? x.how.slice(0, 20) : '',
      titles: Array.isArray(x.titles) ? x.titles.filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 120)).slice(0, 30) : [],
    }
  }
  return out
}
