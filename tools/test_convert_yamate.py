import math
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from convert_yamate import (
    DEFAULT_CALIBRATION_INPUT,
    DEFAULT_CALIBRATION_OUTPUT,
    gamma_from_calibration,
    height_map,
    max_layer_height,
    mesh_heights,
    write_obj,
)


class YamateConversionTests(unittest.TestCase):
    def test_calibration_curve_matches_meeting_observation(self):
        gamma = gamma_from_calibration(DEFAULT_CALIBRATION_INPUT, DEFAULT_CALIBRATION_OUTPUT)
        self.assertAlmostEqual(gamma, 1.736966, places=5)
        self.assertAlmostEqual(0.5**gamma, 0.3, places=7)

    def test_layer_height_uses_pass_density_and_reference(self):
        self.assertAlmostEqual(max_layer_height(800, 4, 0.2), 0.711111, places=5)

    def test_black_high_map_preserves_transparency(self):
        image = Image.new("RGBA", (2, 1))
        image.putdata([(0, 0, 0, 255), (255, 255, 255, 0)])
        result = list(height_map(image, image.size, black_is_high=True).tobytes())
        self.assertEqual(result, [255, 0])

    def test_mesh_combines_base_texture_and_varnish(self):
        heights = mesh_heights(
            [255, 128], [128, 0], [0, 255],
            {"base": 0.7, "texture": 0.2, "varnish": 0.05},
        )
        self.assertAlmostEqual(heights[0], 0.7 + 0.2 * 128 / 255)
        self.assertAlmostEqual(heights[1], 0.7 * 128 / 255 + 0.05)

    def test_obj_exports_raw_and_correctable_z_values(self):
        raw = mesh_heights([0, 128, 255, 255, 128, 0], None, None,
                           {"base": 1.0, "texture": 0.0, "varnish": 0.0})
        with tempfile.TemporaryDirectory() as directory:
            raw_path = Path(directory) / "raw.obj"
            corrected_path = Path(directory) / "corrected.obj"
            maximum = write_obj(raw_path, raw, 3, 2, 30, 20, "color.png")
            gamma = gamma_from_calibration(0.5, 0.3)
            write_obj(corrected_path, raw, 3, 2, 30, 20, "color.png", gamma=gamma)
            raw_vertices = [line.split() for line in raw_path.read_text("ascii").splitlines()
                            if line.startswith("v ")][:len(raw)]
            corrected_vertices = [line.split() for line in corrected_path.read_text("ascii").splitlines()
                                  if line.startswith("v ")][:len(raw)]
            self.assertAlmostEqual(maximum, 1.0)
            self.assertTrue(math.isclose(float(raw_vertices[2][3]), 1.0))
            self.assertAlmostEqual(float(raw_vertices[1][3]), 128 / 255, places=5)
            self.assertAlmostEqual(float(corrected_vertices[1][3]), (128 / 255) ** gamma, places=5)
            self.assertLess(float(corrected_vertices[1][3]), float(raw_vertices[1][3]))


if __name__ == "__main__":
    unittest.main()