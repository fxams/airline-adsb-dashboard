# airline-adsb-dashboard

A small zero-dependency Node.js app that compares airlines on **estimated** distance flown, average speed, average altitude, average flight time and a route-efficiency index, by airline, aircraft type and route, with a global route map.

- `/` dashboard (rankings with ascending/descending order, filters, sortable table, SVG route map)
- `/api/traced` per-airline/type/route aggregates from traced flights (2026-11-03 14:53 to 2026-11-04 16:22 UTC: 485 flights, 160 aircraft)
- `/api/snapshot` live per-airline snapshot around six hub airports, fetched from adsb.lol every `REFRESH_MINUTES` (default 10) and cached in memory
- `/api/map`, `/healthz`

Run: `node server.js` (Node 18+). Deploy: `render.yaml` (Render free web service).

## Dashboard (v2)
Dark analytics UI (MapLibre + CARTO dark basemap, ECharts): live map polled every 30 s (server refresh 60 s, `no-store` headers, LIVE/STALE indicator), QTR vs UAE 365-day head-to-head from adsb.lol globe_history full-day dumps, distributions (box plots, scatter, heatmap, correlation), global 3-day leaderboard with coverage warning, sortable tables with CSV/JSON export, API explorer.

API: `/api/live`, `/api/h2h`, `/api/global`, `/api/snapshot`, `/api/traced`, `/healthz`. All times UTC; figures are estimates.

## Caveats
All figures are estimates from samples, US and Europe heavy. The efficiency index is not fuel burn, delay, punctuality or safety; ATC, weather and winds drive much of it, and small samples are low confidence. No delay figures are shown.

## Data and credits
- ADS-B data: [adsb.lol](https://adsb.lol), licensed under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Derived data in `data/traced.json` and `data/map.json` is shared under ODbL.
- Airline names: [OpenFlights](https://openflights.org/data) (ODbL).
- Airports: [OurAirports](https://ourairports.com/data/) (public domain).
- Land outline: [Natural Earth](https://www.naturalearthdata.com/) (public domain).

Code: MIT.

## Live feed, routes and coverage (v3)
- Live positions are fetched worldwide from adsb.lol `/v2/type/{type}` for ~50 common airliner types (serial, spaced, every 90 s). Aircraft without a type in the database are not included.
- Clicking an aircraft looks up its route from [adsbdb.com](https://www.adsbdb.com) (`/api/route?cs=`; cached 24 h, misses 6 h, max 1 request/s) and cross-checks it with routes inferred from adsb.lol history. Remaining route is an estimated great circle.
- `/api/coverage` returns 2-degree cells with receptions in the last 6 h; the map shades them. Unshaded areas have no ADS-B receivers feeding adsb.lol (most oceans, much of Africa, Siberia), so aircraft there are not visible.
- Mobile layout: bottom-sheet flight panel, filter drawer, scrollable tabs and tables. Times in UTC.
