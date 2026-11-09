// Marketed/ticketed passenger flight numbers vs ADS-B ATC callsigns.
// A number is shown only when a connected source has an explicit marketed field
// AND that number is consistent with the PR9 plausibility-checked city pair.
// Never derive by ICAO→IATA prefix conversion. Never treat callsign_iata or a
// callsign remainder as a ticket. Codeshares are not resolved.
(function (root) {
  const ICAO_TO_IATA = {
    QTR: "QR", UAE: "EK", ETD: "EY", BAW: "BA", AAL: "AA", DAL: "DL", UAL: "UA",
    DLH: "LH", AFR: "AF", KLM: "KL", VIR: "VS", SIA: "SQ", CPA: "CX", QFA: "QF",
    THY: "TK", SVA: "SV", MSR: "MS", ACA: "AC", ANA: "NH", JAL: "JL", KAL: "KE",
    CSN: "CZ", CES: "MU", CCA: "CA", ANZ: "NZ", FIN: "AY", SAS: "SK", SWR: "LX",
    AUA: "OS", IBE: "IB", AZA: "AZ", TAP: "TP", EIN: "EI", RYR: "FR", SWA: "WN",
    JBU: "B6", ASA: "AS", NKS: "NK", FFT: "F9", HAL: "HA", AMX: "AM", LAN: "LA",
    AVA: "AV", CMP: "CM", ARG: "AR", GLO: "G3", AZU: "AD", AIC: "AI", MAS: "MH",
    GIA: "GA", PAL: "PR", VOZ: "VA", AXM: "AK", JST: "JQ", SAA: "SA", ETH: "ET",
    KQA: "KQ", RAM: "AT", GFA: "GF", OMA: "WY", RJA: "RJ", MEA: "ME", KAC: "KU",
    PIA: "PK", ALK: "UL", THA: "TG", HVN: "VN", AAR: "OZ", EVA: "BR", CAL: "CI",
    CHH: "HU", ELY: "LY", NAX: "DY", WZZ: "W6", VLG: "VY", AEE: "A3", LOT: "LO",
    ROT: "RO", BTI: "BT", ICE: "FI", PGT: "PC", AFL: "SU", SBI: "S7", SVR: "U6",
    WJA: "WS", TSC: "TS", FJI: "FJ", CTN: "OU", CSA: "OK", BEL: "SN", EZY: "U2"
  };

  const EXPLICIT_KEYS = ["flight_number", "marketed_flight_number", "ticketed_flight_number", "iata_flight", "iataNumber", "flightIata", "marketed"];
  const FORBIDDEN_KEYS = ["callsign_iata", "callsignIata", "callsign_icao", "callsign"];

  const RESEARCHED = [
    { source: "adsbdb.com", queried: true, note: "Queried by ADS-B callsign. Has callsign_iata (IATA spelling of the same radio callsign), not a marketed ticket number." },
    { source: "hexdb.io /v2/routes", queried: false, note: "Origin/destination only. No marketed flight_number field. Not queried live (no qualifying field)." },
    { source: "adsb.im /api/0/routeset", queried: false, note: "Field number is the callsign remainder (QTR62E → 62E), not a ticketed IATA number. Not queried live." },
    { source: "OpenSky Network", queried: false, note: "API documents that it does not provide commercial flight numbers or schedules." },
    { source: "VRS standing-data (CC0)", queried: false, note: "Number is the number portion of the normalised ATC callsign, not a marketed ticket." },
    { source: "FlightAware AeroAPI", queried: false, note: "Not connected. Personal edition forbids public situational displays and requires a key." },
    { source: "Dubai Pulse FIDS", queried: false, note: "Open dataset includes registration + IATA flightnumber, but the API returns 401 without a granted key." },
    { source: "Qatar Open Data / airline status pages", queried: false, note: "Aggregates or booking forms. No parseable first-party callsign→ticket feed." },
    { source: "Flightradar24 / FlightStats", queried: false, note: "Not connected (ToS). Pages may be viewed for verification only, never as a product feed." }
  ];

  function norm(s) {
    return String(s || "").toUpperCase().replace(/[\s\-]/g, "");
  }

  function splitCallsign(cs) {
    const s = norm(cs);
    const m = s.match(/^([A-Z]{3})([0-9A-Z]+)$/) || s.match(/^([A-Z][A-Z0-9])([0-9A-Z]+)$/);
    if (!m) return null;
    return { code: m[1], rest: m[2], full: s };
  }

  function prefixConverted(cs) {
    const p = splitCallsign(cs);
    if (!p) return null;
    const iata = ICAO_TO_IATA[p.code];
    if (!iata) return null;
    return iata + p.rest;
  }

  function restHasLetter(cs) {
    const p = splitCallsign(cs);
    return !!(p && /[A-Z]/.test(p.rest));
  }

  function looksMarketed(s) {
    const n = norm(s);
    // IATA airline (letter+alnum) + 1–4 digits + optional one letter (UA123A).
    return /^[A-Z][A-Z0-9]\d{1,4}[A-Z]?$/.test(n);
  }

  function isPrefixConversion(cs, candidate) {
    const conv = prefixConverted(cs);
    return !!(conv && norm(candidate) === conv);
  }

  function pickExplicit(payload) {
    if (!payload || typeof payload !== "object") return null;
    for (const k of EXPLICIT_KEYS) {
      if (payload[k] == null || payload[k] === "") continue;
      if (typeof payload[k] === "object") continue;
      return { key: k, value: norm(payload[k]) };
    }
    if (payload.flight && typeof payload.flight === "object") {
      for (const k of ["iataNumber", "iata", "number"]) {
        if (k === "number") continue; // ambiguous: often the callsign remainder
        if (payload.flight[k]) return { key: "flight." + k, value: norm(payload.flight[k]) };
      }
    }
    return null;
  }

  function endsOf(rec) {
    const o = rec && (rec.origin || rec.o || (rec.od && rec.od.o));
    const d = rec && (rec.destination || rec.d || (rec.od && rec.od.d));
    const code = (x) => (x && (x.iata || x.iata_code || x.icao || x.icao_code || "")) || "";
    return { oi: norm(code(o)), di: norm(code(d)) };
  }

  function routeCodes(route) {
    if (!route || !route.od) return null;
    const od = route.od;
    const oi = norm(od.oi || (od.o && (od.o.iata || od.o.icao)));
    const di = norm(od.di || (od.d && (od.d.iata || od.d.icao)));
    if (!oi || !di) return null;
    return { oi, di };
  }

  function samePair(a, b) {
    if (!a || !b || !a.oi || !b.oi) return false;
    return a.oi === b.oi && a.di === b.di;
  }

  function inspectSources(opts) {
    const callsign = norm(opts && opts.callsign);
    const records = (opts && opts.records) || [];
    const consulted = [];
    let candidate = null;
    for (const rec of records) {
      const src = rec.source || "unknown";
      const payload = rec.payload || rec;
      const forbidden = [];
      for (const k of FORBIDDEN_KEYS) {
        if (payload && payload[k]) forbidden.push({ key: k, value: norm(payload[k]) });
      }
      if (payload && payload.number != null && payload.number !== "" && splitCallsign(callsign) && norm(payload.number) === splitCallsign(callsign).rest) {
        forbidden.push({ key: "number", value: norm(payload.number), reason: "callsign remainder" });
      }
      const explicit = pickExplicit(payload);
      if (!explicit) {
        consulted.push({
          source: src,
          accepted: false,
          reason: forbidden.length
            ? ("no explicit marketed field; " + forbidden.map((f) => f.key + "=" + f.value + " is not a ticket").join("; "))
            : "no explicit marketed flight_number field"
        });
        continue;
      }
      if (isPrefixConversion(callsign, explicit.value) && restHasLetter(callsign)) {
        consulted.push({ source: src, accepted: false, field: explicit.key, value: explicit.value, reason: "same as ICAO→IATA spelling of an alphanumeric ATC callsign; not a ticketed number" });
        continue;
      }
      if (restHasLetter(callsign) && /[A-Z]/.test(explicit.value.replace(/^[A-Z][A-Z0-9]/, ""))) {
        consulted.push({ source: src, accepted: false, field: explicit.key, value: explicit.value, reason: "candidate still has letters in the number part; treated as a radio callsign, not a ticket" });
        continue;
      }
      if (!looksMarketed(explicit.value)) {
        consulted.push({ source: src, accepted: false, field: explicit.key, value: explicit.value, reason: "value is not an IATA marketed-number shape" });
        continue;
      }
      const ends = endsOf(rec);
      consulted.push({ source: src, accepted: true, field: explicit.key, value: explicit.value, origin: ends.oi || null, destination: ends.di || null });
      if (!candidate) candidate = { number: explicit.value, source: src, field: explicit.key, origin: ends.oi || null, destination: ends.di || null };
    }
    const note = candidate
      ? ("Explicit " + candidate.field + " from " + candidate.source + ". Shown only if it matches the plausibility-checked city pair.")
      : "No connected free source exposes an explicit marketed flight_number for this callsign. Prefix conversion (QTR→QR, UAE→EK) is not applied. callsign_iata is the IATA spelling of the radio callsign, not a ticket.";
    return {
      found: false,
      candidate,
      consulted,
      researched: RESEARCHED,
      note
    };
  }

  function acceptMarketedFlight(opts) {
    const callsign = norm(opts && opts.callsign);
    const lookup = (opts && opts.lookup) || inspectSources(opts || {});
    const route = opts && opts.route;
    const unverified = !!(route && (route.unverified || route.conflict || !route.od));
    const pair = routeCodes(route);
    const cand = lookup.candidate;
    if (!cand || !cand.number) {
      return { found: false, number: null, source: null, lookup, note: lookup.note || "Unavailable: no explicit marketed flight_number from a connected free source." };
    }
    if (unverified || !pair) {
      return { found: false, number: null, source: cand.source, lookup, note: "A candidate existed but the displayed route is unverified or the two route sources disagree, so the number is not shown." };
    }
    if (cand.origin && cand.destination && !samePair({ oi: cand.origin, di: cand.destination }, pair)) {
      return { found: false, number: null, source: cand.source, lookup, note: "Candidate " + cand.number + " from " + cand.source + " does not match the plausibility-checked " + pair.oi + "–" + pair.di + " pair." };
    }
    if (!cand.origin || !cand.destination) {
      return { found: false, number: null, source: cand.source, lookup, note: "Candidate has no origin/destination, so it cannot be checked against the displayed pair." };
    }
    return {
      found: true,
      number: cand.number,
      source: cand.source,
      lookup,
      note: "Marketed flight number " + cand.number + " from " + cand.source + " (" + cand.field + "). Consistent with the plausibility-checked " + pair.oi + "–" + pair.di + " pair. Not derived from the ATC callsign."
    };
  }

  function catalogNote(lookup) {
    const rows = ((lookup && lookup.researched) || RESEARCHED).map((r) => r.source + ": " + r.note);
    const cons = ((lookup && lookup.consulted) || []).map((c) => c.source + (c.accepted ? " candidate " + c.value : " — " + (c.reason || "no field")));
    return [].concat(cons.length ? ["Looked up this callsign: " + cons.join(". ")] : [], ["Sources reviewed (UTC): " + rows.join(" ")]).join(" ");
  }

  const API = {
    ICAO_TO_IATA,
    EXPLICIT_KEYS,
    RESEARCHED,
    norm,
    splitCallsign,
    prefixConverted,
    restHasLetter,
    looksMarketed,
    isPrefixConversion,
    pickExplicit,
    inspectSources,
    acceptMarketedFlight,
    catalogNote
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  for (const k of Object.keys(API)) root[k] = API[k];
  root.FlightNo = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
