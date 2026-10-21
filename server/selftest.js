// Offline self-tests for open-art-mcp: framing, schemas, validation, mocked HTTP, licence logic,
// download path validation. No network is used (fetch is mocked; the subprocess smoke makes no HTTP calls).
// Run: node server/selftest.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as M from "./index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`ok   ${name}`); } catch (e) { fail++; failures.push(name); console.log(`FAIL ${name}\n     ${String(e?.stack || e).split("\n").slice(0, 4).join("\n     ")}`); }
}

// ---- fetch mock ------------------------------------------------------------
const realFetch = globalThis.fetch;
let calls = [];
function resp(spec) {
  if (spec instanceof Response) return spec;
  const { status = 200, json, body, headers = {} } = spec;
  const h = { ...headers };
  let b = body;
  if (json !== undefined) { b = JSON.stringify(json); h["content-type"] = h["content-type"] || "application/json"; }
  return new Response(b ?? "", { status, headers: h });
}
function mock(router) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = await router(String(url), init);
    if (r instanceof Error) throw r;
    return resp(r);
  };
}
const urls = () => calls.map((c) => c.url);

// ---- fixtures --------------------------------------------------------------
const metObj = (id, pd = true) => ({
  objectID: id, isPublicDomain: pd, title: `Met ${id}`, artistDisplayName: "A. Painter", artistDisplayBio: "Dutch, 1853–1890", objectDate: "1887", medium: "Oil on canvas",
  classification: "Paintings", department: "European Paintings", culture: "", creditLine: "Bequest", dimensions: "16 x 12 in.", accessionNumber: "67.1", objectURL: `https://www.metmuseum.org/art/collection/search/${id}`,
  primaryImage: pd ? `https://images.metmuseum.org/CRDImages/ep/original/${id}.jpg` : "", primaryImageSmall: pd ? `https://images.metmuseum.org/CRDImages/ep/web-large/${id}.jpg` : "",
  additionalImages: pd ? [`https://images.metmuseum.org/CRDImages/ep/original/${id}b.jpg`] : [], rightsAndReproduction: pd ? "" : "© Artist estate", tags: [{ term: "Men" }],
});
const cmaRec = (id, st = "CC0") => ({
  id, accession_number: `1958.${id}`, share_license_status: st, title: `CMA ${id}`, creation_date: "c. 1868", creators: [{ description: "Claude Monet (French, 1840–1926)" }], technique: "oil on fabric", type: "Painting",
  department: "Modern European Painting and Sculpture", culture: ["France, 19th century"], creditline: "Bequest", measurements: "Framed: 128 cm", url: `https://clevelandart.org/art/1958.${id}`, description: "<p>Nice &amp; clear.</p>",
  copyright: st === "CC0" ? null : "© Estate",
  images: st === "CC0" ? { web: { url: `https://openaccess-cdn.clevelandart.org/1958.${id}/1958.${id}_web.jpg` }, print: { url: `https://openaccess-cdn.clevelandart.org/1958.${id}/1958.${id}_print.jpg` }, full: { url: `https://openaccess-cdn.clevelandart.org/1958.${id}/1958.${id}_full.tif` } } : {},
});
const vamRec = (n) => ({ systemNumber: `O${n}`, accessionNumber: "E.31-1968", objectType: "Poster", _primaryTitle: `VAM ${n}`, _primaryMaker: { name: "Unknown" }, _primaryDate: "1968", _primaryPlace: "London", _images: { _iiif_image_base_url: `https://framemark.vam.ac.uk/collections/2006AY${n}/` } });
const vamDetail = (n) => ({ meta: { images: { _iiif_image: `https://framemark.vam.ac.uk/collections/2006AL${n}/`, _images_meta: [{ assetRef: "x", copyright: "© Victoria and Albert Museum, London" }] } }, record: { systemNumber: `O${n}`, accessionNumber: "W.1-1931", objectType: "Bed", titles: [{ title: "Great Bed" }], artistMakerPerson: [{ name: { text: "Vredeman, Hans" } }], productionDates: [{ date: { text: "1590-1600" } }], placesOfOrigin: [{ place: { text: "Ware" } }], materialsAndTechniques: "oak", creditLine: "Purchased", summaryDescription: "<b>Object</b><br>Big bed", images: ["2006AL1", "2006AM2"], categories: [{ text: "Furniture" }] } });

// AIC fixtures mirror live response shapes captured 2026-10-20 (artworks/{id}, artworks/search, departments).
const AIC_CONFIG = { iiif_url: "https://www.artic.edu/iiif/2", website_url: "https://www.artic.edu" };
const aicRec = (id, pd = true) => ({
  id, title: `AIC ${id}`, main_reference_number: "1926.224", date_display: "1884–86", artist_display: "Georges Seurat (French, 1859–1891)", artist_title: "Georges Seurat", place_of_origin: "France",
  short_description: "<p>Dots &amp; dashes.</p>", description: "<p>Long</p>", dimensions: "207.5 × 308.1 cm", medium_display: "Oil on canvas", credit_line: "Helen Birch Bartlett Memorial Collection",
  is_public_domain: pd, copyright_notice: pd ? null : "© Estate / ARS", department_title: "Painting and Sculpture of Europe", classification_title: "painting", artwork_type_title: "Painting",
  term_titles: ["oil on canvas", "Pointillism", "painting", "painting"], image_id: "2d484387-2509-5e8e-2c43-22f9981972eb", alt_image_ids: ["6782523e-056b-ba22-69f9-b5f1b59efcb6", "../evil"],
});
const AIC_INFO = { license_text: "CC0 except description (CC-By)", version: "1.16" };

// Rijksmuseum + Openverse fixtures: trimmed copies of live responses captured 2026-10-20 (server/fixtures/).
const FIX = (f) => JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", f), "utf8"));
const RIJKS_PD = FIX("rijks-200107928.json"); // SK-C-5 Night Watch: image rights Public Domain Mark
const RIJKS_INC = FIX("rijks-200496110.json"); // RP-P-2008-90 Karel Appel: image rights In Copyright (InC)
const RIJKS_SEARCH = FIX("rijks-search-nachtwacht.json");
const OV_SEARCH = FIX("openverse-search-sunflower.json"); // live: one CC BY-SA 2.0 Flickr result
const ovCc0 = { ...OV_SEARCH.results[0], id: "0aff3595-8168-440b-83ff-7a80b65dea42", license: "cc0", license_version: "1.0", license_url: "https://creativecommons.org/publicdomain/zero/1.0/", thumbnail: "https://api.openverse.org/v1/images/0aff3595-8168-440b-83ff-7a80b65dea42/thumb/", attribution: "\"Tulip\" by someone is marked with CC0 1.0." };
const ovPdm = { ...ovCc0, id: "1bff3595-8168-440b-83ff-7a80b65dea42", license: "pdm", license_url: "https://creativecommons.org/publicdomain/mark/1.0/", thumbnail: "https://api.openverse.org/v1/images/1bff3595-8168-440b-83ff-7a80b65dea42/thumb/" };

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);

function router() {
  return (url) => {
    const u = new URL(url);
    if (u.hostname === "collectionapi.metmuseum.org") {
      if (u.pathname === "/public/collection/v1.1/search") {
        if (u.searchParams.get("q") === "nothing") return { json: { total: 0, objectIDs: null } };
        return { json: { total: 3, objectIDs: [101, 102, 103] } };
      }
      if (u.pathname === "/public/collection/v1/departments") return { json: { departments: [{ departmentId: 11, displayName: "European Paintings" }] } };
      const m = /\/v1\/objects\/(\d+)$/.exec(u.pathname);
      if (m) { const id = Number(m[1]); if (id === 404404) return { status: 404, json: { message: "ObjectID not found" } }; return { json: metObj(id, id !== 102) }; }
    }
    if (u.hostname === "openaccess-api.clevelandart.org") {
      if (u.pathname === "/api/artworks/") {
        if (u.searchParams.get("q") === "boom") return { status: 500, body: "oops" };
        return { json: { info: { total: 2 }, data: u.searchParams.get("cc0") ? [cmaRec(1)] : [cmaRec(1), cmaRec(2, "Copyrighted")] } };
      }
      const m = /^\/api\/artworks\/(.+)$/.exec(u.pathname);
      if (m) { if (m[1] === "9999") return { status: 404, json: { detail: "Artwork not found" } }; return { json: { data: cmaRec(Number(m[1]) || 5, m[1] === "77" ? "Copyrighted" : "CC0") } }; }
    }
    if (u.hostname === "api.vam.ac.uk") {
      if (u.pathname === "/v2/objects/search") return { json: { info: { record_count: 20661, page: 1, pages: 2067 }, records: [vamRec(1), vamRec(2)] } };
      if (/\/v2\/object\/O\d+$/.test(u.pathname)) return { json: vamDetail(u.pathname.split("/O")[1]) };
      if (u.pathname.startsWith("/v2/objects/clusters/")) return { json: [{ id: "THES48601", value: "Textiles", count: 5 }] };
    }
    if (u.hostname === "api.artic.edu") {
      if (u.pathname === "/api/v1/artworks/search") {
        const pdOnly = u.searchParams.get("query[bool][filter][0][term][is_public_domain]") === "true";
        return { json: { preference: null, pagination: { total: 2, limit: 2, offset: 0, total_pages: 1, current_page: 1 }, data: pdOnly ? [{ _score: 9, ...aicRec(27992) }] : [{ _score: 9, ...aicRec(27992) }, { _score: 8, ...aicRec(28067, false) }], info: AIC_INFO, config: AIC_CONFIG } };
      }
      if (u.pathname === "/api/v1/departments") return { json: { pagination: { total: 2 }, data: [{ id: "PC-10", title: "Painting and Sculpture of Europe" }, { id: "PC-13", title: "Prints and Drawings" }], info: AIC_INFO, config: AIC_CONFIG } };
      const m = /^\/api\/v1\/artworks\/(\d+)$/.exec(u.pathname);
      if (m) { if (m[1] === "999999999") return { status: 404, json: { status: 404, error: "Not found", detail: "The item you requested cannot be found." } }; return { json: { data: aicRec(Number(m[1]), m[1] !== "28067"), info: AIC_INFO, config: AIC_CONFIG } }; }
    }
    if (u.hostname === "data.rijksmuseum.nl" && u.pathname === "/search/collection") {
      if (u.searchParams.get("objectNumber") === "SK-C-5") return { json: { ...RIJKS_SEARCH, partOf: { ...RIJKS_SEARCH.partOf, totalItems: 1 }, orderedItems: [{ id: "https://id.rijksmuseum.nl/200107928", type: "HumanMadeObject" }] } };
      if (u.searchParams.get("objectNumber")) return { json: { ...RIJKS_SEARCH, partOf: { ...RIJKS_SEARCH.partOf, totalItems: 0 }, orderedItems: [] } };
      return { json: { ...RIJKS_SEARCH, orderedItems: [{ id: "https://id.rijksmuseum.nl/200107928", type: "HumanMadeObject" }, { id: "https://id.rijksmuseum.nl/200496110", type: "HumanMadeObject" }, { id: "https://evil.example/1", type: "HumanMadeObject" }] } };
    }
    if (u.hostname === "id.rijksmuseum.nl") {
      if (u.pathname === "/200107928") return { json: RIJKS_PD, headers: { "content-type": "application/ld+json" } };
      if (u.pathname === "/200496110") return { json: RIJKS_INC, headers: { "content-type": "application/ld+json" } };
      return { status: 404, body: "not found" };
    }
    if (u.hostname === "iiif.micr.io") return { body: JPEG, headers: { "content-type": "image/jpeg" } };
    if (u.hostname === "api.openverse.org") {
      if (u.pathname === "/v1/images/") {
        if (Number(u.searchParams.get("page_size")) > 20) return { status: 401, json: { detail: "page_size may not exceed 20 for anonymous requests" } };
        const lic = u.searchParams.get("license");
        const results = lic === "cc0,pdm" ? [ovCc0, ovPdm] : [OV_SEARCH.results[0], ovCc0];
        return { json: { result_count: results.length, page_count: 1, page_size: results.length, page: 1, results } };
      }
      const m = /^\/v1\/images\/([0-9a-f-]{36})\/$/.exec(u.pathname);
      if (m) { const r = [ovCc0, ovPdm, OV_SEARCH.results[0]].find((x) => x.id === m[1]); return r ? { json: r } : { status: 404, json: { detail: "Not found." } }; }
      if (/\/thumb\/$/.test(u.pathname)) return { body: JPEG, headers: { "content-type": "image/jpeg" } };
    }
    if (u.hostname === "www.artic.edu" && u.pathname.startsWith("/iiif/2/")) return { body: JPEG, headers: { "content-type": "image/jpeg" } };
    if (u.hostname === "images.metmuseum.org" || u.hostname === "openaccess-cdn.clevelandart.org") return { body: JPEG, headers: { "content-type": "image/jpeg" } };
    return { status: 404, json: { detail: "no route" } };
  };
}

const call = async (name, args) => { const r = await M.callTool(name, args); return { ...r, data: r.content ? JSON.parse(r.content[0].text) : null }; };
M._setIntervalsForTest(20);

// ===== 1. framing parser =====================================================
function runParser(chunks) {
  const got = [], errs = [];
  const p = M.createFrameParser((o, f, term) => got.push({ o, f, term }), (f, term, r) => errs.push({ f, term, r }));
  for (const c of chunks) p.push(Buffer.from(c));
  p.end();
  return { got, errs };
}
const req = (id, method = "ping") => ({ jsonrpc: "2.0", id, method });
const clFrame = (o, term) => { const b = JSON.stringify(o); return `Content-Length: ${Buffer.byteLength(b)}${term}${term}${b}`; };

await t("framing: NDJSON (LF and CRLF line ends)", () => {
  const a = runParser([JSON.stringify(req(1)) + "\n" + JSON.stringify(req(2)) + "\r\n"]);
  assert.equal(a.got.length, 2); assert.equal(a.got[0].f, "ndjson"); assert.equal(a.errs.length, 0);
});
await t("framing: NDJSON final line without newline is flushed at end()", () => {
  const a = runParser([JSON.stringify(req(1))]);
  assert.equal(a.got.length, 1);
});
await t("framing: Content-Length with LF-LF", () => {
  const a = runParser([clFrame(req(1), "\n")]);
  assert.equal(a.got.length, 1); assert.equal(a.got[0].f, "cl"); assert.equal(a.got[0].term, "\n");
});
await t("framing: Content-Length with CRLF-CRLF", () => {
  const a = runParser([clFrame(req(1), "\r\n")]);
  assert.equal(a.got.length, 1); assert.equal(a.got[0].term, "\r\n");
});
await t("framing: byte-by-byte delivery of all three framings, mixed in one stream", () => {
  const s = JSON.stringify(req(1)) + "\n" + clFrame(req(2), "\r\n") + clFrame(req(3), "\n") + JSON.stringify(req(4)) + "\n";
  const a = runParser([...Buffer.from(s)].map((b) => Buffer.from([b])));
  assert.deepEqual(a.got.map((g) => g.o.id), [1, 2, 3, 4]);
  assert.deepEqual(a.got.map((g) => g.f), ["ndjson", "cl", "cl", "ndjson"]);
  assert.equal(a.errs.length, 0);
});
await t("framing: lower-case header and multi-byte UTF-8 body length", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping", params: { s: "Ünïcödé 日本" } });
  const a = runParser([`content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`]);
  assert.equal(a.got.length, 1); assert.equal(a.got[0].o.params.s, "Ünïcödé 日本");
});
await t("framing: malformed JSON yields a parse error, not a crash; parser recovers", () => {
  const a = runParser(["{not json}\n", JSON.stringify(req(5)) + "\n"]);
  assert.equal(a.errs.length, 1); assert.equal(a.got.length, 1);
});
await t("framing: encodeFrame mirrors NDJSON / CL-LF / CL-CRLF and never embeds raw newlines in NDJSON", () => {
  const o = { jsonrpc: "2.0", id: 1, result: { text: "a\nb" } };
  assert.equal(M.encodeFrame(o, "ndjson").toString().split("\n").length, 2);
  const lf = M.encodeFrame(o, "cl", "\n").toString(); assert.match(lf, /^Content-Length: \d+\n\n\{/);
  const crlf = M.encodeFrame(o, "cl", "\r\n").toString(); assert.match(crlf, /^Content-Length: \d+\r\n\r\n\{/);
  const n = Number(/Content-Length: (\d+)/.exec(crlf)[1]); assert.equal(Buffer.byteLength(crlf.split("\r\n\r\n")[1]), n);
});

// ===== 2. subprocess smoke: tools/list over all three framings ================
function rpcOverStdio(inputBuf, { expect, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, "index.js")], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, ...env } });
    const out = [], err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    const to = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("subprocess timeout")); }, 20000);
    child.on("close", () => { clearTimeout(to); resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }); });
    child.stdin.write(inputBuf);
    child.stdin.end();
  });
}
function parseOut(stdout, framing) {
  const s = stdout.toString("utf8");
  if (framing === "ndjson") return s.split("\n").filter(Boolean).map((l) => JSON.parse(l)); // throws if any stdout line is not JSON
  const out = []; let rest = Buffer.from(stdout);
  while (rest.length) {
    const m = /^Content-Length: (\d+)(\r?\n)\2/.exec(rest.toString("latin1")); assert.ok(m, "stdout is not clean Content-Length framing");
    const hl = m[0].length; out.push(JSON.parse(rest.subarray(hl, hl + Number(m[1])).toString("utf8"))); rest = rest.subarray(hl + Number(m[1]));
  }
  return out;
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "selftest", version: "0" } } };
const INITD = { jsonrpc: "2.0", method: "notifications/initialized" };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const STATUS = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "oa_status", arguments: {} } };
const BADCALL = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "oa_met_get_object", arguments: { objectId: "../../etc/passwd" } } };
let toolCount = 0;
for (const [label, framing, enc] of [
  ["NDJSON", "ndjson", (o) => JSON.stringify(o) + "\n"],
  ["Content-Length LF", "cl", (o) => clFrame(o, "\n")],
  ["Content-Length CRLF", "cl", (o) => clFrame(o, "\r\n")],
]) {
  await t(`subprocess smoke (${label}): initialize + tools/list + status + invalid-id call; stdout is JSON-RPC only`, async () => {
    const r = await rpcOverStdio(Buffer.from([INIT, INITD, LIST, STATUS, BADCALL].map(enc).join("")), {});
    const msgs = parseOut(r.stdout, framing);
    assert.equal(msgs.length, 4, "4 responses (notification gets none)");
    const byId = Object.fromEntries(msgs.map((m) => [m.id, m]));
    assert.equal(byId[1].result.serverInfo.name, "open-art-mcp");
    assert.equal(byId[1].result.protocolVersion, "2025-06-18");
    toolCount = byId[2].result.tools.length;
    assert.equal(toolCount, 20);
    assert.ok(JSON.parse(byId[3].result.content[0].text).version);
    assert.equal(byId[4].result.isError, true);
    assert.equal(JSON.parse(byId[4].result.content[0].text).error.code, "INVALID_INPUT");
    assert.match(r.stderr, /ready \(stdio\)/, "logs go to stderr");
    if (framing === "cl") assert.ok(r.stdout.toString().startsWith("Content-Length:"));
    if (label === "Content-Length CRLF") assert.ok(r.stdout.toString().includes("\r\n\r\n"));
    if (label === "Content-Length LF") assert.ok(!r.stdout.toString().includes("\r"));
  });
}
await t("subprocess: unknown method -> -32601; unknown tool -> -32602; bad JSON -> -32700 with null id", async () => {
  const lines = ["{bad\n", JSON.stringify({ jsonrpc: "2.0", id: 7, method: "nope/x" }) + "\n", JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "no_such_tool" } }) + "\n"].join("");
  const r = await rpcOverStdio(Buffer.from(lines), {});
  const msgs = parseOut(r.stdout, "ndjson");
  assert.ok(msgs.some((m) => m.error?.code === -32700 && m.id === null));
  assert.ok(msgs.some((m) => m.id === 7 && m.error.code === -32601));
  assert.ok(msgs.some((m) => m.id === 8 && m.error.code === -32602));
});
await t("subprocess: batch request returns one array response", async () => {
  const r = await rpcOverStdio(Buffer.from(JSON.stringify([req(1), req(2), INITD]) + "\n"), {});
  const msgs = parseOut(r.stdout, "ndjson");
  assert.equal(msgs.length, 1); assert.equal(msgs[0].length, 2);
});
await t("subprocess: run-mcp.sh launcher works from another cwd", async () => {
  const sh = path.join(HERE, "..", "run-mcp.sh");
  const out = await new Promise((resolve) => { const c = spawn("bash", [sh], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] }); const o = []; c.stdout.on("data", (d) => o.push(d)); c.on("close", () => resolve(Buffer.concat(o))); c.stdin.end(JSON.stringify(LIST) + "\n"); });
  assert.equal(parseOut(out, "ndjson")[0].result.tools.length, 20);
});

// ===== 3. schemas ============================================================
await t("tools/list: 20 tools, strict schemas, annotations (readOnlyHint true on all but the download tool)", () => {
  const tools = M.listTools();
  assert.equal(tools.length, 20);
  const names = tools.map((x) => x.name);
  assert.equal(new Set(names).size, 20);
  for (const x of tools) {
    assert.match(x.name, /^oa_[a-z_]+$/);
    assert.equal(x.inputSchema.type, "object"); assert.equal(x.inputSchema.additionalProperties, false);
    assert.ok(x.description.length > 20);
    assert.equal(x.annotations.destructiveHint, false);
    if (x.name === "oa_download_image") { assert.equal(x.annotations.readOnlyHint, false); } else assert.equal(x.annotations.readOnlyHint, true, x.name);
    for (const r of x.inputSchema.required) assert.ok(x.inputSchema.properties[r], `${x.name}.${r}`);
  }
  for (const n of ["oa_search_all", "oa_best_image_url", "oa_met_search", "oa_cleveland_search", "oa_vam_search", "oa_met_get_object", "oa_cleveland_get_artwork", "oa_vam_get_object", "oa_met_list_departments", "oa_cleveland_list_departments", "oa_vam_list_collections", "oa_status", "oa_download_image", "oa_aic_search", "oa_aic_get_artwork", "oa_aic_list_departments", "oa_rijks_search", "oa_rijks_get_object", "oa_openverse_search", "oa_openverse_get_image"]) assert.ok(names.includes(n), n);
  assert.equal(names.filter((n) => /write|post|delete|update|create/.test(n)).length, 0);
});
await t("version in server/package.json matches plugin.json and VERSION", () => {
  const pj = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
  const pl = JSON.parse(fs.readFileSync(path.join(HERE, "..", "plugin.json"), "utf8"));
  assert.equal(pj.version, pl.version); assert.equal(pl.version, M.VERSION); assert.equal(pl.name, "open-art-mcp"); assert.deepEqual(pl.author, { name: "Chris R" });
  assert.deepEqual(pj.dependencies ?? {}, {});
});

// ===== 4. input validation (no network may happen) ===========================
await t("validation: ids, ranges, unknown args and control characters are rejected before any HTTP call", async () => {
  mock(router());
  const bad = [
    ["oa_met_get_object", { objectId: "abc" }], ["oa_met_get_object", { objectId: "0" }], ["oa_met_get_object", { objectId: "12a" }], ["oa_met_get_object", { objectId: "1e5" }],
    ["oa_met_get_object", { objectId: "../1" }], ["oa_met_get_object", { objectId: "1234567890" }], ["oa_met_get_object", {}], ["oa_met_get_object", { objectId: "1", extra: 1 }],
    ["oa_cleveland_get_artwork", { id: "a/b" }], ["oa_cleveland_get_artwork", { id: "../x" }], ["oa_cleveland_get_artwork", { id: "1958.39?x=1" }], ["oa_cleveland_get_artwork", { id: "" }],
    ["oa_vam_get_object", { systemNumber: "o1" }], ["oa_vam_get_object", { systemNumber: "O0" }], ["oa_vam_get_object", { systemNumber: "O1/../x" }], ["oa_vam_get_object", { systemNumber: "123" }],
    ["oa_met_search", { q: "a\u0000b" }], ["oa_met_search", { q: "x", limit: 0 }], ["oa_met_search", { q: "x", limit: 26 }], ["oa_met_search", { q: "x", hydrate: false, limit: 101 }], ["oa_met_search", { q: "x", offset: 9990, limit: 20, hydrate: false }],
    ["oa_met_search", {}], ["oa_met_search", { q: "x", dateBegin: 1800 }], ["oa_met_search", { q: "x", medium: "Paint&ings=1" }], ["oa_met_search", { q: "x".repeat(201) }], ["oa_met_search", { q: "x", departmentId: "11; drop" }],
    ["oa_cleveland_search", {}], ["oa_cleveland_search", { q: "x", department: "Not A Department" }], ["oa_cleveland_search", { q: "x", limit: 101 }], ["oa_cleveland_search", { q: "x", type: "Pai/nting" }],
    ["oa_vam_search", {}], ["oa_vam_search", { q: "x", pageSize: 101 }], ["oa_vam_search", { q: "x", page: 0 }], ["oa_vam_search", { q: "x", collectionId: "THES1;x" }], ["oa_vam_search", { q: "x", yearMadeFrom: 1900 }],
    ["oa_vam_list_collections", { type: "../x" }], ["oa_search_all", {}], ["oa_search_all", { q: "   " }], ["oa_search_all", { q: "x", museums: ["louvre"] }], ["oa_search_all", { q: "x", limitPerMuseum: 11 }],
    ["oa_best_image_url", { museum: "met", id: "abc" }], ["oa_best_image_url", { museum: "vam", id: "12" }], ["oa_best_image_url", { museum: "louvre", id: "1" }], ["oa_best_image_url", { museum: "cleveland", id: "x y" }],
    ["oa_aic_get_artwork", { id: "abc" }], ["oa_aic_get_artwork", { id: "0" }], ["oa_aic_get_artwork", { id: "1/../2" }], ["oa_aic_get_artwork", {}],
    ["oa_aic_search", {}], ["oa_aic_search", { q: "x", limit: 101 }], ["oa_aic_search", { q: "x", page: 0 }], ["oa_aic_search", { q: "x", page: 101, limit: 100 }], ["oa_aic_search", { q: "x", departmentId: "PC-1]x" }], ["oa_aic_search", { q: "x", toString: 1 }],
    ["oa_best_image_url", { museum: "aic", id: "x1" }],
    ["oa_rijks_search", {}], ["oa_rijks_search", { title: "x", limit: 11 }], ["oa_rijks_search", { title: "x", offset: 100 }], ["oa_rijks_search", { creationDate: "16??;x" }], ["oa_rijks_search", { title: "x", pageToken: "a/b" }], ["oa_rijks_search", { q: "x" }],
    ["oa_rijks_get_object", { id: "SK-C-5*" }], ["oa_rijks_get_object", { id: "../200107928" }], ["oa_rijks_get_object", { id: "123" }], ["oa_rijks_get_object", { id: "sk-c-5" }],
    ["oa_openverse_search", {}], ["oa_openverse_search", { q: "x", pageSize: 21 }], ["oa_openverse_search", { q: "x", licenses: ["gpl"] }], ["oa_openverse_search", { q: "x", source: "Flickr!" }], ["oa_openverse_search", { q: "x", licenses: ["by"] }],
    ["oa_openverse_get_image", { id: "not-a-uuid" }], ["oa_openverse_get_image", { id: "0aff3595-8168-440b-83ff-7a80b65dea42/../x" }],
    ["oa_best_image_url", { museum: "openverse", id: "123" }], ["oa_download_image", { museum: "openverse", id: "0aff3595-8168-440b-83ff-7a80b65dea42", directory: "/tmp/ovx", size: "large" }],
    ["oa_download_image", { museum: "vam", id: "O1", directory: "/tmp/x" }], ["oa_download_image", { museum: "met", id: "1", directory: "relative/dir" }], ["oa_download_image", { museum: "met", id: "1", directory: "/tmp/../etc" }],
  ];
  for (const [name, args] of bad) {
    const r = await call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)} should fail`);
    assert.ok(["INVALID_INPUT", "INVALID_DIRECTORY"].includes(r.data.error.code), `${name} ${JSON.stringify(args)} -> ${r.data.error.code}`);
  }
  assert.equal(calls.length, 0, "no upstream request for invalid input");
});
await t("validation: numeric strings are coerced for ints; valid ids pass", async () => {
  mock(router());
  const r = await call("oa_met_get_object", { objectId: "436532" });
  assert.equal(r.isError, false); assert.equal(r.data.result.id, "436532");
  const c = await call("oa_cleveland_get_artwork", { id: "1916.1160.b" }); assert.equal(c.isError, false);
  assert.ok(urls().some((u) => u.endsWith("/api/artworks/1916.1160.b")));
});

// ===== 5. Met (mocked) =======================================================
await t("met search: uses /v1.1/search only (never /v1/search), hydrates, hides non-public-domain, UA + GET", async () => {
  mock(router());
  const r = await call("oa_met_search", { q: "sunflowers", limit: 3 });
  assert.equal(r.isError, false);
  assert.ok(urls()[0].includes("/public/collection/v1.1/search?"));
  assert.ok(!urls().some((u) => /\/v1\/search/.test(u)));
  assert.match(urls()[0], /hasImages=true/); assert.match(urls()[0], /limit=3/); assert.match(urls()[0], /offset=0/);
  assert.deepEqual(r.data.results.map((x) => x.id), ["101", "103"], "102 is not public domain");
  assert.ok(r.data.results.every((x) => x.license.openAccess && x.license.reuse === "direct-reuse-ok"));
  assert.equal(r.data.total, 3);
  for (const c of calls) { assert.equal(c.init.method, "GET"); assert.match(c.init.headers["User-Agent"], /^open-art-mcp\/0\.3\.0 \(/); assert.equal(c.init.body, undefined); }
});
await t("met search: openAccessOnly=false keeps non-public-domain items flagged reference-only", async () => {
  mock(router());
  const r = await call("oa_met_search", { q: "x", openAccessOnly: false, hasImage: false });
  const x = r.data.results.find((z) => z.id === "102");
  assert.ok(x); assert.equal(x.license.openAccess, false); assert.equal(x.license.reuse, "reference-only"); assert.equal(x.license.status, "restricted"); assert.equal(x.license.rights, "© Artist estate"); assert.equal(x.images.hasImage, false);
  assert.ok(!/hasImages/.test(urls()[0]));
});
await t("met search: zero hits (objectIDs:null) is handled; hydrate=false returns ids only", async () => {
  mock(router());
  const z = await call("oa_met_search", { q: "nothing" }); assert.equal(z.isError, false); assert.deepEqual(z.data.results, []); assert.equal(z.data.total, 0);
  const ids = await call("oa_met_search", { q: "x", hydrate: false, limit: 100 }); assert.deepEqual(ids.data.objectIDs, [101, 102, 103]); assert.equal(calls.filter((c) => /objects/.test(c.url)).length, 0);
});
await t("met get: licence + images; 404 -> NOT_FOUND", async () => {
  mock(router());
  const r = await call("oa_met_get_object", { objectId: "101" });
  assert.equal(r.data.result.license.status, "public-domain"); assert.ok(r.data.result.images.large.startsWith("https://images.metmuseum.org/")); assert.equal(r.data.result.images.additional.length, 1);
  const n = await call("oa_met_get_object", { objectId: "404404" }); assert.equal(n.isError, true); assert.equal(n.data.error.code, "NOT_FOUND");
});
await t("met departments", async () => { mock(router()); const r = await call("oa_met_list_departments", {}); assert.equal(r.data.departments[0].departmentId, 11); });

// ===== 6. Cleveland / V&A (mocked) ==========================================
await t("cleveland: CC0 vs Copyrighted licence mapping; cc0 + has_image params; HTML stripped", async () => {
  mock(router());
  const r = await call("oa_cleveland_search", { q: "monet" });
  assert.match(urls()[0], /cc0=1/); assert.match(urls()[0], /has_image=1/);
  const x = r.data.results[0]; assert.equal(x.license.status, "CC0"); assert.equal(x.license.openAccess, true); assert.equal(x.description, "Nice & clear."); assert.ok(x.images.original.endsWith(".tif")); assert.ok(x.images.large.endsWith("_print.jpg"));
  mock(router());
  const all = await call("oa_cleveland_search", { q: "monet", openAccessOnly: false, hasImage: false });
  const c = all.data.results.find((z) => z.id === "2"); assert.equal(c.license.openAccess, false); assert.equal(c.images.hasImage, false); assert.equal(c.license.rights, "© Estate"); assert.match(c.license.label, /Copyrighted/);
  const cr = await call("oa_cleveland_get_artwork", { id: "77" }); assert.equal(cr.data.result.license.reuse, "reference-only");
  const nf = await call("oa_cleveland_get_artwork", { id: "9999" }); assert.equal(nf.data.error.code, "NOT_FOUND");
});
await t("cleveland departments list is static, no network", async () => { mock(router()); const r = await call("oa_cleveland_list_departments", {}); assert.ok(r.data.departments.includes("Prints")); assert.equal(calls.length, 0); });
await t("v&a: never open access (search record + detail), IIIF image urls, framemark host only", async () => {
  mock(router());
  const s = await call("oa_vam_search", { q: "poster" });
  assert.match(urls()[0], /images_exist=1/); assert.match(urls()[0], /page_size=10/);
  for (const x of s.data.results) { assert.equal(x.license.openAccess, false); assert.equal(x.license.reuse, "reference-only"); assert.equal(x.license.status, "not-open-access"); assert.match(x.license.termsUrl, /vam\.ac\.uk/); assert.match(x.images.large, /^https:\/\/framemark\.vam\.ac\.uk\/collections\/[A-Za-z0-9]+\/full\/full\/0\/default\.jpg$/); }
  const d = await call("oa_vam_get_object", { systemNumber: "O9138" });
  assert.equal(d.data.result.license.openAccess, false); assert.equal(d.data.result.title, "Great Bed"); assert.equal(d.data.result.description, "Object Big bed"); assert.equal(d.data.result.images.additional.length, 1); assert.equal(d.data.result.license.rights, "© Victoria and Albert Museum, London");
  const l = await call("oa_vam_list_collections", {}); assert.equal(l.data.terms[0].id, "THES48601");
});
await t("v&a: a hostile image base URL in a response is not turned into an image URL", () => {
  const rec = M.normalizeVamSearchRecord({ systemNumber: "O1", _images: { _iiif_image_base_url: "https://evil.example/collections/x/" } });
  assert.equal(rec.images.hasImage, false); assert.equal(rec.images.large, null);
});

// ===== 7. cross-museum =======================================================
await t("search_all: default openAccessOnly skips V&A (and says so); only open-access results come back", async () => {
  mock(router());
  const r = await call("oa_search_all", { q: "monet" });
  assert.ok(r.data.skipped.vam); assert.ok(!calls.some((c) => c.url.includes("vam.ac.uk")));
  assert.ok(r.data.results.length >= 2); assert.ok(r.data.results.every((x) => x.license.openAccess));
  assert.deepEqual([...new Set(r.data.results.map((x) => x.museum))].sort(), ["aic", "cleveland", "met", "openverse", "rijks"]);
  assert.deepEqual(Object.keys(r.data.perMuseum).sort(), ["aic", "cleveland", "met", "openverse", "rijks"]); assert.deepEqual(r.data.errors, {});
});
await t("search_all: openAccessOnly=false includes V&A as reference-only, normalized shape identical across museums, interleaved", async () => {
  mock(router());
  const r = await call("oa_search_all", { q: "monet", openAccessOnly: false, hasImage: false });
  const keys = (x) => Object.keys(x).sort().join(",");
  const shapes = new Set(r.data.results.map(keys)); assert.equal(shapes.size, 1, "one normalized record shape");
  assert.deepEqual([...new Set(r.data.results.map((x) => x.museum))].sort(), ["aic", "cleveland", "met", "openverse", "rijks", "vam"]);
  assert.equal(new Set(r.data.results.slice(0, 6).map((x) => x.museum)).size, 6, "round-robin interleave");
  for (const x of r.data.results) { assert.ok(["met", "cleveland", "vam", "aic", "rijks", "openverse"].includes(x.museum)); assert.equal(typeof x.license.openAccess, "boolean"); assert.ok(x.license.label); assert.ok("rights" in x.license); assert.ok(x.license.termsUrl); assert.ok(x.images && "hasImage" in x.images); }
  assert.ok(r.data.results.filter((x) => x.museum === "vam").every((x) => !x.license.openAccess));
});
await t("search_all: one museum failing returns partial results plus a per-museum error", async () => {
  mock(router());
  const r = await call("oa_search_all", { q: "boom" });
  assert.equal(r.isError, false); assert.equal(r.data.errors.cleveland.code, "UPSTREAM_ERROR"); assert.ok(r.data.results.some((x) => x.museum === "met"));
});
await t("search_all: museums subset honoured", async () => {
  mock(router());
  const r = await call("oa_search_all", { q: "x", museums: ["cleveland"] });
  assert.ok(calls.every((c) => c.url.includes("clevelandart.org"))); assert.ok(r.data.results.every((x) => x.museum === "cleveland"));
});

// ===== 8. image helper =======================================================
await t("best_image_url: open-access returns URL by size; V&A returns null unless requireOpenAccess=false (and then warns)", async () => {
  mock(router());
  const w = await call("oa_best_image_url", { museum: "met", id: "101", size: "web" }); assert.match(w.data.url, /web-large/);
  const l = await call("oa_best_image_url", { museum: "met", id: "101" }); assert.match(l.data.url, /original/);
  const c = await call("oa_best_image_url", { museum: "cleveland", id: "5" }); assert.match(c.data.url, /_print\.jpg$/);
  const co = await call("oa_best_image_url", { museum: "cleveland", id: "5", size: "original" }); assert.match(co.data.url, /_full\.tif$/);
  const v = await call("oa_best_image_url", { museum: "vam", id: "O9138" }); assert.equal(v.data.url, null); assert.equal(v.data.license.openAccess, false); assert.ok(v.data.notes.some((n) => /reference only/i.test(n)));
  const v2 = await call("oa_best_image_url", { museum: "vam", id: "O9138", requireOpenAccess: false, size: "web" }); assert.match(v2.data.url, /!768,768/); assert.ok(v2.data.notes.some((n) => /REFERENCE ONLY/.test(n)));
  const nonPd = await call("oa_best_image_url", { museum: "cleveland", id: "77" }); assert.equal(nonPd.data.url, null);
  assert.ok(calls.every((x) => x.init.method === "GET"));
});

// ===== 9. HTTP behaviour =====================================================
await t("http: host allow-list, https only, no credentials; refused URLs never reach fetch", async () => {
  mock(router());
  for (const u of ["https://evil.example/x", "http://collectionapi.metmuseum.org/x", "https://user:pw@collectionapi.metmuseum.org/x", "https://collectionapi.metmuseum.org:8443/x", "file:///etc/passwd", "not a url"]) {
    await assert.rejects(() => M.httpGet(u), (e) => e instanceof M.ToolError && ["HOST_NOT_ALLOWED", "INVALID_URL"].includes(e.code), u);
  }
  assert.equal(calls.length, 0);
});
await t("http: redirect to a non-allow-listed host is refused; same-museum redirect is followed", async () => {
  mock((url) => url.includes("/hop") ? { status: 302, headers: { location: "https://evil.example/steal" } } : url.includes("/ok") ? { status: 302, headers: { location: "/public/collection/v1/departments" } } : router()(url));
  await assert.rejects(() => M.httpGet("https://collectionapi.metmuseum.org/hop"), (e) => e.code === "HOST_NOT_ALLOWED");
  assert.equal(calls.length, 1);
  const r = await M.getJson("https://collectionapi.metmuseum.org/ok"); assert.ok(r.departments);
});
await t("http: 30s timeout is enforced (OPEN_ART_TIMEOUT_MS lowers it for the test; it can never exceed 30000)", async () => {
  process.env.OPEN_ART_TIMEOUT_MS = "150";
  mock((url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))));
  const t0 = Date.now(); const r = await call("oa_met_get_object", { objectId: "1" }); const dt = Date.now() - t0;
  assert.equal(r.data.error.code, "TIMEOUT"); assert.ok(dt < 3000, `took ${dt}`);
  process.env.OPEN_ART_TIMEOUT_MS = "999999999";
  assert.equal(M.LIMITS.httpTimeoutMs, 30000); assert.equal(M._timeoutMs(), 30000);
  delete process.env.OPEN_ART_TIMEOUT_MS;
});
await t("http: 10 MB response cap (declared Content-Length and streamed bodies)", async () => {
  mock(() => ({ status: 200, body: "x", headers: { "content-length": String(11 * 1024 * 1024) } }));
  assert.equal((await call("oa_met_list_departments", {})).data.error.code, "RESPONSE_TOO_LARGE");
  mock(() => { let n = 0; const stream = new ReadableStream({ pull(c) { if (n++ < 12) c.enqueue(new Uint8Array(1024 * 1024)); else c.close(); } }); return new Response(stream, { status: 200 }); });
  assert.equal((await call("oa_met_list_departments", {})).data.error.code, "RESPONSE_TOO_LARGE");
  assert.equal(M.LIMITS.maxResponseBytes, 10 * 1024 * 1024);
});
await t("http: 429 with Retry-After is retried once; 429 without it surfaces RATE_LIMITED; 410 -> ENDPOINT_RETIRED; non-JSON -> BAD_JSON", async () => {
  let n = 0;
  mock(() => (n++ === 0 ? { status: 429, headers: { "retry-after": "0" } } : { json: { departments: [] } }));
  assert.equal((await call("oa_met_list_departments", {})).isError, false); assert.equal(calls.length, 2);
  mock(() => ({ status: 429 })); const r = await call("oa_met_list_departments", {}); assert.equal(r.data.error.code, "RATE_LIMITED"); assert.equal(calls.length, 1);
  mock(() => ({ status: 410, json: { message: "retired" } })); assert.equal((await call("oa_met_list_departments", {})).data.error.code, "ENDPOINT_RETIRED");
  mock(() => ({ status: 200, body: "<html>" })); assert.equal((await call("oa_met_list_departments", {})).data.error.code, "BAD_JSON");
  mock(() => new Error("ECONNRESET")); assert.equal((await call("oa_met_list_departments", {})).data.error.code, "NETWORK_ERROR");
});
await t("pacing: per-museum minimum interval is honoured; museums do not block each other", async () => {
  M._setIntervalsForTest(120);
  mock(router());
  const t0 = Date.now();
  await call("oa_met_get_object", { objectId: "1" }); await call("oa_met_get_object", { objectId: "2" }); await call("oa_met_get_object", { objectId: "3" });
  const dt = Date.now() - t0; assert.ok(dt >= 230, `3 sequential met calls took ${dt}ms (<230)`);
  const t1 = Date.now();
  await Promise.all([call("oa_met_get_object", { objectId: "4" }), call("oa_cleveland_get_artwork", { id: "5" }), call("oa_vam_get_object", { systemNumber: "O6" })]);
  assert.ok(Date.now() - t1 < 400, "different museums run in parallel");
  const t2 = Date.now(); await Promise.all([1, 2, 3].map((i) => call("oa_met_get_object", { objectId: String(i) }))); assert.ok(Date.now() - t2 >= 230, "concurrent calls to one museum are serialised");
  M._setIntervalsForTest(20);
  const d = M.MUSEUMS; assert.equal(d.met.minIntervalMs >= 13, true); assert.ok(d.vam.minIntervalMs >= d.cleveland.minIntervalMs && d.cleveland.minIntervalMs >= d.met.minIntervalMs);
  assert.ok(1000 / d.met.minIntervalMs <= 80, "Met stays far below its documented 80 req/s");
});
await t("user-agent is descriptive; OPEN_ART_CONTACT is appended only when it is clean", () => {
  assert.match(M.userAgent(), /open-art-mcp\/0\.3\.0 \(read-only MCP plugin/);
  process.env.OPEN_ART_CONTACT = "https://example.org/x"; assert.match(M.userAgent(), /contact: https:\/\/example\.org\/x$/);
  process.env.OPEN_ART_CONTACT = "bad\r\nX-Evil: 1"; assert.doesNotMatch(M.userAgent(), /Evil/);
  delete process.env.OPEN_ART_CONTACT;
});
await t("only GET requests are ever issued (every tool, mocked)", async () => {
  mock(router());
  await call("oa_met_search", { q: "x" }); await call("oa_cleveland_search", { q: "x" }); await call("oa_vam_search", { q: "x" }); await call("oa_search_all", { q: "x", openAccessOnly: false }); await call("oa_vam_list_collections", { type: "material" });
  assert.ok(calls.length > 5); assert.ok(calls.every((c) => c.init.method === "GET" && !c.init.body));
});

// ===== 10. download + path validation ========================================
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oa-selftest-"));
await t("download: dry run by default writes nothing", async () => {
  mock(router());
  const d = path.join(tmp, "dry");
  const r = await call("oa_download_image", { museum: "met", id: "101", directory: d });
  assert.equal(r.isError, false); assert.equal(r.data.dryRun, true); assert.ok(!fs.existsSync(d)); assert.equal(calls.filter((c) => c.url.includes("images.metmuseum")).length, 0);
});
await t("download: confirm=true writes image + license.json, never overwrites", async () => {
  mock(router());
  const d = path.join(tmp, "ok", "sub");
  const r = await call("oa_download_image", { museum: "met", id: "101", directory: d, confirm: true });
  assert.equal(r.isError, false, JSON.stringify(r.data)); assert.equal(r.data.written.length, 2);
  const [img, meta] = r.data.written; assert.ok(img.startsWith(fs.realpathSync(d))); assert.ok(img.endsWith(".jpg")); assert.deepEqual(fs.readFileSync(img), JPEG);
  const j = JSON.parse(fs.readFileSync(meta, "utf8")); assert.equal(j.license.openAccess, true); assert.equal(j.museum, "met"); assert.match(j.imageUrl, /^https:\/\/images\.metmuseum\.org\//);
  const again = await call("oa_download_image", { museum: "met", id: "101", directory: d, confirm: true }); assert.equal(again.data.error.code, "FILE_EXISTS");
  assert.deepEqual(fs.readdirSync(d).sort().length, 2);
  const c = await call("oa_download_image", { museum: "cleveland", id: "5", directory: d, confirm: true, size: "large" }); assert.equal(c.isError, false); assert.match(c.data.written[0], /cleveland-5-large\.jpg$/);
});
await t("download: refuses non-open-access items and wrong content types, and enforces the size cap", async () => {
  mock(router());
  const np = await call("oa_download_image", { museum: "met", id: "102", directory: path.join(tmp, "np"), confirm: true }); assert.equal(np.data.error.code, "NOT_OPEN_ACCESS"); assert.ok(!fs.existsSync(path.join(tmp, "np")));
  const cr = await call("oa_download_image", { museum: "cleveland", id: "77", directory: path.join(tmp, "np"), confirm: true }); assert.equal(cr.data.error.code, "NOT_OPEN_ACCESS");
  mock((u) => (u.includes("images.metmuseum") ? { body: "<html>", headers: { "content-type": "text/html" } } : router()(u)));
  const ct = await call("oa_download_image", { museum: "met", id: "101", directory: path.join(tmp, "ct"), confirm: true }); assert.equal(ct.data.error.code, "UNEXPECTED_CONTENT_TYPE");
  mock((u) => (u.includes("images.metmuseum") ? { body: Buffer.alloc(3 * 1024 * 1024), headers: { "content-type": "image/jpeg", "content-length": String(3 * 1024 * 1024) } } : router()(u)));
  const big = await call("oa_download_image", { museum: "met", id: "101", directory: path.join(tmp, "big"), confirm: true, maxMegabytes: 1 }); assert.equal(big.data.error.code, "RESPONSE_TOO_LARGE");
  assert.deepEqual(fs.existsSync(path.join(tmp, "big")) ? fs.readdirSync(path.join(tmp, "big")) : [], []);
});
await t("path validation: relative, '..', NUL, root, system dirs, hidden dirs, home, plugin dir, symlink escape", () => {
  const bad = ["relative/x", "./x", "", "/", "/tmp/../etc", "/etc", "/etc/cron.d", "/proc/self", "/usr/local/x", "/var/lib/x", "/root/x", "/tmp/a\0b", path.join(tmp, ".hidden"), path.join(tmp, "a", ".ssh"), path.join(HERE, "..", "x"), os.homedir(), "x".repeat(2000)];
  for (const b of bad) assert.throws(() => M.validateDownloadDir(b), (e) => e instanceof M.ToolError && e.code === "INVALID_DIRECTORY", JSON.stringify(b));
  const link = path.join(tmp, "escape"); fs.symlinkSync("/etc", link);
  assert.throws(() => M.validateDownloadDir(path.join(link, "x")), (e) => e.code === "INVALID_DIRECTORY");
  assert.throws(() => M.validateDownloadDir(link), (e) => e.code === "INVALID_DIRECTORY");
  assert.ok(M.validateDownloadDir(path.join(tmp, "fine", "deeper")).includes("fine"));
});
await t("path validation: OPEN_ART_DOWNLOAD_ROOT confines writes", () => {
  const root = path.join(tmp, "root"); fs.mkdirSync(root);
  process.env.OPEN_ART_DOWNLOAD_ROOT = root;
  assert.ok(M.validateDownloadDir(path.join(root, "a")));
  assert.throws(() => M.validateDownloadDir(path.join(tmp, "elsewhere")), (e) => e.code === "INVALID_DIRECTORY");
  assert.throws(() => M.validateDownloadDir(root + "-sibling"), (e) => e.code === "INVALID_DIRECTORY");
  const l2 = path.join(root, "out"); fs.symlinkSync(os.tmpdir(), l2);
  assert.throws(() => M.validateDownloadDir(path.join(l2, "x")), (e) => e.code === "INVALID_DIRECTORY");
  delete process.env.OPEN_ART_DOWNLOAD_ROOT;
});

// ===== 10b. Art Institute of Chicago ===========================================
await t("aic: get artwork normalizes live shape; is_public_domain=true -> open access; IIIF URLs built from config.iiif_url", async () => {
  mock(router()); const r = await call("oa_aic_get_artwork", { id: "27992" });
  assert.equal(r.isError, false, JSON.stringify(r.data)); const x = r.data.result;
  assert.equal(x.museum, "aic"); assert.equal(x.license.openAccess, true); assert.equal(x.license.status, "public-domain"); assert.match(x.license.termsUrl, /artic\.edu\/terms/);
  assert.equal(x.images.web, "https://www.artic.edu/iiif/2/2d484387-2509-5e8e-2c43-22f9981972eb/full/843,/0/default.jpg");
  assert.match(x.images.large, /\/full\/1686,\/0\/default\.jpg$/); assert.equal(x.images.additional.length, 1, "invalid alt image id dropped");
  assert.equal(x.description, "Dots & dashes."); assert.equal(x.accessionNumber, "1926.224"); assert.equal(x.url, "https://www.artic.edu/artworks/27992"); assert.deepEqual(x.tags, ["oil on canvas", "Pointillism", "painting"]);
  assert.ok(calls[0].url.includes("fields=")); assert.ok(calls[0].init.headers["AIC-User-Agent"].startsWith("open-art-mcp/0.3.0"));
});
await t("aic: not public domain -> reference only; best_image_url withholds URL; download refused", async () => {
  mock(router()); const r = await call("oa_aic_get_artwork", { id: "28067" });
  assert.equal(r.data.result.license.openAccess, false); assert.equal(r.data.result.license.reuse, "reference-only"); assert.equal(r.data.result.license.rights, "© Estate / ARS");
  const b = await call("oa_best_image_url", { museum: "aic", id: "28067" }); assert.equal(b.data.url, null);
  const d = await call("oa_download_image", { museum: "aic", id: "28067", directory: path.join(tmp, "aicno"), confirm: true }); assert.equal(d.data.error.code, "NOT_OPEN_ACCESS");
});
await t("aic: only is_public_domain === true counts (truthy strings, missing flag do not)", () => {
  for (const v of ["true", 1, undefined, null]) assert.equal(M.normalizeAic({ id: 1, is_public_domain: v, image_id: null }, AIC_CONFIG).license.openAccess, false, String(v));
  const n = M.normalizeAic({ id: 1, is_public_domain: true, image_id: null }, AIC_CONFIG); assert.equal(n.images.hasImage, false); assert.equal(n.images.web, null);
});
await t("aic: off-host iiif_url in config is ignored (falls back to www.artic.edu/iiif/2)", () => {
  const n = M.normalizeAic({ id: 1, is_public_domain: true, image_id: "2d484387-2509-5e8e-2c43-22f9981972eb" }, { iiif_url: "https://evil.example/iiif/2" });
  assert.ok(n.images.web.startsWith("https://www.artic.edu/iiif/2/"));
});
await t("aic: search sends public-domain + image filters as query DSL params; openAccessOnly=false drops the PD filter", async () => {
  mock(router()); const r = await call("oa_aic_search", { q: "seurat", departmentId: "PC-10", limit: 5, page: 2 });
  assert.equal(r.isError, false); const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get("query[bool][filter][0][term][is_public_domain]"), "true"); assert.equal(u.searchParams.get("query[bool][filter][1][term][department_id]"), "PC-10");
  assert.equal(u.searchParams.get("query[bool][filter][2][exists][field]"), "image_id"); assert.equal(u.searchParams.get("page"), "2"); assert.equal(u.searchParams.get("limit"), "5");
  assert.ok(r.data.results.every((x) => x.license.openAccess)); assert.equal(r.data.total, 2);
  mock(router()); const r2 = await call("oa_aic_search", { q: "x", openAccessOnly: false, hasImage: false });
  const u2 = new URL(calls[0].url); assert.equal([...u2.searchParams.keys()].some((k) => k.startsWith("query[")), false);
  assert.equal(r2.data.results.length, 2); assert.equal(r2.data.results[1].license.openAccess, false);
});
await t("aic: departments list, 404 mapped to NOT_FOUND", async () => {
  mock(router()); const d = await call("oa_aic_list_departments", {}); assert.deepEqual(d.data.departments[0], { departmentId: "PC-10", title: "Painting and Sculpture of Europe" });
  const n = await call("oa_aic_get_artwork", { id: "999999999" }); assert.equal(n.data.error.code, "NOT_FOUND");
});
await t("aic: allow-list permits only /iiif/2/ on www.artic.edu; AIC-User-Agent only sent to AIC hosts", async () => {
  mock(router());
  for (const u of ["https://www.artic.edu/artworks/27992", "https://www.artic.edu/", "https://artic.edu/iiif/2/x", "http://api.artic.edu/api/v1/artworks/1"]) await assert.rejects(() => M.httpGet(u), (e) => ["HOST_NOT_ALLOWED", "INVALID_URL"].includes(e.code), u);
  assert.equal(calls.length, 0);
  await M.httpGet("https://www.artic.edu/iiif/2/2d484387-2509-5e8e-2c43-22f9981972eb/full/843,/0/default.jpg", { accept: "image/*" });
  await M.getJson("https://collectionapi.metmuseum.org/public/collection/v1/departments");
  assert.ok(calls[0].init.headers["AIC-User-Agent"]); assert.equal(calls[1].init.headers["AIC-User-Agent"], undefined);
});
await t("aic: download writes open-access IIIF image + licence json", async () => {
  mock(router()); const dir = path.join(tmp, "aicdl");
  const r = await call("oa_download_image", { museum: "aic", id: "27992", directory: dir, confirm: true });
  assert.equal(r.isError, false, JSON.stringify(r.data)); assert.equal(r.data.written.length, 2); assert.ok(r.data.imageUrl.includes("/iiif/2/"));
});
await t("pacing: env overrides can only slow a museum down (AIC=50 still >= 1000 ms; slower values honoured)", () => {
  const k = "OPEN_ART_AIC_MIN_INTERVAL_MS", km = "OPEN_ART_MET_MIN_INTERVAL_MS";
  process.env[k] = "50"; assert.ok(M._envIntervalForTest("aic") >= 1000);
  process.env[k] = "0"; assert.ok(M._envIntervalForTest("aic") >= 1000);
  process.env[k] = "2500"; assert.equal(M._envIntervalForTest("aic"), 2500);
  process.env[k] = "999999"; assert.equal(M._envIntervalForTest("aic"), 60000);
  process.env[km] = "1"; assert.equal(M._envIntervalForTest("met"), M.MUSEUMS.met.minIntervalMs);
  delete process.env[k]; delete process.env[km]; assert.equal(M._envIntervalForTest("aic"), 1000);
});
await t("aic: IIIF paths with encoded separators/dots or '..' are refused before fetch", async () => {
  mock(router());
  const bad = ["/iiif/2/..%2f..%2f", "/iiif/2/..%2F..%2Fartworks", "/iiif/2/x%5cy", "/iiif/2/x%5Cy", "/iiif/2/%2e%2e/x", "/iiif/2/%2E%2E/x", "/iiif/2/a%2fb/full/843,/0/default.jpg", "/iiif/2/%zz"];
  for (const pth of bad) await assert.rejects(() => M.httpGet("https://www.artic.edu" + pth), (e) => e.code === "HOST_NOT_ALLOWED", pth);
  assert.equal(calls.length, 0);
});
await t("aic: pacing default respects documented 60 req/min (>= 1000 ms)", () => { assert.ok(M.MUSEUMS.aic.minIntervalMs >= 1000); assert.match(M.MUSEUMS.aic.documentedLimit, /60/); });

// ===== 10c. Rijksmuseum =======================================================
await t("rijks: get by LOD id normalizes live Linked Art; Public Domain Mark image rights -> open access; IIIF sizes", async () => {
  mock(router()); const r = await call("oa_rijks_get_object", { id: "200107928" });
  assert.equal(r.isError, false, JSON.stringify(r.data)); const x = r.data.result;
  assert.equal(x.museum, "rijks"); assert.equal(x.id, "200107928"); assert.equal(x.accessionNumber, "SK-C-5"); assert.equal(x.artist, "Rembrandt van Rijn"); assert.equal(x.date, "1642");
  assert.match(x.title, /^The Night Watch/); assert.equal(x.medium, "oil on canvas"); assert.equal(x.classification, "painting"); assert.equal(x.creditLine, "On loan from the City of Amsterdam");
  assert.equal(x.license.openAccess, true); assert.equal(x.license.status, "public-domain"); assert.match(x.license.rights, /publicdomain\/mark\/1\.0/);
  assert.equal(x.images.web, "https://iiif.micr.io/PJEZO/full/843,/0/default.jpg"); assert.equal(x.images.large, "https://iiif.micr.io/PJEZO/full/1686,/0/default.jpg");
  assert.match(x.url, /^https:\/\/www\.rijksmuseum\.nl\//);
});
await t("rijks: metadata CC0 is NOT image rights; InC image -> reference only; artist from creator text; download refused", async () => {
  mock(router()); const r = await call("oa_rijks_get_object", { id: "200496110" }); const x = r.data.result;
  assert.equal(x.license.openAccess, false); assert.equal(x.license.status, "restricted"); assert.match(x.license.rights, /rightsstatements\.org\/vocab\/InC/); assert.match(x.artist, /Karel Appel/);
  const b = await call("oa_best_image_url", { museum: "rijks", id: "200496110" }); assert.equal(b.data.url, null);
  const d = await call("oa_download_image", { museum: "rijks", id: "200496110", directory: path.join(tmp, "rjno"), confirm: true }); assert.equal(d.data.error.code, "NOT_OPEN_ACCESS");
});
await t("rijks: object number resolves through search objectNumber; unknown number -> NOT_FOUND", async () => {
  mock(router()); const r = await call("oa_rijks_get_object", { id: "SK-C-5" }); assert.equal(r.data.result.id, "200107928");
  assert.equal(new URL(calls[0].url).searchParams.get("objectNumber"), "SK-C-5"); assert.equal(calls[1].url, "https://id.rijksmuseum.nl/200107928");
  mock(router()); assert.equal((await call("oa_rijks_get_object", { id: "SK-X-999" })).data.error.code, "NOT_FOUND");
});
await t("rijks: search maps filters, hydrates limit ids, hides non-open, drops off-host ids, returns nextPageToken", async () => {
  mock(router()); const r = await call("oa_rijks_search", { title: "nachtwacht", creator: "Rembrandt", limit: 3 });
  assert.equal(r.isError, false, JSON.stringify(r.data)); const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get("title"), "nachtwacht"); assert.equal(u.searchParams.get("creator"), "Rembrandt"); assert.equal(u.searchParams.get("imageAvailable"), "true");
  assert.equal(r.data.pageIds, 2, "off-host id dropped"); assert.equal(r.data.results.length, 1); assert.equal(r.data.results[0].accessionNumber, "SK-C-5"); assert.ok(r.data.notes.some((n) => /hidden/.test(n)));
  assert.ok(r.data.nextPageToken); assert.ok(calls.every((c) => !c.url.includes("evil.example")));
  mock(router()); const r2 = await call("oa_rijks_search", { creator: "x", openAccessOnly: false, hasImage: false, limit: 2 }); assert.equal(r2.data.results.length, 2); assert.equal(new URL(calls[0].url).searchParams.get("imageAvailable"), null);
});
await t("rijks: allow-list paths and encoded-path checks", async () => {
  mock(router());
  for (const u of ["https://data.rijksmuseum.nl/docs/", "https://id.rijksmuseum.nl/..%2fx", "https://iiif.micr.io/A%2e%2e/x", "https://iiif.micr.io/a%5cb", "https://www.rijksmuseum.nl/x"]) await assert.rejects(() => M.httpGet(u), (e) => e.code === "HOST_NOT_ALLOWED", u);
  assert.equal(calls.length, 0);
});
await t("rijks: download writes open-access IIIF image", async () => {
  mock(router()); const r = await call("oa_download_image", { museum: "rijks", id: "SK-C-5", directory: path.join(tmp, "rjdl"), confirm: true });
  assert.equal(r.isError, false, JSON.stringify(r.data)); assert.equal(r.data.written.length, 2); assert.match(r.data.imageUrl, /iiif\.micr\.io\/PJEZO\/full\/843,/);
});

// ===== 10d. Openverse =========================================================
await t("openverse: CC BY-SA live result -> not open access, licence/URL/creator/attribution/requirement returned", () => {
  const x = M.normalizeOpenverse(OV_SEARCH.results[0]);
  assert.equal(x.license.openAccess, false); assert.equal(x.license.status, "cc-licensed"); assert.equal(x.license.reuse, "licence-conditions-apply");
  assert.equal(x.license.licenseCode, "by-sa"); assert.equal(x.license.licenseVersion, "2.0"); assert.equal(x.license.licenseUrl, "https://creativecommons.org/licenses/by-sa/2.0/");
  assert.equal(x.license.creator, "tony_donnelly"); assert.match(x.license.attribution, /licensed under CC BY-SA 2\.0/); assert.match(x.license.requirement, /attribution/); assert.match(x.license.requirement, /share alike/);
  assert.equal(x.images.web, OV_SEARCH.results[0].thumbnail); assert.equal(x.dimensions, "1024 × 768 px");
});
await t("openverse: only cc0 and pdm are open access (case-insensitive code); everything else is not", () => {
  assert.equal(M.normalizeOpenverse(ovCc0).license.status, "CC0"); assert.equal(M.normalizeOpenverse(ovPdm).license.status, "public-domain");
  assert.equal(M.normalizeOpenverse({ ...ovCc0, license: "CC0" }).license.openAccess, true);
  for (const l of ["by", "by-nc", "by-nd", "sampling+", "", undefined]) assert.equal(M.normalizeOpenverse({ ...ovCc0, license: l }).license.openAccess, false, String(l));
  assert.equal(M.normalizeOpenverse({ ...ovCc0, thumbnail: "https://evil.example/t.jpg" }).images.web, null);
});
await t("openverse: search defaults to license=cc0,pdm; openAccessOnly=false passes licenses through; anon page_size cap", async () => {
  mock(router()); const r = await call("oa_openverse_search", { q: "tulip" });
  const u = new URL(calls[0].url); assert.equal(u.searchParams.get("license"), "cc0,pdm"); assert.equal(u.searchParams.get("page_size"), "10");
  assert.ok(r.data.results.every((x) => x.license.openAccess && x.license.attribution));
  mock(router()); const r2 = await call("oa_openverse_search", { q: "tulip", openAccessOnly: false, licenses: ["by", "by-sa"], categories: ["digitized_artwork"] });
  const u2 = new URL(calls[0].url); assert.equal(u2.searchParams.get("license"), "by,by-sa"); assert.equal(u2.searchParams.get("category"), "digitized_artwork");
  assert.ok(r2.data.results.some((x) => !x.license.openAccess));
});
await t("openverse: get image; best_image_url gives thumbnail (web) or provider file (large); download uses thumb only", async () => {
  mock(router()); const g = await call("oa_openverse_get_image", { id: ovCc0.id }); assert.equal(g.data.result.license.openAccess, true);
  const b = await call("oa_best_image_url", { museum: "openverse", id: ovCc0.id, size: "web" }); assert.match(b.data.url, /api\.openverse\.org\/v1\/images\/.+\/thumb\/$/);
  const nb = await call("oa_best_image_url", { museum: "openverse", id: OV_SEARCH.results[0].id }); assert.equal(nb.data.url, null);
  const d = await call("oa_download_image", { museum: "openverse", id: ovCc0.id, directory: path.join(tmp, "ovdl"), confirm: true }); assert.equal(d.isError, false, JSON.stringify(d.data)); assert.equal(d.data.written.length, 2);
  const nd = await call("oa_download_image", { museum: "openverse", id: OV_SEARCH.results[0].id, directory: path.join(tmp, "ovno"), confirm: true }); assert.equal(nd.data.error.code, "NOT_OPEN_ACCESS");
  assert.equal((await call("oa_openverse_get_image", { id: "2cff3595-8168-440b-83ff-7a80b65dea42" })).data.error.code, "NOT_FOUND");
});
await t("openverse: only /v1/images/ on api.openverse.org; encoded paths refused; pacing >= 3000 ms and env cannot speed it up", async () => {
  mock(router());
  for (const u of ["https://api.openverse.org/v1/audio/", "https://api.openverse.org/v1/images/..%2f..%2fauth_tokens/", "https://live.staticflickr.com/x.jpg"]) await assert.rejects(() => M.httpGet(u), (e) => e.code === "HOST_NOT_ALLOWED", u);
  assert.equal(calls.length, 0); assert.ok(M.MUSEUMS.openverse.minIntervalMs >= 3000);
  process.env.OPEN_ART_OPENVERSE_MIN_INTERVAL_MS = "100"; assert.ok(M._envIntervalForTest("openverse") >= 3000);
  process.env.OPEN_ART_RIJKS_MIN_INTERVAL_MS = "50"; assert.ok(M._envIntervalForTest("rijks") >= 500);
  delete process.env.OPEN_ART_OPENVERSE_MIN_INTERVAL_MS; delete process.env.OPEN_ART_RIJKS_MIN_INTERVAL_MS;
});

// ===== 11. status ============================================================
await t("status: no network, reports caps and pacing", async () => {
  mock(router()); const r = await call("oa_status", {});
  assert.equal(calls.length, 0); assert.equal(r.data.caps.maxResponseBytes, 10485760); assert.equal(r.data.caps.httpTimeoutMs, 30000); assert.ok(r.data.museums.met.documentedLimit.includes("80")); assert.match(r.data.licencePolicy, /reference only/i);
});

globalThis.fetch = realFetch;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:", failures.join(" | ")); process.exit(1); }
