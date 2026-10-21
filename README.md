# open-art-mcp

A read-only stdio MCP server, plus a skill, for searching open-access art collections at three museums:

- **The Metropolitan Museum of Art** (Collection API)
- **Cleveland Museum of Art** (Open Access API)
- **Victoria and Albert Museum** (Collections API v2)

Results come back in one normalized shape. Every item carries a `license` object (`openAccess`, `status`, `label`, `rights`, `reuse`, `termsUrl`) and `images` URLs (`web`, `large`, `original`, `additional`).

**No API keys or accounts are needed.** The server has no dependencies beyond Node.js (ES modules).

## Tools (13)

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
| `oa_search_all` | Search all three in parallel, interleave the results and report per-museum errors. Open access only by default, which skips the V&A. |
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

- `OPEN_ART_CONTACT`: contact string appended to the User-Agent.
- `OPEN_ART_DOWNLOAD_ROOT`: an absolute path; `oa_download_image` may only write beneath it.
- `OPEN_ART_MET_MIN_INTERVAL_MS`, `OPEN_ART_CLEVELAND_MIN_INTERVAL_MS`, `OPEN_ART_VAM_MIN_INTERVAL_MS`: slow a museum down further (floor 50 ms).

## Rate limits

The server makes GET requests only, to an https host allow-list (the three API hosts and their image CDNs, with redirects re-checked). It has a 30 s timeout and a 10 MB response cap, and paces requests per museum:

| Museum | Documented limit | Pacing here |
|---|---|---|
| The Met | 80 requests/second (Met API docs) | 100 ms between requests (~10/s) |
| Cleveland | none documented | 250 ms (~4/s) |
| V&A | none documented | 500 ms (2/s) |

On a 429 or 503 response, the server retries once when `Retry-After` is 15 s or less. Only a delay in seconds is honoured: a `Retry-After` given as an HTTP date is not retried, and the error is returned.

## Licensing of the art

Check each item's `license` field. Only items with `license.openAccess=true` may be reused freely.

- **The Met:** objects flagged public domain (Open Access) are open access; all others are reference only. Terms: https://metmuseum.github.io/
- **Cleveland:** CC0 works are open access and include image URLs; copyrighted works include none. Terms: https://clevelandart.org/open-access
- **V&A:** no item is open access or CC0. Results are reference only (non-commercial personal and educational API use under V&A terms). Terms: https://www.vam.ac.uk/info/va-websites-terms-conditions

## Tests

```sh
cd server
node selftest.js              # offline, mocked HTTP: 46 checks, including a subprocess stdio framing smoke
node live-smoke.js            # live read-only GETs against the three APIs
node live-smoke.js --download # also downloads one open-access image to a temp dir, then deletes it
```

## Licence

MIT © 2026 Chris R. See `LICENSE`.
