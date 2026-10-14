"""Build public/fonts/JakartaDisplayPunct-ExtraBold.woff2 from the 800 weight.

Plus Jakarta Sans 800 gives the period, comma, colon, semicolon and
exclamation mark a wide left sidebearing (0.11 to 0.13em, against 0.01 to
0.06em on the letters). At display sizes the gap before a trailing mark reads
as a stray space ("apps ." in a 46px heading). This script cuts those five
glyphs out of the shipped 800 weight, trims their sidebearings and saves them
as a tiny font that index.css layers in front of Plus Jakarta Sans with
unicode-range, for the 800 headings only. Every other character, and every
other use of Jakarta, keeps the original font.

Run from boilerindy-react/ with fontTools 4.51.0 (and brotli for WOFF2):

    python3 -I scripts/fonts/display-punct.py

The source font is under the SIL Open Font License 1.1 (OFL.txt), which names
no Reserved Font Name; the modified copy is renamed anyway and keeps the
copyright and license strings. The output name is fixed because vercel.json
caches /fonts/* as immutable: change the trims and the file name together.
"""

from pathlib import Path

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "public" / "fonts" / "PlusJakartaSans-ExtraBold.woff2"
TARGET = ROOT / "public" / "fonts" / "JakartaDisplayPunct-ExtraBold.woff2"
FAMILY = "Jakarta Display Punct"

# Units per em are 1000, so 70 is 0.07em. Left trim closes the gap after the
# word; the smaller right trim keeps a decimal point or a time colon centred.
TRIMS = {
    0x2E: (70, 45),  # period, left sidebearing 129 -> 59
    0x2C: (70, 45),  # comma, 110 -> 40
    0x21: (70, 45),  # exclamation mark, 125 -> 55
    0x3A: (60, 60),  # colon, 129 -> 69 on both sides (times stay centred)
    0x3B: (60, 60),  # semicolon, 129 -> 69
}


def main() -> None:
    font = TTFont(SOURCE)

    options = Options()
    options.layout_features = []  # no kerning: the neighbours live in the main font
    options.hinting = False
    options.name_IDs = ["*"]
    options.notdef_outline = True
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=list(TRIMS))
    subsetter.subset(font)

    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    glyf = font["glyf"]
    hmtx = font["hmtx"]

    for code, (left, right) in TRIMS.items():
        name = cmap[code]
        # Decompose first: the colon and semicolon are built from the period,
        # and a shared component would otherwise be shifted twice.
        recording = DecomposingRecordingPen(glyph_set)
        glyph_set[name].draw(recording)
        pen = TTGlyphPen(None)
        recording.replay(TransformPen(pen, (1, 0, 0, 1, -left, 0)))
        glyph = pen.glyph()
        glyph.recalcBounds(glyf)
        glyf[name] = glyph
        advance, _ = hmtx[name]
        hmtx[name] = (advance - left - right, glyph.xMin)

    for record in font["name"].names:
        if record.nameID in (1, 4, 16):
            record.string = FAMILY if record.nameID != 4 else f"{FAMILY} ExtraBold"
        elif record.nameID == 6:
            record.string = "JakartaDisplayPunct-ExtraBold"
        elif record.nameID == 3:
            record.string = "JakartaDisplayPunct-ExtraBold;trimmed punctuation"

    font.flavor = "woff2"
    font.save(TARGET)
    print(f"wrote {TARGET.relative_to(ROOT)} ({TARGET.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
