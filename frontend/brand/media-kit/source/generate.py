#!/usr/bin/env python3
"""Generate sid's media kit from the frontend fonts and supplied SVG mark."""

from __future__ import annotations

import ctypes
import ctypes.util
import re
import sys
import tempfile
import types
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
KIT = Path(__file__).resolve().parents[1]
SOURCE_MARK = KIT / "source" / "sid-mark-original.svg"
OUT = KIT

GROUND = "#111315"
INK = "#e6e3dc"
ROSE = "#e0457b"
TEAL = "#3fbfae"
PAPER_GROUND = "#f2f0ea"
PAPER_INK = "#141414"
ST_BLOCK = "#e5484d"
ST_HOLD = "#f2b134"
ST_ALLOW = "#3fc27c"

FONT_FILES = {
    "display": ROOT / "node_modules/@fontsource/syne/files/syne-latin-600-normal.woff2",
    "sans": ROOT / "node_modules/@fontsource/tasa-explorer/files/tasa-explorer-latin-400-normal.woff2",
    "sans-bold": ROOT / "node_modules/@fontsource/tasa-explorer/files/tasa-explorer-latin-700-normal.woff2",
    "mono": ROOT / "node_modules/@fontsource/commit-mono/files/commit-mono-latin-500-normal.woff2",
}

SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)


def install_brotli_adapter() -> None:
    """Let fontTools use macOS's installed Brotli decoder for WOFF2 input."""
    library = ctypes.util.find_library("brotlidec")
    if not library:
        raise RuntimeError("libbrotlidec is needed to read the frontend WOFF2 fonts")
    decoder = ctypes.CDLL(library).BrotliDecoderDecompress
    decoder.argtypes = [ctypes.c_size_t, ctypes.c_void_p,
                        ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p]
    decoder.restype = ctypes.c_int

    def decompress(data: bytes) -> bytes:
        capacity = 64 * 1024 * 1024
        source = ctypes.create_string_buffer(data)
        target = ctypes.create_string_buffer(capacity)
        target_size = ctypes.c_size_t(capacity)
        if decoder(len(data), source, ctypes.byref(target_size), target) != 1:
            raise RuntimeError("WOFF2 Brotli stream could not be decoded")
        return target.raw[:target_size.value]

    sys.modules["brotli"] = types.SimpleNamespace(decompress=decompress)


def load_fonts(temp_dir: Path):
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.ttLib import TTFont

    install_brotli_adapter()
    fonts = {}
    for name, source in FONT_FILES.items():
        if not source.is_file():
            raise FileNotFoundError(f"Missing frontend font: {source}")
        font = TTFont(source)
        font.flavor = None
        ttf_path = temp_dir / f"{name}.ttf"
        font.save(ttf_path)
        fonts[name] = {
            "tt": TTFont(ttf_path),
            "pil": ImageFont.truetype(str(ttf_path), 24),
            "path": ttf_path,
            "pen": SVGPathPen,
        }
    return fonts


def read_mark():
    root = ET.parse(SOURCE_MARK).getroot()
    style = "\n".join(node.text or "" for node in root.iter()
                      if node.tag.endswith("style"))
    fills = {key: value for key, value in re.findall(
        r"\.cls-(\d+)\s*\{\s*fill:\s*(#[0-9a-fA-F]+)", style)}
    polygons = []
    for node in root.iter():
        if node.tag.endswith(("polygon", "polyline")):
            coordinates = [float(value) for value in re.findall(
                r"-?\d+(?:\.\d+)?", node.attrib["points"])]
            points = list(zip(coordinates[::2], coordinates[1::2]))
            cls = node.attrib.get("class", "cls-1").replace("cls-", "")
            polygons.append((points, fills.get(cls, "#F15A29")))
    min_x = min(x for points, _ in polygons for x, _ in points)
    min_y = min(y for points, _ in polygons for _, y in points)
    max_x = max(x for points, _ in polygons for x, _ in points)
    max_y = max(y for points, _ in polygons for _, y in points)
    return [min_x, min_y, max_x - min_x, max_y - min_y], polygons


VIEWBOX, MARK = read_mark()


def font_px(fonts, key: str, size: int):
    return ImageFont.truetype(str(fonts[key]["path"]), size)


def glyph_metrics(font_entry, char: str):
    tt = font_entry["tt"]
    glyph_name = tt.getBestCmap().get(ord(char), ".notdef")
    advance = tt["hmtx"].metrics[glyph_name][0]
    return glyph_name, advance


def kerning_pairs(font_entry):
    tt = font_entry["tt"]
    pairs = {}
    if "GPOS" not in tt:
        return pairs
    lookups = tt["GPOS"].table.LookupList.Lookup
    for lookup in lookups:
        if lookup.LookupType != 2:
            continue
        for subtable in lookup.SubTable:
            if subtable.Format != 1:
                continue
            for first, pairset in zip(subtable.Coverage.glyphs, subtable.PairSet):
                for record in pairset.PairValueRecord:
                    value = record.Value1
                    if value and value.XAdvance:
                        pairs[(first, record.SecondGlyph)] = value.XAdvance
    return pairs


def line_advance(font_entry, text: str, scale: float, spacing: float, kern):
    total = 0.0
    prev = None
    for char in text:
        glyph, advance = glyph_metrics(font_entry, char)
        if prev is not None:
            total += kern.get((prev, glyph), 0) * scale + spacing
        total += advance * scale
        prev = glyph
    return total


def glyph_svg(font_entry, char: str, x: float, baseline: float,
              scale: float, color: str) -> str:
    glyph_name, _ = glyph_metrics(font_entry, char)
    glyph = font_entry["tt"].getGlyphSet()[glyph_name]
    pen = font_entry["pen"](font_entry["tt"].getGlyphSet())
    glyph.draw(pen)
    path = pen.getCommands()
    if not path:
        return ""
    return (f'<path d="{path}" fill="{color}" '
            f'transform="translate({x:.3f} {baseline:.3f}) '
            f'scale({scale:.6f} {-scale:.6f})"/>')


class Board:
    def __init__(self, width: int, height: int, fonts):
        self.width = width
        self.height = height
        self.fonts = fonts
        self.ops = []

    def rect(self, x, y, w, h, color, radius=0):
        self.ops.append(("rect", x, y, w, h, color, radius))

    def circle(self, x, y, radius, color):
        self.ops.append(("circle", x, y, radius, color))

    def polygon(self, points, color):
        self.ops.append(("poly", points, color))

    def text(self, x, y, value, size, font="display", color=INK,
             align="left", spacing=0, leading=None):
        self.ops.append(("text", x, y, value, size, font, color,
                         align, spacing, leading or round(size * 1.05)))

    def mark(self, x, y, width, height):
        self.ops.append(("mark", x, y, width, height))

    def write(self, base_name: str):
        svg_path = OUT / f"images/{base_name}.svg"
        png_path = OUT / f"images/{base_name}.png"
        svg_path.write_text(self.to_svg(), encoding="utf-8")
        self.to_png().save(png_path, optimize=True)

    def to_svg(self):
        chunks = [f'<svg xmlns="{SVG_NS}" width="{self.width}" '
                  f'height="{self.height}" viewBox="0 0 {self.width} {self.height}">']
        for op in self.ops:
            kind = op[0]
            if kind == "rect":
                _, x, y, w, h, color, radius = op
                chunks.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" '
                              f'rx="{radius}" fill="{color}"/>')
            elif kind == "circle":
                _, x, y, radius, color = op
                chunks.append(f'<circle cx="{x}" cy="{y}" r="{radius}" fill="{color}"/>')
            elif kind == "poly":
                _, points, color = op
                pts = " ".join(f"{x},{y}" for x, y in points)
                chunks.append(f'<polygon points="{pts}" fill="{color}"/>')
            elif kind == "mark":
                _, x, y, w, h = op
                chunks.extend(mark_svg(x, y, w, h))
            elif kind == "text":
                _, x, y, value, size, font_key, color, align, spacing, leading = op
                entry = self.fonts[font_key]
                tt = entry["tt"]
                units = tt["head"].unitsPerEm
                scale = size / units
                ascent = tt["hhea"].ascent * scale
                kern = kerning_pairs(entry)
                for line_number, line in enumerate(value.split("\n")):
                    width = line_advance(entry, line, scale, spacing, kern)
                    left = x if align == "left" else x - width / 2 if align == "center" else x - width
                    cursor = left
                    previous = None
                    baseline = y + ascent + line_number * leading
                    for char in line:
                        glyph, advance = glyph_metrics(entry, char)
                        if previous is not None:
                            cursor += kern.get((previous, glyph), 0) * scale + spacing
                        chunks.append(glyph_svg(entry, char, cursor, baseline,
                                                scale, color))
                        cursor += advance * scale
                        previous = glyph
        chunks.append("</svg>")
        return "\n".join(chunks)

    def to_png(self, background=PAPER_GROUND):
        if background is None:
            image = Image.new("RGBA", (self.width, self.height), (0, 0, 0, 0))
        else:
            image = Image.new("RGB", (self.width, self.height), background)
        draw = ImageDraw.Draw(image)
        for op in self.ops:
            kind = op[0]
            if kind == "rect":
                _, x, y, w, h, color, radius = op
                box = (x, y, x + w, y + h)
                if radius:
                    draw.rounded_rectangle(box, radius=radius, fill=color)
                else:
                    draw.rectangle(box, fill=color)
            elif kind == "circle":
                _, x, y, radius, color = op
                draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
            elif kind == "poly":
                _, points, color = op
                draw.polygon(points, fill=color)
            elif kind == "mark":
                _, x, y, w, h = op
                draw_mark(draw, x, y, w, h)
            elif kind == "text":
                _, x, y, value, size, font_key, color, align, spacing, leading = op
                font = font_px(self.fonts, font_key, size)
                lines = value.split("\n")
                line_widths = [sum(font.getlength(ch) for ch in line) +
                               max(0, len(line) - 1) * spacing for line in lines]
                for line_number, line in enumerate(lines):
                    line_width = line_widths[line_number]
                    left = x if align == "left" else x - line_width / 2 if align == "center" else x - line_width
                    top = y + line_number * leading
                    if spacing == 0:
                        draw.text((round(left), round(top)), line, font=font,
                                  fill=color, anchor="lt")
                    else:
                        cursor = left
                        for char in line:
                            draw.text((round(cursor), round(top)), char, font=font,
                                      fill=color, anchor="lt")
                            cursor += font.getlength(char) + spacing
        return image


def mark_svg(x, y, width, height):
    vb_x, vb_y, vb_w, vb_h = VIEWBOX
    scale = min(width / vb_w, height / vb_h)
    offset_x = x + (width - vb_w * scale) / 2 - vb_x * scale
    offset_y = y + (height - vb_h * scale) / 2 - vb_y * scale
    parts = [f'<g transform="translate({offset_x:.3f} {offset_y:.3f}) scale({scale:.6f})">']
    for points, color in MARK:
        pts = " ".join(f"{px:.2f},{py:.2f}" for px, py in points)
        parts.append(f'<polygon points="{pts}" fill="{color}"/>')
    parts.append("</g>")
    return parts


def draw_mark(draw, x, y, width, height):
    vb_x, vb_y, vb_w, vb_h = VIEWBOX
    scale = min(width / vb_w, height / vb_h)
    offset_x = x + (width - vb_w * scale) / 2 - vb_x * scale
    offset_y = y + (height - vb_h * scale) / 2 - vb_y * scale
    for points, color in MARK:
        transformed = [(round(offset_x + px * scale), round(offset_y + py * scale))
                      for px, py in points]
        draw.polygon(transformed, fill=color)


def save_logo_assets(fonts):
    original = ET.parse(SOURCE_MARK)
    original_root = original.getroot()
    original_root.attrib["viewBox"] = " ".join(f"{value:.2f}" for value in VIEWBOX)
    original.write(OUT / "logos/sid-mark-color.svg", encoding="unicode",
                   xml_declaration=True)

    lockup = Board(1040, 400, fonts)
    lockup.mark(20, 8, 390, 390)
    lockup.text(430, 120, "sid", 204, "display", PAPER_INK)
    (OUT / "logos/sid-lockup.svg").write_text(lockup.to_svg(), encoding="utf-8")

    wordmark = Board(640, 250, fonts)
    wordmark.text(28, 10, "sid", 208, "display", PAPER_INK)
    (OUT / "logos/sid-wordmark.svg").write_text(wordmark.to_svg(), encoding="utf-8")

    color_mark = Board(512, 512, fonts)
    color_mark.mark(40, 40, 432, 432)
    color_mark.to_png(background=None).save(OUT / "logos/sid-mark-color.png", optimize=True)
    lockup.to_png(background=None).save(OUT / "logos/sid-lockup.png", optimize=True)
    wordmark.to_png(background=None).save(OUT / "logos/sid-wordmark.png", optimize=True)


def make_artboards(fonts):
    # The mark's tight viewBox lets it carry the color; a single paper panel holds it
    # apart from the dark, high-contrast type field.
    board = Board(1800, 1200, fonts)
    board.rect(0, 0, 1800, 1200, GROUND)
    board.rect(1010, 180, 675, 840, PAPER_GROUND)
    board.mark(1034, 275, 628, 628)
    board.text(118, 280, "sid", 236, "display", INK)
    board.text(126, 578, "Before commands run.", 52, "sans", INK)
    board.write("sid-3x2")

    # Keep the compact preview to the same two lines and one mark.
    board = Board(1200, 630, fonts)
    board.rect(0, 0, 1200, 630, GROUND)
    board.rect(720, 40, 440, 550, PAPER_GROUND)
    board.mark(755, 105, 370, 420)
    board.text(72, 130, "sid", 154, "display", INK)
    board.text(80, 319, "Before commands run.", 42, "sans", INK)
    board.write("sid-open-graph")

    # A single mark panel leaves enough room for thumbnail-sized supporting text.
    board = Board(1280, 720, fonts)
    board.rect(0, 0, 1280, 720, GROUND)
    board.rect(760, 38, 482, 644, PAPER_GROUND)
    board.mark(786, 110, 430, 500)
    board.text(74, 163, "sid", 172, "display", INK)
    board.text(82, 378, "Before commands run.", 56, "sans", INK)
    board.write("sid-thumbnail")

    # The wide crop keeps the same mark-led hierarchy with a roomier subtitle.
    board = Board(1500, 500, fonts)
    board.rect(0, 0, 1500, 500, GROUND)
    board.rect(1020, 28, 450, 444, PAPER_GROUND)
    board.mark(1035, 48, 420, 400)
    board.text(82, 76, "sid", 116, "display", INK)
    board.text(90, 227, "Before commands run.", 40, "sans", INK)
    board.write("sid-social-header")

    # Square profile assets stay to the mark alone.
    board = Board(800, 800, fonts)
    board.rect(0, 0, 800, 800, PAPER_GROUND)
    board.mark(76, 76, 648, 648)
    board.write("sid-social-avatar")

    # App icon uses the complete supplied mark on site paper with a clear margin.
    board = Board(1024, 1024, fonts)
    board.rect(0, 0, 1024, 1024, PAPER_GROUND)
    board.mark(118, 118, 788, 788)
    board.to_png().save(OUT / "icons/app-icon.png", optimize=True)
    (OUT / "icons/app-icon.svg").write_text(board.to_svg(), encoding="utf-8")

    # The reference sheet keeps only the name, descriptor and site accent colors.
    board = Board(1600, 1080, fonts)
    board.rect(0, 0, 1600, 1080, PAPER_GROUND)
    board.text(120, 130, "sid", 184, "display", PAPER_INK)
    board.text(130, 360, "Before commands run.", 42, "sans", PAPER_INK)
    board.mark(980, 100, 500, 590)
    palette = [ROSE, TEAL, ST_ALLOW, ST_HOLD, ST_BLOCK]
    for index, color in enumerate(palette):
        board.rect(130 + index * 222, 770, 222, 96, color)
    board.write("sid-brand-sheet")


def save_icons(fonts):
    # The app symbol is already available in 1024px. Derive its standard sizes.
    app = Image.open(OUT / "icons/app-icon.png").convert("RGB")
    for size, name in ((512, "app-icon-512.png"),
                       (180, "apple-touch-icon.png")):
        app.resize((size, size), Image.Resampling.LANCZOS).save(
            OUT / "icons" / name, optimize=True)

    favicon = Board(64, 64, fonts)
    favicon.rect(0, 0, 64, 64, PAPER_GROUND)
    favicon.mark(6, 6, 52, 52)
    svg = favicon.to_svg()
    (OUT / "icons/favicon.svg").write_text(svg, encoding="utf-8")
    favicon_image = favicon.to_png()
    for size in (16, 32, 48):
        favicon_image.resize((size, size), Image.Resampling.LANCZOS).save(
            OUT / f"icons/favicon-{size}.png", optimize=True)
    favicon_image.save(OUT / "icons/favicon.ico", format="ICO",
                       sizes=[(16, 16), (32, 32), (48, 48)])

    manifest = '''{
  "name": "sid",
  "short_name": "sid",
  "icons": [
    { "src": "icons/app-icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "icons/apple-touch-icon.png", "sizes": "180x180", "type": "image/png" }
  ],
  "display": "standalone",
  "background_color": "#111315",
  "theme_color": "#111315"
}
'''
    (OUT / "site.webmanifest").write_text(manifest, encoding="utf-8")


def make_contact_sheet():
    files = [
        ("3:2 BRAND IMAGE", OUT / "images/sid-3x2.png"),
        ("OPEN GRAPH", OUT / "images/sid-open-graph.png"),
        ("VIDEO THUMBNAIL", OUT / "images/sid-thumbnail.png"),
        ("SOCIAL HEADER", OUT / "images/sid-social-header.png"),
        ("APP ICON", OUT / "icons/app-icon.png"),
        ("BRAND SHEET", OUT / "images/sid-brand-sheet.png"),
    ]
    width, height = 1800, 1340
    contact = Image.new("RGB", (width, height), PAPER_GROUND)
    draw = ImageDraw.Draw(contact)
    label_font = ImageFont.truetype(str(CURRENT_TEMP / "mono.ttf"), 17)
    positions = [(70, 92, 900, 600), (1000, 92, 730, 383),
                 (1000, 525, 730, 410), (70, 1000, 850, 283),
                 (980, 1000, 300, 300), (1325, 1000, 405, 278)]
    for (label, path), (x, y, w, h) in zip(files, positions):
        thumb = Image.open(path).convert("RGB")
        thumb.thumbnail((w, h), Image.Resampling.LANCZOS)
        dx = x + (w - thumb.width) // 2
        dy = y + (h - thumb.height) // 2
        contact.paste(thumb, (dx, dy))
        draw.text((x, y - 28), label, font=label_font, fill=PAPER_INK)
    contact.save(OUT / "contact-sheet.png", optimize=True)


CURRENT_TEMP = None


def main():
    global CURRENT_TEMP
    with tempfile.TemporaryDirectory(prefix="sid-media-kit-") as temp:
        CURRENT_TEMP = Path(temp)
        fonts = load_fonts(CURRENT_TEMP)
        save_logo_assets(fonts)
        make_artboards(fonts)
        save_icons(fonts)
        make_contact_sheet()
    print(f"Wrote sid media kit to {OUT}")


if __name__ == "__main__":
    main()
