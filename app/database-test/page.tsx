"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/Lib/supabase/client";

type Mountain = {
  id: number;
  osm_id: number;
  name: string | null;
  name_de: string | null;
  height: number;
  latitude: number;
  longitude: number;
  region_source: string | null;
};

export default function DatabaseTestPage() {
  const [mountains, setMountains] = useState<Mountain[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    async function loadMountains() {
      const supabase = createClient();

      const { data, error, count } = await supabase
        .from("mountains")
        .select(
          `
            id,
            osm_id,
            name,
            name_de,
            height,
            latitude,
            longitude,
            region_source
          `,
          {
            count: "exact",
          },
        )
        .order("height", {
          ascending: false,
        })
        .limit(20);

      if (error) {
        console.error(error);
        setErrorMessage(error.message);
        setLoading(false);
        return;
      }

      setMountains(data ?? []);
      setTotalCount(count);
      setLoading(false);
    }

    loadMountains();
  }, []);

  if (loading) {
    return (
      <main className="p-8">
        Загружаю данные из Supabase…
      </main>
    );
  }

  if (errorMessage) {
    return (
      <main className="p-8">
        <h1 className="text-2xl font-bold text-red-700">
          Ошибка подключения
        </h1>

        <pre className="mt-4 whitespace-pre-wrap rounded-xl bg-gray-100 p-4">
          {errorMessage}
        </pre>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-3xl font-bold">
        Проверка базы Mountains
      </h1>

      <p className="mt-2 text-gray-600">
        Всего вершин в базе: {totalCount ?? "неизвестно"}
      </p>

      <div className="mt-6 overflow-hidden rounded-2xl border">
        <table className="w-full text-left">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3">Название</th>
              <th className="p-3">Высота</th>
              <th className="p-3">Регион</th>
              <th className="p-3">OSM ID</th>
            </tr>
          </thead>

          <tbody>
            {mountains.map((mountain) => (
              <tr key={mountain.id} className="border-t">
                <td className="p-3">
                  {mountain.name ||
                    mountain.name_de ||
                    "Безымянная вершина"}
                </td>

                <td className="p-3">
                  {mountain.height} м
                </td>

                <td className="p-3">
                  {mountain.region_source || "—"}
                </td>

                <td className="p-3">
                  {mountain.osm_id}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}