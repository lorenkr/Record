"""Spotify Vinyl Player — a turntable that spins whatever you're playing on Spotify.

Everything (record, label, tonearm) is drawn as vectors at the screen's native
resolution, so it stays sharp on Retina displays and at any window size.

Keys:  F / double-click  full screen     T  always on top     Esc  leave full screen
Run:   python record.py            (or double-click "Vinyl Player.command")
       python record.py --demo     (no Spotify needed, shows a sample record)
"""
import colorsys
import getpass
import math
import os
import random
import subprocess
import sys
import threading
import time
from io import BytesIO
from pathlib import Path

os.environ.setdefault("QT_LOGGING_RULES", "qt.qpa.keymapper=false")

import requests
from PIL import Image, ImageStat
from PySide6.QtCore import QElapsedTimer, QObject, QPointF, QRectF, QSettings, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import (
    QColor, QConicalGradient, QDesktopServices, QFont, QFontMetricsF, QIcon, QImage, QKeySequence,
    QLinearGradient, QPainter, QPainterPath, QPen, QPixmap, QRadialGradient, QShortcut,
)
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWidgets import QApplication, QInputDialog, QMenu, QMessageBox, QWidget

APP_DIR = Path(__file__).resolve().parent

# --- Behaviour -------------------------------------------------------------
POLL_SECONDS = 1.5          # how often Spotify is asked what's playing
RPM = 9.0                   # calm, easy-to-follow spin (a real LP turns at 33⅓)
DISC_DEG_PER_SEC = RPM * 360 / 60

# --- Turntable geometry (in units of the record's radius R) ----------------
LABEL_R = 0.34              # paper label
GROOVE_OUTER = 0.94         # where the needle drops at the start of a song
GROOVE_INNER = 0.48         # where it ends up at the end of a song
PIVOT = (1.04, -0.80)       # tonearm pivot relative to the record's center
ARM_LEN = 1.18              # pivot -> stylus
REST_ANGLE = 78.0           # degrees (screen coords, 90 = straight down)


def arm_angle_for_radius(r):
    """Angle the tonearm must point at so the stylus sits r (in R units) from the center."""
    px, py = PIVOT
    d = math.hypot(px, py)
    cos_phi = (ARM_LEN ** 2 + d ** 2 - r ** 2) / (2 * ARM_LEN * d)
    phi = math.degrees(math.acos(max(-1.0, min(1.0, cos_phi))))
    to_center = math.degrees(math.atan2(-py, -px))
    return to_center - phi


# ===========================================================================
#  Rendering helpers (all produce images at device-pixel resolution)
# ===========================================================================
def _new_image(n):
    img = QImage(n, n, QImage.Format_ARGB32_Premultiplied)
    img.fill(Qt.transparent)
    return img


def render_disc(n):
    """The black vinyl (grooves, track gaps, rim, dust). Rotates with the record."""
    img = _new_image(n)
    p = QPainter(img)
    p.setRenderHint(QPainter.Antialiasing)
    c = QPointF(n / 2, n / 2)
    R = n / 2
    rnd = random.Random(33)

    g = QRadialGradient(c, R)
    g.setColorAt(0.0, QColor(30, 30, 32))
    g.setColorAt(1.0, QColor(12, 12, 13))
    p.setPen(Qt.NoPen)
    p.setBrush(g)
    p.drawEllipse(c, R, R)

    # Run-out area between label and music: smooth and glossy.
    p.setBrush(QColor(20, 20, 22))
    p.drawEllipse(c, R * (LABEL_R + 0.10), R * (LABEL_R + 0.10))

    # Grooves: many fine concentric rings with slightly varying brightness.
    start, end = R * (LABEL_R + 0.10), R * 0.965
    gaps = sorted(rnd.uniform(start + R * 0.05, end - R * 0.05) for _ in range(6))
    step = max(1.0, n / 900)
    p.setBrush(Qt.NoBrush)
    r = start
    while r < end:
        if not any(abs(r - gp) < R * 0.009 for gp in gaps):
            pen = QPen(QColor(255, 255, 255, rnd.randint(5, 17)))
            pen.setWidthF(step * 0.55)
            p.setPen(pen)
            p.drawEllipse(c, r, r)
        r += step

    # Track gaps: thin glossy bands between songs.
    for gp in gaps:
        pen = QPen(QColor(48, 48, 52, 200))
        pen.setWidthF(R * 0.012)
        p.setPen(pen)
        p.drawEllipse(c, gp, gp)

    # Lead-in groove and rounded rim.
    pen = QPen(QColor(40, 40, 44))
    pen.setWidthF(R * 0.02)
    p.setPen(pen)
    p.drawEllipse(c, R * 0.978, R * 0.978)
    rim = QPen(QColor(85, 85, 90, 220))
    rim.setWidthF(max(1.0, R * 0.006))
    p.setPen(rim)
    p.drawEllipse(c, R - rim.widthF() / 2, R - rim.widthF() / 2)

    # Uneven sheen pressed into the vinyl. Unlike the fixed reflection, this turns with the
    # record, so you can see the whole disc spinning, not just the label.
    ring = QPainterPath()
    ring.addEllipse(c, R * 0.97, R * 0.97)
    inner = QPainterPath()
    inner.addEllipse(c, R * (LABEL_R + 0.02), R * (LABEL_R + 0.02))
    p.save()
    p.setClipPath(ring.subtracted(inner))
    cone = QConicalGradient(c, rnd.uniform(0, 360))
    for pos, a in [(0.0, 0), (0.07, 30), (0.16, 4), (0.31, 22), (0.42, 0), (0.58, 14),
                   (0.66, 36), (0.75, 6), (0.88, 20), (1.0, 0)]:
        cone.setColorAt(pos, QColor(255, 255, 255, a))
    p.fillRect(img.rect(), cone)
    p.restore()

    # A few hairline scratches.
    p.setBrush(Qt.NoBrush)
    for _ in range(7):
        rr = rnd.uniform(R * (LABEL_R + 0.12), R * 0.93)
        start_deg = rnd.uniform(0, 360)
        span = rnd.uniform(8, 28)
        pen = QPen(QColor(255, 255, 255, rnd.randint(35, 70)))
        pen.setWidthF(max(0.8, step * 0.8))
        pen.setCapStyle(Qt.RoundCap)
        p.setPen(pen)
        p.drawArc(QRectF(c.x() - rr, c.y() - rr, 2 * rr, 2 * rr), int(start_deg * 16), int(span * 16))

    # A little dust — it turns with the record and makes the spin readable.
    p.setPen(Qt.NoPen)
    for _ in range(int(110 + n / 8)):
        a = rnd.uniform(0, math.tau)
        rr = rnd.uniform(R * (LABEL_R + 0.02), R * 0.97)
        s = rnd.uniform(0.5, 1.6) * step
        p.setBrush(QColor(255, 255, 255, rnd.randint(25, 75)))
        p.drawEllipse(QPointF(c.x() + rr * math.cos(a), c.y() + rr * math.sin(a)), s, s)
    p.end()
    return img


def render_sheen(n):
    """Light reflected by the grooves. It does NOT rotate — exactly like on a real record."""
    img = _new_image(n)
    p = QPainter(img)
    p.setRenderHint(QPainter.Antialiasing)
    c = QPointF(n / 2, n / 2)
    R = n / 2

    ring = QPainterPath()
    ring.addEllipse(c, R * 0.995, R * 0.995)
    hole = QPainterPath()
    hole.addEllipse(c, R * LABEL_R, R * LABEL_R)
    ring = ring.subtracted(hole)
    p.setClipPath(ring)

    cone = QConicalGradient(c, 128)
    for pos, a in [(0.0, 0), (0.06, 26), (0.10, 70), (0.14, 26), (0.22, 0),
                   (0.50, 0), (0.56, 22), (0.60, 58), (0.64, 22), (0.72, 0), (1.0, 0)]:
        cone.setColorAt(pos, QColor(255, 255, 255, a))
    p.fillRect(img.rect(), cone)

    # Soft overall light from the top-left, darker towards the bottom-right.
    lin = QLinearGradient(0, 0, n, n)
    lin.setColorAt(0.0, QColor(255, 255, 255, 18))
    lin.setColorAt(0.5, QColor(255, 255, 255, 0))
    lin.setColorAt(1.0, QColor(0, 0, 0, 50))
    p.fillRect(img.rect(), lin)
    p.end()
    return img


def render_label(art, n):
    """Circular paper label: album art, or a classic red label when there's none."""
    img = _new_image(n)
    p = QPainter(img)
    p.setRenderHint(QPainter.Antialiasing)
    p.setRenderHint(QPainter.SmoothPixmapTransform)
    c = QPointF(n / 2, n / 2)
    r = n / 2
    clip = QPainterPath()
    clip.addEllipse(c, r, r)
    p.setClipPath(clip)

    if art is not None and not art.isNull():
        p.drawImage(QRectF(0, 0, n, n), art)
    else:
        g = QRadialGradient(c, r)
        g.setColorAt(0, QColor(190, 40, 45))
        g.setColorAt(1, QColor(120, 18, 24))
        p.fillRect(img.rect(), g)
        pen = QPen(QColor(255, 225, 200, 130))
        pen.setWidthF(max(1.0, n / 160))
        p.setPen(pen)
        p.setBrush(Qt.NoBrush)
        p.drawEllipse(c, r * 0.88, r * 0.88)
        p.drawEllipse(c, r * 0.30, r * 0.30)
        f = QFont()
        f.setPixelSize(max(6, int(n * 0.11)))
        f.setWeight(QFont.DemiBold)
        f.setLetterSpacing(QFont.PercentageSpacing, 112)
        p.setFont(f)
        p.setPen(QColor(255, 230, 205, 220))
        p.drawText(QRectF(0, n * 0.16, n, n * 0.2), Qt.AlignCenter, "VINYL")
        f.setPixelSize(max(5, int(n * 0.07)))
        p.setFont(f)
        p.drawText(QRectF(0, n * 0.66, n, n * 0.14), Qt.AlignCenter, "33⅓ RPM")

    # Paper look: slight vignette and a pressed edge.
    v = QRadialGradient(c, r)
    v.setColorAt(0.0, QColor(0, 0, 0, 0))
    v.setColorAt(0.75, QColor(0, 0, 0, 10))
    v.setColorAt(1.0, QColor(0, 0, 0, 90))
    p.fillRect(img.rect(), v)
    p.setClipping(False)
    edge = QPen(QColor(0, 0, 0, 120))
    edge.setWidthF(max(1.0, n / 220))
    p.setPen(edge)
    p.setBrush(Qt.NoBrush)
    p.drawEllipse(c, r - edge.widthF() / 2, r - edge.widthF() / 2)
    p.end()
    return img


def _metal(p, rect_or_center, radius=None, angle=0):
    """Brushed-aluminium brush (conical gradient)."""
    cone = QConicalGradient(rect_or_center, angle)
    stops = [(0.0, 150), (0.12, 235), (0.25, 120), (0.38, 205), (0.5, 140),
             (0.62, 230), (0.75, 115), (0.88, 200), (1.0, 150)]
    for pos, v in stops:
        cone.setColorAt(pos, QColor(v, v, v + 4))
    return cone


def _chrome_linear(y0, y1):
    g = QLinearGradient(0, y0, 0, y1)
    g.setColorAt(0.0, QColor(70, 70, 75))
    g.setColorAt(0.30, QColor(245, 245, 250))
    g.setColorAt(0.55, QColor(160, 160, 166))
    g.setColorAt(1.0, QColor(55, 55, 60))
    return g


# ===========================================================================
#  Tonearm (vector, drawn in R units)
# ===========================================================================
def _arm_paths():
    """Geometry of the moving part of the arm, in R units, pivot at (0,0), stylus at (ARM_LEN, 0)."""
    L = ARM_LEN
    joint = QPointF(L - 0.20, -0.065)
    tube = QPainterPath(QPointF(-0.15, 0))
    tube.cubicTo(QPointF(0.40 * L, 0.0), QPointF(0.68 * L, 0.07), joint)
    head_angle = math.degrees(math.atan2(-joint.y(), L - joint.x()))
    head_len = math.hypot(L - joint.x(), joint.y())
    return tube, joint, head_angle, head_len


def draw_tonearm(p, P, R, angle, lift, shadow_only=False):
    tube, joint, head_angle, head_len = _arm_paths()
    p.save()
    p.translate(P)
    p.scale(R, R)
    p.rotate(angle)
    if lift:
        p.scale(1 + 0.015 * lift, 1 + 0.015 * lift)

    # Counterweight
    cw = QRectF(-0.36, -0.085, 0.21, 0.17)
    p.setPen(Qt.NoPen)
    p.setBrush(QColor(0, 0, 0) if shadow_only else _chrome_linear(-0.085, 0.085))
    p.drawRoundedRect(cw, 0.025, 0.025)
    if not shadow_only:
        knurl = QPen(QColor(0, 0, 0, 70))
        knurl.setWidthF(0.006)
        p.setPen(knurl)
        for i in range(1, 8):
            x = cw.left() + cw.width() * i / 8
            p.drawLine(QPointF(x, cw.top() + 0.01), QPointF(x, cw.bottom() - 0.01))

    # Tube (chrome: dark body, bright core, specular line)
    def stroke(path, color, width, dy=0.0):
        pen = QPen(color)
        pen.setWidthF(width)
        pen.setCapStyle(Qt.RoundCap)
        p.setPen(pen)
        p.setBrush(Qt.NoBrush)
        if dy:
            p.save()
            p.translate(0, dy)
        p.drawPath(path)
        if dy:
            p.restore()

    if shadow_only:
        stroke(tube, QColor(0, 0, 0), 0.05)
    else:
        stroke(tube, QColor(55, 55, 60), 0.046)
        stroke(tube, QColor(165, 165, 172), 0.032, -0.002)
        stroke(tube, QColor(215, 215, 222), 0.016, -0.006)
        stroke(tube, QColor(255, 255, 255, 230), 0.005, -0.009)

    # Headshell, angled like a real offset arm.
    p.translate(joint)
    p.rotate(head_angle)
    hl = head_len
    shell = QPainterPath(QPointF(-0.01, -0.03))
    shell.lineTo(hl - 0.10, -0.055)
    shell.lineTo(hl + 0.035, -0.052)
    shell.lineTo(hl + 0.035, 0.052)
    shell.lineTo(hl - 0.10, 0.055)
    shell.lineTo(-0.01, 0.03)
    shell.closeSubpath()
    finger = QPainterPath(QPointF(0.07, -0.045))
    finger.cubicTo(QPointF(0.10, -0.12), QPointF(0.15, -0.14), QPointF(0.20, -0.135))

    if shadow_only:
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(0, 0, 0))
        p.drawPath(shell)
        stroke(finger, QColor(0, 0, 0), 0.02)
    else:
        stroke(finger, QColor(60, 60, 65), 0.022)
        stroke(finger, QColor(225, 225, 232), 0.010, -0.002)
        g = QLinearGradient(0, -0.055, 0, 0.055)
        g.setColorAt(0.0, QColor(95, 95, 102))
        g.setColorAt(0.35, QColor(58, 58, 64))
        g.setColorAt(1.0, QColor(28, 28, 32))
        edge = QPen(QColor(150, 150, 158, 160))
        edge.setWidthF(0.004)
        p.setPen(edge)
        p.setBrush(g)
        p.drawPath(shell)
        # collar where the headshell plugs into the tube
        p.setPen(Qt.NoPen)
        p.setBrush(_chrome_linear(-0.033, 0.033))
        p.drawRoundedRect(QRectF(-0.035, -0.033, 0.05, 0.066), 0.01, 0.01)
        # cartridge
        cart = QRectF(hl - 0.085, -0.04, 0.105, 0.08)
        cg = QLinearGradient(0, cart.top(), 0, cart.bottom())
        cg.setColorAt(0.0, QColor(48, 48, 52))
        cg.setColorAt(0.4, QColor(18, 18, 20))
        cg.setColorAt(1.0, QColor(6, 6, 7))
        p.setBrush(cg)
        p.drawRoundedRect(cart, 0.012, 0.012)
        p.setBrush(QColor(170, 30, 36))
        p.drawRect(QRectF(cart.left() + 0.012, -0.04, 0.012, 0.08))
        # mounting screws
        p.setBrush(QColor(200, 200, 206))
        for y in (-0.033, 0.033):
            p.drawEllipse(QPointF(hl - 0.05, y), 0.008, 0.008)
    p.restore()


def draw_arm_base(p, P, R, rest_point):
    """The static parts: shadow, plinth, arm rest and cue lever."""
    p.save()
    p.translate(P)
    p.scale(R, R)
    p.setPen(Qt.NoPen)
    sh = QRadialGradient(QPointF(0.04, 0.06), 0.30)
    sh.setColorAt(0.0, QColor(0, 0, 0, 150))
    sh.setColorAt(0.7, QColor(0, 0, 0, 90))
    sh.setColorAt(1.0, QColor(0, 0, 0, 0))
    p.setBrush(sh)
    p.drawEllipse(QPointF(0.04, 0.06), 0.30, 0.30)

    # cue lever
    for color, w in ((QColor(0, 0, 0, 90), 0.05), (QColor(70, 70, 75), 0.034), (QColor(215, 215, 222), 0.014)):
        pen = QPen(color, w)
        pen.setCapStyle(Qt.RoundCap)
        p.setPen(pen)
        dy = 0.012 if color.alpha() < 255 else 0
        p.drawLine(QPointF(0.16, 0.16 + dy), QPointF(0.30, 0.31 + dy))
    p.setPen(Qt.NoPen)
    p.setBrush(_metal(p, QPointF(0.30, 0.31), angle=40))
    p.drawEllipse(QPointF(0.30, 0.31), 0.035, 0.035)

    # plinth
    p.setBrush(_metal(p, QPointF(0, 0), angle=30))
    p.drawEllipse(QPointF(0, 0), 0.22, 0.22)
    ring = QPen(QColor(30, 30, 34, 200), 0.008)
    p.setPen(ring)
    p.setBrush(Qt.NoBrush)
    p.drawEllipse(QPointF(0, 0), 0.216, 0.216)
    p.setPen(Qt.NoPen)
    inner = QRadialGradient(QPointF(-0.03, -0.03), 0.16)
    inner.setColorAt(0, QColor(70, 70, 76))
    inner.setColorAt(1, QColor(22, 22, 25))
    p.setBrush(inner)
    p.drawEllipse(QPointF(0, 0), 0.135, 0.135)
    p.restore()

    # arm rest post (in window coords, so it stays put)
    p.save()
    p.translate(rest_point)
    p.scale(R, R)
    p.setPen(Qt.NoPen)
    p.setBrush(QColor(0, 0, 0, 110))
    p.drawEllipse(QPointF(0.015, 0.025), 0.05, 0.05)
    post = QRadialGradient(QPointF(-0.012, -0.012), 0.05)
    post.setColorAt(0, QColor(120, 120, 128))
    post.setColorAt(1, QColor(30, 30, 34))
    p.setBrush(post)
    p.drawEllipse(QPointF(0, 0), 0.042, 0.042)
    p.restore()


def draw_pivot_cap(p, P, R):
    p.save()
    p.translate(P)
    p.scale(R, R)
    p.setPen(Qt.NoPen)
    p.setBrush(QColor(0, 0, 0, 90))
    p.drawEllipse(QPointF(0.01, 0.015), 0.085, 0.085)
    p.setBrush(_metal(p, QPointF(0, 0), angle=70))
    p.drawEllipse(QPointF(0, 0), 0.08, 0.08)
    hi = QRadialGradient(QPointF(-0.02, -0.025), 0.05)
    hi.setColorAt(0, QColor(255, 255, 255, 200))
    hi.setColorAt(1, QColor(255, 255, 255, 0))
    p.setBrush(hi)
    p.drawEllipse(QPointF(0, 0), 0.08, 0.08)
    p.setBrush(QColor(40, 40, 44))
    p.drawEllipse(QPointF(0, 0), 0.018, 0.018)
    p.restore()


# ===========================================================================
#  Spotify polling (background thread — the window never freezes)
# ===========================================================================
def _pil_to_qimage(im):
    im = im.convert("RGBA")
    data = im.tobytes("raw", "RGBA")
    return QImage(data, im.width, im.height, im.width * 4, QImage.Format_RGBA8888).copy()


def process_art(raw):
    im = raw.convert("RGB")
    w, h = im.size
    s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    label = im.resize((720, 720), Image.LANCZOS)
    lum = ImageStat.Stat(im.convert("L")).mean[0] / 255
    return {"label": _pil_to_qimage(label), "palette": extract_palette(im), "lum": lum}


def extract_palette(im, k=5):
    """The cover's most prominent colors, vivid ones first, made bolder for the background."""
    q = im.convert("RGB").resize((96, 96)).quantize(colors=10, method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette()
    found = []
    for count, idx in q.getcolors():
        r, g, b = pal[idx * 3: idx * 3 + 3]
        mx, mn = max(r, g, b), min(r, g, b)
        sat = (mx - mn) / mx if mx else 0
        found.append((count * (0.35 + sat) * (0.4 + mx / 255), (r, g, b)))
    found.sort(reverse=True)
    picked = []
    for _, c in found:   # skip near-duplicates
        if all(sum((a - b) ** 2 for a, b in zip(c, o)) > 45 ** 2 for o in picked):
            picked.append(c)
        if len(picked) == k:
            break
    out = []
    for r, g, b in picked or [(110, 80, 200)]:
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s > 0.08:   # colorful: push saturation and brightness so it doesn't turn grey
            s = min(1.0, s * 1.45 + 0.12)
            v = min(1.0, max(v, 0.5) * 1.15)
        out.append(tuple(int(c * 255) for c in colorsys.hsv_to_rgb(h, s, v)))
    while len(out) < 3:
        out.append(out[-1])
    return out


class SpotifyWorker(QObject):
    playback = Signal(dict)
    artwork = Signal(str, dict)
    status = Signal(str, str)  # kind, message

    def __init__(self, client):
        super().__init__()
        self.client = client
        self._wake = threading.Event()
        self._art_url = None
        self.active = True   # False while the window is hidden: don't poll Spotify for nothing

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def poke(self):
        self._wake.set()

    def _run(self):
        while True:
            delay = POLL_SECONDS
            if not self.active:
                self._wake.wait(2)
                self._wake.clear()
                continue
            try:
                if not self.client.configured:
                    self.status.emit("config", "")
                    delay = 10
                elif not self.client.is_authorized():
                    self.status.emit("auth", "")
                    delay = 3
                else:
                    info = self.client.now_playing()
                    info["fetched_at"] = time.monotonic()
                    self.status.emit("ok", "")
                    self.playback.emit(info)
                    url = info.get("image_url")
                    if url and url != self._art_url:
                        resp = requests.get(url, timeout=10)
                        resp.raise_for_status()
                        art = process_art(Image.open(BytesIO(resp.content)))
                        self._art_url = url
                        self.artwork.emit(url, art)
            except Exception as e:  # network down, Spotify hiccup, …
                print(f"Spotify: {e}", file=sys.stderr)
                self.status.emit("offline", "")
                delay = 5
            self._wake.wait(delay)
            self._wake.clear()


# ===========================================================================
#  The window
# ===========================================================================
_GRAIN = {}


def _grain_tile(dpr):
    """A 512px tile of film grain, made once and repeated across the background."""
    if dpr not in _GRAIN:
        pm = QPixmap.fromImage(_pil_to_qimage(Image.effect_noise((512, 512), 110).convert("RGB")))
        pm.setDevicePixelRatio(dpr)
        _GRAIN[dpr] = pm
    return _GRAIN[dpr]


class Turntable(QWidget):
    def __init__(self, client=None, follow_spotify=False):
        super().__init__()
        self.client = client
        self.follow_spotify = follow_spotify
        self._quitting = False
        self.setAttribute(Qt.WA_ShowWithoutActivating, follow_spotify)  # don't steal focus from Spotify
        self.setWindowTitle("Vinyl Player")
        self.setMinimumSize(300, 100)   # can shrink to a small mini-player
        self.settings = QSettings("lorenkr", "VinylPlayer")
        geo = self.settings.value("geometry")
        if geo is None or not self.restoreGeometry(geo):
            self.resize(560, 190)
        if self.settings.value("on_top", True, type=bool):
            self.setWindowFlag(Qt.WindowStaysOnTopHint, True)
        # Glass title bar: the artwork runs all the way up, only the traffic lights float on it.
        self.setWindowFlag(Qt.ExpandedClientAreaHint, True)
        self.setWindowFlag(Qt.NoTitleBarBackgroundHint, True)
        self._press_pos = None

        self.track = None             # last known track (kept while paused / idle)
        self.state = "idle"           # playing | paused | idle
        self.status_kind = "starting"
        self.art, self.prev_art, self.art_fade = None, None, 1.0
        self.disc_angle, self.disc_speed = 0.0, 0.0
        self.arm_angle, self.arm_lift = REST_ANGLE, 0.35
        self._cache = {}
        self._text_cache = None
        self.hint_until = time.monotonic() + 6

        self.clock = QElapsedTimer()
        self.clock.start()
        self.last_t = 0.0
        self.timer = QTimer(self)
        self.timer.setTimerType(Qt.PreciseTimer)
        self.timer.timeout.connect(self.tick)
        self.timer.start(16)

        QShortcut(QKeySequence.Quit, self, self.close)
        QShortcut(QKeySequence.Close, self, self.close)

        if follow_spotify:
            self._spotify_was_running = None
            self.spotify_timer = QTimer(self)
            self.spotify_timer.timeout.connect(self.check_spotify_app)
            self.spotify_timer.start(2000)

        if client is not None:
            self.worker = SpotifyWorker(client)
            self.worker.playback.connect(self.on_playback)
            self.worker.artwork.connect(self.on_artwork)
            self.worker.status.connect(self.on_status)
            self.worker.start()

    # --- data from Spotify ---------------------------------------------
    def on_playback(self, info):
        if info.get("state") == "ok":
            if not self.track or self.track.get("id") != info.get("id"):
                self._text_cache = None
            self.track = info
            self.state = "playing" if info["is_playing"] else "paused"
        else:
            if self.state != "idle":
                self._text_cache = None
            self.state = "idle"
        self.wake()

    def on_artwork(self, url, art):
        self.prev_art, self.art, self.art_fade = self.art, art, 0.0
        self._cache = {k: v for k, v in self._cache.items() if k[0] not in ("bg", "label")}
        self.wake()

    def on_status(self, kind, _msg):
        if kind != self.status_kind:
            self.status_kind = kind
            self._text_cache = None
            self.wake()

    # --- animation -------------------------------------------------------
    def wake(self):
        if self.timer.interval() != 16:
            self.timer.setInterval(16)
        self.update()

    def progress_fraction(self):
        t = self.track
        if not t or not t.get("duration_ms"):
            return 0.0
        ms = t["progress_ms"]
        if self.state == "playing":
            ms += (time.monotonic() - t["fetched_at"]) * 1000
        return max(0.0, min(1.0, ms / t["duration_ms"]))

    def tick(self):
        now = self.clock.elapsed() / 1000
        dt = min(0.1, now - self.last_t)
        self.last_t = now
        playing = self.state == "playing"

        # Platter: spins up in about a second, coasts down a little slower.
        target = DISC_DEG_PER_SEC if playing else 0.0
        k = 1 - math.exp(-dt * (3.0 if playing else 1.8))
        self.disc_speed += (target - self.disc_speed) * k
        if not playing and self.disc_speed < 0.3:
            self.disc_speed = 0.0
        self.disc_angle = (self.disc_angle + self.disc_speed * dt) % 360

        # Tonearm: lift, swing, lower — like cueing a real record.
        on_record = self.track is not None and self.state in ("playing", "paused")
        if on_record:
            r = GROOVE_OUTER - (GROOVE_OUTER - GROOVE_INNER) * self.progress_fraction()
            desired = arm_angle_for_radius(r)
        else:
            desired = REST_ANGLE
        diff = desired - self.arm_angle
        moving = abs(diff) > 0.6
        if moving or self.state == "paused":
            lift_target = 1.0
        elif playing:
            lift_target = 0.0
        else:
            lift_target = 0.35   # resting on the arm rest
        step = dt * 1.8
        self.arm_lift += max(-step, min(step, lift_target - self.arm_lift))
        if moving and self.arm_lift > 0.9:
            move = diff * (1 - math.exp(-dt * 3.2))
            limit = 70 * dt
            self.arm_angle += max(-limit, min(limit, move))
        elif not moving:
            self.arm_angle = desired

        self.art_fade = min(1.0, self.art_fade + dt / 0.8)

        if not self.isVisible():
            self.timer.setInterval(1000)
            return
        busy = (self.disc_speed > 0 or moving or abs(lift_target - self.arm_lift) > 1e-3
                or self.art_fade < 1.0 or time.monotonic() < self.hint_until)
        want = 16 if busy else 250  # idle: barely any CPU
        if self.timer.interval() != want:
            self.timer.setInterval(want)
        self.update()

    # --- input -----------------------------------------------------------
    def toggle_fullscreen(self):
        self.showNormal() if self.isFullScreen() else self.showFullScreen()

    def toggle_on_top(self):
        on = not bool(self.windowFlags() & Qt.WindowStaysOnTopHint)
        self.setWindowFlag(Qt.WindowStaysOnTopHint, on)
        self.settings.setValue("on_top", on)
        self.show()
        self.hint_text = "Always on top: on" if on else "Always on top: off"
        self.hint_until = time.monotonic() + 2
        self.wake()

    # Physical key positions (macOS virtual key codes), so F / T also work with a Hebrew layout.
    MAC_KEY_F, MAC_KEY_T = 3, 17

    def keyPressEvent(self, e):
        vk = e.nativeVirtualKey()
        if e.modifiers() & (Qt.ControlModifier | Qt.MetaModifier | Qt.AltModifier):
            return super().keyPressEvent(e)
        if e.key() == Qt.Key_F or vk == self.MAC_KEY_F:
            self.toggle_fullscreen()
        elif e.key() == Qt.Key_T or vk == self.MAC_KEY_T:
            self.toggle_on_top()
        elif e.key() == Qt.Key_Escape and self.isFullScreen():
            self.showNormal()
        else:
            super().keyPressEvent(e)

    def mouseDoubleClickEvent(self, _e):
        self.toggle_fullscreen()

    # The title bar is see-through, so the whole window can be dragged to move it.
    def mousePressEvent(self, e):
        self._press_pos = e.position() if e.button() == Qt.LeftButton else None

    def mouseMoveEvent(self, e):
        if self._press_pos is not None and (e.position() - self._press_pos).manhattanLength() > 4:
            self._press_pos = None
            if self.windowHandle():
                self.windowHandle().startSystemMove()

    def mouseReleaseEvent(self, e):
        clicked = self._press_pos is not None
        self._press_pos = None
        if clicked and self.status_kind == "auth":
            self.connect_spotify()

    def showEvent(self, e):
        super().showEvent(e)
        QTimer.singleShot(0, self._hide_native_title)

    def _hide_native_title(self):
        """Hide the 'Vinyl Player' text in the title bar (macOS)."""
        try:
            import objc
            from AppKit import NSWindowTitleHidden
            win = objc.objc_object(c_void_p=int(self.winId())).window()
            if win is not None:
                win.setTitleVisibility_(NSWindowTitleHidden)
                win.setTitlebarAppearsTransparent_(True)
        except Exception:
            pass

    def connect_spotify(self):
        QDesktopServices.openUrl(QUrl(self.client.authorize_url()))
        text, ok = QInputDialog.getText(
            self, "Connect Spotify",
            "Approve access in the browser window that just opened.\n"
            "You'll land on a new page — copy that page's full address\n"
            "from the address bar and paste it here:")
        if ok and text.strip():
            try:
                self.client.complete_auth(text)
                self.worker.poke()
            except Exception as e:
                QMessageBox.warning(self, "Connect Spotify", f"That didn't work, please try again.\n\n{e}")

    def resizeEvent(self, e):
        self._text_cache = None
        # While the window is being dragged, stretch the old background; redraw it sharp once it settles.
        self._resizing_until = time.monotonic() + 0.2
        QTimer.singleShot(250, self.update)
        super().resizeEvent(e)

    def closeEvent(self, e):
        self.settings.setValue("geometry", self.saveGeometry())
        if self.follow_spotify and not self._quitting:
            # Keep running in the background; reappear next time Spotify opens.
            e.ignore()
            self.hide_to_background()
            return
        super().closeEvent(e)
        QApplication.quit()

    # --- follow Spotify --------------------------------------------------
    def check_spotify_app(self):
        running = subprocess.run(["pgrep", "-x", "Spotify"], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL).returncode == 0
        if running and self._spotify_was_running is not True:
            self.bring_to_front(activate=False)
        elif not running and self._spotify_was_running:
            self.hide_to_background()
        self._spotify_was_running = running

    def bring_to_front(self, activate=True):
        set_dock_icon(True)
        if hasattr(self, "worker"):
            self.worker.active = True
            self.worker.poke()
        self.setAttribute(Qt.WA_ShowWithoutActivating, not activate)
        self.show()
        self.raise_()
        if activate:
            try:
                from AppKit import NSApplication
                NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
            except Exception:
                pass
            self.activateWindow()
        self.wake()

    def hide_to_background(self):
        self.settings.setValue("geometry", self.saveGeometry())
        self.hide()
        if hasattr(self, "worker"):
            self.worker.active = False
        set_dock_icon(False)

    def quit_completely(self):
        self._quitting = True
        self.close()
        QApplication.quit()

    def contextMenuEvent(self, e):
        m = QMenu(self)
        top = m.addAction("Always on top")
        top.setCheckable(True)
        top.setChecked(bool(self.windowFlags() & Qt.WindowStaysOnTopHint))
        top.triggered.connect(self.toggle_on_top)
        m.addAction("Exit full screen" if self.isFullScreen() else "Full screen").triggered.connect(self.toggle_fullscreen)
        m.addSeparator()
        if self.follow_spotify:
            m.addAction("Hide until Spotify opens again").triggered.connect(self.hide_to_background)
        m.addAction("Quit Vinyl Player").triggered.connect(self.quit_completely)
        m.exec(e.globalPos())

    # --- layout ----------------------------------------------------------
    def geometry_info(self):
        W, H = self.width(), self.height()
        # The record sits in the middle of the window; the arm needs ~1.4 R on the right.
        R = min(0.41 * H, (W / 2) / 1.45)
        return W, H, R, QPointF(W / 2, H * 0.52)

    def _cached(self, key, factory):
        if key not in self._cache:
            self._cache[key] = factory()
        return self._cache[key]

    def _pixmap(self, img, dpr):
        pm = QPixmap.fromImage(img)
        pm.setDevicePixelRatio(dpr)
        return pm

    # --- painting --------------------------------------------------------
    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        p.setRenderHint(QPainter.SmoothPixmapTransform)
        dpr = self.devicePixelRatioF()
        W, H, R, C = self.geometry_info()

        self.paint_background(p, W, H, R, C, dpr)
        self.paint_record(p, R, C, dpr)
        self.paint_arm(p, R, C)
        self.paint_text(p, W, H, R, C)
        p.end()

    def _bg_pixmap(self, art, W, H, R, C, dpr):
        def make():
            # A grainy mesh gradient of the cover's main colors, with fine rings
            # spreading out from the record like a fingerprint.
            pal = [QColor(*c) for c in art["palette"]]
            pw, ph = max(1, int(W * dpr)), max(1, int(H * dpr))
            out = QImage(pw, ph, QImage.Format_ARGB32_Premultiplied)
            out.setDevicePixelRatio(dpr)
            q = QPainter(out)
            q.setRenderHint(QPainter.Antialiasing)
            q.fillRect(QRectF(0, 0, W, H), pal[0])
            rnd = random.Random(str(art["palette"]))   # same layout every time for a given cover
            spots = [(0.05, 0.10, 0.80), (0.95, 0.05, 0.75), (0.80, 1.00, 0.85),
                     (0.25, 1.05, 0.70), (0.55, 0.40, 0.55)]
            for (fx, fy, fr), col in zip(spots, pal[1:] + pal[:1]):
                g = QRadialGradient(QPointF((fx + rnd.uniform(-0.08, 0.08)) * W,
                                            (fy + rnd.uniform(-0.15, 0.15)) * H), fr * max(W, H) * 0.7)
                c = QColor(col)
                for stop, a in ((0.0, 255), (0.4, 200), (0.75, 70), (1.0, 0)):
                    c.setAlpha(a)
                    g.setColorAt(stop, c)
                q.fillRect(QRectF(0, 0, W, H), g)

            dark = QColor(pal[0]).darker(170)
            far = math.hypot(max(C.x(), W - C.x()), max(C.y(), H - C.y()))
            step = max(3.2, R * 0.05)
            r = R * 1.08
            while r < far:
                fade = min(1.0, (r - R * 1.08) / (R * 0.5))
                path = QPainterPath()
                for k in range(181):
                    th = k / 180 * 2 * math.pi
                    rr = r * (1 + 0.025 * math.sin(3 * th + r * 0.013) + 0.012 * math.sin(5 * th - r * 0.02))
                    pt = QPointF(C.x() + rr * math.cos(th), C.y() + rr * math.sin(th) * 0.92)
                    path.moveTo(pt) if k == 0 else path.lineTo(pt)
                # Embossed groove: a light edge just below a darker line.
                q.setPen(QPen(QColor(255, 255, 255, int(70 * fade)), 1.0))
                q.drawPath(path.translated(0.0, 1.0))
                dark.setAlpha(int(140 * fade))
                q.setPen(QPen(dark, 1.3))
                q.drawPath(path)
                r += step

            # Film grain, one speck per screen pixel.
            q.setOpacity(0.28)
            q.setCompositionMode(QPainter.CompositionMode_Overlay)
            q.drawTiledPixmap(QRectF(0, 0, W, H), _grain_tile(dpr))
            q.end()
            return QPixmap.fromImage(out)
        key = ("bg", id(art), W, H, R, C.x(), C.y(), dpr)
        if key not in self._cache and time.monotonic() < getattr(self, "_resizing_until", 0):
            stale = next((v for k, v in self._cache.items() if k[0] == "bg" and k[1] == id(art)), None)
            if stale is not None:
                return stale
        if key not in self._cache:   # don't pile up one per size while the window is resized
            self._cache = {k: v for k, v in self._cache.items()
                           if k[0] != "bg" or k[1] != id(art)}
        return self._cached(key, make)

    def paint_background(self, p, W, H, R, C, dpr):
        p.fillRect(self.rect(), QColor(20, 19, 20))
        for art, alpha in ((self.prev_art, 1.0), (self.art, self.art_fade)):
            if art is not None and alpha > 0:
                p.setOpacity(alpha)
                p.drawPixmap(QRectF(0, 0, W, H), self._bg_pixmap(art, W, H, R, C, dpr), QRectF())
        p.setOpacity(1.0)

        # Readability: a dark veil behind the text on the left (stronger on bright covers) + soft vignette.
        lum = self.art["lum"] if self.art else 0.2
        a = int((110 + 120 * lum) * 0.7)
        text_end = max(1.0, C.x() - R)
        veil = QLinearGradient(0, 0, text_end, 0)
        veil.setColorAt(0.0, QColor(0, 0, 0, a))
        veil.setColorAt(0.7, QColor(0, 0, 0, int(a * 0.6)))
        veil.setColorAt(1.0, QColor(0, 0, 0, 0))
        p.fillRect(QRectF(0, 0, text_end, H), veil)
        vig = QRadialGradient(C, max(W, H) * 0.75)
        vig.setColorAt(0.5, QColor(0, 0, 0, 0))
        vig.setColorAt(1.0, QColor(0, 0, 0, 120))
        p.fillRect(self.rect(), vig)

    def paint_record(self, p, R, C, dpr):
        n = max(8, int(round(2 * R * dpr)))
        ln = max(8, int(round(2 * R * LABEL_R * dpr)))
        disc = self._cached(("disc", n), lambda: self._pixmap(render_disc(n), dpr))
        sheen = self._cached(("sheen", n), lambda: self._pixmap(render_sheen(n), dpr))

        # Shadow under the record
        p.setPen(Qt.NoPen)
        sc = QPointF(C.x() + 0.03 * R, C.y() + 0.07 * R)
        sh = QRadialGradient(sc, 1.13 * R)
        sh.setColorAt(0.0, QColor(0, 0, 0, 170))
        sh.setColorAt(0.86, QColor(0, 0, 0, 120))
        sh.setColorAt(1.0, QColor(0, 0, 0, 0))
        p.setBrush(sh)
        p.drawEllipse(sc, 1.13 * R, 1.13 * R)

        p.save()
        p.translate(C)
        p.rotate(self.disc_angle)  # clockwise, like a real turntable
        p.drawPixmap(QRectF(-R, -R, 2 * R, 2 * R), disc, QRectF())
        lr = R * LABEL_R
        for art, alpha in ((self.prev_art, 1.0), (self.art, self.art_fade)):
            if alpha <= 0 or (art is None and self.prev_art is not None and alpha < 1):
                continue
            lab = self._cached(("label", id(art), ln),
                               lambda a=art: self._pixmap(render_label(a["label"] if a else None, ln), dpr))
            p.setOpacity(alpha)
            p.drawPixmap(QRectF(-lr, -lr, 2 * lr, 2 * lr), lab, QRectF())
        p.setOpacity(1.0)
        p.restore()

        p.drawPixmap(QRectF(C.x() - R, C.y() - R, 2 * R, 2 * R), sheen, QRectF())


    def paint_arm(self, p, R, C):
        P = QPointF(C.x() + PIVOT[0] * R, C.y() + PIVOT[1] * R)
        rest_a = math.radians(REST_ANGLE)
        rest_point = QPointF(P.x() + math.cos(rest_a) * ARM_LEN * 0.74 * R,
                             P.y() + math.sin(rest_a) * ARM_LEN * 0.74 * R)
        draw_arm_base(p, P, R, rest_point)

        # Shadow: further away and softer when the arm is lifted.
        off = R * (0.025 + 0.06 * self.arm_lift)
        p.setOpacity(0.32 - 0.12 * self.arm_lift)
        for spread in (0.0, 0.012):
            draw_tonearm(p, QPointF(P.x() + off * 0.6, P.y() + off + spread * R), R,
                         self.arm_angle, self.arm_lift, shadow_only=True)
        p.setOpacity(1.0)
        draw_tonearm(p, P, R, self.arm_angle, self.arm_lift)
        draw_pivot_cap(p, P, R)

    # --- text ------------------------------------------------------------
    def _text_content(self):
        t = self.track
        kind = self.status_kind
        if kind == "config":
            return ("SETUP NEEDED", "Add your Spotify keys",
                    "Put CLIENT_ID and CLIENT_SECRET in the .env file", "")
        if kind == "auth":
            return ("WELCOME", "Connect Spotify", "Click anywhere to sign in", "")
        if t is None:
            if kind == "offline":
                return ("OFFLINE", "Can't reach Spotify", "Retrying automatically…", "")
            if kind == "starting":
                return ("", "Connecting…", "", "")
            return ("READY", "Nothing playing", "Start a song on Spotify", "")
        eyebrow = {"playing": "NOW PLAYING", "paused": "PAUSED", "idle": "LAST PLAYED"}[self.state]
        if kind == "offline":
            eyebrow = "OFFLINE · RETRYING"
        return (eyebrow, t["name"], t["artist"], t["album"])

    def _fit_text(self, W, H, x0, x1):
        eyebrow, title, artist, album = self._text_content()
        width = max(60.0, x1 - x0)
        max_h = H * 0.80
        flags = Qt.TextWordWrap | Qt.AlignLeft

        def font(px, weight):
            f = QFont()
            f.setPixelSize(max(9, int(px)))
            f.setWeight(weight)
            return f

        # Small window: keep only what matters most.
        if H < 170:
            eyebrow = ""
        if H < 130:
            album = ""
        size = min(H * 0.16, width * 0.16)
        while True:
            tf = font(size, QFont.Bold)
            af = font(max(9, min(size * 0.52, H * 0.085)), QFont.Medium)
            bf = font(max(8, min(size * 0.40, H * 0.062)), QFont.Normal)
            ef = font(max(8, min(size * 0.30, H * 0.048)), QFont.DemiBold)
            ef.setLetterSpacing(QFont.PercentageSpacing, 118)
            tm = QFontMetricsF(tf)
            tr = tm.boundingRect(QRectF(0, 0, width, 1e5), flags, title)
            lines = round(tr.height() / tm.lineSpacing())
            ar = QFontMetricsF(af).boundingRect(QRectF(0, 0, width, 1e5), flags, artist) if artist else QRectF()
            br = QFontMetricsF(bf).boundingRect(QRectF(0, 0, width, 1e5), flags, album) if album else QRectF()
            er = QFontMetricsF(ef).boundingRect(QRectF(0, 0, width, 1e5), flags, eyebrow) if eyebrow else QRectF()
            gap = tf.pixelSize() * 0.22
            total = er.height() + tr.height() + ar.height() + br.height() + gap * 3
            fits = tr.width() <= width + 1 and lines <= 3 and total <= max_h
            if fits or size <= 10:
                break
            size *= 0.93
        return dict(width=width, total=total, gap=gap,
                    items=[(eyebrow, ef, er, 175), (title, tf, tr, 255), (artist, af, ar, 235), (album, bf, br, 165)])

    def paint_text(self, p, W, H, R, C):
        margin = max(12.0, min(18.0, H * 0.1), H * 0.075)
        x0 = margin
        x1 = C.x() - R - max(10.0, H * 0.06)
        if x1 - x0 < 60:
            return   # too narrow for text: just the turntable
        key = (W, H, x1)
        if not self._text_cache or self._text_cache[0] != key:
            self._text_cache = (key, self._fit_text(W, H, x0, x1))
        L = self._text_cache[1]
        y = C.y() - L["total"] / 2
        width = L["width"]
        flags = Qt.TextWordWrap | Qt.AlignLeft
        for text, f, r, alpha in L["items"]:
            if not text:
                continue
            rect = QRectF(x0, y, width + 2, r.height() + 2)
            p.setFont(f)
            # soft shadow keeps the text readable on any cover
            for dx, dy, a in ((0, 2.0, 90), (0, 1.0, 120)):
                p.setPen(QColor(0, 0, 0, a))
                p.drawText(rect.translated(dx, dy), flags, text)
            p.setPen(QColor(255, 255, 255, alpha))
            p.drawText(rect, flags, text)
            y += r.height() + L["gap"]

        if time.monotonic() < self.hint_until:
            hint = getattr(self, "hint_text", "F  full screen   ·   T  always on top   ·   right-click for more")
            f = QFont()
            f.setPixelSize(max(10, int(H * 0.04)))
            p.setFont(f)
            p.setPen(QColor(255, 255, 255, 130))
            p.drawText(QRectF(x0, H - margin * 0.9, W, margin * 0.8), Qt.AlignLeft | Qt.AlignVCenter, hint)


# ===========================================================================
def make_icon(size=1024):
    img = QImage(size, size, QImage.Format_ARGB32_Premultiplied)
    img.fill(Qt.transparent)
    p = QPainter(img)
    p.setRenderHint(QPainter.Antialiasing)
    p.setRenderHint(QPainter.SmoothPixmapTransform)
    m = size * 0.1
    bg = QLinearGradient(0, 0, size, size)
    bg.setColorAt(0, QColor(60, 54, 50))
    bg.setColorAt(1, QColor(18, 17, 18))
    p.setPen(Qt.NoPen)
    p.setBrush(bg)
    p.drawRoundedRect(QRectF(m, m, size - 2 * m, size - 2 * m), size * 0.18, size * 0.18)
    R = size * 0.30
    C = QPointF(size * 0.45, size * 0.52)
    n = int(2 * R)
    p.drawImage(QRectF(C.x() - R, C.y() - R, 2 * R, 2 * R), render_disc(n))
    lr = R * LABEL_R
    p.drawImage(QRectF(C.x() - lr, C.y() - lr, 2 * lr, 2 * lr), render_label(None, int(2 * lr)))
    p.drawImage(QRectF(C.x() - R, C.y() - R, 2 * R, 2 * R), render_sheen(n))
    P = QPointF(C.x() + PIVOT[0] * R, C.y() + PIVOT[1] * R)
    draw_tonearm(p, P, R, arm_angle_for_radius(0.8), 0)
    draw_pivot_cap(p, P, R)
    p.end()
    return img


def demo_art():
    """A generated 'album cover' so the app can be previewed without Spotify."""
    im = Image.new("RGB", (640, 640))
    px = im.load()
    for y in range(640):
        for x in range(640):
            px[x, y] = (int(230 - y * 0.15), int(120 + x * 0.12), int(90 + (x + y) * 0.1))
    return process_art(im)


def set_dock_icon(visible):
    """Show the Dock icon only while the window is on screen (needs pyobjc; optional)."""
    try:
        from AppKit import (NSApplication, NSApplicationActivationPolicyAccessory,
                            NSApplicationActivationPolicyRegular)
        NSApplication.sharedApplication().setActivationPolicy_(
            NSApplicationActivationPolicyRegular if visible else NSApplicationActivationPolicyAccessory)
    except Exception:
        pass


def _unhide_qt_plugins():
    """macOS can flag files as 'hidden'; Qt then skips its own plugins and won't start."""
    import stat
    import PySide6
    plugins = Path(PySide6.__file__).parent / "Qt" / "plugins"
    for path in [plugins, *plugins.rglob("*")]:
        try:
            flags = os.lstat(path).st_flags
            if flags & stat.UF_HIDDEN:
                os.chflags(path, flags & ~stat.UF_HIDDEN, follow_symlinks=False)
        except (OSError, AttributeError):
            pass


def main():
    _unhide_qt_plugins()
    app = QApplication(sys.argv)
    app.setApplicationName("Vinyl Player")
    app.setWindowIcon(QIcon(QPixmap.fromImage(make_icon(512))))

    if "--icon" in sys.argv:
        make_icon(1024).save(sys.argv[sys.argv.index("--icon") + 1])
        return

    if "--demo" in sys.argv:
        w = Turntable(None)
        w.status_kind = "ok"
        w.on_playback({"state": "ok", "id": "demo", "name": "Song Name", "artist": "Artist",
                       "album": "Album", "is_playing": True, "progress_ms": 60000,
                       "duration_ms": 210000, "fetched_at": time.monotonic()})
        w.on_artwork("demo", demo_art())
        w.show()
        sys.exit(app.exec())

    # Only one copy at a time: opening the app again just brings the window back.
    server_name = f"vinyl-player-{getpass.getuser()}"
    probe = QLocalSocket()
    probe.connectToServer(server_name)
    if probe.waitForConnected(300):
        if "--follow-spotify" in sys.argv and "--show" not in sys.argv:
            return   # background start while already running: nothing to do
        probe.write(b"show")
        probe.flush()
        probe.waitForBytesWritten(300)
        return
    QLocalServer.removeServer(server_name)
    server = QLocalServer()
    server.listen(server_name)

    import spotifyPlay
    follow = "--follow-spotify" in sys.argv
    w = Turntable(spotifyPlay.SpotifyClient(), follow_spotify=follow)
    server.newConnection.connect(lambda: (server.nextPendingConnection(), w.bring_to_front()))
    app.setQuitOnLastWindowClosed(not follow)
    if follow:
        set_dock_icon(False)
        w.worker.active = False
        if "--show" in sys.argv:   # opened by hand (Spotlight / Launchpad / Dock)
            w.bring_to_front()
        w.check_spotify_app()       # shows the window right away if Spotify is already open
    else:
        w.bring_to_front()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
