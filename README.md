# Fire, Water & Rock

Wildfire, river, earthquake and highway hazard twin. Region: BC / Pacific Northwest.

**Live dashboard: https://markandrewjenkins.github.io/fire-water-rock/**

Built only on free, open government and citizen-science data. A Python pipeline fetches and models the data,
and a static Vite + d3 + MapLibre page presents it. GitHub Actions refreshes everything daily and publishes it
to GitHub Pages.

## Method in brief

- **Wildfire starts:** Daily new fires per BC Wildfire fire centre and cause, April–October 2000–2025 (≈42k fires).
  - Modelled with Poisson gradient boosting on the centre's ECCC station heat, rain (1/7/30 days), days since rain and a dryness index.
  - Leave-one-season-out validation against a centre × week climatology. Deviance explained is 52% vs 31% for lightning fires and 24% vs 14% for people-caused fires.
  - The current season is a true out-of-sample test. The 7-day outlook runs on ECCC GEM forecasts.
- **Rivers:** The latest real-time reading at ~430 gauges is ranked against that gauge's 1991–present daily means within ±7 days of the date.
- **Floods:** Gumbel fits to pre-2021 water-year annual maxima, with bootstrap ranges, give return periods for the November 2021 atmospheric-river peaks. A GEV fit is kept as a sensitivity check.
- **Earthquakes:** Gutenberg–Richter recurrence (Aki–Utsu b-value, magnitude of completeness by maximum curvature + 0.2) from the USGS catalogue since 1970, with 50-year Poisson odds.
- **Refreshing:** `fetch now` + `build` daily. `fetch history` + `build --retrain` occasionally rebuild the derived tables.

## Design

The page has a Classic design and a themed alternative, **Field Ops** (field notebook with ics forms / emergency operations centre), switched with the
button in the top bar or with `?skin=alt` / `?skin=classic` in the URL. Each has a day and a night version.

## Running locally

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
.venv/Scripts/python -m pipelines.hazards.fetch now
.venv/Scripts/python -m pipelines.hazards.build
cd site && npm ci && npm run dev
```

Data licences are listed at the foot of the dashboard.
