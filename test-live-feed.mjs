#!/usr/bin/env node
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { LiveFeed, parseTypes, parseRetryAfter, backoffMs, feedBanner, DEFAULT_TYPES, TYPE_URL } = require("./live-feed");

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

function makeFeed(handler, extra = {}) {
  const calls = [];
  let t = 1_000_000;
  const sleeps = [];
  const feed = new LiveFeed({
    types: extra.types || ["A20N", "A35K"],
    timeoutMs: extra.timeoutMs || 1000,
    gapMs: extra.gapMs == null ? 100 : extra.gapMs,
    staleMs: extra.staleMs || 20 * 60e3,
    attempts: extra.attempts || 4,
    baseBackoffMs: extra.baseBackoffMs || 1500,
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
}

ok(parseRetryAfter("5") === 5000, "Retry-After seconds");
ok(parseRetryAfter("0.4") === 400, "Retry-After fractional seconds");
ok(backoffMs(0, 5000, 1500, 20000, () => 0) === 5000, "backoff honors Retry-After");
ok(backoffMs(0, null, 1500, 20000, () => 0) === 1500, "backoff attempt 0");
ok(backoffMs(2, null, 1500, 20000, () => 0) === 6000, "backoff attempt 2 exponential");
ok(feedBanner({ failed: [{ t: "A35K" }, { t: "B77W" }] }) === "2 type groups unavailable (A35K, B77W)", "feedBanner failed");
ok(feedBanner({ failed: [], stale: [{ t: "A388" }] }) === "1 type group stale (A388)", "feedBanner stale");
ok(feedBanner({ failed: [], stale: [] }) === "", "feedBanner empty");

{
  const { feed, calls } = makeFeed((url) => {
    const t = url.split("/").pop();
    if (t === "A20N") return jsonRes(200, { ac: [ac("aaa", "BAW1", "A20N")] });
    return jsonRes(200, { ac: [ac("qtr1", "QTR1", "A35K"), ac("qtr2", "QTR2", "A35K")] });
  });
  const { seen, feed: f } = await feed.refresh();
  ok(f.n_ok === 2 && f.n_failed === 0, "all ok " + JSON.stringify({ n_ok: f.n_ok, failed: f.failed }));
  ok(seen.size === 3, "collects both type groups n=" + seen.size);
  ok(calls.length === 2, "one fetch each when both succeed calls=" + calls.length);
  ok(calls[0].url === TYPE_URL("A20N"), "first type in list order");
}

{
  let n35 = 0;
  const { feed, calls, sleeps } = makeFeed((url) => {
    const t = url.split("/").pop();
    if (t === "A20N") return jsonRes(200, { ac: [ac("aaa", "BAW1", "A20N")] });
    n35++;
    if (n35 === 1) return jsonRes(429, { ac: [] }, { "Retry-After": "5" });
    return jsonRes(200, { ac: [ac("06a124", "QTR35P", "A35K")] });
  });
  const { seen, feed: f } = await feed.refresh();
  ok(f.ok.includes("A20N") && f.ok.includes("A35K") && f.n_failed === 0, "429 then success in pass 2 " + JSON.stringify(f.ok));
  ok(seen.has("06a124") && seen.has("aaa"), "partial first-pass failure does not drop A20N or recovered A35K");
  ok(n35 === 2, "A35K fetched twice (pass1 fail, pass2 ok) n=" + n35);
  ok(sleeps.some((ms) => ms >= 5000) || sleeps.reduce((a, b) => a + b, 0) >= 5000, "honors Retry-After 5s sleeps=" + sleeps.join(","));
  ok(calls.every((c) => c.opts && c.opts.headers["User-Agent"].includes("airline-adsb-dashboard")), "UA header set");
}

{
  const { feed } = makeFeed((url) => {
    const t = url.split("/").pop();
    if (t === "A20N") return jsonRes(200, { ac: [ac("aaa", "BAW1", "A20N")] });
    return jsonRes(429, { ac: [] });
  });
  const { seen, feed: f } = await feed.refresh();
  ok(f.failed.map((x) => x.t).join() === "A35K", "persistent 429 is in failed " + JSON.stringify(f.failed));
  ok(f.ok.join() === "A20N", "successful type still listed");
  ok(seen.has("aaa") && !seen.has("missing"), "A20N kept, A35K omitted when never cached n=" + seen.size);
  ok(f.failed[0].err.includes("429"), "failed err records status " + f.failed[0].err);
}

{
  const { feed } = makeFeed((url) => {
    const t = url.split("/").pop();
    if (t === "A20N") return jsonRes(200, { ac: [ac("aaa", "BAW1", "A20N")] });
    return jsonRes(200, { ac: [ac("qtr1", "QTR1", "A35K")] });
  });
  await feed.refresh();
  feed.fetchImpl = async (url) => {
    const t = url.split("/").pop();
    if (t === "A20N") return jsonRes(200, { ac: [ac("aaa", "BAW1", "A20N")] });
    return jsonRes(503, { ac: [] });
  };
  const { seen, feed: f } = await feed.refresh();
  ok(f.stale.map((x) => x.t).join() === "A35K", "last good A35K reused as stale " + JSON.stringify(f.stale));
  ok(seen.has("qtr1") && seen.has("aaa"), "stale A35K still in published set");
  ok(f.n_failed === 0, "stale is not failed");
}

{
  const { feed, advance } = makeFeed((url) => {
    const t = url.split("/").pop();
    if (t === "A20N") return jsonRes(200, { ac: [ac("aaa", "BAW1", "A20N")] });
    return jsonRes(200, { ac: [ac("qtr1", "QTR1", "A35K")] });
  }, { staleMs: 1000 });
  await feed.refresh();
  advance(5000);
  feed.fetchImpl = async (url) => {
    const t = url.split("/").pop();
    if (t === "A20N") return jsonRes(200, { ac: [ac("aaa", "BAW1", "A20N")] });
    return jsonRes(502, { ac: [] });
  };
  const { seen, feed: f } = await feed.refresh();
  ok(f.failed.map((x) => x.t).join() === "A35K", "expired lastT becomes failed " + JSON.stringify(f.failed));
  ok(seen.has("aaa") && !seen.has("qtr1"), "expired A35K not published");
}

{
  const { feed, calls } = makeFeed((url) => {
    const t = url.split("/").pop();
    if (t === "A20N") return jsonRes(200, { ac: [ac("aaa", "BAW1", "A20N")] });
    return jsonRes(429, { ac: [] });
  });
  await feed.refresh();
  const afterFirst = calls.length;
  await feed.refresh();
  const secondCycle = calls.slice(afterFirst).map((c) => c.url.split("/").pop());
  ok(secondCycle[0] === "A35K", "next cycle fetches previously failed type first " + secondCycle.join(","));
}

{
  let n = 0;
  const { feed } = makeFeed((url) => {
    n++;
    return jsonRes(404, { ac: [] });
  }, { types: ["ZZZZ"] });
  const { feed: f } = await feed.refresh();
  ok(n === 1, "404 is not retried on pass 2 n=" + n);
  ok(f.failed[0] && f.failed[0].err.includes("404"), "404 recorded");
}

{
  const { feed } = makeFeed(() => jsonRes(200, { ac: [] }), { types: ["C919"] });
  const { seen, feed: f } = await feed.refresh();
  ok(f.ok.join() === "C919" && seen.size === 0, "empty ac[] is success, not a dropped type");
}

{
  let n35 = 0;
  const { feed } = makeFeed((url) => {
    const t = url.split("/").pop();
    if (t === "A20N") return jsonRes(200, { ac: [ac("aaa", "BAW1", "A20N")] });
    n35++;
    if (n35 < 3) {
      const e = new Error("timeout");
      e.name = "TimeoutError";
      throw e;
    }
    return jsonRes(200, { ac: [ac("qtr1", "QTR1", "A35K")] });
  });
  const { seen, feed: f } = await feed.refresh();
  ok(f.ok.includes("A35K") && seen.has("qtr1"), "timeouts are retried then recovered n35=" + n35);
}

{
  const src = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
  ok(/\/api\/feed/.test(src), "server exposes /api/feed");
  ok(/liveFeed\.refresh/.test(src), "server refresh uses LiveFeed");
  ok(/scheduleRefresh/.test(src), "overlapping interval skip replaced by sequential schedule");
  ok(/REFRESH_MS - elapsed/.test(src), "next cycle wait accounts for cycle duration");
  ok(!/lastT\.set\(t/.test(src), "old lastT 5 min loop removed from server.js");
  const html = fs.readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  ok(/function feedNote\(f\)/.test(html), "header defines feedNote");
  ok(/L&&L\.feed/.test(html), "status reads L.feed");
  ok(/type group/.test(html), "copy mentions type groups");
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
    { at: "2026-11-09T08:31:36.522Z", ac: [], feed: { failed: [{ t: "A35K" }, { t: "B77W" }], stale: [], ok: ["A20N"] } },
    Date.now(),
    (id) => (id === "lst" ? lst : dot)
  );
  ok(/2 type groups unavailable \(A35K, B77W\)/.test(ui.text), "status line names failed type groups: " + ui.text);
  ok(ui.title.includes("A35K"), "lst title has failed types");
  const mapjs = fs.readFileSync(new URL("./public/map.js", import.meta.url), "utf8");
  ok(/feedNote\(L\.feed\)/.test(mapjs), "live count title uses feedNote");
}

console.error = origErr;
if (fail.length) {
  console.error("FAILED", fail.length, fail);
  process.exit(1);
}
console.log("ok", "live-feed tests passed");
