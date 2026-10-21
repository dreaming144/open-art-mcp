# Changelog

## 0.1.0

Initial release.

- 13 tools over three open-access museum APIs, all keyless: The Met (`/public/collection/v1.1/search` + `/v1/objects`, `/v1/departments`), Cleveland Museum of Art Open Access API, V&A Collections API v2.
- Normalized record for every museum with a `license` object on every result (`openAccess`, `status`, `label`, `rights`, `reuse`, `termsUrl`) and `images` (`web`, `large`, `original`, `additional`).
- `oa_search_all` fans out in parallel, interleaves results, reports per-museum errors without failing the whole call. Open-access-only by default (V&A skipped, because no V&A item is open access).
- `oa_best_image_url` returns a URL only for open-access items unless `requireOpenAccess=false` is passed (then it warns "REFERENCE ONLY").
- `oa_download_image`: the only tool that writes (local files only). Dry run by default, `confirm=true` to write, open-access items only, never overwrites, path validation (absolute, no `..`, no dot-directories, no system directories, symlinks resolved, optional `OPEN_ART_DOWNLOAD_ROOT` confinement), image content types only, 10 MB cap (`maxMegabytes` up to 50), writes a `.license.json` provenance file.
- Hand-rolled stdio framing: NDJSON, Content-Length with LF-LF, Content-Length with CRLF-CRLF (replies mirror the request's framing). stdout is JSON-RPC only; logs go to stderr.
- GET-only HTTP with host allow-list (https; the three API hosts and three image CDNs; redirects re-checked), 30 s timeout, 10 MB response cap, descriptive User-Agent, per-museum pacing (Met 100 ms, Cleveland 250 ms, V&A 500 ms between requests; one retry on 429/503 when `Retry-After` is 15 s or less).
- Strict input validation (ids digits-only or fixed formats, numeric ranges, enum filters, no unknown arguments, no control characters) before any network call.
- Tests: `server/selftest.js` (offline, mocked HTTP, 46 checks incl. subprocess framing smoke), `server/live-smoke.js` (live read-only GETs; optional `--download`).
- `Retry-After` is honoured only as delay-seconds; an HTTP-date value is not retried (documented in README).
- Metadata: `license` in server/package.json; `repository` and `homepage` in plugin.json.
