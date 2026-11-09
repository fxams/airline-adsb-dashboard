#!/usr/bin/env node
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const fn = require("./public/flightno.js");

const fail = [];
function ok(cond, msg) {
  console.log((cond ? "PASS  " : "FAIL  ") + msg);
  if (!cond) fail.push(msg);
}

ok(fn.prefixConverted("QTR35P") === "QR35P", "QTR35P prefix spelling is QR35P");
ok(fn.prefixConverted("UAE81W") === "EK81W", "UAE81W prefix spelling is EK81W");
ok(fn.prefixConverted("QTR217") === "QR217", "QTR217 prefix spelling is QR217");
ok(fn.isPrefixConversion("QTR35P", "QR35P"), "QR35P is prefix conversion");
ok(!fn.isPrefixConversion("UAE81W", "EK255"), "EK255 is not prefix conversion of UAE81W");
ok(fn.looksMarketed("EK255") && fn.looksMarketed("QR1181") && fn.looksMarketed("QR7"), "ticket shapes");
ok(!fn.looksMarketed("35P") && !fn.looksMarketed("QTR35P"), "callsign remainder is not marketed");

const adsbdbAlpha = {
  callsign: "QTR62E",
  callsign_icao: "QTR62E",
  callsign_iata: "QR62E",
  origin: { iata_code: "DOH", icao_code: "OTHH" },
  destination: { iata_code: "AGP", icao_code: "LEMG" }
};
const ins = fn.inspectSources({ callsign: "QTR62E", records: [{ source: "adsbdb.com", payload: adsbdbAlpha, origin: adsbdbAlpha.origin, destination: adsbdbAlpha.destination }] });
ok(!ins.candidate, "adsbdb callsign_iata does not become a candidate " + JSON.stringify(ins.consulted));
ok(/callsign_iata/.test(JSON.stringify(ins.consulted)), "consulted log mentions callsign_iata");

const routeset = { callsign: "QTR62E", number: "62E", airline_code: "QTR" };
const ins2 = fn.inspectSources({ callsign: "QTR62E", records: [{ source: "adsb.im routeset", payload: routeset }] });
ok(!ins2.candidate, "routeset number 62E is rejected");

const explicit = {
  payload: { flight_number: "EK255", callsign: "UAE81W" },
  source: "mock-schedule",
  origin: { iata: "BCN" },
  destination: { iata: "MEX" }
};
const ins3 = fn.inspectSources({ callsign: "UAE81W", records: [explicit] });
ok(ins3.candidate && ins3.candidate.number === "EK255", "explicit flight_number EK255 is a candidate");

const routeOk = { od: { oi: "BCN", di: "MEX", o: { iata: "BCN", lat: 41.3, lon: 2.08 }, d: { iata: "MEX", lat: 19.4, lon: -99.07 } }, unverified: false, conflict: false };
const acc = fn.acceptMarketedFlight({ callsign: "UAE81W", lookup: ins3, route: routeOk });
ok(acc.found && acc.number === "EK255" && acc.source === "mock-schedule", "accepted when OD matches PR9 pair " + acc.note);

const routeBud = { od: { oi: "BUD", di: "DOH", o: { iata: "BUD" }, d: { iata: "DOH" } }, unverified: false, conflict: false };
const accBad = fn.acceptMarketedFlight({ callsign: "UAE81W", lookup: ins3, route: routeBud });
ok(!accBad.found, "rejected when candidate OD disagrees with displayed pair: " + accBad.note);

const unver = fn.acceptMarketedFlight({ callsign: "UAE81W", lookup: ins3, route: { od: null, unverified: true } });
ok(!unver.found, "unverified route does not show a number");

const prefixAsExplicit = fn.inspectSources({
  callsign: "QTR35P",
  records: [{ source: "bogus", payload: { flight_number: "QR35P" }, origin: { iata: "IAD" }, destination: { iata: "DOH" } }]
});
ok(!prefixAsExplicit.candidate, "explicit field that is only the alphanumeric prefix spelling is still rejected");

const numericExplicit = fn.inspectSources({
  callsign: "QTR217",
  records: [{ source: "mock-schedule", payload: { flight_number: "QR217" }, origin: { iata: "DOH" }, destination: { iata: "AMM" } }]
});
ok(numericExplicit.candidate && numericExplicit.candidate.number === "QR217", "explicit QR217 for numeric callsign QTR217 is allowed (not taken from callsign_iata)");
ok(!fn.inspectSources({
  callsign: "QTR217",
  records: [{ source: "adsbdb.com", payload: { callsign_iata: "QR217" }, origin: { iata: "DOH" }, destination: { iata: "AMM" } }]
}).candidate, "the same QR217 from callsign_iata is not a candidate");

ok(/adsbdb\.com/.test(fn.catalogNote(ins)) && /Flightradar24/.test(fn.catalogNote(ins)), "catalog lists researched sources");

if (fail.length) {
  console.error("FAILED", fail.length, fail);
  process.exit(1);
}
console.log("ok flightno unit tests");
