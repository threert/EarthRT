// The globe: a CAMetalLayer the core (native/core) traces into from its own thread, and the pointer and keys the
// globe's script reads (it moves the camera itself: drag, orbit, wheel, keys). Everything the script and the
// renderer report comes back through `ert_poll`, polled on the main run loop. From threert/native-app-template.
import AppKit
import QuartzCore
import SwiftUI

final class RenderNSView: NSView {
    let metal = CAMetalLayer()
    private(set) var handle: OpaquePointer?
    /// Called on the main thread with every batch of messages from the core (core/src/lib.rs lists them).
    var onPosts: (([[String: Any]]) -> Void)?
    private var timer: Timer?
    private var tracking: NSTrackingArea?
    private var lastSize = CGSize.zero
    /// The bundle to start with, once the view has a size, and the core's options (launch params, proxy, rendering).
    private var bundle: String?
    var options: [String: Any] = [:]

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer = metal
        metal.isOpaque = true
        metal.backgroundColor = NSColor.black.cgColor
        metal.framebufferOnly = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// The most pixels the view is traced at: a Retina window's 5 million would halve the frame rate for sharpness the
    /// path tracer's own resolve does not have. The layer is scaled up to the view.
    static var maxPixels: CGFloat = 1_600_000
    private var scale: CGFloat {
        let backing = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        let points = max(bounds.width * bounds.height, 1)
        return min(backing, (RenderNSView.maxPixels / points).squareRoot())
    }
    private var pixels: (UInt32, UInt32) {
        (UInt32(max(1, (bounds.width * scale).rounded())), UInt32(max(1, (bounds.height * scale).rounded())))
    }

    /// Starts the renderer on `bundle` (now, or as soon as the view is laid out).
    func start(bundle: String) {
        self.bundle = bundle
        guard handle == nil, bounds.width > 8, bounds.height > 8 else { return }
        metal.contentsScale = scale
        let (w, h) = pixels
        lastSize = bounds.size
        let json = (try? JSONSerialization.data(withJSONObject: options)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        handle = ert_create(Unmanaged.passUnretained(metal).toOpaque(), w, h, Float(scale), bundle, Paths.assets, Paths.presets, json)
        if timer == nil {
            let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.poll() }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
    }

    /// Ends the renderer (its thread is joined).
    func stop() {
        poll()
        if let handle { ert_destroy(handle) }
        handle = nil
    }

    private func poll() {
        guard let handle, let text = ert_poll(handle) else { return }
        defer { ert_free(text) }
        guard let data = String(cString: text).data(using: .utf8),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        onPosts?(list)
    }

    override func layout() {
        super.layout()
        if handle == nil { if let bundle { start(bundle: bundle) }; return }
        guard bounds.size != lastSize, bounds.width > 8, bounds.height > 8 else { return }
        lastSize = bounds.size
        metal.contentsScale = scale
        let (w, h) = pixels
        ert_resize(handle, w, h, Float(scale))
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        lastSize = .zero
        needsLayout = true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    // ----- input: the scene reads it as `f.input` (pointer: "free") -----

    private func point(_ event: NSEvent) {
        guard let handle else { return }
        let p = convert(event.locationInWindow, from: nil)
        ert_pointer(handle, Float(p.x / max(bounds.width, 1)), Float(p.y / max(bounds.height, 1)))
    }
    override func mouseMoved(with event: NSEvent) { point(event) }
    override func mouseDragged(with event: NSEvent) { point(event) }
    override func rightMouseDragged(with event: NSEvent) { point(event) }
    override func otherMouseDragged(with event: NSEvent) { point(event) }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        point(event)
        // A control-click is a right click (orbit), as everywhere on the Mac.
        ert_button(handle, event.modifierFlags.contains(.control) ? 2 : 0, true)
        controlDown = event.modifierFlags.contains(.control)
    }
    private var controlDown = false
    override func mouseUp(with event: NSEvent) { point(event); ert_button(handle, controlDown ? 2 : 0, false) }
    override func rightMouseDown(with event: NSEvent) { point(event); ert_button(handle, 2, true) }
    override func rightMouseUp(with event: NSEvent) { point(event); ert_button(handle, 2, false) }
    override func otherMouseDown(with event: NSEvent) { point(event); ert_button(handle, 1, true) }
    override func otherMouseUp(with event: NSEvent) { point(event); ert_button(handle, 1, false) }
    override func scrollWheel(with event: NSEvent) {
        // A wheel's line is a notch; a trackpad's points are a fortieth of one.
        let dy = event.hasPreciseScrollingDeltas ? Float(event.scrollingDeltaY) / 40 : Float(event.scrollingDeltaY)
        if dy != 0 { ert_wheel(handle, dy) }
    }
    override func magnify(with event: NSEvent) { ert_wheel(handle, Float(event.magnification) * 6) }

    private static let named: [UInt16: String] = [
        49: "Space", 53: "Escape", 33: "BracketLeft", 30: "BracketRight", 43: "Comma", 47: "Period", 50: "Backquote", 27: "Minus", 24: "Equal", 36: "Enter", 48: "Tab", 51: "Backspace", 123: "Left", 124: "Right", 125: "Down", 126: "Up",
        56: "Shift", 60: "Shift", 59: "Ctrl", 62: "Ctrl", 58: "Alt", 61: "Alt", 55: "Meta", 54: "Meta",
    ]
    private func key(_ event: NSEvent, down: Bool) {
        var name = RenderNSView.named[event.keyCode]
        if name == nil, let c = event.charactersIgnoringModifiers?.uppercased(), c.count == 1, let ch = c.unicodeScalars.first,
           (ch.value >= 65 && ch.value <= 90) || (ch.value >= 48 && ch.value <= 57) { name = c }
        guard let name else { return }
        key(name, down: down)
    }
    /// Keys the scene holds down: released together when the view loses the keyboard (a held W would stay down).
    private var held: Set<String> = []
    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command) { super.keyDown(with: event); return }
        if !event.isARepeat { key(event, down: true) }
    }
    override func keyUp(with event: NSEvent) { key(event, down: false) }
    /// Shift, Ctrl, Alt and Cmd come as a change of the modifier flags, not as keyDown / keyUp.
    override func flagsChanged(with event: NSEvent) {
        let flag: NSEvent.ModifierFlags
        switch event.keyCode {
        case 56, 60: flag = .shift
        case 59, 62: flag = .control
        case 58, 61: flag = .option
        case 55, 54: flag = .command
        default: super.flagsChanged(with: event); return
        }
        key(event, down: event.modifierFlags.contains(flag))
    }
    private func releaseKeys() { for name in held { key(name, down: false) } }
    override func resignFirstResponder() -> Bool {
        releaseKeys()
        return super.resignFirstResponder()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // Another app or window takes the keyboard: its key-ups never reach this view.
        NotificationCenter.default.removeObserver(self, name: NSWindow.didResignKeyNotification, object: nil)
        if let window { NotificationCenter.default.addObserver(self, selector: #selector(windowResignedKey), name: NSWindow.didResignKeyNotification, object: window) }
    }
    @objc private func windowResignedKey() { releaseKeys() }

    // ----- for the model (and tests that drive the view) -----

    func send(_ messages: [[String: Any]]) {
        guard JSONSerialization.isValidJSONObject(messages) else {
            FileHandle.standardError.write("earthrt: not JSON, not sent: \(messages)\n".data(using: .utf8)!)
            return
        }
        guard let handle, let data = try? JSONSerialization.data(withJSONObject: messages), let text = String(data: data, encoding: .utf8) else { return }
        ert_send(handle, text)
    }
    func pointer(u: Double, v: Double, button: Int? = nil, down: Bool = false) {
        guard let handle else { return }
        ert_pointer(handle, Float(u), Float(v))
        if let button { ert_button(handle, UInt8(button), down) }
    }
    func wheel(_ notches: Double) { if let handle { ert_wheel(handle, Float(notches)) } }
    func key(_ name: String, down: Bool) {
        guard let handle else { return }
        if down { held.insert(name) } else { held.remove(name) }
        let code = name.count == 1 ? (name.first!.isNumber ? "Digit\(name)" : "Key\(name)") : name
        ert_key(handle, code, name, down)
    }
    func snapshot(to path: String) { if let handle { ert_snapshot(handle, path) } }
    func reload(_ bundle: String) { if let handle { ert_reload(handle, bundle) } }
    /// The Graphics settings: quality, reconstruction, fps, bounces (native/core `ert_rendering`).
    func rendering(_ settings: [String: Any]) {
        guard let handle, let data = try? JSONSerialization.data(withJSONObject: settings), let text = String(data: data, encoding: .utf8) else { return }
        ert_rendering(handle, text)
    }
}

struct RenderView: NSViewRepresentable {
    let view: RenderNSView
    func makeNSView(context: Context) -> RenderNSView { view }
    func updateNSView(_ nsView: RenderNSView, context: Context) {}
}
