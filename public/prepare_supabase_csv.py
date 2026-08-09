from pathlib import Path

import pandas as pd


project_folder = Path(__file__).resolve().parent

input_file = project_folder / "germany_peaks_700.csv"
output_file = project_folder / "mountains_supabase.csv"


if not input_file.exists():
    raise FileNotFoundError(
        f"Файл не найден: {input_file}"
    )


df = pd.read_csv(input_file)

df = df.rename(
    columns={
        "lat": "latitude",
        "lon": "longitude",
    }
)

required_columns = [
    "osm_id",
    "name",
    "name_de",
    "height",
    "latitude",
    "longitude",
    "wikidata",
    "wikipedia",
    "region_source",
]

missing_columns = [
    column
    for column in required_columns
    if column not in df.columns
]

if missing_columns:
    raise ValueError(
        f"Не хватает колонок: {missing_columns}"
    )


df = df[required_columns]

df = df.drop_duplicates(
    subset=["osm_id"]
)

df = df.sort_values(
    by=["height", "name"],
    ascending=[False, True],
)

df.to_csv(
    output_file,
    index=False,
    encoding="utf-8-sig",
)

print("Готово!")
print(f"Количество вершин: {len(df)}")
print(f"Файл создан: {output_file}")