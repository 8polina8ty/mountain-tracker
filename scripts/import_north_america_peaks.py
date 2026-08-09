from __future__ import annotations

import subprocess
import sys
from pathlib import Path


DATA_DIR = Path(r"E:\Projekt mounts\date")

IMPORT_SCRIPT = (
    Path(__file__).parent
    / "import_osm_peaks.py"
)
NORTH_AMERICA_IMPORTS = {
    "canada-260806.osm.pbf": "CA",
    "greenland-260806.osm.pbf": "GL",
    "mexico-260806.osm.pbf": "MX",
    "us-260806.osm.pbf": "US",
}

CENTRAL_AMERICA_IMPORTS = {
    "bahamas-260728.osm.pbf": "BS",
    "belize-260728.osm.pbf": "BZ",
    "costa-rica-260728.osm.pbf": "CR",
    "cuba-260728.osm.pbf": "CU",
    "el-salvador-260728.osm.pbf": "SV",
    "guatemala-260728.osm.pbf": "GT",
    "honduras-260728.osm.pbf": "HN",
    "jamaica-260728.osm.pbf": "JM",
    "nicaragua-260728.osm.pbf": "NI",
    "panama-260728.osm.pbf": "PA",
}

def main(dry_run = "--dry-run" in sys.argv) -> None:
    successful: list[str] = []
    failed: list[str] = []
    missing: list[str] = []

    total = len(CENTRAL_AMERICA_IMPORTS)

    print(f"Стран для импорта: {total}")
    print(f"Папка данных: {DATA_DIR}")
    print()

    if dry_run:
     print("РЕЖИМ DRY RUN — данные в Supabase не загружаются.")
    print()

    for index, (file_name, country_code) in enumerate(
        CENTRAL_AMERICA_IMPORTS.items(),
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
    print("ИТОГ ИМПОРТА ЦЕНТРАЛЬНОЙ АМЕРИКИ И КАРИБОВ")
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