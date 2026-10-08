// Groundwork comment overlay. Added to each page by `groundwork --app`.
// Press Comment (or Alt+C), point at anything, click it, and write a line.
// The comment lands in the Groundwork map, on the Feedback page.
;(() => {
  if (window.__groundworkFeedback) return
  window.__groundworkFeedback = true

  const host = document.createElement('groundwork-feedback')
  // all: initial keeps the page's styles out; font and color are set again after it.
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font: 13px/1.4 Inter, system-ui, -apple-system, sans-serif; color: #e8e6e3;'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      .pill { position: fixed; right: 16px; bottom: 16px; pointer-events: auto; display: flex; align-items: center; gap: 6px;
        padding: 8px 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,.12); background: #2c2c2c; color: #e8e6e3;
        font: inherit; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
      .pill:hover { background: #383838; }
      .pill.on { background: #0d99ff; border-color: #0d99ff; color: #fff; }
      .pill svg { width: 16px; height: 16px; }
      .box { position: fixed; pointer-events: none; border: 2px solid #0d99ff; background: rgba(13,153,255,.08); border-radius: 4px; display: none; }
      .tip { position: fixed; pointer-events: none; padding: 3px 6px; border-radius: 4px; background: #0d99ff; color: #fff; font-size: 11px; display: none; white-space: nowrap; }
      .hint { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); padding: 6px 12px; border-radius: 8px; background: #2c2c2c;
        border: 1px solid rgba(255,255,255,.12); display: none; }
      .card { position: fixed; width: 300px; pointer-events: auto; padding: 12px; border-radius: 10px; background: #2c2c2c;
        border: 1px solid rgba(255,255,255,.12); box-shadow: 0 8px 24px rgba(0,0,0,.35); display: none; }
      .card .on-what { font-size: 11px; color: rgba(232,230,227,.55); margin-bottom: 6px; }
      textarea { width: 100%; min-height: 64px; resize: none; padding: 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,.12);
        background: #1e1e1e; color: inherit; font: inherit; outline: none; }
      textarea:focus { border-color: #0d99ff; }
      .row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
      button.b { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; border: 0; cursor: pointer; background: transparent; color: rgba(232,230,227,.7); }
      button.b:hover { background: rgba(255,255,255,.08); color: #e8e6e3; }
      button.send { background: #0d99ff; color: #fff; }
      button.send:hover { background: #2aa5ff; }
      button.send:disabled { opacity: .4; cursor: default; }
      .save { position: fixed; right: 16px; bottom: 60px; pointer-events: auto; font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 999px;
        border: 1px solid rgba(255,255,255,.12); background: #2c2c2c; color: rgba(232,230,227,.8); cursor: pointer; display: none; }
      .save:hover { color: #e8e6e3; background: #383838; }
      .toast { position: fixed; right: 16px; bottom: 64px; padding: 6px 12px; border-radius: 8px; background: #2c2c2c; border: 1px solid rgba(255,255,255,.12); display: none; }
    </style>
    <div class="box"></div><div class="tip"></div>
    <div class="hint">Click what you want to comment on. Esc to stop.</div>
    <div class="card">
      <div class="on-what"></div>
      <textarea placeholder="What should change? Enter sends"></textarea>
      <div class="row"><button class="b cancel">Cancel</button><button class="b send">Send to Groundwork</button></div>
    </div>
    <div class="toast"></div>
    <button class="save" title="Save the waiting comments as a file to send to whoever runs Groundwork">Save as file</button>
    <button class="pill" title="Comment on this page (Alt+C)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>
      <span>Comment</span>
    </button>`
  const $ = (s) => root.querySelector(s)
  const pill = $('.pill'), box = $('.box'), tip = $('.tip'), hint = $('.hint'), card = $('.card'), field = $('textarea'), toast = $('.toast')
  const sendBtn = $('.send'), saveBtn = $('.save'), pillLabel = $('.pill span')

  // Comments that could not be sent wait in this browser, and go once Groundwork answers.
  const OUTBOX = 'groundwork.outbox'
  const outbox = {
    read() {
      try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]') } catch { return [] }
    },
    write(list) {
      try { localStorage.setItem(OUTBOX, JSON.stringify(list)) } catch {}
      pillLabel.textContent = list.length ? `Comment · ${list.length}` : 'Comment'
      saveBtn.style.display = list.length ? 'block' : 'none'
    },
  }
  /** 'sent', 'rejected' (do not retry), or 'waiting' (try again later). */
  async function post(comment) {
    try {
      const res = await fetch('/__groundwork/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(comment) })
      if (res.status === 201) return 'sent'
      return res.status === 404 || res.status >= 500 ? 'waiting' : 'rejected'
    } catch {
      return 'waiting'
    }
  }
  async function flush() {
    let list = outbox.read()
    while (list.length) {
      const result = await post(list[0])
      if (result === 'waiting') break
      list = list.slice(1)
      outbox.write(list)
    }
  }
  outbox.write(outbox.read())
  flush()
  setInterval(() => outbox.read().length && flush(), 20000)

  let picking = false
  let picked = null

  const mount = () => (document.body || document.documentElement).appendChild(host)
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount)

  // What a person would call an element, and what kind it is.
  const ROLES = { a: 'link', button: 'button', img: 'image', select: 'menu', textarea: 'text field', h1: 'heading', h2: 'heading', h3: 'heading', nav: 'navigation', li: 'list item' }
  function roleOf(el) {
    const r = el.getAttribute('role')
    if (r) return r
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') return ['button', 'submit', 'checkbox', 'radio'].includes(el.type) ? el.type : 'text field'
    return ROLES[tag] || tag
  }
  function labelOf(el) {
    const by = el.getAttribute('aria-labelledby')
    const labelled = by && document.getElementById(by)?.textContent
    const text = el.getAttribute('aria-label') || labelled || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.value || ''
    return String(text).replace(/\s+/g, ' ').trim().slice(0, 80)
  }
  function idOf(el) {
    return el.getAttribute('data-testid') || el.getAttribute('data-test') || el.id || ''
  }
  /** The nearest named component, for React and Vue. */
  function componentOf(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const fiberKey = Object.keys(n).find((k) => k.startsWith('__reactFiber$'))
      if (fiberKey) {
        for (let f = n[fiberKey]; f; f = f.return) {
          const t = f.type
          const name = t && typeof t !== 'string' && (t.displayName || t.name)
          if (name && /^[A-Z]/.test(name)) return name
        }
      }
      const vue = n.__vueParentComponent
      if (vue) {
        const t = vue.type
        const name = t && (t.name || t.__name)
        if (name) return name
      }
    }
    return ''
  }
  function selectorOf(el) {
    const parts = []
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      if (n.id) {
        parts.unshift(`#${CSS.escape(n.id)}`)
        break
      }
      let part = n.tagName.toLowerCase()
      const cls = [...n.classList].filter((c) => !/^(css|sc|jsx|svelte)-/.test(c)).slice(0, 2)
      if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.')
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : []
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`
      parts.unshift(part)
    }
    return parts.join(' > ')
  }
  // Prefer the element a person means: a button over the icon inside it.
  function meaningful(el) {
    const hit = el.closest('a, button, input, select, textarea, label, [role], img, h1, h2, h3, li, [data-testid]')
    return hit || el
  }

  function place(el) {
    const r = el.getBoundingClientRect()
    Object.assign(box.style, { display: 'block', left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` })
    const name = labelOf(el)
    tip.textContent = roleOf(el) + (name ? ` "${name.slice(0, 40)}"` : '')
    Object.assign(tip.style, { display: 'block', left: `${Math.max(4, r.left)}px`, top: `${r.top > 24 ? r.top - 22 : r.bottom + 4}px` })
  }

  function setPicking(on) {
    picking = on
    pill.classList.toggle('on', on)
    hint.style.display = on ? 'block' : 'none'
    document.documentElement.style.cursor = on ? 'crosshair' : ''
    if (!on) {
      box.style.display = 'none'
      tip.style.display = 'none'
    }
  }
  function closeCard() {
    card.style.display = 'none'
    box.style.display = 'none'
    tip.style.display = 'none'
    picked = null
    field.value = ''
  }

  function openCard(el) {
    picked = el
    setPicking(false)
    place(el)
    const r = el.getBoundingClientRect()
    const name = labelOf(el)
    $('.on-what').textContent = `On the ${roleOf(el)}${name ? ` "${name.slice(0, 50)}"` : ''}`
    const left = Math.min(window.innerWidth - 312, Math.max(12, r.left))
    const below = r.bottom + 170 < window.innerHeight
    Object.assign(card.style, { display: 'block', left: `${left}px`, top: below ? `${r.bottom + 8}px` : `${Math.max(12, r.top - 168)}px` })
    field.focus()
  }

  async function send() {
    const text = field.value.trim()
    if (!text || !picked) return
    const el = picked
    const comment = {
      text,
      platform: 'Web',
      screen: location.pathname,
      url: location.href,
      written: new Date().toISOString(),
      element: { label: labelOf(el), id: idOf(el), role: roleOf(el), component: componentOf(el), selector: selectorOf(el) },
    }
    sendBtn.disabled = true
    const result = await post(comment)
    sendBtn.disabled = false
    closeCard()
    if (result === 'sent') {
      flash('Sent to Groundwork')
      flush()
    } else if (result === 'waiting') {
      const list = [...outbox.read(), comment]
      outbox.write(list)
      flash(`Saved. It goes to Groundwork when it is running (${list.length} waiting)`)
    } else {
      flash('Groundwork did not take it')
    }
  }

  /** One file with every waiting comment, for `groundwork import-feedback <file>`. */
  function saveFile() {
    const list = outbox.read()
    if (!list.length) return
    const blob = new Blob([JSON.stringify({ groundwork: 'feedback', comments: list }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `groundwork-feedback-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    // Saved to a file: it travels that way now, so it no longer waits here.
    outbox.write([])
    flash('Saved. Send the file to whoever runs Groundwork.')
  }
  function flash(text) {
    toast.textContent = text
    toast.style.display = 'block'
    clearTimeout(flash.t)
    flash.t = setTimeout(() => (toast.style.display = 'none'), 2500)
  }

  const ours = (e) => e.composedPath().includes(host)
  // While picking, the page underneath gets no clicks: the click picks.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    window.addEventListener(
      type,
      (e) => {
        if (!picking || ours(e)) return
        e.preventDefault()
        e.stopImmediatePropagation()
        if (type === 'click') openCard(meaningful(e.target))
      },
      true,
    )
  }
  window.addEventListener(
    'mousemove',
    (e) => {
      if (picking && !ours(e)) place(meaningful(e.target))
    },
    true,
  )
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && (e.key === 'c' || e.code === 'KeyC')) {
        e.preventDefault()
        closeCard()
        setPicking(!picking)
      } else if (e.key === 'Escape' && (picking || picked)) {
        e.preventDefault()
        setPicking(false)
        closeCard()
      }
    },
    true,
  )
  window.addEventListener('scroll', () => picked && place(picked), true)

  pill.addEventListener('click', () => {
    closeCard()
    setPicking(!picking)
  })
  $('.cancel').addEventListener('click', closeCard)
  saveBtn.addEventListener('click', saveFile)
  sendBtn.addEventListener('click', send)
  field.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') closeCard()
  })
})()
