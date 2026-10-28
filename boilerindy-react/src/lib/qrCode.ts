import { encode } from 'uqr'

// A QR code drawn as one SVG path, for the QR button beside Share
// (docs/share-links.md, "The QR code"). Error correction M (a code still reads
// with 15% of it lost) keeps a share link to a code about 33 to 37 modules
// wide, so each module stays large on a phone's screen. The quiet zone is the
// drawing's to add: the path starts at the code's first module.

export type QrCodePath = {
  /** One subpath per run of dark modules in a row, in module units from the top left. */
  d: string
  /** The code's width and height in modules, without a quiet zone. */
  size: number
}

export function qrCodePath(text: string): QrCodePath {
  const { data, size } = encode(text, { ecc: 'M', border: 0 })
  let d = ''
  data.forEach((row, y) => {
    let x = 0
    while (x < size) {
      if (!row[x]) {
        x += 1
        continue
      }
      let end = x
      while (end < size && row[end]) end += 1
      d += `M${x} ${y}h${end - x}v1h-${end - x}z`
      x = end
    }
  })
  return { d, size }
}
