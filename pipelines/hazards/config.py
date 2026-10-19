"""Fire, Water & Rock configuration."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "hazards" / "raw"
DERIVED = ROOT / "data" / "hazards" / "derived"      # small, committed: training table + river climatology
OUT = ROOT / "site" / "public" / "data" / "hazards"

WFS = "https://openmaps.gov.bc.ca/geo/pub/wfs"
FIRE_POINTS_NOW = "WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_PNTS_SP"
FIRE_POLYS_NOW = "WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_POLYS_SP"
FIRE_HISTORY = "WHSE_LAND_AND_NATURAL_RESOURCE.PROT_HISTORICAL_INCIDENTS_SP"

# BC Wildfire Service fire centres, keyed by the letter that prefixes each fire number,
# with a spliced ECCC daily climate station chain for the weather features.
FIRE_CENTRES = {
    "V": {"name": "Coastal", "stations": ["1021830"], "lonlat": (-124.90, 49.72)},
    "K": {"name": "Kamloops", "stations": ["1163781", "1163780", "1163842"], "lonlat": (-120.44, 50.70)},
    "G": {"name": "Prince George", "stations": ["1096453", "1096450", "1096439"], "lonlat": (-122.68, 53.89)},
    "C": {"name": "Cariboo", "stations": ["1098941", "1098940"], "lonlat": (-122.05, 52.18)},
    "N": {"name": "Southeast", "stations": ["1152105", "1152102", "1152106"], "lonlat": (-115.78, 49.61)},
    "R": {"name": "Northwest", "stations": ["1077501", "1077500", "1077499"], "lonlat": (-127.18, 54.82)},
}
FIRE_TRAIN_START = 2000

# November 2021 atmospheric-river replay + flood-frequency gauges
FLOOD_GAUGES = {
    "08MF068": "Coquihalla River above Alexander Creek",
    "08NL024": "Tulameen River at Princeton",
    "08NL007": "Similkameen River at Princeton",
    "08MH029": "Sumas River near Huntingdon",
    "08MH001": "Chilliwack River at Vedder Crossing",
    "08LG070": "Nicola River south of Shackan",
    "08HA011": "Cowichan River near Duncan",
    "08HB002": "Englishman River near Parksville",
}
RIVER_CLIM_START = 1991

# Earthquake catalogue (USGS ComCat) and recurrence zones (centre lon, lat, radius km)
QUAKE_BBOX = (46.0, -134.0, 56.0, -114.0)       # south, west, north, east
QUAKE_ZONES = {
    "victoria": {"name": "Greater Victoria", "center": (-123.37, 48.43), "radius_km": 100},
    "vancouver": {"name": "Metro Vancouver", "center": (-123.12, 49.28), "radius_km": 100},
    "haida": {"name": "Haida Gwaii", "center": (-131.9, 52.8), "radius_km": 200},
    "kootenay": {"name": "Kootenays", "center": (-117.3, 49.5), "radius_km": 150},
}

OPEN511 = "https://api.open511.gov.bc.ca/events"
