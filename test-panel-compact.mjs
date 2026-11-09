import puppeteer from "puppeteer-core";
import fs from "fs";

const BASE = "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });

const fail = [];
const evidence = { utc: new Date().toISOString() };
function ok(cond, msg) { if (!cond) fail.push(msg); }

const t0 = Date.parse("2026-11-09T01:00:00Z");
const climb = [
  [t0, 51.6, 25.2, 5000, 280, 1800, 0],
  [t0 + 120000, 51.7, 25.25, 12000, 340, 1400, 0],
  [t0 + 240000, 51.8, 25.3, 24000, 410, 900, 0],
  [t0 + 360000, 51.9, 25.35, 35000, 470, 200, 0],
  [t0 + 480000, 52.0, 25.4, 37000, 485, 0, 0],
];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function open(w, h, { mobile = w <= 700 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument((trk) => {
    localStorage.clear();
    localStorage.hidet = "0";
    const orig = window.fetch;
    window.fetch = function (url, opts) {
      const u = String(url);
      if (/\/api\/track(\?|$)/.test(u)) {
        return Promise.resolve(new Response(JSON.stringify({ hex: "abc123", points: trk }), { headers: { "Content-Type": "application/json" } }));
      }
      if (u.includes("/api/route")) {
        return Promise.resolve(new Response(JSON.stringify({
          found: true, origin: { iata: "DOH", icao: "OTHH", name: "Hamad International", city: "Doha", lat: 25.273, lon: 51.608 },
          destination: { iata: "DXB", icao: "OMDB", name: "Dubai International", city: "Dubai", lat: 25.253, lon: 55.365 },
          airline: { icao: "QTR", name: "Qatar Airways" }
        }), { headers: { "Content-Type": "application/json" } }));
      }
      return orig.apply(this, arguments);
    };
  }, climb);
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof select === "function" && map && map.getLayer && map.getLayer("live"), { timeout: 90000 });
  await page.evaluate(() => {
    L = L || { at: null, ac: [], nm: {} };
    L.at = "2026-11-09T01:08:00.000Z";
    L.ac = [["abc123", "QTR1", "QTR", "B77W", 25.4, 52.0, 37000, 485, 90, "A7-ALX", 0, 2, 0]];
    L.nm = { QTR: "Qatar Airways" };
    if (typeof drawLive === "function") drawLive();
  });
  await page.evaluate(() => { const el = document.getElementById("mw"); if (el) el.scrollIntoView({ block: "start" }); });
  return page;
}

async function shot(page, name) {
  const p = `${OUT}/${name}.png`;
  const el = await page.$("#sp") || await page.$("#mw");
  if (el) await el.screenshot({ path: p });
  else await page.screenshot({ path: p });
  return p;
}

function panelEval() {
  function visText(root) {
    const el = typeof root === "string" ? document.querySelector(root) : root;
    if (!el) return "";
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const cs = getComputedStyle(p);
        if (cs.display === "none" || cs.visibility === "hidden") return NodeFilter.FILTER_REJECT;
        const det = p.closest("details");
        if (det && !det.open && !p.closest("summary")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let t = "";
    while (w.nextNode()) t += w.currentNode.textContent + " ";
    return t.replace(/\s+/g, " ").trim();
  }
  const sp = document.getElementById("sp");
  const mu = [...document.querySelectorAll("#spb .spsec > p.mu")];
  const more = document.querySelector("#spmore details");
  const caveat = document.querySelector(".spcaveat");
  const field = (label) => {
    const cells = [...document.querySelectorAll("#spb .sc")];
    const hit = cells.find((c) => ((c.querySelector("span") || {}).textContent || "").trim() === label);
    return hit ? ((hit.querySelector("b") || {}).textContent || "").replace(/\s+/g, " ").trim() : null;
  };
  const noteDisp = mu.map((p) => getComputedStyle(p).display);
  const caveatDisp = caveat ? getComputedStyle(caveat).display : "missing";
  const moreDisp = document.getElementById("spmore") ? getComputedStyle(document.getElementById("spmore")).display : "missing";
  const bd = document.getElementById("spbd");
  return {
    on: sp.classList.contains("on"),
    min: sp.classList.contains("min"),
    vis: visText(sp),
    all: (sp.innerText || "").replace(/\s+/g, " "),
    flightNo: field("Flight number"),
    callsign: field("Callsign") || document.getElementById("spcs").textContent,
    schedDep: field("Scheduled departure"),
    schedArr: field("Scheduled arrival"),
    caveatDisp,
    moreOpen: !!(more && more.open),
    moreSummary: more && more.querySelector("summary") ? more.querySelector("summary").textContent.trim() : "",
    moreText: more ? more.innerText : "",
    noteDisp,
    moreDisp,
    spnDisp: document.getElementById("spn") ? getComputedStyle(document.getElementById("spn")).display : "missing",
    profpt: (document.getElementById("profpt") && document.getElementById("profpt").innerText) || "",
    pad: bd ? getComputedStyle(bd).padding : "",
    h: sp.getBoundingClientRect().height,
    vh: innerHeight,
    tags: [...document.querySelectorAll("#sp .tg")].map((t) => t.textContent.trim()),
    scrollH: bd ? bd.scrollHeight : 0,
    clientH: bd ? bd.clientHeight : 0,
    scrollTop: bd ? bd.scrollTop : 0,
  };
}

async function exercise(page, tag, { desktop = false } = {}) {
  await page.evaluate(() => select("abc123"));
  await page.waitForFunction(() => document.getElementById("sp").classList.contains("on") && document.getElementById("spb").innerHTML.length > 40, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 400));
  let st = await page.evaluate(panelEval);
  ok(st.on && !st.min, `${tag}: panel expanded by default`);
  ok(st.callsign === "QTR1", `${tag}: callsign shown`);
  ok(st.flightNo === "Unavailable", `${tag}: Flight number stays Unavailable`);
  ok(st.schedDep === "Unavailable" && st.schedArr === "Unavailable", `${tag}: scheduled times stay Unavailable`);
  ok(/Estimated|Observed|Unavailable|Held/.test(st.tags.join(" ")), `${tag}: terse status tags present`);
  ok(/Not for operational flight planning/i.test(st.all), `${tag}: safety caveat accessible`);
  ok(st.flightNo === "Unavailable" && !/\b(EK229|QR1181|flight QR\d+)\b/i.test(st.vis), `${tag}: does not fabricate a marketed flight number`);

  if (desktop) {
    ok(st.noteDisp.length && st.noteDisp.every((d) => d !== "none"), `${tag}: desktop keeps methodology paragraphs`);
    ok(st.moreDisp === "none" || !st.moreSummary, `${tag}: desktop does not use the compact Details control`);
    ok(/Callsign is the ADS-B transponder identity/i.test(st.vis), `${tag}: desktop identity note visible`);
    ok(/adsbdb|adsb\.lol/i.test(st.vis), `${tag}: desktop source attribution visible`);
  } else {
    ok(!st.noteDisp.length || st.noteDisp.every((d) => d === "none"), `${tag}: default view hides section methodology`);
    ok(st.spnDisp === "none", `${tag}: profile methodology note collapsed off the default view`);
    ok(st.caveatDisp === "block", `${tag}: one-line safety caveat remains`);
    ok(st.moreSummary === "Details / sources", `${tag}: Details / sources control present`);
    ok(!st.moreOpen, `${tag}: Details starts collapsed`);
    ok(!/Callsign is the ADS-B transponder identity/i.test(st.vis), `${tag}: long identity explanation not in default view`);
    ok(!/crowd-sourced|Codeshares are not resolved|ODbL/i.test(st.vis), `${tag}: reference paragraphs not in default view`);
    ok(st.h <= st.vh * 0.68, `${tag}: expanded panel stays compact vs viewport`);
    const padN = parseFloat(st.pad) || 99;
    ok(padN <= 12, `${tag}: reduced body padding (${st.pad})`);

    await page.evaluate(() => {
      const d = document.querySelector("#spmore details");
      if (d) d.open = true;
    });
    const open = await page.evaluate(panelEval);
    ok(/Callsign is the ADS-B transponder identity/i.test(open.vis), `${tag}: expanding Details restores identity methodology`);
    ok(/adsbdb|adsb\.lol|NOAA\/NWS/i.test(open.vis), `${tag}: expanding Details restores sources`);
    ok(/not a certified flight level/i.test(open.vis), `${tag}: FL caveat remains reachable`);
    await shot(page, `panel-details-${tag}`);

    await page.evaluate(() => {
      const d = document.querySelector("#spmore details");
      if (d) d.open = false;
    });

    const bd = await page.evaluate(() => {
      const el = document.getElementById("spbd");
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      return { before, after: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight };
    });
    ok(bd.sh > bd.ch - 2, `${tag}: summary body is scrollable or fits`);
    if (bd.sh > bd.ch + 8) ok(bd.after > bd.before, `${tag}: overflowing summary scrolls`);

    await page.click("#sph");
    await new Promise((r) => setTimeout(r, 150));
    const min = await page.evaluate(panelEval);
    ok(min.min, `${tag}: header collapses the summary`);
    ok(/Callsign QTR1/i.test(min.vis), `${tag}: collapsed header still shows identity`);
    ok(min.h < 170, `${tag}: collapsed summary is a short bar`);
    await shot(page, `panel-min-${tag}`);

    await page.click("#sph");
    await new Promise((r) => setTimeout(r, 150));
    const re = await page.evaluate(panelEval);
    ok(!re.min && re.on, `${tag}: expand restores the compact summary`);

    await page.waitForFunction(() => charts && charts.prof && typeof PROF_PTS !== "undefined" && PROF_PTS.length, { timeout: 20000 });
    await page.evaluate(() => { showProfPoint(PROF_PTS[2]); });
    const pt = await page.evaluate(() => document.getElementById("profpt").innerText);
    ok(/FL240/.test(pt) && /410 kt/.test(pt) && /\+900 ft\/min/.test(pt), `${tag}: chart point shows FL, speed and vertical speed`);
    ok(/Point/.test(pt) && !/avg 4/.test(pt), `${tag}: point values are not chart averages`);
    const ptMu = await page.evaluate(() => {
      const mu = document.querySelector("#profpt .mu");
      return mu ? getComputedStyle(mu).display : "missing";
    });
    ok(ptMu === "none", `${tag}: per-point methodology line hidden on mobile`);
  }

  await shot(page, `panel-default-${tag}`);

  const collide = await page.evaluate(async () => {
    const box = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (cs.display === "none" || r.width < 2 || r.height < 2) return null;
      return { x: r.x, y: r.y, w: r.width, h: r.height, z: cs.zIndex };
    };
    const overlap = (a, b) => a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const sp = box("sp");
    const fbtn = box("fbtn");
    const filbar = box("filbar");
    if (typeof closeFilters === "function") closeFilters();
    if (document.getElementById("wxdock")) document.getElementById("wxdock").classList.remove("open");
    const collapsed = document.getElementById("sp").classList.contains("min");
    if (!collapsed && document.getElementById("sph")) document.getElementById("sph").click();
    await new Promise((r) => setTimeout(r, 80));
    const wxbtn = box("wxbtn");
    const f2 = box("fbtn");
    if (typeof toggleFilters === "function") toggleFilters();
    else if (f2) document.getElementById("fbtn").click();
    await new Promise((r) => setTimeout(r, 120));
    const mfl = box("mfl");
    const f3 = box("fbtn");
    if (typeof closeFilters === "function") closeFilters();
    if (typeof toggleWx === "function") toggleWx();
    else if (document.getElementById("wxbtn")) document.getElementById("wxbtn").click();
    await new Promise((r) => setTimeout(r, 120));
    const wx = box("wxdock");
    const f4 = box("fbtn");
    return {
      panelVsFilters: overlap(sp, fbtn),
      collapsedWxVsFilters: overlap(wxbtn, f2),
      sheetVsFiltersBtn: overlap(mfl, f3),
      wxVsFilters: overlap(wx, f4),
      filbarVsFbtn: overlap(filbar, fbtn),
      fbtnVis: !!f3,
      mflVis: !!mfl,
      wxVis: !!wx,
    };
  });
  ok(!collide.panelVsFilters, `${tag}: expanded summary does not cover Filters`);
  ok(!collide.collapsedWxVsFilters, `${tag}: Weather control clear of Filters`);
  ok(!collide.filbarVsFbtn, `${tag}: airline chips do not cover Filters`);
  if (!desktop) {
    ok(collide.fbtnVis && collide.mflVis, `${tag}: Filters sheet still opens with the panel present`);
    ok(!collide.wxVsFilters, `${tag}: Weather sheet does not cover Filters`);
  }
  evidence[tag] = { h: st.h, vh: st.vh, flightNo: st.flightNo, tags: st.tags, collide, more: st.moreSummary };
}

const desk = await open(1280, 860, { mobile: false });
await exercise(desk, "desk-1280", { desktop: true });
await desk.close();

for (const [w, h, tag] of [[320, 568, "mob-320"], [390, 844, "mob-390"], [430, 932, "mob-430"]]) {
  const page = await open(w, h);
  await exercise(page, tag);
  await page.evaluate(() => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => false });
    HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error("ios"));
    if (typeof syncFS === "function") syncFS();
  });
  await page.click("#mfsb");
  await new Promise((r) => setTimeout(r, 400));
  const fs = await page.evaluate(() => {
    const box = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (cs.display === "none" || r.width < 2) return null;
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const overlap = (a, b) => a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    document.getElementById("sp").classList.remove("min");
    if (typeof closeFilters === "function") closeFilters();
    if (typeof toggleFilters === "function") toggleFilters();
    const sp = box("sp");
    const fbtn = box("fbtn");
    const mfl = box("mfl");
    return {
      fs: document.body.classList.contains("map-fs"),
      inMw: document.getElementById("mw").contains(document.getElementById("sp")) && document.getElementById("mw").contains(document.getElementById("mfl")),
      panelVsFilters: overlap(sp, fbtn),
      sheet: !!mfl,
      compact: sp && sp.h <= innerHeight * 0.7,
    };
  });
  ok(fs.fs && fs.inMw, `${tag}: fullscreen keeps summary and filters in the map`);
  ok(!fs.panelVsFilters, `${tag}: fullscreen summary does not cover Filters`);
  ok(fs.sheet, `${tag}: fullscreen Filters sheet still opens`);
  await shot(page, `panel-fs-${tag}`);
  await page.close();
}

await browser.close();
evidence.fail = fail;
fs.writeFileSync(OUT + "/panel-compact-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ fail, evidence }, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
