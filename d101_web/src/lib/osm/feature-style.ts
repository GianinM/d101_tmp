import { Color } from "cesium"

/** How a transport feature is drawn on the map. */
export class FeatureStyle {
  /** Any CSS colour, e.g. "#e8590c" */
  readonly color: string
  /** Line width in pixels */
  readonly width: number
  /** Opacity, 0 (invisible) to 1 (opaque) */
  readonly alpha: number

  constructor(color: string, width: number, alpha = 1) {
    this.color = color
    this.width = width
    this.alpha = alpha
  }

  withAlpha(alpha: number) {
    return new FeatureStyle(this.color, this.width, alpha)
  }

  toCesiumColor() {
    return Color.fromCssColorString(this.color).withAlpha(this.alpha)
  }
}
