"""Generate the synthetic, redistributable offline image-codec PDF fixture.

Requires Pillow with JPEG2000 and libtiff support. No external artwork/fonts.
Two 72 pt square pages render to 200 x 200 pixels at 200 DPI. At quadrant
centres (50,50), (150,50), (50,150), (150,150), expected RGB values are:
  page 1: red, green, blue, white; page 2: black, white, white, black.
The JPEG2000 stream is lossless. Group 4 uses BlackIs1 and the default PDF
Decode array, preserving the source image's black and white quadrants.
"""

from io import BytesIO
from pathlib import Path

from PIL import Image, features


def stream(dictionary: str, data: bytes) -> bytes:
    return f"<< {dictionary} /Length {len(data)} >>\nstream\n".encode("ascii") + data + b"\nendstream"


def make_pdf(objects: list[bytes]) -> bytes:
    output = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode("ascii") + value + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii"))
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    )
    return bytes(output)


def main() -> None:
    assert features.check("jpg_2000"), "Pillow needs JPEG2000 support"
    assert features.check("libtiff"), "Pillow needs libtiff support"
    width = height = 40
    rgb = Image.new("RGB", (width, height))
    mono = Image.new("1", (width, height))
    colors = ((255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255))
    for y in range(height):
        for x in range(width):
            quadrant = (2 if y >= 20 else 0) + (1 if x >= 20 else 0)
            rgb.putpixel((x, y), colors[quadrant])
            mono.putpixel((x, y), 0 if quadrant in (0, 3) else 255)
    jp2 = BytesIO()
    rgb.save(jp2, format="JPEG2000", irreversible=False, no_jp2=True)
    assert Image.open(BytesIO(jp2.getvalue())).tobytes() == rgb.tobytes()
    tiff = BytesIO()
    mono.save(tiff, format="TIFF", compression="group4")
    tiff_bytes = tiff.getvalue()
    with Image.open(BytesIO(tiff_bytes)) as image:
        assert image.tobytes() == mono.tobytes()
        offsets = tuple(image.tag_v2[273])
        lengths = tuple(image.tag_v2[279])
        assert len(offsets) == len(lengths) == 1
        fax = tiff_bytes[offsets[0] : offsets[0] + lengths[0]]
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >>",
        stream("", b"q 72 0 0 72 0 0 cm /Im Do Q\n"),
        stream("/Type /XObject /Subtype /Image /Width 40 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Interpolate false", jp2.getvalue()),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << /XObject << /Im 8 0 R >> >> /Contents 7 0 R >>",
        stream("", b"q 72 0 0 72 0 0 cm /Im Do Q\n"),
        stream("/Type /XObject /Subtype /Image /Width 40 /Height 40 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 40 /Rows 40 /BlackIs1 true >> /Interpolate false", fax),
    ]
    destination = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "codec-images.pdf"
    destination.write_bytes(make_pdf(objects))
    print(f"Wrote {destination}: {destination.stat().st_size} bytes")


if __name__ == "__main__":
    main()
