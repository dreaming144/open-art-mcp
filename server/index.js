#!/usr/bin/env node
// open-art-mcp: zero-dependency stdio MCP server for open-access museum collection APIs
// (The Met, Cleveland Museum of Art, V&A). Read-only GETs, no keys, no auth.
//
// stdout carries JSON-RPC only. All logging goes to stderr.
// Framing (inbound): NDJSON lines, OR "Content-Length: N" headers terminated by LF-LF or CRLF-CRLF.
// Outbound mirrors the request: NDJSON -> NDJSON; Content-Length (LF|CRLF) -> same terminator.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
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
  if (raw && Number.isFinite(n)) return Math.max(MIN_INTERVAL_FLOOR_MS, Math.min(60_000, Math.floor(n)));
  return dflt;
}
const pacers = Object.fromEntries(MUSEUM_IDS.map((id) => [id, new Pacer(id, envInterval(id, MUSEUMS[id].minIntervalMs))]));
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
        headers: { "User-Agent": userAgent(), Accept: accept },
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
        const code = res.status === 404 ? "NOT_FOUND" : res.status === 410 ? "ENDPOINT_RETIRED" : res.status === 403 ? "FORBIDDEN" : res.status === 400 || res.status === 422 ? "UPSTREAM_REJECTED_INPUT" : "UPSTREAM_ERROR";
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

// ---------------------------------------------------------------------------
// Normalisation: one record shape for all three museums
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

const getByMuseum = { met: metGetObject, cleveland: cmaGetArtwork, vam: vamGetObject };
const ID_RE = { met: RE_MET_ID, cleveland: RE_CMA_ID, vam: RE_VAM_ID };
const ID_HINT = { met: "digits only, e.g. 436532", cleveland: "Athena id (digits) or accession number, e.g. 1958.39", vam: "V&A systemNumber like O9138" };

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

// --- Cross-museum ---
def("oa_search_all", "Search The Met, Cleveland and the V&A at once and return one normalized, interleaved list. With openAccessOnly=true (default) the V&A is skipped because none of its items are open access; set openAccessOnly=false to include V&A as reference-only results." + LICENCE_NOTE, {
  q: S.str("Search text.", { max: 200 }),
  museums: S.arr("Museums to search (default all).", MUSEUM_IDS, { maxItems: 3 }),
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
}, { title: "Search all three museums" });

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
  id: S.str("Object id: Met objectID (digits), Cleveland Athena id/accession number, or V&A systemNumber (O + digits).", { max: 31 }),
  size: S.enm("web = ~web size, large = print size (default), original = largest published (Cleveland 'full' is a huge TIFF).", SIZES, { default: "large" }),
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
  museum: S.enm("Museum (met or cleveland).", ["met", "cleveland"]),
  id: S.str("Met objectID (digits) or Cleveland Athena id/accession number.", { max: 31 }),
  directory: S.str("Absolute destination directory. No '..', no dot-directories, not a system directory, not the home directory itself. Created if missing.", { max: 1024 }),
  size: S.enm("web or large (default web). 'original' is not downloadable here.", ["web", "large"], { default: "web" }),
  maxMegabytes: S.int("Size cap in MB (default 10, max 50).", { min: 1, max: LIMITS.maxDownloadMegabytesCeiling, default: 10 }),
  confirm: S.bool("Set true to actually write the files. Default false = dry run.", { default: false }),
}, ["museum", "id", "directory"], async (a, ctx) => {
  if (!ID_RE[a.museum].test(a.id)) throw new ToolError("INVALID_INPUT", `id has an invalid format for ${a.museum} (${ID_HINT[a.museum]})`);
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
  licencePolicy: "Direct reuse only when license.openAccess=true (Met public domain flag, Cleveland share_license_status=CC0). Everything else, including every V&A item, is reference only.",
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
const INSTRUCTIONS = "Read-only open-access museum search (The Met, Cleveland Museum of Art, V&A). Only items with license.openAccess=true (Met public domain, Cleveland CC0) may be reused directly; every other item, including all V&A items, is reference only. No keys needed. Requests are paced per museum.";

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
