// The window: a sidebar (search, places nearby, your places, downloads), the globe, an inspector (the place, making
// one, the agent) and the toolbar (fly, time of day, create, download, the inspector).
import AppKit
import SwiftUI

struct MainView: View {
    @EnvironmentObject var model: Model
    @State private var columns = NavigationSplitViewVisibility.all

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            Sidebar()
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 340)
        } detail: {
            GlobeView()
                .inspector(isPresented: $model.showInspector) {
                    Inspector()
                        .inspectorColumnWidth(min: 300, ideal: 340, max: 460)
                }
                .toolbar { GlobeToolbar() }
        }
        .searchable(text: $model.search, placement: .sidebar, prompt: "Places, cities, coordinates")
        .onSubmit(of: .search) { model.submitSearch() }
        .onChange(of: model.search) { _, _ in model.runSearch() }
        .navigationTitle(model.project.map { "\($0.title) — EarthRT" } ?? "EarthRT")
        .navigationSubtitle(subtitle)
        .sheet(isPresented: $model.showCreate) { CreateSheet() }
        .sheet(isPresented: $model.showPublish) { PublishSheet() }
    }

    private var subtitle: String {
        let c = model.camera
        if model.flight.state == "flying" { return "Flying \(model.flight.from) → \(model.flight.to)" }
        return String(format: "%.4f° %@, %.4f° %@ · %@", abs(c.lat), c.lat >= 0 ? "N" : "S", abs(c.lon), c.lon >= 0 ? "E" : "W", altitude(c.alt))
    }
}

// ----- the sidebar -----

struct Sidebar: View {
    @EnvironmentObject var model: Model
    var body: some View {
        List(selection: Binding(get: { model.sidebarSelection }, set: { model.sidebarPick($0) })) {
            if !model.search.trimmingCharacters(in: .whitespaces).isEmpty {
                SearchResults()
            } else {
                Section("Cities") {
                    ForEach(City.all.prefix(8)) { city in
                        Label { VStack(alignment: .leading, spacing: 1) { Text(city.name); Text(city.country).font(.caption).foregroundStyle(.secondary) } }
                            icon: { Image(systemName: "building.2.crop.circle") }
                            .tag("city:" + city.id)
                    }
                }
                Section("Nearby") {
                    if model.nearby.isEmpty {
                        Text(model.camera.alt > 200_000 ? "Come closer to see places" : "No places here yet").font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(model.nearby) { p in
                        Label {
                            HStack {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(p.title).lineLimit(1)
                                    Text(p.id.hasPrefix("dev/") ? "In development" : p.topic).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer()
                                if p.loaded { Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(.green).help("Shown") }
                            }
                        } icon: { Image(systemName: Theme.kindIcon(p.kind)) }
                        .tag(p.id)
                    }
                }
                Section("My Places") {
                    if model.projects.isEmpty {
                        Text("Click the globe, then Create Here").font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(model.projects, id: \.folder) { p in
                        Label {
                            HStack {
                                Text(p.title).lineLimit(1)
                                Spacer()
                                if model.project?.folder == p.folder { Chip(text: "DEV", tint: .accentColor) }
                            }
                        } icon: { Image(systemName: "hammer") }
                        .tag("folder:" + p.folder)
                        .contextMenu {
                            Button("Open in Dev Mode") { model.openFolder(p.folder) }
                            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p.folder)]) }
                        }
                    }
                }
                if !model.downloads.isEmpty {
                    Section("Downloads") {
                        ForEach(model.downloads) { d in DownloadRow(download: d) }
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }
}

struct SearchResults: View {
    @EnvironmentObject var model: Model
    var body: some View {
        let cities = City.find(model.search)
        if let c = parseCoordinates(model.search) {
            Section("Coordinates") {
                Label(String(format: "Go to %.5f, %.5f", c.lat, c.lon), systemImage: "location").tag(String(format: "at:%.6f,%.6f", c.lat, c.lon))
            }
        }
        if !cities.isEmpty {
            Section("Cities") {
                ForEach(cities) { city in
                    Label("\(city.name), \(city.country)", systemImage: "building.2.crop.circle").tag("city:" + city.id)
                }
            }
        }
        Section {
            if model.searching && model.results.isEmpty { HStack { ProgressView().controlSize(.small); Text("Searching…").foregroundStyle(.secondary) } }
            else if model.results.isEmpty { Text("No places match").foregroundStyle(.secondary) }
            ForEach(model.results) { r in
                Label {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(r.title).lineLimit(1)
                        Text("\(r.author) · \(r.topic)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                } icon: { Image(systemName: Theme.kindIcon(r.kind)) }
                .tag(r.id)
            }
        } header: { Text("Places") }
    }
}

struct DownloadRow: View {
    @EnvironmentObject var model: Model
    let download: Download
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: download.state == "done" ? "checkmark.circle.fill" : download.state == "running" ? "arrow.down.circle" : "exclamationmark.circle")
                    .foregroundStyle(download.state == "done" ? .green : download.state == "running" ? Color.accentColor : .orange)
                Text(download.title).lineLimit(1).font(.callout)
                Spacer()
                if download.state == "running" {
                    Button { model.cancelDownload(download.id) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.buttonStyle(.plain).help("Stop")
                }
            }
            if download.state == "running" { ProgressView(value: download.progress).controlSize(.small) }
            Text("\(download.done) of \(download.total) tiles · \(ByteCountFormatter.string(fromByteCount: download.bytes, countStyle: .file))\(download.failed > 0 ? " · \(download.failed) failed" : "")")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

// ----- the globe and what is over it -----

struct GlobeView: View {
    @EnvironmentObject var model: Model
    var body: some View {
        ZStack {
            RenderView(view: model.view).ignoresSafeArea()
            if let fatal = model.fatal {
                ContentUnavailableView { Label("The globe could not start", systemImage: "exclamationmark.triangle") } description: { Text(fatal).textSelection(.enabled) }
                    .background(.background)
            } else if !model.ready {
                VStack(spacing: 10) { ProgressView(); Text("Starting the path tracer…").foregroundStyle(.secondary) }
            }
            VStack(spacing: 10) {
                if model.flight.state == "flying" { FlightCard().padding(.top, 10) }
                Spacer()
                if let pick = model.pick, model.ready { PickCard(pick: pick) }
                StatusBar()
            }
            .padding(.horizontal, 12).padding(.bottom, 10)
            if let notice = model.notice {
                VStack {
                    Text(notice).font(.callout).padding(.horizontal, 14).padding(.vertical, 8).card(10).padding(.top, model.flight.state == "flying" ? 76 : 12)
                    Spacer()
                }
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: notice) { try? await Task.sleep(nanoseconds: 4_000_000_000); withAnimation { model.notice = nil } }
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.notice)
        .animation(.easeOut(duration: 0.2), value: model.flight.state)
    }
}

struct StatusBar: View {
    @EnvironmentObject var model: Model
    var body: some View {
        HStack(spacing: 14) {
            let c = model.camera
            Label(String(format: "%.4f°, %.4f°", c.lat, c.lon), systemImage: "location.north.line").help("Latitude, longitude")
            Label(altitude(c.alt), systemImage: "arrow.up.and.down").help("Height above sea level")
            Label(String(format: "%02d:%02d", Int(model.localSolarHour), Int(model.localSolarHour.truncatingRemainder(dividingBy: 1) * 60)), systemImage: model.localSolarHour > 6.5 && model.localSolarHour < 18.5 ? "sun.max" : "moon.stars")
                .help("Local solar time")
            Spacer()
            let t = model.tiles
            if t.inFlight + t.queued > 0 {
                HStack(spacing: 5) { ProgressView().controlSize(.mini); Text("Loading \(t.inFlight + t.queued) tiles") }
            } else {
                Label("\(t.shown) tiles", systemImage: "square.grid.3x3").help("Tiles shown · \(t.resident) in memory")
            }
            if let fps = model.stats["fps"] as? NSNumber {
                Text("\(Int(fps.doubleValue.rounded())) fps").monospacedDigit().help("\(model.adapter)\(model.hwrt ? ", hardware ray tracing" : "")")
            }
            if !model.renderStatus.isEmpty { Text(model.renderStatus).help("Reconstruction · render scale (View → Graphics)") }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .labelStyle(.titleAndIcon)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .card(9)
    }
}

struct FlightCard: View {
    @EnvironmentObject var model: Model
    var body: some View {
        let f = model.flight
        HStack(spacing: 12) {
            Image(systemName: "airplane").font(.title3).foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("\(f.from) → \(f.to)").font(.headline)
                    Spacer()
                    Text("\(clock(f.seconds)) / \(clock(f.duration))").font(.caption).monospacedDigit().foregroundStyle(.secondary)
                }
                ProgressView(value: f.progress)
            }
            .frame(width: 320)
            Button { model.downloadFlight() } label: { Image(systemName: "arrow.down.circle") }.buttonStyle(.borderless).help("Download this flight for offline use")
            Button("Stop") { model.stopFlight() }.keyboardShortcut(".", modifiers: .command)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .card()
    }
    private func clock(_ s: Double) -> String { String(format: "%d:%02d", Int(s) / 60, Int(s) % 60) }
}

struct PickCard: View {
    @EnvironmentObject var model: Model
    let pick: Pick
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "mappin.circle.fill").font(.title2).foregroundStyle(.red)
            VStack(alignment: .leading, spacing: 2) {
                Text(String(format: "%.5f°, %.5f°", pick.lat, pick.lon)).font(.headline).monospacedDigit().textSelection(.enabled)
                Text(String(format: "%.0f m above sea level%@", pick.h, pick.building != nil ? " · a building" : "")).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 16)
            Button { model.goto(lat: pick.lat, lon: pick.lon, alt: pick.h + 600, heading: model.camera.heading, pitch: -40) } label: { Label("Go Closer", systemImage: "scope") }
            Button { model.downloadArea(lat: pick.lat, lon: pick.lon, radius: 5000) } label: { Label("Download Area", systemImage: "arrow.down.circle") }
            Button { model.createHere() } label: { Label("Create Here", systemImage: "plus.square.on.square") }.buttonStyle(.borderedProminent)
            Button { model.pick = nil } label: { Image(systemName: "xmark") }.buttonStyle(.borderless).help("Close")
        }
        .controlSize(.regular)
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: 760)
        .card()
    }
}

// ----- the toolbar -----

struct GlobeToolbar: ToolbarContent {
    @EnvironmentObject var model: Model
    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            Button { model.home() } label: { Label("Whole Earth", systemImage: "globe.asia.australia") }.help("See the whole Earth (⌘0)")
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button { model.showFlight.toggle() } label: { Label("Fly", systemImage: "airplane.departure") }
                .help("Fly from one place to another")
                .popover(isPresented: $model.showFlight, arrowEdge: .bottom) { FlightPicker() }
            Button { model.showTime.toggle() } label: { Label("Time of Day", systemImage: model.localSolarHour > 6.5 && model.localSolarHour < 18.5 ? "sun.max" : "moon.stars") }
                .help("The sun: time of day")
                .popover(isPresented: $model.showTime, arrowEdge: .bottom) { TimePicker() }
            Menu {
                Button("Download This Area") { model.downloadArea() }
                Button("Download This Flight") { model.downloadFlight() }.disabled(model.flight.state != "flying")
                Divider()
                SettingsLink { Text("Storage Settings…") }
            } label: { Label("Offline", systemImage: "arrow.down.circle") }
                .help("Keep tiles for offline use")
            Button { model.createHere() } label: { Label("Create Here", systemImage: "plus.square.on.square") }
                .help("Make a place at the spot you clicked (⌘N)")
            Button { model.showInspector.toggle() } label: { Label("Inspector", systemImage: "sidebar.trailing") }
                .help("Show the inspector (⌥⌘I)")
        }
    }
}

struct FlightPicker: View {
    @EnvironmentObject var model: Model
    @State private var from = "here"
    @State private var to = "san-francisco"
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Fly").font(.headline)
            Form {
                Picker("From", selection: $from) {
                    Text("Where I am").tag("here")
                    Divider()
                    ForEach(City.all) { Text($0.name).tag($0.id) }
                }
                Picker("To", selection: $to) {
                    ForEach(City.all) { Text($0.name).tag($0.id) }
                    if !model.nearby.isEmpty { Divider(); ForEach(model.nearby.prefix(10)) { Text($0.title).tag($0.id) } }
                }
            }
            .formStyle(.columns)
            HStack {
                if model.flight.state == "flying" { Button("Stop Flight") { model.stopFlight() } }
                Spacer()
                Button("Fly") { model.fly(from: end(from), to: end(to) ?? to) }
                    .keyboardShortcut(.defaultAction).disabled(from == to)
            }
        }
        .padding(16).frame(width: 300)
        .onAppear { if let near = City.all.min(by: { d($0) < d($1) }), d(near) < 1 { from = near.id; if to == near.id { to = "tokyo" } } }
    }
    private func d(_ c: City) -> Double { hypot(c.lat - model.camera.lat, c.lon - model.camera.lon) }
    private func end(_ id: String) -> Any? {
        if id == "here" { return nil }
        if let c = City.all.first(where: { $0.id == id }) { return ["lat": c.lat, "lon": c.lon, "alt": 1500] as [String: Any] }
        return id
    }
}

struct TimePicker: View {
    @EnvironmentObject var model: Model
    @State private var hour = 12.0
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Time of Day").font(.headline)
                Spacer()
                Text(String(format: "%02d:%02d", Int(hour), Int(hour.truncatingRemainder(dividingBy: 1) * 60))).monospacedDigit().foregroundStyle(.secondary)
            }
            Slider(value: $hour, in: 0...23.99) { Text("Hour") } minimumValueLabel: { Image(systemName: "moon.stars") } maximumValueLabel: { Image(systemName: "moon.stars") }
                .labelsHidden()
                .onChange(of: hour) { _, h in model.setTime(hour: h) }
            HStack {
                ForEach([(6.0, "Dawn"), (12.0, "Noon"), (17.5, "Dusk"), (22.0, "Night")], id: \.0) { h, name in
                    Button(name) { hour = h }.controlSize(.small)
                }
            }
            Picker("Speed", selection: Binding(get: { model.timeRate }, set: { model.setTimeRate($0) })) {
                Text("Still").tag(0.0)
                Text("Real time").tag(1.0)
                Text("1 hour a minute").tag(60.0)
                Text("1 hour a second").tag(3600.0)
            }
            Divider()
            HStack {
                Text("The sun over the place you look at").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Now") { model.setTime(hour: nil); hour = model.localSolarHour }
            }
        }
        .padding(16).frame(width: 320)
        .onAppear { hour = model.localSolarHour }
    }
}
