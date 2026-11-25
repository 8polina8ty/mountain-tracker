"""Extract real Base Access candidates from Alps PBF."""
import argparse
import json
import pathlib
import time

import osmium

parser = argparse.ArgumentParser()
parser.add_argument("--pbf", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--pbf-sha", required=True)
args = parser.parse_args()

pbf = pathlib.Path(args.pbf)
out = pathlib.Path(args.out)
pbf_sha = args.pbf_sha

t0 = time.monotonic()
cands = []

class H(osmium.SimpleHandler):
    def node(self, n):
        if not n.location.valid():
            return
        tags = dict(n.tags)
        kind = None
        if tags.get("highway") == "trailhead":
            kind = "TRAILHEAD"
        elif tags.get("amenity") == "parking":
            kind = "PARKING"
        elif tags.get("place") in ("village", "hamlet", "isolated_dwelling", "farm"):
            kind = tags["place"].upper()
        elif tags.get("highway") == "bus_stop":
            kind = "BUS_STOP"
        elif tags.get("railway") == "station":
            kind = "TRAIN_STATION"
        elif tags.get("railway") == "halt":
            kind = "HALT"
        elif tags.get("information") == "guidepost":
            kind = "TRAILHEAD_INFO"
        # Hut explicitly excluded as PRIMARY (Base Access V2)
        if tags.get("tourism") in ("alpine_hut", "wilderness_hut"):
            return
        if kind:
            cands.append({
                "osmType": "node",
                "osmId": n.id,
                "kind": kind,
                "name": tags.get("name"),
                "lat": n.location.lat,
                "lon": n.location.lon,
                "tags": tags,
            })

h = H()
h.apply_file(str(pbf), locations=True)

elapsed = time.monotonic() - t0
index = {
    "version": "mountain-tracker/graphhopper-candidate-index/v1",
    "pbfSha256": pbf_sha,
    "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "count": len(cands),
    "candidates": cands,
}
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(index, ensure_ascii=False), encoding="utf8")
meta = out.with_name("candidate-index-meta.json")
meta.write_text(json.dumps({"pbfSha256": pbf_sha, "count": len(cands), "seconds": round(elapsed, 1)}, ensure_ascii=False), encoding="utf8")
print(json.dumps({"status": "BUILT", "count": len(cands), "seconds": round(elapsed, 2), "pbfSha": pbf_sha}))
