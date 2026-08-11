#!/usr/bin/env python3
"""
selftest.py -- offline test harness for the legend parsing and palette embedding.

Builds a synthetic palette-indexed GeoTIFF and synthetic legends, then drives the
real code in baron_geotiff.py against them. No network and no credentials, so this
runs anywhere and gives the same answer every time.

What it covers
--------------
  legend parsing    both accepted shapes: the CDN's {"palettes":[{"entries":[...]}]}
                    and the flat [{"value":..,"rgba":..,"label":..}] form
                    alpha in the LAST two hex digits, not the first
                    "Undefined" and blank labels excluded from the label map
                    multi-palette legends: --palette selects, out of range raises
                    malformed input raises rather than embedding a wrong palette
  embedding         the colour table reaches the file, alpha survives, and
                    ColorInterp becomes Palette
                    pixels are byte-for-byte identical to the source: the whole
                    point of the copy-then-attach approach
                    VALUE_<idx> tags present for labelled indices, absent for
                    "Undefined"
                    LEGEND_JSON round-trips back to the input document
                    provenance tags land on the dataset
  guards            a non-Byte raster is refused, and the useless partial copy is
                    cleaned up rather than left behind
  qml               the sidecar lists labelled entries and skips "Undefined"

Usage:
    python3 selftest.py [--keep]
"""

import argparse
import json
import os
import shutil
import sys
import tempfile

from osgeo import gdal, osr

gdal.UseExceptions()

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import baron_geotiff as bg                                            # noqa: E402

passed = 0
failures = []


def check(label, ok, detail=''):
    """Record one assertion and print its result."""
    global passed
    print(f'  [{"PASS" if ok else "FAIL"}] {label}{" — " + detail if detail else ""}')
    if ok:
        passed += 1
    else:
        failures.append(label)


# ============================================================================
# Synthetic fixtures
# ============================================================================

# Index 0 and 1 are transparent (alpha 00) and labelled "Undefined", the shape a
# real Baron legend uses for its no-data head. 2..5 carry real values.
CDN_LEGEND = {
    "palettes": [
        {
            "entries": [
                {"color": "#00000000", "value": "Undefined"},
                {"color": "#11223300", "value": "Undefined"},
                {"color": "#01f3f7ff", "value": "0.5 dBZ"},
                {"color": "#25e17dff", "value": "15 dBZ"},
                {"color": "#ffff2180", "value": "35 dBZ"},
                {"color": "#ff0000ff", "value": "45 dBZ"},
            ]
        },
        {
            "mask": "snow",
            "entries": [
                {"color": "#00000000", "value": "Undefined"},
                {"color": "#aabbccff", "value": "snow 1"},
            ],
        },
    ]
}

FLAT_LEGEND = [
    {"value": 0, "rgba": [0, 0, 0, 0], "label": "Undefined"},
    {"value": 2, "rgba": [1, 243, 247, 255], "label": "0.5 dBZ"},
    {"value": 3, "rgba": [37, 225, 125, 255], "label": "15 dBZ"},
]

# The pixel pattern written into every synthetic raster. Includes both transparent
# indices and every labelled index, so the round-trip check is meaningful.
PIXELS = [
    [0, 1, 2],
    [3, 4, 5],
    [2, 0, 5],
]


def build_indexed_tif(path, datatype=gdal.GDT_Byte, bands=1):
    """Write a small georeferenced raster holding the PIXELS pattern."""
    driver = gdal.GetDriverByName('GTiff')
    dataset = driver.Create(path, 3, 3, bands, datatype)

    # Arbitrary but valid georeferencing: 1-degree pixels near the prime meridian.
    dataset.SetGeoTransform([-1.5, 1.0, 0.0, 1.5, 0.0, -1.0])
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    dataset.SetProjection(srs.ExportToWkt())

    for band_index in range(1, bands + 1):
        dataset.GetRasterBand(band_index).WriteArray(_as_array(datatype))

    dataset.FlushCache()
    dataset = None
    return path


def _as_array(datatype):
    """PIXELS as a numpy array of the type GDAL expects for datatype."""
    import numpy

    dtype = numpy.float32 if datatype == gdal.GDT_Float32 else numpy.uint8
    return numpy.array(PIXELS, dtype=dtype)


def read_pixels(path):
    """Band 1 of path as a nested list."""
    dataset = gdal.Open(path)
    values = dataset.GetRasterBand(1).ReadAsArray().tolist()
    dataset = None
    return values


# ============================================================================
# Legend parsing
# ============================================================================

def test_parse_palette():
    print('\nparse_palette')

    colors, labels = bg.parse_palette(CDN_LEGEND)

    check('CDN shape: one entry per array position', len(colors) == 6,
          f'got {len(colors)}')
    check('CDN shape: alpha read from the last two hex digits',
          colors[2] == (1, 243, 247, 255), f'got {colors.get(2)}')
    check('CDN shape: transparent entry keeps its rgb and zero alpha',
          colors[1] == (17, 34, 51, 0), f'got {colors.get(1)}')
    check('CDN shape: partial alpha survives', colors[4] == (255, 255, 33, 128),
          f'got {colors.get(4)}')
    check('CDN shape: labels exclude "Undefined"',
          sorted(labels) == [2, 3, 4, 5], f'got {sorted(labels)}')
    check('CDN shape: label text preserved', labels.get(2) == '0.5 dBZ',
          f'got {labels.get(2)}')

    # A flat legend indexes by an explicit 'value' field rather than by position,
    # so index 1 is legitimately absent.
    flat_colors, flat_labels = bg.parse_palette(FLAT_LEGEND)
    check('flat shape: indices come from the value field',
          sorted(flat_colors) == [0, 2, 3], f'got {sorted(flat_colors)}')
    check('flat shape: rgba read verbatim', flat_colors[2] == (1, 243, 247, 255),
          f'got {flat_colors.get(2)}')
    check('flat shape: labels exclude "Undefined"', sorted(flat_labels) == [2, 3],
          f'got {sorted(flat_labels)}')

    second, second_labels = bg.parse_palette(CDN_LEGEND, palette_index=1)
    check('--palette selects the requested palette',
          len(second) == 2 and second_labels.get(1) == 'snow 1',
          f'got {len(second)} entries, label {second_labels.get(1)}')

    for label, bad in [
        ('palette index out of range', (CDN_LEGEND, 9)),
        ('empty palettes list', ({'palettes': []}, 0)),
        ('entries missing', ({'palettes': [{}]}, 0)),
        ('short hex colour', ({'palettes': [{'entries': [{'color': '#fff'}]}]}, 0)),
        ('missing rgba in flat entry', ([{'value': 1, 'label': 'x'}], 0)),
        ('unsupported document', ('not a legend', 0)),
    ]:
        legend, index = bad
        try:
            bg.parse_palette(legend, palette_index=index)
            check(f'rejects {label}', False, 'no exception raised')
        except (ValueError, TypeError, KeyError, IndexError):
            check(f'rejects {label}', True)


# ============================================================================
# Palette embedding
# ============================================================================

def test_write_colored(workdir):
    print('\nwrite_colored')

    raw = build_indexed_tif(os.path.join(workdir, 'raw.tif'))
    colored = os.path.join(workdir, 'raw_color.tif')
    provenance = {
        'PRODUCT': 'C39-0x03EA-0',
        'PROJECTION': 'Standard-Mercator',
        'INSTANCE_TIME': '2026-08-10T14:30:00Z',
        'LEGEND_URL': 'https://static.velocityweather.com/legends/x/y/geotiff_legend.json',
    }

    bg.write_colored(raw, colored, CDN_LEGEND, palette_index=0,
                     provenance=provenance)

    check('colour file created', os.path.exists(colored))
    check('source left in place', os.path.exists(raw))
    check('pixels unchanged by the copy', read_pixels(colored) == PIXELS,
          f'got {read_pixels(colored)}')

    dataset = gdal.Open(colored)
    band = dataset.GetRasterBand(1)
    table = band.GetRasterColorTable()

    check('colour table attached', table is not None)
    if table is not None:
        # A TIFF colour map is always a full 256-entry table, so GDAL pads it.
        check('colour table padded to the TIFF-native 256 entries',
              table.GetCount() == 256, f'got {table.GetCount()}')
        check('colour table rgb matches the legend',
              table.GetColorEntry(2)[:3] == (1, 243, 247),
              f'got {table.GetColorEntry(2)}')
        check('colour table rgb kept for a transparent entry',
              table.GetColorEntry(1)[:3] == (17, 34, 51),
              f'got {table.GetColorEntry(1)}')
        # A TIFF colour map has no alpha channel. GDAL accepts the 4-tuple and
        # drops it, so the mask band and the ALPHA_ tags carry transparency.
        check('colour table reports opaque alpha, as TIFF requires',
              table.GetColorEntry(0)[3] == 255, f'got {table.GetColorEntry(0)}')

    check('band reports a palette interpretation',
          band.GetRasterColorInterpretation() == gdal.GCI_PaletteIndex,
          f'got {band.GetRasterColorInterpretation()}')

    band_tags = band.GetMetadata()
    check('VALUE_ tag written for a labelled index',
          band_tags.get('VALUE_2') == '0.5 dBZ', f'got {band_tags.get("VALUE_2")}')
    check('VALUE_ tag absent for "Undefined"',
          'VALUE_0' not in band_tags and 'VALUE_1' not in band_tags,
          f'got keys {sorted(band_tags)}')
    check('one VALUE_ tag per labelled index',
          len([k for k in band_tags if k.startswith('VALUE_')]) == 4,
          f'got {[k for k in band_tags if k.startswith("VALUE_")]}')

    check('ALPHA_ tag records a fully transparent index',
          band_tags.get('ALPHA_0') == '0', f'got {band_tags.get("ALPHA_0")}')
    check('ALPHA_ tag records partial alpha',
          band_tags.get('ALPHA_4') == '128', f'got {band_tags.get("ALPHA_4")}')
    check('no ALPHA_ tag for an opaque index', 'ALPHA_2' not in band_tags,
          f'got {band_tags.get("ALPHA_2")}')

    # Transparency lands as an internal mask: indices 0 and 1 are alpha 0.
    expected_mask = [[0, 0, 255], [255, 255, 255], [255, 0, 255]]
    mask_band = band.GetMaskBand()
    check('mask band present', mask_band is not None)
    if mask_band is not None:
        check('mask marks exactly the transparent indices',
              mask_band.ReadAsArray().tolist() == expected_mask,
              f'got {mask_band.ReadAsArray().tolist()}')
    check('mask stored inside the TIFF, not as a .msk sidecar',
          not os.path.exists(colored + '.msk'))

    tags = dataset.GetMetadata()
    check('LEGEND_JSON round-trips',
          json.loads(tags.get('LEGEND_JSON', '{}')) == CDN_LEGEND)
    check('palette index recorded', tags.get('LEGEND_PALETTE_INDEX') == '0',
          f'got {tags.get("LEGEND_PALETTE_INDEX")}')
    check('provenance recorded',
          all(tags.get(key) == value for key, value in provenance.items()),
          f'got {[(k, tags.get(k)) for k in provenance]}')

    # NoData must stay unset: the alpha channel carries transparency, and claiming
    # a NoData index would hide real pixel values from a value query.
    check('no NoData value invented', band.GetNoDataValue() is None,
          f'got {band.GetNoDataValue()}')

    dataset = None


def test_write_colored_guards(workdir):
    print('\nwrite_colored guards')

    float_raw = build_indexed_tif(os.path.join(workdir, 'float.tif'),
                                  datatype=gdal.GDT_Float32)
    float_out = os.path.join(workdir, 'float_color.tif')
    try:
        bg.write_colored(float_raw, float_out, CDN_LEGEND)
        check('refuses a non-Byte raster', False, 'no exception raised')
    except ValueError as error:
        check('refuses a non-Byte raster', True)
        check('non-Byte message names the type', 'Byte' in str(error),
              f'got {error}')
    check('no partial copy left behind after a refusal',
          not os.path.exists(float_out))

    multi_raw = build_indexed_tif(os.path.join(workdir, 'multi.tif'), bands=3)
    multi_out = os.path.join(workdir, 'multi_color.tif')
    try:
        bg.write_colored(multi_raw, multi_out, CDN_LEGEND)
        check('refuses a multi-band raster', False, 'no exception raised')
    except ValueError:
        check('refuses a multi-band raster', True)
    check('no partial copy left behind after a multi-band refusal',
          not os.path.exists(multi_out))


# ============================================================================
# QML sidecar
# ============================================================================

def test_write_qml(workdir):
    print('\nwrite_qml')

    colors, labels = bg.parse_palette(CDN_LEGEND)
    qml = os.path.join(workdir, 'style.qml')
    bg.write_qml(colors, labels, qml)

    with open(qml) as handle:
        content = handle.read()

    check('qml written', os.path.exists(qml))
    check('qml declares a paletted renderer', 'type="paletted"' in content)
    check('qml carries a labelled entry',
          'value="2"' in content and '0.5 dBZ' in content)
    check('qml skips "Undefined"', 'Undefined' not in content)
    check('qml keeps alpha', 'alpha="128"' in content)


# ============================================================================
# Runner
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description='Offline tests for baron_geotiff.py legend and palette handling.')
    parser.add_argument('--keep', action='store_true',
                        help='keep the temporary working directory for inspection')
    args = parser.parse_args()

    workdir = tempfile.mkdtemp(prefix='baron_geotiff_selftest_')
    print(f'workdir: {workdir}')

    try:
        test_parse_palette()
        test_write_colored(workdir)
        test_write_colored_guards(workdir)
        test_write_qml(workdir)
    finally:
        if args.keep:
            print(f'\nkept {workdir}')
        else:
            shutil.rmtree(workdir, ignore_errors=True)

    total = passed + len(failures)
    print()
    if failures:
        print(f'{len(failures)} of {total} checks FAILED: {failures}')
        return 1
    print(f'all {total} checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
