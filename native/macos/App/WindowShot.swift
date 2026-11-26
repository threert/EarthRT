// A picture of the whole window without the screen: the window's views drawn offscreen over the traced frame. For
// tests and screenshots (`app.shot`); it works while the display sleeps, which a screen capture does not.
// From threert/native-app-template, drawing the window's frame view (toolbar and sidebar included).
import AppKit

enum WindowShot {
    /// `frame`: a picture of `view` (the traced view's, or the map's), drawn under the window's other views; the
    /// views in `hide` are hidden while those are drawn (a WKWebView and a Metal layer do not draw offscreen).
    static func compose(over view: NSView, frame: String, hide: [NSView], to path: String) -> (width: Int, height: Int) {
        guard let window = view.window, let content = window.contentView else { return (0, 0) }
        let root = content.superview ?? content
        let bounds = root.bounds
        let scale = window.backingScaleFactor
        let (w, h) = (Int(bounds.width * scale), Int(bounds.height * scale))
        let was = hide.map(\.isHidden)
        for v in hide { v.isHidden = true }
        let ui = root.bitmapImageRepForCachingDisplay(in: bounds)
        if let ui { root.cacheDisplay(in: bounds, to: ui) }
        for (v, h) in zip(hide, was) { v.isHidden = h }
        guard let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                         isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return (0, 0) }
        out.size = bounds.size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
        if let image = NSImage(contentsOfFile: frame) {
            // (The frame view is not flipped: the globe's rectangle in it, from the bottom.)
            image.draw(in: view.convert(view.bounds, to: root))
        }
        ui?.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
        NSGraphicsContext.restoreGraphicsState()
        try? out.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        try? FileManager.default.removeItem(atPath: frame)
        return (w, h)
    }
}
