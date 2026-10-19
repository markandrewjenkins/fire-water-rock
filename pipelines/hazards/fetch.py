"""Download inputs for Fire, Water & Rock.

  python -m pipelines.hazards.fetch [now|history|all]

  now      current fires and perimeters, latest river readings, recent quakes, road events,
           recent weather for the fire centres (fast; runs daily in CI)
  history  fire incidents since 1950, fire-centre weather since 1999, river daily-mean
           history, the full quake catalogue (slow; run occasionally)
"""
from __future__ import annotations

import io
import sys
import time
from datetime import date, datetime, timedelta, timezone

import pandas as pd
import requests

from pipelines.common.eccc import climate_daily
from pipelines.common.http import USER_AGENT, get_json

from .config import (FIRE_CENTRES, FIRE_HISTORY, FIRE_POINTS_NOW, FIRE_POLYS_NOW, FIRE_TRAIN_START, FLOOD_GAUGES,
                     OPEN511, QUAKE_BBOX, RAW, RIVER_CLIM_START, WFS)

API = "https://api.weather.gc.ca/collections"
S = requests.Session()
S.headers["User-Agent"] = USER_AGENT


def wfs_all(type_name: str, props: list[str] | None = None, cql: str | None = None, page: int = 10000) -> list[dict]:
    feats, start = [], 0
    while True:
        params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeName": f"pub:{type_name}",
                  "outputFormat": "json", "srsName": "EPSG:4326", "count": page, "startIndex": start, "sortBy": "OBJECTID"}
        if props:
            params["propertyName"] = ",".join(props)
        if cql:
            params["CQL_FILTER"] = cql
        d = get_json(WFS, params, min_interval=0.5, timeout=180)
        batch = d.get("features", [])
        feats += batch
        print(f"    {type_name.split('.')[-1]}: {len(feats):,}", flush=True)
        if len(batch) < page:
            return feats
        start += page


def save(df: pd.DataFrame, name: str) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    df.to_parquet(RAW / f"{name}.parquet", index=False)


# ----------------------------------------------------------------------------- fires

def fire_history() -> None:
    props = ["FIRE_NUMBER", "FIRE_YEAR", "IGNITION_DATE", "FIRE_CAUSE", "FIRE_TYPE", "CURRENT_SIZE", "LATITUDE", "LONGITUDE"]
    feats = wfs_all(FIRE_HISTORY, props)
    save(pd.DataFrame([f["properties"] for f in feats]), "fire_history")


def fires_now() -> None:
    pts = wfs_all(FIRE_POINTS_NOW)
    save(pd.DataFrame([f["properties"] for f in pts]), "fires_now")
    polys = wfs_all(FIRE_POLYS_NOW)
    import json
    (RAW / "fire_polys_now.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": polys}), encoding="utf-8")


# ----------------------------------------------------------------------------- weather

def fire_weather(start: str) -> pd.DataFrame:
    frames = []
    for key, fc in FIRE_CENTRES.items():
        for sid in fc["stations"]:
            df = climate_daily(sid, start=start)
            df["station"], df["centre"] = sid, key
            frames.append(df)
            print(f"    {fc['name']:<14} {sid}: {len(df):,} days", flush=True)
    return pd.concat(frames, ignore_index=True)


# ----------------------------------------------------------------------------- rivers

def river_stations() -> pd.DataFrame:
    d = get_json(f"{API}/hydrometric-stations/items", {"f": "json", "PROV_TERR_STATE_LOC": "BC", "STATUS_EN": "Active",
                                                        "REAL_TIME": 1, "limit": 2000})
    rows = [{**f["properties"], "lon": f["geometry"]["coordinates"][0], "lat": f["geometry"]["coordinates"][1]} for f in d["features"]]
    df = pd.DataFrame(rows)[["STATION_NUMBER", "STATION_NAME", "DRAINAGE_AREA_GROSS", "lon", "lat"]]
    save(df, "river_stations")
    return df


def rivers_now() -> None:
    """Latest reading per real-time station (last 6 hours)."""
    since = (datetime.now(timezone.utc) - timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows, offset = [], 0
    while True:
        d = get_json(f"{API}/hydrometric-realtime/items", {
            "f": "json", "PROV_TERR_STATE_LOC": "BC", "datetime": f"{since}/..", "limit": 10000, "offset": offset,
            "properties": "STATION_NUMBER,DATETIME,LEVEL,DISCHARGE"}, min_interval=0.5, timeout=180)
        batch = d.get("features", [])
        rows += [f["properties"] for f in batch]
        if len(batch) < 10000:
            break
        offset += 10000
    df = pd.DataFrame(rows)
    df["DATETIME"] = pd.to_datetime(df.DATETIME)
    latest = df.sort_values("DATETIME").groupby("STATION_NUMBER").tail(1)
    # also each station's mean over the last 24h-ish window for a steadier daily comparison
    save(latest.reset_index(drop=True), "rivers_now")
    print(f"    rivers now: {len(latest)} stations reporting", flush=True)


def river_history(stations: list[str], start: str) -> None:
    out = RAW / "river_daily"
    out.mkdir(parents=True, exist_ok=True)
    for i, sid in enumerate(stations):
        f = out / f"{sid}.parquet"
        if f.exists():
            continue
        rows, offset = [], 0
        while True:
            d = get_json(f"{API}/hydrometric-daily-mean/items", {
                "f": "json", "STATION_NUMBER": sid, "datetime": f"{start}/..", "limit": 10000, "offset": offset,
                "properties": "DATE,LEVEL,DISCHARGE"}, min_interval=0.3, timeout=180)
            batch = d.get("features", [])
            rows += [x["properties"] for x in batch]
            if len(batch) < 10000:
                break
            offset += 10000
        pd.DataFrame(rows, columns=["DATE", "LEVEL", "DISCHARGE"]).to_parquet(f, index=False)
        if i % 25 == 0:
            print(f"    river history {i + 1}/{len(stations)}", flush=True)


# ----------------------------------------------------------------------------- quakes & roads

def quakes(start: str, minmag: float) -> pd.DataFrame:
    s, w, n, e = QUAKE_BBOX
    r = S.get("https://earthquake.usgs.gov/fdsnws/event/1/query", params={
        "format": "csv", "starttime": start, "minlatitude": s, "maxlatitude": n, "minlongitude": w, "maxlongitude": e,
        "minmagnitude": minmag, "orderby": "time-asc"}, timeout=180)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    return df[["time", "latitude", "longitude", "depth", "mag", "magType", "place", "id"]]


def roads_now() -> None:
    events, offset = [], 0
    while True:
        d = get_json(OPEN511, {"format": "json", "status": "ACTIVE", "limit": 500, "offset": offset})
        batch = d.get("events", [])
        events += batch
        if len(batch) < 500:
            break
        offset += 500
    rows = []
    for e in events:
        geom = e.get("geography") or {}
        coords = geom.get("coordinates")
        if geom.get("type") == "Point":
            lon, lat = coords
        elif geom.get("type") == "LineString" and coords:
            lon, lat = coords[len(coords) // 2]
        elif geom.get("type") == "MultiLineString" and coords:
            lon, lat = coords[0][len(coords[0]) // 2]
        else:
            continue
        road = (e.get("roads") or [{}])[0]
        rows.append({"id": e.get("id"), "type": e.get("event_type"), "subtypes": ",".join(e.get("event_subtypes") or []),
                     "severity": e.get("severity"), "road": road.get("name"), "state": road.get("state"),
                     "description": (e.get("description") or "")[:400], "updated": e.get("updated"), "lon": lon, "lat": lat})
    save(pd.DataFrame(rows), "roads_now")
    print(f"    road events: {len(rows)}", flush=True)


# ----------------------------------------------------------------------------- entry points

def now() -> None:
    print("Fires now…"); fires_now()
    print("Rivers now…"); river_stations(); rivers_now()
    print("Quakes (30 days)…"); save(quakes((date.today() - timedelta(days=30)).isoformat(), 1.0), "quakes_recent")
    print("Roads…"); roads_now()
    start = date(date.today().year - 1, 11, 1).isoformat()      # covers this whole fire season + lead-in
    print(f"Fire-centre weather since {start}…")
    save(fire_weather(start), "fire_weather_recent")


def history() -> None:
    print("Fire history (all years)…"); fire_history()
    print(f"Fire-centre weather since {FIRE_TRAIN_START - 1}…"); save(fire_weather(f"{FIRE_TRAIN_START - 1}-01-01"), "fire_weather")
    print("Quake catalogue since 1970…"); save(quakes("1970-01-01", 2.5), "quakes_catalog")
    st = river_stations()
    print("River history (flood gauges, full record)…"); river_history(list(FLOOD_GAUGES), "1900-01-01")
    print(f"River history (all real-time stations since {RIVER_CLIM_START})…")
    river_history([s for s in st.STATION_NUMBER if s not in FLOOD_GAUGES], f"{RIVER_CLIM_START}-01-01")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("history", "all"):
        history()
    if what in ("now", "all"):
        now()
