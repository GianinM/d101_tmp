import type { LatLon, OsmTags } from "./transport-feature"

// The Swiss server (run by the Swiss OSM association, Switzerland data only)
// is fast and rarely busy; the global ones are fallbacks.
const OVERPASS_URLS = [
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
const REQUEST_TIMEOUT = 30_000

// Roads for vehicles; footways, paths, tracks and cycleways are left out.
const HIGHWAY_TYPES = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
]
const RAILWAY_TYPES = [
  "rail",
  "light_rail",
  "narrow_gauge",
  "subway",
  "tram",
  "funicular",
  "monorail",
]

export type BBox = { south: number; west: number; north: number; east: number }

export type OverpassWay = {
  type: "way"
  id: number
  tags?: OsmTags
  geometry?: LatLon[]
}

function buildQuery({ south, west, north, east }: BBox) {
  const bbox = `${south},${west},${north},${east}`
  return `[out:json][timeout:25];
(
  way["highway"~"^(${HIGHWAY_TYPES.join("|")})$"](${bbox});
  way["railway"~"^(${RAILWAY_TYPES.join("|")})$"](${bbox});
);
out geom;`
}

/**
 * Fetches the roads and railways inside a bounding box. Servers are tried in
 * turn (they are often busy), giving up on each after REQUEST_TIMEOUT.
 */
export async function fetchTransportWays(bbox: BBox, signal: AbortSignal) {
  const body = new URLSearchParams({ data: buildQuery(bbox) })
  const errors: unknown[] = []

  for (const url of OVERPASS_URLS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
      })
      if (!response.ok) throw new Error(`${url} answered ${response.status}`)
      const json = (await response.json()) as { elements: OverpassWay[] }
      return json.elements.filter((element) => element.type === "way")
    } catch (error) {
      if (signal.aborted) throw error // cancelled by the caller: stop here
      errors.push(error)
    }
  }
  throw new AggregateError(errors, "All Overpass servers failed")
}
