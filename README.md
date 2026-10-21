# open-art-mcp

A read-only stdio MCP server, plus a skill, for searching open-access art collections at five museums, plus the Openverse open-licence image index:

- **The Metropolitan Museum of Art** (Collection API)
- **Cleveland Museum of Art** (Open Access API)
- **Art Institute of Chicago** (public API v1, IIIF images)
- **Rijksmuseum** (Linked Open Data: Search API + id.rijksmuseum.nl resolver, IIIF images)
- **Victoria and Albert Museum** (Collections API v2)
- **Openverse** (api.openverse.org v1, anonymous; aggregated openly licensed images, not a museum). Verified live on 2026-10-21; new searches can be slow.

Results come back in one normalized shape. Every item carries a `license` object (`openAccess`, `status`, `label`, `rights`, `reuse`, `termsUrl`) and `images` URLs (`web`, `large`, `original`, `additional`).

**No API keys or accounts are needed.** The server has no dependencies beyond Node.js (ES modules).

## Tools (20)

| Tool | What it does |
|---|---|
| `oa_met_search` | Search The Met (`/v1.1/search`, paginated); returns normalized records or ids only. |
| `oa_met_get_object` | Get one Met object by numeric objectID. |
| `oa_met_list_departments` | List Met departments (id + name) for the `departmentId` filter. |
| `oa_cleveland_search` | Search the Cleveland Open Access API; CC0 works include image URLs. |
| `oa_cleveland_get_artwork` | Get one Cleveland artwork by Athena id or accession number (e.g. `1958.39`). |
| `oa_cleveland_list_departments` | List Cleveland departments (a static list from the API docs; there is no departments endpoint). |
| `oa_vam_search` | Search the V&A Collections API v2 (reference only, never open access). |
| `oa_vam_get_object` | Get one V&A object by systemNumber (e.g. `O9138`). |
| `oa_vam_list_collections` | List V&A facets with counts (collections, categories, object types, materials, techniques, styles). |
| `oa_aic_search` | Search the Art Institute of Chicago (`/artworks/search`); public-domain only by default, optional `departmentId`. |
| `oa_aic_get_artwork` | Get one AIC artwork by numeric id (e.g. `27992`). |
| `oa_aic_list_departments` | List AIC departments (`PC-` ids) for the `departmentId` filter. |
| `oa_rijks_search` | Search the Rijksmuseum (title, creator, description, type, material, technique, creationDate, aboutActor; no free-text `q`). Ids are hydrated from the LOD resolver (`limit` 1-10); paging via `offset` within a 100-id page and `nextPageToken`. With `openAccessOnly` it hydrates further ids on the page (up to 3×`limit`) to fill `limit`, and returns `nextOffset`. |
| `oa_rijks_get_object` | Get one Rijksmuseum object by LOD id (`200107928`) or object number (`SK-C-5`). |
| `oa_openverse_search` | Search Openverse images. CC0 + PDM only by default; `openAccessOnly=false` with `licenses` returns other CC licences with their attribution requirement. |
| `oa_openverse_get_image` | Get one Openverse image by UUID. |
| `oa_search_all` | Search all six sources in parallel (Rijksmuseum by title), interleave the results and report per-museum errors. Open access only by default, which skips the V&A. |
| `oa_best_image_url` | Return the best image URL without downloading; open-access items only unless `requireOpenAccess=false` (then marked REFERENCE ONLY). |
| `oa_download_image` | Download one open-access image to a local directory. Dry run by default and `confirm=true` to write; writes a `.license.json` beside it. |
| `oa_status` | Show the version, per-museum pacing and counters, caps and licence policy. Makes no network calls. |

`oa_download_image` is the only tool that writes, and it writes local files only. It refuses anything not flagged open access. It never overwrites, validates the path (absolute, no `..`, no dot-directories or system directories, symlinks resolved), accepts image content types only, and caps downloads at 10 MB by default (`maxMegabytes` up to 50).

## Install and use

Needs Node.js on `PATH`. The plugin's `mcp.json`:

```json
{
  "mcpServers": {
    "open-art": { "type": "stdio", "command": "./run-mcp.sh", "args": [] }
  }
}
```

`run-mcp.sh` finds its own directory, so it works from any location. For another MCP client, point it at `run-mcp.sh` (or `node server/index.js`) as a stdio server. The server accepts NDJSON and Content-Length framing (LF or CRLF). stdout carries JSON-RPC only; logs go to stderr.

Optional environment variables (all unset by default):

- `OPEN_ART_CONTACT`: contact string appended to the User-Agent (and the `AIC-User-Agent` header, which AIC asks for: project name plus a contact email).
- `OPEN_ART_DOWNLOAD_ROOT`: an absolute path; `oa_download_image` may only write beneath it.
- `OPEN_ART_MET_MIN_INTERVAL_MS`, `OPEN_ART_CLEVELAND_MIN_INTERVAL_MS`, `OPEN_ART_VAM_MIN_INTERVAL_MS`, `OPEN_ART_AIC_MIN_INTERVAL_MS`, `OPEN_ART_RIJKS_MIN_INTERVAL_MS`, `OPEN_ART_OPENVERSE_MIN_INTERVAL_MS`: slow a museum down further. They can only slow a museum down: values below its default are ignored.

## Rate limits

The server makes GET requests only, to an https host allow-list (the API hosts and their image hosts, with redirects re-checked; path-restricted hosts are `www.artic.edu` → `/iiif/2/`, `data.rijksmuseum.nl` → `/search/collection`, `api.openverse.org` → `/v1/images/`; on path-restricted hosts any encoded `%2f`, `%5c`, `%2e` or decoded `..` segment is refused). It has a 30 s timeout and a 10 MB response cap, and paces requests per museum:

| Museum | Documented limit | Pacing here |
|---|---|---|
| The Met | 80 requests/second (Met API docs) | 100 ms between requests (~10/s) |
| Cleveland | none documented | 250 ms (~4/s) |
| V&A | none documented | 500 ms (2/s) |
| Rijksmuseum | none documented | 500 ms (2/s) |
| Openverse | anonymous: 20/minute burst, 200/day sustained (response headers); `page_size` <= 20 | 3000 ms (20/min) |
| Art Institute of Chicago | 60 requests/minute for anonymous users; scrape single-threaded at <= 1/s (AIC API docs) | 1000 ms (1/s) |

AIC requests carry an `AIC-User-Agent` header (as AIC's docs ask) with the same value as the User-Agent. `OPEN_ART_AIC_MIN_INTERVAL_MS` can't take AIC below 1000 ms.

On a 429 or 503 response, the server retries once when `Retry-After` is 15 s or less. Only a delay in seconds is honoured: a `Retry-After` given as an HTTP date is not retried, and the error is returned.

## Licensing of the art

Check each item's `license` field. Only items with `license.openAccess=true` may be reused freely.

- **The Met:** objects flagged public domain (Open Access) are open access; all others are reference only. Terms: https://metmuseum.github.io/
- **Cleveland:** CC0 works are open access and include image URLs; copyrighted works include none. Terms: https://clevelandart.org/open-access
- **Art Institute of Chicago:** only items AIC flags `is_public_domain: true` are open access; everything else is reference only. Images are IIIF URLs built from the API's `config.iiif_url` and `image_id` (`web` = 843px wide, AIC's recommended size; `large`/`original` = 1686px, the largest it generally serves). Terms: https://www.artic.edu/terms
- **Rijksmuseum:** open access only when the *image* rights statement is the Public Domain Mark or CC0 (e.g. SK-C-5). The record's metadata is always CC0, which is not the image licence and is ignored for gating; images marked In Copyright (rightsstatements.org InC) are reference only. Images: IIIF on `iiif.micr.io` (`web` 843px, `large` 1686px, `original` = `max`). Terms: https://data.rijksmuseum.nl/policy
- **Openverse:** only `cc0` and `pdm` count as open access. Every result also returns `license.licenseCode`, `licenseVersion`, `licenseUrl`, `creator`, `creatorUrl`, `attribution` and `requirement`; other CC licences come back with `reuse: "licence-conditions-apply"`. Images live on third-party hosts: `oa_best_image_url` can return the provider URL, but `oa_download_image` only fetches the Openverse thumbnail (`size=web`); if Openverse cannot build one (HTTP 424) it returns `THUMBNAIL_UNAVAILABLE` with `originalUrl` instead of fetching the third-party file. Anonymous quota is small (200/day). Terms: https://docs.openverse.org/terms_of_service.html
- **V&A:** no item is open access or CC0. Results are reference only (non-commercial personal and educational API use under V&A terms). Terms: https://www.vam.ac.uk/info/va-websites-terms-conditions

## Tests

```sh
cd server
node selftest.js              # offline, mocked HTTP: 68 checks, including a subprocess stdio framing smoke
node live-smoke.js            # live read-only GETs against the live APIs (26 checks, 28 with `--download`, plus 2 Openverse checks that report SKIP if Openverse is timing out)
node live-smoke.js --download # also downloads one open-access image to a temp dir, then deletes it
```

## Licence

MIT © 2026 Chris R. See `LICENSE`.
