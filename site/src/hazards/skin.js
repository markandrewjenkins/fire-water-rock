// "Field Ops" design skin extras: SITREP live strip, ICS field-book header, status LEDs,
// hazard-stripe alerts and a topo tint for the basemap. Everything here exists only while
// data-skin="alt" is on <html>; switching back to Classic removes it all.
import { el, fmtInt } from "../shared/ui.js";

const root = document.documentElement;
const on = () => root.dataset.skin === "alt";
const DATA_LAYERS = new Set(["perimeters", "fires", "rivers", "quakes", "roads"]);
const LVL = { ok: "--good", watch: "--warning", high: "--serious", alarm: "--critical", idle: "--muted" };
let api, observer;

/** @param {{ get: () => ({ live, floods, wildfire, quakes, map }), isDark: () => boolean }} a */
export function initFieldOps(a) {
  api = a;
  window.addEventListener("skinchange", sync);
  const map = api.get().map;
  if (map) {
    map.on("style.load", paintMap);
    map.on("styledata", paintMapIfNeeded);
  }
  sync();
}

function sync() {
  teardown();
  if (!on()) return;
  build();
  paintMap();
}

// ------------------------------------------------------------------ DOM
const led = (lvl, extra = "") => el("i", { class: `ops-led ${extra}`.trim(), "data-lvl": lvl, style: `--led: var(${LVL[lvl]})`, "aria-hidden": "true" });
const vanTime = (d, opts) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", ...opts }).formatToParts(d)
  .reduce((o, p) => ((o[p.type] = p.value), o), {});

function stamp(d) {
  const p = vanTime(d, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
  return { date: `${p.day} ${p.month.replace(".", "").toUpperCase()} ${p.year}`, time: `${p.hour}:${p.minute} ${p.timeZoneName}` };
}

function sitrepNumbers() {
  const { live, floods } = api.get();
  const s = live.summary, gen = new Date(s.generated);
  const q24 = live.quakes.filter((q) => q[4] >= 2.5 && gen - new Date(q[0]) <= 864e5 && new Date(q[0]) <= gen);
  // Rivers above their 2-year flood: live flow vs the 2-year level of each gauge's pre-2021 Gumbel fit (the gauges with a fit).
  const rivers = new Map(live.rivers.map((r) => [r.id, r]));
  const q2 = Object.entries(floods).map(([id, f]) => {
    const c = f.curve?.find(([rp]) => rp === 2), r = rivers.get(id);
    return c && r && r.unit === "m³/s" && r.value != null ? r.value > c[1] : null;
  }).filter((v) => v !== null);
  return { s, gen, q24: q24.length, q24max: Math.max(0, ...q24.map((q) => q[4])), above2: q2.filter(Boolean).length, gauged: q2.length };
}

function build() {
  const { s, gen, q24, q24max, above2, gauged } = sitrepNumbers();
  const t = stamp(gen);
  const item = (lvl, long, short, value) => el("div", { class: "ops-sr-item" }, led(lvl, lvl === "alarm" ? "blink" : ""),
    el("span", { class: "k" }, el("span", { class: "k-long" }, long), el("span", { class: "k-short" }, short)), el("b", {}, value));
  const strip = el("div", { class: "ops-sitrep", "data-ops": "", role: "region", "aria-label": "Situation report" },
    el("div", { class: "wrap ops-sitrep-in" },
      el("div", { class: "ops-sr-tag" }, el("i", { class: "ops-live", "aria-hidden": "true" }), "SITREP"),
      item(s.fires_active ? "watch" : "ok", "Active wildfires", "Wildfires", fmtInt.format(s.fires_active)),
      item(s.fires_out_of_control ? "alarm" : "ok", "Out of control", "Out of ctrl", fmtInt.format(s.fires_out_of_control)),
      item(above2 >= 3 ? "alarm" : above2 ? "watch" : "ok", "Rivers > 2-yr flood", "Rivers > 2-yr", `${above2}/${gauged}`),
      item(q24max >= 5 ? "alarm" : q24 ? "watch" : "ok", "Quakes 24 h · M2.5+", "Quakes 24 h", String(q24)),
      item(s.road_closures ? "watch" : "ok", "Highway closures", "Hwy closed", fmtInt.format(s.road_closures)),
      el("div", { class: "ops-sr-stamp" }, el("span", { class: "k" }, "Data as of"), el("b", {}, `${t.date.slice(0, 6)} ${t.time}`))));
  document.querySelector(".topbar").after(strip);

  const field = (label, value) => el("div", { class: "ops-field" }, el("span", { class: "ops-field-l" }, label), el("span", { class: "ops-field-v" }, value));
  const book = el("div", { class: "ops-fieldbook", "data-ops": "", "aria-hidden": "true" },
    field("1 · Form", "ICS-209 · Incident status"),
    field("2 · Jurisdiction", "Province of British Columbia"),
    field("3 · Op period", `${t.date} · ${t.time}`),
    field("4 · Sources", "BCWS · ECCC · USGS · DriveBC"));
  document.getElementById("asof").before(book);

  const hour = +vanTime(new Date(), { hour: "2-digit", hourCycle: "h23" }).hour;
  document.querySelector("footer.site .wrap").append(el("div", { class: "ops-flavour", "data-ops": "", "aria-hidden": "true" },
    el("span", {}, `${hour >= 6 && hour < 18 ? "Day" : "Night"} shift · LACES: lookouts, awareness, communications, escape routes, safety zones`),
    el("span", { class: "ops-end" }, "End of report")));

  decorate();
  observer = new MutationObserver(decorate);
  for (const id of ["tiles", "outlook", "hydrographs", "quake-tiles"]) {
    const n = document.getElementById(id);
    if (n) observer.observe(n, { childList: true });
  }
}

// Status LEDs and hazard-stripe alerts on cards the page re-renders (idempotent).
function decorate() {
  if (!on()) return;
  const { wildfire, floods, quakes } = api.get();
  const { s, above2 } = sitrepNumbers();
  const tiles = document.querySelectorAll("#tiles .tile");
  const alertTile = [s.fires_out_of_control > 0, above2 > 0, s.quakes_week_max >= 5, false];
  tiles.forEach((t, i) => t.classList.toggle("ops-alert", !!alertTile[i]));

  const fc = Object.values(wildfire.forecast);
  document.querySelectorAll("#outlook .outlook-card").forEach((card, i) => {
    const c = fc[i];
    if (!c || card.querySelector(".ops-rating")) return;
    const v = c.week_total;
    const [lvl, word] = !c.in_season ? ["idle", "Standby"] : v < 3 ? ["ok", "Low"] : v < 10 ? ["watch", "Moderate"] : v < 25 ? ["high", "High"] : ["alarm", "Extreme"];
    card.querySelector(".sub")?.prepend(el("span", { class: "ops-rating", "data-ops": "", "aria-hidden": "true" }, led(lvl, lvl === "alarm" ? "blink" : ""), `Starts ${word}`));
  });

  const hy = Object.values(floods).filter((f) => f.hydrograph?.length);
  document.querySelectorAll("#hydrographs .hydro").forEach((card, i) => {
    const rp = hy[i]?.return_period || 0;
    card.classList.toggle("ops-alert", rp >= 100);
    if (card.querySelector(".ops-led")) return;
    const lvl = rp >= 100 ? "alarm" : rp >= 25 ? "high" : rp >= 10 ? "watch" : "ok";
    card.querySelector(".name")?.prepend(led(lvl));
  });

  const z = quakes[document.querySelector("#zones [aria-pressed='true']")?.dataset.z];
  document.querySelectorAll("#quake-tiles .qtile").forEach((card, i) => {
    const p = z?.probs[["M5", "M6", "M7"][i]]?.p50 || 0;
    card.classList.toggle("ops-alert", p >= 0.5);
  });
}

function teardown() {
  observer?.disconnect();
  observer = null;
  document.querySelectorAll("[data-ops]").forEach((n) => n.remove());
  document.querySelectorAll(".hydro .name > .ops-led").forEach((n) => n.remove());
  document.querySelectorAll(".ops-alert").forEach((n) => n.classList.remove("ops-alert"));
}

// ------------------------------------------------------------------ basemap: topo sheet (day) / EOC olive (night)
const TOPO = {
  day: { bg: "#e6ddb4", wood: "#cfd3a3", resid: "#dcd2a5", ice: "#eef0e6", water: "#9fb5c4", waterLine: "#86a3b8", motorway: "#9a6234",
    major: "#ad8152", minor: "#c9ad85", casing: "#e6ddb4", rail: "#6f6a52", bound: "#8b6b45", label: "#2b2a1f", halo: "#ece4c0",
    waterLabel: "#3d5d77", roadLabel: "#6b4f31" },
  night: { bg: "#20231b", wood: "#272c20", resid: "#272a21", ice: "#2b2f27", water: "#1c2a31", waterLine: "#29404c", motorway: "#6e5a35",
    major: "#544a33", minor: "#3a3829", casing: "#1b1d17", rail: "#3d4031", bound: "#6a5f42", label: "#bdb18a", halo: "#1b1d17",
    waterLabel: "#7895a8", roadLabel: "#8f7f58" },
};
const palette = () => (api.isDark() ? TOPO.night : TOPO.day);

function paintMapIfNeeded() {
  if (!on()) return;
  const map = api.get().map;
  try {
    if (map?.getLayer("background") && map.getPaintProperty("background", "background-color") !== palette().bg) paintMap();
  } catch { /* style mid-swap */ }
}

function paintMap() {
  const map = api.get().map;
  if (!on() || !map) return;
  let layers;
  try { layers = map.getStyle()?.layers; } catch { return; }
  if (!layers) return;
  const P = palette();
  const set = (id, prop, v) => { try { map.setPaintProperty(id, prop, v); } catch { /* not applicable */ } };
  for (const l of layers) {
    const id = l.id;
    if (DATA_LAYERS.has(id)) continue;
    if (l.type === "background") set(id, "background-color", P.bg);
    else if (l.type === "fill") {
      const c = /water/.test(id) ? P.water : /wood|park|grass/.test(id) ? P.wood : /glacier|ice/.test(id) ? P.ice
        : /road_area|pier/.test(id) ? P.bg : P.resid;
      set(id, "fill-color", c);
      if (id === "building") set(id, "fill-outline-color", P.resid);
    } else if (l.type === "line") {
      const c = /waterway/.test(id) ? P.waterLine : /boundary/.test(id) ? P.bound : /dashline/.test(id) ? P.bg : /rail/.test(id) ? P.rail
        : /casing/.test(id) ? P.casing : /motorway/.test(id) ? P.motorway : /major/.test(id) ? P.major : /pier/.test(id) ? P.bg : P.minor;
      set(id, "line-color", c);
    } else if (l.type === "symbol") {
      set(id, "text-color", /water/.test(id) ? P.waterLabel : /highway|road/.test(id) ? P.roadLabel : P.label);
      set(id, "text-halo-color", P.halo);
    }
  }
}
