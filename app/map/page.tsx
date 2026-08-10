import MountainMap from "@/components/MountainMap/MountainMap";

export default function MapPage() {
  return (
    <main aria-labelledby="map-page-title">
      <h1 id="map-page-title" className="sr-only">
        Интерактивная карта горных вершин
      </h1>
      <MountainMap />
    </main>
  );
}
