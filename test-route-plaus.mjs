#!/usr/bin/env node
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const rp = require("./public/route-plaus.js");

const fail = [];
function ok(cond, msg) {
  console.log((cond ? "PASS  " : "FAIL  ") + msg);
  if (!cond) fail.push(msg);
}

const AP = {
  BUD: { iata: "BUD", icao: "LHBP", city: "Budapest", lat: 47.42976, lon: 19.26109 },
  DOH: { iata: "DOH", icao: "OTHH", city: "Doha", lat: 25.27306, lon: 51.60806 },
  IAD: { iata: "IAD", icao: "KIAD", city: "Dulles", lat: 38.944, lon: -77.456 },
  JFK: { iata: "JFK", icao: "KJFK", city: "New York", lat: 40.639, lon: -73.779 },
  BOS: { iata: "BOS", icao: "KBOS", city: "Boston", lat: 42.362, lon: -71.008 },
  ORD: { iata: "ORD", icao: "KORD", city: "Chicago", lat: 41.979, lon: -87.905 },
  MAD: { iata: "MAD", icao: "LEMD", city: "Madrid", lat: 40.47193, lon: -3.56264 },
  BSL: { iata: "BSL", icao: "LFSB", city: "Bâle/Mulhouse", lat: 47.59, lon: 7.52917 },
  DXB: { iata: "DXB", icao: "OMDB", city: "Dubai", lat: 25.253, lon: 55.365 },
  LHR: { iata: "LHR", icao: "EGLL", city: "London", lat: 51.471, lon: -0.46 },
};
function od(o, d) {
  return { o: AP[o], d: AP[d], oi: o, di: d };
}

// Production sample 2026-11-09T08:21:35Z: QTR35P / 06a124 / A7-ANH over Iceland, heading 114°.
const ice = { lat: 65.07351, lon: -14.85008 };
const iceEast = { gs: 536, trk: 114, gnd: false, held: false };
const iceWest = { lat: 62.58293, lon: -23.64136 };
const iceWestOpt = { gs: 417, trk: 271, gnd: false, held: false };

const budDoh = rp.routePlausible(od("BUD", "DOH"), ice, iceEast);
ok(!budDoh.ok && budDoh.reason === "corridor", "BUD-DOH over Iceland is implausible (corridor) " + JSON.stringify(budDoh.geom && { xtd: +budDoh.geom.xtd.toFixed(0), along: +budDoh.geom.along.toFixed(2), route: +budDoh.geom.route.toFixed(0) }));

const iadDoh = rp.routePlausible(od("IAD", "DOH"), ice, iceEast);
ok(iadDoh.ok, "IAD-DOH over Iceland eastbound is plausible NAT " + JSON.stringify(iadDoh.geom && { xtd: +iadDoh.geom.xtd.toFixed(0), along: +iadDoh.geom.along.toFixed(2) }));

const dohIadEast = rp.routePlausible(od("DOH", "IAD"), ice, iceEast);
ok(!dohIadEast.ok && dohIadEast.reason === "heading", "DOH-IAD reverse over Iceland eastbound fails heading " + dohIadEast.reason);

const dohIadWest = rp.routePlausible(od("DOH", "IAD"), iceWest, iceWestOpt);
ok(dohIadWest.ok, "DOH-IAD over Iceland westbound is plausible NAT");

const madBsl = rp.routePlausible(od("MAD", "BSL"), iceWest, iceWestOpt);
ok(!madBsl.ok, "MAD-BSL over Iceland is implausible " + madBsl.reason);

for (const pair of [["IAD", "DOH"], ["JFK", "DOH"], ["BOS", "DOH"], ["ORD", "DOH"]]) {
  const r = rp.routePlausible(od(pair[0], pair[1]), ice, iceEast);
  ok(r.ok, `${pair[0]}-${pair[1]} over Iceland eastbound stays plausible`);
}

const pickedWrong = rp.pickRoute(od("BUD", "DOH"), null, ice, iceEast);
ok(pickedWrong.unverified && !pickedWrong.od, "adsbdb-only BUD-DOH over Iceland → unverified, no OD displayed");
ok(!pickedWrong.od, "does not invent IAD-DOH as a replacement");

const pickedHist = rp.pickRoute(od("BUD", "DOH"), { ...od("IAD", "DOH"), n: 12, tot: 12 }, ice, iceEast);
ok(pickedHist.od && pickedHist.od.oi === "IAD" && pickedHist.od.di === "DOH" && pickedHist.src === "history", "history IAD-DOH used when independently plausible and adsbdb is not");
ok(pickedHist.rejected.some((r) => r.pair === "BUD→DOH"), "rejected adsbdb pair is labelled");

const bothBad = rp.pickRoute(od("BUD", "DOH"), od("MAD", "BSL"), ice, iceEast);
ok(bothBad.unverified && !bothBad.od, "two implausible sources → unverified, no invented pair");

const disagreeOk = rp.pickRoute(od("IAD", "DOH"), od("JFK", "DOH"), ice, iceEast);
ok(disagreeOk.conflict && !disagreeOk.od, "two plausible disagreeing sources stay unavailable (no guess)");

const shortPos = { lat: 25.4, lon: 52.0 };
const short = rp.routePlausible(od("DOH", "DXB"), shortPos, { gs: 485, trk: 90, gnd: false, held: false });
ok(short.ok, "short DOH-DXB near origin remains plausible");

const heldDoh = rp.routePlausible(od("DOH", "LHR"), { lat: 25.273, lon: 51.608 }, { gs: 0, trk: 0, gnd: true, held: true });
ok(heldDoh.ok, "held at origin for DOH-LHR is plausible");

const heldArr = rp.routePlausible(od("BUD", "DOH"), { lat: 25.273, lon: 51.608 }, { gs: 0, trk: 0, gnd: true, held: true });
ok(heldArr.ok, "held at destination for BUD-DOH is plausible (arrived)");

const heldIce = rp.routePlausible(od("BUD", "DOH"), ice, { gs: 0, trk: 0, gnd: true, held: true });
ok(!heldIce.ok, "held over Iceland for BUD-DOH is still implausible");

const toffOk = rp.routePlausible(od("IAD", "DOH"), ice, { ...iceEast, takeoffLL: [38.95, -77.45] });
ok(toffOk.ok, "observed takeoff near IAD corroborates IAD-DOH");

const toffBad = rp.routePlausible(od("IAD", "DOH"), ice, { ...iceEast, takeoffLL: [25.27, 51.61] });
ok(!toffBad.ok && toffBad.reason === "takeoff", "observed takeoff near DOH rejects IAD-DOH origin");

const midCapture = rp.routePlausible(od("IAD", "DOH"), ice, { ...iceEast, takeoffLL: [55.0, -40.0] });
ok(midCapture.ok, "mid-ocean capture does not reject a plausible pair");

const polar = rp.routePlausible(od("DOH", "ORD"), iceWest, iceWestOpt);
ok(polar.ok, "DOH-ORD westbound over Iceland (polar/NAT) stays plausible");

if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
