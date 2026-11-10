#!/usr/bin/env node
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const {
  LiveFeed, parseTypes, parseRetryAfter, backoffMs, feedBanner, snapshotFresh, warmStartUrl,
  loadLiveSnapshotFile, generateTiles, filterAcBbox, DEFAULT_TYPES, TYPE_URL, PROVIDERS, MAX_RADIUS_NM
} = require("./live-feed");

const fail = [];
const origErr = console.error;
console.error = () => {};
function ok(cond, msg) {
  console.log((cond ? "PASS  " : "FAIL  ") + msg);
  if (!cond) fail.push(msg);
}

function jsonRes(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => {
        const key = Object.keys(headers).find((x) => x.toLowerCase() === String(k).toLowerCase());
        return key == null ? null : String(headers[key]);
      },
    },
    json: async () => body,
  };
}

function ac(hex, flight, t, extra = {}) {
  return { hex, flight, t, lat: 25.3, lon: 51.6, seen_pos: 1, alt_baro: 35000, gs: 480, track: 90, r: extra.r || "", ...extra };
}

const TILES = [
  { id: "doh", lat: 25.2731, lon: 51.6081, r: 250, pri: "hot", dueMs: 12000 },
  { id: "lhr", lat: 51.4706, lon: -0.46, r: 250, pri: "hub", dueMs: 35000 }
];

function lolOnly() {
  return [{ ...PROVIDERS[0], minIntervalMs: 0 }];
}

function makeFeed(handler, extra = {}) {
  const calls = [];
  let t = 1_000_000;
  const sleeps = [];
  const feed = new LiveFeed({
    tiles: extra.tiles || TILES,
    providers: extra.providers || lolOnly(),
    hubs: extra.hubs || [],
    globalFill: false,
    timeoutMs: extra.timeoutMs || 1000,
    gapMs: extra.gapMs == null ? 0 : extra.gapMs,
    staleMs: extra.staleMs || 20 * 60e3,
    attempts: extra.attempts || 4,
    baseBackoffMs: extra.baseBackoffMs || 1500,
    tickMs: extra.tickMs == null ? 60_000 : extra.tickMs,
    random: () => 0,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return handler(url, calls.length, calls);
    },
  });
  return { feed, calls, sleeps, clock: () => t, advance: (ms) => { t += ms; } };
}

{
  const types = parseTypes("A20N,A21N,A21N, a35k ,");
  ok(types.join(",") === "A20N,A21N,A35K", "parseTypes dedupes and uppercases " + types.join(","));
  const def = parseTypes("");
  ok(def[0] === "A35K" && def.includes("B77W") && def.includes("A388"), "default list leads with Gulf/widebody types");
  ok(def.filter((t) => t === "A21N").length === 1, "duplicate A21N removed");
  ok(def.length === new Set(def).size, "default types unique n=" + def.length);
  ok(DEFAULT_TYPES.split(",").includes("A321") && DEFAULT_TYPES.split(",").includes("A320"), "narrowbodies still listed");
  ok(TYPE_URL("A35K").includes("/v2/type/A35K"), "TYPE_URL still exported");
}

ok(parseRetryAfter("5") === 5000, "Retry-After seconds");
ok(parseRetryAfter("0.4") === 400, "Retry-After fractional seconds");
ok(backoffMs(0, 5000, 1500, 20000, () => 0) === 5000, "backoff honors Retry-After");
ok(backoffMs(0, null, 1500, 20000, () => 0) === 1500, "backoff attempt 0");
ok(backoffMs(2, null, 1500, 20000, () => 0) === 6000, "backoff attempt 2 exponential");
ok(feedBanner({ failed: [{ t: "doh" }, { t: "lhr" }] }) === "2 tiles unavailable (doh, lhr)", "feedBanner failed tiles");
ok(feedBanner({ kind: "type", failed: [{ t: "A35K" }, { t: "B77W" }] }) === "2 type groups unavailable (A35K, B77W)", "feedBanner type kind");
ok(feedBanner({ failed: [], stale: [{ t: "doh" }] }) === "1 tile stale (doh)", "feedBanner stale");
ok(feedBanner({ failed: [], stale: [] }) === "", "feedBanner empty");
ok(MAX_RADIUS_NM === 250, "point radius cap 250 nm");

{
  const tiles = generateTiles([{ id: "DOH", lat: 25.2731, lon: 51.6081 }, { id: "DXB", lat: 25.2528, lon: 55.3644 }, { id: "LHR", lat: 51.47, lon: -0.46 }], { globalFill: false });
  ok(tiles[0].id === "doh" && tiles.some((t) => t.id === "dxb"), "hot tiles include Doha and Dubai");
  ok(tiles.every((t) => t.r <= 250), "every generated tile respects 250 nm");
  ok(tiles.length >= 6 && tiles.length < 80, "hub+corridor tile count is modest n=" + tiles.length);
}
{
  const hubs = require("./public/airports.js").HUBS;
  const tiles = generateTiles(hubs);
  ok(tiles.length >= 40 && tiles.length <= 80, "full hub set stays a small tile count n=" + tiles.length);
  ok(tiles.filter((t) => t.pri === "hot").length === 6, "six hot tiles");
  ok(!tiles.some((t) => /^g-?\d/.test(t.id)), "no dense lat/lon mesh tiles");
}

{
  const { feed, calls } = makeFeed((url) => {
    if (url.includes("25.2731")) return jsonRes(200, { ac: [ac("qtr1", "QTR1", "A35K"), ac("qtr2", "QTR2", "A35K")] });
    return jsonRes(200, { ac: [ac("baw1", "BAW1", "A20N")] });
  });
  const { seen, feed: f } = await feed.refresh();
  ok(f.n_ok === 2 && f.n_failed === 0, "both tiles ok " + JSON.stringify({ n_ok: f.n_ok, failed: f.failed }));
  ok(seen.size === 3, "merges aircraft from both tiles n=" + seen.size);
  ok(calls.length === 2, "one fetch per tile calls=" + calls.length);
  ok(calls[0].url.includes("/v2/point/25.2731/51.6081/250"), "hot Doha tile first " + calls[0].url);
  ok(calls.every((c) => c.opts && c.opts.headers["User-Agent"].includes("airline-adsb-dashboard")), "UA header set");
  ok((f.sources || []).some((s) => s.home === "https://www.adsb.lol"), "sources list adsb.lol");
}

{
  const { feed, calls } = makeFeed((url) => {
    if (url.includes("25.2731")) return jsonRes(200, { ac: [ac("q1", "QTR1", "A35K", { seen_pos: 2 })] });
    return jsonRes(429, { ac: [] }, { "Retry-After": "5" });
  });
  const { seen, feed: f } = await feed.refresh();
  ok(seen.has("q1"), "successful Doha tile is kept through a 429 on LHR");
  ok(f.ok.includes("doh"), "doh listed ok");
  ok(calls.some((c) => c.url.includes("51.4706") || c.url.includes("51.47")), "LHR was attempted");
}

{
  const providers = [
    { ...PROVIDERS[0], minIntervalMs: 0 },
    { ...PROVIDERS[1], minIntervalMs: 0 }
  ];
  const { feed, calls } = makeFeed((url) => {
    if (url.includes("adsb.lol")) return jsonRes(429, { ac: [] });
    return jsonRes(200, { ac: [ac("q1", "QTR1", "A35K")] });
  }, { providers, tiles: [{ ...TILES[0], id: "x" }] });
  const { seen, feed: f } = await feed.refresh();
  ok(seen.has("q1"), "fails over from adsb.lol 429 to adsb.fi");
  ok(calls.some((c) => c.url.includes("adsb.lol")) && calls.some((c) => c.url.includes("adsb.fi")), "both providers attempted " + calls.map((c) => c.url).join(" | "));
  ok(f.providers.lol.r429 >= 1, "lol 429 counted");
  ok(f.providers.fi.ok >= 1, "fi success counted");
}

{
  const providers = [{ ...PROVIDERS[2], minIntervalMs: 0, circuit403Ms: 15 * 60e3 }];
  const { feed, calls } = makeFeed(() => jsonRes(403, { error: "contact" }), { providers, tiles: TILES, tickMs: 5000 });
  await feed.refresh();
  const st = feed.summary().providers.apl;
  ok(st.r403 >= 1 && st.open, "airplanes.live 403 opens circuit " + JSON.stringify(st));
  ok(calls.length === 1, "cooling circuit does not fail-storm remaining tiles calls=" + calls.length);
}

{
  const { feed, advance } = makeFeed(
    () => jsonRes(200, { ac: [ac("q1", "QTR1", "A35K", { seen_pos: 2 })] }),
    { tiles: [TILES[0]] }
  );
  await feed.refresh();
  advance(180000);
  const a = feed.collectAircraft().get("q1");
  ok(a && Math.abs(a._age - 182) < 2, "collectAircraft age includes tile lag after 180s " + (a && a._age));
}

{
  const { feed } = makeFeed(() => jsonRes(200, { ac: [] }), { tiles: [TILES[0], TILES[1]] });
  const at = feed.now();
  const seen = feed.hydrateFromRows([
    ["q1", "QTR1", "QTR", "A35K", 25.3, 51.6, 35000, 480, 90, "A7-X", 0, 1, 0],
    ["a1", "BAW1", "BAW", "A20N", 51.5, -0.4, 30000, 400, 80, "G-X", 0, 1, 0],
  ], at);
  ok(seen.has("q1") && seen.has("a1"), "hydrate last-good rows");
  const { seen: s2 } = await feed.refresh();
  ok(s2.has("q1") || s2.size >= 0, "refresh after hydrate does not throw");
}

{
  const { feed } = makeFeed(() => jsonRes(200, { ac: [ac("q1", "QTR1", "A35K")] }), { tiles: [TILES[0], TILES[1]] });
  await feed.refresh();
  const bumped = feed.noteViewport(25.3, 51.6);
  ok(bumped, "viewport bump accepted once");
  ok(!feed.noteViewport(25.3, 51.6), "second viewport bump within 20 s is ignored");
}

ok(snapshotFresh("2026-11-09T20:00:00Z", Date.parse("2026-11-09T20:05:00Z"), 20 * 60e3), "fresh snapshot within 20 min");
ok(!snapshotFresh("2026-11-09T19:00:00Z", Date.parse("2026-11-09T20:00:00Z"), 20 * 60e3), "stale snapshot older than 20 min rejected");
ok(warmStartUrl({ RENDER_EXTERNAL_URL: "https://airline-adsb-dashboard.onrender.com" }) === "https://airline-adsb-dashboard.onrender.com", "warm-start uses Render public URL");
ok(warmStartUrl({ LIVE_WARM: "0", RENDER_EXTERNAL_URL: "https://airline-adsb-dashboard.onrender.com" }) === "", "LIVE_WARM=0 disables URL warm-start");
ok(warmStartUrl({ LIVE_WARM_URL: "http://127.0.0.1:10000" }) === "", "loopback warm-start URL rejected");
{
  const now = Date.parse("2026-11-09T20:10:00Z");
  const j = loadLiveSnapshotFile({
    readFileSync: () => JSON.stringify({ at: "2026-11-09T20:08:00Z", ac: [["q1", "QTR1", "QTR", "A35K", 25, 51, 35000, 480, 90, "A7-X", 0, 1, 0]] }),
  }, "/tmp/x", now, 20 * 60e3);
  ok(j && j.ac.length === 1, "disk snapshot loaded when fresh");
  const old = loadLiveSnapshotFile({
    readFileSync: () => JSON.stringify({ at: "2026-11-09T19:00:00Z", ac: [["q1", "QTR1", "QTR", "A35K", 25, 51, 35000, 480, 90, "A7-X", 0, 1, 0]] }),
  }, "/tmp/x", now, 20 * 60e3);
  ok(old == null, "disk snapshot skipped when stale");
}

{
  const rows = [
    ["a", "QTR1", "QTR", "A35K", 25, 51, 35000, 480, 90, "X", 0, 1, 0],
    ["b", "BAW1", "BAW", "A20N", 51, -1, 30000, 400, 80, "Y", 0, 1, 0]
  ];
  ok(filterAcBbox(rows, 40, 20, 60, 30).map((r) => r[0]).join() === "a", "bbox keeps Gulf, drops LHR");
  ok(filterAcBbox(rows, 170, -10, -170, 10).length === 0, "antimeridian bbox with no hits");
}

{
  const src = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
  ok(/\/api\/feed/.test(src), "server exposes /api/feed");
  ok(/\/api\/live\/view/.test(src), "server exposes /api/live/view");
  ok(/liveFeed\.refresh/.test(src), "server refresh uses LiveFeed");
  ok(/publishFromSeen/.test(src), "server publishes from each progress callback");
  ok(/warmStart/.test(src) && /LIVE_SNAP_PATH/.test(src), "warm-start from disk snapshot or previous instance");
  ok(/listen\(PORT, "0\.0\.0\.0"/.test(src), "HTTP server binds 0.0.0.0");
  ok(/await warmStart/.test(src) && /server\.listen/.test(src), "warm-start runs before listen");
  ok(/scheduleRefresh/.test(src), "overlapping interval skip replaced by sequential schedule");
  ok(/nextWaitMs/.test(src), "next cycle wait uses provider/tile token buckets");
  ok(/REFRESH_SECONDS \|\| 90/.test(src), "REFRESH_SECONDS still names the global-tile target");
  ok(/TILE_HUBS/.test(src) && /hubs: TILE_HUBS/.test(src), "live tiles use core hubs, not hist-merged airports");
  ok(!/lastT\.set\(t/.test(src), "old lastT 5 min loop removed from server.js");
  const html = fs.readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  ok(/function feedNote\(f\)/.test(html), "header defines feedNote");
  ok(/L&&L\.feed/.test(html), "status reads L.feed");
  ok(/250 nm/.test(html) && /adsb\.fi/.test(html), "copy mentions 250 nm tiles and adsb.fi");
  ok(/Live ADS-B attribution/.test(html) && /opendatacommons\.org\/licenses\/odbl/.test(html), "method lists required live-source attribution");
  const mapjs = fs.readFileSync(new URL("./public/map.js", import.meta.url), "utf8");
  ok(/customAttribution/.test(mapjs) && /adsb\.fi/.test(mapjs), "map attribution control cites live sources");
  ok(/\/api\/live\/view/.test(mapjs), "map moveend pings viewport endpoint (server-throttled)");
  ok(/id="liveload"/.test(html) && /Loading live data…/.test(html), "empty map shows Loading live data");
  ok(/function liveLoading\(/.test(mapjs) && /syncLiveLoad/.test(mapjs), "map hides loading overlay once aircraft arrive");
  const m = html.match(/function feedNote\(f\)\{[^]*?return""\}/);
  ok(!!m, "extracted feedNote from index.html");
  const st = html.match(/function status\(\)\{[^]*?title=note\|\|""\}/);
  ok(!!st, "extracted status() from index.html");
  const lst = { textContent: "", title: "" }, dot = { className: "" };
  const ui = new Function(
    "L",
    "lastOk",
    "$",
    m[0] + "\n" + st[0] + "\nstatus();\nreturn { text: $(\"lst\").textContent, title: $(\"lst\").title, cls: $(\"dot\").className };"
  )(
    { at: "2026-11-09T08:31:36.522Z", ac: [], feed: { kind: "tile", failed: [{ t: "doh" }, { t: "lhr" }], stale: [], ok: ["jfk"] } },
    Date.now(),
    (id) => (id === "lst" ? lst : dot)
  );
  ok(/2 tiles unavailable \(doh, lhr\)/.test(ui.text), "status line names failed tiles: " + ui.text);
  ok(ui.title.includes("doh"), "lst title has failed tiles");
  ok(/feedNote\(L\.feed\)/.test(mapjs), "live count title uses feedNote");
  const loadUi = { textContent: "", title: "" }, loadDot = { className: "" };
  const waiting = new Function(
    "L",
    "lastOk",
    "$",
    m[0] + "\n" + st[0] + "\nstatus();\nreturn { text: $(\"lst\").textContent };"
  )(null, 0, (id) => (id === "lst" ? loadUi : loadDot));
  ok(waiting.text === "Loading live data…", "status with no snapshot says Loading live data…: " + waiting.text);
}

console.error = origErr;
if (fail.length) {
  console.error("FAILED", fail.length, fail);
  process.exit(1);
}
console.log("ok", "live-feed tests passed");
