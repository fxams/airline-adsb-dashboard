"""Per-flight SID/STAR identification from Kalman-smoothed ADS-B vs CIFP.

Licence-safe names and fixes only (FAA CIFP / US). Ordered fix hits plus
discrete Fréchet and DTW. Below threshold → 'No match / vectored'.
Estimated from the track, not the ATC clearance. Never invents names.
"""
from __future__ import annotations

import math
from collections import defaultdict

from aip_cifp import CLIP_NM, clip_path, hv_nm, norm_rwy, rr

FIX_TOL_NM = 2.0
RESAMPLE_N = 20
FRECHET_SCALE_NM = 5.0
DTW_SCALE_NM = 4.0
CONF_THRESHOLD = 58
MIN_HITS_NAMED = 2

SID_RWY_RT = set("14")
STAR_RWY_RT = set("36")


def _xy(path, lat0, lon0):
    klat = 60.0
    klon = 60.0 * math.cos(math.radians(lat0 or 0.0))
    return [((p[0] - lon0) * klon, (p[1] - lat0) * klat) for p in path]


def resample(path, n=RESAMPLE_N):
    if not path:
        return []
    if len(path) <= n:
        return [list(p) for p in path]
    dist = [0.0]
    for i in range(1, len(path)):
        dist.append(dist[-1] + hv_nm(path[i - 1][1], path[i - 1][0], path[i][1], path[i][0]))
    total = dist[-1] or 1.0
    out = [list(path[0])]
    t = 1
    for k in range(1, n - 1):
        target = total * k / (n - 1)
        while t < len(dist) and dist[t] < target:
            t += 1
        if t >= len(path):
            out.append(list(path[-1]))
            continue
        span = dist[t] - dist[t - 1] or 1e-9
        f = (target - dist[t - 1]) / span
        lo, la = path[t - 1], path[t]
        out.append([lo[0] + f * (la[0] - lo[0]), lo[1] + f * (la[1] - lo[1])])
    out.append(list(path[-1]))
    return out


def discrete_frechet(P, Q):
    n, m = len(P), len(Q)
    if n == 0 or m == 0:
        return 1e9
    prev = [0.0] * m
    prev[0] = math.hypot(P[0][0] - Q[0][0], P[0][1] - Q[0][1])
    for j in range(1, m):
        d = math.hypot(P[0][0] - Q[j][0], P[0][1] - Q[j][1])
        prev[j] = max(prev[j - 1], d)
    for i in range(1, n):
        cur = [0.0] * m
        d = math.hypot(P[i][0] - Q[0][0], P[i][1] - Q[0][1])
        cur[0] = max(prev[0], d)
        for j in range(1, m):
            d = math.hypot(P[i][0] - Q[j][0], P[i][1] - Q[j][1])
            cur[j] = max(min(prev[j], prev[j - 1], cur[j - 1]), d)
        prev = cur
    return prev[-1]


def dtw_mean(P, Q):
    n, m = len(P), len(Q)
    if n == 0 or m == 0:
        return 1e9
    inf = 1e12
    prev = [inf] * (m + 1)
    prev[0] = 0.0
    for i in range(1, n + 1):
        cur = [inf] * (m + 1)
        px, py = P[i - 1]
        for j in range(1, m + 1):
            d = math.hypot(px - Q[j - 1][0], py - Q[j - 1][1])
            cur[j] = d + min(prev[j], prev[j - 1], cur[j - 1])
        prev = cur
    return prev[m] / (n + m)


def flatten_seg(seg):
    out = []
    if not seg:
        return out
    if seg and isinstance(seg[0], (int, float)):
        return [seg] if len(seg) >= 2 else []
    for part in seg:
        if not part:
            continue
        if part and isinstance(part[0], (int, float)):
            out.append(part)
        else:
            out.extend(part)
    return out


def ordered_fix_hits(track, fixes_ll, tol=FIX_TOL_NM):
    """Walk the track forward; each published fix must be hit after the previous."""
    hits = []
    i0 = 0
    for name, lon, lat in fixes_ll:
        best_i, best_d = None, 1e9
        for i in range(i0, len(track)):
            d = hv_nm(track[i][1], track[i][0], lat, lon)
            if d < best_d:
                best_d, best_i = d, i
            if d <= tol:
                hits.append({"fix": name, "nm": rr(d, 2), "i": i})
                i0 = i
                best_i = None
                break
        if best_i is None:
            continue
        # no point within tol after i0
        break
    return hits


def _same_rwy(want, prwy):
    want, prwy = norm_rwy(want), norm_rwy(prwy)
    if not want or not prwy:
        return False
    if prwy.endswith("B") and prwy[:2] == want[:2]:
        return True
    return prwy == want


def score_proc(track, proc, lat0, lon0):
    path = proc.get("path") or []
    fixes = proc.get("fixes") or []
    if len(track) < 4 or len(path) < 2:
        return None
    tclip = clip_path(track, lat0, lon0, CLIP_NM) or track
    pclip = clip_path(path, lat0, lon0, CLIP_NM) or path
    if len(tclip) < 2 or len(pclip) < 2:
        return None
    fix_ll = []
    for i, name in enumerate(fixes):
        if i >= len(path):
            break
        fix_ll.append((name, path[i][0], path[i][1]))
    hits = ordered_fix_hits(tclip, fix_ll)
    nfix = max(len(fix_ll), 1)
    fix_frac = len(hits) / nfix
    # Compare geometry only along the procedure: through the last fix hit, not the
    # rest of a vectored/en-route continuation that would inflate Fréchet.
    if hits:
        i_end = min(len(tclip) - 1, hits[-1]["i"] + 6)
        t_cmp = tclip[: i_end + 1]
    else:
        t_cmp = clip_path(tclip, lat0, lon0, 12.0) or tclip[: max(8, len(tclip) // 4)]
    p_cmp = pclip
    Pt = _xy(resample(t_cmp if len(t_cmp) >= 2 else tclip), lat0, lon0)
    Pp = _xy(resample(p_cmp), lat0, lon0)
    fr = discrete_frechet(Pt, Pp)
    dw = dtw_mean(Pt, Pp)
    fr_s = max(0.0, 1.0 - fr / FRECHET_SCALE_NM)
    dw_s = max(0.0, 1.0 - dw / DTW_SCALE_NM)
    conf = 100.0 * (0.50 * fix_frac + 0.35 * fr_s + 0.15 * dw_s)
    if len(hits) == 0:
        conf = min(conf, 38.0)
    elif len(hits) < MIN_HITS_NAMED and nfix >= 3:
        conf *= 0.65
    # Passing every published fix in order is the SID/STAR, even if ATC vectors after.
    if fix_frac >= 1.0 and len(hits) >= MIN_HITS_NAMED:
        conf = max(conf, 78.0)
    elif fix_frac >= 0.66 and len(hits) >= MIN_HITS_NAMED:
        conf = max(conf, 62.0)
    conf = max(0.0, min(100.0, conf))
    return {
        "proc": proc.get("id"),
        "trans": proc.get("trans") or "",
        "rwy": proc.get("rwy") or "",
        "kind": proc.get("kind"),
        "rt": proc.get("rt") or "",
        "conf": rr(conf, 1),
        "hits": [h["fix"] for h in hits],
        "n_hits": len(hits),
        "n_fixes": nfix,
        "fix_frac": rr(fix_frac, 3),
        "frechet_nm": rr(fr, 2),
        "dtw_nm": rr(dw, 2),
    }


def nomatch():
    return {
        "status": "nomatch",
        "proc": None,
        "trans": "",
        "kind": None,
        "conf": 0,
        "hits": [],
        "n_hits": 0,
        "n_fixes": 0,
        "label": "No match / vectored",
        "note": "Estimated from the ADS-B track, not the ATC clearance. Not for navigation.",
    }


def identify(track, procs, lat0, lon0, kind=None, rwy=None, threshold=CONF_THRESHOLD):
    """Return the most likely SID/STAR or nomatch. Never invents a name."""
    if not track or not procs:
        return nomatch()
    want_kind = "sid" if kind == "dep" else "star" if kind == "arr" else kind
    pool = []
    for p in procs:
        if want_kind and p.get("kind") != want_kind:
            continue
        prwy = p.get("rwy") or ""
        if rwy and prwy and not _same_rwy(rwy, prwy):
            continue
        pool.append(p)
    if not pool:
        pool = [p for p in procs if not want_kind or p.get("kind") == want_kind]
    ranked = []
    rwy_rt = SID_RWY_RT if want_kind == "sid" else STAR_RWY_RT
    for p in pool:
        sc = score_proc(track, p, lat0, lon0)
        if not sc:
            continue
        same = 0 if (rwy and _same_rwy(rwy, p.get("rwy"))) else 1
        rt_rank = 0 if (p.get("rt") in rwy_rt) else 1
        # Confidence first: a matching common route must beat a 0% runway transition.
        ranked.append((-sc["conf"], same, rt_rank, sc["proc"] or "", sc["trans"] or "", sc))
    if not ranked:
        return nomatch()
    ranked.sort()
    best = ranked[0][-1]
    if best["conf"] < threshold or (best["n_hits"] < MIN_HITS_NAMED and best.get("fix_frac", 0) < 0.99):
        out = nomatch()
        out["conf"] = best["conf"]
        out["runner_up"] = {"proc": best["proc"], "trans": best["trans"], "conf": best["conf"]}
        return out
    best["status"] = "match"
    best["label"] = (
        f"Likely {best['kind'].upper()}: {best['proc']}"
        + (f" ({best['trans']})" if best["trans"] else "")
        + f" · {int(round(best['conf']))}% match · estimated from ADS-B track, not the ATC clearance"
    )
    best["note"] = "Estimated from the ADS-B track vs published CIFP fixes. Not the ATC clearance. Not for navigation."
    return best


def identify_hist(procs, hist_tile, lat0, lon0):
    """Score stored Kalman tracks (raw subsample + representatives)."""
    if not procs or not hist_tile:
        return {"flights": 0, "named": 0, "by_rwy": [], "rep": [], "raw": []}
    by_rwy_acc = defaultdict(list)
    raw_out = []
    for i, t in enumerate(hist_tile.get("raw") or []):
        pts = flatten_seg(t.get("seg"))
        ident = identify(pts, procs, lat0, lon0, kind=t.get("dir"), rwy=t.get("rwy"))
        rec = {
            "i": i,
            "rwy": t.get("rwy"),
            "dir": t.get("dir"),
            "status": ident.get("status"),
            "proc": ident.get("proc"),
            "trans": ident.get("trans") or "",
            "kind": ident.get("kind"),
            "conf": ident.get("conf") or 0,
            "hits": ident.get("hits") or [],
            "label": ident.get("label") or "No match / vectored",
        }
        raw_out.append(rec)
        by_rwy_acc[(t.get("rwy"), t.get("dir"))].append(rec)
    rep_out = []
    for r in hist_tile.get("rwys") or []:
        cluster = (r.get("clusters") or [None])[0]
        if not cluster or not cluster.get("path"):
            continue
        ident = identify(cluster["path"], procs, lat0, lon0, kind=r.get("dir"), rwy=r.get("id"))
        rec = {
            "rwy": r.get("id"),
            "dir": r.get("dir"),
            "n": r.get("n"),
            "status": ident.get("status"),
            "proc": ident.get("proc"),
            "trans": ident.get("trans") or "",
            "kind": ident.get("kind"),
            "conf": ident.get("conf") or 0,
            "hits": ident.get("hits") or [],
            "label": ident.get("label") or "No match / vectored",
        }
        rep_out.append(rec)
        if (r.get("id"), r.get("dir")) not in by_rwy_acc:
            by_rwy_acc[(r.get("id"), r.get("dir"))].append(rec)
    by_rwy = []
    named = 0
    flights = 0
    for (rid, direction), rows in sorted(by_rwy_acc.items(), key=lambda kv: (-len(kv[1]), kv[0][0] or "", kv[0][1] or "")):
        counts = defaultdict(lambda: {"n": 0, "conf": 0.0, "kind": None, "trans": ""})
        for row in rows:
            flights += 1
            key = row["proc"] or ""
            counts[key]["n"] += 1
            counts[key]["conf"] += float(row.get("conf") or 0)
            counts[key]["kind"] = row.get("kind")
            counts[key]["trans"] = row.get("trans") or counts[key]["trans"]
            if row.get("status") == "match":
                named += 1
        n = len(rows)
        share = []
        for key, v in sorted(counts.items(), key=lambda kv: (-kv[1]["n"], kv[0] or "zzz")):
            share.append({
                "proc": key or None,
                "trans": v["trans"] if key else "",
                "kind": v["kind"] if key else None,
                "n": v["n"],
                "share": rr(v["n"] / n, 3) if n else 0,
                "mean_conf": rr(v["conf"] / v["n"], 1) if v["n"] else 0,
                "label": (key or "No match / vectored"),
            })
        by_rwy.append({"id": rid, "dir": direction, "n": n, "share": share})
    return {
        "source": "FAA CIFP",
        "method": "Ordered CIFP-fix hits (2.0 nm) plus discrete Fréchet and DTW on Kalman-smoothed ADS-B. Threshold 58%.",
        "threshold": CONF_THRESHOLD,
        "disclaimer": "Estimated from the ADS-B track, not the ATC clearance. Not for navigation.",
        "flights": flights,
        "named": named,
        "by_rwy": by_rwy,
        "rep": rep_out,
        "raw": raw_out,
    }
