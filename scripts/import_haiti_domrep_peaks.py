from __future__ import annotations

import os
import json
import re
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
    / "haiti-and-domrep-260728.osm.pbf"
)

BATCH_SIZE = 500
MIN_HEIGHT = 700

BOUNDARIES_DIR = (
    Path(__file__).parent.parent
    / "date"
    / "boundaries"
)

HAITI_BOUNDARY_PATH = (
    BOUNDARIES_DIR
    / "haiti.geojson"
)

DOMINICAN_REPUBLIC_BOUNDARY_PATH = (
    BOUNDARIES_DIR
    / "dominican-republic.geojson"
)

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

HAITI_BOUNDARY = load_boundary(
    HAITI_BOUNDARY_PATH
)

DOMINICAN_REPUBLIC_BOUNDARY = load_boundary(
    DOMINICAN_REPUBLIC_BOUNDARY_PATH
)

def get_country_code(
    latitude: float,
    longitude: float,
) -> str | None:
    point = Point(
        longitude,
        latitude,
    )

    if HAITI_BOUNDARY.covers(point):
        return "HT"

    if DOMINICAN_REPUBLIC_BOUNDARY.covers(point):
        return "DO"

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
    ) -> None:
        super().__init__()

        self.supabase = supabase
        self.peaks: list[Peak] = []

        self.total_found = 0
        self.total_uploaded = 0

        self.total_haiti = 0
        self.total_domrep = 0
        self.total_outside = 0

    def upload_current_batch(self) -> None:
        if not self.peaks:
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

        height = parse_height(
            node.tags.get("ele")
        )

        if height is None or height < MIN_HEIGHT:
            return

        latitude = float(node.location.lat)
        longitude = float(node.location.lon)

        country_code = get_country_code(
            latitude,
            longitude,
        )

        if country_code is None:
            self.total_outside += 1
            return

        if country_code == "HT":
            self.total_haiti += 1

        elif country_code == "DO":
            self.total_domrep += 1

        name = node.tags.get("name")
        name_de = node.tags.get("name:de")
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
    )

    handler.apply_file(
        str(PBF_PATH),
    )

    handler.upload_current_batch()

    print()
    print("Импорт завершён.")

    print(
        f"Всего найдено: "
        f"{handler.total_found}"
    )

    print(
        f"Гаити (HT): "
        f"{handler.total_haiti}"
    )

    print(
        f"Доминиканская Республика (DO): "
        f"{handler.total_domrep}"
    )

    print(
        f"Вне границ: "
        f"{handler.total_outside}"
    )

    print(
        f"Загружено: "
        f"{handler.total_uploaded}"
    )
if __name__ == "__main__":
     main()

