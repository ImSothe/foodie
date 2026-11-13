"""Renders tools/icon.html to the PNG icons in app/icons with headless Chrome.

Usage: python tools/make_icons.py            (set CHROME to the browser path if it is not the default)
"""
import base64
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHROME = os.environ.get("CHROME", r"C:\Program Files\Google\Chrome\Application\chrome.exe")
ICONS = [  # (file, size, maskable)
    ("apple-touch-icon.png", 180, False),       # iOS needs a PNG for the home screen; everything else is WebP (about a tenth of the size)
    ("icon-192.webp", 192, False),
    ("icon-512.webp", 512, False),
    ("icon-maskable-512.webp", 512, True),
]


def render(size: int, maskable: bool, kind: str = "png") -> bytes:
    url = (ROOT / "tools" / "icon.html").as_uri() + f"?size={size}" + ("&pad=1" if maskable else "") + ("&type=webp" if kind == "webp" else "")
    dom = subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--allow-file-access-from-files",
         "--virtual-time-budget=4000", "--dump-dom", url],
        capture_output=True, text=True, encoding="utf-8", check=True,
    ).stdout
    found = re.search(r'data-png="data:image/(?:png|webp);base64,([A-Za-z0-9+/=]+)"', dom)
    if not found:
        sys.exit(f"icon.html did not produce an image for size {size}")
    return base64.b64decode(found.group(1))


def main() -> None:
    out = ROOT / "app" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    for name, size, maskable in ICONS:
        data = render(size, maskable, "webp" if name.endswith(".webp") else "png")
        (out / name).write_bytes(data)
        print(f"{name}: {size} px, {len(data)} bytes")


if __name__ == "__main__":
    main()
