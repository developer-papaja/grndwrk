// grndwrk straight to the team's store, for a staging site. The store serves
// this in front of the Comment button (feedback.js), with its config, to the
// staging site the team named (docs/store-protocol.md, Comments straight to
// the store). A browser here does what a phone joined to the store does
// (clients/ios/.../Store.swift): the person pastes a store link once, and
// comments go into the store's inbox, where any teammate's grndwrk files them.
//
// The link holds a comment token. It is kept in this site's localStorage, so
// a script on the staging page can read it while the page is open, as it
// could anything on the page. A comment token can only leave comments and
// read what became of them: never the map.
;(() => {
  const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)))
  const COMMENTER = /^[A-Za-z0-9_-]{8,64}$/
  const TOKEN = /^[A-Za-z0-9._~+/=-]{8,4096}$/

  /** `grndwrk:store/<host><path>#<token>`: the store's address for the project without https, and the token after #. */
  function parseLink(link) {
    const m = /^grndwrk:store\/([a-z0-9.-]+(?::\d{1,5})?)(\/[A-Za-z0-9._~%/-]*)#(.+)$/.exec(String(link).trim())
    if (!m || !TOKEN.test(m[3])) return null
    return { where: `${m[1]}${m[2].replace(/\/?$/, '/')}`, token: m[3] }
  }

  /**
   * `config` is { url, site } from the store: the project's address and the
   * staging site. `keep` holds this browser's link ({ get, put, remove });
   * `send` is fetch.
   */
  function grndwrkStore(config, keep, send) {
    const base = String(config.url).replace(/\/?$/, '/')
    const name = `grndwrk.store:${base}`
    let joined = null
    // The store refused the token (logged out, or taken back): a new link is asked for.
    let refused = false

    function load() {
      if (!joined) {
        try {
          const v = JSON.parse(keep.get(name) || 'null')
          joined = v && TOKEN.test(v.token) && COMMENTER.test(v.commenter) ? v : null
        } catch {
          joined = null
        }
      }
      return joined
    }
    const call = (method, path, token, body, headers = {}) =>
      send(`${base}v1/${path}`, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers } })

    /** Who this token is: a comment token, and the commenter its comments go under. */
    async function hello(token) {
      const res = await call('GET', 'hello', token)
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('The store did not take this link. Log in to the store again for a new one.'), { refused: true })
      if (!res.ok) throw new Error(`The store did not answer (${res.status}). Try again.`)
      const b = await res.json()
      if (b.role !== 'comment') throw Object.assign(new Error('This link may do more than leave comments. Ask for a comment link: it never belongs in a web page.'), { refused: true })
      if (!COMMENTER.test(b.commenter || '')) throw new Error('The store does not say who you are (no commenter in hello). Ask whoever runs it to update it.')
      return b.commenter
    }

    async function join(link) {
      const l = parseLink(link)
      if (!l) throw new Error('That is not a store link. It looks like grndwrk:store/… : log in to your team\'s store for one.')
      if (l.where !== base.replace(/^https?:\/\//, '')) throw new Error('This link is for another project or store.')
      let commenter
      try {
        commenter = await hello(l.token)
      } catch (err) {
        throw err instanceof TypeError ? new Error('The store could not be reached from this page. Try again, or ask whether it allows this site.') : err
      }
      joined = { token: l.token, commenter, joined: new Date().toISOString() }
      refused = false
      keep.put(name, JSON.stringify(joined))
      return ''
    }

    /** One file in this browser's own inbox folder, never overwriting one there. */
    async function drop(id, body) {
      const j = load()
      if (!j || refused) return 'join'
      try {
        const res = await call('PUT', `files/inbox/${j.commenter}/${id}.json`, j.token, JSON.stringify(body), { 'Content-Type': 'application/json', 'If-None-Match': '*' })
        // 412: it is there already, from an earlier try that got no answer.
        if (res.status === 201 || res.status === 200 || res.status === 412) return 'sent'
        if (res.status === 401 || res.status === 403) {
          refused = true
          return 'asked'
        }
        return res.status === 400 || res.status === 413 || res.status === 415 ? 'rejected' : 'waiting'
      } catch {
        return 'waiting'
      }
    }
    let lastStatus = []

    return {
      site: config.site,
      store: true,
      /**
       * This browser's own comments as the team's grndwrk last wrote them:
       * each with its key, state, and for a fix ready to test, what changed,
       * the steps, the round and where it was made.
       */
      async status() {
        const j = load()
        if (!j || refused) return []
        try {
          const res = await call('GET', `files/status/${j.commenter}.json`, j.token)
          if (res.status === 401 || res.status === 403) refused = true
          if (res.status === 404) lastStatus = []
          if (res.status !== 200) return lastStatus
          const said = await res.json()
          if (said && Array.isArray(said.comments)) lastStatus = said.comments
        } catch {}
        return lastStatus
      },
      /** Tested: works or not, with a note, for the round it was given. */
      tested(c, works, note) {
        return drop(`r_${randomHex(16)}`, { path: '/api/feedback/tested', body: { comments: [{ id: c.id, key: c.key, round: c.round }], works, note: works ? '' : note, platform: 'Web' }, at: Date.now() })
      },
      shotUrl: `${base}screenshot.js`,
      async joined() {
        return !!load() && !refused
      },
      /** A link is kept, whether or not the store still takes it. */
      async hasLink() {
        return !!load()
      },
      async digits() {
        return ''
      },
      join,
      async leave() {
        joined = null
        refused = false
        keep.remove(name)
      },
      /** Whether the store takes this browser's link. */
      async allowed() {
        const j = load()
        if (!j) return false
        try {
          await hello(j.token)
          refused = false
          return true
        } catch (err) {
          if (err.refused) refused = true
          return false
        }
      },
      /** 'sent', 'join' (no link yet), 'asked' (the store refused the link), 'waiting' (try later) or 'rejected'. */
      async post(comment) {
        // Each comment carries a key of its own, as on the phone, so its status can be asked for later; its file in the inbox is named after it, so a retry never makes two.
        const key = comment.key || randomHex(16)
        return drop(`c_${key}`, { ...comment, key })
      },
    }
  }

  // Blocked storage (a private window, site data refused) keeps the link for this page only.
  const kept = new Map()
  const localKeep = {
    get: (k) => { try { return localStorage.getItem(k) } catch { return kept.get(k) ?? null } },
    put: (k, v) => { kept.set(k, v); try { localStorage.setItem(k, v) } catch {} },
    remove: (k) => { kept.delete(k); try { localStorage.removeItem(k) } catch {} },
  }

  globalThis.__grndwrkStoreFactory = grndwrkStore
  const config = typeof window !== 'undefined' ? window.__grndwrkStoreConfig : undefined
  if (config) window.__grndwrkStore = grndwrkStore(config, localKeep, (u, o) => fetch(u, { ...o, credentials: 'omit', cache: 'no-store', redirect: 'error' }))
})()
