---
name: open-art-mcp
description: >
  Use when you need public-domain / CC0 reference images or metadata for artworks and objects from
  The Metropolitan Museum of Art, the Cleveland Museum of Art, the Art Institute of Chicago, the Rijksmuseum,
  the Victoria and Albert Museum, or openly licensed images via Openverse:
  searching collections, looking up a specific object, listing departments/collections, finding the
  best open-access image URL, or (explicitly asked) downloading one open-access image to a folder.
  Read-only, no API keys. Do not use for: buying, licensing or ordering images, commercial reuse of
  anything not flagged open access, other museums, or generating art (this only finds references).
---

# Open-access museum art: `open-art-mcp`

> **LICENCE RULE (read first).** Every result has a `license` object. **Only items with `license.openAccess: true` (Met public domain, Cleveland CC0, Art Institute of Chicago `is_public_domain`, Rijksmuseum image rights PDM/CC0, Openverse `cc0`/`pdm`) may be reused directly.** Everything else is **reference only**: look, learn, take inspiration, cite, but do not copy, trace, print or publish it. **Openverse items under other CC licences** (`license.reuse: "licence-conditions-apply"`) may be reused only under that licence, always with `license.attribution`. **Every V&A item is reference only** (its terms allow API use for non-commercial personal/educational purposes; it is not CC0).

Read-only: every tool does GET requests to public museum APIs. No keys, no accounts, nothing is posted anywhere. One tool (`oa_download_image`) writes a file locally, only when explicitly confirmed.

## Tools

| Goal | Tool |
|------|------|
| Find things across museums | `oa_search_all` (normalized, interleaved; open-access only by default) |
| Search one museum | `oa_met_search`, `oa_cleveland_search`, `oa_aic_search`, `oa_rijks_search`, `oa_vam_search`, `oa_openverse_search` |
| One object by id | `oa_met_get_object` (digits), `oa_cleveland_get_artwork` (Athena id or accession number like `1958.39`), `oa_aic_get_artwork` (digits, e.g. `27992`), `oa_rijks_get_object` (LOD id or object number like `SK-C-5`), `oa_openverse_get_image` (UUID), `oa_vam_get_object` (`O` + digits) |
| Browse facets | `oa_met_list_departments`, `oa_cleveland_list_departments`, `oa_aic_list_departments`, `oa_vam_list_collections` |
| Best image URL (no download) | `oa_best_image_url` (`size`: web / large / original) |
| Save one open-access image | `oa_download_image` (dry run first, then `confirm: true`) |
| Limits, caps, licence policy | `oa_status` (no network) |

## Workflow for reference-image work

1. `oa_search_all` with a short, concrete query (`"hokusai wave"`, `"art nouveau poster"`). Default `openAccessOnly: true` returns only direct-reuse items and skips the V&A. Set `openAccessOnly: false` only when you also want V&A **reference** pieces; say so when you show them.
2. Show the user the title, artist, date, museum, `license.label` and the image URL. Keep `license.reuse` visible ("direct-reuse-ok" vs "reference-only").
3. For an item you will actually use, call `oa_best_image_url` (or the museum's get tool) and keep `creditLine`, `url` and `license` for attribution notes.
4. Only download when the user asks. `oa_download_image` needs an absolute `directory` the user chose; call it once without `confirm` to show exactly what would be written, then again with `confirm: true`. It refuses non-open-access items and never overwrites. A `<name>.license.json` provenance file is saved next to the image.

## Result shape (same for all museums)

`museum`, `id`, `title`, `artist`, `date`, `medium`, `classification`, `department`, `culture`, `creditLine`, `dimensions`, `accessionNumber`, `url`, `tags`, `description`,
`license` = `{ openAccess, status, label, rights, reuse, termsUrl }`,
`images` = `{ hasImage, web, large, original, additional[] }`.

- `license.status`: `public-domain` (Met, AIC, Rijksmuseum PDM, Openverse PDM), `CC0` (Cleveland, Rijksmuseum, Openverse), `restricted` (Met/Cleveland/AIC item that is not open access), `not-open-access` (all V&A).
- Cleveland `images.original` is a huge TIFF (hundreds of MB): use `large` (print JPEG, ~3400px) unless the user insists.
- AIC images are IIIF JPEGs: `web` 843px wide, `large`/`original` 1686px (AIC's largest normal size).
- Met/Cleveland items that are not open access have no usable image data; treat any URL you do get as view-only.

## Gotchas

- **Met search returns ids only**; the tool fetches each object to show licence info (1 request per result, so `limit` max 25 when hydrating). `openAccessOnly` hides non-public-domain results after fetching, so a page can have fewer rows than `limit`; page with `offset`. `hasImage` does not guarantee public domain.
- **Rijksmuseum search** with `openAccessOnly` hydrates extra ids from the same 100-id page (up to 3×`limit`) to fill `limit`; continue with `offset=nextOffset`, then `nextPageToken`.
- Met `/v1.1/search` only reaches the first 10,000 hits (`offset + limit <= 10000`). `dateBegin` and `dateEnd` must be used together.
- Cleveland has no departments endpoint; the department list is static from its docs.
- V&A pages start at 1, `pageSize` max 100. V&A asks apps to display images from the API-provided URL rather than hosting copies.
- Rijksmuseum search has **no free-text q**: use `title`, `creator`, `description`, `type`, etc. Each object costs one request (records are big), so `limit` is 1-10. A Rijksmuseum record's metadata is CC0 but that says nothing about the image: gating uses the image rights only.
- Openverse is verified live but can be slow on new searches. Expect possible timeouts; report them rather than retrying in a loop. Anonymous quota is 20 requests/minute and **200/day**; `pageSize` max 20. Always show `license.attribution` (and `license.requirement` for non-CC0/PDM). Downloads only fetch the Openverse thumbnail; `THUMBNAIL_UNAVAILABLE` means Openverse has no thumbnail for it, so give the user `originalUrl` (with attribution) instead.
- AIC: `page` starts at 1, `limit` max 100, `page * limit <= 10000`; `departmentId` is a `PC-` id from `oa_aic_list_departments`.
- Requests are paced per museum (Met ~10/s, Cleveland ~4/s, V&A 2/s, Rijksmuseum 2/s, AIC 1/s because AIC allows 60/min, Openverse 1 per 3 s). AIC is the slow one: keep AIC pages small. If you get `RATE_LIMITED`, wait; do not loop.
- Errors come back as `{ error: { code, message } }` with `isError: true` (`INVALID_INPUT`, `NOT_FOUND`, `RATE_LIMITED`, `TIMEOUT`, `RESPONSE_TOO_LARGE`, `NOT_OPEN_ACCESS`, ...). Fix the input; do not retry blindly.

## Not covered

No ordering/licensing of images, no commercial clearance, no reverse image search, no writes to any museum service. If the user needs print-on-demand or commercial use of a non-open-access work, tell them it needs the museum's own licence.
