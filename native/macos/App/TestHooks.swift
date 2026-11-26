// What tests (and `earthrt app '<json>'`) drive the window with: requests of type `app.*` from the sidecar, each
// answered (`answer {id, …}`). Clicks go through the window's own event dispatch (`app.click`), so a control that a
// view in front of it would swallow fails the test as it would fail a person.
import AppKit
import SwiftUI

@MainActor
enum TestHooks {
    static func handle(_ m: [String: Any], model: Model) {
        let t = m["t"] as? String ?? ""
        switch t {
        case "app.pointer":
            let u = m["u"] as? Double ?? 0.5, v = m["v"] as? Double ?? 0.5
            if m["click"] as? Bool == true {
                model.view.pointer(u: u, v: v, button: 0, down: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { model.view.pointer(u: u, v: v, button: 0, down: false) }
            } else if let drag = m["drag"] as? [Double], drag.count == 2 {
                // A drag from (u, v) by (du, dv) over half a second, with `button` (0 moves the globe, 2 orbits).
                let button = m["button"] as? Int ?? 0
                model.view.pointer(u: u, v: v, button: button, down: true)
                for i in 1...15 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.033) {
                        model.view.pointer(u: u + drag[0] * Double(i) / 15, v: v + drag[1] * Double(i) / 15)
                        if i == 15 { model.view.pointer(u: u + drag[0], v: v + drag[1], button: button, down: false) }
                    }
                }
            } else {
                model.view.pointer(u: u, v: v, button: m["button"] as? Int, down: m["down"] as? Bool ?? false)
            }
            model.answer(m)
        case "app.key":
            let key = m["key"] as? String ?? ""
            model.view.key(key, down: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + (m["hold"] as? Double ?? 0.08)) { model.view.key(key, down: false) }
            model.answer(m)
        case "app.wheel":
            model.view.wheel(m["notches"] as? Double ?? 1)
            model.answer(m)
        case "app.prompt":
            model.inspector = .agent
            model.showInspector = true
            model.prompt(m["text"] as? String ?? "")
            model.answer(m)
        case "app.panel":
            if let show = m["show"] as? Bool { model.showInspector = show }
            if let tab = (m["panel"] ?? m["tab"]) as? String, let p = InspectorTab.allCases.first(where: { $0.rawValue.lowercased() == tab.lowercased() }) { model.inspector = p; model.showInspector = true }
            if let s = m["sheet"] as? String {
                switch s { case "publish": model.showPublish = true; case "create": model.createHere(); case "flight": model.showFlight = true; case "time": model.showTime = true
                default: model.showPublish = false; model.showCreate = false; model.showFlight = false; model.showTime = false }
            }
            model.answer(m)
        case "app.open":
            if let text = m["url"] as? String, let url = URL(string: text) { model.open(url: url) }
            model.answer(m)
        case "app.search":
            model.search = m["q"] as? String ?? ""
            model.runSearch()
            if m["submit"] as? Bool == true { model.submitSearch() }
            model.answer(m)
        case "app.select":
            // (`place`, not `id`: the request's own id is `id`.)
            if let id = m["place"] as? String { model.gotoPlace(id) } else { model.select(nil) }
            model.answer(m)
        case "app.choose":
            if let id = m["place"] as? String, let v = model.versions.first(where: { $0.id == id }) { model.choose(v); model.answer(m) }
            else { model.answer(m, ["error": "no version \(m["place"] ?? "") of the selected place"]) }
        case "app.fly":
            model.fly(from: m["from"], to: m["to"] ?? "san-francisco")
            model.answer(m)
        case "app.time":
            model.setTime(hour: m["hour"] as? Double)
            model.answer(m)
        case "app.pick":
            // As if the globe had been clicked at a spot (Create Here's starting point).
            model.pick = Pick(lat: m["lat"] as? Double ?? model.camera.lat, lon: m["lon"] as? Double ?? model.camera.lon, h: m["h"] as? Double ?? model.camera.ground, place: nil, building: nil)
            model.answer(m)
        case "app.create":
            model.pick = Pick(lat: m["lat"] as? Double ?? model.camera.lat, lon: m["lon"] as? Double ?? model.camera.lon, h: 0, place: nil, building: nil)
            model.create(title: m["title"] as? String ?? "A test place", kind: m["kind"] as? String ?? "site", radius: m["radius"] as? Double ?? 40)
            model.answer(m)
        case "app.click":
            // Points from the window's top left (the content's coordinates), as a person clicks.
            let ok = click(x: m["x"] as? Double ?? 0, y: m["y"] as? Double ?? 0, model: model)
            model.answer(m, ok.map { ["hit": $0] } ?? ["error": "no window"])
        case "app.window":
            if let w = model.view.window {
                if let size = m["size"] as? [Double], size.count == 2 { w.setContentSize(NSSize(width: size[0], height: size[1])) }
                if let mode = m["appearance"] as? String { NSApp.appearance = mode == "light" ? NSAppearance(named: .aqua) : mode == "dark" ? NSAppearance(named: .darkAqua) : nil }
                model.answer(m, ["frame": [w.frame.origin.x, w.frame.origin.y, w.frame.width, w.frame.height], "content": [w.contentLayoutRect.width, w.contentLayoutRect.height], "number": w.windowNumber])
            } else { model.answer(m, ["error": "no window"]) }
        case "app.enter":
            if let id = m["place"] as? String { model.enter(id) }
            model.answer(m)
        case "app.exit":
            model.exitTraced(camera: nil)
            model.answer(m)
        case "app.state":
            model.answer(m, state(model))
        default:
            model.answer(m, ["error": "unknown request \(t)"])
        }
    }

    static func state(_ model: Model) -> [String: Any] {
        let c = model.camera
        return [
            "ready": model.ready, "fatal": model.fatal ?? NSNull(),
            "camera": ["lat": c.lat, "lon": c.lon, "alt": c.alt, "heading": c.heading, "pitch": c.pitch, "ground": c.ground],
            "tiles": ["shown": model.tiles.shown, "inFlight": model.tiles.inFlight, "queued": model.tiles.queued],
            "selected": model.selectedID ?? NSNull(),
            "versions": model.versions.map { ["id": $0.id, "title": $0.title, "chosen": $0.chosen, "likes": $0.likes] },
            "nearby": model.nearby.map { ["id": $0.id, "loaded": $0.loaded, "chosen": $0.chosen] },
            "flight": ["state": model.flight.state, "seconds": model.flight.seconds, "duration": model.flight.duration, "from": model.flight.from, "to": model.flight.to],
            "project": model.project.map { ["folder": $0.folder, "id": $0.id] } ?? NSNull(),
            "build": ["seq": model.buildSeq, "ok": model.buildOK], "placeLoaded": model.placeLoaded,
            "downloads": model.downloads.map { ["id": $0.id, "state": $0.state, "done": $0.done, "total": $0.total] },
            "rendering": model.renderStatus, "fps": model.stats["fps"] ?? 0,
            "inspector": model.showInspector ? model.inspector.rawValue : NSNull(),
            "github": model.github?.login ?? NSNull(),
            "traced": model.traced, "entering": model.entering ?? NSNull(), "tracedFatal": model.tracedFatal ?? NSNull(),
            "near": model.near?.id ?? NSNull(), "mapFrameMs": model.mapFrameMs,
            "tasks": model.tasks.values.sorted { $0.id < $1.id }.suffix(6).map { ["id": $0.id, "kind": $0.kind, "state": $0.state, "error": $0.error ?? NSNull(), "lines": Array($0.lines.suffix(4))] as [String: Any] },
            "sidecar": model.sidecarStatus,
        ]
    }

    /// A left click at a point of the window (from its content's top left): mouse down and up through `sendEvent`.
    static func click(x: Double, y: Double, model: Model) -> String? {
        guard let window = model.view.window ?? NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil }), let content = window.contentView else { return nil }
        let p = NSPoint(x: x, y: content.bounds.height - y)
        let hit = content.superview?.hitTest(content.convert(p, to: content.superview)) ?? content.hitTest(p)
        let chain = sequence(first: hit, next: { $0?.superview }).compactMap { $0.map { String(describing: type(of: $0)) } }.prefix(6).joined(separator: " < ")
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                          context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) {
                window.sendEvent(e)
            }
        }
        return chain
    }
}
