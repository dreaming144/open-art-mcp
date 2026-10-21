---
name: open-art-mcp
description: >
  Use when you need public-domain / CC0 reference images or metadata for artworks and objects from
  The Metropolitan Museum of Art, the Cleveland Museum of Art, or the Victoria and Albert Museum:
  searching collections, looking up a specific object, listing departments/collections, finding the
  best open-access image URL, or (explicitly asked) downloading one open-access image to a folder.
  Read-only, no API keys. Do not use for: buying, licensing or ordering images, commercial reuse of
  anything not flagged open access, other museums, or generating art (this only finds references).
---

# Open-access museum art: `open-art-mcp`

> **LICENCE RULE (read first).** Every result has a `license` object. **Only items with `license.openAccess: true` (Met public domain, Cleveland CC0) may be reused directly.** Everything else is **reference only**: look, learn, take inspiration, cite, but do not copy, trace, print or publish it. **Every V&A item is reference only** (its terms allow API use for non-commercial personal/educational purposes; it is not CC0).

Read-only: every tool does GET requests to public museum APIs. No keys, no accounts, nothing is posted anywhere. One tool (`oa_download_image`) writes a file locally, only when explicitly confirmed.

## Tools

| Goal | Tool |
|------|------|
| Find things across museums | `oa_search_all` (normalized, interleaved; open-access only by default) |
| Search one museum | `oa_met_search`, `oa_cleveland_search`, `oa_vam_search` |
| One object by id | `oa_met_get_object` (digits), `oa_cleveland_get_artwork` (Athena id or accession number like `1958.39`), `oa_vam_get_object` (`O` + digits) |
| Browse facets | `oa_met_list_departments`, `oa_cleveland_list_departments`, `oa_vam_list_collections` |
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

- `license.status`: `public-domain` (Met), `CC0` (Cleveland), `restricted` (Met/Cleveland item that is not open access), `not-open-access` (all V&A).
- Cleveland `images.original` is a huge TIFF (hundreds of MB): use `large` (print JPEG, ~3400px) unless the user insists.
- Met/Cleveland items that are not open access have no usable image data; treat any URL you do get as view-only.

## Gotchas

- **Met search returns ids only**; the tool fetches each object to show licence info (1 request per result, so `limit` max 25 when hydrating). `openAccessOnly` hides non-public-domain results after fetching, so a page can have fewer rows than `limit`; page with `offset`. `hasImage` does not guarantee public domain.
- Met `/v1.1/search` only reaches the first 10,000 hits (`offset + limit <= 10000`). `dateBegin` and `dateEnd` must be used together.
- Cleveland has no departments endpoint; the department list is static from its docs.
- V&A pages start at 1, `pageSize` max 100. V&A asks apps to display images from the API-provided URL rather than hosting copies.
- Requests are paced per museum (Met ~10/s, Cleveland ~4/s, V&A 2/s). If you get `RATE_LIMITED`, wait; do not loop.
- Errors come back as `{ error: { code, message } }` with `isError: true` (`INVALID_INPUT`, `NOT_FOUND`, `RATE_LIMITED`, `TIMEOUT`, `RESPONSE_TOO_LARGE`, `NOT_OPEN_ACCESS`, ...). Fix the input; do not retry blindly.

## Not covered

No ordering/licensing of images, no commercial clearance, no reverse image search, no writes to any museum service. If the user needs print-on-demand or commercial use of a non-open-access work, tell them it needs the museum's own licence.
