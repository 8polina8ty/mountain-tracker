from __future__ import annotations

import os
import re
import sys
import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import osmium
from dotenv import load_dotenv
from supabase import Client, create_client


PBF_PATH = (
    Path(__file__).parent.parent
    / "date"
    / "antarctica-260728.osm.pbf"
)

BATCH_SIZE = 500
MIN_HEIGHT = 700

@dataclass
class Peak:
    osm_id: int
    name: str
    name_de: str | None
    height: int
    latitude: float
    longitude: float
    wikidata: str | None
    wikipedia: str | None
    country_code: str = "AQ"
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
        self.osm_ids: list[int] = []
        self.min_lat = 90.0
        self.max_lat = -90.0
        self.min_lon = 180.0
        self.max_lon = -180.0

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

        wikidata = node.tags.get("wikidata")

        wikipedia = normalize_wikipedia(
            node.tags.get("wikipedia")
        )

        latitude = float(node.location.lat)
        longitude = float(node.location.lon)

        self.min_lat = min(
            self.min_lat,
            latitude,
        )

        self.max_lat = max(
            self.max_lat,
            latitude,
        )

        self.min_lon = min(
            self.min_lon,
            longitude,
        )

        self.max_lon = max(
            self.max_lon,
            longitude,
        )

        self.peaks.append(
            Peak(
                osm_id=int(node.id),
                name=name or name_de or "Unknown",
                name_de=name_de,
                height=height,
                latitude=latitude,
                longitude=longitude,
                wikidata=wikidata,
                wikipedia=wikipedia,
            )
        )

        self.total_found += 1

        self.osm_ids.append(
    int(node.id)
)

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

    if analyze_mode:
         output_path = (
            Path(__file__).parent.parent
            / "date"
            / "antarctica_osm_ids.csv"
        )

         with output_path.open(
            "w",
            newline="",
            encoding="utf-8",
        ) as file:
            writer = csv.writer(file)

            writer.writerow(["osm_id"])

            for osm_id in handler.osm_ids:
                writer.writerow([osm_id])

         print(
            f"OSM ID сохранены: {output_path}"
        )

    print()
    print("=" * 70)
    print("ИТОГ ИМПОРТА АНТАРКТИДЫ")
    print("=" * 70)

    print(
        f"Всего найдено: "
        f"{handler.total_found}"
    )

    print(
        f"Загружено: "
        f"{handler.total_uploaded}"
    )

    print()
    print("Диапазон координат:")

    print(
        f"Широта: "
        f"{handler.min_lat} → {handler.max_lat}"
    )

    print(
        f"Долгота: "
        f"{handler.min_lon} → {handler.max_lon}"
    )

if __name__ == "__main__":
    main()