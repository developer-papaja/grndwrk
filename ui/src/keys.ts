import { state } from './state'

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function bindKeys(captureInput: () => HTMLElement | null, actions: { layout: () => void }) {
  window.addEventListener('keydown', (e) => {
    // Cmd+Z (Ctrl+Z on Windows) outside a field takes back the answer just given.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && state.undoAnswer && !isTyping(e.target)) {
      e.preventDefault()
      void state.undoLast()
      return
    }
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
      // A card hidden by another view (selectionInView) is never changed or closed by a key.
      case '[':
        if (state.selectionInView) state.nudgeAltitude(-1)
        break
      case ']':
        if (state.selectionInView) state.nudgeAltitude(1)
        break
      case 'v':
      case 'V':
        if (state.view === 'map') actions.layout()
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        if (state.selectionInView) state.requestDelete()
        break
      case 'Escape':
        if (state.view === 'focus') state.setView('map')
        else if (state.mode === 'link') state.toggleLinkMode()
        else if (state.selectionInView && (state.selectedId || state.selectedGapId || state.selectedStoryId || state.reportOpen)) state.closePanel()
        break
    }
  })
}
