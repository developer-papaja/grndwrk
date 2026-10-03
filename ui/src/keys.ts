import { state } from './state'

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function bindKeys(captureInput: () => HTMLInputElement | null, actions: { fit: () => void; pan: (on: boolean) => void }) {
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') actions.pan(false)
  })
  window.addEventListener('blur', () => actions.pan(false))

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return

    if (isTyping(e.target)) {
      // Esc leaves the field. Every other key belongs to the field.
      if (e.key === 'Escape') (e.target as HTMLElement).blur()
      return
    }

    switch (e.key) {
      case ' ':
        e.preventDefault()
        if (!e.repeat) actions.pan(true)
        break
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
        else if (state.selectedId || state.selectedGapId || state.reportOpen) state.closePanel()
        break
    }
  })
}
