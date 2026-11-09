// Per-type adsb.lol live fetch: retry/backoff, stale fallback, type-group health.
// adsb.lol has no whole-world endpoint, so each ICAO type is queried separately.

const UA = "airline-adsb-dashboard (github.com/fxams/airline-adsb-dashboard)";
const TYPE_URL = (t) => `https://api.adsb.lol/v2/type/${encodeURIComponent(t)}`;

// Widebody / Gulf types first so QTR/UAE (A35K, A359, B77W, A388, …) are requested
// before a mid-cycle rate limit can skip them. Duplicate A21N removed.
const DEFAULT_TYPES = "A35K,A359,A388,B77W,B77L,B772,B789,B788,B78X,A333,A332,A339,A338,A343,A346,A306,B764,B763,B744,B748,MD11,A21N,A20N,A321,A320,A319,A318,BCS3,BCS1,B38M,B39M,B3XM,B738,B739,B737,B753,B752,E195,E190,E290,E295,E75S,E75L,E170,CRJ9,CRJ7,CRJX,AT76,AT75,DH8D,B712,C919";

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function parseTypes(s) {
  const raw = String(s == null || s === "" ? DEFAULT_TYPES : s);
  return [...new Set(raw.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))];
}

function parseRetryAfter(h, now) {
  if (h == null || h === "") return null;
  const s = String(h).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(60_000, Math.max(0, Number(s) * 1000));
  const ms = Date.parse(s) - (now || Date.now());
  if (Number.isFinite(ms)) return Math.min(60_000, Math.max(0, ms));
  return null;
}

function backoffMs(attempt, retryAfterMs, base, cap, rnd) {
  const b = base == null ? 1500 : base;
  const c = cap == null ? 20000 : cap;
  if (retryAfterMs != null && Number.isFinite(retryAfterMs)) return Math.min(c, Math.max(400, retryAfterMs));
  const exp = Math.min(c, b * (2 ** Math.max(0, attempt)));
  const jitter = Math.round(exp * 0.15 * (typeof rnd === "function" ? rnd() : Math.random()));
  return Math.min(c, exp + jitter);
}

function headerGet(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function feedBanner(feed) {
  if (!feed) return "";
  const fail = feed.failed || [];
  const stale = feed.stale || [];
  if (fail.length) {
    const names = fail.map((x) => x.t || x).slice(0, 8).join(", ");
    return `${fail.length} type group${fail.length === 1 ? "" : "s"} unavailable (${names}${fail.length > 8 ? "…" : ""})`;
  }
  if (stale.length) {
    const names = stale.map((x) => x.t || x).slice(0, 6).join(", ");
    return `${stale.length} type group${stale.length === 1 ? "" : "s"} stale (${names}${stale.length > 6 ? "…" : ""})`;
  }
  return "";
}

function errText(e) {
  if (!e) return "unknown";
  if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
  return String(e.message || e);
}

class LiveFeed {
  constructor(opts) {
    const o = opts || {};
    this.types = parseTypes(Array.isArray(o.types) ? o.types.join(",") : o.types);
    this.fetchImpl = o.fetchImpl || fetch;
    this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now || (() => Date.now());
    this.timeoutMs = o.timeoutMs == null ? 12000 : o.timeoutMs;
    this.baseGapMs = o.gapMs == null ? 400 : o.gapMs;
    this.gapMs = this.baseGapMs;
    this.staleMs = o.staleMs == null ? 20 * 60e3 : o.staleMs;
    this.attempts = o.attempts == null ? 4 : o.attempts;
    this.baseBackoffMs = o.baseBackoffMs == null ? 1500 : o.baseBackoffMs;
    this.random = o.random || Math.random;
    this.lastT = new Map();
    this.cooldownUntil = 0;
    this.lastCycleMs = 0;
    this.lastFeed = this._emptyFeed(null, 0);
  }

  _emptyFeed(at, cycleMs) {
    return {
      at,
      cycle_ms: cycleMs,
      ok: [],
      stale: [],
      failed: [],
      n_ok: 0,
      n_stale: 0,
      n_failed: 0,
      n_types: this.types.length,
      note: "Each ICAO type is fetched from adsb.lol /v2/type. Failed groups are retried later in the same cycle (and first on the next cycle). Last good sample is kept up to 20 min. Partial failure does not drop successful groups.",
    };
  }

  summary() {
    return this.lastFeed;
  }

  async _waitCooldown() {
    const wait = this.cooldownUntil - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  _setCooldown(ms) {
    const until = this.now() + Math.max(0, ms);
    if (until > this.cooldownUntil) this.cooldownUntil = until;
  }

  async fetchTypeOnce(t) {
    await this._waitCooldown();
    const r = await this.fetchImpl(TYPE_URL(t), {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (RETRYABLE.has(r.status) || !r.ok) {
      const ra = parseRetryAfter(headerGet(r.headers, "retry-after"), this.now());
      const err = new Error(`adsb.lol ${r.status}`);
      err.status = r.status;
      err.retryable = RETRYABLE.has(r.status);
      if (err.retryable) {
        const waitMs = backoffMs(0, ra, this.baseBackoffMs, 20000, this.random);
        err.retryAfterMs = waitMs;
        this._setCooldown(waitMs);
        this.gapMs = Math.min(2500, Math.max(this.gapMs, waitMs / 4) * 1.35);
      }
      throw err;
    }
    this.gapMs = Math.max(this.baseGapMs, this.gapMs * 0.92);
    const j = await r.json();
    return j.ac || [];
  }

  async fetchTypeRetry(t, attempts, sleepOnFail) {
    let lastErr = null;
    const n = Math.max(1, attempts);
    for (let k = 0; k < n; k++) {
      try {
        return { t, ac: await this.fetchTypeOnce(t), err: null };
      } catch (e) {
        lastErr = e;
        if (e && e.status === 404) break;
        if (e && e.retryable === false && e.status && e.status < 500) break;
        if (sleepOnFail && k < n - 1) {
          await this.sleep(e.retryAfterMs || backoffMs(k, null, this.baseBackoffMs, 20000, this.random));
        }
      }
    }
    return { t, ac: null, err: errText(lastErr) };
  }

  applyResult(t, result) {
    const now = this.now();
    if (result.ac) {
      this.lastT.set(t, { ts: now, ac: result.ac, err: null });
      return { t, status: "ok", n: result.ac.length, err: null, age_s: 0, last_ok_utc: new Date(now).toISOString() };
    }
    const o = this.lastT.get(t);
    const lastOk = o ? new Date(o.ts).toISOString() : null;
    if (o && now - o.ts < this.staleMs) {
      return { t, status: "stale", n: o.ac.length, err: result.err, age_s: Math.round((now - o.ts) / 1000), last_ok_utc: lastOk };
    }
    return { t, status: "failed", n: 0, err: result.err, age_s: o ? Math.round((now - o.ts) / 1000) : null, last_ok_utc: lastOk };
  }

  _order() {
    const prev = new Set([
      ...(this.lastFeed.failed || []).map((x) => x.t),
      ...(this.lastFeed.stale || []).map((x) => x.t),
    ]);
    if (!prev.size) return this.types.slice();
    return [...this.types.filter((t) => prev.has(t)), ...this.types.filter((t) => !prev.has(t))];
  }

  _pack(groups, cycleMs) {
    const ok = [], stale = [], failed = [];
    for (const g of groups) {
      if (g.status === "ok") ok.push(g.t);
      else if (g.status === "stale") stale.push({ t: g.t, age_s: g.age_s, err: g.err, last_ok_utc: g.last_ok_utc });
      else failed.push({ t: g.t, err: g.err, last_ok_utc: g.last_ok_utc });
    }
    return {
      at: new Date(this.now()).toISOString(),
      cycle_ms: cycleMs,
      ok,
      stale,
      failed,
      n_ok: ok.length,
      n_stale: stale.length,
      n_failed: failed.length,
      n_types: this.types.length,
      note: this._emptyFeed(null, 0).note,
    };
  }

  collectAircraft() {
    const seen = new Map();
    const now = this.now();
    const keep = new Set([...(this.lastFeed.ok || []), ...(this.lastFeed.stale || []).map((x) => x.t)]);
    for (const t of this.types) {
      const o = this.lastT.get(t);
      if (!o || !o.ac) continue;
      // Always keep groups that succeeded or were marked stale this cycle, even if
      // later retries in the same cycle pushed the clock past staleMs.
      if (!keep.has(t) && now - o.ts >= this.staleMs) continue;
      for (const a of o.ac) {
        if (!a || !a.hex) continue;
        const p = seen.get(a.hex);
        if (!p || (a.seen_pos ?? 99) < (p.seen_pos ?? 99)) seen.set(a.hex, a);
      }
    }
    return seen;
  }

  async refresh() {
    const t0 = this.now();
    const by = new Map();
    const order = this._order();
    for (const t of order) {
      by.set(t, this.applyResult(t, await this.fetchTypeRetry(t, 1, false)));
      await this.sleep(this.gapMs);
    }
    const need = order.filter((t) => {
      const g = by.get(t);
      if (!g || g.status === "ok") return false;
      // Client errors other than rate-limit / timeout are not worth a second pass.
      if (g.err && /^adsb\.lol 4\d\d$/.test(g.err) && !/408|425|429/.test(g.err)) return false;
      return true;
    });
    for (const t of need) {
      by.set(t, this.applyResult(t, await this.fetchTypeRetry(t, Math.max(1, this.attempts - 1), true)));
      await this.sleep(this.gapMs);
    }
    const groups = this.types.map((t) => by.get(t) || this.applyResult(t, { ac: null, err: "not fetched" }));
    this.lastCycleMs = this.now() - t0;
    this.lastFeed = this._pack(groups, this.lastCycleMs);
    const seen = this.collectAircraft();
    if (this.lastFeed.failed.length) {
      console.error(
        "type groups failed",
        this.lastFeed.failed.map((x) => x.t).join(","),
        this.lastFeed.failed.map((x) => `${x.t}:${x.err}`).join("; ")
      );
    }
    if (this.lastFeed.stale.length) {
      console.error(
        "type groups stale",
        this.lastFeed.stale.map((x) => x.t).join(","),
        this.lastFeed.stale.map((x) => `${x.t}:${x.err}`).join("; ")
      );
    }
    return { seen, feed: this.lastFeed, groups };
  }
}

module.exports = {
  LiveFeed,
  parseTypes,
  parseRetryAfter,
  backoffMs,
  feedBanner,
  DEFAULT_TYPES,
  TYPE_URL,
  UA,
  RETRYABLE,
};
