import { describe, expect, test } from 'vitest'
import { stripHtml } from './linkifyText'

// Issue #295 - stripHtml stripped tags before decoding entities and decoded
// `&amp;` first, so escaped markup in a campus feed reached students as literal
// brackets and doubly escaped text was unescaped twice.

describe('stripHtml', () => {
  test('unescapes doubly escaped input exactly once', () => {
    expect(stripHtml('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;')
    expect(stripHtml('&amp;amp;')).toBe('&amp;')
    expect(stripHtml('&amp;lt;img src=x onerror=alert(1)&amp;gt;')).toBe('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('removes markup that the feed escaped', () => {
    expect(stripHtml('&lt;b&gt;Free pizza&lt;/b&gt;')).toBe('Free pizza')
    expect(stripHtml('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('alert(1)')
  })

  test('leaves no tag behind for nested or malformed input', () => {
    for (const input of [
      '<scr<b>ipt>alert(1)</scr<b>ipt>',
      '<<b>script>alert(1)<</b>/script>',
      '<scr<script>ipt>alert(1)</script>',
      '&lt;scr<b>ipt&gt;alert(1)&lt;/script&gt;',
      '<p>one</p><<p>>two',
    ]) {
      expect(stripHtml(input)).not.toMatch(/<[a-z/!?]/i)
    }
    expect(stripHtml('<scr<b>ipt>alert(1)</scr<b>ipt>')).not.toContain('<')
  })

  test('keeps a literal comparison in prose', () => {
    expect(stripHtml('Tacos &lt; $5 &amp; burritos &gt; $8')).toBe('Tacos < $5 & burritos > $8')
    expect(stripHtml('3 < 5 and 7 > 6')).toBe('3 < 5 and 7 > 6')
  })

  test('turns breaks, paragraphs and list items into newlines', () => {
    expect(stripHtml('a<br>b')).toBe('a\nb')
    expect(stripHtml('a<br/>b<BR />c')).toBe('a\nb\nc')
    expect(stripHtml('<p>one</p><p>two</p>')).toBe('one\ntwo')
    expect(stripHtml('<ul><li>x</li><li>y</li></ul>')).toBe('x\ny')
    expect(stripHtml('a<br><br><br><br>b')).toBe('a\n\nb')
  })

  test('decodes the supported entities, in any case', () => {
    expect(stripHtml('Tacos &amp; pizza')).toBe('Tacos & pizza')
    expect(stripHtml('&quot;Free&quot; &#39;food&#39; &apos;today&apos;')).toBe(`"Free" 'food' 'today'`)
    expect(stripHtml('a&nbsp;b &AMP; c')).toBe('a b & c')
    expect(stripHtml('&copy; stays')).toBe('&copy; stays')
  })

  test('returns an empty string for empty input', () => {
    expect(stripHtml(null)).toBe('')
    expect(stripHtml(undefined)).toBe('')
    expect(stripHtml('')).toBe('')
  })
})
