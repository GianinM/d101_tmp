import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  Credit,
  GeometryInstance,
  GroundPolylineGeometry,
  GroundPolylinePrimitive,
  Math as CesiumMath,
  PolylineColorAppearance,
  type Viewer,
} from "cesium"

/**
 * Loads roads and railways from OpenStreetMap (via the Overpass API) around
 * the point the camera looks at, and drapes them on the terrain.
 *
 * Data is only requested when the camera is close to the ground: a whole
 * country's worth of roads is far too much for one request (and the public
 * Overpass servers are rate-limited).
 */

// The Swiss server (run by the Swiss OSM association, Switzerland data only)
// is fast and rarely busy; the global ones are fallbacks.
const OVERPASS_URLS = [
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
const REQUEST_TIMEOUT = 30_000

/** Above this height (metres above terrain) nothing is loaded or shown. */
const MAX_CAMERA_HEIGHT = 15_000
/** Radius (metres) of the area loaded around the look-at point. */
const MIN_RADIUS = 1_500
const MAX_RADIUS = 6_000

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

type Style = { color: string; width: number }

const HIGHWAY_STYLES: Record<string, Style> = {
  motorway: { color: "#e8590c", width: 5 },
  trunk: { color: "#f76707", width: 4.5 },
  primary: { color: "#fab005", width: 4 },
  secondary: { color: "#ffd43b", width: 3.5 },
  tertiary: { color: "#ffec99", width: 3 },
}
const DEFAULT_HIGHWAY_STYLE: Style = { color: "#ffffff", width: 2 }
const RAILWAY_STYLES: Record<string, Style> = {
  rail: { color: "#c92a2a", width: 3.5 },
  narrow_gauge: { color: "#c92a2a", width: 3 },
  light_rail: { color: "#862e9c", width: 3 },
  subway: { color: "#862e9c", width: 3 },
  tram: { color: "#5f3dc4", width: 2.5 },
  funicular: { color: "#1971c2", width: 3 },
  monorail: { color: "#1971c2", width: 3 },
}
const DEFAULT_RAILWAY_STYLE: Style = { color: "#c92a2a", width: 3 }
/** Tunnels are drawn on the surface, so they are faded out. */
const TUNNEL_ALPHA = 0.35

type BBox = { south: number; west: number; north: number; east: number }

type OverpassWay = {
  type: "way"
  id: number
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
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
 * Public Overpass servers are often busy (429 / 502 / 504) or slow to answer,
 * so each one is tried in turn, giving up on a server after REQUEST_TIMEOUT.
 */
async function fetchWays(bbox: BBox, signal: AbortSignal) {
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

function styleFor(tags: Record<string, string>) {
  const style = tags.railway
    ? (RAILWAY_STYLES[tags.railway] ?? DEFAULT_RAILWAY_STYLE)
    : (HIGHWAY_STYLES[tags.highway?.replace("_link", "")] ??
      DEFAULT_HIGHWAY_STYLE)
  const isTunnel = tags.tunnel !== undefined && tags.tunnel !== "no"
  const color = Color.fromCssColorString(style.color).withAlpha(
    isTunnel ? TUNNEL_ALPHA : 1
  )
  return { color, width: style.width }
}

function toGeometryInstance(way: OverpassWay) {
  // Drop consecutive duplicate points: zero-length segments break the geometry
  const points = (way.geometry ?? []).filter(
    (point, i, all) =>
      i === 0 || point.lat !== all[i - 1].lat || point.lon !== all[i - 1].lon
  )
  if (points.length < 2) return undefined

  const { color, width } = styleFor(way.tags ?? {})
  return new GeometryInstance({
    id: { osmId: way.id, tags: way.tags ?? {} },
    geometry: new GroundPolylineGeometry({
      positions: Cartesian3.fromDegreesArray(
        points.flatMap((point) => [point.lon, point.lat])
      ),
      width,
    }),
    attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
  })
}

function contains(outer: BBox, inner: BBox) {
  return (
    inner.south >= outer.south &&
    inner.north <= outer.north &&
    inner.west >= outer.west &&
    inner.east <= outer.east
  )
}

function bboxAround(center: Cartographic, radius: number): BBox {
  const lat = CesiumMath.toDegrees(center.latitude)
  const lon = CesiumMath.toDegrees(center.longitude)
  const dLat = radius / 111_320
  const dLon = radius / (111_320 * Math.cos(center.latitude))
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon }
}

export function addOsmTransportLayer(viewer: Viewer) {
  const { scene, camera } = viewer

  if (!GroundPolylinePrimitive.isSupported(scene)) {
    console.warn("Ground polylines are not supported: OSM layer disabled")
    return () => {}
  }

  const credit = new Credit(
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>',
    true
  )
  viewer.creditDisplay.addStaticCredit(credit)

  let primitive: GroundPolylinePrimitive | undefined
  let loadedBBox: BBox | undefined
  let controller: AbortController | undefined

  function clear() {
    if (primitive) scene.groundPrimitives.remove(primitive) // also destroys it
    primitive = undefined
    loadedBBox = undefined
  }

  /** Point on the terrain at the centre of the screen. */
  function lookAtPoint() {
    const canvas = scene.canvas
    const ray = camera.getPickRay(
      new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)
    )
    const hit = ray && scene.globe.pick(ray, scene)
    return hit ? Cartographic.fromCartesian(hit) : undefined
  }

  async function update() {
    const cameraPosition = camera.positionCartographic
    const groundHeight = scene.globe.getHeight(cameraPosition) ?? 0
    const heightAboveGround = cameraPosition.height - groundHeight

    if (heightAboveGround > MAX_CAMERA_HEIGHT) {
      controller?.abort()
      clear()
      return
    }

    // Looking at the sky: fall back to the point below the camera
    const center = lookAtPoint() ?? cameraPosition
    const radius = CesiumMath.clamp(heightAboveGround * 1.5, MIN_RADIUS, MAX_RADIUS)
    const needed = bboxAround(center, radius)
    if (loadedBBox && contains(loadedBBox, needed)) return

    // Load a bit more than needed so small camera moves don't trigger a reload
    const requested = bboxAround(center, radius * 1.5)

    controller?.abort()
    const ownController = new AbortController()
    controller = ownController
    try {
      const ways = await fetchWays(requested, ownController.signal)
      if (ownController.signal.aborted || viewer.isDestroyed()) return

      const instances = ways
        .map(toGeometryInstance)
        .filter((instance) => instance !== undefined)

      clear()
      if (instances.length > 0) {
        primitive = scene.groundPrimitives.add(
          new GroundPolylinePrimitive({
            geometryInstances: instances,
            appearance: new PolylineColorAppearance(),
          })
        )
      }
      loadedBBox = requested
    } catch (error) {
      if (ownController.signal.aborted) return
      console.warn("Could not load OSM roads and railways", error)
    }
  }

  const removeMoveEndListener = camera.moveEnd.addEventListener(() => {
    void update()
  })
  void update()

  return function remove() {
    removeMoveEndListener()
    controller?.abort()
    if (!viewer.isDestroyed()) {
      clear()
      viewer.creditDisplay.removeStaticCredit(credit)
    }
  }
}
