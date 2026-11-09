import { useEffect, useRef } from "react"
import {
  Cartesian3,
  Cesium3DTileset,
  CesiumTerrainProvider,
  ImageryLayer,
  Math as CesiumMath,
  Rectangle,
  UrlTemplateImageryProvider,
  Viewer,
} from "cesium"
import "cesium/Build/Cesium/Widgets/widgets.css"
import { LV95, WGS84 } from "@swissgeo/coordinates"

import { addOsmTransportLayer } from "@/lib/osm-transport-layer"
import { cn } from "@/lib/utils"

const TERRAIN_URL = "https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/"
const BUILDINGS_URL =
  "https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json"
const IMAGERY_URL =
  "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swisstlm3d-karte-farbe.3d/default/current/3857/{z}/{x}/{y}.jpeg"

// Imagery is only available over Switzerland (LV95 bounds, expressed in WGS84)
const swissBounds = LV95.getBoundsAs(WGS84)
const imageryRectangle = swissBounds
  ? Rectangle.fromDegrees(...swissBounds.flatten)
  : undefined

export function SwissMap({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let viewer: Viewer | undefined
    let removeOsmLayer: (() => void) | undefined
    // Setup is async: if the component unmounts before it finishes
    // (e.g. React StrictMode double-mount), skip or undo the work.
    let cancelled = false

    async function setupCesium(container: HTMLDivElement) {
      const terrainProvider = await CesiumTerrainProvider.fromUrl(TERRAIN_URL)
      if (cancelled) return

      viewer = new Viewer(container, {
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        infoBox: false,
        selectionIndicator: false,
        fullscreenButton: false,
        navigationHelpButton: false,
        homeButton: false,
        sceneModePicker: false,
        geocoder: false,
        terrainProvider,
        baseLayer: new ImageryLayer(
          new UrlTemplateImageryProvider({
            url: IMAGERY_URL,
            minimumLevel: 8,
            maximumLevel: 17,
            rectangle: imageryRectangle,
          })
        ),
      })
      // Terrain is opaque (nothing should go through)
      viewer.scene.globe.depthTestAgainstTerrain = true

      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(8.67, 46.72, 4500),
        orientation: {
          pitch: CesiumMath.toRadians(-20),
        },
      })

      // Roads and railways from OpenStreetMap, loaded around the camera
      removeOsmLayer = addOsmTransportLayer(viewer)

      // Add buildings
      const swissBuildings = await Cesium3DTileset.fromUrl(BUILDINGS_URL)
      if (cancelled || !viewer || viewer.isDestroyed()) {
        swissBuildings.destroy()
        return
      }
      viewer.scene.primitives.add(swissBuildings)
    }

    setupCesium(container).catch((error) => {
      console.error("Failed to initialise the Swiss map", error)
    })

    return () => {
      cancelled = true
      removeOsmLayer?.()
      if (viewer && !viewer.isDestroyed()) viewer.destroy()
    }
  }, [])

  return <div ref={containerRef} className={cn("relative size-full", className)} />
}
