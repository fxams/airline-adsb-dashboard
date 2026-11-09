#!/usr/bin/env python3
"""Synthetic CIFP recovery + real Kalman subsample checks for SID/STAR ident.

Ground truth for synthetics is the FAA CIFP procedure path itself (independently
published). Real QTR clips have no ATC clearance; we only check that named
procedures exist in CIFP and that the matcher never invents a name.
"""
from __future__ import annotations

import gzip
import json
import os
import random
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
from aip_ident import identify  # noqa: E402
from aip_cifp import hv_nm  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
fail = []


def ok(cond, msg):
    if not cond:
        fail.append(msg)


def densify(path, n=8):
    if not path:
        return []
    out = [list(path[0])]
    for a, b in zip(path, path[1:]):
        for t in range(1, n + 1):
            f = t / float(n)
            out.append([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])])
    return out


def jitter(path, deg, rng):
    return [[p[0] + (rng.random() - 0.5) * deg, p[1] + (rng.random() - 0.5) * deg] for p in path]


def extend_after(path, nm=25.0):
    if len(path) < 2:
        return path
    a, b = path[-2], path[-1]
    dlon, dlat = b[0] - a[0], b[1] - a[1]
    dist = (dlon ** 2 + dlat ** 2) ** 0.5 or 1e-6
    step = (nm / 60.0) / dist
    extra = [b[0] + dlon * step, b[1] + dlat * step]
    return list(path) + [extra]


jfk = json.loads(gzip.open(os.path.join(ROOT, "data/aip/JFK.json.gz")).read())
procs = jfk["procs"]
lat0, lon0 = jfk["lat"], jfk["lon"]
cifp_ids = {p["id"] for p in procs}

ok(jfk["ident_mode"] == "cifp", "JFK ident_mode cifp")
ok((jfk.get("ident") or {}).get("flights", 0) >= 1, "JFK has Kalman ident subsample")
ok(all(p["id"] for p in procs) and all(p.get("fixes") for p in procs if p.get("path")), "CIFP names/fixes present")

# --- Synthetic: fly the published CIFP path (independent ground truth). ---
rng = random.Random(7)
sid_rwy = [
    p for p in procs
    if p["kind"] == "sid" and (p.get("trans") or "").startswith("RW") and len(p.get("fixes") or []) >= 2
    and len(p.get("path") or []) >= 2
    and hv_nm(lat0, lon0, p["path"][-1][1], p["path"][-1][0]) >= hv_nm(lat0, lon0, p["path"][0][1], p["path"][0][0])
]
ok(len(sid_rwy) >= 2, f"enough outbound runway SIDs {len(sid_rwy)}")

hit = miss = wrong = 0
details = []
for p in sid_rwy:
    track = densify(p["path"])
    ident = identify(track, procs, lat0, lon0, kind="sid", rwy=p.get("rwy") or None)
    rec = {"truth": p["id"], "trans": p["trans"], "status": ident.get("status"), "pred": ident.get("proc"), "conf": ident.get("conf")}
    details.append(rec)
    if ident.get("status") == "match" and ident.get("proc") == p["id"]:
        hit += 1
    elif ident.get("status") == "match":
        wrong += 1
    else:
        miss += 1

n = len(sid_rwy) or 1
recall = hit / n
precision = hit / (hit + wrong) if (hit + wrong) else 0.0
ok(recall >= 0.85, f"synthetic runway-SID recall {recall:.0%} ({hit}/{n}, miss={miss}, wrong={wrong})")
ok(precision >= 0.9 or hit + wrong == 0, f"synthetic runway-SID precision {precision:.0%}")

deez = next(p for p in procs if p["id"] == "DEEZZ6" and p["trans"] == "RW04L")
dtrack = densify(deez["path"])
dident = identify(dtrack, procs, lat0, lon0, kind="sid", rwy="04L")
ok(dident.get("status") == "match" and dident.get("proc") == "DEEZZ6", f"DEEZZ6 RW04L exact {dident}")
ok(dident.get("conf", 0) >= 78, f"DEEZZ6 conf {dident.get('conf')}")
ok("RW04L" in (dident.get("hits") or []) and "PONAE" in (dident.get("hits") or []), f"DEEZZ6 hits {dident.get('hits')}")

noisy = jitter(dtrack, 0.002, rng)
nident = identify(noisy, procs, lat0, lon0, kind="sid", rwy="04L")
ok(nident.get("proc") == "DEEZZ6", f"DEEZZ6 with 0.002° noise {nident.get('proc')} {nident.get('conf')}")

ext = identify(extend_after(dtrack, 30), procs, lat0, lon0, kind="sid", rwy="04L")
ok(ext.get("proc") == "DEEZZ6" and ext.get("status") == "match", f"DEEZZ6 still matched after 30 nm continuation {ext.get('status')} {ext.get('conf')}")

skorr = next((p for p in procs if p["id"] == "SKORR6" and (p.get("trans") or "").startswith("RW")), None)
if skorr:
    sident = identify(densify(skorr["path"]), procs, lat0, lon0, kind="sid", rwy=skorr.get("rwy"))
    ok(sident.get("proc") != "DEEZZ6", f"SKORR6 path not labelled DEEZZ6 ({sident.get('proc')})")

# Southbound, away from JFK north/east SIDs (DEEZZ/SKORR).
vectored = densify([[lon0, lat0], [lon0, lat0 - 0.12], [lon0 + 0.04, lat0 - 0.28], [lon0 - 0.05, lat0 - 0.45]])
vident = identify(vectored, procs, lat0, lon0, kind="sid", rwy="04L")
ok(vident.get("status") != "match", f"southbound vectored path nomatch {vident.get('status')} {vident.get('proc')} {vident.get('conf')}")

# Never invent a name.
for ident in (dident, nident, ext, vident):
    if ident.get("proc"):
        ok(ident["proc"] in cifp_ids, f"invented name {ident['proc']}")

# --- Real Kalman subsample: names must be CIFP ids; 04L dep is DEEZZ6. ---
ident_blob = jfk["ident"]
named = [r for r in (ident_blob.get("raw") or []) if r.get("status") == "match"]
ok(all(r["proc"] in cifp_ids for r in named), "every named real flight uses a CIFP procedure id")
ok(ident_blob["named"] <= ident_blob["flights"], "named ⊆ flights")
dep04 = next((b for b in ident_blob["by_rwy"] if b["id"] == "04L" and b["dir"] == "dep"), None)
ok(dep04 and any(s.get("proc") == "DEEZZ6" for s in dep04["share"]), f"JFK 04L dep named DEEZZ6 {dep04}")

idx = json.load(open(os.path.join(ROOT, "data/aip/index.json"), encoding="utf-8"))
lhr = next(a for a in idx["airports"] if a["id"] == "LHR")
ok(lhr["ident_mode"] == "none" and lhr["ident_named"] == 0, "EGLL/LHR ident_mode none")
ok("fabricated" in (lhr.get("ident_terms") or "").lower() or "never" in (lhr.get("ident_terms") or "").lower(), "LHR terms say names are not invented")
ok("OpenAIP" in (lhr.get("ident_terms") or "") and "OurAirports" in (lhr.get("ident_terms") or ""), "LHR terms cite OurAirports/OpenAIP")
ok("NATS" in (lhr.get("ident_terms") or "") or "redistribut" in (lhr.get("ident_terms") or "").lower(), "LHR terms cite NATS")

# JS matcher agrees on DEEZZ6 RW04L.
js = subprocess.run(
    ["node", "-e", r"""
const Ident=require('./public/aip-ident.js');
const fs=require('fs'), zlib=require('zlib');
const j=JSON.parse(zlib.gunzipSync(fs.readFileSync('data/aip/JFK.json.gz')));
const p=j.procs.find(x=>x.id==='DEEZZ6'&&x.trans==='RW04L');
const dense=[p.path[0].slice()];
for (let i=0;i<p.path.length-1;i++){
  const a=p.path[i], b=p.path[i+1];
  for (let t=1;t<=8;t++){const f=t/8; dense.push([a[0]+f*(b[0]-a[0]), a[1]+f*(b[1]-a[1])]);}
}
const ident=Ident.identify(dense, j.procs, j.lat, j.lon, 'sid', '04L');
process.stdout.write(JSON.stringify({status:ident.status, proc:ident.proc, conf:ident.conf, hits:ident.hits}));
"""],
    cwd=ROOT,
    capture_output=True,
    text=True,
    check=False,
)
ok(js.returncode == 0, f"js matcher ran {js.stderr}")
if js.returncode == 0:
    jsj = json.loads(js.stdout)
    ok(jsj.get("status") == "match" and jsj.get("proc") == "DEEZZ6", f"JS DEEZZ6 {jsj}")
    ok(abs(float(jsj.get("conf") or 0) - float(dident.get("conf") or 0)) <= 2.0, f"JS/Py conf {jsj.get('conf')} vs {dident.get('conf')}")

report = {
    "synthetic_runway_sids": n,
    "synthetic_hit": hit,
    "synthetic_miss": miss,
    "synthetic_wrong": wrong,
    "recall": round(recall, 3),
    "precision": round(precision, 3),
    "deezz6_conf": dident.get("conf"),
    "jfk_flights": ident_blob.get("flights"),
    "jfk_named": ident_blob.get("named"),
    "jfk_named_rate": round(ident_blob["named"] / ident_blob["flights"], 3) if ident_blob.get("flights") else 0,
    "note": (
        "Synthetic ground truth is the FAA CIFP procedure geometry (public domain). "
        "Real Kalman clips have no ATC clearance feed; named procedures are CIFP ids only. "
        "Arrivals at JFK are often vectored, so a low named rate on arrivals is expected."
    ),
    "details": details,
}
print("PRECISION", json.dumps({k: report[k] for k in report if k != "details"}))

if fail:
    print("FAIL\n" + "\n".join(fail))
    sys.exit(1)
print("PASS", {"recall": report["recall"], "precision": report["precision"], "jfk_named": report["jfk_named"], "jfk_flights": report["jfk_flights"]})
