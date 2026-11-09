#!/usr/bin/env python3
"""Licence policy, CIFP parse, and committed AIP index."""
import gzip
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
from aip_cifp import decode_latlon, lookup_fix, parse_proc_records, index_fixes, legs_to_path  # noqa: E402
from aip_policy import policy_for  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
fail = []


def ok(cond, msg):
    if not cond:
        fail.append(msg)


idx = json.load(open("data/aip/index.json", encoding="utf-8"))
ok(idx["n_airports"] == 193, f"193 observed QTR airports, got {idx['n_airports']}")
ok(idx["n_draw"] == 30, f"30 US DRAW, got {idx['n_draw']}")
ok(idx["n_link"] == 163, f"163 LINK, got {idx['n_link']}")
ok(idx["cycle"] == "CIFP 261029", idx.get("cycle"))
ok("17 U.S.C." in (idx.get("license") or ""), "index cites 17 U.S.C. § 105")
blob = json.dumps(idx).lower()
ok("not navigraph" in blob and "not jeppesen" in blob, "index denies Navigraph/Jeppesen")

by_id = {a["id"]: a for a in idx["airports"]}
jfk = by_id["JFK"]
ok(jfk["mode"] == "draw" and jfk["icao"] == "KJFK", "JFK DRAW")
ok(jfk["n_sid"] >= 2 and jfk["n_star"] >= 2, f"JFK has SID+STAR {jfk['n_sid']}/{jfk['n_star']}")
ok("FAA" in jfk["aip"] and "105" in (policy_for("KJFK", "JFK")["terms"]), "JFK FAA terms")

lhr = by_id["LHR"]
ok(lhr["mode"] == "link" and lhr["icao"] == "EGLL", "LHR/EGLL LINK")
ok(lhr["tile"] is None and lhr["n_sid"] == 0, "EGLL has no procedure tile")
ok(lhr.get("ident_mode") == "none" and lhr.get("ident_named") == 0, "EGLL ident_mode none")
ok("OurAirports" in (lhr.get("ident_terms") or "") and "OpenAIP" in (lhr.get("ident_terms") or ""), "EGLL ident terms cite open sources")
ok("EG-AD-2.EGLL" in (lhr["ad2_url"] or ""), f"EGLL AD 2 URL {lhr['ad2_url']}")
ok("nats-uk.ead-it.com" in (lhr["terms_url"] or "") and "redistribute" in (lhr["terms"] or "").lower(), "NATS T&Cs cited")

doh = by_id["DOH"]
ok(doh["mode"] == "link" and doh["icao"] == "OTHH", "DOH LINK")
ok("caa.gov.qa" in (doh["ad2_url"] or ""), "QCAA AIM link")
ok("personal" in (doh["terms"] or "").lower() or "non-commercial" in (doh["terms"] or "").lower(), "QCAA terms")

syd = by_id["SYD"]
ok(syd["mode"] == "link" and "airservices" in (syd["terms"] or "").lower(), "SYD Airservices")

yyz = next((a for a in idx["airports"] if a["icao"].startswith("CY")), None)
ok(yyz and yyz["mode"] == "link" and "NAV CANADA" in (yyz["terms"] or ""), f"Canada LINK {yyz}")

fra = by_id.get("FRA") or next((a for a in idx["airports"] if a["icao"] == "EDDF"), None)
ok(fra and fra["mode"] == "link" and "dfs" in (fra["ad2_url"] or "").lower(), "FRA DFS link")

ok(all(a["mode"] in ("draw", "link") and a.get("ad2_url") and a.get("terms") for a in idx["airports"]), "every airport has mode, AD 2 URL, terms")
ok(all(a["tile"] is None for a in idx["airports"] if a["mode"] == "link"), "link-only airports have no geometry tile")
ok(all(a["icao"].startswith("K") or a["icao"].startswith("PH") for a in idx["airports"] if a["mode"] == "draw"), "DRAW is US ICAO only")

tile = json.loads(gzip.open("data/aip/JFK.json.gz").read())
ok(tile["mode"] == "draw" and tile["n_sid"] >= 2, "JFK tile DRAW")
ok(any(p["id"].startswith("DEEZZ") or p["id"].startswith("SKORR") for p in tile["procs"] if p["kind"] == "sid"), "JFK SID names from CIFP")
ok(any(p["kind"] == "star" for p in tile["procs"]), "JFK STAR drawn")
ok("Not for navigation" in (tile["disclaimer"] or "") + (tile["note"] or ""), "not for navigation")
ok(all(len(p["path"]) >= 2 for p in tile["procs"]), "every drawn proc has ≥2 fixes")
ok(tile.get("ident_mode") == "cifp" and (tile.get("ident") or {}).get("flights", 0) >= 1, "JFK ident subsample")
ok((tile.get("ident") or {}).get("named", 0) <= (tile.get("ident") or {}).get("flights", 0), "named ⊆ flights")
cifp_ids = {p["id"] for p in tile["procs"]}
for row in (tile.get("ident") or {}).get("raw") or []:
    if row.get("proc"):
        ok(row["proc"] in cifp_ids, f"invented ident name {row}")
ok(any(b.get("id") == "04L" and b.get("dir") == "dep" and any(s.get("proc") == "DEEZZ6" for s in b.get("share") or []) for b in (tile.get("ident") or {}).get("by_rwy") or []), "04L dep DEEZZ6")
for m in tile.get("match") or []:
    ok(m["kind"] in ("sid", "star") and m["mean_nm"] <= 4.2, f"match gate {m}")

ll = decode_latlon("N40382374W073464329")
ok(ll and abs(ll[0] - 40.63993) < 1e-4 and abs(ll[1] + 73.77869) < 1e-4, f"KJFK ARP decode {ll}")

# Tiny ARINC 424 fixture copied from FAA CIFP 261029 (KJFK DEEZZ6 RW04L).
fix = """\
HDR01FAACIFP18      001P013203973042611  07-OCT-202615:55:03  U.S.A. DOT FAA                                                9D60747B
SUSAP KJFKK6AJFK     0     145YHN40382374W073464329W013000013         1800018000C    MNAR    JOHN F KENNEDY INTL           303911912
SUSAP KJFKK6GRW04L   0120790440 N40372318W073470505         -0028300012046057200IIHIQ1                                     308521709
SUSAP KJFKK6CPONAE K60    W     N40401997W073444686                       W0126     NAR           PONAE                    304332603
SUSAEAENRT   DEEZZ K60    C     N41065200W073464000                       W0126     NAR           DEEZZ                    327752605
SUSAP KJFKK6DDEEZZ64RW04L 010         0        VA                     0438        + 00520     18000       KJFK  K6PA       304552603
SUSAP KJFKK6DDEEZZ64RW04L 020PONAEK6PC0EY      DF                                                                          304562603
SUSAP KJFKK6DDEEZZ64RW04L 030         0 E      VM                     0990                                                 304572603
"""
fd, path = tempfile.mkstemp(prefix="cifp", suffix=".txt")
os.write(fd, fix.encode("ascii"))
os.close(fd)
try:
    by_key, by_ident = index_fixes(path)
    ok("PONAE" in by_ident, "fixture indexes PONAE")
    ok("DEEZZ" in by_ident, "fixture indexes EA DEEZZ")
    legs = parse_proc_records(path, {"KJFK"})
    ok(("KJFK", "sid", "DEEZZ6", "4", "RW04L") in legs, f"SID group {list(legs)}")
    pth, names = legs_to_path(legs[("KJFK", "sid", "DEEZZ6", "4", "RW04L")], "KJFK", 40.64, -73.78, by_key, by_ident, "RW04L")
    ok(pth and len(pth) >= 2, f"RW04L SID path {pth} {names}")
    ok(names and "PONAE" in names, f"PONAE on path {names}")
finally:
    os.remove(path)

p = policy_for("KJFK", "JFK")
ok(p["mode"] == "draw", "policy KJFK draw")
p = policy_for("EGLL", "LHR")
ok(p["mode"] == "link" and "NATS" in p["terms"], "policy EGLL link NATS")
p = policy_for("OTHH", "DOH")
ok(p["mode"] == "link", "policy OTHH link")
p = policy_for("IN-0276", "NMI")
ok(p["mode"] == "link" and "India" in p["state"], "Navi Mumbai treated as India AIP")

if fail:
    print("FAIL\n" + "\n".join(fail))
    sys.exit(1)
print("PASS", {
    "n_airports": idx["n_airports"],
    "n_draw": idx["n_draw"],
    "n_link": idx["n_link"],
    "n_sid": idx["n_sid"],
    "n_star": idx["n_star"],
    "n_match": idx["n_match"],
    "jfk": {"sid": jfk["n_sid"], "star": jfk["n_star"], "match": jfk["n_match"]},
    "lhr_ad2": lhr["ad2_url"],
})
