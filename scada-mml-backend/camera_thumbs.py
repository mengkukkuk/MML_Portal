"""Small JPEG previews of inspection frames, for the camera rail's film strip.

The strip paints ~140 px tiles, but the frames on disk are ~500 KB each and the
browser used to download all thirty of them: ~15 MB to fill one strip, over a
link where a single image already took 5-10 s. A tile needs a few KB. The
full-size file is still served on demand for the lightbox.

Like camera_files this is DB-free and HTTP-free so it can be tested on its own.
Two properties it must keep:

**It never raises into a request.** Pillow missing, a corrupt file, a decompression
bomb: every failure returns None and the router falls back to the original bytes.
A tile that loads slowly is better than a strip that errors.

**The cache is bounded.** One entry is ~10-25 KB; 512 of them is ~10 MB, which
holds several cameras' worth of strips. Keys are chosen by the caller and must
include everything that makes the bytes differ (camera, slot, frame id, width).
"""
import io
import logging
import threading
from collections import OrderedDict
from collections.abc import Hashable

try:  # Pillow is a runtime dependency, but a missing wheel must not break the API.
    from PIL import Image
except ImportError:  # pragma: no cover - exercised only on a broken install
    Image = None

logger = logging.getLogger("mml-api.camera_thumbs")

MIN_WIDTH = 64
MAX_WIDTH = 512
DEFAULT_WIDTH = 240  # ~2x the tile's CSS width, so it stays sharp on HiDPI

# The files are 500 KB PNGs of a few megapixels. Anything claiming far more is
# not an inspection crop, and decoding it is exactly what a decompression bomb
# wants. Pillow raises past this, which `make_thumbnail` turns into None.
_MAX_PIXELS = 40_000_000
if Image is not None:
    Image.MAX_IMAGE_PIXELS = _MAX_PIXELS

_JPEG_QUALITY = 80
_MAX_ENTRIES = 512

_cache: "OrderedDict[Hashable, bytes]" = OrderedDict()
_lock = threading.Lock()


def clamp_width(width: int) -> int:
    return max(MIN_WIDTH, min(int(width), MAX_WIDTH))


def available() -> bool:
    return Image is not None


def make_thumbnail(data: bytes, width: int = DEFAULT_WIDTH) -> bytes | None:
    """Downscale `data` to a JPEG whose longest side is `width`, or None.

    The caller has already sniffed `data` as PNG/JPEG/WebP and enforced the size
    ceiling; this does not re-validate the format, it only refuses to fail loudly.
    """
    if Image is None:
        return None
    width = clamp_width(width)
    try:
        with Image.open(io.BytesIO(data)) as img:
            # JPEG can be decoded at 1/2, 1/4, 1/8 scale for free; a no-op otherwise.
            img.draft("RGB", (width, width))
            img.thumbnail((width, width), Image.Resampling.LANCZOS)
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                # JPEG has no alpha; flatten onto white rather than letting
                # transparent pixels turn black.
                rgba = img.convert("RGBA")
                flat = Image.new("RGB", rgba.size, (255, 255, 255))
                flat.paste(rgba, mask=rgba.getchannel("A"))
                img = flat
            elif img.mode != "RGB":
                img = img.convert("RGB")
            out = io.BytesIO()
            img.save(out, format="JPEG", quality=_JPEG_QUALITY, optimize=True)
            return out.getvalue()
    except Exception:  # noqa: BLE001 - see module docstring: never raise into a request
        logger.warning("thumbnail generation failed", exc_info=True)
        return None


def cached(key: Hashable) -> bytes | None:
    with _lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
        return hit


def remember(key: Hashable, thumb: bytes) -> None:
    with _lock:
        _cache[key] = thumb
        _cache.move_to_end(key)
        while len(_cache) > _MAX_ENTRIES:
            _cache.popitem(last=False)


def clear() -> None:
    """Drop every cached thumbnail. For tests."""
    with _lock:
        _cache.clear()
