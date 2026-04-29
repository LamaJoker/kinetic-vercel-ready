"""
Génère tous les assets Android (icônes launcher + splash) à partir du logo Kinetic.
Utilise uniquement Pillow — aucune dépendance native Cairo requise.

Logo : éclair #A8FF00 sur fond sombre #111827
"""
import os
import math
from PIL import Image, ImageDraw

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RES  = os.path.join(REPO, "apps", "web", "android", "app", "src", "main", "res")

BG_ICON    = (17,  24,  39, 255)   # #111827
BG_SPLASH  = (11,  15,  26, 255)   # #0b0f1a
NEON       = (168, 255,  0, 255)   # #A8FF00

# Points de l'éclair dans un espace 32×32
BOLT_PTS_32 = [(21,2),(10,18),(18,18),(11,30),(22,14),(14,14)]

def scale_pts(pts, src, dst, offset_x=0, offset_y=0):
    """Mise à l'échelle des points de src→dst avec décalage centrage."""
    k = dst / src
    return [(x * k + offset_x, y * k + offset_y) for x, y in pts]

def draw_rounded_rect(draw, size, radius_frac, fill):
    """Rectangle avec coins arrondis qui remplit (0,0)→(size,size)."""
    s = size
    r = int(size * radius_frac)
    draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=fill)

def make_icon(size: int, circle=False) -> Image.Image:
    """
    Icône launcher : fond sombre + éclair centré.
    circle=True → forme ronde (ic_launcher_round).
    """
    scale = size / 32
    # Marge 3px dans un espace 32px
    margin = int(3 * scale)
    bolt_size = size - 2 * margin

    img  = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if circle:
        draw.ellipse([0, 0, size - 1, size - 1], fill=BG_ICON)
    else:
        radius_frac = 7 / 32          # rx="7" dans viewBox 32
        draw_rounded_rect(draw, size, radius_frac, BG_ICON)

    # Éclair mis à l'échelle dans la zone centrale
    pts = scale_pts(BOLT_PTS_32, 32, bolt_size, offset_x=margin, offset_y=margin)
    draw.polygon(pts, fill=NEON)

    return img

def make_foreground(size: int) -> Image.Image:
    """
    Foreground adaptatif : fond transparent, éclair dans la zone safe (66%).
    Taille safe = size * 0.66, centré dans size×size.
    """
    safe = int(size * 0.66)
    pad  = (size - safe) // 2

    img  = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pts = scale_pts(BOLT_PTS_32, 32, safe, offset_x=pad, offset_y=pad)
    draw.polygon(pts, fill=NEON)
    return img

def make_splash(w: int, h: int, icon_size: int) -> Image.Image:
    img  = Image.new("RGBA", (w, h), BG_SPLASH)
    icon = make_icon(icon_size, circle=True)
    x    = (w - icon_size) // 2
    y    = (h - icon_size) // 2
    img.paste(icon, (x, y), icon)
    return img

def save(img: Image.Image, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG")
    w, h = img.size
    print(f"  ✓ {os.path.relpath(path, REPO)}  ({w}×{h})")

# ── Launcher icons ────────────────────────────────────────────────────────────
print("\n📱 Icônes launcher…")
DENSITIES = {
    "mipmap-mdpi":    48,
    "mipmap-hdpi":    72,
    "mipmap-xhdpi":   96,
    "mipmap-xxhdpi":  144,
    "mipmap-xxxhdpi": 192,
}
for folder, size in DENSITIES.items():
    save(make_icon(size, circle=False), os.path.join(RES, folder, "ic_launcher.png"))
    save(make_icon(size, circle=True),  os.path.join(RES, folder, "ic_launcher_round.png"))

# ── Adaptive icon foreground ──────────────────────────────────────────────────
print("\n🎨 Adaptive icon foreground…")
FOREGROUND_SIZES = {
    "mipmap-mdpi":    108,
    "mipmap-hdpi":    162,
    "mipmap-xhdpi":   216,
    "mipmap-xxhdpi":  324,
    "mipmap-xxxhdpi": 432,
}
for folder, size in FOREGROUND_SIZES.items():
    save(make_foreground(size), os.path.join(RES, folder, "ic_launcher_foreground.png"))

# ── Adaptive icon XMLs ────────────────────────────────────────────────────────
bg_xml = '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n'
for xml_name in ("ic_launcher.xml", "ic_launcher_round.xml"):
    p = os.path.join(RES, "mipmap-anydpi-v26", xml_name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(bg_xml)
    print(f"  ✓ {os.path.relpath(p, REPO)}")

color_xml = '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#111827</color>\n</resources>\n'
p = os.path.join(RES, "values", "ic_launcher_background.xml")
open(p, "w").write(color_xml)
print(f"  ✓ {os.path.relpath(p, REPO)}")

# ── Splash screens ────────────────────────────────────────────────────────────
print("\n🌟 Splash screens…")
SPLASHES = {
    "drawable":           (480,  800,  80),
    "drawable-port-mdpi": (320,  480,  64),
    "drawable-port-hdpi": (480,  800,  96),
    "drawable-port-xhdpi":  (720,  1280, 144),
    "drawable-port-xxhdpi": (960,  1600, 192),
    "drawable-port-xxxhdpi":(1280, 1920, 256),
    "drawable-land-mdpi": (480,  320,  64),
    "drawable-land-hdpi": (800,  480,  96),
    "drawable-land-xhdpi":  (1280,  720, 144),
    "drawable-land-xxhdpi": (1600,  960, 192),
    "drawable-land-xxxhdpi":(1920, 1280, 256),
}
for folder, (w, h, icon_sz) in SPLASHES.items():
    save(make_splash(w, h, icon_sz), os.path.join(RES, folder, "splash.png"))

print("\n✅  Tous les assets Android générés avec succès !")
