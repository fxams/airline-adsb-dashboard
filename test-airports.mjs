import assert from "assert";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const A = require("./public/airports.js");

const fail = [];
function ok(cond, msg) { if (!cond) fail.push(msg); }

ok(A.resolveApt("EGLL") && A.resolveApt("EGLL").id === "LHR", "EGLL alias → LHR");
ok(A.resolveApt("lhr").id === "LHR", "LHR case-insensitive");
ok(A.resolveApt("OTHH").id === "DOH", "OTHH → DOH");
ok(A.resolveApt("OMDB").id === "DXB", "OMDB → DXB");
ok(!A.resolveApt("XXXX"), "unknown ICAO rejected");
ok(!A.resolveApt(""), "empty rejected");
ok(A.PRESETS.includes("LHR") && A.PRESETS.includes("DOH") && A.PRESETS.includes("DXB"), "presets are DOH/DXB/LHR");

const lhr = A.resolveApt("EGLL");
ok(Math.abs(lhr.lat - 51.4706) < 0.01 && Math.abs(lhr.lon + 0.46194) < 0.01, "EGLL ARP in west London");
ok(lhr.icao === "EGLL" && lhr.iata === "LHR", "LHR hub carries ICAO EGLL");

const near = A.nearestApt(51.47, -0.46, 15);
ok(near && near.id === "LHR", "nearest to Heathrow ARP is LHR");
const none = A.nearestApt(0, 0, 15);
ok(!none, "mid-ocean is not a hub");
const doh = A.nearestApt(25.273, 51.608, 5);
ok(doh && doh.id === "DOH", "nearest to Hamad ARP is DOH");

ok(A.isSurface(true, 0, 0, 1), "on-ground inside 8 nm is surface");
ok(!A.isSurface(true, 0, 0, 12), "on-ground outside 8 nm is not surface");
ok(A.isSurface(false, 200, 30, 2), "low and slow inside 8 nm is surface");
ok(!A.isSurface(false, 3000, 220, 2), "approach altitude is not surface");
ok(A.POINT_NM === 40 && A.GND_NM === 8, "40 nm airborne / 8 nm surface");
ok(A.AUTO_ZOOM === 10.5 && A.AUTO_NM === 15, "auto overlay at zoom 10.5 within 15 nm");

const lgw = A.nearestApt(51.148, -0.19, 10);
ok(lgw && lgw.id === "LGW", "Gatwick is in the catalog for zoom-in (not a chrome preset)");
ok(!A.PRESETS.includes("LGW"), "LGW is not a top-bar preset");
ok(typeof A.merge === "function", "catalog can merge observed-history airports");
const nBefore = A.HUBS.length;
const added = A.merge([{ id: "PEN", icao: "WMKP", iata: "PEN", lat: 5.2971, lon: 100.277, name: "Penang" }]);
ok(added === 1 && A.resolveApt("WMKP") && A.resolveApt("WMKP").id === "PEN", "merge adds observed QTR airport PEN");
ok(A.merge([{ id: "PEN", icao: "WMKP", iata: "PEN", lat: 5.3, lon: 100.3 }]) === 0, "merge does not duplicate");
ok(A.HUBS.length === nBefore + 1, "merge grows catalog by one");
ok(!A.PRESETS.includes("PEN"), "merged airports are not chrome presets");

if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS", { nHubs: A.HUBS.length, presets: A.PRESETS, egll: A.resolveApt("EGLL").id });
