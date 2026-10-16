// Settings kept in the browser from before the rename to grndwrk
// (groundwork.layout and the rest) carry over once. Imported first, so the
// state reads them under their new names.
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('groundwork.')) continue
    const renamed = `grndwrk.${key.slice('groundwork.'.length)}`
    if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(key) ?? '')
    localStorage.removeItem(key)
  }
} catch {
  // No storage here: the defaults are used.
}
