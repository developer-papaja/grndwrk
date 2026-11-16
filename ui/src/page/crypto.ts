/** `node:crypto` for the store code in the page: only what it uses, from the browser's own random numbers. */
export function randomInt(min: number, max?: number): number {
  const [lo, hi] = max === undefined ? [0, min] : [min, max]
  const range = hi - lo
  // Rejection sampling, so every value is as likely as the others.
  const limit = Math.floor(0x1_0000_0000 / range) * range
  const buf = new Uint32Array(1)
  do crypto.getRandomValues(buf)
  while (buf[0] >= limit)
  return lo + (buf[0] % range)
}

export default { randomInt }
