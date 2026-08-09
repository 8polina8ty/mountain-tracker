from __future__ import annotations

import csv
import json
import os
import re
import sys

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import osmium
from dotenv import load_dotenv
from shapely.geometry import Point, shape
from supabase import Client, create_client


PBF_PATH = (
    Path(__file__).parent.parent
    / "date"
    / "australia-oceania-260728.osm.pbf"
)

BOUNDARIES_DIR = (
    Path(__file__).parent.parent
    / "date"
    / "boundaries"
)

BATCH_SIZE = 500
MIN_HEIGHT = 700

OCEANIA_BOUNDARIES = {
    "AU": "australia.geojson",
    "NZ": "new-zealand.geojson",
    "PG": "papua-new-guinea.geojson",
    "FJ": "fiji.geojson",
    "SB": "solomon-islands.geojson",
    "VU": "vanuatu.geojson",
    "NC": "new-caledonia.geojson",
    "WS": "samoa.geojson",
    "TO": "tonga.geojson",
    "FM": "micronesia.geojson",
    "PW": "palau.geojson",
    "MH": "marshall-islands.geojson",
    "KI": "kiribati.geojson",
    "NR": "nauru.geojson",
    "TV": "tuvalu.geojson",
    "PF": "french-polynesia.geojson",
    "AS": "american-samoa.geojson",
  # "MP": "northern-mariana-islands.geojson",
  # "TF": "french-southern-territories.geojson",
  # "HM": "heard-island-and-mcdonald-islands.geojson",
}

SPECIAL_COUNTRY_OVERRIDES = {
    1914665997: "MP",  # Mount Agrihan
    1742506996: "SB",  # Tinakula
    2113386834: "NZ",  # Mount Dick
}

SPECIAL_REGION_RULES = [
    {
        "country_code": "TF",
        "min_lat": -51.0,
        "max_lat": -37.0,
        "min_lon": 60.0,
        "max_lon": 80.0,
    },
    {
    "country_code": "HM",
    "min_lat": -54.0,
    "max_lat": -52.0,
    "min_lon": 72.0,
    "max_lon": 75.0,
},
]

def load_boundary(path: Path):
    if not path.exists():
        raise FileNotFoundError(
            f"Файл границы не найден: {path}"
        )

    with path.open(
        "r",
        encoding="utf-8",
    ) as file:
        geojson = json.load(file)

    if geojson.get("type") == "FeatureCollection":
        features = geojson.get("features", [])

        if not features:
            raise ValueError(
                f"GeoJSON не содержит объектов: {path}"
            )

        geometry = features[0]["geometry"]

    elif geojson.get("type") == "Feature":
        geometry = geojson["geometry"]

    else:
        geometry = geojson

    return shape(geometry)

COUNTRY_BOUNDARIES = {
    country_code: load_boundary(
        BOUNDARIES_DIR / file_name
    )
    for country_code, file_name
    in OCEANIA_BOUNDARIES.items()
}

def get_country_code(
    latitude: float,
    longitude: float,
) -> str | None:
    point = Point(
        longitude,
        latitude,
    )

    for country_code, boundary in COUNTRY_BOUNDARIES.items():
        if boundary.covers(point):
            return country_code

    return None

@dataclass
class Peak:
    osm_id: int
    name: str | None
    name_de: str | None
    height: int | None
    latitude: float
    longitude: float
    wikidata: str | None
    wikipedia: str | None
    country_code: str
    source: str = "osm"



    def to_dict(self) -> dict[str, Any]:
        return {
            "osm_id": self.osm_id,
            "name": self.name,
            "name_de": self.name_de,
            "height": self.height,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "wikidata": self.wikidata,
            "wikipedia": self.wikipedia,
            "country_code": self.country_code,
            "source": self.source,
        }

def parse_height(value: str | None) -> int | None:
    if not value:
        return None

    normalized = (
        value.strip()
        .lower()
        .replace(",", ".")
        .replace("meters", "")
        .replace("meter", "")
        .replace("metres", "")
        .replace("metre", "")
        .replace("m", "")
        .strip()
    )

    match = re.search(
        r"-?\d+(?:\.\d+)?",
        normalized,
    )

    if not match:
        return None

    try:
        height = round(float(match.group()))
    except ValueError:
        return None

    if height < -500 or height > 9000:
        return None

    return height


def normalize_wikipedia(
    value: str | None,
) -> str | None:
    if not value:
        return None

    value = value.strip()

    if ":" in value:
        _, title = value.split(":", 1)
        return title.strip() or None

    return value or None

class PeakHandler(osmium.SimpleHandler):
    def __init__(
        self,
        supabase: Client,
        dry_run: bool = False,
    ) -> None:
        super().__init__()

        self.supabase = supabase
        self.dry_run = dry_run
        self.peaks: list[Peak] = []

        self.total_found = 0
        self.total_uploaded = 0
        self.total_outside = 0

        self.outside_peaks: list[dict[str, Any]] = []

        self.country_counts = {
    country_code: 0
    for country_code in {
        *OCEANIA_BOUNDARIES.keys(),
        "MP",
        "TF",
        "HM",
    }
}

    def upload_current_batch(self) -> None:
        if not self.peaks:
         return

        if self.dry_run:
         self.peaks.clear()
         return

        rows = [
          peak.to_dict()
          for peak in self.peaks
    ]

        self.supabase.table("mountains").upsert(
        rows,
        on_conflict="osm_id",
        ).execute()

        self.total_uploaded += len(self.peaks)

        print(
        f"Загружено: {self.total_uploaded}",
        flush=True,
    )

        self.peaks.clear()

    def node(
        self,
        node: osmium.osm.Node,
    ) -> None:
        natural_type = node.tags.get("natural")

        if natural_type not in {"peak", "volcano"}:
            return

        if not node.location.valid():
            return

        name = node.tags.get("name")
        name_de = node.tags.get("name:de")

        if not name and not name_de:
            return

        height = parse_height(
            node.tags.get("ele")
        )

        if height is None or height < MIN_HEIGHT:
            return

        latitude = float(node.location.lat)
        longitude = float(node.location.lon)

        country_code = SPECIAL_COUNTRY_OVERRIDES.get(
           int(node.id)
)

        if country_code is None:
          country_code = get_country_code(
           latitude,
           longitude,
    )

        if country_code is None:
          for rule in SPECIAL_REGION_RULES:
           if (
            rule["min_lat"] <= latitude <= rule["max_lat"]
            and rule["min_lon"] <= longitude <= rule["max_lon"]
        ):
            country_code = rule["country_code"]
            break

        if country_code is None:
         if (
        130.0 <= longitude <= 141.5
        and -6.0 <= latitude <= 1.0
    ):
          return  

        if country_code is None:
           self.total_outside += 1

           self.outside_peaks.append(
        {
            "osm_id": int(node.id),
            "name": name,
            "height": height,
            "latitude": latitude,
            "longitude": longitude,
           }
        )

        self.country_counts[country_code] += 1

        wikidata = node.tags.get("wikidata")

        wikipedia = normalize_wikipedia(
            node.tags.get("wikipedia")
        )

        self.peaks.append(
            Peak(
                osm_id=int(node.id),
                name=name,
                name_de=name_de,
                height=height,
                latitude=latitude,
                longitude=longitude,
                wikidata=wikidata,
                wikipedia=wikipedia,
                country_code=country_code,
            )
        )

        self.total_found += 1

        if len(self.peaks) >= BATCH_SIZE:
            self.upload_current_batch()

def get_supabase_client() -> Client:
    load_dotenv(".env.local")

    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL")

    service_role_key = os.getenv(
        "SUPABASE_SERVICE_ROLE_KEY"
    )

    if not url:
        raise RuntimeError(
            "NEXT_PUBLIC_SUPABASE_URL отсутствует в .env.local"
        )

    if not service_role_key:
        raise RuntimeError(
            "SUPABASE_SERVICE_ROLE_KEY отсутствует в .env.local"
        )

    return create_client(
        url,
        service_role_key,
    )

def main() -> None:
    analyze_mode = "--analyze" in sys.argv
    if not PBF_PATH.exists():
        raise FileNotFoundError(
            f"Файл не найден: {PBF_PATH}"
        )

    print(
        f"Читаю файл: {PBF_PATH}"
    )

    supabase = get_supabase_client()

    handler = PeakHandler(
    supabase,
    dry_run=analyze_mode,
)

    if analyze_mode:
        print(
            "РЕЖИМ ANALYZE — данные в Supabase "
            "не записываются."
        )

    handler.apply_file(
        str(PBF_PATH),
    )

    handler.upload_current_batch()

    outside_csv_path = (
        Path(__file__).parent.parent
        / "date"
        / "oceania_unmatched_peaks.csv"
    )

    if handler.outside_peaks:
        with outside_csv_path.open(
            "w",
            newline="",
            encoding="utf-8",
        ) as file:
            writer = csv.DictWriter(
                file,
                fieldnames=[
                    "osm_id",
                    "name",
                    "height",
                    "latitude",
                    "longitude",
                ],
            )

            writer.writeheader()
            writer.writerows(
                handler.outside_peaks
            )

        print(
            f"Вершины вне границ сохранены: "
            f"{outside_csv_path}"
        )

    print()
    print("=" * 70)
    print("ИТОГ ИМПОРТА ОКЕАНИИ")
    print("=" * 70)

    print(
        f"Всего найдено: "
        f"{handler.total_found}"
    )

    print(
        f"Загружено: "
        f"{handler.total_uploaded}"
    )

    print(
        f"Вне известных границ: "
        f"{handler.total_outside}"
    )

    print()
    print("По странам:")

    for country_code, count in sorted(
        handler.country_counts.items()
    ):
        print(
            f"{country_code}: {count}"
        )



if __name__ == "__main__":
    main()

