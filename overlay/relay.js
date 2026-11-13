// grndwrk through the team's relay, for a staging site. The relay serves this
// in front of the Comment button (feedback.js), with its config, to the one
// site the team named. A browser here does what a colleague's phone does
// (clients/ios/.../Relay.swift, src/relay/keys.ts): it joins once with an
// invite, waits until someone allows it in the map with four digits it shows,
// and leaves its comments sealed at the relay. Nothing reaches anyone's Mac
// directly, and the relay cannot read what it holds.
//
// The keys are kept in this site's IndexedDB as WebCrypto keys that cannot be
// read back out: a script on the page could use them while it runs, as it
// could anything on the page, but cannot take them away.
;(() => {
  const enc = new TextEncoder()
  const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const fromHex = (text) => Uint8Array.from(text.match(/../g) || [], (h) => parseInt(h, 16))
  const sha256Hex = async (text) => hex(await crypto.subtle.digest('SHA-256', typeof text === 'string' ? enc.encode(text) : text))
  const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)))
  /** An HMAC keyed by a key's text, as everywhere in grndwrk's relay. */
  const hmacKey = (text) => crypto.subtle.importKey('raw', enc.encode(text), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const hmacHex = async (key, message) => hex(await crypto.subtle.sign('HMAC', typeof key === 'string' ? await hmacKey(key) : key, enc.encode(message)))
  const aesKey = (hexKey) => crypto.subtle.importKey('raw', fromHex(hexKey), 'AES-GCM', false, ['encrypt', 'decrypt'])
  /** AES-256-GCM: 12 random bytes, the ciphertext and its tag, with the place bound in. */
  async function seal(key, context, plain) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, key, plain))
    const out = new Uint8Array(12 + ct.length)
    out.set(iv)
    out.set(ct, 12)
    return out
  }
  /** The plain bytes, or null when it was changed, is for another place, or another key sealed it. */
  async function open(key, context, sealed) {
    if (sealed.length < 28) return null
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12), additionalData: enc.encode(context) }, key, sealed.slice(12)))
    } catch {
      return null
    }
  }
  /** The four digits the map shows next to the colleague's name, worked out from the key as on the phone. */
  const joinDigits = async (key) => String(parseInt((await sha256Hex(`grndwrk-join:${key}`)).slice(0, 8), 16) % 10000).padStart(4, '0')

  /**
   * `config` is { url, mailbox, site } from the relay; `keep` stores this
   * browser's keys ({ get, put, remove }); `send` is fetch.
   */
  function grndwrkRelay(config, keep, send) {
    const base = `${config.url}/v1/${config.mailbox}`
    let joined = null

    async function load() {
      if (!joined) joined = (await keep.get(config.mailbox).catch(() => null)) || null
      return joined
    }

    /** Join with an invite link: a new key of this browser's own, sealed with the invite's secret. Returns the digits to tell whoever invited you. */
    async function join(link) {
      const m = /^grndwrk:invite\/([a-z0-9.-]+(?::\d{1,5})?)\/([a-f0-9]{32})\/([a-f0-9]{64})$/.exec(String(link).trim())
      if (!m) throw new Error('That is not an invite. It looks like grndwrk:invite/… : ask whoever runs grndwrk for one.')
      if (m[1] !== new URL(config.url).host || m[2] !== config.mailbox) throw new Error('This invite is for another project or relay.')
      const secret = m[3]
      const key = randomHex(32)
      const invite = (await sha256Hex(`grndwrk-invite:${secret}`)).slice(0, 32)
      const body = await seal(await aesKey(secret), `join:${invite}`, enc.encode(JSON.stringify({ key })))
      const res = await send(`${base}/join/${invite}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body })
      if (res.status === 409) throw new Error('This invite has been used. Ask for a new one.')
      if (res.status === 404) throw new Error('This invite has expired or was taken back. Ask for a new one.')
      if (res.status !== 202) throw new Error(`The relay did not take it (${res.status}). Try again.`)
      // Only what is needed from here on, as keys this page cannot read back. The key itself is not kept.
      const signText = await hmacHex(key, 'grndwrk-relay:sign')
      const sealText = await hmacHex(key, 'grndwrk-relay:seal')
      joined = {
        device: (await sha256Hex(`grndwrk-device:${signText}`)).slice(0, 32),
        sign: await hmacKey(signText),
        seal: await aesKey(sealText),
        digits: await joinDigits(key),
        joined: new Date().toISOString(),
      }
      await keep.put(config.mailbox, joined)
      return joined.digits
    }

    /** A request signed as the phone signs it: the method, the path, the time, a nonce and a hash of the body. */
    async function signed(method, rest, body = new Uint8Array(0)) {
      const j = await load()
      const path = `/v1/${config.mailbox}${rest}`
      const time = String(Date.now())
      const nonce = randomHex(16)
      const signature = await hmacHex(j.sign, `grndwrk-request\n${method}\n${path}\n${time}\n${nonce}\n${await sha256Hex(body)}`)
      return send(config.url + path, {
        method,
        body: method === 'GET' ? undefined : body,
        headers: {
          ...(method === 'GET' ? {} : { 'content-type': 'application/octet-stream' }),
          'x-grndwrk-device': j.device,
          'x-grndwrk-time': time,
          'x-grndwrk-nonce': nonce,
          'x-grndwrk-signature': signature,
        },
      })
    }

    /** Leave a sealed request at the relay, as the phone does. */
    async function leave(path, body) {
      const j = await load()
      if (!j) return 'join'
      const envelope = { path, body, id: randomHex(16), at: Date.now() }
      try {
        const sealed = await seal(j.seal, `inbox:${j.device}`, enc.encode(JSON.stringify(envelope)))
        const res = await signed('POST', '/inbox', sealed)
        if (res.status === 202) return 'sent'
        if (res.status === 401) return 'asked'
        return res.status === 413 || res.status === 400 ? 'rejected' : 'waiting'
      } catch {
        return 'waiting'
      }
    }
    // The newest status read: an older one handed over again is ignored, as on the phone.
    let lastStatus = { at: 0, comments: [] }

    return {
      site: config.site,
      /**
       * This browser's own comments as the team's grndwrk last told it, sealed
       * for it at the relay: each with its key, state, and for a fix ready to
       * test, what changed, the steps, the round and where it was made.
       */
      async status() {
        const j = await load()
        if (!j) return []
        try {
          const res = await signed('GET', '/outbox')
          if (res.status !== 200) return lastStatus.comments
          const plain = await open(j.seal, `outbox:${j.device}`, new Uint8Array(await res.arrayBuffer()))
          const said = plain ? JSON.parse(new TextDecoder().decode(plain)) : null
          if (said && Array.isArray(said.comments) && Number(said.at) >= lastStatus.at) lastStatus = { at: Number(said.at), comments: said.comments }
        } catch {}
        return lastStatus.comments
      },
      /** Tested: works or not, with a note, for the round it was given. */
      tested(c, works, note) {
        return leave('/api/feedback/tested', { comments: [{ id: c.id, key: c.key, round: c.round }], works, note: works ? '' : note, platform: 'Web' })
      },
      /** Open it in the map on the team's Macs. */
      show(c) {
        return leave('/api/feedback/show', { comments: [{ id: c.id, key: c.key }] })
      },
      shotUrl: `${base}/screenshot.js`,
      async joined() {
        return !!(await load())
      },
      async digits() {
        return (await load())?.digits || ''
      },
      join,
      async leave() {
        joined = null
        await keep.remove(config.mailbox)
      },
      /** Whether someone allowed this browser in the map yet: the relay answers its own requests only then. */
      async allowed() {
        if (!(await load())) return false
        try {
          const res = await signed('GET', '/outbox')
          return res.status === 200 || res.status === 204
        } catch {
          return false
        }
      },
      /** 'sent', 'join' (no invite yet), 'asked' (waiting to be allowed), 'waiting' (try later) or 'rejected'. */
      async post(comment) {
        // Each comment carries a key of its own, as on the phone, so its status can be asked for later.
        return leave('/api/feedback', { ...comment, key: comment.key || randomHex(16) })
      },
    }
  }

  /** This browser's keys, in IndexedDB on the staging site. */
  const indexedKeep = {
    db() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('grndwrk', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('relay')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    },
    async run(mode, act) {
      const db = await this.db()
      return new Promise((resolve, reject) => {
        const req = act(db.transaction('relay', mode).objectStore('relay'))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    },
    get(k) { return this.run('readonly', (s) => s.get(k)) },
    put(k, v) { return this.run('readwrite', (s) => s.put(v, k)) },
    remove(k) { return this.run('readwrite', (s) => s.delete(k)) },
  }

  globalThis.__grndwrkRelayFactory = grndwrkRelay
  const config = typeof window !== 'undefined' ? window.__grndwrkRelayConfig : undefined
  if (config && typeof indexedDB !== 'undefined') window.__grndwrkRelay = grndwrkRelay(config, indexedKeep, (u, o) => fetch(u, { ...o, credentials: 'omit', cache: 'no-store' }))
})()
