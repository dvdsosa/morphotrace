# /// script
# requires-python = ">=3.10"
# dependencies = ["shapely>=2.0", "numpy"]
# ///
"""Independent check of a MorphoTrace annotations.json with shapely.

For every annotated image it recomputes, outside the browser:
  * the polygon area the tool reports (sum of solids minus holes, as stats() does);
  * the geometric area of (union of solids) minus (union of holes) with shapely;
  * the pixel count of a mask that marks pixels whose centre is inside that geometry;
and flags invalid (self-intersecting) polygons, overlapping solids, holes outside any solid and any
disagreement beyond tolerance. Exit code 1 if any image is flagged.

    uv run tests/check_export.py annotations.json [--csv report.csv]
"""
import argparse
import csv
import json
import sys

import numpy as np
import shapely
from shapely.geometry import Polygon
from shapely.ops import unary_union

AREA_TOL = 0.5  # px²: tolerance between tool area and shapely area (round3 noise is far below this)


def shoelace(pts):
    x, y = np.asarray(pts, float).T
    return abs(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y)) / 2


def mask_count(geom, w, h):
    if geom.is_empty or not w or not h:
        return 0
    xs, ys = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    return int(shapely.contains_xy(geom, xs.ravel(), ys.ravel()).sum())


def check_image(r, umpp):
    polys = r.get("polygons") or []
    solids = [p["points"] for p in polys if not p.get("hole")]
    holes = [p["points"] for p in polys if p.get("hole")]
    flags = []

    naive = sum(shoelace(p) for p in solids) - sum(shoelace(p) for p in holes)
    S = [Polygon(p) for p in solids]
    H = [Polygon(p) for p in holes]
    if not all(g.is_valid for g in S + H):
        flags.append("invalid_polygon")
    S = [shapely.make_valid(g) for g in S]
    H = [shapely.make_valid(g) for g in H]
    solid_u = unary_union(S) if S else Polygon()
    hole_u = unary_union(H) if H else Polygon()
    if S and solid_u.area < sum(g.area for g in S) - AREA_TOL:
        flags.append("overlapping_solids")
    if H and hole_u.difference(solid_u).area > AREA_TOL:
        flags.append("hole_outside_solid")
    geom = solid_u.difference(hole_u)

    tool = r.get("area_px_polygon")
    if tool is not None and abs(tool - naive) > AREA_TOL:
        flags.append("stored_area_mismatch")
    if abs(naive - geom.area) > AREA_TOL:
        flags.append("polygon_vs_geometry")
    count = mask_count(geom, r.get("width"), r.get("height"))
    bound = 0.5 * geom.length + 2  # pixel-centre sampling error ≲ half a pixel per unit boundary
    if abs(count - geom.area) > bound:
        flags.append("mask_vs_area")
    if "area_px_mask" in r and abs(r["area_px_mask"] - count) > bound:
        flags.append("exported_mask_mismatch")

    return {
        "rel_path": r.get("rel_path"), "class": r.get("class"),
        "n_solids": len(solids), "n_holes": len(holes),
        "area_px_tool": tool, "area_px_recomputed": round(naive, 3), "area_px_shapely": round(geom.area, 3),
        "mask_px": count, "area_px_mask_exported": r.get("area_px_mask", ""),
        "mask_minus_area_pct": round(100 * (count - geom.area) / geom.area, 3) if geom.area else "",
        "area_mm2_shapely": geom.area * umpp**2 / 1e6,
        "flags": ";".join(flags),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("json", nargs="+")
    ap.add_argument("--csv", help="write the per-image report here")
    a = ap.parse_args()

    rows = []
    for path in a.json:
        obj = json.load(open(path))
        umpp = float(obj.get("um_per_px") or 0)
        imgs = [r for r in obj.get("images", []) if r.get("status") == "annotated"]
        out = [dict(check_image(r, umpp), source=path) for r in imgs]
        rows += out
        bad = [o for o in out if o["flags"]]
        pct = np.array([o["mask_minus_area_pct"] for o in out if o["mask_minus_area_pct"] != ""], float)
        print(f"{path}\n  tool {obj.get('tool')} · µm/px {umpp} · annotated {len(imgs)} · flagged {len(bad)}")
        if pct.size:
            print(f"  mask vs polygon area: median {np.median(pct):+.3f} %, |max| {np.abs(pct).max():.3f} %")
        for o in bad:
            print(f"  ! {o['rel_path']}: {o['flags']} (tool {o['area_px_tool']}, shapely {o['area_px_shapely']}, mask {o['mask_px']})")
    if a.csv and rows:
        with open(a.csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        print(f"report: {a.csv}")
    sys.exit(1 if any(o["flags"] for o in rows) else 0)


if __name__ == "__main__":
    main()
