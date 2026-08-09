import type {
  Feature,
  FeatureCollection,
  Point,
} from "geojson";

export type PeakFeatureCollection =
  FeatureCollection<Point, PeakProperties>;


export type PeakProperties = {
  id: number;
  osm_id: number;
  name?: string;
  name_de?: string;
  height: number;
  wikidata?: string;
  wikipedia?: string;
  region_source?: string;
  climbed?: boolean;
};

export type MountainRow = {
  id: number;
  osm_id: number;
  name: string | null;
  name_de: string | null;
  height: number;
  latitude: number;
  longitude: number;
  wikidata: string | null;
  wikipedia: string | null;
  region_source: string | null;
};

export type SelectedPeak = PeakProperties & {
  longitude: number;
  latitude: number;
};


export type PeakFeature =
  Feature<Point, PeakProperties>;
