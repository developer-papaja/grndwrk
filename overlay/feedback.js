// Groundwork comment overlay. Added to each page by `groundwork --app`.
// Press Comment (or Alt+C), point at anything, click it, and write a line.
// The comment lands in the Groundwork map, on the Feedback page.
;(() => {
  if (window.__groundworkFeedback) return
  // A tool for your own machine: localhost, or a local development name like
  // shop.test (Herd, Valet) or shop.localhost. On any other address it does
  // nothing and says why, so it never reaches the people using the product.
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$|\.(test|localhost)$/.test(location.hostname)) {
    console.warn('Groundwork comments only run on this machine (localhost, *.test, *.localhost). Remove this script from the page.')
    return
  }
  // Comments go back to the Groundwork the script came from: the proxy, or the
  // map's server when the product's own layout loads it.
  const base = document.currentScript && document.currentScript.src ? new URL(document.currentScript.src).origin : location.origin
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
      .pill.dragging { cursor: grabbing; opacity: .9; }
      .dock-target { position: fixed; left: 0; right: 0; bottom: 0; height: 36px; background: rgba(13,153,255,.25); border-top: 2px dashed #0d99ff; display: none; pointer-events: none; }
      .bar { position: fixed; left: 0; right: 0; bottom: 0; height: 36px; pointer-events: auto; display: none; align-items: center; gap: 4px; padding: 0 6px 0 12px;
        background: #2c2c2c; border-top: 1px solid rgba(255,255,255,.12); box-shadow: 0 -4px 14px rgba(0,0,0,.2); }
      .bar .name { font-weight: 600; margin-right: 8px; display: flex; align-items: center; gap: 6px; }
      .bar .dot { width: 7px; height: 7px; border-radius: 50%; background: #3ecf8e; }
      .bar button { font: inherit; font-size: 12px; height: 26px; padding: 0 10px; border-radius: 6px; border: 0; cursor: pointer; background: transparent; color: rgba(232,230,227,.8); display: flex; align-items: center; gap: 5px; }
      .bar button:hover { background: rgba(255,255,255,.08); color: #e8e6e3; }
      .bar button.go { background: #0d99ff; color: #fff; }
      .bar button.go.on { background: #2aa5ff; }
      .bar .grow { flex: 1; }
      .bar svg, .tab svg { width: 14px; height: 14px; }
      .tab { position: fixed; left: 0; bottom: 0; height: 26px; padding: 0 10px; pointer-events: auto; display: none; align-items: center; gap: 5px; border: 0;
        border-top-right-radius: 8px; background: #2c2c2c; color: #e8e6e3; font: inherit; font-size: 12px; cursor: pointer; box-shadow: 0 -2px 8px rgba(0,0,0,.2); }
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
      .h { position: fixed; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: #fff; border: 2.5px solid #0d99ff;
        box-shadow: 0 1px 3px rgba(0,0,0,.3); pointer-events: auto; display: none; }
      .h.tl, .h.br { cursor: nwse-resize; } .h.tr, .h.bl { cursor: nesw-resize; }
      .box.edit { pointer-events: auto; cursor: move; }
      .steps { display: flex; gap: 4px; margin: 0 0 8px; }
      .steps button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; font: inherit; font-size: 12px; padding: 6px 8px;
        border-radius: 6px; border: 1px solid rgba(255,255,255,.12); background: transparent; color: rgba(232,230,227,.8); cursor: pointer; }
      .steps button:hover:not(:disabled) { background: rgba(255,255,255,.08); color: #e8e6e3; }
      .steps button:disabled { opacity: .35; cursor: default; }
      .steps svg { width: 14px; height: 14px; }
      .card .on-what { font-size: 12px; color: #e8e6e3; margin-bottom: 8px; line-height: 1.35; }
      .toast { position: fixed; right: 16px; bottom: 64px; padding: 6px 12px; border-radius: 8px; background: #2c2c2c; border: 1px solid rgba(255,255,255,.12); display: none; }
    </style>
    <div class="box"></div><div class="tip"></div>
    <div class="h tl"></div><div class="h tr"></div><div class="h bl"></div><div class="h br"></div>
    <div class="hint">Click what you want to comment on. Esc to stop.</div>
    <div class="card">
      <div class="on-what"></div>
      <div class="steps">
        <button class="smaller" title="Smaller: the part inside it ( Alt ↓ )"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" /></svg>Smaller</button>
        <button class="bigger" title="Bigger: what it sits in ( Alt ↑ )"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>Bigger</button>
      </div>
      <textarea placeholder="What should change? Enter sends"></textarea>
      <div class="row"><button class="b cancel">Cancel</button><button class="b send">Send to Groundwork</button></div>
    </div>
    <div class="toast"></div>
    <button class="save" title="Save the waiting comments as a file to send to whoever runs Groundwork">Save as file</button>
    <div class="dock-target"></div>
    <div class="bar">
      <span class="name"><span class="dot"></span>Groundwork</span>
      <button class="go" title="Comment on this page (Alt+C)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg><span class="bar-label">Comment</span></button>
      <button class="bar-save" title="Save the waiting comments as a file to send to whoever runs Groundwork" style="display:none">Save as file</button>
      <span class="grow"></span>
      <button class="float" title="Float the button over the page instead"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>Float</button>
      <button class="fold" title="Fold into a small tab"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg></button>
    </div>
    <button class="tab" title="Groundwork: open the bar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>Groundwork</button>
    <button class="pill" title="Comment on this page (Alt+C). Drag to move it; drop it on the bottom edge for a bar.">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>
      <span>Comment</span>
    </button>`
  const $ = (s) => root.querySelector(s)
  const pill = $('.pill'), box = $('.box'), tip = $('.tip'), hint = $('.hint'), card = $('.card'), field = $('textarea'), toast = $('.toast')
  const sendBtn = $('.send'), saveBtn = $('.save'), pillLabel = $('.pill span')
  const bar = $('.bar'), tab = $('.tab'), dockTarget = $('.dock-target'), barGo = $('.bar .go'), barLabel = $('.bar-label'), barSave = $('.bar-save')

  // Where the button sits: floating where it was dragged, as a bar along the
  // bottom edge (the page gets room for it, like Laravel's debug bar), or
  // folded into a tab. Kept per site in this browser.
  const PLACE = 'groundwork.place'
  let seat = { mode: 'float', x: null, y: null }
  try { seat = { ...seat, ...JSON.parse(localStorage.getItem(PLACE) || '{}') } } catch {}
  const pagePadding = document.documentElement.style.paddingBottom
  function applyPlace() {
    pill.style.display = seat.mode === 'float' ? 'flex' : 'none'
    bar.style.display = seat.mode === 'bar' ? 'flex' : 'none'
    tab.style.display = seat.mode === 'tab' ? 'flex' : 'none'
    document.documentElement.style.paddingBottom = seat.mode === 'bar' ? '36px' : pagePadding
    if (seat.mode === 'float' && seat.x !== null) {
      const x = Math.max(4, Math.min(window.innerWidth - pill.offsetWidth - 4, seat.x))
      const y = Math.max(4, Math.min(window.innerHeight - pill.offsetHeight - 4, seat.y))
      Object.assign(pill.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' })
    }
    try { localStorage.setItem(PLACE, JSON.stringify(seat)) } catch {}
  }

  // Dragging the button: a short move is still a click.
  let moved = null
  pill.addEventListener('pointerdown', (e) => {
    const r = pill.getBoundingClientRect()
    moved = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY, dragging: false }
    pill.setPointerCapture(e.pointerId)
  })
  pill.addEventListener('pointermove', (e) => {
    if (!moved) return
    if (!moved.dragging && Math.hypot(e.clientX - moved.x, e.clientY - moved.y) < 5) return
    moved.dragging = true
    pill.classList.add('dragging')
    Object.assign(pill.style, { left: `${e.clientX - moved.dx}px`, top: `${e.clientY - moved.dy}px`, right: 'auto', bottom: 'auto' })
    dockTarget.style.display = e.clientY > window.innerHeight - 40 ? 'block' : 'none'
  })
  pill.addEventListener('pointerup', (e) => {
    if (!moved) return
    const dragged = moved.dragging
    pill.classList.remove('dragging')
    dockTarget.style.display = 'none'
    if (dragged) {
      if (e.clientY > window.innerHeight - 40) seat = { ...seat, mode: 'bar' }
      else seat = { mode: 'float', x: e.clientX - moved.dx, y: e.clientY - moved.dy }
      applyPlace()
    }
    // Swallow the click that follows a drag.
    moved = dragged ? { swallow: true } : null
  })

  // Comments that could not be sent wait in this browser, and go once Groundwork answers.
  const OUTBOX = 'groundwork.outbox'
  const outbox = {
    read() {
      try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]') } catch { return [] }
    },
    write(list) {
      try { localStorage.setItem(OUTBOX, JSON.stringify(list)) } catch {}
      pillLabel.textContent = list.length ? `Comment · ${list.length}` : 'Comment'
      saveBtn.style.display = list.length && seat.mode === 'float' ? 'block' : 'none'
      if (typeof barLabel !== 'undefined') {
        barLabel.textContent = pillLabel.textContent
        barSave.style.display = list.length ? 'flex' : 'none'
      }
    },
  }
  // Whether the map is asking the person to allow this site.
  let asked = false, tick = 0
  // Pictures too large for the browser's storage, kept while this page is open, by when the comment was written.
  const held = new Map()
  /** 'sent', 'rejected' (do not retry), 'asked' (wait for the person to allow this site), or 'waiting' (try again later). */
  async function post(comment) {
    if (!comment.image && held.has(comment.written)) comment = { ...comment, image: held.get(comment.written) }
    try {
      const res = await fetch(`${base}/__groundwork/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(comment) })
      if (res.status === 201) return 'sent'
      // The map asks the person to allow this site first; the comment waits here until then.
      if (res.status === 403 && (await res.json().catch(() => ({}))).ask) return 'asked'
      return res.status === 404 || res.status === 429 || res.status >= 500 ? 'waiting' : 'rejected'
    } catch {
      return 'waiting'
    }
  }
  async function flush() {
    let list = outbox.read()
    while (list.length) {
      const result = await post(list[0])
      asked = result === 'asked'
      if (result === 'waiting' || result === 'asked') break
      list = list.slice(1)
      outbox.write(list)
    }
  }
  outbox.write(outbox.read())
  flush()
  // Every 20 seconds; every 5 while the map is asked to allow this site, so the comment arrives soon after.
  setInterval(() => outbox.read().length && (asked || ++tick % 4 === 0) && flush(), 5000)

  let picking = false
  /** What is picked: the element, and the chain from the clicked element out to the page, to step through. */
  let picked = null
  let chain = []
  let at = 0
  /** An area framed by hand with the handles, in page coordinates, instead of an element. */
  let area = null
  const handles = [...root.querySelectorAll('.h')]

  const mount = () => (document.body || document.documentElement).appendChild(host)
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount)

  // What a person would call an element, and what kind it is.
  const ROLES = { a: 'link', button: 'button', img: 'image', select: 'menu', textarea: 'text field', h1: 'heading', h2: 'heading', h3: 'heading', nav: 'navigation', li: 'list item', ul: 'list', ol: 'list', form: 'form', label: 'label', p: 'text', span: 'text', div: 'box', section: 'section', article: 'card', main: 'page', header: 'header', footer: 'footer', aside: 'side panel', table: 'table', tr: 'row', td: 'cell', svg: 'icon' }
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
    const text = el.getAttribute('aria-label') || labelled || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || buttonValue(el) || ''
    return String(text).replace(/\s+/g, ' ').trim().slice(0, 80)
  }
  /** What a field holds is never sent, only what a button input says on it (a typed card number or password stays in the page). */
  function buttonValue(el) {
    return el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) ? el.value : ''
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

  /** Where the selection is now, in the window: the framed area, or the picked element. */
  function selectionRect() {
    if (area) return { left: area.x - scrollX, top: area.y - scrollY, width: area.w, height: area.h }
    const r = picked.getBoundingClientRect()
    return { left: r.left - 2, top: r.top - 2, width: r.width + 4, height: r.height + 4 }
  }
  /** The box and its four handles around the selection, while it is being edited. */
  function showSelection() {
    const r = selectionRect()
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    box.classList.add('edit')
    tip.style.display = 'none'
    const corners = [[r.left, r.top], [r.left + r.width, r.top], [r.left, r.top + r.height], [r.left + r.width, r.top + r.height]]
    handles.forEach((h, i) => Object.assign(h.style, { display: 'block', left: `${corners[i][0]}px`, top: `${corners[i][1]}px` }))
  }
  function hideSelection() {
    box.classList.remove('edit')
    handles.forEach((h) => (h.style.display = 'none'))
  }

  /** From the clicked element out to the page, each step a box the eye sees as bigger. */
  function chainFrom(el) {
    const out = []
    let last = null
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const r = n.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      if (n === document.body) break
      const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`
      // The same box twice (a wrapper exactly around its child): keep the outer one, it says more.
      if (key === last) out[out.length - 1] = n
      else out.push(n)
      last = key
    }
    return out.length ? out : [el]
  }

  /** What an area framed by hand holds: the texts inside it, top to bottom. */
  function textsIn(rect) {
    const found = []
    const all = document.body.querySelectorAll('*')
    for (let i = 0; i < all.length && i < 5000; i++) {
      const n = all[i]
      if (n === host || n.children.length > 0 && [...n.childNodes].every((c) => c.nodeType !== 3 || !c.textContent.trim())) continue
      const t = (n.getAttribute('aria-label') || n.innerText || n.getAttribute('alt') || '').replace(/\s+/g, ' ').trim()
      if (!t) continue
      const r = n.getBoundingClientRect()
      if (r.width && r.left >= rect.left - 2 && r.top >= rect.top - 2 && r.right <= rect.left + rect.width + 2 && r.bottom <= rect.top + rect.height + 2) found.push({ t: t.slice(0, 60), y: r.top, x: r.left })
    }
    found.sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x))
    return [...new Set(found.map((f) => f.t))].slice(0, 4).join(' · ')
  }

  /** The smallest element around a framed area, for the comment's selector and component. */
  function anchorOf(rect) {
    box.style.pointerEvents = 'none'
    let n = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    box.style.pointerEvents = ''
    while (n && n !== document.body) {
      const r = n.getBoundingClientRect()
      if (r.left <= rect.left + 2 && r.top <= rect.top + 2 && r.right >= rect.left + rect.width - 2 && r.bottom >= rect.top + rect.height - 2) break
      n = n.parentElement
    }
    return n || document.body
  }

  /** The line in the card that says what is picked, and whether it can grow or shrink. */
  function describe() {
    if (area) {
      const texts = area.texts
      $('.on-what').textContent = `Your area${texts ? ` "${texts.slice(0, 90)}"` : ''}`
    } else {
      const name = labelOf(picked)
      $('.on-what').textContent = `On the ${roleOf(picked)}${name ? ` "${name.slice(0, 60)}"` : ''}`
    }
    $('.smaller').disabled = !area && at === 0
    $('.bigger').disabled = !area && at >= chain.length - 1
  }

  /** Smaller or bigger: along the chain. From a framed area, back to the elements. */
  function step(by) {
    if (!picked) return
    if (area) area = null
    else at = Math.max(0, Math.min(chain.length - 1, at + by))
    picked = chain[at]
    showSelection()
    describe()
  }


  function setPicking(on) {
    picking = on
    pill.classList.toggle('on', on)
    barGo.classList.toggle('on', on)
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
    hideSelection()
    picked = null
    area = null
    chain = []
    field.value = ''
  }

  /** The card next to the selection, out of its way. */
  function placeCard() {
    const r = selectionRect()
    const h = card.offsetHeight || 210
    const left = Math.min(window.innerWidth - 312, Math.max(12, r.left))
    const below = r.top + r.height + h + 16 < window.innerHeight
    const above = r.top - h - 16 > 0
    const top = below ? r.top + r.height + 8 : above ? r.top - h - 8 : Math.max(12, window.innerHeight - h - 12)
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` })
  }

  function openCard(clicked) {
    setPicking(false)
    chain = chainFrom(clicked)
    const meant = meaningful(clicked)
    at = Math.max(0, chain.findIndex((n) => n === meant || n.contains(meant)))
    picked = chain[at]
    area = null
    card.style.display = 'block'
    describe()
    showSelection()
    placeCard()
    field.focus()
  }

  // Framing by hand: a corner resizes the box, the inside moves it.
  let drag = null
  handles.forEach((h, i) =>
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      drag = { corner: i, start: selectionRect(), x: e.clientX, y: e.clientY }
    }),
  )
  box.addEventListener('pointerdown', (e) => {
    if (!picked) return
    e.preventDefault()
    drag = { corner: -1, start: selectionRect(), x: e.clientX, y: e.clientY }
  })
  window.addEventListener('pointermove', (e) => {
    if (!drag) return
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    let { left, top, width, height } = drag.start
    let right = left + width, bottom = top + height
    if (drag.corner === -1) {
      left += dx; right += dx; top += dy; bottom += dy
    } else {
      if (drag.corner % 2 === 0) left = Math.min(left + dx, right - 16)
      else right = Math.max(right + dx, left + 16)
      if (drag.corner < 2) top = Math.min(top + dy, bottom - 16)
      else bottom = Math.max(bottom + dy, top + 16)
    }
    area = { x: left + scrollX, y: top + scrollY, w: right - left, h: bottom - top, texts: area?.texts ?? '' }
    showSelection()
  })
  window.addEventListener('pointerup', () => {
    if (!drag) return
    drag = null
    // What the area holds, read once the mouse lets go.
    if (area) area.texts = textsIn(selectionRect())
    describe()
    placeCard()
    field.focus()
  })

  /** The drawing library, loaded from Groundwork the first time a picture is taken. */
  let shotLib = null
  function loadShotLib() {
    if (window.__groundworkShot) return Promise.resolve(window.__groundworkShot)
    if (!shotLib) {
      shotLib = new Promise((resolve, reject) => {
        const tag = document.createElement('script')
        tag.src = `${base}/__groundwork/screenshot.js`
        tag.onload = () => (window.__groundworkShot ? resolve(window.__groundworkShot) : reject(new Error('not loaded')))
        tag.onerror = reject
        document.head.appendChild(tag)
      })
      shotLib.catch(() => (shotLib = null))
    }
    return shotLib
  }

  /**
   * A picture of the spot: the page around the selection, with some margin,
   * drawn from the page itself (not a screenshot, so a font or an image from
   * another site can be missing). Without the box, the card or the button.
   * Null when it cannot be drawn: the comment goes without it.
   */
  async function pictureOf(rect) {
    try {
      const lib = await loadShotLib()
      const margin = 48
      const want = { left: rect.left - margin, top: rect.top - margin, right: rect.left + rect.width + margin, bottom: rect.top + rect.height + margin }
      // The smallest element around the spot and its margin, so the whole page is not drawn.
      let around = area ? anchorOf(rect) : picked
      while (around && around !== document.body) {
        const r = around.getBoundingClientRect()
        if (r.left <= want.left && r.top <= want.top && r.right >= want.right && r.bottom >= want.bottom) break
        around = around.parentElement
      }
      around = around || document.body
      const outer = around.getBoundingClientRect()
      const scale = Math.min(2, window.devicePixelRatio || 1)
      // What is inside an element wholly outside the spot is left out: a big
      // page (a calendar of thousands of cells) is otherwise slow to draw. The
      // element itself stays, as an empty box of its own size, so nothing
      // around it moves.
      const outside = (el) => {
        if (!el || el === around) return false
        const r = el.getBoundingClientRect()
        return r.right < want.left || r.left > want.right || r.bottom < want.top || r.top > want.bottom
      }
      const drawing = lib.domToCanvas(around, {
        scale,
        timeout: 4000,
        filter: (n) => n !== host && !outside(n.parentElement),
        onCloneEachNode: cleanAttributes,
        // A scrolled list is drawn as scrolled, not from its top.
        features: { restoreScrollPosition: true },
      })
      // A page too big to draw in time sends its comment without a picture.
      const canvas = await Promise.race([drawing, new Promise((resolve) => setTimeout(() => resolve(null), 20000))])
      if (!canvas) return null
      // Cut the spot and its margin out of the drawing of the element around it.
      const x = Math.max(0, want.left - outer.left), y = Math.max(0, want.top - outer.top)
      const w = Math.min(outer.width - x, want.right - want.left), h = Math.min(outer.height - y, want.bottom - want.top)
      if (w < 4 || h < 4) return null
      const crop = document.createElement('canvas')
      crop.width = Math.round(w * scale)
      crop.height = Math.round(h * scale)
      const ctx = crop.getContext('2d')
      ctx.drawImage(canvas, x * scale, y * scale, w * scale, h * scale, 0, 0, crop.width, crop.height)
      // Nothing drawn at all: no picture, rather than a black one.
      if (blank(ctx, crop.width, crop.height)) return null
      // A JPEG has no transparency: what the page leaves see-through gets the page's own background, not black.
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = pageBackground()
      ctx.fillRect(0, 0, crop.width, crop.height)
      const jpeg = crop.toDataURL('image/jpeg', 0.75)
      return jpeg.length < 6_000_000 ? jpeg : null
    } catch {
      return null
    }
  }

  /**
   * Livewire's `wire:id`, Alpine's `@click`, `:class` and `x-on:click` are
   * fine in HTML but not in the SVG the picture is drawn through, where one
   * of them makes the browser draw nothing. They change nothing visible.
   */
  function cleanAttributes(clone) {
    if (clone.nodeType !== 1) return
    for (const attr of [...clone.attributes]) {
      if (!attr.namespaceURI && !/^[A-Za-z_][\w.-]*$/.test(attr.name)) clone.removeAttribute(attr.name)
    }
  }

  function blank(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h).data
    const step = Math.max(4, Math.floor(data.length / 4 / 20000) * 4)
    for (let i = 3; i < data.length; i += step) if (data[i]) return false
    return true
  }

  function pageBackground() {
    for (const el of [document.body, document.documentElement]) {
      const bg = el && getComputedStyle(el).backgroundColor
      if (bg && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(bg)) return bg
    }
    return '#fff'
  }

  async function send() {
    const text = field.value.trim()
    if (!text || !picked) return
    // A framed area is described by what it holds, and placed by the element around it.
    const el = area ? anchorOf(selectionRect()) : picked
    const comment = {
      text,
      platform: 'Web',
      screen: location.pathname,
      // Without the query and the hash, which can hold tokens or personal data.
      url: location.origin + location.pathname,
      written: new Date().toISOString(),
      element: area
        ? { label: area.texts, id: idOf(el), role: 'area', component: componentOf(el), selector: selectorOf(el) }
        : { label: labelOf(el), id: idOf(el), role: roleOf(el), component: componentOf(el), selector: selectorOf(el) },
    }
    sendBtn.disabled = true
    // Drawn while the selection is still on screen; the box and card are left out of it.
    const picture = await pictureOf(selectionRect())
    if (picture) comment.image = picture
    const result = await post(comment)
    sendBtn.disabled = false
    closeCard()
    if (result === 'sent') {
      flash('Sent to Groundwork')
      flush()
    } else if (result === 'waiting' || result === 'asked') {
      // The browser keeps little: a large picture would lose the whole comment. Keep the words for sure.
      const keep = comment.image && comment.image.length > 400_000 ? { ...comment, image: undefined } : comment
      if (keep !== comment) held.set(comment.written, comment.image)
      const list = [...outbox.read(), keep]
      outbox.write(list)
      flash(result === 'asked'
        ? `Allow ${location.host} in Groundwork's map once. The comment goes then.`
        : `Saved. It goes to Groundwork when it is running (${list.length} waiting)`)
      asked = result === 'asked'
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
  window.addEventListener('scroll', () => picked && card.style.display === 'block' && showSelection(), true)
  window.addEventListener('resize', () => picked && card.style.display === 'block' && (showSelection(), placeCard()))
  $('.smaller').addEventListener('click', () => (step(-1), field.focus()))
  $('.bigger').addEventListener('click', () => (step(1), field.focus()))

  pill.addEventListener('click', (e) => {
    if (moved && moved.swallow) {
      moved = null
      e.preventDefault()
      return
    }
    closeCard()
    setPicking(!picking)
  })
  $('.cancel').addEventListener('click', closeCard)
  saveBtn.addEventListener('click', saveFile)
  barSave.addEventListener('click', saveFile)
  barGo.addEventListener('click', () => {
    closeCard()
    setPicking(!picking)
  })
  $('.float').addEventListener('click', () => ((seat = { mode: 'float', x: null, y: null }), applyPlace()))
  $('.fold').addEventListener('click', () => ((seat = { ...seat, mode: 'tab' }), applyPlace()))
  tab.addEventListener('click', () => ((seat = { ...seat, mode: 'bar' }), applyPlace()))
  window.addEventListener('resize', () => seat.mode === 'float' && seat.x !== null && applyPlace())
  applyPlace()
  sendBtn.addEventListener('click', send)
  field.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      step(e.key === 'ArrowUp' ? 1 : -1)
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') closeCard()
  })
})()
