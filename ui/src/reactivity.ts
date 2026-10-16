import Alpine from 'alpinejs'
import { computed, effect, reactive, stop, toRaw, type ComputedRef } from '@vue/reactivity'

// Alpine inlines its own copy of @vue/reactivity, which keeps `computed` out
// of reach. Hand it the same library from node_modules instead (wired the way
// Alpine wires its own), so the costly getters can be cached below. Imported
// before the store is made.
Alpine.setReactivityEngine({
  reactive: reactive as never,
  effect: ((callback: () => unknown, options: { scheduler?: (run: () => unknown) => void } = {}) => {
    // Since Vue 3.2 the scheduler gets no arguments; Alpine's expects the runner.
    let runner: ReturnType<typeof effect> | undefined
    runner = effect(callback, {
      scheduler: () => {
        if (!runner) return
        options.scheduler ? options.scheduler(runner) : runner()
      },
    })
    return runner
  }) as never,
  release: stop as never,
  raw: toRaw,
})

const memo = new Map<string, ComputedRef<unknown>>()

/**
 * A getter's value, computed once and kept until something it read changes.
 * Alpine getters run again on every read, and the map reads the board, the
 * visible nodes and the page names many times per render.
 */
export function cached<T>(name: string, get: () => T): T {
  let ref = memo.get(name)
  if (!ref) {
    ref = computed(get)
    memo.set(name, ref)
  }
  return ref.value as T
}
