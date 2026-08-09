from __future__ import annotations

import subprocess
import sys
from pathlib import Path


DATA_DIR = Path(r"E:\Projekt mounts\date")

IMPORT_SCRIPT = (
    Path(__file__).parent
    / "import_osm_peaks.py"
)
AFRICA_IMPORTS = {
    "algeria-260728.osm.pbf": "DZ",
    "angola-260728.osm.pbf": "AO",
    "benin-260728.osm.pbf": "BJ",
    "botswana-260728.osm.pbf": "BW",
    "burkina-faso-260728.osm.pbf": "BF",
    "burundi-260728.osm.pbf": "BI",
    "cameroon-260728.osm.pbf": "CM",
    "cape-verde-260728.osm.pbf": "CV",
    "central-african-republic-260728.osm.pbf": "CF",
    "chad-260728.osm.pbf": "TD",
    "comores-260728.osm.pbf": "KM",
    "congo-brazzaville-260728.osm.pbf": "CG",
    "congo-democratic-republic-260728.osm.pbf": "CD",
    "djibouti-260728.osm.pbf": "DJ",
    "egypt-260728.osm.pbf": "EG",
    "equatorial-guinea-260728.osm.pbf": "GQ",
    "eritrea-260728.osm.pbf": "ER",
    "ethiopia-260728.osm.pbf": "ET",
    "gabon-260728.osm.pbf": "GA",
    "ghana-260728.osm.pbf": "GH",
    "guinea-260728.osm.pbf": "GN",
    "guinea-bissau-260728.osm.pbf": "GW",
    "ivory-coast-260728.osm.pbf": "CI",
    "kenya-260728.osm.pbf": "KE",
    "lesotho-260728.osm.pbf": "LS",
    "liberia-260728.osm.pbf": "LR",
    "libya-260728.osm.pbf": "LY",
    "madagascar-260728.osm.pbf": "MG",
    "malawi-260728.osm.pbf": "MW",
    "mali-260728.osm.pbf": "ML",
    "mauritania-260728.osm.pbf": "MR",
    "mauritius-260728.osm.pbf": "MU",
    "morocco-260728.osm.pbf": "MA",
    "mozambique-260728.osm.pbf": "MZ",
    "namibia-260728.osm.pbf": "NA",
    "niger-260728.osm.pbf": "NE",
    "nigeria-260728.osm.pbf": "NG",
    "rwanda-260728.osm.pbf": "RW",
    "sao-tome-and-principe-260728.osm.pbf": "ST",
    "seychelles-260728.osm.pbf": "SC",
    "sierra-leone-260728.osm.pbf": "SL",
    "somalia-260728.osm.pbf": "SO",
    "south-africa-260728.osm.pbf": "ZA",
    "south-sudan-260728.osm.pbf": "SS",
    "sudan-260728.osm.pbf": "SD",
    "swaziland-260728.osm.pbf": "SZ",
    "tanzania-260728.osm.pbf": "TZ",
    "togo-260728.osm.pbf": "TG",
    "tunisia-260728.osm.pbf": "TN",
    "uganda-260728.osm.pbf": "UG",
    "zambia-260728.osm.pbf": "ZM",
    "zimbabwe-260728.osm.pbf": "ZW",
}

def main(dry_run = "--dry-run" in sys.argv) -> None:
    successful: list[str] = []
    failed: list[str] = []
    missing: list[str] = []

    total = len(AFRICA_IMPORTS)

    print(f"Стран для импорта: {total}")
    print(f"Папка данных: {DATA_DIR}")
    print()

    if dry_run:
     print("РЕЖИМ DRY RUN — данные в Supabase не загружаются.")
    print()

    for index, (file_name, country_code) in enumerate(
        AFRICA_IMPORTS.items(),
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