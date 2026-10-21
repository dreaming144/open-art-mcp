# Changelog

## 0.3.1

- Fixed `oa_download_image` for Openverse: `/thumb/` answers a bare `Accept: image/*` with HTTP 406. Image downloads now send `Accept: image/*,*/*;q=0.8` (the content type is still checked). The 0.3.0 live smoke never downloaded from Openverse, so it missed this. It now downloads one Openverse thumbnail, and a 406 fails the run instead of being skipped.
- When Openverse cannot build a thumbnail (HTTP 424, "Thumbnail unavailable from provider"; seen on some Wikimedia images), the download returns `THUMBNAIL_UNAVAILABLE` with `originalUrl`. Originals live on third-party hosts (Flickr, Wikimedia and others), so the allow-list was not widened and they are not fetched.
- Rijksmuseum search with `openAccessOnly=true` keeps hydrating ids from the same 100-id page until `limit` is filled. It stops after at most 3×`limit` lookups and returns `nextOffset`. Before this fix, items with no image or restricted rights were dropped without being replaced (e.g. `landschap`, limit 8, returned 4).
- V&A search: records with an empty `_primaryTitle` now use `objectType` as the title.
- Checked, no change needed: Cleveland already maps `creators[].description` to `artist` (the empty ones are anonymous works where the API's `creators` list is `[]`). Openverse exposes no creation date (`indexed_on` is the indexing date), so `date` stays null. V&A images are marked "© Victoria and Albert Museum, London" in the API, so V&A stays reference-only.

## 0.3.0

- Added the Rijksmuseum (data.rijksmuseum.nl Search API + id.rijksmuseum.nl Linked Art resolver, keyless): `oa_rijks_search`, `oa_rijks_get_object`. Open access only when the image rights statement is the Public Domain Mark or CC0 (metadata CC0 is ignored for gating). IIIF images from `iiif.micr.io`.
- Added Openverse (api.openverse.org v1, anonymous), Verified live (30/30 live smoke checks passed on 2026-10-21 after earlier timeouts on 2026-10-20); new searches can be slow. Tools: `oa_openverse_search`, `oa_openverse_get_image`. Only `cc0`/`pdm` are open access; all results carry licence code, version, URL, creator, attribution and a reuse requirement. Pacing 3000 ms (anonymous 20/min burst, 200/day).
- Both are in `oa_search_all`, `oa_best_image_url` and `oa_download_image` (Openverse downloads use the Openverse thumbnail only). 20 tools total.
- 401 from upstream maps to `UPSTREAM_REJECTED_INPUT`. Offline fixtures (trimmed live responses) live in `server/fixtures/`.
- Tests: selftest 68 offline checks; live smoke 26 checks (28 with `--download`) plus 2 Openverse checks (SKIP when Openverse times out).

## 0.2.0

- Added the Art Institute of Chicago (public API v1, keyless): 3 new tools, `oa_aic_search`, `oa_aic_get_artwork`, `oa_aic_list_departments` (16 tools total).
- AIC is in `oa_search_all`, `oa_best_image_url` and `oa_download_image`. Only `is_public_domain: true` counts as open access.
- AIC images are IIIF URLs built from the response's `config.iiif_url` (must be `https://www.artic.edu/iiif/2`) plus `image_id`: web 843px, large/original 1686px.
- Allow-list: `api.artic.edu`, and `www.artic.edu` restricted to `/iiif/2/` paths.
- Pacing for AIC is 1000 ms (AIC documents 60 requests/minute for anonymous users). Every AIC request sends an `AIC-User-Agent` header, as AIC's docs ask.
- `OPEN_ART_*_MIN_INTERVAL_MS` can now only slow a museum down; a value below the museum's default pacing is clamped up to it.
- AIC IIIF paths containing encoded `%2f`, `%5c` or `%2e` (any case), or anything that decodes to a `..` segment, are refused.
- Tests: selftest now runs 57 offline checks; live smoke runs 22 (plus 1 with `--download`).

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
