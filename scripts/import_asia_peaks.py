from __future__ import annotations

import subprocess
import sys
from pathlib import Path


DATA_DIR = Path(r"E:\Projekt mounts\date")

IMPORT_SCRIPT = (
    Path(__file__).parent
    / "import_osm_peaks.py"
)
ASIA_IMPORTS = {
    "afghanistan-260728.osm.pbf": "AF",
    "armenia-260728.osm.pbf": "AM",
    "azerbaijan-260728.osm.pbf": "AZ",
    "bangladesh-260728.osm.pbf": "BD",
    "bhutan-260728.osm.pbf": "BT",
    "cambodia-260728.osm.pbf": "KH",
    "china-260728.osm.pbf": "CN",
    "east-timor-260728.osm.pbf": "TL",
    "india-260728.osm.pbf": "IN",
    "indonesia-260728.osm.pbf": "ID",
    "iran-260728.osm.pbf": "IR",
    "iraq-260728.osm.pbf": "IQ",
    "japan-260728.osm.pbf": "JP",
    "jordan-260728.osm.pbf": "JO",
    "kazakhstan-260728.osm.pbf": "KZ",
    "kyrgyzstan-260728.osm.pbf": "KG",
    "laos-260728.osm.pbf": "LA",
    "lebanon-260728.osm.pbf": "LB",
    "maldives-260728.osm.pbf": "MV",
    "mongolia-260728.osm.pbf": "MN",
    "myanmar-260728.osm.pbf": "MM",
    "nepal-260728.osm.pbf": "NP",
    "north-korea-260728.osm.pbf": "KP",
    "pakistan-260728.osm.pbf": "PK",
    "philippines-260728.osm.pbf": "PH",
    "south-korea-260728.osm.pbf": "KR",
    "sri-lanka-260728.osm.pbf": "LK",
    "syria-260728.osm.pbf": "SY",
    "taiwan-260728.osm.pbf": "TW",
    "tajikistan-260728.osm.pbf": "TJ",
    "thailand-260728.osm.pbf": "TH",
    "turkmenistan-260728.osm.pbf": "TM",
    "uzbekistan-260728.osm.pbf": "UZ",
    "vietnam-260728.osm.pbf": "VN",
    "yemen-260728.osm.pbf": "YE",
}

def main(dry_run = "--dry-run" in sys.argv) -> None:
    successful: list[str] = []
    failed: list[str] = []
    missing: list[str] = []

    total = len(ASIA_IMPORTS)

    print(f"Стран для импорта: {total}")
    print(f"Папка данных: {DATA_DIR}")
    print()

    if dry_run:
     print("РЕЖИМ DRY RUN — данные в Supabase не загружаются.")
    print()

    for index, (file_name, country_code) in enumerate(
        ASIA_IMPORTS.items(),
        start=1,
    ):
        pbf_path = DATA_DIR / file_name

        print("=" * 70)
        print(
            f"[{index}/{total}] "
            f"{country_code} — {file_name}"
        )
        print("=" * 70)

        if not pbf_path.exists():
            print(
                f"ПРОПУЩЕНО: файл не найден:\n"
                f"{pbf_path}"
            )
            missing.append(country_code)
            print()
            continue

        if dry_run:
         print(f"OK: файл найден")
         print(f"Страна: {country_code}")
         print(f"Файл: {pbf_path}")
         successful.append(country_code)
         print()
         continue

        command = [
            sys.executable,
            str(IMPORT_SCRIPT),
            str(pbf_path),
            country_code,
        ]

        try:
            result = subprocess.run(
                command,
                check=False,
            )
        except Exception as error:
            print(
                f"ОШИБКА запуска {country_code}: "
                f"{error}"
            )
            failed.append(country_code)
            print()
            continue

        if result.returncode == 0:
            successful.append(country_code)

            print(
                f"ГОТОВО: {country_code}"
            )
        else:
            failed.append(country_code)

            print(
                f"ОШИБКА: {country_code}, "
                f"код завершения "
                f"{result.returncode}"
            )

        print()

    print()
    print("=" * 70)
    print("ИТОГ ИМПОРТА АЗИИ")
    print("=" * 70)

    print(
        f"Успешно: {len(successful)}"
    )

    if successful:
        print(
            "  "
            + ", ".join(successful)
        )

    print(
        f"Ошибок: {len(failed)}"
    )

    if failed:
        print(
            "  "
            + ", ".join(failed)
        )

    print(
        f"Файлов не найдено: {len(missing)}"
    )

    if missing:
        print(
            "  "
            + ", ".join(missing)
        )


if __name__ == "__main__":
    main()