from __future__ import annotations

import subprocess
import sys
from pathlib import Path


DATA_DIR = (
    Path(__file__).parent.parent
    / "date"
)

IMPORT_SCRIPT = (
    Path(__file__).parent
    / "import_osm_peaks.py"
)


SOUTH_AMERICA_IMPORTS = {
    "argentina-260806.osm.pbf": "AR",
    "bolivia-260806.osm.pbf": "BO",
    "brazil-260806.osm.pbf": "BR",
    "chile-260806.osm.pbf": "CL",
    "colombia-260806.osm.pbf": "CO",
    "ecuador-260806.osm.pbf": "EC",
    "guyana-260806.osm.pbf": "GY",
    "paraguay-260806.osm.pbf": "PY",
    "peru-260806.osm.pbf": "PE",
    "suriname-260806.osm.pbf": "SR",
    "uruguay-260806.osm.pbf": "UY",
    "venezuela-260806.osm.pbf": "VE",
}
def main() -> None:
    dry_run = "--dry-run" in sys.argv

    successful: list[str] = []
    failed: list[str] = []
    missing: list[str] = []

    total = len(SOUTH_AMERICA_IMPORTS)

    print(f"Стран для импорта: {total}")
    print(f"Папка данных: {DATA_DIR}")
    print()

    if dry_run:
        print(
            "РЕЖИМ DRY RUN — данные в Supabase "
            "не загружаются."
        )
        print()

    for index, (file_name, country_code) in enumerate(
        SOUTH_AMERICA_IMPORTS.items(),
        start=1,
    ):
        pbf_path = DATA_DIR / file_name

        print("=" * 70)
        print(
            f"[{index}/{total}] "
            f"{country_code} — {file_name}"
        )
        print(f"Файл: {pbf_path}")

        if not pbf_path.exists():
            print("ОШИБКА: файл не найден.")
            missing.append(country_code)
            continue

        if dry_run:
            print("OK — файл найден.")
            successful.append(country_code)
            continue

        result = subprocess.run(
            [
                sys.executable,
                str(IMPORT_SCRIPT),
                str(pbf_path),
                country_code,
            ],
            check=False,
        )

        if result.returncode == 0:
            successful.append(country_code)
        else:
            failed.append(country_code)

    print()
    print("=" * 70)
    print("ИТОГ ИМПОРТА ЮЖНОЙ АМЕРИКИ")
    print("=" * 70)

    print(f"Успешно: {len(successful)}")

    if successful:
        print("  " + ", ".join(successful))

    print(f"Ошибок: {len(failed)}")

    if failed:
        print("  " + ", ".join(failed))

    print(f"Файлов не найдено: {len(missing)}")

    if missing:
        print("  " + ", ".join(missing))
def main() -> None:
    dry_run = "--dry-run" in sys.argv

    successful: list[str] = []
    failed: list[str] = []
    missing: list[str] = []

    total = len(SOUTH_AMERICA_IMPORTS)

    print(f"Стран для импорта: {total}")
    print(f"Папка данных: {DATA_DIR}")
    print()

    if dry_run:
        print(
            "РЕЖИМ DRY RUN — данные в Supabase "
            "не загружаются."
        )
        print()

    for index, (file_name, country_code) in enumerate(
        SOUTH_AMERICA_IMPORTS.items(),
        start=1,
    ):
        pbf_path = DATA_DIR / file_name

        print("=" * 70)
        print(
            f"[{index}/{total}] "
            f"{country_code} — {file_name}"
        )
        print(f"Файл: {pbf_path}")

        if not pbf_path.exists():
            print("ОШИБКА: файл не найден.")
            missing.append(country_code)
            continue

        if dry_run:
            print("OK — файл найден.")
            successful.append(country_code)
            continue

        result = subprocess.run(
            [
                sys.executable,
                str(IMPORT_SCRIPT),
                str(pbf_path),
                country_code,
            ],
            check=False,
        )

        if result.returncode == 0:
            successful.append(country_code)
        else:
            failed.append(country_code)

    print()
    print("=" * 70)
    print("ИТОГ ИМПОРТА ЮЖНОЙ АМЕРИКИ")
    print("=" * 70)

    print(f"Успешно: {len(successful)}")

    if successful:
        print("  " + ", ".join(successful))

    print(f"Ошибок: {len(failed)}")

    if failed:
        print("  " + ", ".join(failed))

    print(f"Файлов не найдено: {len(missing)}")

    if missing:
            print("  " + ", ".join(missing))
if __name__ == "__main__":
    main()