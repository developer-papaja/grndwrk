import { state } from './state'

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function bindKeys(captureInput: () => HTMLInputElement | null, actions: { layout: () => void }) {
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return

    // A picture open on top of everything takes the keys: Esc closes, arrows step.
    if (state.viewing) {
      if (e.key === 'Escape') state.closeShot()
      else if (e.key === 'ArrowLeft') state.stepShot(-1)
      else if (e.key === 'ArrowRight') state.stepShot(1)
      e.preventDefault()
      return
    }

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
      case 'v':
      case 'V':
        if (state.view === 'map') actions.layout()
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        state.requestDelete()
        break
      case 'Escape':
        if (state.view === 'focus') state.setView('map')
        else if (state.mode === 'link') state.toggleLinkMode()
        else if (state.selectedId || state.selectedGapId || state.selectedStoryId || state.reportOpen) state.closePanel()
        break
    }
  })
}
