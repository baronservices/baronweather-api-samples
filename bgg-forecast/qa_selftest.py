#!/usr/bin/env python3
"""
qa_selftest.py -- synthetic-defect harness for qa_bgg.py.

Clones known-good products from a reference folder, injects one defect per
case, runs qa_bgg.py against each mutated copy, and asserts the gate reports
the expected FAILure (and stays green on an untouched clone). This turns
"would the gate catch X?" -- including the season-dependent placement checks
that otherwise wait for a winter run -- into an executed test.

Cases (all on clones; the reference folder is never written):
  clean       untouched day-temp-max clone              -> exit 0, no FAIL
  rolled      all bands rolled 180 deg in longitude     -> georef anchor FAIL
  flipped     all bands mirrored north-south            -> zonal-season FAIL
  undefined   nodata index written into band 7 only     -> palette FAIL 0@band7
  frozen      band 11 overwritten with band 9           -> frozen-pair FAIL
  clamped     30% of band 1 forced into a clamp index   -> clamp-usage FAIL
  timeshift   GRIB_VALID_TIME shifted +12h everywhere   -> time-metadata FAIL
  uvswap      windvector u/v element tags swapped       -> u/v order FAIL
  mixedrun    second product's run shifted -6h          -> mixed-run FAIL
  verbose     clean temperature file with -v             -> structured pixel trace

Usage:
    python3 qa_selftest.py --reference download [--legends download]
                           [--workdir DIR] [--keep]
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from osgeo import gdal

gdal.UseExceptions()
gdal.SetConfigOption("GDAL_PAM_ENABLED", "NO")

TMAX = "bgg-global-day-temp-max-c-2meter_Standard-Geodetic_latest.tif"
TMIN = "bgg-global-day-temp-min-c-2meter_Standard-Geodetic_latest.tif"
WVEC = "bgg-global-day-windvector-10meter_Standard-Geodetic_latest.tif"
QA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qa_bgg.py")


def clone(reference, name, case_dir):
    os.makedirs(case_dir, exist_ok=True)
    destination = os.path.join(case_dir, name)
    shutil.copyfile(os.path.join(reference, name), destination)
    return destination


def each_band(path):
    ds = gdal.Open(path, gdal.GA_Update)
    try:
        for band_number in range(1, ds.RasterCount + 1):
            yield ds, ds.GetRasterBand(band_number)
    finally:
        ds.FlushCache()
        ds = None


def mutate_rolled(path):
    """Roll 180 degrees in longitude, keeping the duplicated seam columns."""
    for _, band in each_band(path):
        data = band.ReadAsArray()
        rolled = np.roll(data[:, :3600], 1800, axis=1)
        band.WriteArray(np.concatenate([rolled, rolled[:, :1]], axis=1))


def mutate_flipped(path):
    for _, band in each_band(path):
        band.WriteArray(band.ReadAsArray()[::-1, :])


def mutate_undefined(path):
    ds = gdal.Open(path, gdal.GA_Update)
    band = ds.GetRasterBand(7)
    block = band.ReadAsArray(500, 500, 40, 40)
    block[:] = 0                      # index 0 is undefined in the temp legend
    band.WriteArray(block, 500, 500)
    ds.FlushCache(); ds = None


def mutate_frozen(path):
    ds = gdal.Open(path, gdal.GA_Update)
    source = ds.GetRasterBand(9).ReadAsArray()   # same-phase pair (9, 11) is sampled
    ds.GetRasterBand(11).WriteArray(source)
    ds.FlushCache(); ds = None


def mutate_clamped(path):
    ds = gdal.Open(path, gdal.GA_Update)
    band = ds.GetRasterBand(1)
    data = band.ReadAsArray()
    data[:540, :] = 1                 # index 1 = '< -85 C' clamp bucket (~30% of rows)
    band.WriteArray(data)
    ds.FlushCache(); ds = None


def mutate_timeshift(path):
    for _, band in each_band(path):
        valid = int(band.GetMetadataItem("GRIB_VALID_TIME").split()[0])
        band.SetMetadataItem("GRIB_VALID_TIME", str(valid + 43200))


def mutate_uvswap(path):
    ds = gdal.Open(path, gdal.GA_Update)
    ds.GetRasterBand(1).SetMetadataItem("GRIB_ELEMENT", "VGRD")
    ds.GetRasterBand(2).SetMetadataItem("GRIB_ELEMENT", "UGRD")
    ds.FlushCache(); ds = None


def mutate_mixedrun(path):
    for _, band in each_band(path):
        ref = int(band.GetMetadataItem("GRIB_REF_TIME").split()[0])
        valid = int(band.GetMetadataItem("GRIB_VALID_TIME").split()[0])
        band.SetMetadataItem("GRIB_REF_TIME", str(ref - 21600))
        band.SetMetadataItem("GRIB_VALID_TIME", str(valid - 21600))


CASES = [
    # name, files to clone, mutation(list of (file, fn)), FAIL substring or None
    ("clean",     [TMAX], [], None),
    ("rolled",    [TMAX], [(TMAX, mutate_rolled)], "georef anchors"),
    ("flipped",   [TMAX], [(TMAX, mutate_flipped)], "zonal-mean"),
    ("undefined", [TMAX], [(TMAX, mutate_undefined)], "0@band7"),
    ("frozen",    [TMAX], [(TMAX, mutate_frozen)], "identical sampled band pairs"),
    ("clamped",   [TMAX], [(TMAX, mutate_clamped)], "clamp-bucket usage"),
    ("timeshift", [TMAX], [(TMAX, mutate_timeshift)], "time-metadata"),
    ("uvswap",    [WVEC], [(WVEC, mutate_uvswap)], "u/v component order"),
    ("mixedrun",  [TMAX, TMIN], [(TMIN, mutate_mixedrun)], "mixed GRIB_REF_TIME"),
]


def run_case(name, files, mutations, expect_fail, reference, legends, workdir):
    case_dir = os.path.join(workdir, name)
    for filename in files:
        clone(reference, filename, case_dir)
    for filename, mutation in mutations:
        mutation(os.path.join(case_dir, filename))
    proc = subprocess.run(
        [sys.executable, QA, "--dir", case_dir, "--legends", legends,
         "--wx-sample-bands", "0"],
        capture_output=True, text=True)
    output = proc.stdout + proc.stderr
    fail_lines = [line for line in output.splitlines() if "[FAIL]" in line]
    if expect_fail is None:
        ok = proc.returncode == 0 and not fail_lines
        want = "exit 0, no FAIL"
    else:
        ok = proc.returncode != 0 and any(expect_fail in line for line in fail_lines)
        want = f"FAIL containing {expect_fail!r}"
    status = "ok" if ok else "SELF-TEST FAILURE"
    print(f"[{status}] {name}: expected {want}; exit {proc.returncode}; "
          f"{len(fail_lines)} FAIL line(s)")
    if not ok:
        for line in fail_lines[:6]:
            print(f"    {line.strip()}")
        if not fail_lines:
            print("    (no FAIL lines; gate output tail below)")
            for line in output.splitlines()[-6:]:
                print(f"    {line.strip()}")
    return ok


def run_verbose_case(reference, legends, workdir):
    case_dir = os.path.join(workdir, "verbose")
    clone(reference, TMAX, case_dir)
    proc = subprocess.run(
        [sys.executable, QA, "--dir", case_dir, "--legends", legends,
         "--wx-sample-bands", "0", "-v", "--verbose-pixel-limit", "2"],
        capture_output=True, text=True)
    trace_lines = [line for line in proc.stderr.splitlines() if line.startswith("[TRACE] ")]
    required_fragments = [
        '"event":"check-detail"', '"result":"PASS"', '"event":"pixel"',
        '"classifications":', '"values":', '"test":',
        '"event":"verbose-end"',
    ]
    missing = [fragment for fragment in required_fragments
               if not any(fragment in line for line in trace_lines)]
    ok = proc.returncode == 0 and not missing
    status = "ok" if ok else "SELF-TEST FAILURE"
    print(f"[{status}] verbose: expected structured aggregate/pixel trace; "
          f"exit {proc.returncode}; {len(trace_lines)} TRACE line(s)")
    if missing:
        print(f"    missing trace fragments: {missing}")
    return ok


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reference", required=True,
                        help="folder of known-good BGG GeoTIFFs (read-only source)")
    parser.add_argument("--legends", default=None,
                        help="legend folder passed through to qa_bgg.py (default: --reference)")
    parser.add_argument("--workdir", default=None,
                        help="where to build mutated clones (default: a temp dir)")
    parser.add_argument("--keep", action="store_true",
                        help="keep the workdir instead of deleting it on success")
    args = parser.parse_args()
    legends = args.legends or args.reference
    workdir = args.workdir or tempfile.mkdtemp(prefix="qa_selftest_")
    os.makedirs(workdir, exist_ok=True)
    print(f"workdir: {workdir}")

    results = []
    for name, files, mutations, expect_fail in CASES:
        results.append(run_case(name, files, mutations, expect_fail,
                                args.reference, legends, workdir))
    results.append(run_verbose_case(args.reference, legends, workdir))
    passed = sum(results)
    print(f"\n==== self-test: {passed}/{len(results)} cases behave as expected ====")
    if passed == len(results) and not args.keep and args.workdir is None:
        shutil.rmtree(workdir, ignore_errors=True)
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
