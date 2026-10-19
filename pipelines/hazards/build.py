"""Models and map layers for Fire, Water & Rock.

  python -m pipelines.hazards.build [--retrain]

Wildfire starts
    Daily count of new fires per fire centre and cause (lightning / people), fire season
    (Apr–Oct) 2000–2025, modelled with Poisson gradient boosting on weather from the
    centre's ECCC station: heat, recent rain, days since rain and a running dryness index.
    Validated leave-one-season-out against a seasonal climatology (centre × cause × week).
Rivers
    Each real-time gauge's latest reading ranked against its own daily-mean history for the
    same time of year (±7 days, 1991–present). Flood frequency: GEV fit to annual peak daily
    flow, giving the return period of the November 2021 atmospheric-river peaks.
Earthquakes
    Gutenberg–Richter recurrence per zone from the USGS catalogue (Aki–Utsu b-value with
    bootstrap interval, magnitude of completeness by maximum curvature + 0.2).
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.ensemble import HistGradientBoostingRegressor

from pipelines.common.eccc import fill_series, splice
from pipelines.common.http import get_json

from .config import DERIVED, FIRE_CENTRES, FIRE_TRAIN_START, FLOOD_GAUGES, OUT, QUAKE_ZONES, RAW, RIVER_CLIM_START

FEATURES = ["tmax", "tmax_3d", "tmax_anom", "precip", "precip_7d", "precip_30d", "dry_days", "dryness", "doy_sin",
            "doy_cos", "centre_code"]
CAUSES = ["lightning", "people"]
CENTRE_CODES = {k: i for i, k in enumerate(FIRE_CENTRES)}
SEASON = (91, 304)          # Apr 1 – Oct 31 (day of year)


def clean(o):
    """Replace NaN/inf anywhere in a nested structure with None (JSON has no NaN)."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (float, np.floating)):
        return None if not np.isfinite(o) else float(o)
    return o


def dump(name, obj):
    obj = clean(obj)
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / name, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False, allow_nan=False, default=_default)
    print(f"  wrote {name} ({(OUT / name).stat().st_size / 1024:,.0f} KB)")


def _default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return None if not np.isfinite(o) else round(float(o), 3)
    if isinstance(o, (date, datetime, pd.Timestamp)):
        return o.isoformat()[:10]
    raise TypeError(type(o))


def sv(x, n=None):
    """String value or None (pandas gives NaN floats for missing text)."""
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return None
    return str(x)[:n] if n else str(x)


def r(x, n=2):
    return None if x is None or not np.isfinite(x) else round(float(x), n)


# ============================================================================= weather features

def centre_weather(raw: pd.DataFrame) -> dict[str, pd.DataFrame]:
    out = {}
    for key, fc in FIRE_CENTRES.items():
        chain = [raw[(raw.centre == key) & (raw.station == sid)].set_index("date") for sid in fc["stations"]]
        tmax = splice([c.tmax for c in chain]).interpolate(limit=5)
        precip = fill_series([c.precip for c in chain])
        out[key] = pd.DataFrame({"tmax": tmax, "precip": precip.reindex(tmax.index)})
    return out


def features(w: pd.DataFrame, clim: pd.Series | None = None) -> pd.DataFrame:
    df = w.copy()
    df["precip"] = df.precip.fillna(0.0)
    df["tmax_3d"] = df.tmax.rolling(3, min_periods=1).mean()
    df["precip_7d"] = df.precip.rolling(7, min_periods=1).sum()
    df["precip_30d"] = df.precip.rolling(30, min_periods=1).sum()
    wet = df.precip >= 2.0
    df["dry_days"] = (~wet).groupby(wet.cumsum()).cumsum().clip(upper=90)
    # dryness: heat accumulated since the last soaking rain (≥ 10 mm over 3 days resets it)
    reset = df.precip.rolling(3, min_periods=1).sum() >= 10
    heat = (df.tmax - 10).clip(lower=0).fillna(0)
    df["dryness"] = heat.groupby(reset.cumsum()).cumsum().clip(upper=2500)
    doy = df.index.dayofyear
    df["doy"] = doy
    df["doy_sin"], df["doy_cos"] = np.sin(2 * np.pi * doy / 365.25), np.cos(2 * np.pi * doy / 365.25)
    if clim is None:
        clim = df.groupby("doy").tmax.mean().rolling(15, center=True, min_periods=1).mean()
    df["tmax_anom"] = df.tmax - clim.reindex(df.doy).to_numpy()
    return df, clim


# ============================================================================= wildfire model

def fire_table(hist: pd.DataFrame, weather: dict[str, pd.DataFrame]):
    f = hist[(hist.FIRE_TYPE == "Fire") & (hist.FIRE_YEAR >= FIRE_TRAIN_START)].copy()
    f["centre"] = f.FIRE_NUMBER.str[0]
    f = f[f.centre.isin(FIRE_CENTRES)]
    f["date"] = pd.to_datetime(f.IGNITION_DATE.str[:10], errors="coerce")
    f["cause"] = np.where(f.FIRE_CAUSE.str.lower().str.startswith("light"), "lightning", "people")
    counts = f.dropna(subset=["date"]).groupby(["centre", "cause", "date"]).size()
    rows, clims = [], {}
    for key, w in weather.items():
        feat, clim = features(w)
        clims[key] = clim
        feat = feat[(feat.index.year >= FIRE_TRAIN_START) & (feat.doy.between(*SEASON))].dropna(subset=["tmax"])
        for cause in CAUSES:
            d = feat.copy()
            d["centre"], d["centre_code"], d["cause"] = key, CENTRE_CODES[key], cause
            d["n"] = counts.reindex(pd.MultiIndex.from_product([[key], [cause], d.index])).fillna(0).to_numpy()
            rows.append(d)
    t = pd.concat(rows)
    t["year"] = t.index.year
    t["week"] = ((t.doy - 1) // 7).astype(int)
    return t, clims


FEATURE_GROUPS = {
    "Heat": ["tmax", "tmax_3d", "tmax_anom"], "Rain": ["precip", "precip_7d", "precip_30d"],
    "Dryness": ["dry_days", "dryness"], "Time of year": ["doy_sin", "doy_cos"], "Fire centre": ["centre_code"],
}


def grouped_importance(model, X, y, d_full, repeats=3):
    """Shuffle each group of correlated inputs together; report the rise in Poisson deviance."""
    rng = np.random.default_rng(0)
    out = {}
    for name, cols in FEATURE_GROUPS.items():
        idx = [FEATURES.index(c) for c in cols]
        rises = []
        for _ in range(repeats):
            Xp = X.copy()
            perm = rng.permutation(len(X))
            Xp[:, idx] = X[perm][:, idx]
            rises.append(poisson_dev(y, model.predict(Xp)) - d_full)
        out[name] = float(np.mean(rises))
    return out


def gbm():
    return HistGradientBoostingRegressor(loss="poisson", max_iter=350, learning_rate=0.05, max_leaf_nodes=31,
                                         min_samples_leaf=40, l2_regularization=1.0,
                                         categorical_features=[FEATURES.index("centre_code")], random_state=3)


def poisson_dev(y, mu):
    mu = np.clip(mu, 1e-9, None)
    return 2 * np.sum(y * np.log(np.where(y > 0, y / mu, 1.0)) - (y - mu))


def fire_model(train: pd.DataFrame, current: pd.DataFrame):
    out = {"by_cause": {}}
    models = {}
    for cause in CAUSES:
        t = train[train.cause == cause]
        X, y = t[FEATURES].to_numpy(), t.n.to_numpy()
        pred, base = np.zeros(len(t)), np.zeros(len(t))
        for yr in sorted(t.year.unique()):
            te = (t.year == yr).to_numpy()
            pred[te] = gbm().fit(X[~te], y[~te]).predict(X[te])
            cl = t[~te].groupby(["centre", "week"]).n.mean()
            base[te] = cl.reindex(pd.MultiIndex.from_arrays([t.centre[te], t.week[te]])).fillna(t[~te].n.mean()).to_numpy()
        null = np.full_like(y, y.mean(), dtype=float)
        d_model, d_base, d_null = poisson_dev(y, pred), poisson_dev(y, base), poisson_dev(y, null)
        t = t.assign(pred=pred, base=base)
        season = t.groupby(["year"]).agg(obs=("n", "sum"), pred=("pred", "sum"), base=("base", "sum")).reset_index()
        weekly = t.groupby(["centre", "year", "week"]).agg(obs=("n", "sum"), pred=("pred", "sum"), base=("base", "sum"))
        m = gbm().fit(X, y)
        models[cause] = m
        imp = grouped_importance(m, X, y, d_full=poisson_dev(y, m.predict(X)))
        out["by_cause"][cause] = {
            "deviance_explained": r(1 - d_model / d_null, 3), "deviance_explained_baseline": r(1 - d_base / d_null, 3),
            "weekly_mae": r((weekly.pred - weekly.obs).abs().mean()), "weekly_mae_baseline": r((weekly.base - weekly.obs).abs().mean()),
            "season_corr": r(np.corrcoef(season.obs, season.pred)[0, 1], 3),
            "season_corr_baseline": r(np.corrcoef(season.obs, season.base)[0, 1], 3),
            "season": season.round(1).values.tolist(),
            "importance": {g: r(v / max(d_null, 1), 4) for g, v in imp.items()},
            "n_days": int(len(t)), "n_fires": int(y.sum()),
        }
        print(f"  {cause:<10} dev.expl {out['by_cause'][cause]['deviance_explained']} vs baseline "
              f"{out['by_cause'][cause]['deviance_explained_baseline']}; season r {out['by_cause'][cause]['season_corr']} "
              f"vs {out['by_cause'][cause]['season_corr_baseline']}")
    # out-of-sample current season: observed vs expected given the observed weather
    cur = []
    for cause in CAUSES:
        c = current[current.cause == cause]
        if len(c):
            cur.append(c.assign(pred=models[cause].predict(c[FEATURES].to_numpy())))
    if cur:
        c = pd.concat(cur)
        wk = c.groupby(["week", "cause"]).agg(obs=("n", "sum"), pred=("pred", "sum"),
                                               start=("doy", "min")).reset_index()
        out["current_season"] = {"year": int(c.year.iloc[0]), "weeks": wk.round(2).values.tolist(),
                                 "cols": ["week", "cause", "obs", "pred", "start_doy"],
                                 "total_obs": int(c.n.sum()), "total_pred": r(c.pred.sum(), 1)}
    return models, out


def openmeteo_forecast(lon: float, lat: float) -> pd.DataFrame:
    d = get_json("https://api.open-meteo.com/v1/forecast", {
        "latitude": lat, "longitude": lon, "daily": "temperature_2m_max,precipitation_sum", "models": "gem_seamless",
        "past_days": 10, "forecast_days": 8, "timezone": "America/Vancouver"})
    df = pd.DataFrame({"tmax": d["daily"]["temperature_2m_max"], "precip": d["daily"]["precipitation_sum"]},
                      index=pd.to_datetime(d["daily"]["time"]))
    return df


def fire_forecast(models, weather_recent: dict[str, pd.DataFrame], clims) -> dict:
    today = pd.Timestamp(date.today())
    out = {}
    for key, fc in FIRE_CENTRES.items():
        obs = weather_recent[key]
        fcst = openmeteo_forecast(*fc["lonlat"])
        w = pd.concat([obs[obs.index < fcst.index.min()], fcst]).sort_index()
        w = w[~w.index.duplicated(keep="last")]
        # observed station data wins where it exists
        w.loc[obs.index.intersection(w.index), ["tmax", "precip"]] = obs.loc[obs.index.intersection(w.index), ["tmax", "precip"]].combine_first(
            w.loc[obs.index.intersection(w.index), ["tmax", "precip"]])
        feat, _ = features(w.asfreq("D"), clims[key])
        feat["centre_code"] = CENTRE_CODES[key]
        days = feat[feat.index >= today].head(7)
        in_season = days.doy.between(*SEASON)
        rows = []
        for d_, row in days.iterrows():
            mu = {c: float(models[c].predict(row[FEATURES].to_numpy(dtype=float)[None, :])[0]) if in_season[d_] else 0.0 for c in CAUSES}
            total = sum(mu.values())
            rows.append({"date": d_.date().isoformat(), "lightning": r(mu["lightning"], 3), "people": r(mu["people"], 3),
                         "total": r(total, 3), "lo": int(stats.poisson.ppf(0.1, total)) if total > 0 else 0,
                         "hi": int(stats.poisson.ppf(0.9, total)) if total > 0 else 0,
                         "tmax": r(row.tmax, 1), "precip": r(row.precip, 1), "dry_days": int(row.dry_days)})
        out[key] = {"name": fc["name"], "days": rows, "week_total": r(sum(x["total"] for x in rows), 1),
                    "in_season": bool(in_season.any())}
    return out


# ============================================================================= rivers

def river_climatology(stations: pd.DataFrame) -> pd.DataFrame:
    """Per-station quantiles of daily means in 5-day bins (±7 days), discharge if available else level."""
    rows = []
    qs = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]
    for sid in stations.STATION_NUMBER:
        f = RAW / "river_daily" / f"{sid}.parquet"
        if not f.exists():
            continue
        d = pd.read_parquet(f)
        if d.empty:
            continue
        d["DATE"] = pd.to_datetime(d.DATE)
        d = d[d.DATE.dt.year >= RIVER_CLIM_START]
        var = "DISCHARGE" if d.DISCHARGE.notna().sum() > 3650 else "LEVEL"
        s = d.set_index("DATE")[var].dropna()
        if len(s) < 3650:
            continue
        doy = s.index.dayofyear.to_numpy()
        vals = s.to_numpy()
        for b in range(0, 366, 5):
            centre = b + 2
            dist = np.minimum(np.abs(doy - centre), 366 - np.abs(doy - centre))
            v = vals[dist <= 7]
            if len(v) < 60:
                continue
            rows.append([sid, var, b, *np.quantile(v, qs), float(v.max()), len(np.unique(s.index.year))])
    cols = ["station", "var", "bin"] + [f"q{int(q * 100):02d}" for q in qs] + ["max", "years"]
    return pd.DataFrame(rows, columns=cols)


def percentile_of(value: float, row: pd.Series) -> float:
    qs = np.array([0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99])
    xs = row[[f"q{int(q * 100):02d}" for q in qs]].to_numpy(dtype=float)
    if value <= xs[0]:
        return 0.05 * value / xs[0] if xs[0] > 0 else 0.0
    if value >= xs[-1]:
        return 0.99 + 0.01 * min(1, (value - xs[-1]) / max(row["max"] - xs[-1], 1e-6))
    return float(np.interp(value, xs, qs))


def flood_frequency() -> dict:
    out = {}
    for sid, name in FLOOD_GAUGES.items():
        f = RAW / "river_daily" / f"{sid}.parquet"
        if not f.exists():
            continue
        d = pd.read_parquet(f)
        d["DATE"] = pd.to_datetime(d.DATE)
        q = d.set_index("DATE").DISCHARGE.dropna()
        if len(q) < 3650:
            continue
        wy = q.index.year + (q.index.month >= 10)          # water year Oct–Sep
        amax = q.groupby(wy).max()
        complete = q.groupby(wy).size() >= 300
        amax = amax[complete]
        event = q[(q.index >= "2021-11-10") & (q.index <= "2021-11-25")]
        peak = float(event.max()) if len(event) else None
        pre = amax[amax.index < 2022]
        pre = pre[pre.index != 2022]
        res = {"name": name, "years": [int(amax.index.min()), int(amax.index.max())], "n_years": int(len(amax)),
               "peak_2021": r(peak, 1), "previous_record": r(float(pre[pre.index < 2022].max()), 1) if len(pre) else None}
        if peak and len(pre) >= 20:
            # Gumbel (2-parameter) is the primary fit: robust for 30–90 year records. A 3-parameter GEV is
            # reported as a sensitivity check; its shape is poorly constrained and can bound the tail.
            loc, scale = stats.gumbel_r.fit(pre.to_numpy())
            rp = 1 / max(stats.gumbel_r.sf(peak, loc, scale), 1e-9)
            rng = np.random.default_rng(0)
            rps = []
            for _ in range(400):
                sample = rng.choice(pre.to_numpy(), size=len(pre), replace=True)       # nonparametric bootstrap
                lb, sb = stats.gumbel_r.fit(sample)
                rps.append(1 / max(stats.gumbel_r.sf(peak, lb, sb), 1e-9))
            c, gl, gs = stats.genextreme.fit(pre.to_numpy())
            gev_sf = stats.genextreme.sf(peak, c, gl, gs)
            res.update({"return_period": r(min(rp, 1e5), 0), "rp_lo": r(min(np.percentile(rps, 10), 1e5), 0),
                        "rp_hi": r(min(np.percentile(rps, 90), 1e5), 0),
                        "gev_return_period": r(1 / gev_sf, 0) if gev_sf > 1e-9 else None,
                        "gev_bounded": bool(gev_sf <= 1e-9), "beyond_record_ratio": r(peak / float(pre.max()), 2),
                        "curve": [[t, r(stats.gumbel_r.isf(1 / t, loc, scale), 1)] for t in [2, 5, 10, 25, 50, 100, 200, 500]]})
        # hydrograph Oct 15 – Dec 15 2021 vs typical
        win = q[(q.index >= "2021-10-15") & (q.index <= "2021-12-15")]
        typ = []
        for d_ in win.index:
            same = q[(q.index.dayofyear == d_.dayofyear) & (q.index.year < 2021)]
            typ.append([d_.date().isoformat(), r(float(win[d_]), 2), r(same.median(), 2) if len(same) else None,
                        r(same.quantile(0.9), 2) if len(same) else None])
        res["hydrograph"] = typ
        res["annual_max"] = [[int(y), r(float(v), 1)] for y, v in amax.items()]
        out[sid] = res
        print(f"  flood {sid} {name[:30]:<30} peak {peak} RP {res.get('return_period')} ({res.get('rp_lo')}–{res.get('rp_hi')})")
    return out


# ============================================================================= quakes

def haversine_km(lon1, lat1, lon2, lat2):
    lon1, lat1, lon2, lat2 = map(np.radians, (lon1, lat1, lon2, lat2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * np.arcsin(np.sqrt(a))


def gutenberg_richter(cat: pd.DataFrame) -> dict:
    out = {}
    cat = cat.copy()
    cat["t"] = pd.to_datetime(cat.time, utc=True)
    span_end = cat.t.max()
    for key, z in QUAKE_ZONES.items():
        dist = haversine_km(cat.longitude, cat.latitude, *z["center"])
        e = cat[dist <= z["radius_km"]]
        mags = e.mag.dropna().round(1).to_numpy()
        if len(mags) < 50:
            continue
        bins = np.arange(2.5, mags.max() + 0.11, 0.1)
        hist = np.histogram(mags, bins=np.append(bins, bins[-1] + 0.1) - 0.05)[0]
        mc = round(float(bins[np.argmax(hist)]) + 0.2, 1)
        sel = e[e.mag >= mc - 0.05]
        years = (span_end - pd.Timestamp("1970-01-01", tz="UTC")).days / 365.25
        m = sel.mag.to_numpy()
        b = math.log10(math.e) / (m.mean() - (mc - 0.05))
        rng = np.random.default_rng(1)
        bs = [math.log10(math.e) / (s.mean() - (mc - 0.05)) for s in (rng.choice(m, len(m)) for _ in range(500))]
        rate_mc = len(m) / years
        a = math.log10(rate_mc) + b * mc

        def prob(mag, yrs=50, bb=b, aa=a):
            lam = 10 ** (aa - bb * mag)
            return 1 - math.exp(-lam * yrs), lam
        probs = {}
        for mag in (5.0, 6.0, 7.0):
            p, lam = prob(mag)
            lo = prob(mag, bb=np.percentile(bs, 90), aa=math.log10(rate_mc) + np.percentile(bs, 90) * mc)[0]
            hi = prob(mag, bb=np.percentile(bs, 10), aa=math.log10(rate_mc) + np.percentile(bs, 10) * mc)[0]
            probs[f"M{int(mag)}"] = {"p50": r(p, 3), "lo": r(lo, 3), "hi": r(hi, 3), "return_years": r(1 / lam, 0)}
        mags_axis = np.round(np.arange(mc, max(m.max(), mc) + 0.05, 0.1), 1)
        fmd = [[float(x), r((e.mag >= x - 0.05).sum() / years, 4)] for x in np.round(np.arange(2.5, e.mag.max() + 0.05, 0.1), 1)]
        biggest = e.sort_values("mag", ascending=False).head(5)
        out[key] = {"name": z["name"], "radius_km": z["radius_km"], "center": z["center"], "n": int(len(e)), "mc": mc,
                    "b": r(b, 3), "b_lo": r(np.percentile(bs, 10), 3), "b_hi": r(np.percentile(bs, 90), 3), "a": r(a, 3),
                    "years": r(years, 1), "probs": probs, "fmd": fmd,
                    "fit": [[float(x), r(10 ** (a - b * x), 5)] for x in np.round(np.arange(mc, 8.05, 0.1), 1)],
                    "biggest": [[row.time[:10], r(row.mag, 1), row.place, r(row.depth, 0)] for row in biggest.itertuples()]}
        print(f"  quakes {key:<10} n={len(e)} Mc={mc} b={b:.2f} P(M6+,50y)={probs['M6']['p50']}")
    return out


# ============================================================================= main

def main(retrain: bool) -> None:
    DERIVED.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).isoformat(timespec="minutes")

    # ---------- wildfire model (training table is derived once from the slow history fetch)
    train_path, clim_path = DERIVED / "fire_training.parquet", DERIVED / "fire_tmax_clim.json"
    if retrain or not train_path.exists():
        hist = pd.read_parquet(RAW / "fire_history.parquet")
        weather = centre_weather(pd.read_parquet(RAW / "fire_weather.parquet"))
        train, clims = fire_table(hist, weather)
        train.to_parquet(train_path)
        clim_path.write_text(json.dumps({k: v.round(2).tolist() for k, v in clims.items()}))
        # area burned by year (all years) for the long-history chart
        h = hist[hist.FIRE_TYPE == "Fire"].copy()
        h["cause"] = np.where(h.FIRE_CAUSE.str.lower().str.startswith("light"), "lightning", "people")
        yearly = h.groupby(["FIRE_YEAR", "cause"]).agg(n=("FIRE_NUMBER", "size"), ha=("CURRENT_SIZE", "sum")).unstack(fill_value=0)
        yearly.columns = [f"{a}_{b}" for a, b in yearly.columns]
        yearly.reset_index().to_parquet(DERIVED / "fire_yearly.parquet", index=False)
    train = pd.read_parquet(train_path)
    clims = {k: pd.Series(v, index=range(1, len(v) + 1)) for k, v in json.loads(clim_path.read_text()).items()}
    train = train[train.year < date.today().year]

    # current season (out of sample): fires recorded this year with observed weather
    now_f = pd.read_parquet(RAW / "fires_now.parquet")
    wr = centre_weather(pd.read_parquet(RAW / "fire_weather_recent.parquet"))
    hist_w = wr      # recent weather (Nov 1 last year → today) covers the whole current season
    cur_rows = []
    nf = now_f[now_f.FIRE_TYPE == "Fire"].copy()
    nf["centre"] = nf.FIRE_NUMBER.str[0]
    nf["date"] = pd.to_datetime(nf.IGNITION_DATE.str[:10], errors="coerce")
    nf["cause"] = np.where(nf.FIRE_CAUSE.str.lower().str.startswith("light"), "lightning", "people")
    cnt = nf.groupby(["centre", "cause", "date"]).size()
    yr = date.today().year
    for key in FIRE_CENTRES:
        w = hist_w[key]
        w = w[w.index.year >= yr - 1]
        feat, _ = features(w, clims[key])
        feat = feat[(feat.index.year == yr) & feat.doy.between(*SEASON)].dropna(subset=["tmax"])
        for cause in CAUSES:
            d = feat.copy()
            d["centre"], d["centre_code"], d["cause"], d["year"] = key, CENTRE_CODES[key], cause, yr
            d["week"] = ((d.doy - 1) // 7).astype(int)
            d["n"] = cnt.reindex(pd.MultiIndex.from_product([[key], [cause], d.index])).fillna(0).to_numpy()
            cur_rows.append(d)
    current = pd.concat(cur_rows) if cur_rows else pd.DataFrame()
    models, fire_card = fire_model(train, current)
    forecast = fire_forecast(models, wr, clims)
    yearly = pd.read_parquet(DERIVED / "fire_yearly.parquet")

    # ---------- live layers
    fires = now_f[now_f.FIRE_TYPE == "Fire"].copy()
    fires_out = [{"id": f.FIRE_NUMBER, "name": sv(f.INCIDENT_NAME) if sv(f.INCIDENT_NAME) not in (None, f.FIRE_NUMBER) else sv(f.GEOGRAPHIC_DESCRIPTION),
                  "place": sv(f.GEOGRAPHIC_DESCRIPTION), "status": sv(f.FIRE_STATUS), "cause": sv(f.FIRE_CAUSE), "ha": r(f.CURRENT_SIZE, 1),
                  "ignited": sv(f.IGNITION_DATE, 10), "out": sv(f.FIRE_OUT_DATE, 10),
                  "centre": FIRE_CENTRES.get(f.FIRE_NUMBER[0], {}).get("name"), "of_note": f.FIRE_OF_NOTE_IND == "Y",
                  "url": f.FIRE_URL, "lon": r(f.LONGITUDE, 4), "lat": r(f.LATITUDE, 4)} for f in fires.itertuples()]
    polys = json.loads((RAW / "fire_polys_now.geojson").read_text(encoding="utf-8"))
    for ft in polys["features"]:
        p = ft["properties"]
        ft["properties"] = {"id": p.get("FIRE_NUMBER"), "ha": p.get("FIRE_SIZE_HECTARES"), "status": p.get("FIRE_STATUS")}
        ft["geometry"] = round_geom(ft["geometry"])

    st = pd.read_parquet(RAW / "river_stations.parquet")
    clim_file = DERIVED / "river_climatology.parquet"
    if retrain or not clim_file.exists():
        river_climatology(st).to_parquet(clim_file, index=False)
    rclim = pd.read_parquet(clim_file)
    rnow = pd.read_parquet(RAW / "rivers_now.parquet").merge(st, on="STATION_NUMBER", how="left")
    today_bin = (date.today().timetuple().tm_yday - 1) // 5 * 5
    rivers = []
    for row in rnow.itertuples():
        c = rclim[(rclim.station == row.STATION_NUMBER) & (rclim.bin == today_bin)]
        pct, var, val = None, None, None
        if len(c):
            c = c.iloc[0]
            var = c["var"]
            val = row.DISCHARGE if var == "DISCHARGE" else row.LEVEL
            if val is not None and np.isfinite(val):
                pct = percentile_of(float(val), c)
        if val is None or (isinstance(val, float) and not np.isfinite(val)):
            val = row.DISCHARGE if row.DISCHARGE == row.DISCHARGE else row.LEVEL
            var = "DISCHARGE" if row.DISCHARGE == row.DISCHARGE else "LEVEL"
        rivers.append({"id": row.STATION_NUMBER, "name": str(row.STATION_NAME).title(), "lon": r(row.lon, 4), "lat": r(row.lat, 4),
                       "value": r(val, 2), "unit": "m³/s" if var == "DISCHARGE" else "m", "pct": r(pct, 3),
                       "median": r(c["q50"], 2) if pct is not None else None, "years": int(c["years"]) if pct is not None else None,
                       "time": row.DATETIME.isoformat(), "area": r(row.DRAINAGE_AREA_GROSS, 0)})

    qr = pd.read_parquet(RAW / "quakes_recent.parquet")
    quakes_recent = [[q.time, r(q.longitude, 3), r(q.latitude, 3), r(q.depth, 1), r(q.mag, 1), q.place, q.id] for q in qr.itertuples()]
    roads = pd.read_parquet(RAW / "roads_now.parquet")
    roads["closed"] = roads.state.fillna("").str.contains("CLOSED") | roads.subtypes.fillna("").str.contains("CLOSED")
    roads_out = roads[(roads.severity.isin(["MAJOR", "MODERATE"])) | roads.closed | (roads.type == "INCIDENT")]
    roads_out = [{"id": x.id, "type": x.type, "subtypes": x.subtypes, "severity": x.severity, "road": x.road, "state": x.state,
                  "closed": bool(x.closed), "description": x.description, "lon": r(x.lon, 4), "lat": r(x.lat, 4)} for x in roads_out.itertuples()]

    # floods and quake recurrence need the slow history fetch; keep the published JSON when it's absent (CI)
    floods = flood_frequency() if (RAW / "river_daily").exists() else None
    gr = gutenberg_richter(pd.read_parquet(RAW / "quakes_catalog.parquet")) if (RAW / "quakes_catalog.parquet").exists() else None

    active = [f for f in fires_out if f["status"] in ("Out of Control", "Being Held", "Under Control")]
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    summary = {
        "generated": generated,
        "fires_active": len(active), "fires_out_of_control": sum(f["status"] == "Out of Control" for f in fires_out),
        "fires_season": len(fires_out), "ha_season": r(sum(f["ha"] or 0 for f in fires_out), 0),
        "rivers_high": sum(1 for x in rivers if x["pct"] is not None and x["pct"] >= 0.9),
        "rivers_ranked": sum(1 for x in rivers if x["pct"] is not None),
        "quakes_week": sum(1 for q in quakes_recent if q[0] >= week_ago and (q[4] or 0) >= 2.5),
        "quakes_week_max": max([q[4] or 0 for q in quakes_recent if q[0] >= week_ago] or [0]),
        "road_closures": sum(1 for x in roads_out if x["closed"]),
    }
    dump("live.json", {"summary": summary, "fires": fires_out, "rivers": rivers, "quakes": quakes_recent, "roads": roads_out})
    dump("fire_perimeters.json", polys)
    dump("wildfire.json", {"card": fire_card, "forecast": forecast, "centres": {k: v["name"] for k, v in FIRE_CENTRES.items()},
                           "yearly": yearly.round(1).to_dict("records"), "features": FEATURES, "generated": generated})
    if floods is not None:
        dump("floods.json", floods)
    if gr is not None:
        dump("quakes.json", gr)


def simplify_ring(pts: list, tol: float) -> list:
    """Ramer–Douglas–Peucker on one ring (lon/lat degrees)."""
    a = np.asarray(pts, dtype=float)
    if len(a) <= 4:
        return pts
    keep = np.zeros(len(a), dtype=bool)
    keep[0] = keep[-1] = True
    # closed ring: anchor on the vertex farthest from the start so no segment has zero length
    far = int(np.argmax(np.hypot(*(a - a[0]).T)))
    keep[far] = True
    stack = [(0, far), (far, len(a) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        seg = a[j] - a[i]
        norm = np.hypot(*seg) or 1e-12
        rel = a[i + 1:j] - a[i]
        d = np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / norm     # 2-D cross product
        k = int(np.argmax(d))
        if d[k] > tol:
            keep[i + 1 + k] = True
            stack += [(i, i + 1 + k), (i + 1 + k, j)]
    out = a[keep]
    return out.tolist() if len(out) >= 4 else pts


def round_geom(g, nd=4, tol=0.0008):
    def rings(c):
        return [[round(x, nd), round(y, nd)] for x, y in simplify_ring(c, tol)]
    if g["type"] == "Polygon":
        coords = [rings(r_) for r_ in g["coordinates"]]
    elif g["type"] == "MultiPolygon":
        coords = [[rings(r_) for r_ in poly] for poly in g["coordinates"]]
    else:
        coords = g["coordinates"]
    return {"type": g["type"], "coordinates": coords}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--retrain", action="store_true", help="rebuild the training table and river climatology from raw history")
    main(ap.parse_args().retrain)
