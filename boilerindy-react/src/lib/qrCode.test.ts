import { describe, expect, test } from 'vitest'
import jsQR from 'jsqr'
import { qrCodePath } from './qrCode'

// Each code is painted from its path, with the quiet zone the page draws, and
// read back by jsQR, a decoder that shares no code with the encoder.

const SITE = 'https://www.boilerindy.app'
const QUIET_ZONE = 4
const RUN = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g

function paint(d: string, size: number, scale: number): { pixels: Uint8ClampedArray; width: number } {
  const width = (size + QUIET_ZONE * 2) * scale
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255)
  for (const [, x, y, run] of d.matchAll(RUN)) {
    const left = (Number(x) + QUIET_ZONE) * scale
    const top = (Number(y) + QUIET_ZONE) * scale
    for (let row = top; row < top + scale; row += 1) {
      for (let col = left; col < left + Number(run) * scale; col += 1) {
        const i = (row * width + col) * 4
        pixels[i] = 0
        pixels[i + 1] = 0
        pixels[i + 2] = 0
      }
    }
  }
  return { pixels, width }
}

describe('qrCodePath', () => {
  test.each([
    `${SITE}/transit?ref=qr-bus`,
    `${SITE}/transit?route=31&ref=qr-bus`,
    `${SITE}/dining?hall=tower-dining&meal=dinner&ref=qr-dining`,
    `${SITE}/dining?hall=campus-center&meal=late-night&ref=qr-dining`,
    `${SITE}/free-food?ref=qr-free-food`,
  ])('draws a code that reads back as %s', (link) => {
    const { d, size } = qrCodePath(link)
    for (const scale of [3, 6]) {
      const { pixels, width } = paint(d, size, scale)
      expect(jsQR(pixels, width, width)?.data).toBe(link)
    }
  })

  test('draws whole modules only, each run closed where it started', () => {
    const { d, size } = qrCodePath(`${SITE}/transit?route=31&ref=qr-bus`)
    expect(d.replace(RUN, '')).toBe('')
    for (const [, x, y, run, back] of d.matchAll(RUN)) {
      expect(back).toBe(run)
      expect(Number(x) + Number(run)).toBeLessThanOrEqual(size)
      expect(Number(y)).toBeLessThan(size)
    }
  })

  test('keeps a share link to a code small enough for large modules', () => {
    expect(qrCodePath(`${SITE}/transit?route=31&ref=qr-bus`).size).toBeLessThanOrEqual(41)
    expect(qrCodePath(`${SITE}/dining?hall=tower-dining&meal=dinner&ref=qr-dining`).size).toBeLessThanOrEqual(41)
  })
})
