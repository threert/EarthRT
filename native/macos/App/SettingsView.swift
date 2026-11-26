// Settings: Graphics (quality, the denoiser: MetalFX or ThreeRT's), Storage (the offline cache), Accounts (GitHub,
// Meshy), Advanced (another service). What is set once lives here, not in the window.
import AppKit
import SwiftUI

struct SettingsView: View {
    var body: some View {
        TabView {
            GraphicsSettings().tabItem { Label("Graphics", systemImage: "sparkles.tv") }
            StorageSettings().tabItem { Label("Storage", systemImage: "internaldrive") }
            AccountSettings().tabItem { Label("Accounts", systemImage: "person.crop.circle") }
            AdvancedSettings().tabItem { Label("Advanced", systemImage: "gearshape.2") }
        }
        .frame(width: 520)
        .padding(.vertical, 8)
    }
}

struct GraphicsSettings: View {
    @EnvironmentObject var model: Model
    var body: some View {
        Form {
            Section {
                Picker("Quality", selection: $model.quality) {
                    Text("Automatic (keeps the frame rate)").tag("auto")
                    Text("Native: every pixel traced").tag("native")
                    Text("Quality: two thirds").tag("quality")
                    Text("Balanced").tag("balanced")
                    Text("Performance: a half").tag("performance")
                    Text("Ultra performance: a third").tag("ultra-performance")
                }
                Picker("Denoiser", selection: $model.reconstruction) {
                    Text("Best available").tag("auto")
                    Text("MetalFX (denoised upscaling)").tag("metalfx")
                    Text("ThreeRT's denoiser").tag("builtin")
                }
                Picker("Frame rate", selection: $model.fps) {
                    Text("30 fps").tag(30)
                    Text("60 fps").tag(60)
                    Text("120 fps").tag(120)
                }
            } footer: {
                Text(model.renderStatus.isEmpty ? "" : "Now: \(model.renderStatus) on \(model.adapter)\(model.hwrt ? " with hardware ray tracing" : "").")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("The globe") {
                Toggle("Buildings", isOn: $model.buildings)
                LabeledContent("Detail") {
                    Slider(value: $model.detail, in: 1...6, step: 0.5) { Text("Detail") } minimumValueLabel: { Text("More").font(.caption) } maximumValueLabel: { Text("Faster").font(.caption) }
                        .labelsHidden()
                }
            }
        }
        .formStyle(.grouped)
    }
}

struct StorageSettings: View {
    @EnvironmentObject var model: Model
    @State private var size: Int64 = -1
    @State private var confirm = false
    var body: some View {
        Form {
            Section {
                LabeledContent("Tiles and places kept") {
                    Text(size < 0 ? "Counting…" : ByteCountFormatter.string(fromByteCount: size, countStyle: .file)).monospacedDigit()
                }
                LabeledContent("Where") {
                    Button(Paths.cache.replacingOccurrences(of: NSHomeDirectory(), with: "~")) { NSWorkspace.shared.open(URL(fileURLWithPath: Paths.cache)) }.buttonStyle(.link)
                }
                HStack {
                    Spacer()
                    Button("Clear Cache…", role: .destructive) { confirm = true }
                }
            } footer: {
                Text("Every tile the globe shows is kept, so a place once seen opens without the network. Download an area or a flight ahead from the toolbar's Offline menu.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !model.downloads.isEmpty {
                Section("Downloads") { ForEach(model.downloads) { DownloadRow(download: $0) } }
            }
        }
        .formStyle(.grouped)
        .task { await count() }
        .confirmationDialog("Clear the cache?", isPresented: $confirm) {
            Button("Clear", role: .destructive) {
                let fm = FileManager.default
                for name in (try? fm.contentsOfDirectory(atPath: Paths.cache)) ?? [] { try? fm.removeItem(atPath: Paths.cache + "/" + name) }
                Task { await count() }
            }
        } message: { Text("Tiles and places are downloaded again when the globe needs them; downloads for offline use go too.") }
    }
    private func count() async {
        size = -1
        size = await Task.detached { Paths.size(of: Paths.cache) }.value
    }
}

struct AccountSettings: View {
    @EnvironmentObject var model: Model
    @State private var meshyKey = ""
    @AppStorage("githubClientId") private var clientId = ""
    var body: some View {
        Form {
            Section {
                if let gh = model.github {
                    LabeledContent("Signed in as") { Text(gh.login) }
                    LabeledContent("Through") { Text(gh.via == "gh" ? "the gh command line" : "EarthRT") }
                    if gh.via == "app" { Button("Sign Out") { model.signOutGitHub() } }
                } else {
                    LabeledContent("GitHub") { Text("Not signed in").foregroundStyle(.secondary) }
                    if let code = model.deviceCode {
                        LabeledContent("Your code") {
                            HStack {
                                Text(code.code).font(.title3.monospaced().weight(.semibold)).textSelection(.enabled)
                                Button("Open GitHub") {
                                    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code.code, forType: .string)
                                    NSWorkspace.shared.open(URL(string: code.uri)!)
                                }
                            }
                        }
                    }
                    HStack {
                        Spacer()
                        Button("Check Again") { model.refreshGitHub() }
                        Button("Sign In with GitHub…") { model.signInGitHub() }.buttonStyle(.borderedProminent)
                    }
                }
            } header: { Text("GitHub") } footer: {
                Text("For Publish (a repository under your account) and likes. With the gh command line logged in (`gh auth login`), EarthRT uses it.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section {
                if model.meshyKeySet {
                    LabeledContent("API key") { Text("Saved in your Keychain").foregroundStyle(.secondary) }
                    Button("Remove Key", role: .destructive) { model.setMeshyKey(nil) }
                } else {
                    SecureField("API key", text: $meshyKey, prompt: Text("msy_…"))
                    HStack {
                        Button("Get a Key") { NSWorkspace.shared.open(URL(string: "https://www.meshy.ai/settings/api")!) }.buttonStyle(.link)
                        Spacer()
                        Button("Save") { model.setMeshyKey(meshyKey); meshyKey = "" }.disabled(meshyKey.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            } header: { Text("Meshy") } footer: {
                Text("Text or a picture to a 3D model for your places. Each model costs credits of your Meshy account. Without a key, models are placeholders.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section {
                TextField("OAuth App client ID", text: $clientId, prompt: Text("Iv1.…"))
                    .onSubmit { model.sidecarSend("settings", ["githubClientId": clientId]) }
            } header: { Text("GitHub sign-in (development)") } footer: {
                Text("The client ID of EarthRT's GitHub OAuth App, with device flow enabled. Release builds carry it.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

struct AdvancedSettings: View {
    @AppStorage("api") private var api = ""
    var body: some View {
        Form {
            Section {
                TextField("Service", text: $api, prompt: Text("https://earth.threert.dev"))
            } footer: {
                Text("Another EarthRT service (a local `wrangler dev`, for one). Takes effect at the next launch.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Folders") {
                LabeledContent("Places you make") { Button(Paths.places.replacingOccurrences(of: NSHomeDirectory(), with: "~")) { NSWorkspace.shared.open(URL(fileURLWithPath: Paths.places)) }.buttonStyle(.link) }
            }
        }
        .formStyle(.grouped)
    }
}

struct ConsoleView: View {
    @EnvironmentObject var model: Model
    @State private var errorsOnly = false
    var body: some View {
        let lines = model.console.filter { !errorsOnly || $0.level == "error" || $0.level == "warn" }
        ScrollViewReader { proxy in
            List(lines) { line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(line.source).font(.caption.monospaced()).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
                    Text(line.text).font(.callout.monospaced()).foregroundStyle(line.level == "error" ? .red : line.level == "warn" ? .orange : .primary).textSelection(.enabled)
                }
                .id(line.id)
            }
            .onChange(of: model.console.count) { _, _ in if let last = lines.last { proxy.scrollTo(last.id, anchor: .bottom) } }
        }
        .toolbar {
            Toggle(isOn: $errorsOnly) { Label("Errors Only", systemImage: "exclamationmark.triangle") }
            Button { model.console = []; model.unseenErrors = 0 } label: { Label("Clear", systemImage: "trash") }
        }
        .onAppear { model.unseenErrors = 0 }
    }
}
