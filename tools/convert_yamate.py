#!/usr/bin/env python3
"""Convert Yamate UV print PSD layers into preview maps and OBJ relief meshes."""
from __future__ import annotations

import argparse
import json
import math
import secrets
import sys
import time
from io import BytesIO
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageOps
except ImportError as exc:
    raise SystemExit("Install dependencies with: python -m pip install -r requirements.txt") from exc

DEFAULT_CALIBRATION_INPUT = 0.5
DEFAULT_CALIBRATION_OUTPUT = 0.3
REFERENCE_PASSES = 900.0
REFERENCE_PASS_HEIGHT_MM = 0.2


def gamma_from_calibration(input_fraction: float, output_fraction: float) -> float:
    if not 0 < input_fraction < 1 or not 0 < output_fraction < 1:
        raise ValueError("Calibration fractions must be between 0 and 1")
    return math.log(output_fraction) / math.log(input_fraction)


def load_source(path: Path, max_edge: int, pdf_coverage: bool = False) -> Image.Image:
    suffix = path.suffix.lower()
    if suffix == ".psd":
        try:
            from psd_tools import PSDImage
        except ImportError as exc:
            raise RuntimeError("PSD input requires psd-tools; install requirements.txt") from exc
        image = PSDImage.open(path).composite().convert("RGBA")
    elif suffix == ".pdf":
        try:
            import fitz
        except ImportError as exc:
            raise RuntimeError("PDF input requires PyMuPDF; install requirements.txt") from exc
        document = fitz.open(path)
        if not document:
            raise ValueError(f"PDF has no pages: {path}")
        page = document[0]
        scale = max_edge / max(page.rect.width, page.rect.height)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=True)
        image = Image.open(BytesIO(pixmap.tobytes("png"))).convert("RGBA")
        if pdf_coverage and image.getchannel("A").getextrema() == (255, 255):
            image.putalpha(ImageOps.invert(ImageOps.grayscale(image)))
    else:
        image = Image.open(path).convert("RGBA")

    image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    return image


def resize_to(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    if image.size == size:
        return image
    return image.resize(size, Image.Resampling.LANCZOS)


def height_map(image: Image.Image, size: tuple[int, int], black_is_high: bool) -> Image.Image:
    image = resize_to(image, size).convert("RGBA")
    gray = ImageOps.grayscale(image)
    if black_is_high:
        gray = ImageOps.invert(gray)
    return ImageChops.multiply(gray, image.getchannel("A"))


def color_image(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    image = resize_to(image, size).convert("RGBA")
    background = Image.new("RGBA", size, "white")
    return Image.alpha_composite(background, image).convert("RGB")


def max_layer_height(density_percent: float, passes: int, pass_height_mm: float) -> float:
    return pass_height_mm * passes * density_percent / REFERENCE_PASSES


def resample_map(image: Image.Image, width: int, height: int) -> list[int]:
    return list(image.resize((width, height), Image.Resampling.BILINEAR).convert("L").tobytes())


def mesh_heights(
    base: list[int],
    texture: list[int] | None,
    varnish: list[int] | None,
    layer_heights: dict[str, float],
) -> list[float]:
    heights = []
    for index, base_value in enumerate(base):
        height = base_value / 255 * layer_heights["base"]
        if texture is not None:
            height += texture[index] / 255 * layer_heights["texture"]
        if varnish is not None:
            height += varnish[index] / 255 * layer_heights["varnish"]
        heights.append(height)
    return heights


def write_obj(path: Path, heights: list[float], width: int, height: int,
              width_mm: float, height_mm: float, color_name: str,
              gamma: float | None = None) -> float:
    max_height = max(heights, default=0.0)
    if max_height <= 0:
        raise ValueError("The selected height layers contain no printable relief")
    if gamma is not None:
        heights = [max_height * ((value / max_height) ** gamma) for value in heights]

    mtl_path = path.with_suffix(".mtl")
    mtl_path.write_text(
        "newmtl PrintSurface\n"
        "Ka 1.0 1.0 1.0\n"
        "Kd 1.0 1.0 1.0\n"
        "Ks 0.0 0.0 0.0\n"
        "d 1.0\n"
        "illum 1\n"
        f"map_Kd {color_name}\n",
        encoding="ascii",
    )

    def vertex_xy(x: int, y: int) -> tuple[float, float]:
        return (x / (width - 1) * width_mm - width_mm / 2,
                height_mm / 2 - y / (height - 1) * height_mm)

    with path.open("w", encoding="ascii", newline="\n") as obj:
        obj.write(f"mtllib {mtl_path.name}\nusemtl PrintSurface\ns 1\n")
        for y in range(height):
            for x in range(width):
                px, py = vertex_xy(x, y)
                obj.write(f"v {px:.6f} {py:.6f} {heights[y * width + x]:.6f}\n")
                obj.write(f"vt {x / (width - 1):.6f} {1 - y / (height - 1):.6f}\n")

        boundary = list(range(width))
        boundary.extend(y * width + width - 1 for y in range(1, height))
        boundary.extend((height - 1) * width + x for x in range(width - 2, -1, -1))
        boundary.extend(y * width for y in range(height - 2, 0, -1))
        bottom_start = width * height + 1
        for top_index in boundary:
            y, x = divmod(top_index, width)
            px, py = vertex_xy(x, y)
            obj.write(f"v {px:.6f} {py:.6f} 0.000000\n")
            obj.write(f"vt {x / (width - 1):.6f} {1 - y / (height - 1):.6f}\n")

        for y in range(height - 1):
            for x in range(width - 1):
                top_left = y * width + x + 1
                top_right = top_left + 1
                bottom_left = (y + 1) * width + x + 1
                bottom_right = bottom_left + 1
                obj.write(f"f {top_left}/{top_left} {bottom_left}/{bottom_left} {top_right}/{top_right}\n")
                obj.write(f"f {top_right}/{top_right} {bottom_left}/{bottom_left} {bottom_right}/{bottom_right}\n")

        perimeter = len(boundary)
        for index in range(perimeter):
            next_index = (index + 1) % perimeter
            top_a = boundary[index] + 1
            top_b = boundary[next_index] + 1
            lower_a = bottom_start + index
            lower_b = bottom_start + next_index
            obj.write(f"f {top_a}/{top_a} {top_b}/{top_b} {lower_b}/{lower_b} {lower_a}/{lower_a}\n")

        center = bottom_start + perimeter
        px, py = 0.0, 0.0
        obj.write(f"v {px:.6f} {py:.6f} 0.000000\nvt 0.5 0.5\n")
        center_uv = width * height + perimeter + 1
        for index in range(perimeter):
            a = bottom_start + index
            b = bottom_start + (index + 1) % perimeter
            obj.write(f"f {center}/{center_uv} {a}/{a} {b}/{b}\n")
    return max_height


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, type=Path, help="Base white PSD/image")
    parser.add_argument("--texture", type=Path, help="Texture white PSD/image")
    parser.add_argument("--color", type=Path, help="Color PSD/image")
    parser.add_argument("--original", type=Path, help="Optional original image")
    parser.add_argument("--varnish", type=Path, help="Optional varnish PSD/image/vector PDF")
    parser.add_argument("--output", type=Path, default=Path("data"), help="Output data root")
    parser.add_argument("--title", default="Yamate UV preview")
    parser.add_argument("--width-mm", type=float, default=300)
    parser.add_argument("--base-density-percent", type=float, default=800)
    parser.add_argument("--base-passes", type=int, default=4)
    parser.add_argument("--texture-density-percent", type=float, default=800)
    parser.add_argument("--texture-passes", type=int, default=4)
    parser.add_argument("--varnish-density-percent", type=float, default=500)
    parser.add_argument("--varnish-passes", type=int, default=2)
    parser.add_argument("--pass-height-mm", type=float, default=REFERENCE_PASS_HEIGHT_MM)
    parser.add_argument("--calibration-input", type=float, default=DEFAULT_CALIBRATION_INPUT)
    parser.add_argument("--calibration-output", type=float, default=DEFAULT_CALIBRATION_OUTPUT)
    parser.add_argument("--max-edge", type=int, default=2048)
    parser.add_argument("--mesh-long-edge", type=int, default=384)
    parser.add_argument("--white-high", action="store_true", help="Treat white as high instead of the Yamate default black-high")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.width_mm <= 0 or args.max_edge < 2 or args.mesh_long_edge < 2:
        raise ValueError("Width and image/mesh resolutions must be positive")

    token = secrets.token_urlsafe(24)
    project_dir = args.output / token
    project_dir.mkdir(parents=True, exist_ok=False)
    black_is_high = not args.white_high

    base_source = load_source(args.base, args.max_edge)
    size = base_source.size
    base = height_map(base_source, size, black_is_high)
    base.save(project_dir / "base.png")

    layer_sources = {
        "texture": args.texture,
        "varnish": args.varnish,
        "color": args.color,
        "original": args.original,
    }
    maps: dict[str, Image.Image] = {"base": base}
    for name, path in layer_sources.items():
        if path is None:
            continue
        source = load_source(path, args.max_edge, pdf_coverage=name == "varnish")
        source = resize_to(source, size)
        if name in ("texture", "varnish"):
            converted = height_map(source, size, black_is_high)
            converted.save(project_dir / f"{name}.png")
            maps[name] = converted
        else:
            converted = color_image(source, size)
            converted.save(project_dir / f"{name}.png")

    layer_heights = {
        "base": max_layer_height(args.base_density_percent, args.base_passes, args.pass_height_mm),
        "texture": max_layer_height(args.texture_density_percent, args.texture_passes, args.pass_height_mm) if args.texture else 0,
        "varnish": max_layer_height(args.varnish_density_percent, args.varnish_passes, args.pass_height_mm) if args.varnish else 0,
    }
    ratio = args.width_mm / size[0]
    height_mm = size[1] * ratio
    gamma = gamma_from_calibration(args.calibration_input, args.calibration_output)

    mesh_width = args.mesh_long_edge if size[0] >= size[1] else max(2, round(args.mesh_long_edge * size[0] / size[1]))
    mesh_height = args.mesh_long_edge if size[1] > size[0] else max(2, round(args.mesh_long_edge * size[1] / size[0]))
    mesh_base = resample_map(base, mesh_width, mesh_height)
    mesh_texture = resample_map(maps["texture"], mesh_width, mesh_height) if "texture" in maps else None
    mesh_varnish = resample_map(maps["varnish"], mesh_width, mesh_height) if "varnish" in maps else None
    raw_heights = mesh_heights(mesh_base, mesh_texture, mesh_varnish, layer_heights)
    raw_max = write_obj(project_dir / "model.obj", raw_heights, mesh_width, mesh_height,
                        args.width_mm, height_mm, "color.png")
    ink_max = write_obj(project_dir / "model-ink.obj", raw_heights, mesh_width, mesh_height,
                        args.width_mm, height_mm, "color.png", gamma=gamma)

    layers = {
        "base": {"ink": "White", "density_percent": args.base_density_percent,
                 "passes": args.base_passes, "max_height_mm": round(layer_heights["base"], 4)},
        "color": {"ink": "CMYK", "density_percent": 100, "passes": 1},
    }
    if args.texture:
        layers["texture"] = {
            "ink": "White", "density_percent": args.texture_density_percent,
            "passes": args.texture_passes, "max_height_mm": round(layer_heights["texture"], 4),
        }
    if args.varnish:
        layers["varnish"] = {
            "ink": "Gloss", "density_percent": args.varnish_density_percent,
            "passes": args.varnish_passes, "max_height_mm": round(layer_heights["varnish"], 4),
        }

    config = {
        "title": args.title,
        "size_mm": {"width": round(args.width_mm, 3), "height": round(height_mm, 3)},
        "white_is_high": True,
        "ink_height_curve": {
            "model": "power",
            "input_fraction": args.calibration_input,
            "output_fraction": args.calibration_output,
            "gamma": round(gamma, 6),
            "source": "Yamate meeting notes: 50% input density measured at about 30% height; approximate until printer calibration",
        },
        "layers": layers,
        "note": "Height curve is an estimate from one measured point, not a printer-specific calibration. Verify against a physical test print.",
    }
    (project_dir / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")

    files = {name: f"files/{name}.png" for name in ("base", "texture", "color", "varnish", "original")
             if (project_dir / f"{name}.png").is_file()}
    manifest = {"title": args.title, "files": files, "config": "files/config.json"}
    (project_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    meta = {"title": args.title, "created_at": time.time(), "expires_at": None}
    (project_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Output: {project_dir}")
    print(f"Preview route: /p/{token}")
    print(f"Heightmap size: {size[0]} x {size[1]} px; print size: {args.width_mm:.2f} x {height_mm:.2f} mm")
    print(f"Estimated layer heights: base={layer_heights['base']:.3f} mm, texture={layer_heights['texture']:.3f} mm, varnish={layer_heights['varnish']:.3f} mm")
    print(f"Calibration: {args.calibration_input:.0%} input -> {args.calibration_output:.0%} height (gamma={gamma:.3f})")
    print(f"OBJ maximum: raw={raw_max:.3f} mm, ink-corrected={ink_max:.3f} mm; mesh={mesh_width} x {mesh_height}")
    print("The generated OBJ files are not referenced by manifest.json; the browser preview uses the editable layer maps and its correction toggle.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"convert_yamate: {exc}", file=sys.stderr)
        raise SystemExit(1)