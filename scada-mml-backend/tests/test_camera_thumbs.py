"""camera_thumbs: small previews for the film strip. No DB, no HTTP."""
import io
import os

import pytest
from PIL import Image

import camera_thumbs


def _png(size=(900, 600), mode="RGB", noisy=True) -> bytes:
    img = Image.new(mode, size)
    if noisy:
        # Incompressible noise so the PNG is realistically large (hundreds of KB).
        channels = len(img.getbands())
        img.frombytes(os.urandom(size[0] * size[1] * channels))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _clean():
    camera_thumbs.clear()
    yield
    camera_thumbs.clear()


def test_a_large_png_becomes_a_small_jpeg():
    src = _png()
    assert len(src) > 500_000            # the size class that was strangling the link

    thumb = camera_thumbs.make_thumbnail(src, 240)

    assert thumb is not None
    assert thumb[:3] == b"\xff\xd8\xff"
    assert len(thumb) < 0.1 * len(src)
    with Image.open(io.BytesIO(thumb)) as out:
        assert max(out.size) == 240
        assert out.size[0] / out.size[1] == pytest.approx(900 / 600, abs=0.02)


def test_a_small_image_is_not_upscaled():
    thumb = camera_thumbs.make_thumbnail(_png((100, 80), noisy=False), 240)
    with Image.open(io.BytesIO(thumb)) as out:
        assert out.size == (100, 80)


@pytest.mark.parametrize("mode", ["RGBA", "L", "P", "LA"])
def test_other_color_modes_still_produce_a_jpeg(mode):
    thumb = camera_thumbs.make_thumbnail(_png((300, 200), mode, noisy=False), 128)
    assert thumb is not None and thumb[:3] == b"\xff\xd8\xff"


def test_transparent_pixels_flatten_to_white_not_black():
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    thumb = camera_thumbs.make_thumbnail(buf.getvalue(), 64)
    with Image.open(io.BytesIO(thumb)) as out:
        assert min(out.getpixel((10, 10))) > 240


@pytest.mark.parametrize("garbage", [b"", b"not an image", b"\x89PNG\r\n\x1a\n" + b"\x00" * 24])
def test_undecodable_input_returns_none_and_never_raises(garbage):
    assert camera_thumbs.make_thumbnail(garbage, 240) is None


def test_a_decompression_bomb_returns_none():
    # 1-bit, so the file is tiny; the *declared* size is what makes it a bomb.
    side = int((camera_thumbs._MAX_PIXELS * 2) ** 0.5) + 10
    buf = io.BytesIO()
    Image.new("1", (side, side)).save(buf, format="PNG")
    assert len(buf.getvalue()) < 200_000
    assert camera_thumbs.make_thumbnail(buf.getvalue(), 240) is None


def test_missing_pillow_degrades_to_none(monkeypatch):
    monkeypatch.setattr(camera_thumbs, "Image", None)
    assert camera_thumbs.available() is False
    assert camera_thumbs.make_thumbnail(_png((50, 50), noisy=False)) is None


@pytest.mark.parametrize("asked,expected", [(1, 64), (64, 64), (240, 240), (9999, 512), (-5, 64)])
def test_width_is_clamped(asked, expected):
    assert camera_thumbs.clamp_width(asked) == expected


def test_cache_returns_what_was_stored_and_is_bounded(monkeypatch):
    monkeypatch.setattr(camera_thumbs, "_MAX_ENTRIES", 3)
    for i in range(5):
        camera_thumbs.remember(("cam", i), b"x%d" % i)
    assert camera_thumbs.cached(("cam", 0)) is None      # evicted, oldest first
    assert camera_thumbs.cached(("cam", 1)) is None
    assert camera_thumbs.cached(("cam", 4)) == b"x4"


def test_cache_hit_refreshes_recency(monkeypatch):
    monkeypatch.setattr(camera_thumbs, "_MAX_ENTRIES", 2)
    camera_thumbs.remember("a", b"A")
    camera_thumbs.remember("b", b"B")
    camera_thumbs.cached("a")                            # a is now the freshest
    camera_thumbs.remember("c", b"C")
    assert camera_thumbs.cached("b") is None
    assert camera_thumbs.cached("a") == b"A"
