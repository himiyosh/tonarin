"""Writes Tonarin's app icon sources (original artwork: our own mochi character, design "A" chosen 2026-09-27).

  python3 scripts/make-icon.py

- assets/icon.svg (kept next to this script's output, drawn by hand) is the classic icon: Big Sur grid, an 824 pt
  squircle with a soft shadow on a 1024 canvas. assets/icon.png (1024) and pet/ui/app-icon.png (128) are renders of it
  (any SVG renderer with filter support; Chromium was used). electron-builder turns icon.png into the .icns.
- build/icon/Icon.icon: the same design as an Icon Composer bundle for macOS 26 Liquid Glass. The system draws the
  shape, glass, highlights and shadows itself, so the layers are flat: a gradient background (in icon.json), the
  body, the face and the antenna. `node scripts/build-icon.mjs` compiles it to build/icon/Assets.car with actool
  (Xcode 26 or later); the afterPack hook puts Assets.car into the app when it exists.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
BODY = "M100 52 C 146 52, 170 88, 168 126 C 166 160, 138 178, 100 178 C 62 178, 34 160, 32 126 C 30 88, 54 52, 100 52 Z"
FEET = '<ellipse cx="74" cy="177" rx="14.5" ry="6.5"/><ellipse cx="126" cy="177" rx="14.5" ry="6.5"/>'


FACE_DEFS = (
    '<radialGradient id="cheek" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ff7fb0" stop-opacity="0.75"/>'
    '<stop offset="1" stop-color="#ff7fb0" stop-opacity="0"/></radialGradient>'
)
FACE = """
  <ellipse cx="60" cy="131" rx="13" ry="8" fill="url(#cheek)"/>
  <ellipse cx="140" cy="131" rx="13" ry="8" fill="url(#cheek)"/>
  <ellipse cx="78" cy="110" rx="9" ry="12" fill="#261f4d"/>
  <ellipse cx="122" cy="110" rx="9" ry="12" fill="#261f4d"/>
  <circle cx="81.5" cy="104.5" r="3.4" fill="#ffffff"/>
  <circle cx="125.5" cy="104.5" r="3.4" fill="#ffffff"/>
  <circle cx="75" cy="115" r="1.4" fill="#ffffff" fill-opacity="0.8"/>
  <circle cx="119" cy="115" r="1.4" fill="#ffffff" fill-opacity="0.8"/>
  <path d="M92 134 Q100 141 108 134" fill="none" stroke="#5b3a78" stroke-width="3" stroke-linecap="round"/>"""


def layer_svg(content, defs=""):
    # Full-bleed 1024 canvas; the character scaled so it sits comfortably inside the system's squircle.
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
        f"<defs>{defs}</defs><g transform=\"translate(82 69) scale(4.3)\">{content}</g></svg>\n"
    )


def icon_bundle():
    out = ROOT / "build" / "icon" / "Icon.icon"
    (out / "Assets").mkdir(parents=True, exist_ok=True)
    body = layer_svg(
        f'<g fill="url(#b)">{FEET}<path d="{BODY}"/></g>',
        '<linearGradient id="b" x1="0.2" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="#ffffff"/>'
        '<stop offset="0.55" stop-color="#f1ecff"/><stop offset="1" stop-color="#d9d0ff"/></linearGradient>',
    )
    face_svg = layer_svg(FACE, FACE_DEFS)
    antenna = layer_svg(
        '<path d="M100 56 C 99 42, 106 32, 114 24" fill="none" stroke="#ffffff" stroke-width="4.2" stroke-linecap="round"/>'
        '<circle cx="116" cy="21" r="8.2" fill="url(#g)"/>',
        '<radialGradient id="g" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#e9fff9"/>'
        '<stop offset="0.45" stop-color="#7ff5d6"/><stop offset="1" stop-color="#2fb9a0"/></radialGradient>',
    )
    (out / "Assets" / "body.svg").write_text(body)
    (out / "Assets" / "face.svg").write_text(face_svg)
    (out / "Assets" / "antenna.svg").write_text(antenna)
    at = {"scale": 1, "translation-in-points": [0, 0]}
    icon = {
        "fill-specializations": [
            {"value": {"linear-gradient": ["srgb:0.30980,0.27451,1.00000,1.00000", "srgb:1.00000,0.43529,0.70980,1.00000"]}},
            {"appearance": "dark", "value": {"linear-gradient": ["srgb:0.11765,0.10588,0.29412,1.00000", "srgb:0.35686,0.11373,0.30980,1.00000"]}},
        ],
        "groups": [
            {
                "name": "face",
                "layers": [{"name": "face", "image-name": "face.svg", "glass": False, "hidden": False, "position": at}],
                "shadow": {"kind": "none", "opacity": 0.5},
                "specular": False,
                "translucency": {"enabled": False, "value": 0.5},
            },
            {
                "name": "body",
                "layers": [{"name": "body", "image-name": "body.svg", "glass": True, "hidden": False, "position": at}],
                "lighting": "individual",
                "shadow": {"kind": "neutral", "opacity": 0.5},
                "specular": True,
                "translucency": {"enabled": True, "value": 0.25},
            },
            {
                "name": "antenna",
                "layers": [{"name": "antenna", "image-name": "antenna.svg", "glass": True, "hidden": False, "position": at}],
                "shadow": {"kind": "layer-color", "opacity": 0.5},
                "specular": True,
                "translucency": {"enabled": True, "value": 0.4},
            },
        ],
        "supported-platforms": {"squares": "shared"},
    }
    (out / "icon.json").write_text(json.dumps(icon, indent=2) + "\n")
    return out


if __name__ == "__main__":
    print("wrote", icon_bundle())
