#!/usr/bin/env python3
"""
Baron GeoTIFF Retrieval Script

This script provides a unified interface for fetching Baron GeoTIFF data
from the Velocity Weather API and saving it to local files.

Usage Modes:
    1. Fetch single GeoTIFF:
        python geotiff_fetch.py --product C39-0x03EA-0 \
            --projection Standard-Mercator --timestamp latest \
            --output temperature.tif

    2. Fetch multiple GeoTIFFs with time range:
        python geotiff_fetch.py --product C39-0x03EA-0 \
            --projection Standard-Mercator --starttime 2024-05-26T06:00:00Z \
            --endtime 2024-05-27T06:00:00Z --output-dir geotiffs/

    3. Fetch latest with metadata:
        python geotiff_fetch.py --product C39-0x03EA-0 \
            --projection Standard-Mercator --timestamp latest \
            --output latest.tif --save-metadata meta.json

    4. List available timestamps:
        python geotiff_fetch.py --product C39-0x03EA-0 \
            --projection Standard-Mercator --list-times

    5. Download legend (color scale):
        python geotiff_fetch.py --product north-american-radar \
            --projection Mask1-Mercator --save-legend legend.json

Environment Variables:
    BARON_ACCESS_KEY: API access key (can override with --access-key)
    BARON_ACCESS_KEY_SECRET: API secret (can override with --access-key-secret)
"""

import argparse
import base64
import datetime
import hashlib
import hmac
import json
import logging
import os
import sys
import time
from logging.handlers import RotatingFileHandler
from urllib.parse import urlencode
from urllib.request import urlopen
from urllib.error import URLError, HTTPError

import requests
from tenacity import retry, stop_after_attempt, wait_exponential


# ============================================================================
# Constants and Configuration
# ============================================================================

API_HOST = "https://api.velocityweather.com/v1"
LEGEND_BASE_URL = "https://static.velocityweather.com/legends"
LOG_FILE_MAX_BYTES = 10 * 1024 * 1024  # 10MB
LOG_BACKUP_COUNT = 10

# Common projections
COMMON_PROJECTIONS = [
    "Standard-Mercator",
    "Standard-Geodetic"
]

# Exit codes
EXIT_SUCCESS = 0
EXIT_FATAL_ERROR = 1
EXIT_PARTIAL_SUCCESS = 2

# Endpoint type cache (session-level, persists across function calls)
_ENDPOINT_CACHE = {}


# ============================================================================
# Logging Setup
# ============================================================================

def setup_logging(log_file=None, log_level=logging.INFO, quiet=False):
    """
    Configure unified logging with console and optional file output.

    Sets up a dual-channel logging system with both console and file handlers.
    The console handler respects the specified log level, while the file handler
    always logs at DEBUG level for comprehensive troubleshooting. Uses rotating
    file handler to prevent disk space issues.

    Args:
        log_file (str, optional): Absolute path to log file. If provided, creates
            parent directories automatically. Defaults to None (no file logging).
        log_level (int, optional): Minimum logging level for console output.
            Use logging.DEBUG, logging.INFO, logging.WARNING, or logging.ERROR.
            Defaults to logging.INFO.
        quiet (bool, optional): If True, suppresses all console output (file
            logging continues if log_file provided). Useful for automation/cron.
            Defaults to False.

    Side Effects:
        - Clears all existing handlers from root logger
        - Sets root logger level to DEBUG (most permissive)
        - Creates log file parent directories if they don't exist
        - Configures rotating file handler (10MB per file, 10 backups)

    Time Complexity: O(1)
    Space Complexity: O(1)

    Example:
        >>> setup_logging('logs/app.log', logging.DEBUG, quiet=False)
        # Logs DEBUG+ to file, DEBUG+ to console

        >>> setup_logging(log_level=logging.WARNING, quiet=True)
        # No file logging, no console output
    """
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.DEBUG)
    root_logger.handlers.clear()

    formatter = logging.Formatter(
        '%(asctime)s - %(levelname)s - %(message)s'
    )

    # Console handler
    if not quiet:
        console = logging.StreamHandler()
        console.setLevel(log_level)
        console.setFormatter(formatter)
        root_logger.addHandler(console)

    # File handler
    if log_file:
        os.makedirs(os.path.dirname(log_file), exist_ok=True)
        file_handler = RotatingFileHandler(
            log_file,
            maxBytes=LOG_FILE_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT
        )
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(formatter)
        root_logger.addHandler(file_handler)


def mask_credential(credential):
    """
    Mask credential for safe logging while preserving partial identifiability.

    Shows only the first and last 4 characters of credentials to allow verification
    while preventing exposure in logs. Useful for debugging authentication issues
    without compromising security.

    Args:
        credential (str): The credential string to mask (API key, secret, token, etc.)

    Returns:
        str: Masked credential in format "XXXX***YYYY" where XXXX and YYYY are
            the first and last 4 characters. Returns "***" for credentials shorter
            than 8 characters or None/empty values.

    Time Complexity: O(1) - constant time string slicing
    Space Complexity: O(1) - returns fixed-size string

    Security Note:
        First/last 4 characters are sufficient for verification without enabling
        credential reconstruction. Safe for log files and console output.

    Examples:
        >>> mask_credential("abcdefghijklmnop")
        'abcd***mnop'

        >>> mask_credential("short")
        '***'

        >>> mask_credential(None)
        '***'
    """
    if not credential or len(credential) < 8:
        return "***"
    return credential[:4] + "***" + credential[-4:]


# ============================================================================
# Authentication
# ============================================================================

def get_credentials(access_key=None, access_key_secret=None):
    """
    Get API credentials from CLI arguments or environment variables with fallback.

    Implements a two-tier credential resolution strategy:
    1. First priority: CLI arguments (--access-key, --access-key-secret)
    2. Second priority: Environment variables (BARON_ACCESS_KEY, BARON_ACCESS_KEY_SECRET)

    This allows CLI arguments to override environment variables for flexibility
    in multi-account scenarios or testing.

    Args:
        access_key (str, optional): Baron API access key from CLI. Defaults to None.
        access_key_secret (str, optional): Baron API secret from CLI. Defaults to None.

    Returns:
        tuple[str, str]: Tuple containing (access_key, access_key_secret). Both values
            are guaranteed to be non-empty strings if function returns successfully.

    Raises:
        ValueError: If both credentials cannot be resolved from either CLI args or
            environment variables. Provides helpful error message with setup instructions.

    Side Effects:
        - Logs masked access key at INFO level for verification
        - Uses mask_credential() to safely log first/last 4 chars only

    Time Complexity: O(1)
    Space Complexity: O(1)

    Examples:
        >>> # Using environment variables
        >>> os.environ['BARON_ACCESS_KEY'] = 'my_key'
        >>> os.environ['BARON_ACCESS_KEY_SECRET'] = 'my_secret'
        >>> key, secret = get_credentials()

        >>> # Using CLI arguments (overrides env vars)
        >>> key, secret = get_credentials('cli_key', 'cli_secret')

        >>> # Missing credentials
        >>> key, secret = get_credentials()  # Raises ValueError
    """
    # Priority 1: CLI args, Priority 2: Environment variables
    key = access_key or os.getenv('BARON_ACCESS_KEY')
    secret = access_key_secret or os.getenv('BARON_ACCESS_KEY_SECRET')

    if not key or not secret:
        raise ValueError(
            "API credentials not found. Set BARON_ACCESS_KEY and "
            "BARON_ACCESS_KEY_SECRET environment variables or use "
            "--access-key and --access-key-secret flags."
        )

    # Log masked key for verification (security: only shows first/last 4 chars)
    logging.info(f"Using access key: {mask_credential(key)}")
    return key, secret


def sig(key, secret):
    """
    Generate HMAC-SHA1 signature for API request authentication.

    Implements Baron Weather API's authentication scheme using HMAC-SHA1:
    1. Generate Unix timestamp (seconds since epoch)
    2. Create signing string: "{key}:{timestamp}"
    3. Compute HMAC-SHA1 hash using secret as key
    4. Base64-encode result (URL-safe alphabet)
    5. Replace '=' with '%3D' for URL compatibility
    6. Return as query string: "sig={signature}&ts={timestamp}"

    The API validates requests by:
    - Checking timestamp is recent (prevents replay attacks)
    - Recomputing HMAC with server-side secret
    - Comparing signatures (constant-time comparison)

    Args:
        key (str): Baron API access key (public identifier)
        secret (str): Baron API secret (private signing key)

    Returns:
        str: URL query string fragment containing signature and timestamp.
            Format: "sig={base64_signature}&ts={unix_timestamp}"
            Example: "sig=BwcOW5NuOLDAwNhil0L6L4y-ESo%3D&ts=1761154128"

    Time Complexity: O(1)
    Space Complexity: O(1)

    Security Note:
        - Uses HMAC-SHA1 (SHA1 is acceptable for HMAC despite general SHA1 weakness)
        - Timestamp prevents replay attacks (API rejects old signatures)
        - Never log or expose the secret key

    Example:
        >>> signature = sig("my_access_key", "my_secret")
        >>> print(signature)
        'sig=Xj8K2l...&ts=1761154128'
    """
    # Generate Unix timestamp (integer seconds since epoch)
    ts = "{:.0f}".format(time.time())

    # Create string to sign: "key:timestamp"
    to_sign = key + ":" + ts

    # Compute HMAC-SHA1: HMAC(secret, "key:timestamp")
    hashval = hmac.new(secret.encode('utf-8'), to_sign.encode('utf-8'), hashlib.sha1)

    # Base64-encode and URL-encode '=' -> '%3D'
    sig_bytes = base64.urlsafe_b64encode(hashval.digest()).replace(b'=', b'%3D')
    sig_str = sig_bytes.decode('latin-1')

    # Return query string fragment
    return "sig={}&ts={}".format(sig_str, ts)


def sign_request(url, key, secret):
    """
    Sign a URL with HMAC authentication.

    Args:
        url: URL to sign
        key: API access key
        secret: API access key secret

    Returns:
        str: Signed URL
    """
    signature = sig(key, secret)
    q = '?' if url.find("?") == -1 else '&'
    url += "{}{}".format(q, signature)
    return url


# ============================================================================
# API Interaction
# ============================================================================

@retry(stop=stop_after_attempt(10), wait=wait_exponential(multiplier=1, min=2, max=10))
def fetch_with_retry(url, timeout=30):
    """
    Fetch data from URL with automatic retry on failure.

    Args:
        url: URL to fetch
        timeout: Request timeout in seconds

    Returns:
        requests.Response object

    Raises:
        requests.exceptions.RequestException on failure after retries
    """
    response = requests.get(url, timeout=timeout)
    if response.status_code != 200:
        logging.error(f"Non-200 status code: {response.status_code} for URL: {url}")
        response.raise_for_status()
    return response


def get_metadata(product, projection, timestamp, access_key, access_key_secret, page_size=500, product_type='observational'):
    """
    Fetch metadata for a product to get available timestamps.

    Args:
        product: Product code (e.g., "C39-0x03EA-0")
        projection: Projection type (e.g., "Standard-Mercator")
        timestamp: Timestamp to query older than (ISO format or "latest")
        access_key: API access key
        access_key_secret: API secret
        page_size: Number of results per page
        product_type: Product type ('observational' or 'forecast')

    Returns:
        list: List of metadata records with timestamps
    """
    if timestamp.casefold() == "latest".casefold():
        # For latest, nudge time forward to midnight UTC tomorrow
        a = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        a += datetime.timedelta(days=1)
        timestamp = a.isoformat().replace("+00:00", "") + "Z"

    # Check cache for previously successful endpoint
    cache_key = f"{product}/{projection}"
    cached_endpoint = _ENDPOINT_CACHE.get(cache_key)

    # Determine endpoint types to try based on product_type and cache
    if cached_endpoint:
        # Use cached endpoint first
        endpoints_to_try = [cached_endpoint]
        logging.debug(f"Using cached endpoint '{cached_endpoint}' for {cache_key}")
    elif product_type == 'observational':
        # Try tiles first (observational), fallback to maps (forecast)
        endpoints_to_try = ['tiles', 'maps']
    else:  # product_type == 'forecast'
        # Try maps first (forecast), fallback to tiles (observational)
        endpoints_to_try = ['maps', 'tiles']

    last_exception = None

    for endpoint in endpoints_to_try:
        uri = f"/meta/{endpoint}/product-instances/{product}/{projection}.json?page_size={page_size}&older_than={timestamp}"
        url = f"{API_HOST}/{access_key}{uri}"
        url = sign_request(url, access_key, access_key_secret)

        logging.debug(f"Trying /{endpoint}/ endpoint for {cache_key}")

        try:
            response = requests.get(url, timeout=30)

            if response.status_code == 404:
                logging.debug(f"/{endpoint}/ endpoint returned 404 for {cache_key}")
                last_exception = requests.exceptions.HTTPError(f"404 Not Found")
                # Don't retry on 404, try next endpoint
                continue

            # For any other non-200 status, use retry logic
            if response.status_code != 200:
                logging.error(f"Non-200 status code: {response.status_code} for URL: {url}")
                response.raise_for_status()

            # Success! Parse and cache
            metadata = response.json()
            logging.info(f"Retrieved {len(metadata)} metadata records from /{endpoint}/ endpoint")

            # Cache the successful endpoint
            if not cached_endpoint:
                _ENDPOINT_CACHE[cache_key] = endpoint
                logging.debug(f"Cached endpoint type '{endpoint}' for {cache_key}")

            return metadata

        except requests.exceptions.HTTPError as e:
            if '404' in str(e):
                # 404 is expected when trying wrong endpoint, continue to next
                last_exception = e
                continue
            else:
                # Other HTTP errors should be logged and raised
                logging.error(f"HTTP error on /{endpoint}/ endpoint: {e}")
                last_exception = e
                # Don't try next endpoint for non-404 errors
                break
        except requests.exceptions.RequestException as e:
            logging.error(f"Request error on /{endpoint}/ endpoint: {e}")
            last_exception = e
            # Don't try next endpoint for connection errors
            break

    # All attempts failed
    error_msg = f"Product '{product}' not found. Tried endpoints: {', '.join([f'/meta/{e}/' for e in endpoints_to_try])}. "
    error_msg += "Verify: (1) Product code is correct, (2) API access is authorized, (3) Product type matches (use --product-type flag)."
    logging.error(error_msg)

    if last_exception:
        raise last_exception
    else:
        raise requests.exceptions.RequestException(error_msg)


def get_geotiff(product, projection, timestamp, access_key, access_key_secret):
    """
    Fetch a single GeoTIFF from the API.

    For forecast products, the API returns JSON with an S3 URL that must be
    fetched separately. For observational products, it returns the binary directly.

    Args:
        product: Product code
        projection: Projection type
        timestamp: ISO 8601 timestamp
        access_key: API access key
        access_key_secret: API secret

    Returns:
        tuple: (binary_data, content_type)
    """
    uri = f"/geotiff/{product}/{projection}/{timestamp}.json"
    url = f"{API_HOST}/{access_key}{uri}"
    url = sign_request(url, access_key, access_key_secret)

    logging.info(f"Fetching GeoTIFF: {product}/{projection}/{timestamp}")
    logging.debug(f"URL: {url}")

    try:
        response = fetch_with_retry(url)
        content_type = response.headers.get('Content-Type', 'application/octet-stream')

        # Check if response is JSON (forecast products return S3 URLs)
        if 'application/json' in content_type:
            logging.debug(f"Received JSON response, extracting S3 URL")
            json_data = response.json()

            if 'source' not in json_data:
                raise ValueError(f"JSON response missing 'source' field: {json_data}")

            s3_url = json_data['source']
            logging.info(f"Downloading GeoTIFF from S3: {s3_url[:100]}...")

            # Fetch actual GeoTIFF from S3 (URL already has AWS signature)
            s3_response = requests.get(s3_url, timeout=60)
            s3_response.raise_for_status()

            # Return the binary GeoTIFF data
            geotiff_data = s3_response.content
            geotiff_type = s3_response.headers.get('Content-Type', 'image/tiff')
            logging.info(f"Downloaded {len(geotiff_data)} bytes from S3 (type: {geotiff_type})")

            return geotiff_data, geotiff_type
        else:
            # Direct binary response (observational products)
            logging.info(f"Received {len(response.content)} bytes (type: {content_type})")
            return response.content, content_type

    except requests.exceptions.RequestException as e:
        logging.error(f"Failed to fetch GeoTIFF: {e}")
        raise
    except (ValueError, KeyError) as e:
        logging.error(f"Failed to parse GeoTIFF response: {e}")
        raise


def get_legend(product, projection):
    """
    Fetch legend/color scale JSON for a product.

    Retrieves the legend metadata from Baron's static CDN which describes the
    color scale, value ranges, and visual representation used in GeoTIFF products.
    Legend files are product-specific and define how pixel values map to colors.

    Note: Legend URLs do not require authentication (public static resources).

    Args:
        product (str): Product code or name (e.g., "north-american-radar", "C39-0x03EA-0")
        projection (str): Projection type (e.g., "Standard-Mercator", "Mask1-Mercator")

    Returns:
        dict: Legend JSON containing color scale, value ranges, units, etc.
            Typical structure:
            {
                "colors": [...],
                "values": [...],
                "units": "...",
                "description": "..."
            }

    Raises:
        requests.exceptions.RequestException: If legend fetch fails (404, network error, etc.)
        json.JSONDecodeError: If response is not valid JSON

    Time Complexity: O(1) - single HTTP request
    Space Complexity: O(n) where n = legend JSON size (typically < 10KB)

    URL Pattern:
        https://static.velocityweather.com/legends/{product}/{projection}/geotiff_legend.json

    Examples:
        >>> legend = get_legend("north-american-radar", "Mask1-Mercator")
        >>> print(legend['units'])
        'dBZ'

        >>> # Legend files are public (no authentication required)
        >>> legend = get_legend("C39-0x03EA-0", "Standard-Mercator")
    """
    # Construct legend URL (static CDN, no authentication required)
    url = f"{LEGEND_BASE_URL}/{product}/{projection}/geotiff_legend.json"

    logging.info(f"Fetching legend for {product}/{projection}")
    logging.debug(f"Legend URL: {url}")

    try:
        # Legend files are public, no signature needed
        response = requests.get(url, timeout=30)
        response.raise_for_status()

        # Parse JSON legend
        legend_data = response.json()
        logging.info(f"Retrieved legend ({len(response.content)} bytes)")

        return legend_data

    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 404:
            logging.error(
                f"Legend not found for {product}/{projection}. "
                f"Product or projection name may be incorrect, or legend may not exist."
            )
        raise
    except requests.exceptions.RequestException as e:
        logging.error(f"Failed to fetch legend: {e}")
        raise
    except json.JSONDecodeError as e:
        logging.error(f"Failed to parse legend JSON: {e}")
        raise


def fetch_time_range(product, projection, starttime, endtime, access_key, access_key_secret, output_dir, product_type='observational'):
    """
    Fetch all available GeoTIFFs within a time range.

    Args:
        product: Product code
        projection: Projection type
        starttime: Start time (ISO 8601)
        endtime: End time (ISO 8601)
        access_key: API access key
        access_key_secret: API secret
        output_dir: Directory to save files
        product_type: Product type ('observational' or 'forecast')

    Returns:
        tuple: (success_count, failure_count)
    """
    # Get all available timestamps
    logging.info(f"Fetching metadata for time range: {starttime} to {endtime}")
    metadata = get_metadata(product, projection, endtime, access_key, access_key_secret, page_size=500, product_type=product_type)

    # Filter to time range
    start_dt = datetime.datetime.fromisoformat(starttime.replace("Z", "+00:00"))
    end_dt = datetime.datetime.fromisoformat(endtime.replace("Z", "+00:00"))

    filtered_times = []
    for record in metadata:
        record_time = record.get('time')
        if not record_time:
            continue
        record_dt = datetime.datetime.fromisoformat(record_time.replace("Z", "+00:00"))
        if start_dt <= record_dt <= end_dt:
            filtered_times.append(record_time)

    logging.info(f"Found {len(filtered_times)} timestamps in range")

    # Create output directory
    os.makedirs(output_dir, exist_ok=True)

    # Fetch each GeoTIFF
    success_count = 0
    failure_count = 0

    for timestamp in filtered_times:
        try:
            data, content_type = get_geotiff(product, projection, timestamp, access_key, access_key_secret)

            # Generate filename from timestamp
            clean_time = timestamp.replace(":", "").replace("-", "").replace("Z", "")
            filename = f"{product}_{projection}_{clean_time}.tif"
            filepath = os.path.join(output_dir, filename)

            with open(filepath, 'wb') as f:
                f.write(data)

            logging.info(f"Saved: {filepath}")
            success_count += 1

        except Exception as e:
            logging.error(f"Failed to fetch {timestamp}: {e}")
            failure_count += 1

    return success_count, failure_count


# ============================================================================
# Main Pipeline
# ============================================================================

def main():
    """Main entry point for GeoTIFF retrieval."""
    parser = argparse.ArgumentParser(
        description="Baron GeoTIFF Retrieval - Fetch GeoTIFF data from Velocity Weather API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Fetch latest GeoTIFF
  %(prog)s --product C39-0x03EA-0 --projection Standard-Mercator --timestamp latest --output temperature.tif

  # Fetch specific timestamp
  %(prog)s --product C39-0x03EA-0 --projection Standard-Mercator --timestamp 2024-05-26T18:16:25Z --output temperature.tif

  # List available timestamps
  %(prog)s --product C39-0x03EA-0 --projection Standard-Mercator --list-times --count 10

  # Fetch time range
  %(prog)s --product C39-0x03EA-0 --projection Standard-Mercator --starttime 2024-05-26T06:00:00Z --endtime 2024-05-26T12:00:00Z --output-dir geotiffs/

  # Fetch with metadata
  %(prog)s --product C39-0x03EA-0 --projection Standard-Mercator --timestamp latest --output latest.tif --save-metadata meta.json

  # Download legend (color scale)
  %(prog)s --product north-american-radar --projection Mask1-Mercator --save-legend legend.json

Environment Variables:
  BARON_ACCESS_KEY       API access key (required)
  BARON_ACCESS_KEY_SECRET API access key secret (required)

Common Products:
  C39-0x03EA-0              North American Radar
  goes-west-fulldisk-hires-ir  GOES West IR
  baron-hires-visibility-miles-surface  Surface Visibility
  hrrr-smoke-surface        HRRR Smoke

Common Projections:
  Standard-Mercator         Web Mercator (EPSG:3857)
  Standard-Geodetic         WGS84 (EPSG:4326)
  Equidistant-Cylindrical   Plate Carrée

Exit Codes:
  0  Success
  1  Fatal error
  2  Partial success (some files failed)
        """
    )

    # Product specification
    parser.add_argument(
        '--product',
        required=True,
        metavar='CODE',
        help='Product code (e.g., C39-0x03EA-0, north-american-radar)'
    )
    parser.add_argument(
        '--projection',
        required=True,
        metavar='PROJ',
        help='Projection type (e.g., Standard-Mercator, Standard-Geodetic)'
    )
    parser.add_argument(
        '--product-type',
        choices=['observational', 'forecast'],
        default='observational',
        metavar='TYPE',
        help='Product type: observational (realtime/historical data, uses /meta/tiles/) or forecast (model/nowcast data, uses /meta/maps/). Default: observational'
    )

    # Time specification
    time_group = parser.add_mutually_exclusive_group()
    time_group.add_argument(
        '--timestamp',
        metavar='TIME',
        help='Single timestamp in ISO 8601 format (e.g., 2024-05-26T18:16:25Z) or "latest"'
    )
    time_group.add_argument(
        '--starttime',
        metavar='TIME',
        help='Start time for range query (ISO 8601 format). Requires --endtime and --output-dir'
    )
    time_group.add_argument(
        '--list-times',
        action='store_true',
        help='List available timestamps for product (no download)'
    )

    parser.add_argument(
        '--endtime',
        metavar='TIME',
        help='End time for range query (ISO 8601 format). Requires --starttime and --output-dir'
    )

    # Output specification
    parser.add_argument(
        '--output',
        metavar='FILE',
        help='Output filename for single GeoTIFF (used with --timestamp)'
    )
    parser.add_argument(
        '--output-dir',
        metavar='DIR',
        help='Output directory for multiple GeoTIFFs (used with --starttime/--endtime)'
    )
    parser.add_argument(
        '--save-metadata',
        metavar='FILE',
        help='Save product metadata to JSON file'
    )
    parser.add_argument(
        '--save-legend',
        metavar='FILE',
        help='Download and save product legend/color scale JSON file (describes value-to-color mapping)'
    )

    # List options
    parser.add_argument(
        '--count',
        type=int,
        default=10,
        metavar='N',
        help='Number of timestamps to display with --list-times (default: 10)'
    )

    # Credentials
    parser.add_argument(
        '--access-key',
        metavar='KEY',
        help='API access key (overrides BARON_ACCESS_KEY env var)'
    )
    parser.add_argument(
        '--access-key-secret',
        metavar='SECRET',
        help='API secret (overrides BARON_ACCESS_KEY_SECRET env var)'
    )

    # Logging
    parser.add_argument(
        '--log-file',
        metavar='PATH',
        default='logs/geotiff_fetch.log',
        help='Path to log file (default: logs/geotiff_fetch.log)'
    )
    parser.add_argument(
        '--log-level',
        choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'],
        default='INFO',
        help='Console logging level (default: INFO)'
    )
    parser.add_argument(
        '--quiet',
        action='store_true',
        help='Suppress console output'
    )

    args = parser.parse_args()

    # Validate argument combinations
    if args.starttime and not args.endtime:
        parser.error("--endtime is required when using --starttime")
    if args.endtime and not args.starttime:
        parser.error("--starttime is required when using --endtime")
    if args.starttime and args.endtime and not args.output_dir:
        parser.error("--output-dir is required for time range queries")
    if args.timestamp and not args.output and not args.save_metadata:
        parser.error("--output or --save-metadata is required when using --timestamp")
    if args.output and (args.starttime or args.output_dir):
        parser.error("--output is for single files only; use --output-dir for time ranges")

    # Setup logging
    log_level = getattr(logging, args.log_level)
    setup_logging(log_file=args.log_file, log_level=log_level, quiet=args.quiet)

    logging.info("=" * 70)
    logging.info("Baron GeoTIFF Retrieval Starting")
    logging.info("=" * 70)

    try:
        # Handle legend download (can be standalone or combined with other operations)
        if args.save_legend:
            try:
                logging.info(f"Downloading legend for {args.product}/{args.projection}")
                legend_data = get_legend(args.product, args.projection)

                with open(args.save_legend, 'w') as f:
                    json.dump(legend_data, f, indent=2)

                logging.info(f"Legend saved to {args.save_legend}")
                print(f"\nLegend saved to: {args.save_legend}")

                # If only legend download requested (no other modes), exit successfully
                if not any([args.list_times, args.timestamp, args.starttime]):
                    logging.info("Legend download complete")
                    return EXIT_SUCCESS

            except Exception as e:
                logging.error(f"Failed to download legend: {e}")
                # If only legend was requested, exit with error
                if not any([args.list_times, args.timestamp, args.starttime]):
                    return EXIT_FATAL_ERROR
                # Otherwise continue with other operations
                logging.warning("Continuing with other operations despite legend failure")

        # Get credentials (only needed for data operations, not legend)
        access_key, access_key_secret = get_credentials(args.access_key, args.access_key_secret)

        # Mode 1: List available times
        if args.list_times:
            logging.info(f"Mode: List available timestamps")
            logging.info(f"Product: {args.product}")
            logging.info(f"Projection: {args.projection}")
            logging.info(f"Product type: {args.product_type}")

            metadata = get_metadata(args.product, args.projection, "latest",
                                   access_key, access_key_secret, page_size=args.count, product_type=args.product_type)

            print(f"\nAvailable timestamps for {args.product}/{args.projection}:")
            print("-" * 70)
            for i, record in enumerate(metadata[:args.count], 1):
                timestamp = record.get('time', 'N/A')
                print(f"{i:3d}. {timestamp}")
            print("-" * 70)
            print(f"Showing {min(args.count, len(metadata))} of {len(metadata)} available timestamps")

            # Save metadata if requested
            if args.save_metadata:
                with open(args.save_metadata, 'w') as f:
                    json.dump(metadata, f, indent=2)
                logging.info(f"Metadata saved to {args.save_metadata}")

            return EXIT_SUCCESS

        # Mode 2: Fetch single GeoTIFF
        elif args.timestamp:
            logging.info(f"Mode: Fetch single GeoTIFF")
            logging.info(f"Product: {args.product}")
            logging.info(f"Projection: {args.projection}")
            logging.info(f"Timestamp: {args.timestamp}")
            logging.info(f"Product type: {args.product_type}")

            # Get metadata first to resolve "latest"
            metadata = get_metadata(args.product, args.projection, args.timestamp,
                                   access_key, access_key_secret, page_size=1, product_type=args.product_type)

            if not metadata:
                logging.error("No metadata found")
                return EXIT_FATAL_ERROR

            actual_timestamp = metadata[0]['time']
            logging.info(f"Resolved timestamp: {actual_timestamp}")

            # Fetch GeoTIFF
            data, content_type = get_geotiff(args.product, args.projection, actual_timestamp,
                                            access_key, access_key_secret)

            # Save file
            if args.output:
                with open(args.output, 'wb') as f:
                    f.write(data)
                logging.info(f"Saved to {args.output}")

            # Save metadata
            if args.save_metadata:
                with open(args.save_metadata, 'w') as f:
                    json.dump(metadata[0], f, indent=2)
                logging.info(f"Metadata saved to {args.save_metadata}")

            logging.info("Fetch complete")
            return EXIT_SUCCESS

        # Mode 3: Fetch time range
        elif args.starttime and args.endtime:
            logging.info(f"Mode: Fetch time range")
            logging.info(f"Product: {args.product}")
            logging.info(f"Projection: {args.projection}")
            logging.info(f"Time range: {args.starttime} to {args.endtime}")
            logging.info(f"Output directory: {args.output_dir}")
            logging.info(f"Product type: {args.product_type}")

            success_count, failure_count = fetch_time_range(
                args.product, args.projection, args.starttime, args.endtime,
                access_key, access_key_secret, args.output_dir, product_type=args.product_type
            )

            logging.info("=" * 70)
            logging.info("Summary:")
            logging.info(f"  Successful downloads: {success_count}")
            if failure_count > 0:
                logging.info(f"  Failed downloads: {failure_count}")
            logging.info("=" * 70)

            if failure_count > 0:
                logging.warning("Fetch completed with some failures")
                return EXIT_PARTIAL_SUCCESS
            else:
                logging.info("Fetch completed successfully")
                return EXIT_SUCCESS

        else:
            parser.error("Must specify --timestamp, --starttime/--endtime, or --list-times")

    except ValueError as e:
        logging.error(f"Configuration error: {e}")
        return EXIT_FATAL_ERROR
    except FileNotFoundError as e:
        logging.error(f"File not found: {e}")
        return EXIT_FATAL_ERROR
    except Exception as e:
        logging.error(f"Unexpected error: {e}", exc_info=True)
        return EXIT_FATAL_ERROR


if __name__ == '__main__':
    sys.exit(main())
