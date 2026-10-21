#!/usr/bin/env node
// open-art-mcp: zero-dependency stdio MCP server for open-access museum collection APIs
// (The Met, Cleveland Museum of Art, V&A, Art Institute of Chicago, Rijksmuseum) plus Openverse. Read-only GETs, no keys, no auth.
//
// stdout carries JSON-RPC only. All logging goes to stderr.
// Framing (inbound): NDJSON lines, OR "Content-Length: N" headers terminated by LF-LF or CRLF-CRLF.
// Outbound mirrors the request: NDJSON -> NDJSON; Content-Length (LF|CRLF) -> same terminator.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.3.0";
export const SERVER_NAME = "open-art-mcp";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
export const LIMITS = Object.freeze({
  httpTimeoutMs: 30_000, // per upstream request (hard cap)
  toolDeadlineMs: 110_000, // whole tool call
  maxResponseBytes: 10 * 1024 * 1024, // 10 MB cap on any upstream response body
  maxDownloadMegabytesCeiling: 50, // `maxMegabytes` on oa_download_image can raise the 10 MB default up to this
  maxInboundBytes: 4 * 1024 * 1024, // inbound JSON-RPC buffer cap
  maxRedirects: 3,
  maxTextChars: 1500, // description truncation in normalized records
});

// Polite per-museum pacing (minimum ms between request starts).
// Met documents <= 80 req/s; Cleveland and V&A document no numeric limit, so we stay conservative.
export const MUSEUMS = Object.freeze({
  met: {
    id: "met",
    name: "The Metropolitan Museum of Art",
    documentedLimit: "80 requests/second (Met API docs)",
    minIntervalMs: 100, // ~10 req/s
    apiHost: "collectionapi.metmuseum.org",
    imageHosts: ["images.metmuseum.org"],
    termsUrl: "https://metmuseum.github.io/",
  },
  cleveland: {
    id: "cleveland",
    name: "Cleveland Museum of Art",
    documentedLimit: "none documented",
    minIntervalMs: 250, // ~4 req/s
    apiHost: "openaccess-api.clevelandart.org",
    imageHosts: ["openaccess-cdn.clevelandart.org"],
    termsUrl: "https://clevelandart.org/open-access",
  },
  vam: {
    id: "vam",
    name: "Victoria and Albert Museum",
    documentedLimit: "none documented",
    minIntervalMs: 500, // 2 req/s
    apiHost: "api.vam.ac.uk",
    imageHosts: ["framemark.vam.ac.uk"],
    termsUrl: "https://www.vam.ac.uk/info/va-websites-terms-conditions",
  },
  aic: {
    id: "aic",
    name: "Art Institute of Chicago",
    documentedLimit: "60 requests/minute for anonymous users (AIC API docs); scrape single-threaded at <= 1 req/s",
    minIntervalMs: 1000, // 1 req/s == the documented 60/min ceiling
    apiHost: "api.artic.edu",
    imageHosts: ["www.artic.edu"],
    // www.artic.edu is also the public website: only the IIIF image service is allowed there.
    hostPathPrefixes: { "www.artic.edu": ["/iiif/2/"] },
    termsUrl: "https://www.artic.edu/terms",
  },
  rijks: {
    id: "rijks",
    name: "Rijksmuseum",
    documentedLimit: "none documented (data.rijksmuseum.nl)",
    minIntervalMs: 500, // 2 req/s; each object record is ~20-200 KB of Linked Art JSON-LD
    apiHost: "data.rijksmuseum.nl",
    imageHosts: ["id.rijksmuseum.nl", "iiif.micr.io"],
    hostPathPrefixes: { "data.rijksmuseum.nl": ["/search/collection"], "id.rijksmuseum.nl": ["/"], "iiif.micr.io": ["/"] },
    termsUrl: "https://data.rijksmuseum.nl/policy",
  },
  openverse: {
    id: "openverse",
    name: "Openverse",
    documentedLimit: "anonymous: 20 requests/minute burst, 200 requests/day sustained (x-ratelimit headers); page_size <= 20",
    minIntervalMs: 3000, // 20/min burst
    apiHost: "api.openverse.org",
    imageHosts: [],
    hostPathPrefixes: { "api.openverse.org": ["/v1/images/"] },
    termsUrl: "https://docs.openverse.org/terms_of_service.html",
  },
});
const MUSEUM_IDS = Object.keys(MUSEUMS);
const HOST_TO_MUSEUM = new Map();
for (const m of Object.values(MUSEUMS)) {
  HOST_TO_MUSEUM.set(m.apiHost, m.id);
  for (const h of m.imageHosts) HOST_TO_MUSEUM.set(h, m.id);
}
const MIN_INTERVAL_FLOOR_MS = 50; // env overrides can slow us down, never below this

const MET_BASE = "https://collectionapi.metmuseum.org/public/collection";
const CMA_BASE = "https://openaccess-api.clevelandart.org/api";
const VAM_BASE = "https://api.vam.ac.uk/v2";
const AIC_BASE = "https://api.artic.edu/api/v1";
const AIC_IIIF_DEFAULT = "https://www.artic.edu/iiif/2";
const RIJKS_SEARCH = "https://data.rijksmuseum.nl/search/collection";
const RIJKS_ID_BASE = "https://id.rijksmuseum.nl";
const OV_BASE = "https://api.openverse.org/v1";

// Cleveland has no departments endpoint (404); this is Appendix B of its docs (v4.0.3, 2026-07-09).
export const CMA_DEPARTMENTS = Object.freeze([
  "African Art", "American Painting and Sculpture", "Art of the Americas", "Chinese Art",
  "Contemporary Art", "Decorative Art and Design", "Drawings", "Egyptian and Ancient Near Eastern Art",
  "European Painting and Sculpture", "Greek and Roman Art", "Indian and South East Asian Art",
  "Islamic Art", "Japanese Art", "Korean Art", "Medieval Art", "Modern European Painting and Sculpture",
  "Oceania", "Performing Arts, Music, & Film", "Photography", "Prints", "Textiles",
]);
const VAM_CLUSTER_TYPES = ["collection", "category", "object_type", "material", "technique", "style"];

// ---------------------------------------------------------------------------
// Logging (stderr only)
// ---------------------------------------------------------------------------
function log(...a) {
  try {
    process.stderr.write(`[${SERVER_NAME}] ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class ToolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Per-museum pacing (serialises request starts per museum; museums are independent)
// ---------------------------------------------------------------------------
class Pacer {
  constructor(id, minIntervalMs) {
    this.id = id;
    this.minIntervalMs = minIntervalMs;
    this.last = 0;
    this.chain = Promise.resolve();
    this.stats = { requests: 0, retries: 0, errors: 0, waitedMs: 0 };
  }
  wait() {
    const p = this.chain.then(async () => {
      const wait = Math.max(0, this.last + this.minIntervalMs - Date.now());
      if (wait) {
        this.stats.waitedMs += wait;
        await sleep(wait);
      }
      this.last = Date.now();
    });
    this.chain = p.catch(() => {});
    return p;
  }
}
function envInterval(id, dflt) {
  const raw = process.env[`OPEN_ART_${id.toUpperCase()}_MIN_INTERVAL_MS`];
  const n = Number(raw);
  // Env overrides may only SLOW a museum down: never below its documented-limit default.
  if (raw && Number.isFinite(n)) return Math.max(dflt, MIN_INTERVAL_FLOOR_MS, Math.min(60_000, Math.floor(n)));
  return dflt;
}
const pacers = Object.fromEntries(MUSEUM_IDS.map((id) => [id, new Pacer(id, envInterval(id, MUSEUMS[id].minIntervalMs))]));
export function _envIntervalForTest(id) { return envInterval(id, MUSEUMS[id].minIntervalMs); }
export function _setIntervalsForTest(ms) { for (const p of Object.values(pacers)) p.minIntervalMs = ms; }
export function _pacerStats() { return Object.fromEntries(Object.entries(pacers).map(([k, p]) => [k, { ...p.stats, minIntervalMs: p.minIntervalMs }])); }

// ---------------------------------------------------------------------------
// User-Agent
// ---------------------------------------------------------------------------
export function userAgent() {
  let ua = `${SERVER_NAME}/${VERSION} (read-only MCP plugin for open-access museum APIs; Node ${process.versions.node})`;
  const c = process.env.OPEN_ART_CONTACT;
  if (c && /^[\x20-\x7e]{3,100}$/.test(c) && !/[\r\n]/.test(c)) ua += ` contact: ${c}`;
  return ua;
}

// ---------------------------------------------------------------------------
// HTTP (GET only, host allow-list, https only, timeout, size cap, polite pacing)
// ---------------------------------------------------------------------------
export function _timeoutMs() { return timeoutMs(); }
function timeoutMs() {
  const n = Number(process.env.OPEN_ART_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(LIMITS.httpTimeoutMs, n) : LIMITS.httpTimeoutMs;
}

function checkUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new ToolError("INVALID_URL", "Invalid URL"); }
  if (url.protocol !== "https:") throw new ToolError("INVALID_URL", "Only https URLs are allowed");
  if (url.username || url.password) throw new ToolError("INVALID_URL", "Credentials in URLs are not allowed");
  const museum = HOST_TO_MUSEUM.get(url.hostname);
  if (!museum || (url.port && url.port !== "443")) throw new ToolError("HOST_NOT_ALLOWED", `Host not allowed: ${url.hostname}`);
  const prefixes = MUSEUMS[museum].hostPathPrefixes?.[url.hostname];
  if (prefixes) {
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); } catch { decoded = null; }
    if (!prefixes.some((pre) => url.pathname.startsWith(pre)) || /%(?:2f|5c|2e)/i.test(url.pathname) || decoded === null || decoded.split(/[\/\\]/).includes("..")) {
      throw new ToolError("HOST_NOT_ALLOWED", `Path not allowed on ${url.hostname}`);
    }
  }
  return { url, museum };
}

async function readCapped(res, maxBytes, signal) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new ToolError("RESPONSE_TOO_LARGE", `Response exceeds ${maxBytes} bytes (Content-Length ${declared})`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) throw new ToolError("TIMEOUT", "Upstream request timed out");
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new ToolError("RESPONSE_TOO_LARGE", `Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/** GET with pacing; returns {status, headers, body(Buffer), finalUrl}. Throws ToolError on non-2xx. */
export async function httpGet(rawUrl, { ctx, accept = "application/json", maxBytes = LIMITS.maxResponseBytes } = {}) {
  let { url, museum } = checkUrl(rawUrl);
  let pacer = pacers[museum];
  let attempt = 0;
  for (let hop = 0; ; ) {
    const remaining = ctx?.deadline ? ctx.deadline - Date.now() : Infinity;
    if (remaining <= 0) throw new ToolError("TOOL_DEADLINE", "Tool call exceeded its overall time budget");
    await pacer.wait();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Math.min(timeoutMs(), Math.max(1, remaining)));
    const started = Date.now();
    pacer.stats.requests++;
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: ac.signal,
        headers: museum === "aic" ? { "User-Agent": userAgent(), "AIC-User-Agent": userAgent(), Accept: accept } : { "User-Agent": userAgent(), Accept: accept },
      });
      log("GET", url.hostname + url.pathname, res.status, `${Date.now() - started}ms`);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        const loc = res.headers.get("location");
        if (!loc || ++hop > LIMITS.maxRedirects) throw new ToolError("TOO_MANY_REDIRECTS", "Too many or invalid redirects");
        const next = checkUrl(new URL(loc, url).toString()); // re-validated: redirects cannot leave the allow-list
        url = next.url;
        if (next.museum !== museum) { museum = next.museum; pacer = pacers[museum]; }
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        const raH = res.headers.get("retry-after");
        const ra = raH === null || raH.trim() === "" ? NaN : Number(raH);
        try { await res.body?.cancel(); } catch { /* ignore */ }
        if (attempt === 0 && Number.isFinite(ra) && ra >= 0 && ra <= 15) {
          attempt++;
          pacer.stats.retries++;
          clearTimeout(t);
          await sleep(Math.max(ra * 1000, pacer.minIntervalMs));
          continue;
        }
        throw new ToolError(res.status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
          `${MUSEUMS[museum].name} returned HTTP ${res.status}${Number.isFinite(ra) ? ` (Retry-After ${ra}s)` : ""}. Slow down and retry later.`, { status: res.status, retryAfterSeconds: Number.isFinite(ra) ? ra : null });
      }
      if (res.status < 200 || res.status >= 300) {
        const snippet = (await readCapped(res, 2048, ac.signal).catch(() => Buffer.alloc(0))).toString("utf8").slice(0, 300);
        const code = res.status === 404 ? "NOT_FOUND" : res.status === 410 ? "ENDPOINT_RETIRED" : res.status === 403 ? "FORBIDDEN" : res.status === 400 || res.status === 401 || res.status === 422 ? "UPSTREAM_REJECTED_INPUT" : "UPSTREAM_ERROR";
        throw new ToolError(code, `${MUSEUMS[museum].name} returned HTTP ${res.status}`, { status: res.status, bodySnippet: snippet });
      }
      const body = await readCapped(res, maxBytes, ac.signal);
      return { status: res.status, headers: res.headers, body, finalUrl: url.toString(), museum };
    } catch (e) {
      pacer.stats.errors++;
      if (e instanceof ToolError) throw e;
      if (e?.name === "AbortError" || ac.signal.aborted) throw new ToolError("TIMEOUT", `Upstream request to ${url.hostname} timed out after ${Math.min(timeoutMs(), 30000) / 1000}s`);
      throw new ToolError("NETWORK_ERROR", `Network error talking to ${url.hostname}: ${String(e?.cause?.code || e?.message || e).slice(0, 200)}`);
    } finally {
      clearTimeout(t);
    }
  }
}

export async function getJson(url, opts) {
  const r = await httpGet(url, opts);
  try {
    return JSON.parse(r.body.toString("utf8"));
  } catch {
    throw new ToolError("BAD_JSON", "Upstream returned a non-JSON body");
  }
}

// ---------------------------------------------------------------------------
// Input validation (single source of truth: the same spec builds the JSON Schema)
// ---------------------------------------------------------------------------
const CTRL = /[\u0000-\u001f\u007f]/;
const S = {
  str: (description, o = {}) => ({ t: "string", description, max: 200, ...o }),
  int: (description, o = {}) => ({ t: "integer", description, ...o }),
  bool: (description, o = {}) => ({ t: "boolean", description, ...o }),
  enm: (description, values, o = {}) => ({ t: "enum", description, values, ...o }),
  arr: (description, items, o = {}) => ({ t: "array", description, items, ...o }),
};

function schemaOf(spec, required = []) {
  const properties = {};
  for (const [k, s] of Object.entries(spec)) {
    const p = { description: s.description };
    if (s.t === "string") { p.type = "string"; p.maxLength = s.max; if (s.pattern) p.pattern = s.pattern.source; }
    else if (s.t === "integer") { p.type = "integer"; if (s.min !== undefined) p.minimum = s.min; if (s.max !== undefined) p.maximum = s.max; }
    else if (s.t === "boolean") p.type = "boolean";
    else if (s.t === "enum") { p.type = "string"; p.enum = s.values; }
    else if (s.t === "array") { p.type = "array"; p.maxItems = s.maxItems ?? 10; p.items = { type: "string", enum: s.items }; p.uniqueItems = true; }
    if (s.default !== undefined) p.default = s.default;
    properties[k] = p;
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export function validateArgs(spec, required, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw new ToolError("INVALID_INPUT", "arguments must be an object");
  const out = {};
  for (const k of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(spec, k)) throw new ToolError("INVALID_INPUT", `Unknown argument: ${String(k).slice(0, 50)}`);
  }
  for (const r of required) if (args[r] === undefined || args[r] === null || args[r] === "") throw new ToolError("INVALID_INPUT", `Missing required argument: ${r}`);
  for (const [k, s] of Object.entries(spec)) {
    let v = args[k];
    if (v === undefined || v === null) { if (s.default !== undefined) out[k] = s.default; continue; }
    switch (s.t) {
      case "string": {
        if (typeof v !== "string") throw new ToolError("INVALID_INPUT", `${k} must be a string`);
        v = v.trim();
        if (v.length > s.max) throw new ToolError("INVALID_INPUT", `${k} is longer than ${s.max} characters`);
        if (CTRL.test(v)) throw new ToolError("INVALID_INPUT", `${k} contains control characters`);
        if (s.pattern && !s.pattern.test(v)) throw new ToolError("INVALID_INPUT", `${k} has an invalid format${s.hint ? ` (${s.hint})` : ""}`);
        if (v === "") { if (required.includes(k)) throw new ToolError("INVALID_INPUT", `Missing required argument: ${k}`); continue; }
        out[k] = v; break;
      }
      case "integer": {
        if (typeof v === "string" && /^-?\d{1,9}$/.test(v.trim())) v = Number(v);
        if (typeof v !== "number" || !Number.isInteger(v)) throw new ToolError("INVALID_INPUT", `${k} must be an integer`);
        if (s.min !== undefined && v < s.min) throw new ToolError("INVALID_INPUT", `${k} must be >= ${s.min}`);
        if (s.max !== undefined && v > s.max) throw new ToolError("INVALID_INPUT", `${k} must be <= ${s.max}`);
        out[k] = v; break;
      }
      case "boolean": {
        if (v === "true") v = true; else if (v === "false") v = false;
        if (typeof v !== "boolean") throw new ToolError("INVALID_INPUT", `${k} must be a boolean`);
        out[k] = v; break;
      }
      case "enum": {
        if (typeof v !== "string" || !s.values.includes(v)) throw new ToolError("INVALID_INPUT", `${k} must be one of: ${s.values.join(", ")}`);
        out[k] = v; break;
      }
      case "array": {
        if (!Array.isArray(v) || v.length === 0 || v.length > (s.maxItems ?? 10)) throw new ToolError("INVALID_INPUT", `${k} must be a non-empty array (max ${s.maxItems ?? 10})`);
        for (const x of v) if (typeof x !== "string" || !s.items.includes(x)) throw new ToolError("INVALID_INPUT", `${k} items must be one of: ${s.items.join(", ")}`);
        out[k] = [...new Set(v)]; break;
      }
      default: throw new Error(`bad spec type ${s.t}`);
    }
  }
  return out;
}

// Id formats
const RE_MET_ID = /^[1-9]\d{0,8}$/;
const RE_CMA_ID = /^(?:\d{1,9}|[0-9A-Za-z][0-9A-Za-z._-]{0,30})$/; // Athena id (digits) or accession number e.g. 1958.39, 1916.1160.b
const RE_VAM_ID = /^O[1-9]\d{0,11}$/; // V&A systemNumber, e.g. O9138
const RE_VAM_THES = /^THES\d{1,9}$/;
const RE_VAM_TERM = /^[A-Za-z]{1,6}\d{1,9}$/;
const RE_AIC_ID = /^[1-9]\d{0,8}$/; // AIC artwork id, e.g. 27992
const RE_AIC_IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_AIC_DEPT = /^PC-\d{1,6}$/;
const RE_RIJKS_LOD = /^[1-9]\d{4,11}$/; // Rijksmuseum LOD id, e.g. 200107928
const RE_RIJKS_OBJNUM = /^[A-Z]{1,6}(?:-[A-Za-z0-9.]{1,20}){1,6}$/; // object number, e.g. SK-C-5, RP-P-2008-90 (no wildcards)
const RE_RIJKS_ID = new RegExp(`(?:${RE_RIJKS_LOD.source})|(?:${RE_RIJKS_OBJNUM.source})`);
const RE_RIJKS_TOKEN = /^[A-Za-z0-9_\-]{1,300}={0,2}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Normalisation: one record shape for all four museums
// ---------------------------------------------------------------------------
const stripHtml = (s) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
const clip = (s, n = LIMITS.maxTextChars) => { const t = stripHtml(s); return t ? (t.length > n ? t.slice(0, n - 1) + "…" : t) : null; };
const nz = (v) => (v === undefined || v === null || v === "" ? null : v);

const REUSE_OK = "direct-reuse-ok";
const REUSE_REF = "reference-only";

function licence({ museum, openAccess, status, label, rights, extra }) {
  return {
    openAccess: !!openAccess, // true ONLY when the museum itself flags the item public domain / CC0
    status, // "public-domain" | "CC0" | "restricted" | "not-open-access"
    label,
    rights: nz(rights),
    reuse: openAccess ? REUSE_OK : REUSE_REF,
    termsUrl: MUSEUMS[museum].termsUrl,
    ...(extra || {}),
  };
}

export function normalizeMet(o) {
  const pd = o.isPublicDomain === true;
  const additional = Array.isArray(o.additionalImages) ? o.additionalImages.filter((x) => typeof x === "string" && x) : [];
  const lic = pd
    ? licence({ museum: "met", openAccess: true, status: "public-domain", label: "Public domain (Met Open Access; CC0)", rights: o.rightsAndReproduction })
    : licence({ museum: "met", openAccess: false, status: "restricted", label: "Not flagged public domain by the Met: reference only", rights: o.rightsAndReproduction });
  const web = nz(o.primaryImageSmall) || nz(o.primaryImage);
  return {
    museum: "met",
    id: String(o.objectID),
    title: nz(o.title),
    artist: nz(o.artistDisplayName),
    artistBio: nz(o.artistDisplayBio),
    date: nz(o.objectDate),
    medium: nz(o.medium),
    classification: nz(o.classification) || nz(o.objectName),
    department: nz(o.department),
    culture: nz(o.culture),
    creditLine: nz(o.creditLine),
    dimensions: nz(o.dimensions),
    accessionNumber: nz(o.accessionNumber),
    url: nz(o.objectURL),
    tags: Array.isArray(o.tags) ? o.tags.map((t) => t?.term).filter(Boolean).slice(0, 20) : [],
    description: null,
    license: lic,
    images: { hasImage: !!(web || nz(o.primaryImage)), web, large: nz(o.primaryImage), original: nz(o.primaryImage), additional },
  };
}

export function normalizeCma(o) {
  const st = o.share_license_status;
  const cc0 = st === "CC0";
  const img = o.images && typeof o.images === "object" ? o.images : {};
  const lic = cc0
    ? licence({ museum: "cleveland", openAccess: true, status: "CC0", label: "CC0 (Cleveland Museum of Art Open Access)", rights: o.copyright })
    : licence({ museum: "cleveland", openAccess: false, status: "restricted", label: `Cleveland share_license_status=${st ?? "unknown"}: not CC0, reference only`, rights: o.copyright });
  const creators = Array.isArray(o.creators) ? o.creators.map((c) => c?.description).filter(Boolean) : [];
  return {
    museum: "cleveland",
    id: String(o.id),
    title: nz(o.title),
    artist: creators.length ? creators.join("; ") : null,
    artistBio: null,
    date: nz(o.creation_date),
    medium: nz(o.technique),
    classification: nz(o.type),
    department: nz(o.department),
    culture: Array.isArray(o.culture) && o.culture.length ? o.culture.join("; ") : null,
    creditLine: nz(o.creditline),
    dimensions: nz(o.measurements),
    accessionNumber: nz(o.accession_number),
    url: nz(o.url),
    tags: [],
    description: clip(o.description),
    license: lic,
    images: {
      hasImage: !!(img.web?.url || img.print?.url || img.full?.url),
      web: nz(img.web?.url),
      large: nz(img.print?.url) || nz(img.web?.url),
      original: nz(img.full?.url) || nz(img.print?.url),
      additional: [],
    },
  };
}

const VAM_TERMS_LABEL = "V&A website terms of use (section 9): API/images for non-commercial personal and educational use; NOT CC0. Reference only. Commercial use needs V&A Images.";
function vamImages(base) {
  if (!base || typeof base !== "string" || !/^https:\/\/framemark\.vam\.ac\.uk\/collections\/[A-Za-z0-9]+\/?$/.test(base)) {
    return { hasImage: false, web: null, large: null, original: null, additional: [] };
  }
  const b = base.endsWith("/") ? base : base + "/";
  return {
    hasImage: true,
    web: `${b}full/!768,768/0/default.jpg`, // IIIF: fit within 768px
    large: `${b}full/full/0/default.jpg`, // largest the V&A serves (up to 2500px)
    original: `${b}full/full/0/default.jpg`,
    additional: [],
  };
}

export function normalizeVamSearchRecord(r) {
  return {
    museum: "vam",
    id: String(r.systemNumber),
    title: nz(r._primaryTitle),
    artist: nz(r._primaryMaker?.name),
    artistBio: null,
    date: nz(r._primaryDate),
    medium: null,
    classification: nz(r.objectType),
    department: null,
    culture: nz(r._primaryPlace),
    creditLine: null,
    dimensions: null,
    accessionNumber: nz(r.accessionNumber),
    url: `https://collections.vam.ac.uk/item/${encodeURIComponent(String(r.systemNumber))}/`,
    tags: [],
    description: null,
    license: licence({ museum: "vam", openAccess: false, status: "not-open-access", label: VAM_TERMS_LABEL, rights: "© Victoria and Albert Museum, London" }),
    images: vamImages(r._images?._iiif_image_base_url),
  };
}

export function normalizeVamRecord(j) {
  const r = j?.record || {};
  const meta = j?.meta || {};
  const maker = Array.isArray(r.artistMakerPerson) && r.artistMakerPerson[0]?.name?.text;
  const org = Array.isArray(r.artistMakerOrganisations) && r.artistMakerOrganisations[0]?.name?.text;
  const title = (Array.isArray(r.titles) && r.titles[0]?.title) || r.briefDescription || r.objectType;
  const date = Array.isArray(r.productionDates) && r.productionDates[0]?.date?.text;
  const place = Array.isArray(r.placesOfOrigin) && r.placesOfOrigin[0]?.place?.text;
  const copyright = meta.images?._images_meta?.[0]?.copyright || "© Victoria and Albert Museum, London";
  const rec = {
    museum: "vam",
    id: String(r.systemNumber),
    title: nz(title),
    artist: nz(maker || org),
    artistBio: null,
    date: nz(date),
    medium: nz(r.materialsAndTechniques),
    classification: nz(r.objectType),
    department: nz(r.collectionCode?.text),
    culture: nz(place),
    creditLine: nz(r.creditLine),
    dimensions: Array.isArray(r.dimensions) && r.dimensions.length ? r.dimensions.map((d) => `${d.dimension || ""} ${d.value || ""}${d.unit || ""}`.trim()).join("; ") : null,
    accessionNumber: nz(r.accessionNumber),
    url: `https://collections.vam.ac.uk/item/${encodeURIComponent(String(r.systemNumber))}/`,
    tags: Array.isArray(r.categories) ? r.categories.map((c) => c?.text).filter(Boolean).slice(0, 20) : [],
    description: clip(r.summaryDescription || r.physicalDescription || r.briefDescription),
    license: licence({ museum: "vam", openAccess: false, status: "not-open-access", label: VAM_TERMS_LABEL, rights: copyright }),
    images: vamImages(meta.images?._iiif_image),
  };
  const extraIds = Array.isArray(r.images) ? r.images.filter((x) => typeof x === "string" && /^[A-Za-z0-9]+$/.test(x)).slice(1, 6) : [];
  rec.images.additional = extraIds.map((id) => `https://framemark.vam.ac.uk/collections/${id}/full/full/0/default.jpg`);
  return rec;
}

// AIC: only is_public_domain === true is open access. Images are built from config.iiif_url + image_id
// (IIIF Image API 2.0; AIC docs recommend 843px wide, 1686px is the largest size they generally serve).
function aicIiifBase(cfg) {
  const u = cfg && typeof cfg.iiif_url === "string" ? cfg.iiif_url.replace(/\/+$/, "") : "";
  return /^https:\/\/www\.artic\.edu\/iiif\/2$/.test(u) ? u : AIC_IIIF_DEFAULT;
}
export function normalizeAic(o, cfg) {
  const pd = o.is_public_domain === true;
  const base = aicIiifBase(cfg);
  const imgId = typeof o.image_id === "string" && RE_AIC_IMAGE_ID.test(o.image_id) ? o.image_id : null;
  const iiif = (id, w) => `${base}/${id}/full/${w},/0/default.jpg`;
  const lic = pd
    ? licence({ museum: "aic", openAccess: true, status: "public-domain", label: "Public domain (Art Institute of Chicago is_public_domain; image CC0)", rights: o.copyright_notice })
    : licence({ museum: "aic", openAccess: false, status: "restricted", label: "Not flagged public domain by the Art Institute of Chicago: reference only", rights: o.copyright_notice });
  const alt = Array.isArray(o.alt_image_ids) ? o.alt_image_ids.filter((x) => typeof x === "string" && RE_AIC_IMAGE_ID.test(x)).slice(0, 5) : [];
  return {
    museum: "aic",
    id: String(o.id),
    title: nz(o.title),
    artist: nz(o.artist_title) || nz(o.artist_display),
    artistBio: nz(o.artist_display),
    date: nz(o.date_display),
    medium: nz(o.medium_display),
    classification: nz(o.classification_title) || nz(o.artwork_type_title),
    department: nz(o.department_title),
    culture: nz(o.place_of_origin),
    creditLine: nz(o.credit_line),
    dimensions: nz(o.dimensions),
    accessionNumber: nz(o.main_reference_number),
    url: `https://www.artic.edu/artworks/${encodeURIComponent(String(o.id))}`,
    tags: Array.isArray(o.term_titles) ? [...new Set(o.term_titles.filter((x) => typeof x === "string"))].slice(0, 20) : [],
    description: clip(o.short_description || o.description),
    license: lic,
    images: imgId
      ? { hasImage: true, web: iiif(imgId, 843), large: iiif(imgId, 1686), original: iiif(imgId, 1686), additional: alt.map((id) => iiif(id, 1686)) }
      : { hasImage: false, web: null, large: null, original: null, additional: [] },
  };
}

// --- Rijksmuseum (Linked Art JSON-LD from id.rijksmuseum.nl) ---
const AAT = (n) => `http://vocab.getty.edu/aat/${n}`;
const AAT_EN = AAT(300388277), AAT_NL = AAT(300388256);
const hasClass = (x, n) => Array.isArray(x?.classified_as) && x.classified_as.some((c) => typeof c?.id === "string" && c.id.replace(/^https:/, "http:") === AAT(n));
const isLang = (x, l) => Array.isArray(x?.language) && x.language.some((g) => g?.id === l);
const notationEn = (x) => { const n = Array.isArray(x?.notation) ? x.notation : []; return (n.find((v) => v?.["@language"] === "en") || n[0])?.["@value"] || null; };
function pickText(list, cls, extra) {
  const c = (Array.isArray(list) ? list : []).filter((x) => typeof x?.content === "string" && hasClass(x, cls) && (!extra || extra(x)));
  return (c.find((x) => isLang(x, AAT_EN)) || c.find((x) => isLang(x, AAT_NL)) || c[0])?.content || null;
}
const RIGHTS = [
  [/^https?:\/\/creativecommons\.org\/publicdomain\/mark\/1\.0\/?$/i, "public-domain", "Public Domain Mark (Rijksmuseum image rights)"],
  [/^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/i, "CC0", "CC0 (Rijksmuseum image rights)"],
];
export function normalizeRijks(j) {
  const lod = String(j?.id || "").replace(/^https:\/\/id\.rijksmuseum\.nl\//, "");
  const objNum = (Array.isArray(j.identified_by) ? j.identified_by : []).find((x) => x?.type === "Identifier" && hasClass(x, 300312355))?.content || null;
  const names = (Array.isArray(j.identified_by) ? j.identified_by : []).filter((x) => x?.type === "Name" && hasClass(x, 300404670));
  const title = (names.find((x) => isLang(x, AAT_EN)) || names[0])?.content || null;
  const pb = j.produced_by || {};
  const parts = Array.isArray(pb.part) ? pb.part : [pb];
  let makers = parts.flatMap((p) => (Array.isArray(p?.carried_out_by) ? p.carried_out_by : []).map(notationEn)).filter(Boolean);
  if (!makers.length) makers = parts.map((p) => pickText(p?.referred_to_by, 300435417)).filter(Boolean);
  const dateNames = Array.isArray(pb.timespan?.identified_by) ? pb.timespan.identified_by : [];
  const date = (dateNames.find((x) => isLang(x, AAT_EN)) || dateNames[0])?.content || null;
  let web = null, imgId = null, rightsUrl = null, rightsLabel = null;
  for (const so of Array.isArray(j.subject_of) ? j.subject_of : []) {
    for (const d of Array.isArray(so?.digitally_carried_by) ? so.digitally_carried_by : []) {
      const ap = Array.isArray(d?.access_point) ? d.access_point.map((a) => a?.id).find((u) => typeof u === "string") : null;
      if (!ap) continue;
      const m = /^https:\/\/iiif\.micr\.io\/([A-Za-z0-9]{1,40})\//.exec(ap);
      if (m && !imgId) {
        imgId = m[1];
        const r = (Array.isArray(d.referred_to_by) ? d.referred_to_by : []).find((x) => typeof x?.content === "string" && Array.isArray(x.classified_as) && x.classified_as.some((c) => /aat\/300460240$/.test(c?.id || "")));
        rightsUrl = r?.content || null; rightsLabel = r?._label || null;
      } else if (!web && d.format === "text/html" && /^https:\/\/www\.rijksmuseum\.nl\//.test(ap)) web = ap;
    }
  }
  const hit = rightsUrl && imgId ? RIGHTS.find(([re]) => re.test(rightsUrl)) : null;
  const rightsText = rightsUrl ? `${rightsLabel ? rightsLabel + ": " : ""}${rightsUrl}` : null;
  const lic = hit
    ? licence({ museum: "rijks", openAccess: true, status: hit[1], label: hit[2], rights: rightsText })
    : licence({ museum: "rijks", openAccess: false, status: "restricted", label: imgId ? `Rijksmuseum image rights ${rightsLabel || rightsUrl || "unknown"}: not public domain / CC0, reference only` : "No Rijksmuseum image: reference only", rights: rightsText });
  const iiif = (w) => `https://iiif.micr.io/${imgId}/full/${w}/0/default.jpg`;
  return {
    museum: "rijks",
    id: /^\d+$/.test(lod) ? lod : String(j?.id || ""),
    title: nz(title),
    artist: makers.length ? [...new Set(makers)].join("; ") : null,
    artistBio: null,
    date: nz(date),
    medium: pickText(j.referred_to_by, 300435429),
    classification: (Array.isArray(j.classified_as) ? j.classified_as.map(notationEn).filter(Boolean) : []).join("; ") || null,
    department: null,
    culture: null,
    creditLine: pickText(j.referred_to_by, 300026687),
    dimensions: pickText(j.referred_to_by, 300435430),
    accessionNumber: nz(objNum),
    url: web,
    tags: [],
    description: clip(pickText(j.referred_to_by, 300435452)),
    license: lic,
    images: imgId ? { hasImage: true, web: iiif("843,"), large: iiif("1686,"), original: iiif("max"), additional: [] } : { hasImage: false, web: null, large: null, original: null, additional: [] },
  };
}

// --- Openverse (aggregated openly licensed images; not a museum) ---
const OV_OPEN = { cc0: ["CC0", "CC0 1.0 (Openverse)"], pdm: ["public-domain", "Public Domain Mark (Openverse)"] };
export function normalizeOpenverse(o) {
  const code = typeof o.license === "string" ? o.license.toLowerCase() : "";
  const open = Object.prototype.hasOwnProperty.call(OV_OPEN, code);
  const nice = code ? `${code === "pdm" ? "PDM" : code === "cc0" ? "CC0" : "CC " + code.toUpperCase()}${o.license_version ? " " + o.license_version : ""}` : "unknown licence";
  const httpsOrNull = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);
  const thumb = typeof o.thumbnail === "string" && /^https:\/\/api\.openverse\.org\/v1\/images\/[0-9a-f-]{36}\/thumb\/$/i.test(o.thumbnail) ? o.thumbnail : null;
  const full = httpsOrNull(o.url);
  const extra = {
    licenseCode: nz(code), licenseVersion: nz(o.license_version), licenseUrl: httpsOrNull(o.license_url),
    creator: nz(o.creator), creatorUrl: httpsOrNull(o.creator_url), attribution: nz(o.attribution),
    provider: nz(o.provider), source: nz(o.source),
    requirement: open ? "No conditions; attribution appreciated." : `Reuse only under ${nice}: keep the attribution text${/nc/.test(code) ? ", non-commercial use only" : ""}${/nd/.test(code) ? ", no derivatives" : ""}${/sa/.test(code) ? ", share alike" : ""}.`,
  };
  if (!open) extra.reuse = "licence-conditions-apply";
  return {
    museum: "openverse",
    id: String(o.id),
    title: nz(o.title),
    artist: nz(o.creator),
    artistBio: null,
    date: null,
    medium: null,
    classification: nz(o.category),
    department: null,
    culture: null,
    creditLine: nz(o.attribution),
    dimensions: Number.isInteger(o.width) && Number.isInteger(o.height) ? `${o.width} × ${o.height} px` : null,
    accessionNumber: null,
    url: httpsOrNull(o.foreign_landing_url),
    tags: Array.isArray(o.tags) ? o.tags.map((t) => t?.name).filter((x) => typeof x === "string").slice(0, 20) : [],
    description: null,
    license: open
      ? licence({ museum: "openverse", openAccess: true, status: OV_OPEN[code][0], label: OV_OPEN[code][1], rights: o.attribution, extra })
      : licence({ museum: "openverse", openAccess: false, status: code ? "cc-licensed" : "unknown", label: `${nice}: not CC0/PDM, so not open access here; reusable only under the licence terms`, rights: o.attribution, extra }),
    images: { hasImage: !!(thumb || full), web: thumb, large: full, original: full, additional: [] },
  };
}

// ---------------------------------------------------------------------------
// Museum clients
// ---------------------------------------------------------------------------
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  return p.toString();
};

async function metGetObject(id, ctx) {
  const j = await getJson(`${MET_BASE}/v1/objects/${id}`, { ctx });
  if (!j || typeof j.objectID !== "number") throw new ToolError("UNEXPECTED_RESPONSE", "Unexpected Met object response");
  return normalizeMet(j);
}

async function cmaGetArtwork(id, ctx) {
  const j = await getJson(`${CMA_BASE}/artworks/${encodeURIComponent(id)}`, { ctx });
  if (!j?.data || j.data.id === undefined) throw new ToolError("UNEXPECTED_RESPONSE", "Unexpected Cleveland artwork response");
  return normalizeCma(j.data);
}

async function vamGetObject(id, ctx) {
  const j = await getJson(`${VAM_BASE}/object/${id}`, { ctx });
  if (!j?.record?.systemNumber) throw new ToolError("UNEXPECTED_RESPONSE", "Unexpected V&A object response");
  return normalizeVamRecord(j);
}

const AIC_FIELDS = "id,title,artist_title,artist_display,date_display,medium_display,classification_title,artwork_type_title,department_title,place_of_origin,credit_line,dimensions,main_reference_number,is_public_domain,copyright_notice,image_id,alt_image_ids,short_description,description,term_titles";

async function aicGetArtwork(id, ctx) {
  const j = await getJson(`${AIC_BASE}/artworks/${id}?fields=${AIC_FIELDS}`, { ctx });
  if (!j?.data || typeof j.data.id !== "number") throw new ToolError("UNEXPECTED_RESPONSE", "Unexpected Art Institute of Chicago artwork response");
  return normalizeAic(j.data, j.config);
}

async function rijksResolve(id, ctx) {
  if (RE_RIJKS_LOD.test(id)) return id;
  const j = await getJson(`${RIJKS_SEARCH}?objectNumber=${encodeURIComponent(id)}`, { ctx, accept: "application/ld+json, application/json" });
  const first = Array.isArray(j?.orderedItems) ? j.orderedItems.map((x) => x?.id).find((u) => typeof u === "string") : null;
  const m = first && /^https:\/\/id\.rijksmuseum\.nl\/([1-9]\d{4,11})$/.exec(first);
  if (!m) throw new ToolError("NOT_FOUND", `No Rijksmuseum object with object number ${id}`);
  return m[1];
}
async function rijksFetchLod(lod, ctx) {
  const j = await getJson(`${RIJKS_ID_BASE}/${lod}`, { ctx, accept: "application/ld+json, application/json" });
  if (!j || j.type !== "HumanMadeObject" || typeof j.id !== "string") throw new ToolError("UNEXPECTED_RESPONSE", "Unexpected Rijksmuseum object response (not a HumanMadeObject)");
  return normalizeRijks(j);
}
async function rijksGetObject(id, ctx) { return rijksFetchLod(await rijksResolve(id, ctx), ctx); }

async function ovGetImage(id, ctx) {
  const j = await getJson(`${OV_BASE}/images/${id.toLowerCase()}/`, { ctx });
  if (!j || typeof j.id !== "string") throw new ToolError("UNEXPECTED_RESPONSE", "Unexpected Openverse image response");
  return normalizeOpenverse(j);
}

const getByMuseum = { met: metGetObject, cleveland: cmaGetArtwork, vam: vamGetObject, aic: aicGetArtwork, rijks: rijksGetObject, openverse: ovGetImage };
const ID_RE = { met: RE_MET_ID, cleveland: RE_CMA_ID, vam: RE_VAM_ID, aic: RE_AIC_ID, rijks: new RegExp(`^${RE_RIJKS_ID.source}$`), openverse: RE_UUID };
const ID_HINT = { met: "digits only, e.g. 436532", cleveland: "Athena id (digits) or accession number, e.g. 1958.39", vam: "V&A systemNumber like O9138", aic: "digits only, e.g. 27992", rijks: "LOD id (digits, e.g. 200107928) or object number (e.g. SK-C-5)", openverse: "Openverse image UUID" };

const CMA_SEARCH_FIELDS = "id,accession_number,share_license_status,title,creation_date,creators,technique,type,department,culture,creditline,measurements,url,images,copyright,description";

async function metSearch(a, ctx) {
  if (a.q === undefined && a.departmentId === undefined && a.dateBegin === undefined && !a.isHighlight && !a.isOnView && a.medium === undefined && a.geoLocation === undefined) {
    throw new ToolError("INVALID_INPUT", "Provide q or at least one filter (an unfiltered /v1.1/search would match the whole 500K+ collection).");
  }
  if ((a.dateBegin === undefined) !== (a.dateEnd === undefined)) throw new ToolError("INVALID_INPUT", "dateBegin and dateEnd must be given together (the Met ignores one without the other).");
  if (a.offset + a.limit > 10000) throw new ToolError("INVALID_INPUT", "offset + limit may not exceed 10000 (Met /v1.1/search limit)");
  if (a.hydrate && a.limit > 25) throw new ToolError("INVALID_INPUT", "limit must be <= 25 when hydrate=true (each result costs one upstream request); use hydrate=false for up to 100 ids");
  const query = {
    q: a.q, title: a.title ? "true" : undefined, tags: a.tags ? "true" : undefined, artistOrCulture: a.artistOrCulture ? "true" : undefined,
    departmentId: a.departmentId, medium: a.medium, geoLocation: a.geoLocation, dateBegin: a.dateBegin, dateEnd: a.dateEnd,
    isHighlight: a.isHighlight ? "true" : undefined, isOnView: a.isOnView ? "true" : undefined,
    hasImages: a.hasImage || a.openAccessOnly ? "true" : undefined, offset: a.offset, limit: a.limit,
  };
  // NOTE: /v1.1/search takes no q-less "isPublicDomain" filter (it is silently ignored), so open-access
  // filtering is done on the hydrated objects. q without filters is fine; filters without q are fine on /v1.1.
  const res = await getJson(`${MET_BASE}/v1.1/search?${qs(query)}`, { ctx });
  const ids = Array.isArray(res?.objectIDs) ? res.objectIDs.filter((x) => Number.isInteger(x)) : []; // zero hits => objectIDs:null
  const out = { museum: "met", total: Number(res?.total) || 0, offset: a.offset, limit: a.limit, returnedIds: ids.length, results: [], notes: [] };
  if (!a.hydrate) { out.objectIDs = ids; out.notes.push("hydrate=false: ids only, no licence info. Call oa_met_get_object before using any image."); return out; }
  let skipped = 0, filtered = 0;
  for (const id of ids) {
    try {
      const rec = await metGetObject(String(id), ctx);
      if (a.openAccessOnly && !rec.license.openAccess) { filtered++; continue; }
      out.results.push(rec);
    } catch (e) {
      if (e instanceof ToolError && (e.code === "NOT_FOUND")) { skipped++; continue; }
      throw e;
    }
  }
  if (filtered) out.notes.push(`${filtered} result(s) on this page were not public domain and were hidden (openAccessOnly=true).`);
  if (skipped) out.notes.push(`${skipped} id(s) could not be fetched (404).`);
  out.notes.push("total counts all matches before the open-access filter; page with offset.");
  return out;
}

async function cmaSearch(a, ctx) {
  if (a.q === undefined && a.department === undefined && a.type === undefined && a.artists === undefined && a.title === undefined && a.technique === undefined && a.culture === undefined && a.createdAfter === undefined && a.createdBefore === undefined) {
    throw new ToolError("INVALID_INPUT", "Provide q or at least one filter.");
  }
  const url = `${CMA_BASE}/artworks/?` + qs({
    q: a.q, department: a.department, type: a.type, artists: a.artists, title: a.title, technique: a.technique, culture: a.culture,
    created_after: a.createdAfter, created_before: a.createdBefore, cc0: a.openAccessOnly ? "1" : undefined, has_image: a.hasImage ? "1" : undefined,
    skip: a.skip, limit: a.limit, fields: CMA_SEARCH_FIELDS,
  });
  const j = await getJson(url, { ctx });
  const data = Array.isArray(j?.data) ? j.data : [];
  return { museum: "cleveland", total: Number(j?.info?.total) || 0, skip: a.skip, limit: a.limit, results: data.map(normalizeCma), notes: a.openAccessOnly ? [] : ["openAccessOnly=false: results may include copyrighted works (no image data; reference only)."] };
}

async function vamSearch(a, ctx) {
  if (a.q === undefined && a.collectionId === undefined && a.categoryId === undefined && a.materialId === undefined && a.techniqueId === undefined && a.objectType === undefined && a.yearMadeFrom === undefined) {
    throw new ToolError("INVALID_INPUT", "Provide q or at least one filter.");
  }
  if ((a.yearMadeFrom === undefined) !== (a.yearMadeTo === undefined)) throw new ToolError("INVALID_INPUT", "yearMadeFrom and yearMadeTo must be given together");
  const url = `${VAM_BASE}/objects/search?` + qs({
    q: a.q, id_collection: a.collectionId, id_category: a.categoryId, id_material: a.materialId, id_technique: a.techniqueId,
    kw_object_type: a.objectType, year_made_from: a.yearMadeFrom, year_made_to: a.yearMadeTo,
    images_exist: a.hasImage ? "1" : undefined, page: a.page, page_size: a.pageSize,
  });
  const j = await getJson(url, { ctx });
  const recs = Array.isArray(j?.records) ? j.records : [];
  return {
    museum: "vam", total: Number(j?.info?.record_count) || 0, page: Number(j?.info?.page) || a.page, pages: Number(j?.info?.pages) || 0, pageSize: a.pageSize,
    results: recs.map(normalizeVamSearchRecord),
    notes: ["V&A items are NEVER open access: reference only. API use is non-commercial personal/educational under V&A terms (s9)."],
  };
}

async function aicSearch(a, ctx) {
  if (a.q === undefined && a.departmentId === undefined) throw new ToolError("INVALID_INPUT", "Provide q or departmentId.");
  if (a.page * a.limit > 10000) throw new ToolError("INVALID_INPUT", "page * limit may not exceed 10000 (AIC search result window)");
  // Filters use AIC's Elasticsearch query DSL passed as bracketed GET params (documented "GET with query params").
  const f = [];
  if (a.openAccessOnly) f.push(["term", "is_public_domain", "true"]);
  if (a.departmentId) f.push(["term", "department_id", a.departmentId]);
  const p = new URLSearchParams();
  if (a.q) p.set("q", a.q);
  p.set("page", String(a.page)); p.set("limit", String(a.limit)); p.set("fields", AIC_FIELDS);
  let i = 0;
  for (const [kind, field, val] of f) { p.set(`query[bool][filter][${i}][${kind}][${field}]`, val); i++; }
  if (a.hasImage) p.set(`query[bool][filter][${i}][exists][field]`, "image_id");
  const j = await getJson(`${AIC_BASE}/artworks/search?${p.toString()}`, { ctx });
  const data = Array.isArray(j?.data) ? j.data : [];
  return {
    museum: "aic", total: Number(j?.pagination?.total) || 0, page: a.page, limit: a.limit, totalPages: Number(j?.pagination?.total_pages) || 0,
    results: data.map((o) => normalizeAic(o, j.config)),
    notes: a.openAccessOnly ? [] : ["openAccessOnly=false: results may include works not flagged public domain (reference only)."],
  };
}

const RIJKS_FILTERS = ["title", "creator", "description", "type", "material", "technique", "creationDate", "aboutActor"];
async function rijksSearch(a, ctx) {
  if (!RIJKS_FILTERS.some((k) => a[k] !== undefined) && a.pageToken === undefined) throw new ToolError("INVALID_INPUT", `Provide at least one of: ${RIJKS_FILTERS.join(", ")} (the Rijksmuseum search has no free-text q).`);
  const p = new URLSearchParams();
  for (const k of RIJKS_FILTERS) if (a[k] !== undefined) p.set(k, a[k]);
  if (a.hasImage || a.openAccessOnly) p.set("imageAvailable", "true");
  if (a.pageToken) p.set("pageToken", a.pageToken);
  const j = await getJson(`${RIJKS_SEARCH}?${p.toString()}`, { ctx, accept: "application/ld+json, application/json" });
  const ids = (Array.isArray(j?.orderedItems) ? j.orderedItems : []).map((x) => /^https:\/\/id\.rijksmuseum\.nl\/([1-9]\d{4,11})$/.exec(String(x?.id || ""))?.[1]).filter(Boolean);
  const nextTok = (() => { try { const u = new URL(j?.next?.id); return u.hostname === "data.rijksmuseum.nl" ? u.searchParams.get("pageToken") : null; } catch { return null; } })();
  const slice = ids.slice(a.offset, a.offset + a.limit);
  const out = { museum: "rijks", total: Number(j?.partOf?.totalItems) || 0, pageIds: ids.length, offset: a.offset, limit: a.limit, nextPageToken: nextTok && RE_RIJKS_TOKEN.test(nextTok) ? nextTok : null, results: [], notes: [] };
  let filtered = 0, skipped = 0;
  for (const id of slice) {
    try {
      const rec = await rijksFetchLod(id, ctx);
      if (a.openAccessOnly && !rec.license.openAccess) { filtered++; continue; }
      out.results.push(rec);
    } catch (e) { if (e instanceof ToolError && e.code === "NOT_FOUND") { skipped++; continue; } throw e; }
  }
  if (filtered) out.notes.push(`${filtered} result(s) were not public domain / CC0 and were hidden (openAccessOnly=true).`);
  if (skipped) out.notes.push(`${skipped} id(s) could not be fetched (404).`);
  out.notes.push("Each search page holds up to 100 ids; results hydrate ids[offset..offset+limit). Raise offset to continue within the page, then use nextPageToken.");
  return out;
}

const OV_LICENSES = ["by", "by-nc", "by-nc-nd", "by-nc-sa", "by-nd", "by-sa", "cc0", "nc-sampling+", "pdm", "sampling+"];
const OV_CATEGORIES = ["digitized_artwork", "illustration", "photograph"];
async function ovSearch(a, ctx) {
  const lic = a.openAccessOnly ? (a.licenses ? a.licenses.filter((x) => x === "cc0" || x === "pdm") : ["cc0", "pdm"]) : a.licenses;
  if (a.openAccessOnly && lic.length === 0) throw new ToolError("INVALID_INPUT", "openAccessOnly=true allows only cc0 and pdm in licenses");
  const url = `${OV_BASE}/images/?` + qs({ q: a.q, license: lic ? lic.join(",") : undefined, category: a.categories ? a.categories.join(",") : undefined, source: a.source, page: a.page, page_size: a.pageSize });
  const j = await getJson(url, { ctx });
  const res = Array.isArray(j?.results) ? j.results : [];
  return {
    museum: "openverse", total: Number(j?.result_count) || 0, page: Number(j?.page) || a.page, pageCount: Number(j?.page_count) || 0, pageSize: a.pageSize,
    results: res.map(normalizeOpenverse),
    notes: ["Openverse aggregates third-party images (Flickr, Wikimedia, museums...). Always show license.attribution. Anonymous quota: 20 req/min, 200 req/day.", ...(a.openAccessOnly ? [] : ["openAccessOnly=false: CC BY/BY-SA/NC/ND results need attribution and may restrict use (see license.requirement)."])],
  };
}

// ---------------------------------------------------------------------------
// Download path validation
// ---------------------------------------------------------------------------
const DENY_TOP = new Set(["etc", "proc", "sys", "dev", "boot", "bin", "sbin", "lib", "lib32", "lib64", "libx32", "usr", "var", "run", "root", "snap", "srv"]);
const PLUGIN_ROOT = (() => { const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); try { return fs.realpathSync(p); } catch { return p; } })();

function realpathExistingPrefix(p) {
  // realpath of the longest existing ancestor + the not-yet-existing remainder
  let cur = p;
  const rest = [];
  for (;;) {
    try {
      const rp = fs.realpathSync(cur);
      return path.join(rp, ...rest.reverse());
    } catch (e) {
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw new ToolError("INVALID_DIRECTORY", `Cannot resolve directory: ${e?.code || "error"}`);
      const parent = path.dirname(cur);
      if (parent === cur) throw new ToolError("INVALID_DIRECTORY", "Cannot resolve directory");
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

export function validateDownloadDir(dir) {
  if (typeof dir !== "string" || dir.length === 0 || dir.length > 1024) throw new ToolError("INVALID_DIRECTORY", "directory must be a non-empty string (max 1024 chars)");
  if (dir.includes("\0") || CTRL.test(dir)) throw new ToolError("INVALID_DIRECTORY", "directory contains control characters");
  if (!path.isAbsolute(dir)) throw new ToolError("INVALID_DIRECTORY", "directory must be an absolute path");
  if (dir.split(/[\\/]+/).includes("..")) throw new ToolError("INVALID_DIRECTORY", "directory must not contain '..' segments");
  const norm = path.resolve(dir);
  if (norm === path.parse(norm).root) throw new ToolError("INVALID_DIRECTORY", "directory must not be the filesystem root");
  const real = realpathExistingPrefix(norm);
  const tmpReal = (() => { try { return fs.realpathSync(os.tmpdir()); } catch { return null; } })();
  const inTmp = tmpReal && within(real, tmpReal);
  const top = real.split(path.sep).filter(Boolean)[0];
  if (!inTmp && DENY_TOP.has(top)) throw new ToolError("INVALID_DIRECTORY", `Refusing to write under /${top}`);
  if (real.split(path.sep).filter(Boolean).some((seg) => seg.startsWith("."))) throw new ToolError("INVALID_DIRECTORY", "Refusing to write into hidden (dot) directories");
  if (within(real, PLUGIN_ROOT)) throw new ToolError("INVALID_DIRECTORY", "Refusing to write inside the plugin's own directory");
  const home = os.homedir();
  if (home && real === (() => { try { return fs.realpathSync(home); } catch { return home; } })()) throw new ToolError("INVALID_DIRECTORY", "Refusing to write directly into the home directory; use a sub-folder");
  const rootEnv = process.env.OPEN_ART_DOWNLOAD_ROOT;
  if (rootEnv) {
    if (!path.isAbsolute(rootEnv)) throw new ToolError("INVALID_DIRECTORY", "OPEN_ART_DOWNLOAD_ROOT must be an absolute path");
    const rr = realpathExistingPrefix(path.resolve(rootEnv));
    if (!within(real, rr)) throw new ToolError("INVALID_DIRECTORY", "directory is outside OPEN_ART_DOWNLOAD_ROOT");
  }
  return real;
}

const EXT_BY_TYPE = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/tiff": "tif" };

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const OA = S.bool("Only return open-access (public domain / CC0) items (default true). Items that are not open access are reference only.", { default: true });
const HAS_IMG = S.bool("Only items that have an image (default true).", { default: true });

const SPECS = {};
const REQ = {};
function def(name, description, spec, required, handler, { readOnly = true, openWorld = true, idempotent = true, title } = {}) {
  SPECS[name] = { name, title, description, spec, required, handler, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: openWorld, ...(title ? { title } : {}) } };
}

const LICENCE_NOTE = " Every result carries `license` (openAccess flag, status, rights text, termsUrl, reuse) and `images` URLs. Only items with license.openAccess=true may be reused directly; everything else is reference only.";

// --- Met ---
def("oa_met_search", "Search The Met Collection API (/v1.1/search, paginated). Returns normalized records (hydrated with one object fetch each) or ids only." + LICENCE_NOTE, {
  q: S.str("Search text (title, artist, culture, medium, tags...)."),
  title: S.bool("Match q against the title field only."),
  tags: S.bool("Match q against subject tags only."),
  artistOrCulture: S.bool("Match q against artist or culture only."),
  departmentId: S.int("Met department id (see oa_met_list_departments).", { min: 1, max: 99 }),
  medium: S.str("Medium/object type, e.g. Paintings, Ceramics; several separated by |.", { max: 100, pattern: /^[A-Za-z0-9 ,&'|\-]{1,100}$/, hint: "letters, digits, spaces and | , & ' -" }),
  geoLocation: S.str("Geographic location, e.g. France; several separated by |.", { max: 100, pattern: /^[A-Za-z0-9 ,&'|\-]{1,100}$/, hint: "letters, digits, spaces and | , & ' -" }),
  dateBegin: S.int("Start year (use with dateEnd; negative = BCE).", { min: -9999, max: 2100 }),
  dateEnd: S.int("End year (use with dateBegin).", { min: -9999, max: 2100 }),
  isHighlight: S.bool("Only Met highlights."),
  isOnView: S.bool("Only objects currently on view."),
  openAccessOnly: OA,
  hasImage: HAS_IMG,
  hydrate: S.bool("Fetch each object to return normalized records with licence info (default true). false = ids only.", { default: true }),
  offset: S.int("Zero-based offset (offset+limit <= 10000).", { min: 0, max: 9999, default: 0 }),
  limit: S.int("Page size: 1-25 when hydrate=true (default 10), up to 100 ids when hydrate=false.", { min: 1, max: 100, default: 10 }),
}, [], metSearch, { title: "Search the Met" });

def("oa_met_get_object", "Get one Met object by numeric objectID (normalized, with licence and image URLs)." + LICENCE_NOTE, {
  objectId: S.str("Met objectID, digits only (e.g. 436532).", { pattern: RE_MET_ID, hint: ID_HINT.met, max: 9 }),
}, ["objectId"], async (a, ctx) => ({ museum: "met", result: await metGetObject(a.objectId, ctx) }), { title: "Get a Met object" });

def("oa_met_list_departments", "List Met departments (id + name) for use as departmentId in oa_met_search.", {}, [], async (a, ctx) => {
  const j = await getJson(`${MET_BASE}/v1/departments`, { ctx });
  const list = Array.isArray(j?.departments) ? j.departments.map((d) => ({ departmentId: d.departmentId, displayName: d.displayName })) : [];
  return { museum: "met", departments: list };
}, { title: "List Met departments" });

// --- Cleveland ---
def("oa_cleveland_search", "Search the Cleveland Museum of Art Open Access API. Returns normalized records. CC0 works have web/print/full image URLs; copyrighted works have none." + LICENCE_NOTE, {
  q: S.str("Search text."),
  department: S.enm("Curatorial department (see oa_cleveland_list_departments).", CMA_DEPARTMENTS),
  type: S.str("Artwork type, e.g. Painting, Print, Sculpture, Textile.", { max: 60, pattern: /^[A-Za-z][A-Za-z ,&'\-]{0,59}$/, hint: "letters, spaces and , & ' -" }),
  artists: S.str("Artist name filter.", { max: 100 }),
  title: S.str("Title filter.", { max: 100 }),
  technique: S.str("Technique/medium filter, e.g. oil on canvas.", { max: 100 }),
  culture: S.str("Culture filter.", { max: 100 }),
  createdAfter: S.int("Created after year (negative = BCE).", { min: -9999, max: 2100 }),
  createdBefore: S.int("Created before year.", { min: -9999, max: 2100 }),
  openAccessOnly: OA,
  hasImage: HAS_IMG,
  skip: S.int("Offset.", { min: 0, max: 100000, default: 0 }),
  limit: S.int("Page size 1-100 (default 10).", { min: 1, max: 100, default: 10 }),
}, [], cmaSearch, { title: "Search Cleveland Museum of Art" });

def("oa_cleveland_get_artwork", "Get one Cleveland artwork by Athena id (digits) or accession number (e.g. 1958.39). Normalized, with licence and image URLs." + LICENCE_NOTE, {
  id: S.str("Athena id (digits) or accession number.", { pattern: RE_CMA_ID, hint: ID_HINT.cleveland, max: 31 }),
}, ["id"], async (a, ctx) => ({ museum: "cleveland", result: await cmaGetArtwork(a.id, ctx) }), { title: "Get a Cleveland artwork" });

def("oa_cleveland_list_departments", "List Cleveland departments for the `department` filter. Static list from the API docs (Cleveland has no departments endpoint).", {}, [], async () => ({
  museum: "cleveland", departments: [...CMA_DEPARTMENTS], source: "Cleveland Open Access API docs, Appendix B (v4.0.3); the API has no departments endpoint",
}), { title: "List Cleveland departments", openWorld: false });

// --- V&A ---
def("oa_vam_search", "Search the V&A Collections API v2. V&A items are NEVER open access / CC0: reference only (non-commercial personal and educational API use under V&A terms)." + LICENCE_NOTE, {
  q: S.str("Search text."),
  collectionId: S.str("V&A collection id, e.g. THES48601 (see oa_vam_list_collections).", { pattern: RE_VAM_THES, hint: "THES + digits", max: 15 }),
  categoryId: S.str("Category id (oa_vam_list_collections type=category).", { pattern: RE_VAM_THES, hint: "THES + digits", max: 15 }),
  materialId: S.str("Material id, e.g. AAT12264.", { pattern: RE_VAM_TERM, hint: "letters + digits", max: 16 }),
  techniqueId: S.str("Technique id, e.g. AAT53149.", { pattern: RE_VAM_TERM, hint: "letters + digits", max: 16 }),
  objectType: S.str("Object type keyword, e.g. Poster, Vase.", { max: 60, pattern: /^[A-Za-z][A-Za-z ,&'\-]{0,59}$/, hint: "letters, spaces and , & ' -" }),
  yearMadeFrom: S.int("Made from year.", { min: -9999, max: 2100 }),
  yearMadeTo: S.int("Made to year.", { min: -9999, max: 2100 }),
  hasImage: HAS_IMG,
  page: S.int("Page number, starting at 1.", { min: 1, max: 10000, default: 1 }),
  pageSize: S.int("Results per page 1-100 (default 10).", { min: 1, max: 100, default: 10 }),
}, [], vamSearch, { title: "Search the V&A" });

def("oa_vam_get_object", "Get one V&A object by systemNumber (e.g. O9138). Normalized; always reference-only licence." + LICENCE_NOTE, {
  systemNumber: S.str("V&A systemNumber: 'O' followed by digits.", { pattern: RE_VAM_ID, hint: ID_HINT.vam, max: 13 }),
}, ["systemNumber"], async (a, ctx) => ({ museum: "vam", result: await vamGetObject(a.systemNumber, ctx) }), { title: "Get a V&A object" });

def("oa_vam_list_collections", "List V&A facets with counts: collections (default), categories, object types, materials, techniques or styles. Use ids in oa_vam_search.", {
  type: S.enm("Facet type (default collection).", VAM_CLUSTER_TYPES, { default: "collection" }),
  limit: S.int("Max terms to return (default 50).", { min: 1, max: 100, default: 50 }),
}, [], async (a, ctx) => {
  const j = await getJson(`${VAM_BASE}/objects/clusters/${a.type}/search?cluster_size=${a.limit}`, { ctx });
  const arr = Array.isArray(j) ? j : [];
  return { museum: "vam", type: a.type, terms: arr.slice(0, a.limit).map((t) => ({ id: t.id, value: t.value, count: t.count })) };
}, { title: "List V&A collections/facets" });

// --- Art Institute of Chicago ---
def("oa_aic_search", "Search the Art Institute of Chicago API (/artworks/search). Only items AIC flags is_public_domain are open access; images come from AIC's IIIF server. AIC throttles anonymous use to 60 requests/minute, so requests are paced at 1/s." + LICENCE_NOTE, {
  q: S.str("Search text."),
  departmentId: S.str("AIC department id, e.g. PC-10 (see oa_aic_list_departments).", { pattern: RE_AIC_DEPT, hint: "PC- + digits", max: 9 }),
  openAccessOnly: OA,
  hasImage: HAS_IMG,
  page: S.int("Page number, starting at 1 (page*limit <= 10000).", { min: 1, max: 10000, default: 1 }),
  limit: S.int("Page size 1-100 (default 10).", { min: 1, max: 100, default: 10 }),
}, [], aicSearch, { title: "Search the Art Institute of Chicago" });

def("oa_aic_get_artwork", "Get one Art Institute of Chicago artwork by numeric id (e.g. 27992). Normalized, with licence and IIIF image URLs." + LICENCE_NOTE, {
  id: S.str("AIC artwork id, digits only.", { pattern: RE_AIC_ID, hint: ID_HINT.aic, max: 9 }),
}, ["id"], async (a, ctx) => ({ museum: "aic", result: await aicGetArtwork(a.id, ctx) }), { title: "Get an AIC artwork" });

def("oa_aic_list_departments", "List Art Institute of Chicago departments (id + title) for the departmentId filter in oa_aic_search.", {}, [], async (a, ctx) => {
  const j = await getJson(`${AIC_BASE}/departments?limit=100&fields=id,title`, { ctx });
  const list = Array.isArray(j?.data) ? j.data.filter((d) => typeof d?.id === "string").map((d) => ({ departmentId: d.id, title: d.title })) : [];
  return { museum: "aic", departments: list };
}, { title: "List AIC departments" });

// --- Rijksmuseum ---
const RTXT = (d) => S.str(d, { max: 100 });
def("oa_rijks_search", "Search the Rijksmuseum collection (data.rijksmuseum.nl Linked Art Search; no key). The search returns ids only (100 per page); this tool hydrates `limit` of them from the Linked Open Data resolver. Open access = image rights are Public Domain Mark or CC0. No free-text q: use title/creator/description etc. (Dutch or English terms)." + LICENCE_NOTE, {
  title: RTXT("Title words, e.g. Night Watch."),
  creator: RTXT("Creator name, e.g. Rembrandt van Rijn."),
  description: RTXT("Keywords in the object description."),
  type: RTXT("Object type, e.g. painting, print."),
  material: RTXT("Material, e.g. canvas."),
  technique: RTXT("Technique, e.g. etching."),
  creationDate: S.str("Year or wildcard period, e.g. 1642 or 16??.", { max: 9, pattern: /^[0-9?*-]{1,9}$/, hint: "digits with ? or * wildcards" }),
  aboutActor: RTXT("Person/group depicted or about."),
  openAccessOnly: OA,
  hasImage: HAS_IMG,
  offset: S.int("Offset within the current 100-id page (default 0).", { min: 0, max: 99, default: 0 }),
  limit: S.int("Objects to hydrate, 1-10 (default 5; one request each).", { min: 1, max: 10, default: 5 }),
  pageToken: S.str("nextPageToken from a previous call.", { max: 300, pattern: RE_RIJKS_TOKEN, hint: "opaque token from nextPageToken" }),
}, [], rijksSearch, { title: "Search the Rijksmuseum" });

def("oa_rijks_get_object", "Get one Rijksmuseum object by LOD id (digits, e.g. 200107928) or object number (e.g. SK-C-5). Normalized from Linked Art, with image rights and IIIF image URLs." + LICENCE_NOTE, {
  id: S.str("LOD id or object number.", { pattern: ID_RE.rijks, hint: ID_HINT.rijks, max: 60 }),
}, ["id"], async (a, ctx) => ({ museum: "rijks", result: await rijksGetObject(a.id, ctx) }), { title: "Get a Rijksmuseum object" });

// --- Openverse ---
def("oa_openverse_search", "Search Openverse (api.openverse.org, anonymous) for openly licensed images. Every result carries license code/version/URL, creator and the ready-made attribution text. Only CC0 and PDM count as open access; other CC licences are returned with license.reuse='licence-conditions-apply' and a license.requirement. Anonymous limits: 20 req/min, 200 req/day, page_size <= 20." + LICENCE_NOTE, {
  q: S.str("Search text (max 200 chars).", { max: 200 }),
  openAccessOnly: S.bool("Only CC0 and Public Domain Mark (default true).", { default: true }),
  licenses: S.arr("Licence codes to include (with openAccessOnly=true only cc0/pdm are kept).", OV_LICENSES, { maxItems: 10 }),
  categories: S.arr("Image categories.", OV_CATEGORIES, { maxItems: 3 }),
  source: S.str("Comma-separated Openverse source names, e.g. flickr,wikimedia.", { max: 100, pattern: /^[a-z0-9_]{1,40}(?:,[a-z0-9_]{1,40}){0,5}$/, hint: "lowercase source names, comma separated" }),
  page: S.int("Page number from 1.", { min: 1, max: 50, default: 1 }),
  pageSize: S.int("Results per page 1-20 (anonymous cap 20, default 10).", { min: 1, max: 20, default: 10 }),
}, ["q"], ovSearch, { title: "Search Openverse" });

def("oa_openverse_get_image", "Get one Openverse image by UUID, with licence, licence URL, creator and attribution text." + LICENCE_NOTE, {
  id: S.str("Openverse image UUID.", { pattern: RE_UUID, hint: ID_HINT.openverse, max: 36 }),
}, ["id"], async (a, ctx) => ({ museum: "openverse", result: await ovGetImage(a.id, ctx) }), { title: "Get an Openverse image" });

// --- Cross-museum ---
def("oa_search_all", "Search The Met, Cleveland, the Art Institute of Chicago, the Rijksmuseum (title match), Openverse and the V&A at once and return one normalized, interleaved list. With openAccessOnly=true (default) the V&A is skipped because none of its items are open access; set openAccessOnly=false to include V&A as reference-only results." + LICENCE_NOTE, {
  q: S.str("Search text.", { max: 200 }),
  museums: S.arr("Museums to search (default all).", MUSEUM_IDS, { maxItems: 6 }),
  openAccessOnly: OA,
  hasImage: HAS_IMG,
  limitPerMuseum: S.int("Results per museum, 1-10 (default 5).", { min: 1, max: 10, default: 5 }),
}, ["q"], async (a, ctx) => {
  const want = a.museums || MUSEUM_IDS;
  const out = { query: a.q, openAccessOnly: a.openAccessOnly, perMuseum: {}, errors: {}, skipped: {}, results: [], notes: [] };
  const jobs = [];
  for (const m of want) {
    if (m === "vam" && a.openAccessOnly) { out.skipped.vam = "V&A items are not open access (V&A website terms, not CC0). Set openAccessOnly=false to include them as reference-only."; continue; }
    const run = m === "met"
      ? () => metSearch({ q: a.q, hasImage: a.hasImage, openAccessOnly: a.openAccessOnly, hydrate: true, offset: 0, limit: a.limitPerMuseum }, ctx)
      : m === "cleveland"
        ? () => cmaSearch({ q: a.q, hasImage: a.hasImage, openAccessOnly: a.openAccessOnly, skip: 0, limit: a.limitPerMuseum }, ctx)
        : m === "aic"
          ? () => aicSearch({ q: a.q, hasImage: a.hasImage, openAccessOnly: a.openAccessOnly, page: 1, limit: a.limitPerMuseum }, ctx)
          : m === "rijks"
            ? () => rijksSearch({ title: a.q.slice(0, 100), hasImage: a.hasImage, openAccessOnly: a.openAccessOnly, offset: 0, limit: a.limitPerMuseum }, ctx)
            : m === "openverse"
              ? () => ovSearch({ q: a.q, openAccessOnly: a.openAccessOnly, page: 1, pageSize: a.limitPerMuseum }, ctx)
              : () => vamSearch({ q: a.q, hasImage: a.hasImage, page: 1, pageSize: a.limitPerMuseum }, ctx);
    jobs.push(run().then((r) => ({ m, r }), (e) => ({ m, e })));
  }
  const settled = await Promise.all(jobs);
  const lists = [];
  for (const s of settled) {
    if (s.e) { out.errors[s.m] = { code: s.e.code || "ERROR", message: String(s.e.message).slice(0, 300) }; continue; }
    out.perMuseum[s.m] = { total: s.r.total, returned: s.r.results.length };
    lists.push(s.r.results);
  }
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.results.push(l[i]);
  out.notes.push("Met totals count matches before the open-access filter. Use the per-museum tools to page.");
  return out;
}, { title: "Search all sources" });

// --- Image helper ---
const SIZES = ["web", "large", "original"];
function pickImage(rec, size) {
  const im = rec.images;
  if (size === "web") return im.web || im.large || im.original;
  if (size === "large") return im.large || im.web || im.original;
  return im.original || im.large || im.web;
}

def("oa_best_image_url", "Return the best image URL for one object WITHOUT downloading anything. By default only open-access (public domain / CC0) items return a URL; otherwise `url` is null and the licence explains why. Pass requireOpenAccess=false to get reference-only URLs (do not reuse those).", {
  museum: S.enm("Museum.", MUSEUM_IDS),
  id: S.str("Object id: Met objectID (digits), Cleveland Athena id/accession number, V&A systemNumber (O + digits), AIC artwork id (digits), Rijksmuseum LOD id/object number, or Openverse UUID.", { max: 60 }),
  size: S.enm("web = ~web size, large = print size (default), original = largest published (Cleveland 'full' is a huge TIFF; AIC web=843px, large/original=1686px IIIF; Rijksmuseum web 843px, large 1686px, original = max IIIF; Openverse web = Openverse thumbnail, large/original = the provider's file).", SIZES, { default: "large" }),
  requireOpenAccess: S.bool("Only return a URL when the museum flags the item open access (default true).", { default: true }),
}, ["museum", "id"], async (a, ctx) => {
  if (!ID_RE[a.museum].test(a.id)) throw new ToolError("INVALID_INPUT", `id has an invalid format for ${a.museum} (${ID_HINT[a.museum]})`);
  const rec = await getByMuseum[a.museum](a.id, ctx);
  const chosen = pickImage(rec, a.size);
  const allowed = rec.license.openAccess || !a.requireOpenAccess;
  const out = { museum: rec.museum, id: rec.id, title: rec.title, artist: rec.artist, objectUrl: rec.url, size: a.size, url: allowed && chosen ? chosen : null, license: rec.license, hasImage: rec.images.hasImage, notes: [] };
  if (!rec.images.hasImage) out.notes.push("The museum publishes no image for this object.");
  else if (!allowed) out.notes.push("Not open access: no URL returned (reference only). Re-run with requireOpenAccess=false only to view it, never to reuse it.");
  else if (!rec.license.openAccess) out.notes.push("REFERENCE ONLY: this item is not open access. Do not reuse it directly; check the museum terms.");
  if (a.museum === "vam") out.notes.push("V&A terms ask apps to display images via the API-returned URL rather than copying them.");
  return out;
}, { title: "Best open-access image URL" });

// --- Download (the only tool that writes, and only local files) ---
def("oa_download_image", "Download ONE open-access (public domain / CC0) image to a directory you specify. Refuses anything that is not flagged open access (so never the V&A). Dry-run by default: call once without confirm to see exactly what would be written, then again with confirm=true. Writes the image plus a small <name>.license.json provenance file; never overwrites; max 10 MB unless maxMegabytes is raised (<= 50).", {
  museum: S.enm("Museum (met, cleveland, aic, rijks or openverse).", ["met", "cleveland", "aic", "rijks", "openverse"]),
  id: S.str("Met objectID, Cleveland id/accession number, AIC id, Rijksmuseum LOD id/object number, or Openverse UUID.", { max: 60 }),
  directory: S.str("Absolute destination directory. No '..', no dot-directories, not a system directory, not the home directory itself. Created if missing.", { max: 1024 }),
  size: S.enm("web or large (default web). 'original' is not downloadable here.", ["web", "large"], { default: "web" }),
  maxMegabytes: S.int("Size cap in MB (default 10, max 50).", { min: 1, max: LIMITS.maxDownloadMegabytesCeiling, default: 10 }),
  confirm: S.bool("Set true to actually write the files. Default false = dry run.", { default: false }),
}, ["museum", "id", "directory"], async (a, ctx) => {
  if (!ID_RE[a.museum].test(a.id)) throw new ToolError("INVALID_INPUT", `id has an invalid format for ${a.museum} (${ID_HINT[a.museum]})`);
  if (a.museum === "openverse" && a.size !== "web") throw new ToolError("INVALID_INPUT", "Openverse downloads use size=web (the Openverse thumbnail service); full-size files live on third-party hosts outside the allow-list. Use oa_best_image_url for the original URL.");
  const dir = validateDownloadDir(a.directory);
  const rec = await getByMuseum[a.museum](a.id, ctx);
  if (!rec.license.openAccess) throw new ToolError("NOT_OPEN_ACCESS", "Refusing to download: the museum does not flag this item as open access (public domain / CC0). Reference only.", { license: rec.license });
  const url = pickImage(rec, a.size);
  if (!url) throw new ToolError("NO_IMAGE", "This object has no published image.");
  const safeId = rec.id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  const base = `${rec.museum}-${safeId}-${a.size}`;
  const plan = { museum: rec.museum, id: rec.id, title: rec.title, imageUrl: url, directory: dir, filePrefix: base, license: rec.license };
  if (!a.confirm) return { dryRun: true, wouldWrite: [path.join(dir, `${base}.<ext>`), path.join(dir, `${base}.license.json`)], ...plan, next: "Call again with confirm=true to download." };
  const cap = Math.min(a.maxMegabytes, LIMITS.maxDownloadMegabytesCeiling) * 1024 * 1024;
  const r = await httpGet(url, { ctx, accept: "image/*", maxBytes: cap });
  const ctype = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = EXT_BY_TYPE[ctype];
  if (!ext || ext === "tif") throw new ToolError("UNEXPECTED_CONTENT_TYPE", `Refusing content-type ${ctype || "(none)"}; expected a web image`);
  await fs.promises.mkdir(dir, { recursive: true });
  const real = validateDownloadDir(a.directory); // re-check after creation (symlink races)
  const file = path.join(real, `${base}.${ext}`);
  const meta = path.join(real, `${base}.license.json`);
  const provenance = { source: "open-art-mcp", museum: rec.museum, id: rec.id, title: rec.title, artist: rec.artist, objectUrl: rec.url, imageUrl: url, creditLine: rec.creditLine, license: rec.license, downloadedAt: new Date().toISOString(), bytes: r.body.length };
  let fh;
  try {
    fh = await fs.promises.open(file, "wx", 0o644); // wx: never overwrite
    await fh.writeFile(r.body);
  } catch (e) {
    if (fh) { await fh.close().catch(() => {}); await fs.promises.unlink(file).catch(() => {}); fh = undefined; }
    if (e?.code === "EEXIST") throw new ToolError("FILE_EXISTS", `Refusing to overwrite existing file: ${file}`);
    throw new ToolError("WRITE_FAILED", `Could not write file: ${e?.code || "error"}`);
  } finally { if (fh) await fh.close().catch(() => {}); }
  try { await fs.promises.writeFile(meta, JSON.stringify(provenance, null, 2) + "\n", { flag: "wx", mode: 0o644 }); } catch (e) { if (e?.code !== "EEXIST") log("provenance write failed", e?.code); }
  return { dryRun: false, written: [file, meta], bytes: r.body.length, contentType: ctype, ...plan };
}, { title: "Download an open-access image", readOnly: false, idempotent: false });

// --- Status ---
def("oa_status", "Show server version, per-museum pacing and counters, caps, and the licence policy. Makes no network calls.", {}, [], async () => ({
  name: SERVER_NAME, version: VERSION, userAgent: userAgent(),
  caps: { httpTimeoutMs: Math.min(timeoutMs(), LIMITS.httpTimeoutMs), maxResponseBytes: LIMITS.maxResponseBytes, maxDownloadMegabytes: LIMITS.maxDownloadMegabytesCeiling, toolDeadlineMs: LIMITS.toolDeadlineMs },
  museums: Object.fromEntries(MUSEUM_IDS.map((id) => [id, { name: MUSEUMS[id].name, documentedLimit: MUSEUMS[id].documentedLimit, minIntervalMs: pacers[id].minIntervalMs, stats: pacers[id].stats, termsUrl: MUSEUMS[id].termsUrl }])),
  licencePolicy: "Direct reuse only when license.openAccess=true (Met public domain flag, Cleveland share_license_status=CC0, AIC is_public_domain, Rijksmuseum image rights PDM/CC0, Openverse licence cc0/pdm). Openverse items under other CC licences (BY, BY-SA, NC, ND) may be reused only under those licence terms with the given attribution. Everything else, including every V&A item, is reference only.",
  downloadRoot: process.env.OPEN_ART_DOWNLOAD_ROOT ? "restricted by OPEN_ART_DOWNLOAD_ROOT" : "unrestricted apart from path validation",
}), { title: "Server status and limits", openWorld: false });

export const TOOLS = SPECS;

export function listTools() {
  return Object.values(SPECS).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: schemaOf(t.spec, t.required), annotations: t.annotations }));
}

export async function callTool(name, args) {
  const t = Object.prototype.hasOwnProperty.call(SPECS, name) ? SPECS[name] : null;
  if (!t) return { unknown: true };
  const ctx = { deadline: Date.now() + LIMITS.toolDeadlineMs };
  try {
    const clean = validateArgs(t.spec, t.required, args);
    const result = await t.handler(clean, ctx);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }], isError: false };
  } catch (e) {
    if (e instanceof ToolError) {
      return { content: [{ type: "text", text: JSON.stringify({ error: { code: e.code, message: e.message, ...e.extra } }, null, 1) }], isError: true };
    }
    log("internal error", String(e?.stack || e).slice(0, 500));
    return { content: [{ type: "text", text: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Unexpected internal error" } }) }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP
// ---------------------------------------------------------------------------
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS = "Read-only open-access art search (The Met, Cleveland Museum of Art, Art Institute of Chicago, Rijksmuseum, V&A, plus Openverse). Only items with license.openAccess=true (Met public domain, Cleveland CC0, AIC is_public_domain, Rijksmuseum PDM/CC0 image rights, Openverse CC0/PDM) may be reused directly; Openverse items under other CC licences only under their licence terms with attribution; every other item, including all V&A items, is reference only. No keys needed. Requests are paced per museum.";

export async function handleRpc(msg) {
  // returns a response object, or null for notifications
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { jsonrpc: "2.0", id: msg && typeof msg === "object" && "id" in msg ? msg.id : null, error: { code: -32600, message: "Invalid Request" } };
  }
  const isNotification = !("id" in msg);
  const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code, message } });
  const p = msg.params && typeof msg.params === "object" ? msg.params : {};
  switch (msg.method) {
    case "initialize": {
      const pv = SUPPORTED_PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : SUPPORTED_PROTOCOLS[0];
      return reply({ protocolVersion: pv, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: VERSION }, instructions: INSTRUCTIONS });
    }
    case "ping": return reply({});
    case "tools/list": return reply({ tools: listTools() });
    case "tools/call": {
      if (typeof p.name !== "string") return fail(-32602, "Invalid params: name required");
      const r = await callTool(p.name, p.arguments);
      if (r.unknown) return fail(-32602, `Unknown tool: ${p.name.slice(0, 80)}`);
      return reply(r);
    }
    case "resources/list": return reply({ resources: [] });
    case "resources/templates/list": return reply({ resourceTemplates: [] });
    case "prompts/list": return reply({ prompts: [] });
    case "logging/setLevel": return reply({});
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${msg.method.slice(0, 80)}`);
  }
}

// --- Framing -----------------------------------------------------------------
/** Encode one outbound message. framing: "ndjson" | "cl"; term: "\n" | "\r\n" (cl only). */
export function encodeFrame(obj, framing = "ndjson", term = "\n") {
  const body = JSON.stringify(obj);
  if (framing === "cl") return Buffer.concat([Buffer.from(`Content-Length: ${Buffer.byteLength(body)}${term}${term}`, "latin1"), Buffer.from(body, "utf8")]);
  return Buffer.from(body + "\n", "utf8");
}

const CL_PREFIX = "content-length:";
/**
 * Incremental inbound parser. Accepts NDJSON lines and Content-Length frames (LF-LF or CRLF-CRLF) in any mix.
 * onMessage(parsed, framing, term); onParseError(framing, term, reason).
 */
export function createFrameParser(onMessage, onParseError) {
  let buf = Buffer.alloc(0);
  const parse = (bytes, framing, term) => {
    let obj;
    try { obj = JSON.parse(bytes.toString("utf8")); } catch { onParseError(framing, term, "Parse error"); return; }
    onMessage(obj, framing, term);
  };
  function drain(atEnd) {
    for (;;) {
      let i = 0;
      while (i < buf.length && (buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x20 || buf[i] === 0x09)) i++;
      if (i) buf = buf.subarray(i);
      if (!buf.length) return;
      const head = buf.subarray(0, CL_PREFIX.length).toString("latin1").toLowerCase();
      const maybeCl = head === CL_PREFIX || (buf.length < CL_PREFIX.length && CL_PREFIX.startsWith(head));
      if (maybeCl) {
        if (buf.length < CL_PREFIX.length) { if (atEnd) buf = Buffer.alloc(0); return; }
        const probe = buf.subarray(0, Math.min(buf.length, 8192)).toString("latin1");
        const m = /\r?\n\r?\n/.exec(probe);
        if (!m) {
          if (buf.length > 8192 || atEnd) { onParseError("cl", "\n", "Malformed headers"); buf = Buffer.alloc(0); }
          return;
        }
        const header = probe.slice(0, m.index);
        const term = m[0].includes("\r") ? "\r\n" : "\n";
        const lm = /^content-length:[ \t]*(\d{1,10})[ \t]*$/im.exec(header);
        const bodyStart = m.index + m[0].length;
        if (!lm) { onParseError("cl", term, "Missing or invalid Content-Length"); buf = buf.subarray(bodyStart); continue; }
        const len = Number(lm[1]);
        if (len > LIMITS.maxInboundBytes) { onParseError("cl", term, "Message too large"); buf = Buffer.alloc(0); return; }
        if (buf.length < bodyStart + len) return;
        const body = buf.subarray(bodyStart, bodyStart + len);
        buf = buf.subarray(bodyStart + len);
        parse(body, "cl", term);
        continue;
      }
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > LIMITS.maxInboundBytes) { onParseError("ndjson", "\n", "Message too large"); buf = Buffer.alloc(0); return; }
        if (atEnd) { const line = buf; buf = Buffer.alloc(0); parse(line, "ndjson", "\n"); }
        return;
      }
      let line = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (!line.length) continue;
      parse(line, "ndjson", "\n");
    }
  }
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      drain(false);
    },
    end() { drain(true); },
  };
}

export function startStdioServer({ input = process.stdin, output = process.stdout } = {}) {
  const inflight = new Set();
  const write = (obj, framing, term) => { try { output.write(encodeFrame(obj, framing, term)); } catch (e) { log("write failed", String(e?.code || e)); } };
  const handleOne = async (m) => {
    try { return await handleRpc(m); } catch (e) {
      log("handler error", String(e?.stack || e).slice(0, 400));
      return { jsonrpc: "2.0", id: m && typeof m === "object" && "id" in m ? m.id : null, error: { code: -32603, message: "Internal error" } };
    }
  };
  const parser = createFrameParser(
    (obj, framing, term) => {
      const job = (async () => {
        if (Array.isArray(obj)) {
          if (obj.length === 0) return write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, framing, term);
          const rs = (await Promise.all(obj.map(handleOne))).filter(Boolean);
          if (rs.length) write(rs, framing, term);
          return;
        }
        const r = await handleOne(obj);
        if (r) write(r, framing, term);
      })();
      inflight.add(job);
      job.finally(() => inflight.delete(job));
    },
    (framing, term, reason) => write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: reason } }, framing, term),
  );
  input.on("data", (c) => parser.push(c));
  input.on("end", async () => {
    parser.end();
    await Promise.allSettled([...inflight]);
    process.exit(0);
  });
  input.on("error", (e) => { log("stdin error", String(e?.code || e)); process.exit(1); });
  log(`${SERVER_NAME} ${VERSION} ready (stdio)`);
}

// Run only when executed directly (the selftests import this module without starting the server).
const isMain = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) startStdioServer();
