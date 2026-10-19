import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as d3 from "d3";
import { initTheme, initSkin, cssVar, tooltip, el, tipRow, loadJSON, fmtInt } from "../shared/ui.js";
import { initFieldOps } from "./skin.js";

const DATA = "./data/hazards/";
const STATUS = [
  ["Out of Control", "--critical"], ["Being Held", "--serious"], ["Under Control", "--warning"], ["Out", "--muted"],
];
const FEATURE_LABEL = {
  tmax: "Today's high", tmax_3d: "3-day average high", tmax_anom: "Heat vs normal", precip: "Today's rain", precip_7d: "Rain, last 7 days",
  precip_30d: "Rain, last 30 days", dry_days: "Days since rain", dryness: "Dryness index", doy_sin: "Time of year (a)", doy_cos: "Time of year (b)",
  centre_code: "Fire centre",
};
const MAP_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };

const isDark = initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));
const tip = tooltip();
const state = { zone: "victoria", layers: { fires: true, perimeters: true, rivers: true, quakes: true, roads: true } };
let live, perims, wildfire, floods, quakes, map;

const fmt1 = d3.format(",.1f"), fmt0 = d3.format(",.0f");
const pctLabel = (p) => (p >= 0.99 ? "near record high" : p >= 0.9 ? "very high" : p >= 0.75 ? "above normal" : p > 0.25 ? "normal" : p > 0.1 ? "below normal" : "very low");
const riverColor = d3.scaleLinear([0, 0.1, 0.25, 0.5, 0.75, 0.9, 1], ["#a8641b", "#d49a4a", "#e2cfa6", "#d8d8d4", "#9dc3ea", "#3987e5", "#0d366b"]);
const statusVar = (s) => (STATUS.find((x) => x[0] === s) || [s, "--muted"])[1];

init().catch((err) => {
  console.error(err);
  document.querySelector("main").prepend(el("div", { class: "wrap", style: { padding: "24px", color: "var(--accent)" } }, `Could not load data: ${err.message}`));
});

async function init() {
  [live, perims, wildfire, floods, quakes] = await Promise.all(
    ["live", "fire_perimeters", "wildfire", "floods", "quakes"].map((n) => loadJSON(`${DATA}${n}.json`)));
  renderTiles();
  buildLayerToggles();
  renderSideLists();
  initMap();
  buildZones();
  renderAll();
  initFieldOps({ get: () => ({ live, floods, wildfire, quakes, map }), isDark });
  document.getElementById("generated").textContent = `Data refreshed ${new Date(live.summary.generated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}`;
  let raf, lastW = 0;
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w === lastW) return;
    lastW = w;
    cancelAnimationFrame(raf); raf = requestAnimationFrame(renderAll);
  }).observe(document.querySelector("main"));
  window.addEventListener("themechange", () => { map?.setStyle(isDark() ? MAP_STYLE.dark : MAP_STYLE.light); renderAll(); });
}

function renderAll() {
  renderOutlook();
  renderFireMetrics();
  renderSeason();
  renderSeasons();
  renderImportance();
  renderBurned();
  renderHydrographs();
  renderRP();
  renderQuakes();
}

// ------------------------------------------------------------------ hero tiles
function renderTiles() {
  const s = live.summary;
  document.getElementById("asof").textContent = `British Columbia · ${new Date(s.generated).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" })}`;
  const tile = (glyph, label, value, sub) => el("div", { class: "card tile" },
    el("div", { class: "label" }, el("i", { class: "glyph", style: { background: `var(${glyph})` } }), label),
    el("div", { class: "value" }, value), el("div", { class: "sub" }, sub));
  document.getElementById("tiles").replaceChildren(
    tile("--fire", "Active wildfires", fmtInt.format(s.fires_active), `${s.fires_out_of_control} out of control · ${fmtInt.format(s.fires_season)} fires this season, ${fmtInt.format(s.ha_season)} ha`),
    tile("--water", "Rivers running high", `${s.rivers_high}`, `of ${s.rivers_ranked} ranked gauges are in their top 10% for the date`),
    tile("--rock", "Earthquakes this week", `${s.quakes_week}`, s.quakes_week ? `M2.5 and up · largest M${s.quakes_week_max.toFixed(1)}` : "M2.5 and up in and around BC"),
    tile("--ink-2", "Highway closures", `${s.road_closures}`, "DriveBC full closures right now"));
}

// ------------------------------------------------------------------ map
function buildLayerToggles() {
  const defs = [
    ["fires", "Wildfires", STATUS.map(([s, v]) => [s, `var(${v})`])],
    ["perimeters", "Fire perimeters", []],
    ["rivers", "River gauges vs normal", [["very low", riverColor(0.05)], ["normal", riverColor(0.5)], ["very high", riverColor(0.95)]]],
    ["quakes", "Earthquakes, 30 days", [["size = magnitude", "var(--rock)"]]],
    ["roads", "Highway closures & incidents", [["closed", "var(--ink)"], ["incident", "var(--muted)"]]],
  ];
  document.getElementById("layers").replaceChildren(...defs.map(([k, label, keys]) => el("div", {},
    el("label", {}, el("input", { type: "checkbox", checked: state.layers[k], onchange: (e) => { state.layers[k] = e.target.checked; applyVisibility(); } }), label),
    keys.length ? el("div", { class: "key" }, ...keys.map(([t, c]) => el("span", {}, el("i", { style: { background: c } }), t))) : null)));
}

function initMap() {
  map = new maplibregl.Map({ container: "map", style: isDark() ? MAP_STYLE.dark : MAP_STYLE.light, center: [-124.5, 52.5], zoom: 4.6,
    attributionControl: { compact: true }, cooperativeGestures: matchMedia("(pointer: coarse)").matches });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));
  map.on("style.load", addLayers);
  const pop = new maplibregl.Popup({ maxWidth: "300px" });
  const show = (layer, build) => {
    map.on("click", layer, (e) => pop.setLngLat(e.lngLat).setDOMContent(build(e.features[0].properties)).addTo(map));
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  };
  show("fires", (p) => el("div", { class: "popup" }, el("h4", {}, p.name || p.id),
    el("div", { class: "row" }, el("span", { class: "badge" }, el("i", { style: { background: `var(${statusVar(p.status)})` } }), p.status), ` · ${p.cause}`),
    el("div", { class: "row" }, `${fmt1(+p.ha || 0)} ha · ignited ${p.ignited}${p.out ? ` · out ${p.out}` : ""}`),
    el("div", { class: "row" }, `${p.centre} Fire Centre · ${p.id}`),
    el("a", { href: p.url, target: "_blank", rel: "noopener" }, "BC Wildfire Service ↗")));
  show("rivers", (p) => el("div", { class: "popup" }, el("h4", {}, p.name),
    el("div", { class: "row" }, `${p.value} ${p.unit} now${p.median != null && p.median !== "null" ? ` · typical ${p.median} ${p.unit}` : ""}`),
    el("div", { class: "row" }, p.pct != null && p.pct !== "null" ? `${Math.round(p.pct * 100)}th percentile for the date: ${pctLabel(+p.pct)} (${p.years} yrs of record)` : "Not enough history to rank"),
    el("a", { href: `https://wateroffice.ec.gc.ca/report/real_time_e.html?stn=${p.id}`, target: "_blank", rel: "noopener" }, "Water Office ↗")));
  show("quakes", (p) => el("div", { class: "popup" }, el("h4", {}, `M${(+p.mag).toFixed(1)}`),
    el("div", { class: "row" }, p.place), el("div", { class: "row" }, `${new Date(p.time).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })} · ${p.depth} km deep`),
    el("a", { href: `https://earthquake.usgs.gov/earthquakes/eventpage/${p.id}`, target: "_blank", rel: "noopener" }, "USGS event page ↗")));
  show("roads", (p) => el("div", { class: "popup" }, el("h4", {}, `${p.road || "Road"}: ${p.closed === true || p.closed === "true" ? "closed" : (p.type || "").toLowerCase()}`),
    el("div", { class: "row" }, p.description)));
}

function addLayers() {
  const fc = (features) => ({ type: "FeatureCollection", features });
  const pt = (lon, lat, props) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });
  const statusOrder = (s) => STATUS.findIndex((x) => x[0] === s);
  const fires = live.fires.filter((f) => f.lon != null).sort((a, b) => statusOrder(b.status) - statusOrder(a.status));
  map.addSource("perimeters", { type: "geojson", data: perims });
  map.addSource("fires", { type: "geojson", data: fc(fires.map((f) => pt(f.lon, f.lat, f))) });
  map.addSource("rivers", { type: "geojson", data: fc(live.rivers.filter((r) => r.lon != null).map((r) => pt(r.lon, r.lat, r))) });
  map.addSource("quakes", { type: "geojson", data: fc(live.quakes.map(([time, lon, lat, depth, mag, place, id]) => pt(lon, lat, { time, depth, mag, place, id }))) });
  map.addSource("roads", { type: "geojson", data: fc(live.roads.map((r) => pt(r.lon, r.lat, r))) });
  const c = (v) => cssVar(v);
  map.addLayer({ id: "perimeters", type: "fill", source: "perimeters", paint: { "fill-color": c("--fire"), "fill-opacity": 0.28, "fill-outline-color": c("--fire") } });
  map.addLayer({ id: "rivers", type: "circle", source: "rivers", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3.2, 9, 7],
    "circle-color": ["case", ["==", ["get", "pct"], null], c("--axis"),
      ["interpolate", ["linear"], ["get", "pct"], ...[0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].flatMap((v) => [v, riverColor(v)])]],
    "circle-stroke-color": c("--surface"), "circle-stroke-width": 1.2 } });
  map.addLayer({ id: "fires", type: "circle", source: "fires", paint: {
    "circle-radius": ["interpolate", ["linear"], ["sqrt", ["max", ["coalesce", ["get", "ha"], 0], 0.01]], 0, 2.5, 30, 9, 300, 24],
    "circle-color": ["match", ["get", "status"], ...STATUS.flatMap(([s, v]) => [s, c(v)]), c("--muted")],
    "circle-opacity": ["match", ["get", "status"], "Out", 0.35, 0.9],
    "circle-stroke-color": c("--surface"), "circle-stroke-width": 1 } });
  map.addLayer({ id: "quakes", type: "circle", source: "quakes", paint: {
    "circle-radius": ["interpolate", ["exponential", 1.8], ["get", "mag"], 1, 2, 3, 5, 5, 14, 7, 30],
    "circle-color": c("--rock"), "circle-opacity": 0.35, "circle-stroke-color": c("--rock"), "circle-stroke-width": 1.2 } });
  map.addLayer({ id: "roads", type: "circle", source: "roads", paint: {
    "circle-radius": ["case", ["get", "closed"], 5.5, 3.5], "circle-color": ["case", ["get", "closed"], c("--ink"), c("--muted")],
    "circle-stroke-color": c("--surface"), "circle-stroke-width": 1.5 } });
  applyVisibility();
}
function applyVisibility() {
  if (!map?.getLayer("fires")) return;
  for (const [k, on] of Object.entries(state.layers)) map.setLayoutProperty(k, "visibility", on ? "visible" : "none");
}

function renderSideLists() {
  const fires = live.fires.filter((f) => ["Out of Control", "Being Held"].includes(f.status)).sort((a, b) => (b.ha || 0) - (a.ha || 0)).slice(0, 6);
  const rivers = live.rivers.filter((r) => r.pct != null).sort((a, b) => b.pct - a.pct).slice(0, 6);
  const qs = [...live.quakes].sort((a, b) => b[0].localeCompare(a[0])).filter((q) => q[4] >= 2).slice(0, 6);
  const fly = (lon, lat, z) => () => map.flyTo({ center: [lon, lat], zoom: z, duration: 1400 });
  const list = (title, items) => el("div", {}, el("div", { class: "side-title" }, title),
    items.length ? el("ol", { class: "side-list" }, ...items) : el("div", { class: "note" }, "None right now."));
  document.getElementById("side-lists").replaceChildren(
    list("Largest active fires", fires.map((f) => el("li", {}, el("button", { type: "button", onclick: fly(f.lon, f.lat, 9) },
      el("span", { class: "n" }, f.name || f.id), el("span", { class: "v" }, `${fmt0(f.ha || 0)} ha`),
      el("span", { class: "s" }, `${f.status} · ${f.centre}`))))),
    list("Rivers highest for the date", rivers.map((r) => el("li", {}, el("button", { type: "button", onclick: fly(r.lon, r.lat, 9) },
      el("span", { class: "n" }, r.name), el("span", { class: "v" }, `${Math.round(r.pct * 100)}th pct`),
      el("span", { class: "s" }, `${r.value} ${r.unit} · typical ${r.median} ${r.unit}`))))),
    list("Latest earthquakes (M2+)", qs.map(([time, lon, lat, depth, mag, place]) => el("li", {}, el("button", { type: "button", onclick: fly(lon, lat, 7) },
      el("span", { class: "n" }, place), el("span", { class: "v" }, `M${mag.toFixed(1)}`),
      el("span", { class: "s" }, new Date(time).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })))))));
}

// ------------------------------------------------------------------ chart helpers
function frame(id, height, m) {
  const host = document.getElementById(id);
  const width = Math.max(240, host.clientWidth);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${width} ${height}`);
  return { svg, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw: width - m.l - m.r, ih: height - m.t - m.b, width };
}
const colPath = (x0, w, y0, base, r = 3) => {
  const h = base - y0, rr = Math.min(r, h, w / 2);
  return h <= 0 ? "" : `M${x0},${base}V${y0 + rr}Q${x0},${y0} ${x0 + rr},${y0}H${x0 + w - rr}Q${x0 + w},${y0} ${x0 + w},${y0 + rr}V${base}Z`;
};
const axisClean = (a) => a.select(".domain").remove();

// ------------------------------------------------------------------ outlook
function renderOutlook() {
  const host = document.getElementById("outlook");
  const fc = wildfire.forecast;
  const anyIn = Object.values(fc).some((c) => c.in_season);
  document.getElementById("outlook-sub").textContent = anyIn
    ? "Expected new wildfires per fire centre over the next seven days. It comes from a model trained on 25 seasons of BC Wildfire Service records against each centre's heat, rain and accumulated dryness, driven by Environment Canada's GEM forecast."
    : "Fire season (April–October) is over, so the outlook is quiet. From spring, this panel shows the expected new wildfires per fire centre for the coming week, driven by Environment Canada's GEM forecast.";
  const entries = Object.entries(fc);
  document.getElementById("outlook-legend")?.replaceChildren(
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--fire)" } }), "Lightning"),
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--water)" } }), "People-caused"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--ink-2)" } }), "80% range"));
  host.replaceChildren(...entries.map(([key, c]) => {
    return el("div", { class: "card outlook-card" },
      el("div", { class: "head" }, el("span", { class: "name" }, `${c.name}`), el("span", { class: "total" }, fmt1(c.week_total), el("small", {}, "fires expected"))),
      el("div", { class: "sub" }, c.in_season ? "Next 7 days · whiskers show the 80% range" : "Outside fire season"),
      el("div", { class: "chart", id: `ol-${key}` }));
  }));
  for (const [key, c] of entries) outlookChart(`ol-${key}`, c.days);
}
function outlookChart(id, days) {
  const m = { l: 6, r: 6, t: 14, b: 32 };
  const { g, iw, ih } = frame(id, 130, m);
  const x = d3.scaleBand(days.map((d) => d.date), [0, iw]).padding(0.3);
  const y = d3.scaleLinear([0, Math.max(3, d3.max(days, (d) => d.hi))], [ih, 0]);
  const bw = Math.min(24, x.bandwidth());
  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", ih).attr("y2", ih).style("stroke", "var(--axis)");
  const cols = g.selectAll("g.c").data(days).join("g").attr("class", "c").attr("transform", (d) => `translate(${x(d.date) + (x.bandwidth() - bw) / 2},0)`);
  cols.append("path").attr("d", (d) => colPath(0, bw, y(d.people), ih)).style("fill", "var(--water)");
  cols.append("path").attr("d", (d) => colPath(0, bw, y(d.total), y(d.people) - (d.people > 0.05 ? 2 : 0))).style("fill", "var(--fire)");
  cols.append("line").attr("x1", bw / 2).attr("x2", bw / 2).attr("y1", (d) => y(d.lo)).attr("y2", (d) => y(d.hi)).style("stroke", "var(--ink-2)").style("stroke-width", 1);
  cols.append("text").attr("class", "label").attr("x", bw / 2).attr("y", ih + 13).attr("text-anchor", "middle").style("font-size", "10.5px")
    .text((d) => d3.timeFormat("%a")(new Date(d.date + "T12:00")));
  cols.append("text").attr("class", "label").attr("x", bw / 2).attr("y", ih + 26).attr("text-anchor", "middle").style("font-size", "10px").style("fill", "var(--muted)")
    .text((d) => `${Math.round(d.tmax)}°`);
  cols.append("rect").attr("x", -4).attr("width", bw + 8).attr("y", 0).attr("height", ih + 28).style("fill", "transparent")
    .on("pointermove", (e, d) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, d3.timeFormat("%A %b %-d")(new Date(d.date + "T12:00"))),
      tipRow(cssVar("--fire"), d.lightning.toFixed(2), "lightning fires expected"), tipRow(cssVar("--water"), d.people.toFixed(2), "people-caused fires expected"),
      tipRow(null, `${d.lo}–${d.hi}`, "80% range"), tipRow(null, `${Math.round(d.tmax)}° · ${d.precip} mm`, "forecast high · rain"),
      tipRow(null, `${d.dry_days}`, "days since rain"))))
    .on("pointerleave", () => tip.hide());
}

// ------------------------------------------------------------------ fire model card
function renderFireMetrics() {
  const L = wildfire.card.by_cause.lightning, P = wildfire.card.by_cause.people;
  const cs = wildfire.card.current_season;
  const tiles = [
    ["Lightning fires explained", `${Math.round(L.deviance_explained * 100)}%`, `of day-to-day variation (Poisson deviance), vs ${Math.round(L.deviance_explained_baseline * 100)}% for climatology`],
    ["People-caused fires explained", `${Math.round(P.deviance_explained * 100)}%`, `vs ${Math.round(P.deviance_explained_baseline * 100)}% for climatology: weather matters less for these`],
    ["Ranks whole seasons", `r = ${L.season_corr.toFixed(2)}`, `Correlation of predicted vs recorded lightning-fire totals, 2000–2025`],
    cs ? [`${cs.year} so far`, `${fmtInt.format(cs.total_obs)} vs ${fmtInt.format(Math.round(cs.total_pred))}`, "Fires recorded vs predicted from the season's actual weather (out of sample)"]
      : ["Training data", fmtInt.format(L.n_fires + P.n_fires), "fires, April–October 2000–2025"],
  ];
  document.getElementById("fire-metrics").replaceChildren(...tiles.map(([l, v, s]) => el("div", { class: "card metric" },
    el("div", { class: "label" }, l), el("div", { class: "value" }, v), el("div", { class: "sub" }, s))));
}

function renderSeason() {
  const cs = wildfire.card.current_season;
  if (!cs) { document.getElementById("season").replaceChildren(el("p", { class: "note" }, "No current-season data yet.")); return; }
  document.getElementById("season-title").textContent = `${cs.year}: predicted vs recorded`;
  const wk = d3.rollups(cs.weeks, (v) => ({ obs: d3.sum(v, (d) => d[2]), pred: d3.sum(v, (d) => d[3]), start: d3.min(v, (d) => d[4]) }), (d) => d[0])
    .map(([w, v]) => ({ w, ...v })).sort((a, b) => a.w - b.w);
  const m = { l: 40, r: 12, t: 10, b: 26 };
  const { svg, g, iw, ih } = frame("season", 260, m);
  const date = (doy) => new Date(cs.year, 0, doy);
  const x = d3.scaleBand(wk.map((d) => d.w), [0, iw]).padding(0.25);
  const y = d3.scaleLinear().domain([0, d3.max(wk, (d) => Math.max(d.obs, d.pred))]).nice().range([ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8)).call(axisClean);
  const months = wk.filter((d, i) => i === 0 || date(d.start).getMonth() !== date(wk[i - 1].start).getMonth());
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(months.map((d) => d.w))
    .tickFormat((w) => d3.timeFormat("%b")(date(wk.find((d) => d.w === w).start))).tickSize(0).tickPadding(8)).call(axisClean);
  const bw = Math.min(24, x.bandwidth());
  g.selectAll("path.bar").data(wk).join("path").attr("class", "bar").attr("d", (d) => colPath(x(d.w) + (x.bandwidth() - bw) / 2, bw, y(d.obs), ih)).style("fill", "var(--fire)").style("opacity", 0.85);
  g.append("path").datum(wk).attr("d", d3.line().x((d) => x(d.w) + x.bandwidth() / 2).y((d) => y(d.pred)).curve(d3.curveMonotoneX))
    .style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 2);
  document.getElementById("season-legend").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--fire)" } }), "Recorded"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--ink)" } }), "Predicted from that week's weather"));
  const ch = g.append("line").attr("y1", 0).attr("y2", ih).style("stroke", "var(--axis)").style("opacity", 0);
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node());
    const d = wk[Math.max(0, Math.min(wk.length - 1, Math.floor(px / x.step())))];
    ch.attr("x1", x(d.w) + x.bandwidth() / 2).attr("x2", x(d.w) + x.bandwidth() / 2).style("opacity", 1);
    tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `Week of ${d3.timeFormat("%b %-d")(date(d.start))}`),
      tipRow(cssVar("--fire"), fmtInt.format(d.obs), "fires recorded"), tipRow(cssVar("--ink"), fmt1(d.pred), "predicted")));
  }).on("pointerleave", () => { ch.style("opacity", 0); tip.hide(); });
}

function renderSeasons() {
  const s = wildfire.card.by_cause.lightning.season.map(([year, obs, pred]) => ({ year, obs, pred }));
  const m = { l: 44, r: 12, t: 10, b: 34 };
  const { svg, g, iw, ih } = frame("seasons", 260, m);
  const max = d3.max(s, (d) => Math.max(d.obs, d.pred)) * 1.05;
  const x = d3.scaleLinear([0, max], [0, iw]), y = d3.scaleLinear([0, max], [ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(5).tickSize(0).tickPadding(8)).call(axisClean);
  g.append("line").attr("x1", 0).attr("y1", ih).attr("x2", x(max)).attr("y2", y(max)).style("stroke", "var(--axis)");
  g.append("text").attr("class", "label").attr("x", iw / 2).attr("y", ih + 30).attr("text-anchor", "middle").text("Recorded lightning fires");
  g.selectAll("circle").data(s).join("circle").attr("cx", (d) => x(d.obs)).attr("cy", (d) => y(d.pred)).attr("r", 5)
    .style("fill", "var(--fire)").style("stroke", "var(--surface)").style("stroke-width", 2);
  const top = [...s].sort((a, b) => b.obs - a.obs).slice(0, 4);
  g.selectAll("text.yr").data(top).join("text").attr("class", "label").attr("x", (d) => x(d.obs) - 8).attr("y", (d) => y(d.pred) + 4).attr("text-anchor", "end").text((d) => d.year);
  const del = d3.Delaunay.from(s, (d) => x(d.obs), (d) => y(d.pred));
  svg.on("pointermove", (e) => {
    const [px, py] = d3.pointer(e, g.node());
    const d = s[del.find(px, py)];
    if (Math.hypot(x(d.obs) - px, y(d.pred) - py) > 24) return tip.hide();
    tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${d.year} season`), tipRow(null, fmtInt.format(d.obs), "recorded"),
      tipRow(cssVar("--fire"), fmtInt.format(Math.round(d.pred)), "predicted")));
  }).on("pointerleave", () => tip.hide());
}

function renderImportance() {
  const raw = Object.entries(wildfire.card.by_cause.lightning.importance).map(([k, v]) => [k, Math.max(0, v)]);
  const total = d3.sum(raw, (d) => d[1]) || 1;
  const imp = raw.map(([k, v]) => [k, v / total]).sort((a, b) => b[1] - a[1]);
  const rowH = 30, m = { l: 110, r: 56, t: 4, b: 4 };
  const { g, iw } = frame("importance", m.t + m.b + rowH * imp.length, m);
  const x = d3.scaleLinear([0, d3.max(imp, (d) => d[1]) || 1], [0, iw]);
  const rows = g.selectAll("g").data(imp).join("g").attr("transform", (_, i) => `translate(0,${i * rowH})`);
  rows.append("text").attr("class", "label").attr("x", -10).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((d) => FEATURE_LABEL[d[0]] || d[0]);
  rows.append("path").attr("d", (d) => { const w = Math.max(2, x(d[1])), h = 14, y0 = (rowH - h) / 2, r = Math.min(4, w);
    return `M0,${y0}H${w - r}Q${w},${y0} ${w},${y0 + r}V${y0 + h - r}Q${w},${y0 + h} ${w - r},${y0 + h}H0Z`; }).style("fill", "var(--fire)");
  rows.append("text").attr("class", "label strong").attr("x", (d) => x(d[1]) + 6).attr("y", rowH / 2).attr("dy", "0.35em").style("font-size", "11px")
    .text((d) => (d[1] < 0.005 ? "≈0" : `${Math.round(d[1] * 100)}%`));
}

function renderBurned() {
  const data = wildfire.yearly.map((d) => ({ year: d.FIRE_YEAR, l: d.ha_lightning || 0, p: d.ha_people || 0 })).filter((d) => d.year >= 1950);
  const m = { l: 52, r: 12, t: 10, b: 26 };
  const { svg, g, iw, ih } = frame("burned", 260, m);
  const x = d3.scaleBand(data.map((d) => d.year), [0, iw]).padding(0.15);
  const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.l + d.p)]).nice().range([ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat((v) => (v >= 1e6 ? `${v / 1e6}M` : `${v / 1e3}k`)).tickSize(0).tickPadding(8)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(data.map((d) => d.year).filter((y) => y % 10 === 0)).tickSize(0).tickPadding(8)).call(axisClean);
  const bw = x.bandwidth();
  g.selectAll("rect.p").data(data).join("rect").attr("x", (d) => x(d.year)).attr("width", bw).attr("y", (d) => y(d.p)).attr("height", (d) => ih - y(d.p)).style("fill", "var(--water)");
  g.selectAll("rect.l").data(data).join("rect").attr("x", (d) => x(d.year)).attr("width", bw).attr("y", (d) => y(d.p + d.l)).attr("height", (d) => Math.max(0, y(d.p) - y(d.p + d.l) - (d.p > 0 ? 1 : 0))).style("fill", "var(--fire)");
  const top = [...data].sort((a, b) => b.l + b.p - (a.l + a.p)).slice(0, 4);
  g.selectAll("text.yr").data(top).join("text").attr("class", "label strong").attr("x", (d) => x(d.year) + bw / 2).attr("y", (d) => y(d.l + d.p) - 5)
    .attr("text-anchor", "middle").style("font-size", "11px").text((d) => d.year);
  document.getElementById("burn-legend").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--fire)" } }), "Lightning"),
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--water)" } }), "People & unknown"));
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node());
    const d = data[Math.max(0, Math.min(data.length - 1, Math.floor(px / x.step())))];
    tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, String(d.year)),
      tipRow(cssVar("--fire"), `${fmt0(d.l)} ha`, "lightning"), tipRow(cssVar("--water"), `${fmt0(d.p)} ha`, "people & unknown"),
      tipRow(null, `${fmt0(d.l + d.p)} ha`, "total")));
  }).on("pointerleave", () => tip.hide());
}

// ------------------------------------------------------------------ floods
function renderHydrographs() {
  const host = document.getElementById("hydrographs");
  const entries = Object.entries(floods).filter(([, f]) => f.hydrograph?.length);
  host.replaceChildren(...entries.map(([sid, f]) => {
    return el("div", { class: "card hydro" }, el("div", { class: "name" }, f.name),
      el("div", { class: "sub" }, f.return_period ? `Peak ${fmt0(f.peak_2021)} m³/s · about 1-in-${fmt0(f.return_period)} years` : `Peak ${fmt0(f.peak_2021 || 0)} m³/s`),
      el("div", { class: "chart", id: `hy-${sid}` }));
  }));
  for (const [sid, f] of entries) hydro(`hy-${sid}`, f);
}
function hydro(id, f) {
  const rows = f.hydrograph.map(([d, q, med, p90]) => ({ d: new Date(d + "T12:00"), q, med, p90 }));
  const m = { l: 36, r: 6, t: 8, b: 22 };
  const { svg, g, iw, ih } = frame(id, 150, m);
  const x = d3.scaleTime(d3.extent(rows, (d) => d.d), [0, iw]);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (d) => Math.max(d.q || 0, d.p90 || 0))]).nice().range([ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(3)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(3).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(3).tickFormat(d3.timeFormat("%b %-d")).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("path").datum(rows.filter((d) => d.p90 != null)).attr("d", d3.area().x((d) => x(d.d)).y0(ih).y1((d) => y(d.p90))).style("fill", "var(--ink-2)").style("opacity", 0.12);
  g.append("path").datum(rows.filter((d) => d.med != null)).attr("d", d3.line().x((d) => x(d.d)).y((d) => y(d.med))).style("fill", "none").style("stroke", "var(--muted)").style("stroke-width", 1.5);
  g.append("path").datum(rows.filter((d) => d.q != null)).attr("d", d3.line().x((d) => x(d.d)).y((d) => y(d.q))).style("fill", "none").style("stroke", "var(--water)").style("stroke-width", 2);
  const ch = g.append("line").attr("y1", 0).attr("y2", ih).style("stroke", "var(--axis)").style("opacity", 0);
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node());
    const t = x.invert(px);
    const d = rows[d3.bisector((r) => r.d).center(rows, t)];
    ch.attr("x1", x(d.d)).attr("x2", x(d.d)).style("opacity", 1);
    tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, d3.timeFormat("%b %-d, 2021")(d.d)),
      tipRow(cssVar("--water"), `${fmt1(d.q)} m³/s`, "2021"), tipRow(cssVar("--muted"), `${fmt1(d.med)} m³/s`, "typical (median)"),
      tipRow(null, `${fmt1(d.p90)} m³/s`, "90th percentile")));
  }).on("pointerleave", () => { ch.style("opacity", 0); tip.hide(); });
}
function renderRP() {
  const rows = Object.values(floods).filter((f) => f.return_period).sort((a, b) => b.return_period - a.return_period);
  const rowH = 30, m = { l: 230, r: 90, t: 6, b: 26 };
  const { svg, g, iw, ih } = frame("rp", m.t + m.b + rowH * rows.length, m);
  const x = d3.scaleLog([1, 2000], [0, iw]).clamp(true);
  g.append("g").attr("class", "grid").selectAll("line").data([2, 10, 100, 1000]).join("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues([2, 10, 100, 1000]).tickFormat((d) => `1-in-${d}`).tickSize(0).tickPadding(8)).call(axisClean);
  const r_ = g.selectAll("g.r").data(rows).join("g").attr("class", "r").attr("transform", (_, i) => `translate(0,${i * rowH})`);
  r_.append("text").attr("class", "label").attr("x", -10).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((d) => d.name);
  r_.append("path").attr("d", (d) => { const w = Math.max(2, x(d.return_period)), h = 14, y0 = (rowH - h) / 2, r = Math.min(4, w);
    return `M0,${y0}H${w - r}Q${w},${y0} ${w},${y0 + r}V${y0 + h - r}Q${w},${y0 + h} ${w - r},${y0 + h}H0Z`; }).style("fill", "var(--water)");
  r_.append("line").attr("x1", (d) => x(d.rp_lo)).attr("x2", (d) => x(d.rp_hi)).attr("y1", rowH / 2).attr("y2", rowH / 2).style("stroke", "var(--ink)").style("stroke-width", 1.5);
  r_.append("text").attr("class", "label strong").attr("x", (d) => Math.max(x(d.return_period), x(d.rp_hi)) + 8).attr("y", rowH / 2).attr("dy", "0.35em")
    .text((d) => `1-in-${d.return_period >= 1000 ? ">1,000" : fmt0(d.return_period)}`);
  r_.append("rect").attr("x", -m.l).attr("width", iw + m.l + m.r).attr("height", rowH).style("fill", "transparent")
    .on("pointermove", (e, d) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, d.name),
      tipRow(cssVar("--water"), `${fmt0(d.peak_2021)} m³/s`, "Nov 2021 peak daily flow"), tipRow(null, `${fmt0(d.previous_record)} m³/s`, "previous record"),
      tipRow(null, `1-in-${fmt0(d.rp_lo)} to 1-in-${fmt0(d.rp_hi)}`, "80% range"), tipRow(null, `${d.n_years} years`, "of annual peaks"))))
    .on("pointerleave", () => tip.hide());
  const table = el("table", { class: "data" }, el("thead", {}, el("tr", {}, ...["Gauge", "2021 peak (m³/s)", "Previous record", "Return period", "80% range", "Years"].map((h, i) => el("th", { class: i ? "num" : "" }, h)))),
    el("tbody", {}, ...rows.map((d) => el("tr", {}, el("td", {}, d.name), el("td", { class: "num" }, fmt0(d.peak_2021)), el("td", { class: "num" }, fmt0(d.previous_record)),
      el("td", { class: "num" }, `1-in-${fmt0(d.return_period)}`), el("td", { class: "num" }, `${fmt0(d.rp_lo)}–${fmt0(d.rp_hi)}`), el("td", { class: "num" }, String(d.n_years))))));
  document.getElementById("rp-table").replaceChildren(table);
}

// ------------------------------------------------------------------ quakes
function buildZones() {
  const wrap = document.getElementById("zones");
  for (const [k, z] of Object.entries(quakes)) wrap.append(el("button", { type: "button", "data-z": k, "aria-pressed": k === state.zone, onclick: () => {
    state.zone = k; wrap.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.z === k)); renderQuakes(); } }, z.name));
}
function renderQuakes() {
  const z = quakes[state.zone];
  if (!z) return;
  const pct = (p) => (p >= 0.995 ? ">99%" : p < 0.01 ? `${(p * 100).toFixed(1)}%` : `${Math.round(p * 100)}%`);
  document.getElementById("quake-tiles").replaceChildren(...["M5", "M6", "M7"].map((k) => {
    const p = z.probs[k];
    return el("div", { class: "card qtile" }, el("div", { class: "label" }, `Chance of an ${k}+ within ${z.radius_km} km in the next 50 years`),
      el("div", { class: "value" }, pct(p.p50)), el("div", { class: "sub" }, `Range ${pct(p.lo)}–${pct(p.hi)} · on average every ${fmtInt.format(p.return_years)} years`));
  }));
  document.getElementById("fmd-title").textContent = `Magnitude–frequency · ${z.name} (${z.n.toLocaleString()} quakes since 1970)`;
  const pts = z.fmd.filter((d) => d[1] > 0).map(([mag, rate]) => ({ mag, rate }));
  const fit = z.fit.map(([mag, rate]) => ({ mag, rate }));
  const m = { l: 52, r: 14, t: 10, b: 34 };
  const { svg, g, iw, ih } = frame("fmd", 280, m);
  const x = d3.scaleLinear([2.5, 7.5], [0, iw]);
  const y = d3.scaleLog([1e-3, Math.max(10, d3.max(pts, (d) => d.rate) * 1.5)], [ih, 0]).clamp(true);
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(5).filter((v) => Math.log10(v) % 1 === 0)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickValues(y.ticks(5).filter((v) => Math.log10(v) % 1 === 0)).tickFormat((v) => (v >= 1 ? d3.format(",")(v) : `1/${d3.format(",")(1 / v)}`)).tickSize(0).tickPadding(8)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(6).tickFormat((d) => `M${d}`).tickSize(0).tickPadding(8)).call(axisClean);
  g.append("text").attr("class", "label").attr("x", iw / 2).attr("y", ih + 30).attr("text-anchor", "middle").text("Magnitude (at or above)");
  g.append("line").attr("x1", x(z.mc)).attr("x2", x(z.mc)).attr("y1", 0).attr("y2", ih).style("stroke", "var(--axis)");
  g.append("text").attr("class", "label").attr("x", x(z.mc) + 4).attr("y", 12).style("font-size", "10.5px").text(`complete above M${z.mc}`);
  g.append("path").datum(fit.filter((d) => d.mag <= 7.5 && d.rate >= 1e-3)).attr("d", d3.line().x((d) => x(d.mag)).y((d) => y(d.rate))).style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 2);
  g.selectAll("circle").data(pts).join("circle").attr("cx", (d) => x(d.mag)).attr("cy", (d) => y(d.rate)).attr("r", 4)
    .style("fill", "var(--rock)").style("stroke", "var(--surface)").style("stroke-width", 2).style("opacity", (d) => (d.mag >= z.mc ? 1 : 0.35));
  document.getElementById("fmd-legend").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "dot", style: { background: "var(--rock)" } }), "Observed rate"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--ink)" } }), `Gutenberg–Richter fit (b = ${z.b.toFixed(2)}, range ${z.b_lo.toFixed(2)}–${z.b_hi.toFixed(2)})`));
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node());
    const mag = Math.round(x.invert(px) * 10) / 10;
    const o = pts.find((d) => Math.abs(d.mag - mag) < 0.05), f = fit.find((d) => Math.abs(d.mag - mag) < 0.05);
    if (!o && !f) return tip.hide();
    tip.show(e.clientX, e.clientY, (t) => {
      t.append(el("div", { class: "t-title" }, `M${mag.toFixed(1)} and above`));
      if (o) t.append(tipRow(cssVar("--rock"), o.rate >= 1 ? `${fmt1(o.rate)} / yr` : `1 per ${fmt0(1 / o.rate)} yrs`, "observed"));
      if (f) t.append(tipRow(cssVar("--ink"), f.rate >= 1 ? `${fmt1(f.rate)} / yr` : `1 per ${fmt0(1 / f.rate)} yrs`, "fitted"));
    });
  }).on("pointerleave", () => tip.hide());
  document.getElementById("biggest").replaceChildren(...z.biggest.map(([d, mag, place, depth]) => el("li", {}, `M${mag.toFixed(1)}, ${d}: ${place} (${depth} km deep)`)));
}
