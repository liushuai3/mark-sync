#!/usr/bin/env python3
"""生成 fnOS 应用图标（纯 stdlib，无 PIL 依赖）。

视觉与 extension/icons/icon.svg 一致：
绿色对角渐变圆角矩形 + 白色几何 M。
输出: ICON.PNG(64) ICON_256.PNG(256) app/ui/images/icon_64.png icon_256.png
"""
import os
import struct
import zlib

# 128 网格上的 M 多边形（取自 icon.svg 的 path）
M_POLY = [
    (28, 32), (40, 32), (64, 68), (88, 32), (100, 32), (100, 96),
    (88, 96), (88, 55), (68, 84), (60, 84), (40, 55), (40, 96), (28, 96),
]
C0 = (0x4C, 0xAF, 0x50)  # 渐变起点 #4CAF50（左上）
C1 = (0x2E, 0x7D, 0x32)  # 渐变终点 #2E7D32（右下）
RADIUS = 24  # 128 网格圆角半径


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data)) + tag + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, size: int, rows) -> None:
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)
    print(f"{path} {size}x{size} {len(png)}B")


def in_poly(x: float, y: float, poly) -> bool:
    """奇偶规则射线法。"""
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xin:
                inside = not inside
    return inside


def render(size: int):
    s = size / 128.0
    r = RADIUS * s
    poly = [(x * s, y * s) for x, y in M_POLY]
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            # 圆角矩形透明遮罩
            ax = 0.0 if r <= x < size - r else (r if x < r else size - 1 - r)
            ay = 0.0 if r <= y < size - r else (r if y < r else size - 1 - r)
            corner = (x < r or x > size - 1 - r) and (y < r or y > size - 1 - r)
            if corner and (x - ax) ** 2 + (y - ay) ** 2 > r * r:
                row.extend((0, 0, 0, 0))
                continue
            if in_poly(x + 0.5, y + 0.5, poly):
                row.extend((255, 255, 255, 255))
            else:
                t = (x + y) / (2 * (size - 1))
                row.extend(
                    [int(C0[i] + (C1[i] - C0[i]) * t) for i in range(3)] + [255]
                )
        rows.append(row)
    return rows


def main() -> None:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    os.makedirs("app/ui/images", exist_ok=True)
    for size, path in [
        (256, "ICON_256.PNG"),
        (64, "ICON.PNG"),
        (256, "app/ui/images/icon_256.png"),
        (64, "app/ui/images/icon_64.png"),
    ]:
        write_png(path, size, render(size))


if __name__ == "__main__":
    main()
