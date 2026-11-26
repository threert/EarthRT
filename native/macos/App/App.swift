// EarthRT for macOS: the whole Earth path-traced by ThreeRT, places from GitHub, and the place you make with your own
// coding agent. One window (sidebar, the globe, the inspector), Settings, a console; `earthrt://` links.
import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // A cold launch from a link: the link's parameters are the launch's (before the globe starts).
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:reply:)), forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        MainActor.assumeIsolated {
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: "--open"), i + 1 < args.count, let url = URL(string: args[i + 1]) { Model.shared.open(url: url) }
            Model.shared.start()
        }
    }
    @objc func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let text = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let url = URL(string: text) else { return }
        MainActor.assumeIsolated { Model.shared.open(url: url) }
    }
    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { Model.shared.stop() }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct EarthRTApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = Model.shared

    var body: some Scene {
        Window("EarthRT", id: "main") {
            MainView()
                .environmentObject(model)
                .frame(minWidth: 1000, minHeight: 620)
                .tint(Theme.accent)
        }
        .defaultSize(width: 1440, height: 900)
        .commands { EarthCommands(model: model) }

        Settings {
            SettingsView().environmentObject(model).tint(Theme.accent)
        }

        Window("Console", id: "console") {
            ConsoleView().environmentObject(model).frame(minWidth: 520, minHeight: 300)
        }
        .defaultSize(width: 760, height: 420)
        .keyboardShortcut("c", modifiers: [.command, .option])
    }
}

struct EarthCommands: Commands {
    @ObservedObject var model: Model
    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("Create Place Here…") { model.createHere() }.keyboardShortcut("n", modifiers: .command)
            Button("Open Place Folder…") { model.chooseFolder() }.keyboardShortcut("o", modifiers: .command)
            Button("Remix Selected Place") { if let repo = model.record?.repo { model.remix(repo) } }.disabled(model.record == nil)
            Divider()
            Button("Publish…") { model.showPublish = true }.keyboardShortcut("p", modifiers: [.command, .shift]).disabled(model.project == nil)
            Button("Close Place") { model.closePlace() }.disabled(model.project == nil)
        }
        CommandGroup(after: .saveItem) {
            Button("Save Picture to Desktop") { model.snapshotToDesktop() }.keyboardShortcut("s", modifiers: [.command, .shift])
        }
        CommandGroup(after: .pasteboard) {
            Button("Copy Link to This View") { model.copyLink() }.keyboardShortcut("c", modifiers: [.command, .shift])
        }
        CommandGroup(after: .sidebar) {
            Button(model.showInspector ? "Hide Inspector" : "Show Inspector") { model.showInspector.toggle() }.keyboardShortcut("i", modifiers: [.command, .option])
            Button("Place") { model.inspector = .place; model.showInspector = true }.keyboardShortcut("1", modifiers: .command)
            Button("Create") { model.inspector = .create; model.showInspector = true }.keyboardShortcut("2", modifiers: .command)
            Button("Agent") { model.inspector = .agent; model.showInspector = true }.keyboardShortcut("3", modifiers: .command)
            Divider()
            Toggle("Show Buildings", isOn: $model.buildings)
            Picker("Quality", selection: $model.quality) {
                Text("Automatic").tag("auto")
                Text("Native").tag("native")
                Text("Quality").tag("quality")
                Text("Balanced").tag("balanced")
                Text("Performance").tag("performance")
            }
            Picker("Denoiser", selection: $model.reconstruction) {
                Text("Best Available").tag("auto")
                Text("MetalFX").tag("metalfx")
                Text("ThreeRT").tag("builtin")
            }
            Divider()
        }
        CommandMenu("Go") {
            Button("Whole Earth") { model.home() }.keyboardShortcut("0", modifiers: .command)
            Button("Fly…") { model.showFlight = true }.keyboardShortcut("l", modifiers: .command)
            Button("Stop Flight") { model.stopFlight() }.keyboardShortcut(".", modifiers: .command).disabled(model.flight.state != "flying")
            Divider()
            ForEach(City.all.prefix(6)) { city in Button(city.name) { model.goto(city) } }
            Divider()
            Button("Go to Selected Place") { if let id = model.selectedID { model.gotoPlace(id) } }.keyboardShortcut("g", modifiers: .command).disabled(model.selectedID == nil)
            Button("Like Selected Place") { if let id = model.selectedID { model.toggleLike(id) } }.disabled(model.selectedID == nil || model.selectedID!.hasPrefix("dev/"))
        }
        CommandMenu("Time") {
            Button("Now") { model.setTime(hour: nil) }.keyboardShortcut("t", modifiers: [.command, .option])
            Button("An Hour Earlier") { model.shiftTime(hours: -1) }.keyboardShortcut("[", modifiers: .command)
            Button("An Hour Later") { model.shiftTime(hours: 1) }.keyboardShortcut("]", modifiers: .command)
            Divider()
            Button("Dawn") { model.setTime(hour: 6) }
            Button("Noon") { model.setTime(hour: 12) }
            Button("Dusk") { model.setTime(hour: 17.5) }
            Button("Night") { model.setTime(hour: 22) }
        }
        CommandGroup(replacing: .help) {
            Button("EarthRT on GitHub") { NSWorkspace.shared.open(URL(string: "https://github.com/threert/EarthRT")!) }
            Button("Making Places") { NSWorkspace.shared.open(URL(string: "https://github.com/threert/earth-place-template")!) }
        }
    }
}
