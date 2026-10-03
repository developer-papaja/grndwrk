import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three'
import { wrapLabel } from './layout'

/** Card size in CSS pixels. Drawn at twice that for sharp text. */
const PAD_X = 10
const PAD_Y = 7
const LINE = 16
const EDGE = 3
const FONT = '500 12.5px Inter, system-ui, sans-serif'
const SCALE = 2
const QUESTION = '#f5b942'

export type CardState = 'normal' | 'linked' | 'selected' | 'fresh'

export interface CardLook {
  title: string
  color: string
  state: CardState
  settled: boolean
  error: boolean
  /** Claude is waiting for an answer in this card's thread. */
  question: boolean
}

export interface Card {
  texture: CanvasTexture
  /** Size on screen in CSS pixels. */
  width: number
  height: number
}

const measure = document.createElement('canvas').getContext('2d')!

/**
 * A node drawn as words: its title on a small dark card, with a thin edge in
 * the type's color. Settled cards get a full outline in that color, the
 * selected card a bright one.
 */
export function drawCard(look: CardLook): Card {
  const lines = wrapLabel(look.title).split('\n')
  measure.font = FONT
  const textWidth = Math.max(...lines.map((l) => measure.measureText(l).width))
  const width = Math.ceil(textWidth + PAD_X * 2 + EDGE)
  const height = PAD_Y * 2 + lines.length * LINE

  const canvas = document.createElement('canvas')
  canvas.width = width * SCALE
  canvas.height = height * SCALE
  const ctx = canvas.getContext('2d')!
  ctx.scale(SCALE, SCALE)

  const r = 6
  ctx.beginPath()
  ctx.roundRect(0.5, 0.5, width - 1, height - 1, r)
  ctx.fillStyle = look.state === 'selected' ? '#16344d' : '#2c2c2c'
  ctx.fill()
  ctx.lineWidth = look.state === 'fresh' || look.question ? 1.5 : 1
  ctx.strokeStyle =
    look.state === 'selected'
      ? '#0d99ff'
      : look.question
        ? QUESTION
        : look.state === 'fresh'
        ? look.color
        : look.settled || look.state === 'linked'
        ? withAlpha(look.color, look.state === 'linked' ? 0.75 : 0.55)
        : 'rgba(255, 255, 255, 0.1)'
  ctx.stroke()

  // The type's color as a thin edge on the left.
  ctx.save()
  ctx.clip()
  ctx.fillStyle = look.color
  ctx.fillRect(0, 0, EDGE, height)
  ctx.restore()

  if (look.question) {
    // A small dot in the corner: there is a question waiting.
    ctx.beginPath()
    ctx.arc(width - 7, 7, 3, 0, Math.PI * 2)
    ctx.fillStyle = QUESTION
    ctx.fill()
  }

  ctx.font = FONT
  ctx.textBaseline = 'middle'
  ctx.fillStyle = look.state === 'selected' ? '#ffffff' : look.error ? '#f0b3a8' : 'rgba(242, 242, 242, 0.92)'
  lines.forEach((line, i) => ctx.fillText(line, EDGE + PAD_X, PAD_Y + LINE * i + LINE / 2 + 0.5))

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  // Cards are always shown at the same size, so skip mipmaps and keep text sharp.
  texture.generateMipmaps = false
  texture.minFilter = LinearFilter
  return { texture, width, height }
}

/** A small round dot, used for a card that has no room right now. */
const dots = new Map<string, CanvasTexture>()
export function dotTexture(color: string): CanvasTexture {
  let t = dots.get(color)
  if (t) return t
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 32
  const ctx = canvas.getContext('2d')!
  ctx.beginPath()
  ctx.arc(16, 16, 11, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(14, 17, 22, 0.9)'
  ctx.stroke()
  t = new CanvasTexture(canvas)
  t.colorSpace = SRGBColorSpace
  dots.set(color, t)
  return t
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
