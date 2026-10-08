"""Puts the Sọ̀rọ̀ WhatsApp number into the site and regenerates the QR code.

  uv run --with qrcode python scripts/set_whatsapp_number.py 2348012345678
  uv run --with qrcode python scripts/set_whatsapp_number.py --placeholder   # QR to the website until the number exists
Then commit and redeploy the site: npx wrangler pages deploy site --project-name soroengine --branch main
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from urllib.parse import quote

import qrcode
import qrcode.image.svg

SITE = Path(__file__).resolve().parents[1] / "site"
PLACEHOLDER = "WA_NUMBER_PLACEHOLDER"


def hide_tag(tag: str) -> str:
    """Zero-width form of a source tag; the gateway's hideTag in gateway/src/domain/ref.ts reads it back."""
    marks = "\u200b\u200c\u200d\u2060"
    return "".join(marks[(ord(ch) >> shift) & 3] for ch in tag.upper() for shift in (6, 4, 2, 0))


def write_qr(url: str) -> None:
    img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, border=1, box_size=10)
    (SITE / "assets/qr.svg").write_bytes(img.to_string())
    print("wrote site/assets/qr.svg ->", url)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("number", nargs="?", help="international format, digits only, e.g. 2348012345678")
    p.add_argument("--placeholder", action="store_true")
    a = p.parse_args()

    if a.placeholder:
        write_qr("https://soro.charavol.com/#start")
        return
    if not a.number or not re.fullmatch(r"234\d{10}", a.number):
        raise SystemExit("number must look like 2348012345678")

    for page in SITE.glob("*.html"):
        text = page.read_text()
        if PLACEHOLDER in text:
            page.write_text(text.replace(PLACEHOLDER, a.number))
            print("updated", page.name)
    write_qr(f"https://wa.me/{a.number}?text=" + quote("Hi Sọ̀rọ̀" + hide_tag("QR")))


if __name__ == "__main__":
    main()
