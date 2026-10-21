// Small LIVE smoke test: read-only GETs against the five museum APIs plus Openverse through the real stdio server.
// Not part of the offline selftest because it needs the network.
// Run: node server/live-smoke.js            (GET-only)
//      node server/live-smoke.js --download (also downloads ONE open-access image into a temp dir, then deletes it)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const withDownload = process.argv.includes("--download");
const tmp = withDownload ? fs.mkdtempSync(path.join(os.tmpdir(), "oa-live-")) : null;

const calls = [
  ["met_search", "oa_met_search", { q: "sunflowers", departmentId: 11, limit: 3 }],
  ["met_get", "oa_met_get_object", { objectId: "436532" }],
  ["met_depts", "oa_met_list_departments", {}],
  ["cma_search", "oa_cleveland_search", { q: "monet", limit: 3 }],
  ["cma_get", "oa_cleveland_get_artwork", { id: "1958.39" }],
  ["vam_search", "oa_vam_search", { q: "poster", pageSize: 3 }],
  ["vam_get", "oa_vam_get_object", { systemNumber: "O9138" }],
  ["vam_colls", "oa_vam_list_collections", { limit: 5 }],
  ["all_oa", "oa_search_all", { q: "waterlily", limitPerMuseum: 3 }],
  ["all_ref", "oa_search_all", { q: "kimono", limitPerMuseum: 2, openAccessOnly: false }],
  ["best_met", "oa_best_image_url", { museum: "met", id: "436532" }],
  ["best_cma", "oa_best_image_url", { museum: "cleveland", id: "1958.39", size: "web" }],
  ["best_vam", "oa_best_image_url", { museum: "vam", id: "O9138", requireOpenAccess: false, size: "web" }],
  ["aic_search", "oa_aic_search", { q: "monet", limit: 3 }],
  ["aic_search_dept", "oa_aic_search", { q: "cat", departmentId: "PC-10", limit: 2 }],
  ["aic_get", "oa_aic_get_artwork", { id: "27992" }],
  ["aic_get_ref", "oa_aic_get_artwork", { id: "28067" }],
  ["aic_depts", "oa_aic_list_departments", {}],
  ["best_aic", "oa_best_image_url", { museum: "aic", id: "27992", size: "web" }],
  ["rijks_search", "oa_rijks_search", { title: "nachtwacht", creator: "Rembrandt", limit: 2 }],
  ["rijks_get", "oa_rijks_get_object", { id: "SK-C-5" }],
  ["rijks_get_ref", "oa_rijks_get_object", { id: "200496110" }],
  ["best_rijks", "oa_best_image_url", { museum: "rijks", id: "SK-C-5", size: "web" }],
  ["ov_search", "oa_openverse_search", { q: "sunflower", pageSize: 3 }],
  ["ov_search_ref", "oa_openverse_search", { q: "sunflower", pageSize: 2, openAccessOnly: false }],
];
if (withDownload) {
  calls.push(["download", "oa_download_image", { museum: "cleveland", id: "1958.39", directory: tmp, confirm: true, size: "web" }]);
  calls.push(["download_rijks", "oa_download_image", { museum: "rijks", id: "SK-C-5", directory: tmp, confirm: true, size: "web" }]);
}

const input = calls.map(([id, name, args], i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } })).join("\n") + "\n";
const child = spawn(process.execPath, [path.join(HERE, "index.js")], { stdio: ["pipe", "pipe", "inherit"], env: { PATH: process.env.PATH } });
const out = [];
child.stdout.on("data", (d) => out.push(d));
const timer = setTimeout(() => { child.kill("SIGKILL"); console.error("live smoke timed out"); process.exit(2); }, 420000);
await new Promise((res) => { child.on("close", res); child.stdin.end(input); });
clearTimeout(timer);
const msgs = Object.fromEntries(Buffer.concat(out).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((m) => [m.id, m]));
const R = {};
calls.forEach(([id], i) => { const m = msgs[i + 1]; assert.ok(m, `no response for ${id}`); R[id] = { isError: m.result?.isError, data: JSON.parse(m.result.content[0].text) }; });

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("ok  ", name); } catch (e) { fail++; console.log("FAIL", name, "\n    ", String(e.message).split("\n")[0]); } };
// Openverse: anonymous uncached queries were timing out upstream on 2026-10-20. A TIMEOUT / NETWORK_ERROR /
// RATE_LIMITED from Openverse is reported as SKIP (not pass) so the run stays honest about what was verified.
let skip = 0;
const ovUnavailable = (k) => R[k].isError && ["TIMEOUT", "NETWORK_ERROR", "RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "UPSTREAM_ERROR"].includes(R[k].data?.error?.code);
const tOv = (k, name, fn) => { if (ovUnavailable(k)) { skip++; console.log("SKIP", name, `(Openverse ${R[k].data.error.code})`); return; } t(name, fn); };
const ok = (k) => { assert.equal(R[k].isError, false, `${k}: ${JSON.stringify(R[k].data).slice(0, 300)}`); return R[k].data; };

t("Met /v1.1 search returns hydrated public-domain results", () => { const d = ok("met_search"); assert.ok(d.total > 0); assert.ok(d.results.length >= 1); assert.ok(d.results.every((r) => r.license.openAccess && r.images.large?.startsWith("https://images.metmuseum.org/"))); });
t("Met object 436532 is public domain with images", () => { const d = ok("met_get").result; assert.equal(d.license.status, "public-domain"); assert.ok(d.images.hasImage); assert.equal(d.artist, "Vincent van Gogh"); });
t("Met departments", () => assert.ok(ok("met_depts").departments.length >= 15));
t("Cleveland search returns CC0 works with print images", () => { const d = ok("cma_search"); assert.ok(d.total > 0); assert.ok(d.results.every((r) => r.license.status === "CC0" && r.images.large)); });
t("Cleveland get by accession number", () => { const d = ok("cma_get").result; assert.equal(d.accessionNumber, "1958.39"); assert.equal(d.license.openAccess, true); });
t("V&A search returns reference-only results with IIIF image URLs", () => { const d = ok("vam_search"); assert.ok(d.total > 0); assert.ok(d.results.every((r) => !r.license.openAccess && r.images.large?.startsWith("https://framemark.vam.ac.uk/"))); });
t("V&A object O9138", () => { const d = ok("vam_get").result; assert.equal(d.title, "Great Bed of Ware"); assert.equal(d.license.reuse, "reference-only"); });
t("V&A collections facet list", () => assert.ok(ok("vam_colls").terms.length >= 3));
t("search_all (default) is open-access only, V&A skipped (Openverse timeout tolerated, reported)", () => { const d = ok("all_oa"); assert.ok(d.skipped.vam); assert.ok(d.results.length >= 2); assert.ok(d.results.every((r) => r.license.openAccess)); const errs = Object.keys(d.errors).filter((m) => !(m === "openverse" && ["TIMEOUT", "NETWORK_ERROR", "RATE_LIMITED"].includes(d.errors[m].code))); assert.deepEqual(errs, [], JSON.stringify(d.errors)); });
t("search_all (openAccessOnly=false) fans out to all three museums", () => { const d = ok("all_ref"); const ms = new Set(d.results.map((r) => r.museum)); for (const m of ["met", "cleveland", "vam", "aic", "rijks"]) assert.ok(ms.has(m), `missing ${m}: ${[...ms].join()}`); const errs = Object.keys(d.errors).filter((m) => !(m === "openverse" && ["TIMEOUT", "NETWORK_ERROR", "RATE_LIMITED"].includes(d.errors[m].code))); assert.deepEqual(errs, [], JSON.stringify(d.errors)); if (d.errors.openverse) console.log("     note: Openverse in search_all:", d.errors.openverse.code); });
t("best_image_url returns open-access URLs; V&A needs requireOpenAccess=false", () => { assert.ok(ok("best_met").url.startsWith("https://images.metmuseum.org/")); assert.ok(ok("best_cma").url.startsWith("https://openaccess-cdn.clevelandart.org/")); assert.ok(ok("best_vam").url.includes("framemark.vam.ac.uk")); });

t("AIC search returns public-domain works with IIIF images", () => { const d = ok("aic_search"); assert.ok(d.total > 0); assert.ok(d.results.length >= 1); assert.ok(d.results.every((r) => r.license.openAccess && r.images.web?.startsWith("https://www.artic.edu/iiif/2/"))); });
t("AIC department filter (PC-10) returns that department only", () => { const d = ok("aic_search_dept"); assert.ok(d.results.length >= 1); assert.ok(d.results.every((r) => r.department === "Painting and Sculpture of Europe")); });
t("AIC 27992 (La Grande Jatte) is public domain", () => { const d = ok("aic_get").result; assert.equal(d.artist, "Georges Seurat"); assert.equal(d.license.openAccess, true); assert.ok(d.images.hasImage); });
t("AIC 28067 (Picasso) is reference only", () => { const d = ok("aic_get_ref").result; assert.equal(d.license.openAccess, false); assert.ok(d.license.rights); });
t("AIC departments", () => assert.ok(ok("aic_depts").departments.some((x) => x.departmentId === "PC-10")));
t("search_all (default) includes AIC and Rijksmuseum", () => { assert.ok(R.all_oa.data.perMuseum.aic); assert.ok(R.all_oa.data.perMuseum.rijks || R.all_oa.data.errors.rijks === undefined); });
t("Rijksmuseum search hydrates public-domain objects with IIIF images", () => { const d = ok("rijks_search"); assert.ok(d.total > 0); assert.ok(d.results.length >= 1); assert.ok(d.results.every((r) => r.license.openAccess && r.images.web?.startsWith("https://iiif.micr.io/"))); });
t("Rijksmuseum SK-C-5 (Night Watch) resolves by object number, Public Domain Mark", () => { const d = ok("rijks_get").result; assert.equal(d.accessionNumber, "SK-C-5"); assert.equal(d.artist, "Rembrandt van Rijn"); assert.equal(d.license.status, "public-domain"); });
t("Rijksmuseum 200496110 (Karel Appel print) is In Copyright -> reference only", () => { const d = ok("rijks_get_ref").result; assert.equal(d.license.openAccess, false); assert.match(d.license.rights, /InC/); });
tOv("ov_search", "Openverse open-access search returns only CC0/PDM with attribution", () => { const d = ok("ov_search"); assert.ok(d.results.length >= 1); assert.ok(d.results.every((r) => ["cc0", "pdm"].includes(r.license.licenseCode) && r.license.openAccess && r.license.attribution && r.license.licenseUrl)); });
tOv("ov_search_ref", "Openverse unfiltered search returns licence, URL, creator, attribution", () => { const d = ok("ov_search_ref"); assert.ok(d.results.length >= 1); assert.ok(d.results.every((r) => r.license.licenseCode && r.license.licenseUrl && "creator" in r.license && r.license.attribution)); });

// Image URLs actually serve images (Range GET of the first KB only).
const urls = { met: R.best_met.data.url, cma: R.best_cma.data.url, vam: R.best_vam.data.url, aic: R.best_aic.data.url, rijks: R.best_rijks.data.url };
for (const [k, u] of Object.entries(urls)) {
  try {
    const r = await fetch(u, { headers: { Range: "bytes=0-1023", "User-Agent": "open-art-mcp-live-smoke/0.3.0 (read-only)", "AIC-User-Agent": "open-art-mcp-live-smoke/0.3.0 (read-only)" } });
    t(`image URL serves an image (${k})`, () => { assert.ok([200, 206].includes(r.status), `HTTP ${r.status}`); assert.match(r.headers.get("content-type") || "", /^image\//); });
    await r.body?.cancel();
  } catch (e) { t(`image URL serves an image (${k})`, () => { throw e; }); }
}
// The retired Met endpoint really is gone (documents why we use /v1.1).
try {
  const r = await fetch("https://collectionapi.metmuseum.org/public/collection/v1/search?q=cat", { headers: { "User-Agent": "open-art-mcp-live-smoke/0.3.0 (read-only)" } });
  t("old Met /v1/search is retired (HTTP 410), confirming the /v1.1 choice", () => assert.equal(r.status, 410));
} catch (e) { t("old Met /v1/search check", () => { throw e; }); }

if (withDownload) {
  t("download wrote an image + license.json", () => { const d = ok("download"); assert.equal(d.written.length, 2); assert.ok(fs.statSync(d.written[0]).size > 1000); });
  t("Rijksmuseum download wrote an image + license.json", () => { const d = ok("download_rijks"); assert.equal(d.written.length, 2); assert.ok(fs.statSync(d.written[0]).size > 1000); });
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped (Openverse unavailable)` : ""}`);
process.exit(fail ? 1 : 0);
