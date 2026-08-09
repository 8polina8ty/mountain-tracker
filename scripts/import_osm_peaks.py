from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import osmium
from dotenv import load_dotenv
from supabase import Client, create_client


BATCH_SIZE = 500


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
    country_code: str | None
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

    match = re.search(r"-?\d+(?:\.\d+)?", normalized)

    if not match:
        return None

    try:
        height = round(float(match.group()))
    except ValueError:
        return None

    if height < -500 or height > 9000:
        return None

    return height


def normalize_wikipedia(value: str | None) -> str | None:
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
        country_code: str | None,
        supabase: Client,
    ) -> None:
        super().__init__()

        self.country_code = country_code
        self.supabase = supabase

        self.peaks: list[Peak] = []
        self.total_found = 0
        self.total_uploaded = 0

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

        name = node.tags.get("name")
        name_de = node.tags.get("name:de")

        if not name and not name_de:
         return

        height = parse_height(
            node.tags.get("ele")
        )

        if height is None or height < 700:
            return

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
                latitude=float(node.location.lat),
                longitude=float(node.location.lon),
                wikidata=wikidata,
                wikipedia=wikipedia,
                country_code=self.country_code,
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

    return create_client(url, service_role_key)


def main() -> None:
    if len(sys.argv) < 2:
        print(
            "Использование:\n"
            "python scripts/import_osm_peaks.py "
            "<файл.osm.pbf> [country_code]"
        )
        raise SystemExit(1)

    pbf_path = Path(sys.argv[1])

    if not pbf_path.exists():
        raise FileNotFoundError(
            f"Файл не найден: {pbf_path}"
        )

    country_code = (
        sys.argv[2].upper()
        if len(sys.argv) >= 3
        else None
    )

    print(f"Читаю файл: {pbf_path}")

    supabase = get_supabase_client()

    handler = PeakHandler(
    country_code,
    supabase,
)

    handler.apply_file(
    str(pbf_path),
)

# Загружаем последнюю неполную партию.
    handler.upload_current_batch()

    print(
    f"Найдено вершин: {handler.total_found}"
)
    print(
    f"Загружено вершин: {handler.total_uploaded}"
)

    print("Импорт завершён.")

if __name__ == "__main__":
    main()