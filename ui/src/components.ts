import Alpine from '@alpinejs/csp'
import { checkedSteps } from '../../src/shared/feedback'
import { state } from './state'

/**
 * Parts of the page with state of their own, as Alpine.data components:
 * Alpine's CSP build reads no methods or getters written in the page itself.
 */

/** The project's badge on the rail, and its editor: the name, the letters and the color, saved in project.md. */
Alpine.data('badge', () => ({
  open: false,
  name: '',
  initials: '',
  color: '',
  edit() {
    const p = state.project as Record<string, unknown>
    this.open = true
    this.name = String(p.name ?? '')
    this.initials = String(p.initials ?? '')
    this.color = String(p.color ?? '')
    Alpine.nextTick(() => (this as unknown as { $refs: Record<string, HTMLElement> }).$refs.badgeName?.focus())
  },
  close() {
    this.open = false
    state.projectMenu = false
  },
  /** On the Mac the badge edits; on the page it opens the other projects. */
  press() {
    if (state.onMac) {
      if (this.open) this.open = false
      else this.edit()
    } else {
      this.open = false
      state.toggleProjectMenu()
    }
  },
  editFromMenu() {
    state.projectMenu = false
    this.edit()
  },
  async save() {
    if (await state.saveBadge({ name: this.name, initials: this.initials, color: this.color })) this.open = false
  },
  /** What the badge will say: the name typed, else the folder's. */
  get label(): string {
    return this.name.trim() || String((state.project as Record<string, unknown>).folder ?? '')
  },
  get folder(): string {
    return String((state.project as Record<string, unknown>).folder ?? '')
  },
  get autoColor(): string {
    return state.autoColor(this.label)
  },
  get letters(): string {
    if (this.initials.trim()) return this.initials.trim().toUpperCase()
    const words = this.label.split(/[\s_.-]+/).filter(Boolean)
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '').slice(0, 2)).toUpperCase()
  },
}))

/**
 * The drawn sitemap moves with the mouse, as in a design tool: drag anywhere.
 * A click without moving still opens a screen; after a drag, the click that
 * ends it is swallowed so it opens nothing.
 */
Alpine.data('sitemapPan', () => ({
  pan: null as null | { x: number; y: number; l: number; t: number; moved: boolean },
  get panClass(): string {
    return this.pan?.moved ? 'cursor-grabbing select-none' : 'cursor-grab'
  },
  down(e: PointerEvent, pane: HTMLElement) {
    if (e.button === 0 && e.pointerType === 'mouse') this.pan = { x: e.clientX, y: e.clientY, l: pane.scrollLeft, t: pane.scrollTop, moved: false }
  },
  move(e: PointerEvent, pane: HTMLElement) {
    const pan = this.pan
    if (!pan) return
    const dx = e.clientX - pan.x
    const dy = e.clientY - pan.y
    if (!pan.moved && Math.hypot(dx, dy) > 4) pan.moved = true
    if (pan.moved) {
      pane.scrollLeft = pan.l - dx
      pane.scrollTop = pan.t - dy
    }
  },
  up() {
    if (this.pan?.moved) {
      const stop = (e: Event) => {
        e.stopPropagation()
        e.preventDefault()
      }
      window.addEventListener('click', stop, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', stop, true), 0)
    }
    this.pan = null
  },
  /** Pinch on a trackpad, or Ctrl or Cmd with the scroll wheel, zooms. */
  wheel(e: WheelEvent, pane: HTMLElement) {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    state.pinchSitemap(e, pane)
  },
}))

type Kind = 'screen' | 'persona' | 'thought'
type Q = { entry: number; index: number; options: string[] }

/** What a thread is about: the open screen, persona or thought. */
function ownerOf(kind: Kind): string {
  if (kind === 'screen') return state.screen?.id ?? ''
  if (kind === 'persona') return state.persona?.id ?? ''
  return state.selectedId ?? ''
}

/**
 * The answer box under one of the agent's questions, in the thread of a
 * screen, a persona or a thought: the options picked, the words, pictures,
 * and an answer given too quickly put back after Undo.
 */
Alpine.data('answer', (kind: Kind) => ({
  picked: [] as string[],
  words: '',
  /** After Undo, the answer comes back into the box it came from. */
  takeBack(q: Q) {
    const back = state.takeBack(`${ownerOf(kind)}:${q.entry}:${q.index}`)
    if (back) {
      this.picked = back.picked
      this.words = back.words
    }
  },
  toggle(option: string) {
    this.picked = this.picked.includes(option) ? this.picked.filter((x) => x !== option) : [...this.picked, option]
  },
  async send(q: Q & Parameters<typeof state.answerQuestion>[0]) {
    if (!this.picked.length && !this.words.trim()) return
    const text = state.answerText(q.options, this.picked, this.words)
    if (kind === 'screen') await state.answerScreenQuestion(q, text)
    else if (kind === 'persona') await state.answerPersonaQuestion(q, text)
    else await state.answerQuestion(q, text)
    this.picked = []
    this.words = ''
  },
  /** Pictures pasted, dropped or picked: saved with the thread's owner, shown at the end of the answer. */
  pictures(e: Event) {
    return state.picturesInto(this as unknown as Record<string, unknown>, 'words', ownerOf(kind), e)
  },
}))

/** The options picked for a question in the Inbox, put back after Undo. */
Alpine.data('inboxAnswer', () => ({
  picked: [] as string[],
  takeBack(item: { id: string; entry: number; index: number }) {
    const back = state.takeBack(`inbox:${item.id}:${item.entry}:${item.index}`)
    if (back) this.picked = back.picked
  },
  toggle(option: string) {
    this.picked = this.picked.includes(option) ? this.picked.filter((x) => x !== option) : [...this.picked, option]
  },
  async send(item: Parameters<typeof state.answerInbox>[0] & { key: string; options: string[] }) {
    await state.answerInbox(item, state.answerText(item.options, this.picked, state.inboxDrafts[item.key] || ''))
    this.picked = []
  },
}))

/** A question as the Inbox knows it, for Waiting for… in a thread (`wi`). */
Alpine.data('waitingItem', (kind: Kind) => ({
  get wi() {
    const q = (this as unknown as { q: Parameters<typeof state.threadItem>[3] }).q
    if (kind === 'screen') return state.threadItem('screen', state.screen?.id ?? '', state.screen?.body ?? '', q)
    if (kind === 'persona') return state.threadItem('persona', state.persona?.id ?? '', state.persona?.body ?? '', q)
    return state.threadItem('question', state.selectedId ?? '', state.draft.body, q)
  },
}))

/** Whose thread an entry is in (`owner`), for changing your own entries. */
Alpine.data('entryOwner', (kind: Kind) => ({
  get owner() {
    return ownerOf(kind)
  },
}))

/** One project's card in All projects (`c`): what its own files say, or loading. */
Alpine.data('projectCard', () => ({
  get c() {
    const p = (this as unknown as { p: { url: string } }).p
    return state.projectCards[p.url] ?? { loading: true }
  },
}))

/**
 * A thread entry, and when the agent's entry has To test steps, its steps
 * (`steps`) and how far testing them got: each step works, does not, or is
 * not tried yet.
 */
Alpine.data('entrySteps', () => ({
  get steps() {
    const { e, i } = this as unknown as { e: { who: string; text: string }; i: number }
    if (e.who !== 'claude') return { fix: '', steps: [], checks: [] }
    const read = state.testSteps(e.text)
    // A later entry of the round may mark these steps by number (`Checked:`), without writing them again.
    return read.steps.length ? { ...read, checks: state.roundChecks(i) } : read
  },
  /**
   * An agent entry that only reports a check of steps written before (`Checked:`, no
   * steps of its own): shown folded, its first paragraph, which steps it checked,
   * and its pictures small with their step, until opened.
   */
  get report(): { lead: string; steps: string; pictures: { pic: ReturnType<typeof state.entryPictures>[number]; label: string }[] } | null {
    const { e } = this as unknown as { e: { who: string; text: string } }
    if (e.who !== 'claude' || this.steps.steps.length) return null
    const marks = checkedSteps(state.entryWords(e.text))
    if (!marks.size) return null
    const nums = [...marks.keys()].sort((a, b) => a - b).map((n) => String(n + 1))
    const list = nums.length > 1 ? `${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}` : nums[0]
    // Each picture with the "Step N" line above it, when there is one: matched by the picture
    // itself, read the way the pictures are, so a link or a picture it skips never shifts a label.
    const labelOf = new Map<string, string>()
    let label = ''
    for (const line of e.text.split('\n')) {
      const step = /^\s*Step (\d{1,2})\s*:?\s*$/i.exec(line)
      if (step) label = `Step ${step[1]}`
      else if (/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line)) {
        for (const pic of state.entryPictures(line)) if (!labelOf.has(pic.url)) labelOf.set(pic.url, label)
      } else if (line.trim()) label = ''
    }
    const pictures = state.entryPictures(e.text).map((pic) => ({ pic, label: labelOf.get(pic.url) ?? '' }))
    const lead = state.entryWords(e.text).split(/\n\s*\n/)[0].trim()
    return { lead, steps: `Checked step${nums.length > 1 ? 's' : ''} ${list} of the steps to test`, pictures }
  },
  /** A folded report opened in full. */
  reportOpen: false,
  /** How far the agent checked step n itself, in words for its tag: empty when it did not. */
  checkLabel(n: number): string {
    const c = this.steps.checks[n]
    if (!c) return ''
    const what = { automated: 'Tested automatically', agent: 'Checked by your agent', outdated: 'Looks out of date' }[c.kind]
    return c.note ? `${what}: ${c.note}` : what
  },
  checkClass(n: number): string {
    const kind = this.steps.checks[n]?.kind
    return kind === 'automated' ? 'text-emerald-300' : kind === 'agent' ? 'text-sky-300' : 'text-amber-300'
  },
  checkIcon(n: number): string {
    const kind = this.steps.checks[n]?.kind
    return kind === 'automated' ? '#i-beaker' : kind === 'agent' ? '#i-sparkles' : '#i-clock'
  },
  /** Whether the agent checked any step: only then is there a column for the icons. */
  anyCheck(): boolean {
    return this.steps.checks.some(Boolean)
  },
  /** The step whose check is spelled out under it, after a click on its icon (for touch, where there is no hover). */
  openCheck: -1,
  toggleCheck(n: number) {
    this.openCheck = this.openCheck === n ? -1 : n
  },

  /** How many steps of entry i are marked as working, of all. */
  working(i: number): string {
    const all = this.steps.steps.length
    const ok = this.steps.steps.filter((_, n) => state.stepMark(i, n) === 'ok').length
    return `${ok} of ${all} work`
  },
  allWork(i: number): boolean {
    return this.steps.steps.every((_, n) => state.stepMark(i, n) === 'ok')
  },
  anyBad(i: number): boolean {
    return this.steps.steps.some((_, n) => state.stepMark(i, n) === 'bad')
  },
  stepClass(i: number, n: number): string {
    const mark = state.stepShown(i, n, this.steps.steps.length)
    return mark === 'ok' ? 'bg-emerald-400/20 text-emerald-300' : mark === 'bad' ? 'bg-rose-400/20 text-rose-300' : 'bg-tint/8 text-fog/60'
  },
  stepTitle(i: number, n: number): string {
    const mark = state.stepShown(i, n, this.steps.steps.length)
    return mark === 'ok' ? 'Worked' : mark === 'bad' ? 'Did not work' : ''
  },
  stepLabel(i: number, n: number): string {
    const mark = state.stepShown(i, n, this.steps.steps.length)
    return mark === 'ok' ? '✓' : mark === 'bad' ? '✕' : String(n + 1)
  },
  /** Mark a step as not working, and go to its note. */
  fails(i: number, n: number) {
    state.markStep(i, n, 'bad')
    if (state.stepMark(i, n) === 'bad') state.focusIdSoon(`step-note-${i}-${n}`)
  },
  /** Doesn't work: open the note on the whole test. */
  openNote(i: number) {
    state.setTestNote(i, { open: true })
    state.focusIdSoon(`test-note-${i}`)
  },
  summary(i: number): string {
    if (this.allWork(i)) return 'Every step works.'
    return state.selected?.extra?.source === 'app' ? 'Go through the steps in the app.' : 'Go through the steps.'
  },
}))
