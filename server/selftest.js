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
    assert.equal(toolCount, 13);
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
  assert.equal(parseOut(out, "ndjson")[0].result.tools.length, 13);
});

// ===== 3. schemas ============================================================
await t("tools/list: 13 tools, strict schemas, annotations (readOnlyHint true on all but the download tool)", () => {
  const tools = M.listTools();
  assert.equal(tools.length, 13);
  const names = tools.map((x) => x.name);
  assert.equal(new Set(names).size, 13);
  for (const x of tools) {
    assert.match(x.name, /^oa_[a-z_]+$/);
    assert.equal(x.inputSchema.type, "object"); assert.equal(x.inputSchema.additionalProperties, false);
    assert.ok(x.description.length > 20);
    assert.equal(x.annotations.destructiveHint, false);
    if (x.name === "oa_download_image") { assert.equal(x.annotations.readOnlyHint, false); } else assert.equal(x.annotations.readOnlyHint, true, x.name);
    for (const r of x.inputSchema.required) assert.ok(x.inputSchema.properties[r], `${x.name}.${r}`);
  }
  for (const n of ["oa_search_all", "oa_best_image_url", "oa_met_search", "oa_cleveland_search", "oa_vam_search", "oa_met_get_object", "oa_cleveland_get_artwork", "oa_vam_get_object", "oa_met_list_departments", "oa_cleveland_list_departments", "oa_vam_list_collections", "oa_status", "oa_download_image"]) assert.ok(names.includes(n), n);
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
  for (const c of calls) { assert.equal(c.init.method, "GET"); assert.match(c.init.headers["User-Agent"], /^open-art-mcp\/0\.1\.0 \(/); assert.equal(c.init.body, undefined); }
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
  assert.deepEqual([...new Set(r.data.results.map((x) => x.museum))].sort(), ["cleveland", "met"]);
  assert.deepEqual(Object.keys(r.data.perMuseum).sort(), ["cleveland", "met"]);
});
await t("search_all: openAccessOnly=false includes V&A as reference-only, normalized shape identical across museums, interleaved", async () => {
  mock(router());
  const r = await call("oa_search_all", { q: "monet", openAccessOnly: false, hasImage: false });
  const keys = (x) => Object.keys(x).sort().join(",");
  const shapes = new Set(r.data.results.map(keys)); assert.equal(shapes.size, 1, "one normalized record shape");
  assert.deepEqual([...new Set(r.data.results.map((x) => x.museum))].sort(), ["cleveland", "met", "vam"]);
  assert.equal(new Set(r.data.results.slice(0, 3).map((x) => x.museum)).size, 3, "round-robin interleave");
  for (const x of r.data.results) { assert.ok(["met", "cleveland", "vam"].includes(x.museum)); assert.equal(typeof x.license.openAccess, "boolean"); assert.ok(x.license.label); assert.ok("rights" in x.license); assert.ok(x.license.termsUrl); assert.ok(x.images && "hasImage" in x.images); }
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
  assert.match(M.userAgent(), /open-art-mcp\/0\.1\.0 \(read-only MCP plugin/);
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

// ===== 11. status ============================================================
await t("status: no network, reports caps and pacing", async () => {
  mock(router()); const r = await call("oa_status", {});
  assert.equal(calls.length, 0); assert.equal(r.data.caps.maxResponseBytes, 10485760); assert.equal(r.data.caps.httpTimeoutMs, 30000); assert.ok(r.data.museums.met.documentedLimit.includes("80")); assert.match(r.data.licencePolicy, /reference only/i);
});

globalThis.fetch = realFetch;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:", failures.join(" | ")); process.exit(1); }
