import { Cartesian3 } from "cesium"

import { FeatureStyle } from "./feature-style"

export type OsmTags = Readonly<Record<string, string>>
export type LatLon = { readonly lat: number; readonly lon: number }

/** Tunnels are drawn on the terrain surface, so they are faded out. */
const TUNNEL_ALPHA = 0.35
const EARTH_RADIUS = 6_371_000

/** Distance in metres between two points (haversine formula). */
function distance(a: LatLon, b: LatLon) {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h))
}

function parseNumber(value: string | undefined) {
  if (value === undefined) return undefined
  const number = Number.parseFloat(value)
  return Number.isNaN(number) ? undefined : number
}

/** A road or railway from OpenStreetMap (an OSM "way"). */
export abstract class TransportFeature {
  abstract readonly kind: "road" | "railway"

  readonly osmId: number
  readonly tags: OsmTags
  /** Points along the line, in order */
  readonly path: readonly LatLon[]
  /** How this feature is drawn. Tunnels get a faded version of the base style. */
  readonly style: FeatureStyle

  private cachedPositions?: Cartesian3[]

  constructor(osmId: number, tags: OsmTags, path: readonly LatLon[]) {
    this.osmId = osmId
    this.tags = tags
    this.path = path
    const style = this.baseStyle()
    this.style = this.isTunnel ? style.withAlpha(TUNNEL_ALPHA) : style
  }

  /** Style before tunnel fading; each subclass defines its own. */
  protected abstract baseStyle(): FeatureStyle

  /** OSM type, e.g. "primary" for a road or "rail" for a railway. */
  abstract get type(): string

  get name() {
    return this.tags.name
  }

  get isTunnel() {
    return this.tags.tunnel !== undefined && this.tags.tunnel !== "no"
  }

  get isBridge() {
    return this.tags.bridge !== undefined && this.tags.bridge !== "no"
  }

  get operator() {
    return this.tags.operator
  }

  get osmUrl() {
    return `https://www.openstreetmap.org/way/${this.osmId}`
  }

  /** Length in metres. */
  get length() {
    let total = 0
    for (let i = 1; i < this.path.length; i++) {
      total += distance(this.path[i - 1], this.path[i])
    }
    return total
  }

  /** Path as Cesium positions (computed once). */
  get positions() {
    this.cachedPositions ??= Cartesian3.fromDegreesArray(
      this.path.flatMap((point) => [point.lon, point.lat])
    )
    return this.cachedPositions
  }

  /** Plain summary, handy for logging or showing in the UI. */
  describe(): Record<string, unknown> {
    return {
      kind: this.kind,
      type: this.type,
      osmId: this.osmId,
      name: this.name,
      length: Math.round(this.length),
      tunnel: this.isTunnel,
      bridge: this.isBridge,
      operator: this.operator,
      style: { ...this.style },
      osmUrl: this.osmUrl,
    }
  }
}

const ROAD_STYLES: Record<string, FeatureStyle> = {
  motorway: new FeatureStyle("#e8590c", 5),
  trunk: new FeatureStyle("#f76707", 4.5),
  primary: new FeatureStyle("#fab005", 4),
  secondary: new FeatureStyle("#ffd43b", 3.5),
  tertiary: new FeatureStyle("#ffec99", 3),
}
const DEFAULT_ROAD_STYLE = new FeatureStyle("#ffffff", 2)

export class Road extends TransportFeature {
  readonly kind = "road"

  /** OSM highway type, e.g. "motorway", "primary", "residential" */
  get type() {
    return this.tags.highway
  }

  /** Road number, e.g. "A2" */
  get ref() {
    return this.tags.ref
  }

  /** Speed limit in km/h, when tagged as a number */
  get maxSpeed() {
    return parseNumber(this.tags.maxspeed)
  }

  get lanes() {
    return parseNumber(this.tags.lanes)
  }

  get surface() {
    return this.tags.surface
  }

  get isOneway() {
    return this.tags.oneway === "yes" || this.type === "motorway"
  }

  protected baseStyle() {
    // Link roads ("motorway_link", ...) look like the road they connect to
    return ROAD_STYLES[this.type.replace("_link", "")] ?? DEFAULT_ROAD_STYLE
  }

  override describe() {
    return {
      ...super.describe(),
      ref: this.ref,
      maxSpeed: this.maxSpeed,
      lanes: this.lanes,
      surface: this.surface,
      oneway: this.isOneway,
    }
  }
}

const RAILWAY_STYLES: Record<string, FeatureStyle> = {
  rail: new FeatureStyle("#c92a2a", 3.5),
  narrow_gauge: new FeatureStyle("#c92a2a", 3),
  light_rail: new FeatureStyle("#862e9c", 3),
  subway: new FeatureStyle("#862e9c", 3),
  tram: new FeatureStyle("#5f3dc4", 2.5),
  funicular: new FeatureStyle("#1971c2", 3),
  monorail: new FeatureStyle("#1971c2", 3),
}
const DEFAULT_RAILWAY_STYLE = new FeatureStyle("#c92a2a", 3)

export class Railway extends TransportFeature {
  readonly kind = "railway"

  /** OSM railway type, e.g. "rail", "narrow_gauge", "tram" */
  get type() {
    return this.tags.railway
  }

  /** Track gauge in millimetres, e.g. 1435 (standard) or 1000 (metre gauge) */
  get gauge() {
    return parseNumber(this.tags.gauge)
  }

  get isElectrified() {
    const value = this.tags.electrified
    return value !== undefined && value !== "no"
  }

  /** Voltage in volts, when electrified */
  get voltage() {
    return parseNumber(this.tags.voltage)
  }

  /** "main", "branch", "industrial", ... */
  get usage() {
    return this.tags.usage
  }

  /** Number of tracks */
  get tracks() {
    return parseNumber(this.tags.tracks)
  }

  protected baseStyle() {
    return RAILWAY_STYLES[this.type] ?? DEFAULT_RAILWAY_STYLE
  }

  override describe() {
    return {
      ...super.describe(),
      gauge: this.gauge,
      electrified: this.isElectrified,
      voltage: this.voltage,
      usage: this.usage,
      tracks: this.tracks,
    }
  }
}

/**
 * Builds the right feature class for an OSM way, or returns undefined when
 * the way is neither a road nor a railway, or has too few points to draw.
 */
export function createTransportFeature(
  osmId: number,
  tags: OsmTags,
  geometry: readonly LatLon[]
): TransportFeature | undefined {
  // Drop consecutive duplicate points: zero-length segments break the geometry
  const path = geometry.filter(
    (point, i) =>
      i === 0 ||
      point.lat !== geometry[i - 1].lat ||
      point.lon !== geometry[i - 1].lon
  )
  if (path.length < 2) return undefined

  if (tags.railway) return new Railway(osmId, tags, path)
  if (tags.highway) return new Road(osmId, tags, path)
  return undefined
}
