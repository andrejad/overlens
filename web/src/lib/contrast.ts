// WCAG contrast helpers for text on a user-chosen background color (REQ_FE_082). Ported from the
// Phase 0 wireframe tooling (lum/ratio/fgOf; the tooling is in git history) so a deliverable's bar text stays readable whatever
// color the user picked, in either theme.

// Relative luminance of a "#rrggbb" color (WCAG 2.x definition).
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

// WCAG contrast ratio between two "#rrggbb" colors.
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// The readable foreground (black or white) for a given background color: whichever of the two gives the higher
// contrast ratio. Pure black, not a near-black, so every background reaches 4.5:1 (REQ_FE_082).
export function fgOf(backgroundHex: string): string {
  return contrastRatio(backgroundHex, '#000000') >= contrastRatio(backgroundHex, '#ffffff') ? '#000000' : '#ffffff'
}
