import puppeteer from "puppeteer-core";
import fs from "fs";

const BASE = "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });

const fail = [];
const evidence = { utc: new Date().toISOString() };
function ok(cond, msg) { if (!cond) fail.push(msg); }

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

const SEED = [
  ["abc123", "QTR1", "QTR", "B77W", 25.253, 55.365, 37000, 480, 270, "A7-ALX", 0, 2, 0],
  ["def456", "UAE2", "UAE", "A388", 25.261, 55.347, 0, 4, 90, "A6-EVN", 1, 3, 0],
  ["ghi789", "BAW9", "BAW", "B77W", 25.27, 55.33, 35000, 440, 180, "G-ZZZA", 0, 1, 0],
  ["jkl012", "QTR8", "QTR", "A359", 25.28, 51.61, 39000, 490, 310, "A7-ANB", 0, 4, 0]
];

async function open(w, h, { mobile = w <= 700, landscape = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({
    width: landscape ? h : w,
    height: landscape ? w : h,
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
  });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.hidet = "0"; });
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof select === "function" && map && map.getLayer && map.getLayer("live"), { timeout: 90000 });
  await page.evaluate((seed) => {
    if (!L) L = { at: null, ac: [], nm: {} };
    L.at = new Date().toISOString();
    L.ac = seed;
    L.nm = Object.assign({ QTR: "Qatar Airways", UAE: "Emirates", BAW: "British Airways" }, L.nm || {});
    if (typeof window.GND_AC !== "undefined") GND_AC = [["held1", "QTRH", "QTR", "B77W", 25.27, 51.61, 0, 0, "parked", 0, 1, "held", 40, "2026-11-09T00:00:00Z"]];
    if (typeof onPoll === "function") onPoll();
    else if (typeof drawLive === "function") drawLive();
  }, SEED);
  return page;
}

async function shot(page, name) {
  await page.evaluate(() => { const el = document.getElementById("mw"); if (el) el.scrollIntoView({ block: "nearest" }); });
  await new Promise((r) => setTimeout(r, 120));
  const p = `${OUT}/${name}.png`;
  const el = await page.$("#mw");
  if (el) await el.screenshot({ path: p });
  else await page.screenshot({ path: p, fullPage: false });
  return p;
}

function forceFallback(page) {
  return page.evaluate(() => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => false });
    Object.defineProperty(document, "webkitFullscreenEnabled", { configurable: true, get: () => false });
    HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error("ios"));
    if (typeof syncFS === "function") syncFS();
  });
}

async function clickable(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    const mw = document.getElementById("mw");
    if (mw) mw.scrollIntoView({ block: "start", inline: "nearest" });
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest" });
    const r = el && el.getBoundingClientRect();
    if (!r) return;
    const hdr = document.querySelector("header");
    const nav = document.getElementById("nav");
    let cover = 8;
    if (hdr) cover = Math.max(cover, hdr.getBoundingClientRect().bottom + 6);
    if (nav) {
      const nr = nav.getBoundingClientRect();
      if (nr.height > 1 && nr.bottom > 0) cover = Math.max(cover, nr.bottom + 6);
    }
    if (r.y < cover || r.bottom > innerHeight - 8) window.scrollBy(0, r.y - cover);
  }, sel);
  await new Promise((r) => setTimeout(r, 80));
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return { ok: false, why: "missing" };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.pointerEvents === "none" || r.width < 2 || r.height < 2) {
      return { ok: false, why: "hidden", r: { x: r.x, y: r.y, w: r.width, h: r.height } };
    }
    if (r.y < 0 || r.bottom > innerHeight || r.x < 0 || r.right > innerWidth) {
      return { ok: false, why: "offscreen", r: { x: r.x, y: r.y, w: r.width, h: r.height } };
    }
    const x = r.x + Math.min(r.width / 2, 22);
    const y = r.y + Math.min(r.height / 2, 22);
    const top = document.elementFromPoint(x, y);
    const hit = !!(top && (el === top || el.contains(top) || (top.closest && top.closest(s))));
    return { ok: hit, why: hit ? "hit" : (top && (top.id || top.className || top.tagName)), r: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }, sel);
}

async function filState(page) {
  return page.evaluate(() => {
    const mw = document.getElementById("mw");
    const mfl = document.getElementById("mfl");
    const fbtn = document.getElementById("fbtn");
    const filbar = document.getElementById("filbar");
    const filn = document.getElementById("filn");
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        vis: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 1 && r.height > 1 && cs.opacity !== "0",
        x: r.x, y: r.y, w: r.width, h: r.height, z: cs.zIndex,
        fs: parseFloat(cs.fontSize) || 0, bg: cs.backgroundColor, pad: cs.padding,
      };
    };
    const live = map.getSource("live");
    const data = (live && live._data) || { features: [] };
    return {
      inMw: !!(mw && mw.contains(mfl) && mw.contains(fbtn) && mw.contains(filn)),
      open: mfl.classList.contains("open"),
      expanded: fbtn.getAttribute("aria-expanded"),
      sel: typeof airSel === "function" ? airSel() : [...document.getElementById("mf").selectedOptions].map((o) => o.value),
      ty: document.getElementById("tyf").value,
      fbtn: box(fbtn),
      mfl: box(mfl),
      filbar: box(filbar),
      filn: box(filn),
      filnText: (filn && filn.textContent) || "",
      airOn: [...document.querySelectorAll("[data-mf].on")].map((b) => b.getAttribute("data-mf")),
      tyOn: [...document.querySelectorAll("[data-ty].on")].map((b) => b.getAttribute("data-ty")),
      als: data.features.map((f) => f.properties.a).sort(),
      tys: data.features.map((f) => f.properties.t),
      nLive: data.features.length,
      wxOpen: document.getElementById("wxdock") && document.getElementById("wxdock").classList.contains("open"),
      infoOpen: document.getElementById("infosheet") && !document.getElementById("infosheet").hidden,
      fs: !!(document.fullscreenElement === mw || document.webkitFullscreenElement === mw) || document.body.classList.contains("map-fs"),
      native: document.fullscreenElement === mw || document.webkitFullscreenElement === mw,
      fake: document.body.classList.contains("map-fs"),
      dragPan: map.dragPan && map.dragPan.isEnabled && map.dragPan.isEnabled(),
      cnt: (document.getElementById("cnt") && document.getElementById("cnt").textContent) || "",
    };
  });
}

function unique(arr) { return [...new Set(arr)]; }

async function exerciseFilters(page, tag, { useBar = false, fallback = false } = {}) {
  const out = {};
  await page.evaluate(() => { const el = document.getElementById("mw"); if (el) el.scrollIntoView({ block: "nearest" }); });
  await new Promise((r) => setTimeout(r, 80));
  out.start = await filState(page);
  ok(out.start.inMw, `${tag}: filter UI and counts live inside the map wrapper`);
  ok(out.start.fbtn && out.start.fbtn.vis, `${tag}: Filters button visible`);
  ok(out.start.fbtn.h >= 40 && out.start.fbtn.w >= 40, `${tag}: Filters tap target`);
  ok(out.start.sel.length === 0 && out.start.airOn.includes("all") && !out.start.airOn.includes("QTR"), `${tag}: default All airlines`);
  ok(/live in sample/i.test(out.start.filnText), `${tag}: All shows a concise sample total, not fleet`);
  ok(!/held|fleet/i.test(out.start.filnText), `${tag}: count text does not claim fleet or held`);
  ok(out.start.filn && out.start.filn.vis && out.start.filn.fs <= 12, `${tag}: left count is small text`);
  ok(!out.start.filn.pad || /^0px/.test(out.start.filn.pad), `${tag}: count is text only, not a padded card`);

  const fHit = await clickable(page, "#fbtn");
  ok(fHit.ok, `${tag}: Filters button is the top hit target (${fHit.why})`);
  await page.click("#fbtn");
  await new Promise((r) => setTimeout(r, 200));
  out.opened = await filState(page);
  ok(out.opened.open && out.opened.expanded === "true" && out.opened.mfl.vis, `${tag}: Filters sheet opens`);
  ok(out.opened.dragPan === false, `${tag}: map drag disabled while sheet open`);
  await shot(page, `filters-open-${tag}`);

  await page.click('#filair [data-mf="QTR"]');
  await new Promise((r) => setTimeout(r, 150));
  out.qtr = await filState(page);
  ok(out.qtr.sel.join() === "QTR" && out.qtr.airOn.includes("QTR") && !out.qtr.airOn.includes("all"), `${tag}: QTR chip leaves All`);
  ok(out.qtr.als.every((a) => a === "QTR") && out.qtr.als.length === 2, `${tag}: live source is QTR only`);
  ok(/^QTR 2$/m.test(out.qtr.filnText) && !/UAE/.test(out.qtr.filnText), `${tag}: left count is QTR 2`);

  await page.click('#filair [data-mf="UAE"]');
  await new Promise((r) => setTimeout(r, 150));
  out.both = await filState(page);
  ok(out.both.sel.includes("QTR") && out.both.sel.includes("UAE") && out.both.sel.length === 2, `${tag}: QTR+UAE multi-select union`);
  ok(unique(out.both.als).join() === "QTR,UAE" && out.both.nLive === 3, `${tag}: union shows QTR and UAE`);
  ok(/QTR 2/.test(out.both.filnText) && /UAE 1/.test(out.both.filnText), `${tag}: one count line per selected airline`);
  await shot(page, `filters-multi-${tag}`);

  await page.click('#filty [data-ty="B77W"]');
  await new Promise((r) => setTimeout(r, 150));
  out.ty = await filState(page);
  ok(out.ty.ty.toUpperCase() === "B77W" && out.ty.nLive === 1 && out.ty.als[0] === "QTR", `${tag}: type intersects airline union`);
  ok(/QTR 1/.test(out.ty.filnText) && /UAE 0/.test(out.ty.filnText), `${tag}: counts respect type filter including zero`);

  await page.click('#filty [data-ty=""]');
  await new Promise((r) => setTimeout(r, 120));
  await page.click('#filair [data-mf="QTR"]');
  await new Promise((r) => setTimeout(r, 150));
  out.desel = await filState(page);
  ok(out.desel.sel.join() === "UAE" && !out.desel.airOn.includes("QTR"), `${tag}: deselect QTR keeps UAE`);
  ok(out.desel.als.every((a) => a === "UAE") && /UAE 1/.test(out.desel.filnText) && !/QTR/.test(out.desel.filnText), `${tag}: after deselect, only UAE count`);

  await page.click("#mflx");
  await new Promise((r) => setTimeout(r, 150));
  out.closed = await filState(page);
  ok(!out.closed.open && out.closed.sel.join() === "UAE", `${tag}: close keeps airline selection`);
  ok(out.closed.dragPan !== false, `${tag}: map drag restored after close`);

  if (useBar) {
    ok(out.start.filbar && out.start.filbar.vis, `${tag}: airline chips on the map`);
    const chipHit = await clickable(page, '#filbar [data-mf="QTR"]');
    ok(chipHit.ok, `${tag}: QTR chip is tappable (${chipHit.why})`);
    await page.click('#filbar [data-mf="QTR"]');
    await new Promise((r) => setTimeout(r, 150));
    out.barAdd = await filState(page);
    ok(out.barAdd.sel.includes("QTR") && out.barAdd.sel.includes("UAE"), `${tag}: map chip adds QTR to UAE`);
    await page.click('#filbar [data-reset="1"]');
    await new Promise((r) => setTimeout(r, 150));
    out.reset = await filState(page);
    ok(out.reset.sel.length === 0 && out.reset.ty === "" && out.reset.airOn.includes("all"), `${tag}: Reset restores All airlines`);
    ok(/live in sample/i.test(out.reset.filnText), `${tag}: Reset restores sample total`);
  } else {
    await page.click("#fbtn");
    await new Promise((r) => setTimeout(r, 150));
    await page.click("#mfl .filreset");
    await new Promise((r) => setTimeout(r, 150));
    out.reset = await filState(page);
    ok(out.reset.sel.length === 0 && out.reset.ty === "", `${tag}: sheet Reset restores All`);
    if (out.reset.open) await page.click("#mflx");
  }

  await page.click("#fbtn");
  await new Promise((r) => setTimeout(r, 150));
  await page.click('#filair [data-mf="QTR"]');
  await page.click('#filair [data-mf="other"]');
  await new Promise((r) => setTimeout(r, 150));
  out.other = await filState(page);
  ok(out.other.sel.includes("QTR") && out.other.sel.includes("other"), `${tag}: QTR + Other union`);
  ok(out.other.als.includes("QTR") && out.other.als.includes("BAW") && !out.other.als.includes("UAE"), `${tag}: Other is non-QTR/UAE`);
  ok(/QTR 2/.test(out.other.filnText) && /Other 1/.test(out.other.filnText), `${tag}: Other count uses existing Other option`);

  await page.evaluate(() => {
    L.ac = L.ac.concat([["zzz9", "QTR9", "QTR", "B788", 26.1, 51.5, 33000, 470, 90, "A7-BAA", 0, 1, 0]]);
    if (typeof onPoll === "function") onPoll();
  });
  out.poll = await filState(page);
  ok(out.poll.sel.includes("QTR") && out.poll.sel.includes("other"), `${tag}: live refresh keeps multi-select`);
  ok(/QTR 3/.test(out.poll.filnText), `${tag}: counts refresh with the live sample`);
  ok(!/QTRH|held1/.test(out.poll.filnText), `${tag}: held ground records are not in the live count`);

  async function vis(sel) {
    return page.evaluate((s) => {
      const b = document.querySelector(s);
      if (!b) return false;
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight;
    }, sel);
  }
  async function tap(sel) {
    if (!(await vis(sel))) return false;
    await page.evaluate((s) => document.querySelector(s).click(), sel);
    return true;
  }
  if (await vis("#wxbtn")) {
    await tap("#fbtn");
    await new Promise((r) => setTimeout(r, 120));
    await tap("#wxbtn");
    await new Promise((r) => setTimeout(r, 200));
    out.wx = await filState(page);
    ok(!out.wx.open && out.wx.wxOpen, `${tag}: Weather closes Filters`);
    await tap("#wxbtn");
    await new Promise((r) => setTimeout(r, 120));
  }
  if (await vis("#infobtn")) {
    await tap("#fbtn");
    await new Promise((r) => setTimeout(r, 150));
    await tap("#infobtn");
    await new Promise((r) => setTimeout(r, 200));
    out.info = await filState(page);
    ok(!out.info.open && out.info.infoOpen, `${tag}: Info closes Filters`);
    if (!(await tap("#infox"))) await page.evaluate(() => { if (typeof closeSheets === "function") closeSheets(); });
    await new Promise((r) => setTimeout(r, 120));
  }

  if ((await filState(page)).open) {
    if (!(await tap("#mflx"))) await page.evaluate(() => { if (typeof closeFilters === "function") closeFilters(); });
  }
  const hex = await page.evaluate(() => (L.ac.find((a) => a[2] === "QTR") || L.ac[0])[0]);
  await page.evaluate((h) => select(h), hex);
  await page.waitForFunction(() => document.getElementById("sp").classList.contains("on"), { timeout: 20000 });
  out.panel = await page.evaluate(() => ({
    on: document.getElementById("sp").classList.contains("on"),
    inMw: document.getElementById("mw").contains(document.getElementById("sp")),
  }));
  ok(out.panel.on && out.panel.inMw, `${tag}: aircraft detail still in the map wrapper`);
  const nBox = await page.evaluate(() => {
    const n = document.getElementById("filn").getBoundingClientRect();
    const wx = document.getElementById("wxbtn") && document.getElementById("wxbtn").getBoundingClientRect();
    const zoom = document.querySelector(".maplibregl-ctrl-bottom-right") && document.querySelector(".maplibregl-ctrl-bottom-right").getBoundingClientRect();
    const overlap = (a, b) => a && b && a.width > 1 && b.width > 1 && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    return { vsWx: !!(wx && overlap(n, wx)), vsZoom: !!(zoom && overlap(n, zoom)), left: n.x < innerWidth * 0.45 };
  });
  ok(nBox.left && !nBox.vsWx && !nBox.vsZoom, `${tag}: counts stay on the left and clear of Weather/zoom`);
  await page.evaluate(() => { if (typeof unsel === "function") unsel(); });

  if (fallback) await forceFallback(page);
  await page.click("#mfsb");
  await new Promise((r) => setTimeout(r, 400));
  out.fs = await filState(page);
  ok(out.fs.fs && out.fs.inMw, `${tag}: fullscreen keeps filters and counts inside #mw`);
  const fsHit = await clickable(page, "#fbtn");
  ok(fsHit.ok, `${tag}: Filters clickable in fullscreen (${fsHit.why})`);
  await page.click("#fbtn");
  await new Promise((r) => setTimeout(r, 200));
  out.fsOpen = await filState(page);
  ok(out.fsOpen.open && out.fsOpen.mfl.vis, `${tag}: Filters sheet opens in fullscreen`);
  await page.click('#filair [data-mf="all"]');
  await new Promise((r) => setTimeout(r, 80));
  await page.click('#filair [data-mf="QTR"]');
  await page.click('#filair [data-mf="UAE"]');
  await new Promise((r) => setTimeout(r, 150));
  out.fsBoth = await filState(page);
  ok(out.fsBoth.sel.includes("QTR") && out.fsBoth.sel.includes("UAE"), `${tag}: multi-select in fullscreen`);
  ok(/QTR/.test(out.fsBoth.filnText) && /UAE/.test(out.fsBoth.filnText), `${tag}: counts update in fullscreen`);
  await shot(page, `filters-fs-${tag}`);
  await page.click("#mflx");
  await new Promise((r) => setTimeout(r, 120));
  if (out.fs.fake || out.fs.native) {
    await page.click("#mfsb");
    await new Promise((r) => setTimeout(r, 300));
  }
  out.afterFs = await filState(page);
  ok(!out.afterFs.fs && out.afterFs.sel.includes("QTR") && out.afterFs.sel.includes("UAE"), `${tag}: multi-select survives fullscreen exit`);
  await page.click("#fbtn");
  await new Promise((r) => setTimeout(r, 150));
  await page.click("#mfl .filreset");
  await new Promise((r) => setTimeout(r, 120));
  if ((await filState(page)).open) await page.click("#mflx");
  evidence[tag] = {
    sel: out.fsBoth && out.fsBoth.sel,
    counts: out.fsBoth && out.fsBoth.filnText,
    fs: { fake: out.fs.fake, native: out.fs.native },
    bar: !!(out.start.filbar && out.start.filbar.vis),
    fHit, fsHit,
  };
  return out;
}

const desk = await open(1280, 860, { mobile: false });
await exerciseFilters(desk, "desk-1280", { useBar: false });
await desk.close();

const fake = await open(1280, 860, { mobile: false });
await exerciseFilters(fake, "desk-fallback", { useBar: false, fallback: true });
await fake.close();

const m390 = await open(390, 844);
await exerciseFilters(m390, "mob-390", { useBar: true, fallback: true });
await m390.close();

const m320 = await open(320, 568);
await exerciseFilters(m320, "mob-320", { useBar: true, fallback: true });
await m320.close();

const m430 = await open(430, 932);
await exerciseFilters(m430, "mob-430", { useBar: true, fallback: true });
await m430.close();

const land = await open(390, 844, { landscape: true });
const landStart = await filState(land);
ok(landStart.fbtn && landStart.fbtn.vis, "landscape Filters button visible");
ok(landStart.inMw, "landscape filters and counts inside map wrapper");
await land.click("#fbtn");
await new Promise((r) => setTimeout(r, 200));
const landOpen = await filState(land);
ok(landOpen.open && landOpen.mfl.vis, "landscape Filters sheet opens");
await land.click('#filair [data-mf="QTR"]');
await land.click('#filair [data-mf="UAE"]');
await new Promise((r) => setTimeout(r, 150));
const landBoth = await filState(land);
ok(landBoth.sel.includes("QTR") && landBoth.sel.includes("UAE"), "landscape multi-select");
ok(/QTR 2/.test(landBoth.filnText) && /UAE 1/.test(landBoth.filnText), "landscape left counts");
await shot(land, "filters-open-land-390");
await land.click("#mflx");
await land.close();

await browser.close();
evidence.fail = fail;
fs.writeFileSync(OUT + "/map-filters-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ fail, evidence }, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
