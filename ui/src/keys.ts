import { state } from './state'

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function bindKeys(captureInput: () => HTMLInputElement | null, actions: { fit: () => void }) {
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return

    if (isTyping(e.target)) {
      // Esc leaves the field. Every other key belongs to the field.
      if (e.key === 'Escape') (e.target as HTMLElement).blur()
      return
    }

    switch (e.key) {
      case 'n':
      case 'N':
        e.preventDefault()
        captureInput()?.focus()
        break
      case 'l':
      case 'L':
        state.toggleLinkMode()
        break
      case '/':
        e.preventDefault()
        state.openList()
        break
      case '[':
        state.nudgeAltitude(-1)
        break
      case ']':
        state.nudgeAltitude(1)
        break
      case 'f':
      case 'F':
        actions.fit()
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        state.requestDelete()
        break
      case 'Escape':
        if (state.mode === 'link') state.toggleLinkMode()
        else if (state.selectedId) state.select(null)
        break
    }
  })
}
