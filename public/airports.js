// Hub airports for local ADS-B (250 nm point tiles: adsb.lol / adsb.fi) and map presets.
// Coordinates are public ARP figures (OurAirports, public domain). Not a procedure database.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof root === "object" && root) root.AirportHubs = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const POINT_NM = 40;
  const GND_NM = 8;
  const AUTO_ZOOM = 10.5;
  const AUTO_NM = 15;
  const PRESETS = ["DOH", "DXB", "LHR"];
  // id = IATA (map button / /api/ground?apt=). ICAO aliases also resolve.
  const HUBS = [
    { id: "DOH", icao: "OTHH", iata: "DOH", lat: 25.2731, lon: 51.6081, name: "OTHH Hamad International" },
    { id: "DXB", icao: "OMDB", iata: "DXB", lat: 25.2528, lon: 55.3644, name: "OMDB Dubai International" },
    { id: "AUH", icao: "OMAA", iata: "AUH", lat: 24.433, lon: 54.6511, name: "OMAA Abu Dhabi International" },
    { id: "LHR", icao: "EGLL", iata: "LHR", lat: 51.4706, lon: -0.46194, name: "EGLL London Heathrow" },
    { id: "LGW", icao: "EGKK", iata: "LGW", lat: 51.1481, lon: -0.19028, name: "EGKK London Gatwick" },
    { id: "MAN", icao: "EGCC", iata: "MAN", lat: 53.3537, lon: -2.275, name: "EGCC Manchester" },
    { id: "CDG", icao: "LFPG", iata: "CDG", lat: 49.0097, lon: 2.5478, name: "LFPG Paris Charles de Gaulle" },
    { id: "FRA", icao: "EDDF", iata: "FRA", lat: 50.0379, lon: 8.5622, name: "EDDF Frankfurt" },
    { id: "MUC", icao: "EDDM", iata: "MUC", lat: 48.3538, lon: 11.7861, name: "EDDM Munich" },
    { id: "AMS", icao: "EHAM", iata: "AMS", lat: 52.3086, lon: 4.7639, name: "EHAM Amsterdam Schiphol" },
    { id: "FCO", icao: "LIRF", iata: "FCO", lat: 41.8003, lon: 12.2389, name: "LIRF Rome Fiumicino" },
    { id: "MAD", icao: "LEMD", iata: "MAD", lat: 40.4719, lon: -3.5626, name: "LEMD Madrid Barajas" },
    { id: "BCN", icao: "LEBL", iata: "BCN", lat: 41.2971, lon: 2.0785, name: "LEBL Barcelona" },
    { id: "ZRH", icao: "LSZH", iata: "ZRH", lat: 47.4581, lon: 8.5481, name: "LSZH Zurich" },
    { id: "IST", icao: "LTFM", iata: "IST", lat: 41.2753, lon: 28.7519, name: "LTFM Istanbul" },
    { id: "JFK", icao: "KJFK", iata: "JFK", lat: 40.6399, lon: -73.7787, name: "KJFK New York JFK" },
    { id: "EWR", icao: "KEWR", iata: "EWR", lat: 40.6925, lon: -74.1687, name: "KEWR Newark" },
    { id: "IAD", icao: "KIAD", iata: "IAD", lat: 38.9445, lon: -77.4558, name: "KIAD Washington Dulles" },
    { id: "ORD", icao: "KORD", iata: "ORD", lat: 41.9786, lon: -87.9048, name: "KORD Chicago O'Hare" },
    { id: "LAX", icao: "KLAX", iata: "LAX", lat: 33.9425, lon: -118.408, name: "KLAX Los Angeles" },
    { id: "IAH", icao: "KIAH", iata: "IAH", lat: 29.9844, lon: -95.3414, name: "KIAH Houston Intercontinental" },
    { id: "ATL", icao: "KATL", iata: "ATL", lat: 33.6367, lon: -84.4281, name: "KATL Atlanta" },
    { id: "MIA", icao: "KMIA", iata: "MIA", lat: 25.7954, lon: -80.2901, name: "KMIA Miami" },
    { id: "SFO", icao: "KSFO", iata: "SFO", lat: 37.6188, lon: -122.375, name: "KSFO San Francisco" },
    { id: "SIN", icao: "WSSS", iata: "SIN", lat: 1.35019, lon: 103.994, name: "WSSS Singapore Changi" },
    { id: "BKK", icao: "VTBS", iata: "BKK", lat: 13.6811, lon: 100.747, name: "VTBS Bangkok Suvarnabhumi" },
    { id: "HKG", icao: "VHHH", iata: "HKG", lat: 22.3089, lon: 113.915, name: "VHHH Hong Kong" },
    { id: "BOM", icao: "VABB", iata: "BOM", lat: 19.0887, lon: 72.8679, name: "VABB Mumbai" },
    { id: "DEL", icao: "VIDP", iata: "DEL", lat: 28.5562, lon: 77.1000, name: "VIDP Delhi" },
    { id: "NRT", icao: "RJAA", iata: "NRT", lat: 35.7647, lon: 140.386, name: "RJAA Tokyo Narita" },
    { id: "HND", icao: "RJTT", iata: "HND", lat: 35.5533, lon: 139.781, name: "RJTT Tokyo Haneda" },
    { id: "SYD", icao: "YSSY", iata: "SYD", lat: -33.9461, lon: 151.177, name: "YSSY Sydney" },
    { id: "MEL", icao: "YMML", iata: "MEL", lat: -37.6733, lon: 144.843, name: "YMML Melbourne" },
    { id: "AKL", icao: "NZAA", iata: "AKL", lat: -37.0081, lon: 174.792, name: "NZAA Auckland" },
    { id: "CAI", icao: "HECA", iata: "CAI", lat: 30.1219, lon: 31.4056, name: "HECA Cairo" },
    { id: "JNB", icao: "FAOR", iata: "JNB", lat: -26.1392, lon: 28.246, name: "FAOR Johannesburg" },
    { id: "RUH", icao: "OERK", iata: "RUH", lat: 24.9578, lon: 46.6989, name: "OERK Riyadh" },
    { id: "JED", icao: "OEJN", iata: "JED", lat: 21.6796, lon: 39.1565, name: "OEJN Jeddah" },
    { id: "MCT", icao: "OOMS", iata: "MCT", lat: 23.5933, lon: 58.2844, name: "OOMS Muscat" },
    { id: "BAH", icao: "OBBI", iata: "BAH", lat: 26.2708, lon: 50.6336, name: "OBBI Bahrain" },
    { id: "KWI", icao: "OKBK", iata: "KWI", lat: 29.2266, lon: 47.9689, name: "OKBK Kuwait" }
  ];
  const R = 3440.065;
  const D2R = Math.PI / 180;
  function hv(lat1, lon1, lat2, lon2) {
    const x = Math.sin((lat2 - lat1) * D2R / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin((lon2 - lon1) * D2R / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, x)));
  }
  const byId = Object.create(null);
  const alias = Object.create(null);
  for (const h of HUBS) {
    byId[h.id] = h;
    alias[h.id] = h.id;
    alias[h.iata] = h.id;
    alias[h.icao] = h.id;
  }
  function resolveApt(code) {
    if (!code) return null;
    const id = alias[String(code).trim().toUpperCase()];
    return id ? byId[id] : null;
  }
  function nearestApt(lat, lon, maxNm) {
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    const cap = maxNm == null ? AUTO_NM : maxNm;
    let best = null, bestD = cap;
    for (const h of HUBS) {
      const d = hv(lat, lon, h.lat, h.lon);
      if (d <= bestD) { best = h; bestD = d; }
    }
    return best;
  }
  function isSurface(onG, alt, gs, distNm) {
    if (distNm > GND_NM) return false;
    if (onG) return true;
    return alt < 300 && gs < 60;
  }
  function merge(list) {
    if (!list || !list.length) return 0;
    let n = 0;
    for (const h of list) {
      if (!h || !h.id) continue;
      const id = String(h.id).trim().toUpperCase();
      if (!id) continue;
      const icao = (h.icao || id).toUpperCase();
      const iata = (h.iata || id).toUpperCase();
      if (byId[id]) {
        alias[icao] = id;
        alias[iata] = id;
        continue;
      }
      const lat = Number(h.lat), lon = Number(h.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const rec = { id, icao, iata, lat, lon, name: h.name || id };
      HUBS.push(rec);
      byId[id] = rec;
      alias[id] = id;
      alias[icao] = id;
      alias[iata] = id;
      n++;
    }
    return n;
  }
  return { HUBS, PRESETS, POINT_NM, GND_NM, AUTO_ZOOM, AUTO_NM, resolveApt, nearestApt, isSurface, hv, byId, alias, merge };
});
