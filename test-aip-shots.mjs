import fs from "fs";
import puppeteer from "puppeteer-core";

const BASE = "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });
const fail = [];
function ok(cond, msg) { if (!cond) fail.push(msg); }

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function open(w, h, mobile) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.hidet = "0"; localStorage.apt = "G"; localStorage.aipsid = "0"; });
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof setApt === "function" && map && map.loaded && map.loaded(), { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 500));
  return page;
}

async function goApt(page, id, zoom = 12.2) {
  await page.evaluate((apt) => { APT_FLY = false; setApt(apt, { fly: false }); }, id);
  await page.waitForFunction((apt) => AIP_APT === apt && AIP && map.getSource("aip"), { timeout: 20000 }, id);
  await page.waitForFunction((apt) => HIST_APT === apt && HIST, { timeout: 20000 }, id).catch(() => {});
  await page.evaluate((apt, z) => {
    const h = AirportHubs.resolveApt(apt);
    map.jumpTo({ center: [h.lon, h.lat], zoom: z, bearing: 0, pitch: 0 });
    map.resize();
    if (typeof aipPaint === "function") aipPaint();
    if (typeof histPaint === "function") histPaint();
  }, id, zoom);
  await new Promise((r) => setTimeout(r, 800));
}

async function info(page) {
  return page.evaluate(() => {
    const src = map.getSource("aip") && map.getSource("aip")._data;
    const near = map.getSource("aipnear") && map.getSource("aipnear")._data;
    const vis = map.getLayer("aip-sid") && map.getLayoutProperty("aip-sid", "visibility");
    const aipp = (document.getElementById("aipp") || {}).innerText || "";
    const hpt = (document.getElementById("hpt") || {}).innerText || "";
    const sidnote = (document.getElementById("sidnote") || {}).innerText || "";
    const sidnotef = (document.getElementById("sidnotef") || {}).innerText || "";
    const aipsid = document.getElementById("aipsid");
    const aipname = document.getElementById("aipname");
    const feats = (src && src.features) || [];
    const hist = map.getSource("hist") && map.getSource("hist")._data;
    return {
      apt: APT,
      vis,
      nProc: feats.length,
      kinds: [...new Set(feats.map((f) => f.properties.kind))],
      nNear: ((near && near.features) || []).length,
      aipp,
      hpt,
      sidnote,
      sidnotef,
      toggleShown: !!(aipsid && aipsid.closest("label") && aipsid.closest("label").style.display !== "none"),
      nameToggleShown: !!(aipname && aipname.closest("label") && aipname.closest("label").style.display !== "none"),
      nameChecked: !!(aipname && aipname.checked),
      checked: !!(aipsid && aipsid.checked),
      identMode: AIP && AIP.ident_mode,
      nHist: ((hist && hist.features) || []).length,
      link: ((document.getElementById("aipp") || {}).innerHTML || "").includes("http")
    };
  });
}

async function shot(page, name) {
  await page.evaluate(() => { const el = document.getElementById("mw"); if (el) el.scrollIntoView({ block: "nearest" }); });
  await new Promise((r) => setTimeout(r, 250));
  const p = `${OUT}/${name}.png`;
  const el = await page.$("#mw");
  if (el) await el.screenshot({ path: p });
  else await page.screenshot({ path: p });
  return p;
}

const evidence = { utc: new Date().toISOString() };
const desk = await open(1280, 900, false);

await goApt(desk, "JFK", 11.6);
let jfk = await info(desk);
ok(jfk.apt === "JFK", "JFK overlay");
ok(jfk.toggleShown, "JFK shows SID/STAR toggle");
ok(jfk.nProc === 0 && jfk.vis === "none", "procedures off until toggle");
ok(/FAA CIFP|CIFP 261029|Not for navigation/i.test(jfk.aipp), `JFK panel ${jfk.aipp.slice(0, 180)}`);
evidence.jfkOff = jfk;
evidence.jfkOffShot = await shot(desk, "aip-jfk-off");

await desk.evaluate(() => { const el = document.getElementById("aipsid"); el.checked = true; localStorage.aipsid = "1"; aipPaint(); });
await new Promise((r) => setTimeout(r, 600));
jfk = await info(desk);
ok(jfk.nProc >= 4, `JFK procedures drawn ${jfk.nProc}`);
ok(jfk.kinds.includes("sid") && jfk.kinds.includes("star"), `JFK SID+STAR kinds ${jfk.kinds}`);
ok(jfk.vis === "visible", "aip-sid visible");
ok(/Not for navigation/i.test(jfk.aipp), "label not for navigation");
ok(!jfk.nameToggleShown, "JFK hides name-only toggle (CIFP ident is on)");
ok(/DEEZZ6|SKORR6|No match \/ vectored/i.test(jfk.hpt + jfk.aipp), `JFK ident stats ${jfk.hpt.slice(0, 240)}`);
ok(/estimated from ADS-B/i.test(jfk.hpt + jfk.aipp), "JFK ident estimated-from-track");
ok(/Kalman subsample/i.test(jfk.hpt + jfk.aipp), "JFK discloses Kalman subsample");
evidence.jfkOn = jfk;
evidence.jfkOnShot = await shot(desk, "aip-jfk-sidstar");
{
  const gp = await desk.$("#gp");
  if (gp) evidence.jfkPanel = await gp.screenshot({ path: `${OUT}/aip-jfk-panel.png` });
}
{
  const popped = await desk.evaluate(() => {
    const src = map.getSource("hist") && map.getSource("hist")._data;
    const feats = (src && src.features) || [];
    const f = feats.find((x) => /DEEZZ6|SKORR6/.test((x.properties && x.properties.ident) || "")) || feats[0];
    if (!f) return { ok: false };
    const c = f.geometry.coordinates[Math.min(2, f.geometry.coordinates.length - 1)];
    map.jumpTo({ center: c, zoom: Math.max(map.getZoom(), 11.8) });
    histIdentPopup([c[0], c[1]], f.properties, false);
    return { ok: true, ident: f.properties.ident, lab: f.properties.lab, c };
  });
  ok(popped.ok, "JFK hist popup opened");
  ok(/DEEZZ6|SKORR6|No match/i.test(popped.ident || ""), `popup ident ${popped.ident}`);
  await new Promise((r) => setTimeout(r, 700));
  evidence.jfkPopup = popped;
  evidence.jfkPopupShot = await shot(desk, "aip-jfk-ident-popup");
}
{
  const live = await desk.evaluate(() => {
    if (typeof AipIdent === "undefined" || !AIP || !AIP.procs) return { ok: false };
    const p = AIP.procs.find((x) => x.id === "DEEZZ6" && x.trans === "RW04L");
    if (!p) return { ok: false };
    const dense = [p.path[0].slice()];
    for (let i = 0; i < p.path.length - 1; i++) {
      const a = p.path[i], b = p.path[i + 1];
      for (let t = 1; t <= 8; t++) { const f = t / 8; dense.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]); }
    }
    const ident = AipIdent.identify(dense, AIP.procs, AIP.lat, AIP.lon, "sid", "04L");
    const sp = document.getElementById("sp");
    const spb = document.getElementById("spb");
    if (sp) sp.classList.add("on");
    if (spb) spb.innerHTML = sidStarPanelHtml(ident);
    return { ok: ident.status === "match" && ident.proc === "DEEZZ6", label: ident.label, html: (spb && spb.innerText) || "" };
  });
  ok(live.ok, `live ident DEEZZ6 ${live.label}`);
  ok(/Likely SID: DEEZZ6/i.test(live.html) && /estimated from ADS-B track, not the ATC clearance/i.test(live.html), `panel copy ${live.html.slice(0, 180)}`);
  evidence.jfkLive = live;
  const sp = await desk.$("#sp");
  if (sp) evidence.jfkLiveShot = await sp.screenshot({ path: `${OUT}/aip-jfk-ident-panel.png` });
  await desk.evaluate(() => { const sp = document.getElementById("sp"); if (sp) sp.classList.remove("on"); });
}

await goApt(desk, "LAX", 11.4);
await desk.evaluate(() => { setAipOn(true); });
await new Promise((r) => setTimeout(r, 500));
const lax = await info(desk);
ok(lax.nProc >= 4, `LAX procedures ${lax.nProc}`);
ok(lax.toggleShown, "LAX toggle");
evidence.lax = lax;
evidence.laxShot = await shot(desk, "aip-lax-sidstar");

await goApt(desk, "LHR", 12.1);
const lhr = await info(desk);
ok(lhr.apt === "LHR", "EGLL/LHR");
ok(!lhr.toggleShown, "EGLL hides SID/STAR toggle");
ok(lhr.nProc === 0, "EGLL does not redraw procedures");
ok(/not redrawn/i.test(lhr.aipp), "EGLL panel says not redrawn");
ok(/NATS|redistribute|AD 2/i.test(lhr.aipp), `EGLL cites NATS/AD 2: ${lhr.aipp.slice(0, 220)}`);
ok(/aurora\.nats\.co\.uk|AD 2/i.test(lhr.aipp) || lhr.link, "EGLL has official link");
ok(lhr.nameToggleShown, "EGLL shows name-only licence-restricted toggle");
ok(!lhr.nameChecked, "EGLL name-only default off");
ok(/not identified/i.test(lhr.aipp + lhr.hpt), "EGLL not identified");
ok(!/\bBPK\d|\bDET\d|\bMID\d|\bWOBUN/i.test(lhr.aipp + lhr.hpt), "EGLL does not invent SID names");
evidence.lhr = lhr;
evidence.egllShot = await shot(desk, "aip-egll-linkonly");
{
  const gp = await desk.$("#gp");
  if (gp) evidence.egllPanel = await gp.screenshot({ path: `${OUT}/aip-egll-panel.png` });
}
await desk.evaluate(() => { const el = document.getElementById("aipname"); el.checked = true; localStorage.aipname = "1"; aipPaint(); histPaint(); });
await new Promise((r) => setTimeout(r, 400));
const lhrOn = await info(desk);
ok(/licence-restricted/i.test(lhrOn.aipp + lhrOn.hpt) && /OurAirports|OpenAIP|NATS/i.test(lhrOn.aipp + lhrOn.hpt), `EGLL assessment ${(lhrOn.aipp + lhrOn.hpt).slice(0, 220)}`);
ok(/never fabricated|not assigned|not invented/i.test(lhrOn.aipp + lhrOn.hpt), "EGLL assessment says names not fabricated");
ok(!/\bBPK\d|\bDET\d|\bMID\d|\bWOBUN/i.test(lhrOn.aipp + lhrOn.hpt), "toggle-on still invents no EGLL SID names");
evidence.lhrNameOn = lhrOn;
{
  const gp = await desk.$("#gp");
  if (gp) evidence.egllNameOnPanel = await gp.screenshot({ path: `${OUT}/aip-egll-nameonly.png` });
}

await goApt(desk, "DOH", 12.3);
const doh = await info(desk);
ok(!doh.toggleShown && doh.nProc === 0, "DOH link-only, no geometry");
ok(/QCAA|AIM|AD 2/i.test(doh.aipp), `DOH panel ${doh.aipp.slice(0, 180)}`);
ok(/Doha SID\/STAR charts: official links only \(licence\)/i.test(doh.sidnote + doh.sidnotef), `DOH short note ${doh.sidnote||doh.sidnotef}`);
ok(!/personal, non-commercial/i.test(doh.aipp), "DOH panel is not the long QCAA legal blob");
evidence.doh = doh;
evidence.dohShot = await shot(desk, "aip-doh-linkonly");
{
  const gp = await desk.$("#gp");
  if (gp) evidence.dohPanel = await gp.screenshot({ path: `${OUT}/aip-doh-panel.png` });
}
await desk.close();

const mob = await open(390, 844, true);
await goApt(mob, "JFK", 11.8);
await mob.evaluate(() => { setAipOn(true); });
await new Promise((r) => setTimeout(r, 500));
const jfkM = await info(mob);
ok(jfkM.nProc >= 2, "mobile JFK procedures");
evidence.jfkMob = jfkM;
evidence.jfkMobShot = await shot(mob, "aip-jfk-iphone");
await goApt(mob, "LHR", 12.2);
const lhrM = await info(mob);
ok(lhrM.nProc === 0 && /not redrawn/i.test(lhrM.aipp), "mobile EGLL link-only");
evidence.lhrMob = lhrM;
evidence.egllMobShot = await shot(mob, "aip-egll-iphone");
{
  const gp = await mob.$("#gp");
  if (gp) evidence.egllMobPanel = await gp.screenshot({ path: `${OUT}/aip-egll-iphone-panel.png` });
}
await mob.close();
await browser.close();

fs.writeFileSync(`${OUT}/aip-sidstar-evidence.json`, JSON.stringify(evidence, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS", {
  jfk: { nProc: evidence.jfkOn.nProc, kinds: evidence.jfkOn.kinds, nNear: evidence.jfkOn.nNear, ident: (evidence.jfkLive && evidence.jfkLive.label) || "" },
  lax: { nProc: lax.nProc },
  lhr: { nProc: lhr.nProc, snippet: lhr.aipp.slice(0, 160) },
  doh: { nProc: doh.nProc }
});
