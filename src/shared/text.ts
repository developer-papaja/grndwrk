/**
 * Text that came from another device (a comment, a device name, a screen
 * name): without control characters, which can break the YAML a file is
 * written in, and without the invisible characters that reverse or reorder
 * text, which can make one name look like another. Line breaks stay only
 * where asked for.
 */
export function cleanText(s: string, keepLines = false): string {
  const text = s
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    // Bidirectional overrides and isolates, and the marks that steer them.
    .replace(/[‪-‮⁦-⁩‎‏؜]/g, '')
    // C0 and C1 control characters, but tab and line feed.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
  return keepLines ? text : text.replace(/\s+/g, ' ')
}
