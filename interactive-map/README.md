# Baron Interactive Map

A very basic map that shows three [Baron Weather](https://www.baronweather.com/) raster
products, delivered through either TMS or WMS. Pick a product, flip the delivery toggle, and
compare the two request styles against the same data.

One static page, no build step, no dependencies to install.

## Setup

```bash
cp env.example .env      # then fill in your key and secret
python3 -m http.server 8000
```

Open <http://localhost:8000/>.

`http.server` runs in the foreground and has to keep running the whole time you use the page, so
start it in a terminal you can leave open and press `Ctrl-C` to stop it when you are done. If port
8000 is already taken it fails with `OSError: [Errno 48] Address already in use` — that failure
appears in the terminal, not in the browser, so check there first if the page will not load. Pick
another port and change the URL to match.

Use `localhost`, not a LAN address. Signing uses `crypto.subtle`, which browsers expose only in
a secure context. `http://localhost` and `http://127.0.0.1` qualify; `http://192.168.1.20:8000`
does not, and the page will tell you so rather than fail obscurely.

## Security

**This is a local demonstration. Do not deploy it as it stands.**

The key and the secret are fetched into the browser, so anyone with the page open can read
them. `http.server` serves the whole folder, so `.env` itself is readable by anything that can
reach the port. A public deployment needs a server that holds the secret and signs on behalf
of the page.

## Files

| File | Purpose |
|---|---|
| `index.html` | Panel markup, styles, MapLibre tags |
| `baron.js` | Credentials, signing, instance lookup, URL building. Knows nothing about MapLibre |
| `app.js` | Products, map, panel, legend. Knows nothing about signing |

## Products

| Label | Code | Config |
|---|---|---|
| Max Reflectivity Composite | `C39-0x0302-0` | `Standard-Mercator` |
| Lightning Heatmap | `lightning-heatmap-global` | `Standard-Mercator` |
| GOES East Full Disk IR | `goes-east-fulldisk-hires-ir` | `Standard-Mercator` |

Availability depends on what your key is entitled to. A key without one of these gets a
message in the panel rather than a blank map.

## API notes

The reusable part of this sample. Each item was verified against the live service.

### Signing

```
ts      = floor(Date.now() / 1000)
to_sign = "<key>:<ts>"
sig     = base64(HMAC_SHA1(secret, to_sign)), then "+" → "-", "/" → "_", "=" → "%3D"
query   = "ts=<ts>&sig=<sig>"
```

**A signature is valid for about ±15 minutes.** At 20 minutes old the API returns
`403 {"status":403,"message":"Expired timestamp","code":800311}`.

Because signing is timestamp-based, a system clock more than about 15 minutes out fails every
request the same way — `403 Expired timestamp` — even though the key and secret are correct.

That is why this app never puts a signature in a tile URL. It caches one, renews it every 5
minutes, and appends it per request through MapLibre's `transformRequest` hook. A signature
baked into a source URL works at first and then the map quietly goes blank while panning.

### Newest instance

```
GET /v1/{key}/meta/tiles/product-instances/{product}/{config}.json?page_size=1&{sig}
→ [{"time":"2026-08-11T16:20:38Z","created":"2026-08-11T16:21:59Z"}]
```

Ordered newest first. Observational products live under `/meta/tiles/`; forecast products live
under `/meta/maps/`, which this demo does not use.

### TMS

```
/v1/{key}/tms/1.0.0/{product}+{config}+{time}/{z}/{x}/{y}.png
```

The instance time is part of the path and is required — omitting it returns 404. Rows run
bottom-up, so a MapLibre raster source needs `scheme: 'tms'`.

### WMS

```
/v1/{key}/wms/{product}/{config}
  ?service=WMS&version=1.3.0&request=GetMap
  &crs=EPSG:3857&bbox={minx},{miny},{maxx},{maxy}
  &width={w}&height={h}&format=image/png&transparent=true
  &layers={instance time}
```

This demo requests **one image for the whole view** — a single `GetMap` sized to the map
container, rebuilt on `moveend` — rather than tiling WMS into a pyramid. That is what WMS is
designed for: one image per view, in contrast to TMS's pyramid of fixed 256px tiles at fixed
zoom levels. MapLibre also offers a `{bbox-epsg-3857}` template token that fills in per tile for
anyone who *does* want to tile WMS; this app does not use it, but the token still exists if you do.

Two further limits, both verified against the live service:

- **`WIDTH`/`HEIGHT` are capped at 3000.** `3001` returns `400 InvalidParameter: exceeds the
  maximum allowable value of 3000`. This matches `GetCapabilities`'s `MaxWidth`/`MaxHeight`.
- **A bbox whose aspect ratio disagrees with `width`/`height` still returns HTTP 200** and
  silently distorts the image. There is no error to catch — the caller must derive one dimension
  from the other rather than trusting the service to complain.

Three traps:

- **`LAYERS` is the instance timestamp, not the product code.** `GetCapabilities` lists each
  instance time as a nested layer name. The product code returns `400 InvalidParameter`.
- **`VERSION` must be `1.3.0`.** `1.1.1` returns
  `Unsupported value for parameter "VERSION": must be "1.3.0"`.
- **`CRS=EPSG:3857` is the only projection offered.**

`GetCapabilities` also reports `LayerLimit 1`, `MaxWidth 3000`, `MaxHeight 3000`.

### Legends

```
https://static.velocityweather.com/legends/{product}/{config}/legend.json
→ {"palettes": [{"entries": [{"color": "#a4ffa47f", "value": "5 dBZ"}]}]}
```

Public — no signature. Colours are `#rrggbbaa`, which CSS accepts directly. This is a
different document from the `geotiff_legend.json` that `../geotiff_fetch` uses.

Quality varies, and a client has to cope with all three cases:

| Product | Legend |
|---|---|
| `C39-0x0302-0` | 15 entries, all labelled, `5 dBZ` to `75 dBZ` in 5 dBZ steps |
| `goes-east-fulldisk-hires-ir` | 254 entries, every label is the string `Undefined` |
| `lightning-heatmap-global` | None. The CDN returns `403 AccessDenied` |

Two things worth knowing about the missing case:

- The CDN answers `403 AccessDenied` rather than `404` because the bucket denies `ListBucket`.
  A missing object and a forbidden one look identical from outside.
- **WMS is not a fallback.** This service answers `400 OperationNotSupported` for
  `GetLegendGraphic`, and its `GetCapabilities` advertises no `LegendURL` and no `<Style>`
  blocks. If the CDN has no legend, there is no legend.

So a client must treat "no legend" as a normal state, not an error. This app stays silent on a
403 or 404 and logs anything else.

## Verification

1. Copy `env.example` to `.env` and fill in a valid key and secret.
2. Run `python3 -m http.server 8000`. Open <http://localhost:8000/>.
3. Each of the three products draws tiles in TMS mode.
4. The WMS toggle redraws each product. The network panel shows `request=GetMap`.
5. The valid time appears and matches the newest instance in the metadata response.
6. Max Reflectivity shows a labelled legend. GOES East shows an unlabelled ramp. Lightning
   Heatmap shows `No legend published for this product.`
7. Refresh re-resolves the instance and the map redraws.
8. Leave the page open for 20 minutes, then pan. Tiles still load. This is the check that
   proves per-request signing works.
9. Rename `.env` and reload. The panel shows the setup message and the basemap still loads.

Step 8 is the one that catches the mistake this design exists to avoid.

## Limitations

The basemap is MapLibre's demo style — country outlines only, no state borders and no cities,
so placing radar geographically is hard. Swap the `style` URL in `app.js` for something with
more detail if that matters.

One weather layer at a time. No animation, no instance history, no point queries, and no
automatic polling for new instances — the Refresh button covers that.

`setInterval` does not fire while the machine sleeps, so after a long sleep the cached signature
can be stale and tiles may fail until you click Refresh.

In WMS mode, one image covers one view. During a pan or zoom the old image stretches to fill the
new viewport, then snaps to the freshly fetched image once it arrives at `moveend`. Tiled TMS does
not do this — each tile is independent, so only the tiles entering the view need to load.
