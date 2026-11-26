// The app's state and the switchboard between its parts: the map (the web's map engine in a WKWebView, MapView.swift),
// the traced view (native/core through RenderNSView), the sidecar (place projects, the agent, the `earthrt` command
// line) and the SwiftUI interface (ARCHITECTURE § 1a, SPEC § 6).
//
//   map      earth.view / places / selected / pick / near / flight / status / prefetched ──▶ model ──▶ the interface
//   UI       goto, select, choose, fly, time, dev, pause ──▶ model ──▶ map (earth.*, SPEC § 6.1)
//   Enter    traced.open {place | dev, camera, utc} ──▶ traced view ──▶ traced.ready: cross-fade in, earth.pause
//   exit     traced.exit {camera} ──▶ earth.goto (0 s), cross-fade out, traced.close
//   sidecar  place.opened / place.built ──▶ model: ert://dev/<name>/ for the map, dev/<name>-<n>/ for the traced view
import AppKit
import Foundation
import SwiftUI

struct View3: Equatable {
    var lat = 35.0, lon = 135.7, alt = 12_000_000.0, heading = 0.0, pitch = -90.0, fov = 45.0, ground = 0.0, utc = Date().timeIntervalSince1970 * 1000
}

struct NearbyPlace: Identifiable, Hashable {
    let id: String
    let title: String
    let kind: String
    let topic: String
    let lat: Double
    let lon: Double
    let chosen: Bool
    let loaded: Bool
}

struct Version: Identifiable, Hashable {
    let id: String
    let title: String
    let author: String
    let likes: Int
    let stars: Int
    let era: String?
    let chosen: Bool
}

struct Pick: Equatable {
    let lat: Double
    let lon: Double
    let h: Double
    let place: String?
    let building: String?
}

struct Flight: Equatable {
    var state = "idle"
    var seconds = 0.0
    var duration = 0.0
    var from = ""
    var to = ""
    var paused = false
    var speedup = 1.0
    var progress: Double { duration > 0 ? min(1, seconds / duration) : 0 }
}

struct Download: Identifiable, Equatable {
    let id: String
    let title: String
    var done = 0
    var total = 0
    var bytes: Int64 = 0
    var failed = 0
    var state = "running"
    var progress: Double { total > 0 ? Double(done) / Double(total) : 0 }
}

struct Project: Equatable {
    let folder: String
    let name: String
    let id: String
    let title: String
    let lat: Double
    let lon: Double
    let repo: String?
    let manifest: [String: Any]
    static func == (a: Project, b: Project) -> Bool { a.folder == b.folder && a.id == b.id && a.title == b.title && a.repo == b.repo }
    init?(_ j: [String: Any]?) {
        guard let j, let folder = j["folder"] as? String else { return nil }
        self.folder = folder
        name = j["name"] as? String ?? (folder as NSString).lastPathComponent
        manifest = j["manifest"] as? [String: Any] ?? [:]
        id = manifest["id"] as? String ?? name
        title = manifest["title"] as? String ?? name
        let a = manifest["anchor"] as? [String: Any]
        lat = (a?["lat"] as? NSNumber)?.doubleValue ?? 0
        lon = (a?["lon"] as? NSNumber)?.doubleValue ?? 0
        repo = j["repo"] as? String
    }
}

struct Problem: Identifiable, Hashable {
    let id = UUID()
    let file: String
    let line: Int
    let message: String
}

struct ConsoleLine: Identifiable {
    let id: Int
    let level: String
    let source: String
    let text: String
    let at = Date()
}

struct AgentInfo: Identifiable, Hashable {
    let id: String
    let name: String
    let installed: Bool
    let version: String
    let note: String
}

struct ChatItem: Identifiable {
    let id: String
    var kind: String
    var text: String
    var title: String
    var toolKind: String
    var status: String
    var path: String
    var added: Int
    var removed: Int
    var options: [(id: String, label: String, kind: String)]
    var entries: [(text: String, status: String)]
    var done: Bool

    init(_ j: [String: Any]) {
        id = j["id"] as? String ?? UUID().uuidString
        kind = j["kind"] as? String ?? "text"
        text = j["text"] as? String ?? ""
        title = j["title"] as? String ?? ""
        toolKind = j["toolKind"] as? String ?? ""
        status = j["status"] as? String ?? ""
        path = j["path"] as? String ?? ""
        let diff = j["diff"] as? [String: Any]
        added = diff?["added"] as? Int ?? 0
        removed = diff?["removed"] as? Int ?? 0
        if path.isEmpty, let p = diff?["path"] as? String { path = p }
        options = (j["options"] as? [[String: Any]] ?? []).map { (id: $0["id"] as? String ?? "", label: $0["label"] as? String ?? "", kind: $0["kind"] as? String ?? "") }
        entries = (j["entries"] as? [[String: Any]] ?? []).map { (text: $0["text"] as? String ?? "", status: $0["status"] as? String ?? "") }
        done = j["done"] as? Bool ?? false
    }
}

/// A long job of the sidecar's (create, remix, publish, meshy, check): its lines as they come, then its end.
struct TaskState: Identifiable {
    let id: Int
    let kind: String
    var state = "running"
    var lines: [String] = []
    var error: String?
    var result: [String: Any]?
}

enum InspectorTab: String, CaseIterable, Identifiable {
    case place = "Place", create = "Create", agent = "Agent"
    var id: String { rawValue }
}

@MainActor
final class Model: ObservableObject {
    static let shared = Model()

    /// The traced view (shown over the map when a place is entered).
    let view = RenderNSView()
    /// The map.
    let map = MapController()
    private let sidecar = Sidecar()

    // The map
    @Published var ready = false
    @Published var fatal: String?
    @Published var adapter = ""
    @Published var hwrt = false
    @Published var stats: [String: Any] = [:]
    @Published var camera = View3()
    @Published var tiles = (shown: 0, inFlight: 0, queued: 0, resident: 0)
    @Published var tileBytes: Int64 = 0
    @Published var gen = ""
    @Published var nearby: [NearbyPlace] = []
    @Published var selectedID: String?
    @Published var versions: [Version] = []
    @Published var record: PlaceRecord?
    @Published var pick: Pick?
    @Published var flight = Flight()
    @Published var downloads: [Download] = []
    @Published var mapGPU = 0.0
    @Published var mapFrameMs = 0.0
    /// A place the camera came close to (`earth.near`): the app offers Enter.
    @Published var near: (id: String, distance: Double)?

    // The traced view
    /// Shown (faded in) over the map.
    @Published var traced = false
    /// Entering: `traced.open` sent, `traced.ready` not yet.
    @Published var entering: String?
    @Published var tracedLoading = (done: 0, total: 0)
    @Published var tracedFatal: String?
    private var tracedStarted = false
    /// The title of the place entered (the traced view's bar).
    @Published var enteredTitle: String?
    private var tracedPlace: String?

    // The interface
    @Published var showInspector = false
    @Published var inspector: InspectorTab = .place
    @Published var search = ""
    @Published var results: [PlaceRecord] = []
    @Published var searching = false
    @Published var showFlight = false
    @Published var showTime = false
    @Published var showPublish = false
    @Published var showCreate = false
    @Published var notice: String?
    @Published var liked: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "liked") ?? [])
    /// The user's version of each topic (sent to the globe at launch: earth.choose).
    @Published var choices: [String: String] = (UserDefaults.standard.dictionary(forKey: "choices") as? [String: String]) ?? [:]
    @Published var solarHour: Double?
    @Published var timeRate = 1.0

    // Graphics (Settings → Graphics; the View menu)
    @AppStorage("quality") var quality = "auto" { didSet { applyRendering() } }
    @AppStorage("reconstruction") var reconstruction = "auto" { didSet { applyRendering() } }
    @AppStorage("fps") var fps = 60 { didSet { applyRendering() } }
    @AppStorage("buildings") var buildings = true { didSet { send(["t": "earth.settings", "buildings": buildings]) } }
    @AppStorage("detail") var detail = 2.0 { didSet { send(["t": "earth.settings", "sse": detail]) } }
    @Published var renderStatus = ""

    // Place projects (the sidecar)
    @Published var sidecarStatus = "starting"
    @Published var project: Project?
    @Published var projects: [Project] = []
    @Published var buildOK = true
    @Published var buildSeq = 0
    @Published var buildMs = 0
    @Published var problems: [Problem] = []
    @Published var devPath: String?
    @Published var placeLoaded = false
    @Published var tasks: [Int: TaskState] = [:]
    @Published var lastTask: [String: Int] = [:]

    // Accounts
    @Published var github: (login: String, via: String)?
    @Published var deviceCode: (code: String, uri: String)?
    @Published var meshyKeySet = Keychain.get("meshy") != nil

    // The agent
    @Published var agents: [AgentInfo] = []
    @Published var agent = "claude"
    @Published var agentStatus = "idle"
    @Published var agentError: String?
    @Published var chat: [ChatItem] = []
    @Published var panel = PanelText()

    // The console
    @Published var console: [ConsoleLine] = []
    @Published var unseenErrors = 0
    private var lineSerial = 0

    private var started = false
    private var snapshots: [String: Int] = [:]
    private var windowShots: [String: (id: Int, path: String)] = [:]
    private var logBatch: [[String: Any]] = []
    private var devSerial = 0
    /// A build of the open place waiting to be seen: on the map (`earth.places` lists it loaded) or, when the traced
    /// view shows it, there (`traced.ready`); then the sidecar hears `runtime.place` (what `earthrt check` waits for).
    private var loadWatch: (seq: Int, id: String, since: Date, errors: [String], traced: Bool)?
    /// The map's address for the open place: ert://dev/<name>@<n>/ (a new one each build: nothing cached is read).
    private var mapDevBase: String?
    private var searchTask: Task<Void, Never>?

    var launchParams: [String: String] = [:]

    func start() {
        guard !started else { return }
        started = true
        view.onPosts = { [weak self] posts in self?.posts(posts) }
        map.onMessage = { [weak self] m in self?.mapMessage(m) }
        map.onConsole = { [weak self] level, text in self?.mapConsole(level, text) }
        sidecar.onMessage = { [weak self] message in self?.receive(message) }
        sidecar.onStatus = { [weak self] status in self?.sidecarStatus = status }
        sidecar.start()
        if FileManager.default.fileExists(atPath: Paths.web + "/index.html") {
            map.load(params: launchParams)
        } else {
            fatal = "The map engine's build is missing (\(Paths.web)): run `bun native/tools/macos.ts`, which builds it."
        }
    }

    /// Starts the traced view's core (the first Enter): on the asset root, paused until a place is ready.
    private func startTraced() -> Bool {
        if tracedStarted { return true }
        guard FileManager.default.fileExists(atPath: Paths.bundle) else {
            tracedFatal = "The traced view's script is missing (\(Paths.bundle)): run `bun native/tools/macos.ts`, which builds it."
            notice = tracedFatal
            return false
        }
        var options: [String: Any] = ["params": [String: String](), "rendering": renderingSettings(), "fps": fps]
        if let proxy = Sidecar.systemProxy() { options["proxy"] = proxy }
        view.options = options
        view.start(bundle: Paths.bundle)
        tracedStarted = true
        return true
    }

    func stop() {
        view.stop()
        sidecar.stop()
    }

    // ----- to the map, to the traced view -----

    func send(_ message: [String: Any]) { map.send(message) }

    func tracedSend(_ message: [String: Any]) { view.send([message]) }

    /// The map's camera as the traced view takes it (SPEC § 6.2 `traced.open`).
    private var cameraJSON: [String: Any] {
        ["lat": camera.lat, "lon": camera.lon, "alt": camera.alt, "heading": camera.heading, "pitch": camera.pitch, "fov": camera.fov]
    }

    // ----- Enter: a place path-traced, over the map, from the map's camera -----

    /// Enters a place (a registry id, or "dev/<id>" for the open project).
    func enter(_ id: String) {
        guard startTraced() else { return }
        entering = id
        enteredTitle = id.hasPrefix("dev/") ? project?.title : (nearby.first(where: { $0.id == id })?.title ?? (record?.id == id ? record?.title : nil))
        tracedLoading = (0, 0)
        if id.hasPrefix("dev/"), let p = project, let path = tracedDevPath {
            tracedSend(["t": "traced.open", "dev": ["path": path, "manifest": p.manifest], "camera": cameraJSON, "utc": camera.utc])
            tracedPlace = id
            return
        }
        Task {
            guard let raw = try? await Registry.raw(id) else { notice = "Could not load \(id) from the registry"; entering = nil; return }
            // From far away (above the place's enterFrom, or not near it), the map goes to the place first: the traced
            // view starts where the map then stands (it leaves at once when its camera is above enterFrom).
            let m = raw["manifest"] as? [String: Any] ?? [:]
            let a = m["anchor"] as? [String: Any] ?? [:]
            let enterFrom = (m["enterFrom"] as? NSNumber)?.doubleValue ?? 150
            let dLat = ((a["lat"] as? NSNumber)?.doubleValue ?? camera.lat) - camera.lat, dLon = ((a["lon"] as? NSNumber)?.doubleValue ?? camera.lon) - camera.lon
            let dist = hypot(dLat * 111_320, dLon * 111_320 * cos(camera.lat * .pi / 180))
            if camera.alt - camera.ground > enterFrom * 0.8 || dist > enterFrom {
                send(["t": "earth.gotoPlace", "id": id])
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard entering == id else { return }
            }
            tracedSend(["t": "traced.open", "place": raw, "camera": cameraJSON, "utc": camera.utc])
            tracedPlace = id
        }
    }

    /// Back to the map, where the traced view's camera is (or the map's, if it never showed).
    func exitTraced(camera c: [String: Any]? = nil) {
        if let c, let lat = c["lat"] as? Double, let lon = c["lon"] as? Double, let alt = c["alt"] as? Double {
            var m: [String: Any] = ["t": "earth.goto", "lat": lat, "lon": lon, "alt": alt, "seconds": 0]
            for k in ["heading", "pitch", "fov"] { if let v = c[k] { m[k] = v } }
            send(m)
        }
        send(["t": "earth.pause", "paused": false])
        withAnimation(.easeInOut(duration: 0.45)) { traced = false }
        entering = nil
        tracedPlace = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, !self.traced else { return }
            self.tracedSend(["t": "traced.close"])
            self.view.pause(true)
        }
    }

    /// The map's id for the open project's place ("dev/…/<id>").
    var devPlaceID: String? {
        guard let p = project else { return nil }
        return nearby.first(where: { $0.id.hasPrefix("dev/") && $0.id.hasSuffix("/" + p.id) })?.id ?? "dev/\(p.id)"
    }
    private var flownTo: String?

    /// The traced view's link to the open project (dev mode).
    private var tracedDevPath: String?

    func goto(lat: Double, lon: Double, alt: Double, heading: Double? = nil, pitch: Double? = nil, seconds: Double = 3) {
        var m: [String: Any] = ["t": "earth.goto", "lat": lat, "lon": lon, "alt": alt, "seconds": seconds]
        if let heading { m["heading"] = heading }
        if let pitch { m["pitch"] = pitch }
        send(m)
    }

    func goto(_ city: City) { goto(lat: city.lat, lon: city.lon, alt: city.alt, heading: 0, pitch: -35) }

    func home() { goto(lat: camera.lat, lon: camera.lon, alt: 12_000_000, heading: 0, pitch: -90, seconds: 3) }

    func gotoPlace(_ id: String) {
        send(["t": "earth.gotoPlace", "id": id])
        select(id)
    }

    func select(_ id: String?) {
        var m: [String: Any] = ["t": "earth.select"]
        m["id"] = id.map { $0 as Any } ?? NSNull()
        send(m)
        if id != nil { inspector = .place; showInspector = true }
    }

    func choose(_ version: Version) {
        guard let topic = record?.topic ?? nearby.first(where: { $0.id == version.id })?.topic else { return }
        choices[topic] = version.id
        UserDefaults.standard.set(choices, forKey: "choices")
        send(["t": "earth.choose", "topic": topic, "id": version.id])
        selectedID = version.id
        Task { await loadRecord(version.id) }
    }

    func fly(from: Any?, to: Any) {
        var m: [String: Any] = ["t": "earth.fly", "to": to]
        if let from { m["from"] = from }
        send(m)
        showFlight = false
        near = nil
        // (The names the flight card shows, if the map does not say them.)
        let name = { (x: Any?) -> String in
            if let d = x as? [String: Any] { return d["title"] as? String ?? String(format: "%.2f, %.2f", d["lat"] as? Double ?? 0, d["lon"] as? Double ?? 0) }
            if let id = x as? String { return City.all.first(where: { $0.id == id })?.name ?? self.nearby.first(where: { $0.id == id })?.title ?? id }
            return "Here"
        }
        flightNames = (name(from), name(to))
    }
    private var flightNames = ("", "")

    func stopFlight() { send(["t": "earth.stop"]) }

    func setTime(hour: Double?) {
        if let hour {
            solarHour = hour
            send(["t": "earth.time", "solarHour": hour, "rate": timeRate])
        } else {
            solarHour = nil
            send(["t": "earth.time", "utc": Date().timeIntervalSince1970 * 1000, "rate": 1])
            timeRate = 1
        }
        if traced { tracedSend(["t": "traced.time", "utc": hour.map(utc(solarHour:)) ?? Date().timeIntervalSince1970 * 1000, "rate": timeRate]) }
    }

    func setTimeRate(_ rate: Double) {
        timeRate = rate
        send(["t": "earth.time", "rate": rate])
    }

    func shiftTime(hours: Double) {
        let hour = ((localSolarHour + hours).truncatingRemainder(dividingBy: 24) + 24).truncatingRemainder(dividingBy: 24)
        setTime(hour: hour)
    }

    /// The UTC moment (ms) when it is `solarHour` at the camera's longitude, on the map clock's day.
    func utc(solarHour: Double) -> Double {
        let day = (camera.utc / 86_400_000).rounded(.down) * 86_400_000
        var u = day + (solarHour - camera.lon / 15) * 3_600_000
        if u < day - 43_200_000 { u += 86_400_000 }
        return u
    }

    /// Local solar time at the camera, hours (from the map's clock in earth.view).
    var localSolarHour: Double {
        let h = camera.utc / 3_600_000 + camera.lon / 15
        return (h.truncatingRemainder(dividingBy: 24) + 24).truncatingRemainder(dividingBy: 24)
    }

    func downloadArea(lat: Double? = nil, lon: Double? = nil, radius: Double? = nil, title: String? = nil) {
        let la = lat ?? camera.lat, lo = lon ?? camera.lon
        let r = radius ?? min(max(camera.alt - camera.ground, 2000) * 1.5, 40_000)
        let id = "area-\(Int(Date().timeIntervalSince1970))"
        let name = title ?? String(format: "%.3f°, %.3f° · %@", la, lo, distance(r))
        downloads.insert(Download(id: id, title: name), at: 0)
        send(["t": "earth.prefetch", "id": id, "area": ["lat": la, "lon": lo, "radius": r]])
        notice = "Downloading \(name) for offline use"
    }

    func downloadFlight() {
        guard flight.state == "flying" else { return }
        let id = "flight-\(Int(Date().timeIntervalSince1970))"
        downloads.insert(Download(id: id, title: "Flight \(flight.from) → \(flight.to)"), at: 0)
        send(["t": "earth.prefetch", "id": id, "flight": true])
        notice = "Downloading the flight \(flight.from) → \(flight.to)"
    }

    func cancelDownload(_ id: String) { send(["t": "earth.prefetchCancel", "id": id]) }

    // ----- Graphics -----

    func renderingSettings() -> [String: Any] {
        let recon: Any = reconstruction == "auto" ? "auto" : reconstruction == "metalfx" ? ["metalfx-denoised", "metalfx", "builtin"] : ["builtin"]
        return ["quality": quality, "reconstruction": recon]
    }

    func applyRendering() {
        var s = renderingSettings()
        s["fps"] = fps
        view.rendering(s)
    }

    // ----- links: earthrt://open?at=…&place=…&fly=…, earthrt://dev?path=… (SPEC § 7) -----

    func open(url: URL) {
        guard url.scheme == "earthrt" else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        var q: [String: String] = [:]
        for i in items { if let v = i.value { q[i.name] = v } }
        let action = url.host ?? url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if action == "dev", let path = q["path"] {
            openFolder(path)
            return
        }
        // Before the map is loaded, a link's parameters are its launch parameters (SPEC § 7).
        if !started {
            for (k, v) in q where ["at", "place", "fly", "time", "utc", "api"].contains(k) { launchParams[k] = v }
            if action == "enter", let place = q["place"] { pendingEnter = place }
            return
        }
        if traced { exitTraced() }
        if action == "enter", let place = q["place"] {
            gotoPlace(place)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.enter(place) }
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        if let at = q["at"] {
            let n = at.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            if n.count >= 2 { goto(lat: n[0], lon: n[1], alt: n.count > 2 ? n[2] : 3000, heading: n.count > 3 ? n[3] : 0, pitch: n.count > 4 ? n[4] : -30, seconds: 4) }
        }
        if let place = q["place"] { gotoPlace(place) }
        if let route = q["fly"] {
            let ends = route.split(whereSeparator: { $0 == ";" || $0 == "|" }).map(String.init)
            if ends.count == 2 { fly(from: point(ends[0]), to: point(ends[1])) }
        }
        if let time = q["time"], let h = Double(time) { setTime(hour: h) }
        NSApp.activate(ignoringOtherApps: true)
    }

    private var pendingEnter: String?

    /// One end of a flight from a link: "lat,lon" as a point, anything else (a city, a place id) as it is.
    private func point(_ s: String) -> Any {
        let n = s.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        return n.count >= 2 ? ["lat": n[0], "lon": n[1]] as [String: Any] : s
    }

    // ----- the sidebar: one selection for cities ("city:<id>"), places (their id), projects ("folder:<path>") -----

    @Published var sidebarSelection: String?

    func sidebarPick(_ tag: String?) {
        sidebarSelection = tag
        guard let tag else { return }
        if tag.hasPrefix("city:"), let city = City.all.first(where: { "city:" + $0.id == tag }) { goto(city) }
        else if tag.hasPrefix("folder:") { openFolder(String(tag.dropFirst(7))) }
        else if tag.hasPrefix("at:") {
            let n = tag.dropFirst(3).split(separator: ",").compactMap { Double($0) }
            if n.count == 2 { goto(lat: n[0], lon: n[1], alt: 3000, heading: 0, pitch: -35, seconds: 4) }
        } else { gotoPlace(tag) }
    }

    // ----- search -----

    func runSearch() {
        searchTask?.cancel()
        let q = search.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { results = []; searching = false; return }
        searching = true
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            let found = (try? await Registry.search(q)) ?? []
            guard !Task.isCancelled else { return }
            self?.results = found
            self?.searching = false
        }
    }

    /// Return in the search field: coordinates, then a city, then the first place found.
    func submitSearch() {
        if let c = parseCoordinates(search) { goto(lat: c.lat, lon: c.lon, alt: 3000, heading: 0, pitch: -35, seconds: 4); return }
        if let city = City.find(search).first, !search.isEmpty { goto(city); return }
        if let first = results.first { gotoPlace(first.id) }
    }

    func loadRecord(_ id: String) async {
        guard !id.hasPrefix("dev/") else { record = nil; return }
        if let r = try? await Registry.place(id) { if selectedID == id || versions.contains(where: { $0.id == id }) { record = r } }
    }

    func toggleLike(_ id: String) {
        let on = !liked.contains(id)
        Task {
            guard let token = Keychain.get("github") ?? ghToken else {
                notice = "Sign in to GitHub to like places (Settings → Accounts)"
                return
            }
            do {
                try await Registry.like(id, on, token: token)
                if on { liked.insert(id) } else { liked.remove(id) }
                UserDefaults.standard.set(Array(liked), forKey: "liked")
                versions = versions.map { $0.id == id ? Version(id: $0.id, title: $0.title, author: $0.author, likes: $0.likes + (on ? 1 : -1), stars: $0.stars, era: $0.era, chosen: $0.chosen) : $0 }
            } catch { notice = error.localizedDescription }
        }
    }

    /// The `gh` command line's token, when that is how the user is signed in (kept in memory only: it is gh's).
    private var ghToken: String?

    // ----- making places -----

    func createHere() {
        if pick == nil { pick = Pick(lat: camera.lat, lon: camera.lon, h: camera.ground, place: nil, building: nil) }
        showCreate = true
    }

    func create(title: String, kind: String, radius: Double) {
        guard let pick else { return }
        showCreate = false
        runTask("place.create", ["lat": pick.lat, "lon": pick.lon, "title": title, "kind": kind, "radius": radius])
        inspector = .create
        showInspector = true
    }

    func remix(_ repo: String) {
        runTask("place.remix", ["repo": repo])
        inspector = .create
        showInspector = true
    }

    func openFolder(_ path: String) {
        runTask("place.open", ["folder": path])
        inspector = .create
        showInspector = true
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.directoryURL = URL(fileURLWithPath: Paths.places)
        panel.message = "Choose a place's folder (it has an earthrt.json)"
        panel.prompt = "Open Place"
        if panel.runModal() == .OK, let url = panel.url { openFolder(url.path) }
    }

    func closePlace() { sidecarSend("place.close") }

    func publish(repo: String, dryRun: Bool) { runTask("place.publish", ["repo": repo, "dryRun": dryRun]) }

    func meshy(prompt: String, name: String, height: Double, mock: Bool) {
        runTask("meshy.generate", ["mode": "text", "prompt": prompt, "name": name, "height": height, "at": [0, 0], "mock": mock])
    }

    func fullCheck() { runTask("place.check", [:]) }

    func signInGitHub() { runTask("github.signin", ["clientId": UserDefaults.standard.string(forKey: "githubClientId") ?? ""]) }

    func signOutGitHub() {
        Keychain.set("github", nil)
        sidecarSend("settings", ["githubToken": ""])
        github = nil
        refreshGitHub()
    }

    func refreshGitHub() { runTask("github.whoami", [:]) }

    func setMeshyKey(_ key: String?) {
        Keychain.set("meshy", key)
        meshyKeySet = key?.isEmpty == false
        sidecarSend("settings", ["meshyKey": key ?? ""])
    }

    func revealProject() {
        guard let project else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: project.folder + "/earthrt.json")])
    }

    func openRepository(_ repo: String) {
        if let url = URL(string: "https://github.com/\(repo)") { NSWorkspace.shared.open(url) }
    }

    /// The last task of a kind (create, publish, meshy, …).
    func task(_ kind: String) -> TaskState? { lastTask[kind].flatMap { tasks[$0] } }

    private func runTask(_ type: String, _ fields: [String: Any]) {
        sidecarSend(type, fields)
    }

    func sidecarSend(_ type: String, _ fields: [String: Any] = [:]) {
        var message = fields
        message["t"] = type
        sidecar.send(message)
    }

    // ----- the agent -----

    func prompt(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        sidecarSend("agent.prompt", ["text": trimmed])
    }

    func askToFix() {
        var lines = problems.prefix(5).map { "\($0.file):\($0.line) \($0.message)" }
        lines += console.suffix(40).filter { $0.level == "error" }.suffix(3).map { "[\($0.source)] \($0.text)" }
        prompt("The place has a problem. Run `earthrt check`, find the cause and fix it.\n\n" + lines.joined(separator: "\n"))
    }

    // ----- from the sidecar -----

    private func receive(_ m: [String: Any]) {
        switch m["t"] as? String ?? "" {
        case "state": state(m)
        case "place.opened":
            guard let p = Project(m["project"] as? [String: Any]) else { return }
            project = p
            devPath = nil
            placeLoaded = false
            chat = []
            sidecarSend("place.list")
            notice = "\(p.title) is open in dev mode"
        case "place.closed":
            project = nil
            devPath = nil
            send(["t": "earth.dev", "path": NSNull()])
        case "place.built":
            builtPlace(m)
        case "place.list":
            projects = (m["projects"] as? [[String: Any]] ?? []).compactMap(Project.init)
        case "task":
            taskMessage(m)
        case "github.device":
            deviceCode = (m["userCode"] as? String ?? "", m["uri"] as? String ?? "https://github.com/login/device")
        case "agent.item":
            guard let j = m["item"] as? [String: Any] else { return }
            let item = ChatItem(j)
            if let i = chat.firstIndex(where: { $0.id == item.id }) { chat[i] = item } else { chat.append(item) }
        case "agent.delta":
            guard let id = m["id"] as? String, let text = m["text"] as? String, let i = chat.firstIndex(where: { $0.id == id }) else { return }
            chat[i].text += text
        case "agent.history":
            chat = (m["items"] as? [[String: Any]] ?? []).map(ChatItem.init)
        case "app.snapshot": snapshotRequest(m)
        case "app.shot":
            guard let id = m["id"] as? Int, let path = m["path"] as? String else { return }
            let frame = NSTemporaryDirectory() + "earthrt-window-\(id).png"
            DispatchQueue.main.asyncAfter(deadline: .now() + (m["wait"] as? Double ?? 0.5)) { [weak self] in
                guard let self else { return }
                if self.traced {
                    self.windowShots[frame] = (id, path)
                    self.view.snapshot(to: frame)
                } else {
                    self.map.snapshot(to: frame) { _, _ in
                        let size = WindowShot.compose(over: self.map.web, frame: frame, hide: [self.view, self.map.web], to: path)
                        self.sidecarSend("answer", ["id": id, "path": path, "width": size.width, "height": size.height])
                    }
                }
            }
        case "app.send":
            // (`earthrt send`: earth.* for the map, traced.* for the traced view.)
            for msg in m["messages"] as? [[String: Any]] ?? [] {
                if (msg["t"] as? String ?? "").hasPrefix("earth.") { send(msg) } else { tracedSend(msg) }
            }
        default:
            if let type = m["t"] as? String, type.hasPrefix("app.") { TestHooks.handle(m, model: self) }
            else if m["t"] as? String == "error" { addLine(level: "error", source: "sidecar", text: m["message"] as? String ?? "") }
        }
    }

    func answer(_ m: [String: Any], _ fields: [String: Any] = [:]) {
        guard let id = m["id"] else { return }
        var reply = fields
        reply["id"] = id
        sidecarSend("answer", reply)
    }

    private func state(_ m: [String: Any]) {
        if let text = m["panel"] as? [String: Any] { panel = PanelText(text) }
        if let place = m["place"] as? [String: Any] {
            let p = Project(place["project"] as? [String: Any])
            if p != project { project = p }
            if let build = place["build"] as? [String: Any] {
                buildOK = build["ok"] as? Bool ?? true
                buildSeq = build["seq"] as? Int ?? 0
                buildMs = build["ms"] as? Int ?? 0
                problems = (build["problems"] as? [[String: Any]] ?? []).map { Problem(file: $0["file"] as? String ?? "", line: $0["line"] as? Int ?? 0, message: $0["message"] as? String ?? "") }
            }
        }
        if let a = m["agent"] as? [String: Any] {
            agent = a["selected"] as? String ?? agent
            agentStatus = a["status"] as? String ?? "idle"
            agentError = a["error"] as? String
            agents = (a["agents"] as? [[String: Any]] ?? []).map {
                AgentInfo(id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? "", installed: $0["installed"] as? Bool ?? false,
                          version: $0["version"] as? String ?? "", note: $0["note"] as? String ?? "")
            }
        }
        // The first state of a sidecar: hand it the Keychain's secrets, list the projects, ask who is signed in.
        if !sidecarPrimed {
            sidecarPrimed = true
            sidecarSend("settings", ["meshyKey": Keychain.get("meshy") ?? "", "githubToken": Keychain.get("github") ?? "",
                                     "githubClientId": UserDefaults.standard.string(forKey: "githubClientId") ?? ""])
            sidecarSend("place.list")
            refreshGitHub()
        }
    }
    private var sidecarPrimed = false

    private func builtPlace(_ m: [String: Any]) {
        guard let p = Project(m["project"] as? [String: Any]) else { return }
        project = p
        let seq = m["seq"] as? Int ?? 0
        buildSeq = seq
        buildOK = m["ok"] as? Bool ?? false
        buildMs = m["ms"] as? Int ?? 0
        problems = (m["problems"] as? [[String: Any]] ?? []).map { Problem(file: $0["file"] as? String ?? "", line: $0["line"] as? Int ?? 0, message: $0["message"] as? String ?? "") }
        guard buildOK else {
            addLine(level: "error", source: "place", text: problems.first.map { "\($0.file):\($0.line) \($0.message)" } ?? "the build failed")
            sidecarSend("runtime.place", ["seq": seq, "loaded": false, "errors": problems.map(\.message)])
            return
        }
        // Addresses of their own for each build: neither view reads a file it kept from the build before.
        devSerial += 1
        let manifest = m["manifest"] as? [String: Any] ?? p.manifest
        map.scheme.devFolders["\(p.name)@\(devSerial)"] = p.folder
        let base = "ert://dev/\(p.name)@\(devSerial)/"
        mapDevBase = base
        let path = Paths.linkDev(name: p.name, folder: p.folder, serial: devSerial)
        tracedDevPath = path
        devPath = path
        placeLoaded = false
        send(["t": "earth.dev", "base": base, "manifest": manifest])
        let inTraced = (traced || entering != nil) && tracedPlace == "dev/\(p.id)"
        if inTraced {
            tracedSend(["t": "traced.open", "dev": ["path": path, "manifest": manifest], "camera": cameraJSON, "utc": camera.utc])
        }
        loadWatch = (seq, p.id, Date(), [], inTraced)
        // The first build of a place opened: go to it (the map loads it when the camera is in its visibleFrom).
        if flownTo != p.folder {
            flownTo = p.folder
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                guard let self, let id = self.devPlaceID else { return }
                self.send(["t": "earth.gotoPlace", "id": id])
            }
        }
        addLine(level: "info", source: "place", text: "built \(p.name) (#\(seq), \(buildMs) ms): reloading it \(inTraced ? "in the traced view" : "on the map")")
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
            guard let self, let w = self.loadWatch, w.seq == seq else { return }
            self.loadWatch = nil
            self.sidecarSend("runtime.place", ["seq": seq, "loaded": false, "errors": w.errors + ["the \(w.traced ? "traced view" : "map") did not show the place within 25 s"]])
        }
    }

    private func taskMessage(_ m: [String: Any]) {
        guard let id = m["id"] as? Int else { return }
        let kind = m["kind"] as? String ?? ""
        var t = tasks[id] ?? TaskState(id: id, kind: kind)
        t.state = m["state"] as? String ?? t.state
        if let line = m["line"] as? String, !line.isEmpty { t.lines.append(line); if t.lines.count > 400 { t.lines.removeFirst(100) } }
        if let e = m["error"] as? String { t.error = e }
        if let r = m["result"] as? [String: Any] { t.result = r }
        tasks[id] = t
        lastTask[kind] = id
        if t.state == "failed", let e = t.error { addLine(level: "error", source: kind, text: e); if kind != "github" { notice = e } }
        if t.state == "done" {
            switch kind {
            case "github", "github.signin":
                if let token = t.result?["token"] as? String { Keychain.set("github", token); sidecarSend("settings", ["githubToken": token]) }
                deviceCode = nil
                if let token = t.result?["ghToken"] as? String { ghToken = token }
                let user = t.result?["user"] as? [String: Any]
                if let login = user?["login"] as? String { github = (login, t.result?["via"] as? String ?? "app") }
                else if t.result?["signedIn"] as? Bool == false { github = nil }
            case "meshy":
                notice = (t.result?["mock"] as? Bool == true) ? "A placeholder model is in the place (no Meshy key: Meshy's stand-in)" : "The model is in the place"
            case "publish":
                notice = (t.result?["dryRun"] as? Bool == true) ? "Dry run passed: Publish would create the repository and register it" : "Published"
            case "create", "remix", "open": sidecarSend("place.list")
            default: break
            }
        }
    }

    // ----- from the traced view (the core) -----

    private func posts(_ list: [[String: Any]]) {
        for p in list {
            switch p["t"] as? String ?? "" {
            case "rt.ready":
                adapter = p["adapter"] as? String ?? ""
                hwrt = p["hwrt"] as? Bool ?? false
                view.pause(entering == nil)
            case "rt.fatal":
                tracedFatal = p["message"] as? String ?? "The path tracer could not start"
                notice = tracedFatal
                entering = nil
                addLine(level: "error", source: "traced", text: tracedFatal!)
            case "rt.error":
                let place = p["where"] as? String ?? "?"
                let message = p["message"] as? String ?? ""
                addLine(level: "error", source: "traced " + place, text: message)
                sidecarSend("runtime.error", ["where": place, "message": message])
                if loadWatch != nil { loadWatch!.errors.append("[traced \(place)] \(message)") }
            case "rt.stats":
                stats = p
                if let r = p["rendering"] as? [String: Any] { renderStatus = Model.describe(rendering: r) }
                sidecarSend("runtime.stats", ["stats": p.filter { $0.value is NSNumber }])
            case "rt.snapshot": snapshotTaken(p)
            case "log":
                let level = p["level"] as? String ?? "log"
                let text = p["text"] as? String ?? ""
                addLine(level: level, source: "traced", text: text)
                logBatch.append(["level": level, "text": "traced: " + text])
                if loadWatch != nil, level == "error" || text.contains("dev place") { loadWatch!.errors.append(text) }
            case "traced.loading":
                tracedLoading = (p["done"] as? Int ?? 0, p["total"] as? Int ?? 0)
            case "traced.ready":
                guard entering != nil || traced else { break }
                view.pause(false)
                withAnimation(.easeInOut(duration: 0.45)) { traced = true }
                entering = nil
                // The map stops drawing under it.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in if self?.traced == true { self?.send(["t": "earth.pause", "paused": true]) } }
                if let w = loadWatch, w.traced { loadWatch = nil; sidecarSend("runtime.place", ["seq": w.seq, "loaded": true, "errors": w.errors, "view": "traced"]) }
            case "traced.view":
                // (While the map is paused, the camera the status bar shows is the traced view's.)
                var v = camera
                for (k, value) in p { if let n = (value as? NSNumber)?.doubleValue {
                    switch k { case "lat": v.lat = n; case "lon": v.lon = n; case "alt": v.alt = n; case "heading": v.heading = n; case "pitch": v.pitch = n; case "fov": v.fov = n; default: break }
                } }
                if traced, v != camera { camera = v }
            case "traced.exit":
                exitTraced(camera: p["camera"] as? [String: Any])
            case "traced.status":
                if let r = p["reconstruction"] as? String { renderStatus = r + (renderStatus.contains("·") ? " ·" + (renderStatus.components(separatedBy: "·").last ?? "") : "") }
            default: break
            }
        }
        flushLogs()
    }

    private func flushLogs() {
        if !logBatch.isEmpty {
            sidecarSend("runtime.logs", ["lines": logBatch])
            logBatch = []
        }
    }

    private func mapConsole(_ level: String, _ text: String) {
        addLine(level: level, source: "map", text: text)
        logBatch.append(["level": level, "text": "map: " + text])
        if loadWatch != nil, level == "error", text.contains("dev") || text.contains("place") { loadWatch!.errors.append(text) }
        flushLogs()
    }

    // ----- from the map -----

    private func mapMessage(_ p: [String: Any]) {
        switch p["t"] as? String ?? "" {
        case "earth.ready":
            ready = true
            // The user's versions and settings; then what a link asked to enter.
            for (topic, id) in choices { send(["t": "earth.choose", "topic": topic, "id": id]) }
            send(["t": "earth.settings", "buildings": buildings, "sse": detail, "quality": "app"])
            if let place = pendingEnter { pendingEnter = nil; DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.enter(place) } }
            if let p = project, let base = mapDevBase { send(["t": "earth.dev", "base": base, "manifest": p.manifest]) }
        case "earth.view":
            var v = camera
            for (k, value) in p { if let n = (value as? NSNumber)?.doubleValue {
                switch k { case "lat": v.lat = n; case "lon": v.lon = n; case "alt": v.alt = n; case "heading": v.heading = n; case "pitch": v.pitch = n; case "fov": v.fov = n; case "ground": v.ground = n; case "utc": v.utc = n; default: break }
            } }
            if !traced, v != camera { camera = v }
        case "earth.places":
            nearby = (p["list"] as? [[String: Any]] ?? []).compactMap { j in
                guard let id = j["id"] as? String else { return nil }
                let a = j["anchor"] as? [String: Any]
                return NearbyPlace(id: id, title: j["title"] as? String ?? id, kind: j["kind"] as? String ?? "site", topic: j["topic"] as? String ?? "",
                                   lat: (a?["lat"] as? NSNumber)?.doubleValue ?? 0, lon: (a?["lon"] as? NSNumber)?.doubleValue ?? 0,
                                   chosen: j["chosen"] as? Bool ?? false, loaded: j["loaded"] as? Bool ?? false)
            }
            if let n = near, !nearby.contains(where: { $0.id == n.id }) { near = nil }
            if let w = loadWatch, !w.traced, let dev = nearby.first(where: { $0.id.hasPrefix("dev/") && ($0.id == "dev/" + w.id || $0.id.hasSuffix("/" + w.id)) }), dev.loaded {
                loadWatch = nil
                placeLoaded = true
                sidecarSend("runtime.place", ["seq": w.seq, "loaded": true, "errors": w.errors, "view": "map"])
            }
        case "earth.selected":
            let id = p["id"] as? String
            selectedID = id
            versions = (p["versions"] as? [[String: Any]] ?? []).compactMap { j in
                guard let vid = j["id"] as? String else { return nil }
                let era = (j["era"] as? [String: Any])?["label"] as? String ?? j["era"] as? String
                return Version(id: vid, title: j["title"] as? String ?? vid, author: j["author"] as? String ?? "", likes: j["likes"] as? Int ?? 0,
                               stars: j["stars"] as? Int ?? 0, era: era, chosen: j["chosen"] as? Bool ?? false)
            }
            if let id { Task { await loadRecord(id) }; sidebarSelection = id } else { record = nil }
        case "earth.pick":
            let lat = (p["lat"] as? NSNumber)?.doubleValue ?? 0, lon = (p["lon"] as? NSNumber)?.doubleValue ?? 0
            pick = Pick(lat: lat, lon: lon, h: (p["h"] as? NSNumber)?.doubleValue ?? 0, place: p["place"] as? String, building: p["building"] as? String)
            if let place = p["place"] as? String { select(place) }
        case "earth.near":
            if let id = p["id"] as? String, flight.state != "flying" { near = (id, (p["distance"] as? NSNumber)?.doubleValue ?? 0) } else { near = nil }
        case "earth.flight":
            var f = Flight()
            f.state = p["state"] as? String ?? "idle"
            f.seconds = ((p["seconds"] ?? p["t_"] ?? p["time"]) as? NSNumber)?.doubleValue ?? (p["elapsed"] as? NSNumber)?.doubleValue ?? 0
            f.duration = (p["duration"] as? NSNumber)?.doubleValue ?? 0
            let title = { (x: Any?) -> String in (x as? [String: Any])?["title"] as? String ?? (x as? String) ?? "" }
            f.from = title(p["from"]).isEmpty ? flightNames.0 : title(p["from"])
            f.to = title(p["to"]).isEmpty ? flightNames.1 : title(p["to"])
            f.paused = p["paused"] as? Bool ?? false
            f.speedup = (p["speedup"] as? NSNumber)?.doubleValue ?? 1
            flight = f
        case "earth.status":
            let t = p["tiles"] as? [String: Any] ?? [:]
            tiles = (t["shown"] as? Int ?? 0, t["inFlight"] as? Int ?? 0, t["queued"] as? Int ?? 0, t["resident"] as? Int ?? 0)
            tileBytes = (p["bytes"] as? NSNumber)?.int64Value ?? 0
            mapGPU = (p["gpuMB"] as? NSNumber)?.doubleValue ?? mapGPU
            mapFrameMs = (p["frameMs"] as? NSNumber)?.doubleValue ?? mapFrameMs
            gen = p["gen"] as? String ?? gen
        case "earth.prefetched":
            guard let id = p["id"] as? String else { break }
            var d = downloads.first(where: { $0.id == id }) ?? Download(id: id, title: id)
            d.done = p["done"] as? Int ?? d.done
            d.total = p["total"] as? Int ?? d.total
            d.bytes = (p["bytes"] as? NSNumber)?.int64Value ?? d.bytes
            d.failed = p["failed"] as? Int ?? d.failed
            d.state = p["state"] as? String ?? d.state
            if let i = downloads.firstIndex(where: { $0.id == id }) { downloads[i] = d } else { downloads.insert(d, at: 0) }
            if d.state == "done" { notice = "\(d.title) is downloaded: \(d.total) tiles, \(ByteCountFormatter.string(fromByteCount: d.bytes, countStyle: .file))" }
        default: break
        }
    }

    static func describe(rendering r: [String: Any]) -> String {
        let recon = r["reconstruction"] as? [String: Any]
        let active = recon?["active"] as? String ?? ""
        let names = ["metalfx-denoised": "MetalFX denoised", "metalfx": "MetalFX", "builtin": "ThreeRT denoiser", "off": "no denoiser"]
        let scale = (r["scale"] as? NSNumber)?.doubleValue ?? 1
        return "\(names[active] ?? active) · \(Int((scale * 100).rounded())) %"
    }

    func addLine(level: String, source: String, text: String) {
        lineSerial += 1
        console.append(ConsoleLine(id: lineSerial, level: level, source: source, text: text))
        if console.count > 1500 { console.removeFirst(console.count - 1500) }
        if level == "error" { unseenErrors += 1 }
    }

    // ----- snapshots: `earthrt shot` (the globe at the place) and app.shot (the whole window) -----

    /// `earthrt shot`: the open place (`place`), path-traced (default) or on the map (`view: "map"`), from its start or
    /// a camera in its frame; or what is shown now.
    private func snapshotRequest(_ m: [String: Any]) {
        guard let id = m["id"] as? Int, let path = m["path"] as? String else { return }
        let wait = m["wait"] as? Double ?? 2
        let onMap = (m["view"] as? String) == "map"
        let shoot = { [weak self] in
            guard let self else { return }
            if self.traced && !onMap {
                self.snapshots[path] = id
                self.view.snapshot(to: path)
            } else {
                self.map.snapshot(to: path) { w, h in self.sidecarSend("answer", ["id": id, "path": path, "width": w, "height": h]) }
            }
        }
        guard m["place"] as? Bool == true, let p = project else {
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { shoot() }
            return
        }
        if traced && onMap { exitTraced() }
        send(["t": "earth.gotoPlace", "id": devPlaceID ?? "dev/\(p.id)"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) { [weak self] in
            guard let self else { return }
            // The camera in the place's frame, as a pose (the ground under the anchor from the map's earth.view).
            if let cam = m["camera"] as? [String: Any], let pose = PlaceFrame.pose(camera: cam, manifest: p.manifest, ground: self.camera.ground) {
                self.camera.lat = pose.lat; self.camera.lon = pose.lon; self.camera.alt = pose.alt; self.camera.heading = pose.heading; self.camera.pitch = pose.pitch
                self.goto(lat: pose.lat, lon: pose.lon, alt: pose.alt, heading: pose.heading, pitch: pose.pitch, seconds: 0)
            }
            if onMap {
                self.whenSettled(timeout: 20) { DispatchQueue.main.asyncAfter(deadline: .now() + wait) { shoot() } }
                return
            }
            if self.traced { self.exitTraced() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.enter("dev/\(p.id)")
                self.whenTraced(timeout: 40) { ok in
                    if !ok { self.sidecarSend("answer", ["id": id, "error": "the traced view did not show the place within 40 s"]); return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { shoot() }
                }
            }
        }
    }

    /// Runs `then(true)` once the traced view shows (or `then(false)` after `timeout` s).
    func whenTraced(timeout: Double, _ then: @escaping (Bool) -> Void) {
        let until = Date().addingTimeInterval(timeout)
        func check() {
            if traced { then(true); return }
            if Date() > until || tracedFatal != nil { then(false); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { check() }
        }
        check()
    }

    /// Runs `then` once the globe has no tiles coming (or after `timeout` s).
    func whenSettled(timeout: Double, _ then: @escaping () -> Void) {
        let until = Date().addingTimeInterval(timeout)
        func check() {
            if (tiles.inFlight == 0 && tiles.queued == 0) || Date() > until { then(); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { check() }
        }
        check()
    }

    private func snapshotTaken(_ p: [String: Any]) {
        if let frame = p["path"] as? String, let shot = windowShots.removeValue(forKey: frame) {
            let size = WindowShot.compose(over: view, frame: frame, hide: [view, map.web], to: shot.path)
            sidecarSend("answer", ["id": shot.id, "path": shot.path, "width": size.width, "height": size.height])
        } else if let path = p["path"] as? String, let id = snapshots.removeValue(forKey: path) {
            sidecarSend("answer", ["id": id, "path": path, "width": p["width"] as? Int ?? 0, "height": p["height"] as? Int ?? 0])
        } else if let path = p["path"] as? String {
            addLine(level: "info", source: "app", text: "snapshot: \(path)")
        }
    }

    func snapshotToDesktop() {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        let path = NSHomeDirectory() + "/Desktop/EarthRT \(formatter.string(from: Date())).png"
        if traced { view.snapshot(to: path) } else { map.snapshot(to: path) { _, _ in } }
        notice = "Saved a picture to the Desktop"
    }

    func copyLink() {
        let c = camera
        let link = String(format: "earthrt://open?at=%.5f,%.5f,%.0f,%.0f,%.0f", c.lat, c.lon, c.alt, c.heading, c.pitch)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(link, forType: .string)
        notice = "Copied a link to this view"
    }
}

/// The agent panel's words (the sidecar's PANEL).
struct PanelText {
    var title = "Agent"
    var intro = "Your own Claude Code or Codex, working in this place's folder."
    var placeholder = "Describe what to build here…"
    var suggestions: [String] = []
    init() {}
    init(_ j: [String: Any]) {
        title = j["title"] as? String ?? title
        intro = j["intro"] as? String ?? intro
        placeholder = j["placeholder"] as? String ?? placeholder
        suggestions = j["suggestions"] as? [String] ?? []
    }
}

/// A camera in a place's frame (SPEC § 1: x east, y up, z south at the anchor, turned by `heading`) as a pose.
enum PlaceFrame {
    static func pose(camera: [String: Any], manifest: [String: Any], ground: Double) -> (lat: Double, lon: Double, alt: Double, heading: Double, pitch: Double)? {
        guard let a = manifest["anchor"] as? [String: Any], let lat0 = (a["lat"] as? NSNumber)?.doubleValue, let lon0 = (a["lon"] as? NSNumber)?.doubleValue,
              let p = (camera["position"] as? [NSNumber])?.map(\.doubleValue), p.count == 3 else { return nil }
        let t = (camera["target"] as? [NSNumber])?.map(\.doubleValue) ?? [0, 0, 0]
        let h = ((a["heading"] as? NSNumber)?.doubleValue ?? 0) * .pi / 180
        let base = ((a["heightRef"] as? String) == "ellipsoid" ? 0 : ground) + ((a["height"] as? NSNumber)?.doubleValue ?? 0)
        func en(_ v: [Double]) -> (e: Double, n: Double) {
            (v[0] * cos(h) - v[2] * sin(h), -v[0] * sin(h) - v[2] * cos(h))
        }
        let (e, n) = en(p)
        let r = 6_378_137.0
        let lat = lat0 + n / r * 180 / .pi
        let lon = lon0 + e / (r * cos(lat0 * .pi / 180)) * 180 / .pi
        let d = [t[0] - p[0], t[1] - p[1], t[2] - p[2]]
        let (de, dn) = en(d)
        let heading = (atan2(de, dn) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
        let pitch = atan2(d[1], hypot(de, dn)) * 180 / .pi
        return (lat, lon, base + p[1], heading, pitch)
    }
}

func distance(_ m: Double) -> String {
    m >= 10_000 ? String(format: "%.0f km", m / 1000) : m >= 1000 ? String(format: "%.1f km", m / 1000) : String(format: "%.0f m", m)
}

func altitude(_ m: Double) -> String {
    m >= 100_000 ? String(format: "%.0f km", m / 1000) : m >= 10_000 ? String(format: "%.1f km", m / 1000) : String(format: "%.0f m", m)
}
