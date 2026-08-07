# -*- coding: utf-8 -*-
"""Generate simple PNG icons without external deps (minimal valid PNG)."""
import struct
import zlib
from pathlib import Path


def png_rgba(width: int, height: int, pixel_fn):
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter none
        for x in range(width):
            r, g, b, a = pixel_fn(x, y, width, height)
            raw.extend((r, g, b, a))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"".join(
        [
            b"\x89PNG\r\n\x1a\n",
            chunk(b"IHDR", ihdr),
            chunk(b"IDAT", zlib.compress(bytes(raw), 9)),
            chunk(b"IEND", b""),
        ]
    )


def make_icon(size: int) -> bytes:
    def pix(x, y, w, h):
        # Rounded blue square with a simple "brain/think" spark (yellow)
        cx, cy = (w - 1) / 2, (h - 1) / 2
        dx, dy = x - cx, y - cy
        # outer rounded rect
        margin = w * 0.08
        if x < margin or y < margin or x > w - 1 - margin or y > h - 1 - margin:
            # soft corner circle check
            pass
        # circular badge
        r = min(w, h) * 0.46
        dist = (dx * dx + dy * dy) ** 0.5
        if dist > r:
            return (0, 0, 0, 0)
        # Google-ish blue
        base = (26, 115, 232, 255)
        # inner spark
        if abs(dx) < w * 0.06 and abs(dy) < h * 0.22:
            return (255, 213, 79, 255)
        if abs(dy) < h * 0.06 and abs(dx) < w * 0.22:
            return (255, 213, 79, 255)
        return base

    return png_rgba(size, size, pix)


out = Path(__file__).parent
for s in (16, 48, 128):
    path = out / f"icon{s}.png"
    path.write_bytes(make_icon(s))
    print("wrote", path)
