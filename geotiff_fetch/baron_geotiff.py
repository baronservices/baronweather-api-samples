#!/usr/bin/env python3
"""
baron_geotiff.py -- fetch one Baron GeoTIFF, fetch its legend, and write a copy
that carries the legend inside the file as a native TIFF palette.

GeoTIFFs from the Velocity Weather API are palette-indexed 8-bit rasters. A pixel
holds a palette index, not a physical value: index 192 in a temperature product
means 27.5 C, not 192 K. The index-to-colour and index-to-label mapping lives in a
separate legend document on a public CDN, so a raw file opened in a GIS renders as
a flat grey ramp and reads as nonsense.

This script closes that gap. One command writes three files:

    <stem>.tif            exactly what the API delivered, byte for byte
    <stem>_color.tif      the same pixels, with the palette and labels embedded
    <stem>_legend.json    the legend document as fetched

The coloured copy needs no sidecar and no external legend. It opens in QGIS,
ArcGIS, or any GDAL reader and shows the right colours, and because the pixels are
untouched it stays queryable by index.

Usage:
    # Latest instance, coloured copy and legend written alongside
    python3 baron_geotiff.py --product C39-0x03EA-0 --projection Standard-Mercator

    # An exact instance, to a chosen name
    python3 baron_geotiff.py --product C39-0x03EA-0 --projection Standard-Mercator \
        --timestamp 2026-08-10T14:30:00Z --output radar.tif

    # What instances exist?
    python3 baron_geotiff.py --product C39-0x03EA-0 --projection Standard-Mercator \
        --list-times 10

    # Download only, no GDAL needed
    python3 baron_geotiff.py --product C39-0x03EA-0 --projection Standard-Mercator \
        --no-color

Credentials (.env file only, never the environment):
    BARON_API_KEY / BARON_API_SECRET                  preferred
    BARON_ACCESS_KEY / BARON_ACCESS_KEY_SECRET        also accepted
    BARON_API_BASE_URL                                optional API host override

    Copy env.example to .env. Searched in this directory, then beside the script.

Exit codes:
    0  success
    1  fatal error, nothing downloaded
    2  the raw GeoTIFF was saved but the legend or the coloured copy failed
"""

import argparse
import base64
import datetime
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import sys
import time
import xml.sax.saxutils as saxutils
from logging.handlers import RotatingFileHandler

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential


# ============================================================================
# Constants and Configuration
# ============================================================================

DEFAULT_API_HOST = "https://api.velocityweather.com/v1"
LEGEND_BASE_URL = "https://static.velocityweather.com/legends"
LOG_FILE_MAX_BYTES = 10 * 1024 * 1024  # 10MB
LOG_BACKUP_COUNT = 10

# Labels that mean "this index carries no value". Excluded from the embedded
# labels and from the QML style, so neither is padded with hundreds of dead rows.
EMPTY_LABELS = {'', 'undefined', 'no data', 'nodata', 'n/a', 'none', 'null'}

# Exit codes
EXIT_SUCCESS = 0
EXIT_FATAL_ERROR = 1
EXIT_PARTIAL_SUCCESS = 2


# ============================================================================
# Logging
# ============================================================================

def setup_logging(log_file=None, log_level=logging.INFO, quiet=False):
    """
    Configure console and rotating file logging.

    Both handlers use the same level. The file handler is deliberately not pinned
    to DEBUG: at DEBUG this script records full signed API URLs and presigned S3
    URLs, so a permanent DEBUG log file becomes a plain-text credential store.

    --quiet silences progress output but not errors. A cron job that fails should
    say so, and stderr is what cron mails out; the exit code alone is easy to miss.

    Args:
        log_file (str, optional): Path to the log file. Parent directories are
            created. None disables file logging.
        log_level (int, optional): Level for both handlers. Defaults to INFO.
        quiet (bool, optional): Suppress progress output. Errors still reach
            stderr, and file logging continues.

    Side Effects:
        Clears existing handlers on the root logger.
    """
    root_logger = logging.getLogger()
    root_logger.setLevel(min(log_level, logging.ERROR))
    root_logger.handlers.clear()

    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')

    console = logging.StreamHandler(sys.stderr if quiet else sys.stdout)
    console.setLevel(logging.ERROR if quiet else log_level)
    console.setFormatter(formatter)
    root_logger.addHandler(console)

    if log_file:
        parent = os.path.dirname(os.path.abspath(log_file))
        os.makedirs(parent, exist_ok=True)
        file_handler = RotatingFileHandler(log_file, maxBytes=LOG_FILE_MAX_BYTES,
                                           backupCount=LOG_BACKUP_COUNT)
        file_handler.setLevel(log_level)
        file_handler.setFormatter(formatter)
        root_logger.addHandler(file_handler)


def mask_credential(credential):
    """
    Mask a credential for logging, keeping it identifiable.

    Args:
        credential (str): The value to mask.

    Returns:
        str: 'abcd***wxyz', or '***' for anything shorter than 8 characters.
    """
    if not credential or len(credential) < 8:
        return "***"
    return credential[:4] + "***" + credential[-4:]


# ============================================================================
# Authentication
# ============================================================================

def load_env(path):
    """
    Parse a KEY=VALUE .env file into a dict.

    Blank lines, comment lines, and lines without '=' are skipped. Surrounding
    single or double quotes are stripped from the value.

    Args:
        path (str): Path to the .env file. A missing file yields an empty dict.

    Returns:
        dict[str, str]: The parsed key/value pairs.
    """
    values = {}
    if not os.path.exists(path):
        return values
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, value = line.partition('=')
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def resolve_env_path(env_path):
    """
    Find the .env file to read. Returns (path, list of paths tried).

    A bare default like '.env' resolves against the current working directory, so
    running this script from anywhere but its own folder would find nothing even
    when the .env sits right beside it. The working directory is searched first,
    so a per-project .env keeps winning; the script's folder is the fallback.

    An explicit --env path is used exactly as given and never falls back. A named
    path must not silently resolve to different credentials.

    Args:
        env_path (str): The path requested, usually the '.env' default.

    Returns:
        tuple[str, list[str]]: The path to read, and every path considered.
    """
    tried = [os.path.abspath(env_path)]
    if os.path.exists(env_path):
        return env_path, tried
    if os.path.isabs(env_path) or os.path.dirname(env_path):
        return env_path, tried
    beside_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), env_path)
    tried.append(beside_script)
    if os.path.exists(beside_script):
        return beside_script, tried
    return env_path, tried


def normalize_base_url(base_url):
    """
    Normalize the API host, adding the version segment when it is absent.

    A .env in the wild carries either form: 'https://api.velocityweather.com' or
    'https://api.velocityweather.com/v1'. Every request path in this script is
    relative to the versioned root, so the bare host would produce a 404 on every
    call and look exactly like an unauthorized product.

    Args:
        base_url (str, optional): The configured host, or None for the default.

    Returns:
        str: A versioned API root with no trailing slash.
    """
    root = (base_url or DEFAULT_API_HOST).strip().rstrip('/')
    if not re.search(r'/v\d+$', root):
        root += '/v1'
    return root


def get_credentials(env_path='.env'):
    """
    Get API credentials and the API host from a .env file.

    The file is the only source. Environment variables are deliberately not read:
    one visible file is easier to audit than a value that could arrive from a
    shell, a container, or a cron environment, and a stale exported key silently
    taking precedence over the file is a confusing failure to diagnose.

    Two name pairs are accepted so that one shared .env can serve every tool
    folder in this repository:

        BARON_API_KEY / BARON_API_SECRET                (checked first)
        BARON_ACCESS_KEY / BARON_ACCESS_KEY_SECRET      (fallback)

    Args:
        env_path (str): Path to the .env file. Defaults to '.env', which resolves
            through resolve_env_path().

    Returns:
        tuple[str, str, str]: (key, secret, api_base_url). All three are non-empty
            strings if this function returns.

    Raises:
        ValueError: If either credential is absent. The message names every path
            searched and both accepted name pairs.

    Side Effects:
        Logs the masked key at INFO level for verification.
    """
    resolved, tried = resolve_env_path(env_path)
    values = load_env(resolved)

    key = values.get('BARON_API_KEY') or values.get('BARON_ACCESS_KEY')
    secret = values.get('BARON_API_SECRET') or values.get('BARON_ACCESS_KEY_SECRET')
    base_url = normalize_base_url(values.get('BARON_API_BASE_URL'))

    if not key or not secret:
        raise ValueError(
            "API credentials not found. Set BARON_API_KEY and BARON_API_SECRET "
            "(or BARON_ACCESS_KEY and BARON_ACCESS_KEY_SECRET) in a .env file. "
            "Searched:\n  " + "\n  ".join(tried)
            + "\nCredentials are read from the .env file only, not the environment. "
              "Copy env.example to .env to get started."
        )

    logging.info(f"Using access key: {mask_credential(key)}")
    logging.debug(f"Credentials read from {resolved}")
    return key, secret, base_url


def sig(key, secret):
    """
    Generate the HMAC-SHA1 signature query fragment for one request.

    The scheme: sign "{key}:{unix_timestamp}" with the secret, base64-encode the
    digest with the URL-safe alphabet, then percent-encode the '=' padding. The
    timestamp is what stops a captured signature being replayed later.

    Args:
        key (str): Baron API access key.
        secret (str): Baron API secret. Never logged.

    Returns:
        str: 'sig={signature}&ts={unix_timestamp}'
    """
    ts = "{:.0f}".format(time.time())
    to_sign = key + ":" + ts
    hashval = hmac.new(secret.encode('utf-8'), to_sign.encode('utf-8'), hashlib.sha1)
    sig_bytes = base64.urlsafe_b64encode(hashval.digest()).replace(b'=', b'%3D')
    return "sig={}&ts={}".format(sig_bytes.decode('latin-1'), ts)


def sign_request(url, key, secret):
    """
    Append an HMAC signature to a URL.

    Args:
        url (str): The URL to sign.
        key (str): Baron API access key.
        secret (str): Baron API secret.

    Returns:
        str: The signed URL.
    """
    separator = '?' if url.find("?") == -1 else '&'
    return url + "{}{}".format(separator, sig(key, secret))


# ============================================================================
# HTTP
# ============================================================================

class TransientError(Exception):
    """A server-side or network failure that is worth retrying."""


@retry(
    retry=retry_if_exception_type((TransientError,
                                   requests.exceptions.ConnectionError,
                                   requests.exceptions.Timeout)),
    stop=stop_after_attempt(5),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    reraise=True,
)
def fetch_with_retry(url, timeout=30):
    """
    GET a URL, retrying only what is worth retrying.

    5xx responses and connection or timeout errors are retried up to 5 times with
    exponential backoff. 4xx responses are raised immediately: a 403 or a 404 is
    not transient, and retrying it only delays the error the caller needs to see.

    Args:
        url (str): The URL to fetch.
        timeout (int, optional): Per-attempt timeout in seconds. Defaults to 30.

    Returns:
        requests.Response: A response with a 2xx or 3xx status.

    Raises:
        requests.exceptions.HTTPError: On a 4xx response.
        TransientError: On a 5xx response, after the retries are exhausted.
    """
    response = requests.get(url, timeout=timeout)

    if response.status_code >= 500:
        logging.warning(f"Server returned {response.status_code}, retrying")
        raise TransientError(f"{response.status_code} from {url.split('?')[0]}")

    response.raise_for_status()
    return response


# ============================================================================
# API
# ============================================================================

def get_metadata(product, projection, older_than, key, secret, base_url,
                 page_size=500, product_type='observational'):
    """
    List product instances, newest first.

    Observational products live under /meta/tiles/ and forecast products under
    /meta/maps/. --product-type decides which is tried first; the other is the
    fallback, so a mislabelled product still resolves at the cost of one 404.

    Args:
        product (str): Product code, e.g. 'C39-0x03EA-0'.
        projection (str): Projection name, e.g. 'Standard-Mercator'.
        older_than (str): Return instances older than this ISO 8601 timestamp.
        key (str): Baron API access key.
        secret (str): Baron API secret.
        base_url (str): API host.
        page_size (int, optional): Records per page. Defaults to 500.
        product_type (str, optional): 'observational' or 'forecast'.

    Returns:
        list[dict]: Instance records, each with at least a 'time' field.

    Raises:
        requests.exceptions.RequestException: If both endpoints fail.
    """
    endpoints = ['tiles', 'maps'] if product_type == 'observational' else ['maps', 'tiles']
    last_error = None

    for endpoint in endpoints:
        uri = (f"/meta/{endpoint}/product-instances/{product}/{projection}.json"
               f"?page_size={page_size}&older_than={older_than}")
        url = sign_request(f"{base_url}/{key}{uri}", key, secret)
        logging.debug(f"Trying /{endpoint}/ endpoint")

        try:
            response = fetch_with_retry(url)
        except requests.exceptions.HTTPError as error:
            status = error.response.status_code if error.response is not None else None
            if status == 404:
                logging.debug(f"/{endpoint}/ returned 404, trying the next endpoint")
                last_error = error
                continue
            raise

        records = response.json()
        logging.info(f"Retrieved {len(records)} instance records from /{endpoint}/")
        return records

    raise requests.exceptions.RequestException(
        f"Product '{product}' with projection '{projection}' was not found. Tried "
        + ", ".join(f"/meta/{name}/" for name in endpoints)
        + ". Check that the product code and projection are correct, that your key "
          "is authorized for this product, and that --product-type matches "
          "(observational vs forecast)."
    ) from last_error


def resolve_timestamp(product, projection, timestamp, key, secret, base_url,
                      product_type='observational'):
    """
    Turn 'latest' into a real instance time. Any other value is returned as given.

    An exact timestamp is deliberately not looked up. Resolving it through an
    'older_than' query returns the newest instance *before* the requested time,
    which silently hands back a different frame than the one asked for. Passing it
    through means a time that does not exist fails loudly instead.

    Args:
        product (str): Product code.
        projection (str): Projection name.
        timestamp (str): 'latest' or an ISO 8601 timestamp.
        key (str): Baron API access key.
        secret (str): Baron API secret.
        base_url (str): API host.
        product_type (str, optional): 'observational' or 'forecast'.

    Returns:
        str: An ISO 8601 instance timestamp.

    Raises:
        RuntimeError: If the product has no instances at all.
    """
    if timestamp.casefold() != 'latest':
        return timestamp

    # 'older_than' needs a bound in the future, because the newest instance can
    # carry a timestamp slightly ahead of the clock on this machine.
    tomorrow = (datetime.datetime.now(datetime.timezone.utc)
                .replace(hour=0, minute=0, second=0, microsecond=0)
                + datetime.timedelta(days=1))
    bound = tomorrow.strftime('%Y-%m-%dT%H:%M:%SZ')

    records = get_metadata(product, projection, bound, key, secret, base_url,
                           page_size=1, product_type=product_type)
    if not records:
        raise RuntimeError(
            f"No instances available for {product}/{projection}. The product exists "
            "but has published nothing; try --list-times to confirm."
        )

    resolved = records[0]['time']
    logging.info(f"Resolved 'latest' to {resolved}")
    return resolved


def get_geotiff(product, projection, timestamp, key, secret, base_url):
    """
    Fetch the raster bytes for one instance.

    The endpoint answers in one of two ways. Observational products return the
    GeoTIFF directly. Forecast products return JSON holding a presigned S3 URL in
    a 'source' field, which then has to be fetched separately.

    Args:
        product (str): Product code.
        projection (str): Projection name.
        timestamp (str): ISO 8601 instance time.
        key (str): Baron API access key.
        secret (str): Baron API secret.
        base_url (str): API host.

    Returns:
        bytes: The GeoTIFF.

    Raises:
        requests.exceptions.RequestException: On an HTTP failure.
        ValueError: If a JSON response carries no 'source' URL.
    """
    uri = f"/geotiff/{product}/{projection}/{timestamp}.json"
    url = sign_request(f"{base_url}/{key}{uri}", key, secret)

    logging.info(f"Fetching GeoTIFF: {product}/{projection}/{timestamp}")
    response = fetch_with_retry(url)
    content_type = response.headers.get('Content-Type', '')

    if 'application/json' not in content_type:
        logging.info(f"Received {len(response.content)} bytes ({content_type})")
        return response.content

    payload = response.json()
    if 'source' not in payload:
        raise ValueError(f"JSON response carries no 'source' URL: {payload}")

    logging.info("Response is a redirect to S3, following it")
    s3_response = fetch_with_retry(payload['source'], timeout=60)
    logging.info(f"Downloaded {len(s3_response.content)} bytes from S3")
    return s3_response.content


def legend_url(product, projection):
    """
    Build the legend URL for a product and projection.

    Args:
        product (str): Product code.
        projection (str): Projection name.

    Returns:
        str: The public CDN URL of the GeoTIFF legend.
    """
    return f"{LEGEND_BASE_URL}/{product}/{projection}/geotiff_legend.json"


def get_legend(product, projection):
    """
    Fetch the legend document from the static CDN.

    Legends are public. No signature is applied and no credentials are needed, so
    this works even without a .env file.

    Args:
        product (str): Product code.
        projection (str): Projection name.

    Returns:
        tuple[dict|list, str]: The legend document and the URL it came from.

    Raises:
        requests.exceptions.RequestException: On an HTTP failure.
        json.JSONDecodeError: If the response is not JSON.
    """
    url = legend_url(product, projection)
    logging.info(f"Fetching legend for {product}/{projection}")

    try:
        response = fetch_with_retry(url)
    except requests.exceptions.HTTPError as error:
        status = error.response.status_code if error.response is not None else None
        if status == 404:
            logging.error(
                f"No legend at {url}. The projection is the usual cause: a legend "
                "exists per product AND projection, and the name has to match "
                "exactly."
            )
        raise

    logging.info(f"Retrieved legend ({len(response.content)} bytes)")
    return response.json(), url


# ============================================================================
# Legend parsing
# ============================================================================

def parse_palette(legend, palette_index=0):
    """
    Turn a legend document into a colour table and a label map.

    Two shapes are accepted. The CDN serves the first; the second turns up in
    hand-built and exported legends:

        {"palettes": [{"entries": [{"color": "#RRGGBBaa", "value": "0.5 dBZ"}]}]}
        [{"value": 67, "rgba": [1, 243, 247, 255], "label": "0.5 dBZ"}]

    In the first shape the array position is the pixel value, and alpha is the
    LAST two hex digits, not the first as CSS would have it. In the second the
    'value' field carries the index, so indices can be sparse.

    A Mask1-Mercator radar legend holds three palettes: rain, mixed, and snow. A
    TIFF holds one colour table, so palette_index picks which one to use.

    Labels that mean "no value" ('Undefined' and friends) are dropped, so callers
    do not have to filter hundreds of dead entries back out.

    Args:
        legend (dict|list): The legend document.
        palette_index (int, optional): Which palette to read. Defaults to 0.

    Returns:
        tuple[dict, dict]: ({index: (r, g, b, a)}, {index: label}). The label map
            holds only indices that carry a real label.

    Raises:
        ValueError: If the document shape, the palette index, or an entry is not
            usable. Embedding a half-understood palette would be worse than
            failing here.
    """
    colors = {}
    labels = {}

    if isinstance(legend, dict) and 'palettes' in legend:
        palettes = legend.get('palettes')
        if not isinstance(palettes, list) or not palettes:
            raise ValueError("Legend has no palettes: 'palettes' must be a non-empty list")
        if not 0 <= palette_index < len(palettes):
            raise ValueError(
                f"--palette {palette_index} is out of range: this legend has "
                f"{len(palettes)} palette(s), so the valid range is 0 to "
                f"{len(palettes) - 1}"
            )

        entries = palettes[palette_index].get('entries')
        if not isinstance(entries, list) or not entries:
            raise ValueError(f"Palette {palette_index} has no 'entries' list")

        for index, entry in enumerate(entries):
            if 'color' not in entry:
                raise ValueError(f"Entry {index} has no 'color' field")
            hex_color = str(entry['color']).lstrip('#')
            if len(hex_color) != 8:
                raise ValueError(
                    f"Entry {index}: colour must be 8 hex digits as #RRGGBBaa, "
                    f"got '{entry['color']}'"
                )
            try:
                channels = tuple(int(hex_color[at:at + 2], 16) for at in (0, 2, 4, 6))
            except ValueError:
                raise ValueError(f"Entry {index}: '{entry['color']}' is not hex")

            colors[index] = channels
            label = str(entry.get('value', '')).strip()
            if label.casefold() not in EMPTY_LABELS:
                labels[index] = label

    elif isinstance(legend, list):
        if not legend:
            raise ValueError("Legend is an empty list")
        for entry in legend:
            if not isinstance(entry, dict) or 'value' not in entry:
                raise ValueError(f"Entry has no 'value' field: {entry}")
            if 'rgba' not in entry:
                raise ValueError(f"Entry {entry['value']} has no 'rgba' field")

            rgba = entry['rgba']
            if not isinstance(rgba, list) or len(rgba) != 4:
                raise ValueError(
                    f"Entry {entry['value']}: 'rgba' must be a list of 4 integers")
            if not all(isinstance(channel, int) and 0 <= channel <= 255
                       for channel in rgba):
                raise ValueError(
                    f"Entry {entry['value']}: rgba channels must be 0-255")

            index = int(entry['value'])
            colors[index] = tuple(rgba)
            label = str(entry.get('label', '')).strip()
            if label.casefold() not in EMPTY_LABELS:
                labels[index] = label

    else:
        raise ValueError(
            "Unsupported legend shape. Expected either a dict with a 'palettes' "
            "list or a list of {value, rgba, label} entries."
        )

    if not colors:
        raise ValueError("Legend produced no colour entries")

    return colors, labels


# ============================================================================
# Palette embedding
# ============================================================================

def write_colored(raw_path, color_path, legend, palette_index=0, provenance=None):
    """
    Copy a raster and attach the legend to the copy as a native TIFF palette.

    The copy is byte for byte, then GDAL opens it in update mode and writes the
    colour table and the metadata. Nothing rewrites pixels, so values, NoData,
    compression, and georeferencing are exactly what the API delivered and the
    file stays queryable by index.

    Transparency needs care, because a TIFF colour map holds RGB and nothing else.
    GDAL accepts a 4-tuple and then drops the alpha when it writes the tag, so the
    palette alone would render a transparent no-data head as solid black. Three
    carriers cover it instead:

        internal mask band   pixels whose palette alpha is 0 are marked invalid.
                             Self-contained, honoured by GDAL and QGIS, and it
                             leaves the pixel values alone.
        ALPHA_<index>        band metadata for every index whose alpha is not 255,
                             so partial alpha survives as data even though no
                             raster format carries it in a palette.
        LEGEND_JSON          the whole legend, RGBA intact.

    Transparent indices are NOT remapped to a NoData value: that would destroy the
    very index values a point query needs.

    What lands in the file:

        colour table (RGB)               band 1, ColorInterp=Palette
        internal mask band               band 1, when the legend has alpha 0
        VALUE_<index>                    band 1 metadata, one per labelled index
        ALPHA_<index>                    band 1 metadata, where alpha is not 255
        LEGEND_JSON                      dataset metadata, the whole document
        LEGEND_PALETTE_INDEX             dataset metadata
        anything in provenance           dataset metadata

    A Raster Attribute Table is not used. GDAL writes a RAT to a .aux.xml sidecar
    rather than into the TIFF, which defeats the point of a self-contained file.

    Args:
        raw_path (str): The GeoTIFF to copy.
        color_path (str): Where to write the coloured copy.
        legend (dict|list): The legend document, embedded verbatim.
        palette_index (int, optional): Which palette to use. Defaults to 0.
        provenance (dict, optional): Extra dataset metadata, e.g. PRODUCT.

    Raises:
        ImportError: If GDAL is not installed.
        ValueError: If the raster is not a single-band 8-bit raster, or the legend
            cannot be parsed. Nothing is left behind in either case.
    """
    try:
        import numpy
        from osgeo import gdal
    except ImportError as error:
        raise ImportError(
            "The coloured copy needs the GDAL Python bindings (osgeo) and numpy, "
            "which are not installed. Install GDAL, or use --no-color to fetch the "
            "raw GeoTIFF and the legend without it."
        ) from error

    gdal.UseExceptions()

    colors, labels = parse_palette(legend, palette_index)

    # Validate before copying, so a refusal never leaves a stray file behind.
    source = gdal.Open(raw_path, gdal.GA_ReadOnly)
    try:
        band_count = source.RasterCount
        data_type = source.GetRasterBand(1).DataType
        type_name = gdal.GetDataTypeName(data_type)
    finally:
        source = None

    if band_count != 1 or data_type != gdal.GDT_Byte:
        raise ValueError(
            f"A palette applies only to a single-band 8-bit (Byte) raster. This "
            f"file has {band_count} band(s) of type {type_name}. It is most likely "
            f"already expanded to RGB, or it holds physical values rather than "
            f"palette indices, so there is nothing to colour."
        )

    shutil.copy2(raw_path, color_path)

    # Keep the mask inside the TIFF rather than beside it as a .msk sidecar.
    gdal.SetConfigOption('GDAL_TIFF_INTERNAL_MASK', 'YES')

    transparent = sorted(index for index, rgba in colors.items() if rgba[3] == 0)
    partial = sorted(index for index, rgba in colors.items() if 0 < rgba[3] < 255)

    try:
        dataset = gdal.Open(color_path, gdal.GA_Update)
        band = dataset.GetRasterBand(1)

        # A TIFF colour map is RGB. The 4-tuple is accepted and the alpha dropped.
        table = gdal.ColorTable()
        for index in sorted(colors):
            table.SetColorEntry(index, colors[index])
        band.SetRasterColorTable(table)
        band.SetRasterColorInterpretation(gdal.GCI_PaletteIndex)

        for index in sorted(labels):
            band.SetMetadataItem(f'VALUE_{index}', labels[index])

        # Alpha that the colour map cannot hold, kept as data.
        for index in sorted(colors):
            alpha = colors[index][3]
            if alpha != 255:
                band.SetMetadataItem(f'ALPHA_{index}', str(alpha))

        if transparent:
            values = band.ReadAsArray()
            mask = numpy.where(numpy.isin(values, transparent), 0, 255).astype(numpy.uint8)
            band.CreateMaskBand(gdal.GMF_PER_DATASET)
            band.GetMaskBand().WriteArray(mask)
            band.GetMaskBand().FlushCache()

        tags = dict(provenance or {})
        tags['LEGEND_JSON'] = json.dumps(legend, separators=(',', ':'))
        tags['LEGEND_PALETTE_INDEX'] = str(palette_index)
        dataset.SetMetadata(tags)

        band.FlushCache()
        dataset.FlushCache()
        band = None
        dataset = None
    except Exception:
        # A half-written palette is worse than no coloured file at all.
        if os.path.exists(color_path):
            os.remove(color_path)
        raise

    logging.info(
        f"Embedded {len(colors)} colour entries and {len(labels)} labels into "
        f"{color_path}"
    )
    if transparent:
        logging.info(
            f"Masked {len(transparent)} transparent index value(s) via an internal "
            f"mask band: {_summarize_indices(transparent)}"
        )
    if partial:
        logging.warning(
            f"{len(partial)} index value(s) have partial alpha, which no raster "
            f"palette can carry: {_summarize_indices(partial)}. The exact values "
            f"are in the ALPHA_<index> tags and in the legend; use --qml if you "
            f"need QGIS to honour them when rendering."
        )


def _summarize_indices(indices):
    """
    Render a sorted index list compactly, collapsing runs into ranges.

    A radar legend marks indices 0-66 transparent, and '0-66' reads better in a log
    line than sixty-seven comma-separated numbers.

    Args:
        indices (list[int]): Sorted, unique indices.

    Returns:
        str: e.g. '0-66, 179-255'
    """
    if not indices:
        return 'none'

    runs = []
    start = previous = indices[0]
    for index in indices[1:]:
        if index == previous + 1:
            previous = index
            continue
        runs.append((start, previous))
        start = previous = index
    runs.append((start, previous))

    return ', '.join(str(low) if low == high else f'{low}-{high}'
                     for low, high in runs)


def write_qml(colors, labels, qml_path):
    """
    Write a QGIS paletted-renderer style sidecar.

    The embedded colour table already renders correctly in QGIS. This is for the
    Identify tool, which shows the label text next to each class.

    Only labelled indices are listed, so the legend panel stays readable.

    Args:
        colors (dict): {index: (r, g, b, a)}.
        labels (dict): {index: label}.
        qml_path (str): Where to write the .qml file.
    """
    rows = []
    for index in sorted(labels):
        red, green, blue, alpha = colors[index]
        rows.append(
            f'        <paletteEntry value="{index}" '
            f'color="#{red:02x}{green:02x}{blue:02x}" alpha="{alpha}" '
            f'label="{saxutils.escape(labels[index])}"/>'
        )

    with open(qml_path, 'w', encoding='utf-8') as handle:
        handle.write(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            "<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>\n"
            '<qgis version="3.0.0" styleCategories="AllStyleCategories">\n'
            '  <pipe>\n'
            '    <rasterrenderer opacity="1" alphaBand="-1" band="1" type="paletted">\n'
            '      <rasterTransparency/>\n'
            '      <colorPalette>\n'
            + '\n'.join(rows) + '\n'
            '      </colorPalette>\n'
            '    </rasterrenderer>\n'
            '    <brightnesscontrast brightness="0" contrast="0"/>\n'
            '    <rasterresampler maxOversampling="2"/>\n'
            '  </pipe>\n'
            '  <blendMode>0</blendMode>\n'
            '</qgis>\n'
        )

    logging.info(f"Wrote QGIS style: {qml_path}")


# ============================================================================
# Output naming
# ============================================================================

def default_output_name(product, projection, timestamp):
    """
    Build the default output filename for one instance.

    Args:
        product (str): Product code.
        projection (str): Projection name.
        timestamp (str): ISO 8601 instance time.

    Returns:
        str: e.g. 'C39-0x03EA-0_Standard-Mercator_20260810T143000Z.tif'
    """
    compact = timestamp.replace('-', '').replace(':', '')
    return f"{product}_{projection}_{compact}.tif"


def stem_of(output_path):
    """
    Strip a trailing '.tif' or '.tiff' from a path.

    Args:
        output_path (str): The raw output path.

    Returns:
        str: The path without its raster extension, used to name the sibling files.
    """
    root, extension = os.path.splitext(output_path)
    return root if extension.lower() in ('.tif', '.tiff') else output_path


# ============================================================================
# Main
# ============================================================================

def build_parser():
    """Build the argument parser."""
    parser = argparse.ArgumentParser(
        description="Fetch a Baron GeoTIFF and write a copy with its legend "
                    "embedded as a native TIFF palette.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Latest instance: raw file, coloured copy, and legend
  %(prog)s --product C39-0x03EA-0 --projection Standard-Mercator

  # An exact instance, to a chosen name
  %(prog)s --product C39-0x03EA-0 --projection Standard-Mercator \\
      --timestamp 2026-08-10T14:30:00Z --output radar.tif

  # What instances exist?
  %(prog)s --product C39-0x03EA-0 --projection Standard-Mercator --list-times 10

  # Radar with precipitation-type masks: pick the snow palette
  %(prog)s --product north-american-radar --projection Mask1-Mercator --palette 2

  # A forecast product
  %(prog)s --product hrrr-smoke-surface --projection Standard-Geodetic \\
      --product-type forecast

  # Download only, no GDAL needed
  %(prog)s --product C39-0x03EA-0 --projection Standard-Mercator --no-color

  # Re-colour an earlier download without fetching anything
  %(prog)s --product C39-0x03EA-0 --projection Standard-Mercator \\
      --legend saved_legend.json --palette 1

Credentials (.env file only, never the environment):
  BARON_API_KEY / BARON_API_SECRET             preferred
  BARON_ACCESS_KEY / BARON_ACCESS_KEY_SECRET   also accepted
  BARON_API_BASE_URL                           optional API host override

  Copy env.example to .env. Searched in this directory, then beside the script.

Exit codes:
  0  success
  1  fatal error, nothing downloaded
  2  the raw GeoTIFF was saved but the legend or the coloured copy failed
        """
    )

    parser.add_argument('--product', required=True, metavar='CODE',
                        help='product code, e.g. C39-0x03EA-0')
    parser.add_argument('--projection', default='Standard-Mercator', metavar='NAME',
                        help='projection name (default: Standard-Mercator)')
    parser.add_argument('--product-type', choices=['observational', 'forecast'],
                        default='observational',
                        help='observational products use /meta/tiles/, forecast '
                             'products use /meta/maps/. The other is tried as a '
                             'fallback (default: observational)')

    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--timestamp', default='latest', metavar='TIME',
                      help='"latest" or an ISO 8601 instance time such as '
                           '2026-08-10T14:30:00Z (default: latest). An exact time '
                           'is used verbatim and fails if it does not exist')
    mode.add_argument('--list-times', nargs='?', type=int, const=10, default=None,
                      metavar='N',
                      help='print the N most recent instance times and exit '
                           '(default N: 10)')

    parser.add_argument('--output', metavar='PATH',
                        help='raw GeoTIFF path (default: '
                             '<product>_<projection>_<time>.tif). The coloured '
                             'copy and the legend are named from this')
    parser.add_argument('--color-output', metavar='PATH',
                        help='coloured GeoTIFF path (default: <stem>_color.tif)')
    parser.add_argument('--no-color', action='store_true',
                        help='skip the coloured copy. GDAL is then not needed')
    parser.add_argument('--palette', type=int, default=0, metavar='N',
                        help='which palette to embed when a legend holds several, '
                             'as Mask1-Mercator radar does with rain/mixed/snow '
                             '(default: 0)')
    parser.add_argument('--legend', metavar='PATH',
                        help='read the legend from this local JSON file instead of '
                             'fetching it from the CDN')
    parser.add_argument('--save-legend', metavar='PATH',
                        help='where to save the fetched legend '
                             '(default: <stem>_legend.json)')
    parser.add_argument('--qml', action='store_true',
                        help='also write a QGIS .qml style sidecar')

    parser.add_argument('--env', default='.env', metavar='PATH',
                        help='path to the .env holding the credentials (default: '
                             '.env in this directory, then beside the script)')
    parser.add_argument('--log-file', default='logs/baron_geotiff.log', metavar='PATH',
                        help='log file path (default: logs/baron_geotiff.log)')
    parser.add_argument('--log-level', choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'],
                        default='INFO', help='log level (default: INFO)')
    parser.add_argument('--quiet', action='store_true',
                        help='suppress console output')

    return parser


def main():
    """Fetch, colour, and report. Returns a process exit code."""
    parser = build_parser()
    args = parser.parse_args()

    if args.palette < 0:
        parser.error('--palette must be 0 or greater')

    setup_logging(log_file=args.log_file,
                  log_level=getattr(logging, args.log_level),
                  quiet=args.quiet)

    def say(message):
        """Print a summary line unless --quiet. Failures bypass this and use stderr."""
        if not args.quiet:
            print(message)

    partial = False

    try:
        # ---- Discovery -----------------------------------------------------
        if args.list_times is not None:
            key, secret, base_url = get_credentials(args.env)
            tomorrow = (datetime.datetime.now(datetime.timezone.utc)
                        .replace(hour=0, minute=0, second=0, microsecond=0)
                        + datetime.timedelta(days=1))
            records = get_metadata(
                args.product, args.projection,
                tomorrow.strftime('%Y-%m-%dT%H:%M:%SZ'),
                key, secret, base_url,
                page_size=args.list_times, product_type=args.product_type)

            print(f"\nInstances for {args.product}/{args.projection}:")
            print("-" * 60)
            for position, record in enumerate(records[:args.list_times], 1):
                print(f"{position:3d}. {record.get('time', 'unknown')}")
            print("-" * 60)
            print(f"{min(args.list_times, len(records))} shown")
            return EXIT_SUCCESS

        # ---- Fetch ---------------------------------------------------------
        key, secret, base_url = get_credentials(args.env)
        timestamp = resolve_timestamp(args.product, args.projection, args.timestamp,
                                      key, secret, base_url, args.product_type)

        output = args.output or default_output_name(args.product, args.projection,
                                                    timestamp)
        stem = stem_of(output)

        parent = os.path.dirname(os.path.abspath(output))
        os.makedirs(parent, exist_ok=True)

        data = get_geotiff(args.product, args.projection, timestamp, key, secret,
                           base_url)
        with open(output, 'wb') as handle:
            handle.write(data)
        logging.info(f"Saved {output} ({len(data)} bytes)")
        say(f"Raw GeoTIFF     : {output}")

        # ---- Legend --------------------------------------------------------
        # From here on, the download is safe. A later failure is partial, not fatal.
        legend = None
        source_url = None

        if args.legend:
            with open(args.legend) as handle:
                legend = json.load(handle)
            source_url = os.path.abspath(args.legend)
            logging.info(f"Using local legend {args.legend}")
            say(f"Legend          : {args.legend} (local)")
            if args.save_legend:
                with open(args.save_legend, 'w') as handle:
                    json.dump(legend, handle, indent=2)
                say(f"Legend saved    : {args.save_legend}")
        else:
            try:
                legend, source_url = get_legend(args.product, args.projection)
                legend_path = args.save_legend or f"{stem}_legend.json"
                with open(legend_path, 'w') as handle:
                    json.dump(legend, handle, indent=2)
                say(f"Legend          : {legend_path}")
            except Exception as error:
                logging.error(f"Legend fetch failed: {error}")
                print("Legend          : FAILED, see the log", file=sys.stderr)
                partial = True

        # ---- Colour --------------------------------------------------------
        if args.no_color:
            logging.info("Skipping the coloured copy (--no-color)")
        elif legend is None:
            logging.error("No legend, so no coloured copy. Fix the legend first, "
                          "then re-run with --legend to colour without refetching.")
            partial = True
        else:
            color_output = args.color_output or f"{stem}_color.tif"
            try:
                write_colored(output, color_output, legend, args.palette, {
                    'PRODUCT': args.product,
                    'PROJECTION': args.projection,
                    'INSTANCE_TIME': timestamp,
                    'LEGEND_URL': source_url or '',
                })
                say(f"Coloured GeoTIFF: {color_output}")

                if args.qml:
                    colors, labels = parse_palette(legend, args.palette)
                    qml_path = f"{stem_of(color_output)}.qml"
                    write_qml(colors, labels, qml_path)
                    say(f"QGIS style      : {qml_path}")
            except (ImportError, ValueError, RuntimeError) as error:
                logging.error(f"Colouring failed: {error}")
                print(f"Coloured GeoTIFF: FAILED — {error}", file=sys.stderr)
                partial = True

        if partial:
            logging.warning("Finished with failures: the raw GeoTIFF was saved")
            return EXIT_PARTIAL_SUCCESS

        logging.info("Done")
        return EXIT_SUCCESS

    except ValueError as error:
        logging.error(f"{error}")
        return EXIT_PARTIAL_SUCCESS if partial else EXIT_FATAL_ERROR
    except FileNotFoundError as error:
        logging.error(f"File not found: {error}")
        return EXIT_PARTIAL_SUCCESS if partial else EXIT_FATAL_ERROR
    except KeyboardInterrupt:
        logging.warning("Interrupted")
        return EXIT_FATAL_ERROR
    except Exception as error:
        logging.error(f"{error}", exc_info=args.log_level == 'DEBUG')
        return EXIT_PARTIAL_SUCCESS if partial else EXIT_FATAL_ERROR


if __name__ == '__main__':
    sys.exit(main())
