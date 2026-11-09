import {
  Cartesian2,
  Cartographic,
  ColorGeometryInstanceAttribute,
  Credit,
  Event,
  GeometryInstance,
  GroundPolylineGeometry,
  GroundPolylinePrimitive,
  Math as CesiumMath,
  PolylineColorAppearance,
  type Viewer,
} from "cesium"

import { fetchTransportWays, type BBox } from "./overpass"
import { createTransportFeature, TransportFeature } from "./transport-feature"

/** Above this height (metres above terrain) nothing is loaded or shown. */
const MAX_CAMERA_HEIGHT = 15_000
/** Radius (metres) of the area loaded around the look-at point. */
const MIN_RADIUS = 1_500
const MAX_RADIUS = 6_000
/** Size in pixels of the square searched around a click. */
const PICK_TOLERANCE = 14
/** Max objects looked through when picking (e.g. buildings above a road). */
const PICK_LIMIT = 5

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
  return {
    south: lat - dLat,
    north: lat + dLat,
    west: lon - dLon,
    east: lon + dLon,
  }
}

/**
 * Roads and railways from OpenStreetMap, loaded around the point the camera
 * looks at and draped on the terrain. Every line is a TransportFeature object
 * (Road or Railway) that can be listed, looked up by OSM id, or picked.
 *
 * Data is only requested when the camera is close to the ground: a whole
 * country's worth of roads is far too much for one request.
 */
export class OsmTransportLayer {
  /** Raised with the new feature list each time features are (re)loaded. */
  readonly featuresChanged = new Event<(features: TransportFeature[]) => void>()

  private readonly featuresById = new Map<number, TransportFeature>()
  private readonly credit = new Credit(
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>',
    true
  )
  private primitive?: GroundPolylinePrimitive
  private loadedBBox?: BBox
  private controller?: AbortController
  private removeMoveEndListener?: () => void
  private destroyed = false
  private readonly viewer: Viewer

  constructor(viewer: Viewer) {
    this.viewer = viewer
    if (!GroundPolylinePrimitive.isSupported(viewer.scene)) {
      console.warn("Ground polylines are not supported: OSM layer disabled")
      return
    }
    viewer.creditDisplay.addStaticCredit(this.credit)
    this.removeMoveEndListener = viewer.camera.moveEnd.addEventListener(() => {
      void this.update()
    })
    void this.update()
  }

  /** All features currently loaded. */
  get features() {
    return [...this.featuresById.values()]
  }

  getFeature(osmId: number) {
    return this.featuresById.get(osmId)
  }

  /**
   * The feature drawn at a screen position (e.g. a click), if any.
   * Lines are only a few pixels wide, so a square of `tolerance` pixels around
   * the position is searched, looking past anything drawn on top (buildings).
   */
  pick(windowPosition: Cartesian2, tolerance = PICK_TOLERANCE) {
    const picked: unknown[] = this.viewer.scene.drillPick(
      windowPosition,
      PICK_LIMIT,
      tolerance,
      tolerance
    )
    for (const object of picked) {
      const id =
        object && typeof object === "object" && "id" in object
          ? object.id
          : undefined
      if (id instanceof TransportFeature) return id
    }
    return undefined
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.removeMoveEndListener?.()
    this.controller?.abort()
    if (!this.viewer.isDestroyed()) {
      this.clear()
      this.viewer.creditDisplay.removeStaticCredit(this.credit)
    }
  }

  private clear() {
    if (this.primitive) this.viewer.scene.groundPrimitives.remove(this.primitive) // also destroys it
    this.primitive = undefined
    this.loadedBBox = undefined
    if (this.featuresById.size > 0) {
      this.featuresById.clear()
      this.featuresChanged.raiseEvent([])
    }
  }

  /** Point on the terrain at the centre of the screen. */
  private lookAtPoint() {
    const { scene, camera } = this.viewer
    const ray = camera.getPickRay(
      new Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2)
    )
    const hit = ray && scene.globe.pick(ray, scene)
    return hit ? Cartographic.fromCartesian(hit) : undefined
  }

  private async update() {
    const { scene, camera } = this.viewer
    const cameraPosition = camera.positionCartographic
    const groundHeight = scene.globe.getHeight(cameraPosition) ?? 0
    const heightAboveGround = cameraPosition.height - groundHeight

    if (heightAboveGround > MAX_CAMERA_HEIGHT) {
      this.controller?.abort()
      this.clear()
      return
    }

    // Looking at the sky: fall back to the point below the camera
    const center = this.lookAtPoint() ?? cameraPosition
    const radius = CesiumMath.clamp(
      heightAboveGround * 1.5,
      MIN_RADIUS,
      MAX_RADIUS
    )
    if (this.loadedBBox && contains(this.loadedBBox, bboxAround(center, radius))) {
      return
    }

    // Load a bit more than needed so small camera moves don't trigger a reload
    const requested = bboxAround(center, radius * 1.5)

    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    try {
      const ways = await fetchTransportWays(requested, controller.signal)
      if (controller.signal.aborted || this.destroyed) return

      const features = ways
        .map((way) =>
          createTransportFeature(way.id, way.tags ?? {}, way.geometry ?? [])
        )
        .filter((feature) => feature !== undefined)

      this.show(features)
      this.loadedBBox = requested
      console.info(
        `OSM layer: ${features.length} roads and railways loaded (click one to inspect it)`
      )
    } catch (error) {
      if (controller.signal.aborted) return
      console.warn("Could not load OSM roads and railways", error)
    }
  }

  private show(features: TransportFeature[]) {
    this.clear()
    for (const feature of features) this.featuresById.set(feature.osmId, feature)

    if (features.length > 0) {
      this.primitive = this.viewer.scene.groundPrimitives.add(
        new GroundPolylinePrimitive({
          // One batched primitive; each instance's id is its feature object,
          // so scene.pick() hands back the feature directly
          geometryInstances: features.map(
            (feature) =>
              new GeometryInstance({
                id: feature,
                geometry: new GroundPolylineGeometry({
                  positions: feature.positions,
                  width: feature.style.width,
                }),
                attributes: {
                  color: ColorGeometryInstanceAttribute.fromColor(
                    feature.style.toCesiumColor()
                  ),
                },
              })
          ),
          appearance: new PolylineColorAppearance(),
        })
      )
    }
    this.featuresChanged.raiseEvent(features)
  }
}
