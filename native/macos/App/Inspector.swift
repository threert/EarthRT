// The inspector: the selected place (its versions ranked, eras, likes, Go There, Remix), the place being made (its
// build, Meshy, Publish) and the agent working on it.
import AppKit
import SwiftUI

struct Inspector: View {
    @EnvironmentObject var model: Model
    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $model.inspector) {
                ForEach(InspectorTab.allCases) { tab in Text(tab.rawValue).tag(tab) }
            }
            .pickerStyle(.segmented).labelsHidden()
            .padding(.horizontal, 12).padding(.vertical, 10)
            Divider()
            switch model.inspector {
            case .place: PlacePanel()
            case .create: CreatePanel()
            case .agent: AgentPanel()
            }
        }
    }
}

struct PlacePanel: View {
    @EnvironmentObject var model: Model
    var body: some View {
        if let id = model.selectedID {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header(id)
                    actions(id)
                    if !model.versions.isEmpty { versionsSection }
                    if let r = model.record { about(r) }
                }
                .padding(16)
            }
        } else {
            ContentUnavailableView {
                Label("No Place Selected", systemImage: "mappin.slash")
            } description: {
                Text("Click a place on the globe, or pick one in the sidebar. Places are GitHub repositories anyone can make.")
            } actions: {
                Button("Make One Here") { model.createHere() }
            }
        }
    }

    private func header(_ id: String) -> some View {
        let r = model.record
        let current = model.versions.first(where: { $0.id == id })
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: Theme.kindIcon(r?.kind ?? "site")).foregroundStyle(.secondary)
                Text((r?.kind ?? "site").capitalized).font(.caption).foregroundStyle(.secondary)
                if id.hasPrefix("dev/") { Chip(text: "IN DEVELOPMENT", tint: .accentColor) }
                if let era = r?.era ?? current?.era { Chip(text: era, tint: .purple) }
            }
            Text(r?.title ?? current?.title ?? id).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            if let r, !r.summary.isEmpty { Text(r.summary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            if let r { Text("by \(r.author) · \(r.repo)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
        }
    }

    private func actions(_ id: String) -> some View {
        HStack(spacing: 8) {
            Button { model.enter(id) } label: { Label("Enter", systemImage: "sparkles") }.buttonStyle(.borderedProminent).help("See it path-traced")
            Button { model.gotoPlace(id) } label: { Label("Go There", systemImage: "location") }
            if !id.hasPrefix("dev/") {
                Button { model.toggleLike(id) } label: {
                    Image(systemName: model.liked.contains(id) ? "heart.fill" : "heart")
                }
                .help(model.liked.contains(id) ? "Unlike" : "Like this version")
                if let repo = model.record?.repo {
                    Menu {
                        Button("Open Repository on GitHub") { model.openRepository(repo) }
                        Button("Remix This Place") { model.remix(repo) }
                        Button("Copy Link") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString("earthrt://open?place=\(id)", forType: .string)
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .menuStyle(.borderlessButton).fixedSize().help("More")
                }
            }
        }
        .controlSize(.regular)
    }

    private var versionsSection: some View {
        let eras = Set(model.versions.compactMap(\.era))
        return InspectorSection(title: model.versions.count > 1 ? "\(model.versions.count) Versions" : "Version") {
            if eras.count > 1 {
                Picker("Era", selection: Binding(get: { model.versions.first(where: \.chosen)?.era ?? "" }, set: { era in
                    if let v = model.versions.first(where: { $0.era == era }) { model.choose(v) }
                })) { ForEach(eras.sorted(), id: \.self) { Text($0).tag($0) } }
                .pickerStyle(.segmented)
            }
            VStack(spacing: 0) {
                ForEach(Array(model.versions.enumerated()), id: \.element.id) { i, v in
                    VersionRow(rank: i + 1, version: v)
                    if i < model.versions.count - 1 { Divider().padding(.leading, 34) }
                }
            }
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.fill))
            Text("Ranked by likes on EarthRT and the repository's stars. The one you choose is shown for everyone's view on this Mac.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func about(_ r: PlaceRecord) -> some View {
        InspectorSection(title: "About") {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow { Text("Where").foregroundStyle(.secondary); Text(String(format: "%.5f°, %.5f°", r.lat, r.lon)).textSelection(.enabled) }
                GridRow { Text("Topic").foregroundStyle(.secondary); Text(r.topic).textSelection(.enabled) }
                if !r.license.isEmpty { GridRow { Text("Licence").foregroundStyle(.secondary); Text(r.license) } }
                if !r.credits.isEmpty { GridRow(alignment: .top) { Text("Credits").foregroundStyle(.secondary); Text(r.credits.joined(separator: "\n")).fixedSize(horizontal: false, vertical: true) } }
                if !r.updated.isEmpty { GridRow { Text("Updated").foregroundStyle(.secondary); Text(String(r.updated.prefix(10))) } }
            }
            .font(.callout)
        }
    }
}

struct VersionRow: View {
    @EnvironmentObject var model: Model
    let rank: Int
    let version: Version
    var body: some View {
        HStack(spacing: 10) {
            Text("\(rank)").font(.caption.weight(.bold)).monospacedDigit().foregroundStyle(.secondary).frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(version.title).lineLimit(1)
                    if let era = version.era { Chip(text: era, tint: .purple) }
                }
                Text(version.author).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Label("\(version.likes)", systemImage: model.liked.contains(version.id) ? "heart.fill" : "heart").font(.caption).foregroundStyle(.secondary).labelStyle(.titleAndIcon)
            Label("\(version.stars)", systemImage: "star").font(.caption).foregroundStyle(.secondary).labelStyle(.titleAndIcon)
            if version.chosen {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor).help("Shown")
            } else {
                Button("Show") { model.choose(version) }.controlSize(.small)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { model.choose(version) }
    }
}

// ----- making a place -----

struct CreatePanel: View {
    @EnvironmentObject var model: Model
    @State private var meshyPrompt = ""
    @State private var meshyHeight = 2.0
    var body: some View {
        if let p = model.project {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) { Chip(text: "DEV MODE", tint: .accentColor); if let repo = p.repo { Text(repo).font(.caption).foregroundStyle(.secondary) } }
                        Text(p.title).font(.title2.weight(.semibold))
                        Text(p.folder.replacingOccurrences(of: NSHomeDirectory(), with: "~")).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    HStack(spacing: 8) {
                        Button { model.enter("dev/\(p.id)") } label: { Label("Enter", systemImage: "sparkles") }.buttonStyle(.borderedProminent).help("See it path-traced")
                        Button { model.gotoPlace(model.devPlaceID ?? "dev/\(p.id)") } label: { Label("Go There", systemImage: "location") }
                        Button { model.inspector = .agent } label: { Label("Ask the Agent", systemImage: "sparkles") }
                        Menu {
                            Button("Show in Finder") { model.revealProject() }
                            Button("Rebuild") { model.sidecarSend("place.build") }
                            Button("Run the Full Check") { model.fullCheck() }
                            Divider()
                            Button("Close Place") { model.closePlace() }
                        } label: { Label("More", systemImage: "ellipsis.circle") }.menuStyle(.borderlessButton).fixedSize()
                    }
                    buildSection
                    meshySection
                    InspectorSection(title: "Publish") {
                        Text(p.repo == nil ? "Make it a GitHub repository under your account and put it on the map for everyone." : "Push the latest commit to \(p.repo!) and refresh it on the map.")
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        Button { model.showPublish = true } label: { Label("Publish…", systemImage: "paperplane") }
                    }
                }
                .padding(16)
            }
        } else {
            ContentUnavailableView {
                Label("Make a Place", systemImage: "hammer")
            } description: {
                Text("Click a spot on the globe and choose Create Here: EarthRT makes a project from the place template, opens it in dev mode and starts your own Claude Code or Codex in it.")
            } actions: {
                Button("Create Here") { model.createHere() }.buttonStyle(.borderedProminent)
                Button("Open Place Folder…") { model.chooseFolder() }
            }
        }
    }

    private var buildSection: some View {
        InspectorSection(title: "Build", trailing: AnyView(Text(model.buildSeq > 0 ? "#\(model.buildSeq) · \(model.buildMs) ms" : "").font(.caption).foregroundStyle(.secondary))) {
            HStack(spacing: 8) {
                Image(systemName: !model.buildOK ? "xmark.octagon.fill" : model.placeLoaded ? "checkmark.circle.fill" : "clock")
                    .foregroundStyle(!model.buildOK ? .red : model.placeLoaded ? .green : .secondary)
                Text(!model.buildOK ? "The place does not build" : model.placeLoaded ? "On the map and in the traced view, reloaded on every save" : "Loading…")
            }
            ForEach(model.problems.prefix(6)) { p in
                Text("\(p.file)\(p.line > 0 ? ":\(p.line)" : "") \(p.message)").font(.caption.monospaced()).foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            if !model.buildOK { Button("Ask the Agent to Fix It") { model.inspector = .agent; model.askToFix() } }
            if let t = model.task("check") { TaskLog(task: t, title: "Full check") }
        }
    }

    private var meshySection: some View {
        InspectorSection(title: "Model with Meshy") {
            TextField("A weathered stone lantern with moss on its roof", text: $meshyPrompt, axis: .vertical)
                .lineLimit(2...4).textFieldStyle(.roundedBorder)
            HStack {
                Stepper(value: $meshyHeight, in: 0.2...60, step: 0.5) { Text("Height \(meshyHeight, specifier: "%.1f") m") }
                Spacer()
                Button("Make Model") { model.meshy(prompt: meshyPrompt, name: "", height: meshyHeight, mock: !model.meshyKeySet) }
                    .disabled(meshyPrompt.trimmingCharacters(in: .whitespaces).isEmpty || model.task("meshy")?.state == "running")
            }
            if !model.meshyKeySet {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "info.circle").foregroundStyle(.secondary)
                    Text("No Meshy key: models are placeholders from Meshy's stand-in. Add your key in Settings → Accounts.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            if let t = model.task("meshy") { TaskLog(task: t, title: "Meshy") }
        }
    }
}

/// A sidecar job's last lines and its end.
struct TaskLog: View {
    let task: TaskState
    let title: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if task.state == "running" { ProgressView().controlSize(.mini) }
                else { Image(systemName: task.state == "done" ? "checkmark.circle.fill" : "xmark.octagon.fill").foregroundStyle(task.state == "done" ? .green : .red) }
                Text(task.state == "running" ? "\(title)…" : task.state == "done" ? "\(title): done" : "\(title): \(task.error ?? "failed")").font(.caption.weight(.medium)).lineLimit(2)
            }
            if !task.lines.isEmpty {
                Text(task.lines.suffix(6).joined(separator: "\n")).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(6).textSelection(.enabled)
                    .padding(6).frame(maxWidth: .infinity, alignment: .leading).background(RoundedRectangle(cornerRadius: 6).fill(Theme.fill))
            }
        }
    }
}

struct CreateSheet: View {
    @EnvironmentObject var model: Model
    @Environment(\.dismiss) var dismiss
    @State private var title = ""
    @State private var kind = "site"
    @State private var radius = 40.0
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Image(systemName: "plus.square.on.square").font(.largeTitle).foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Create a Place Here").font(.title3.weight(.semibold))
                    if let p = model.pick { Text(String(format: "%.5f°, %.5f°", p.lat, p.lon)).foregroundStyle(.secondary).monospacedDigit() }
                }
            }
            Form {
                TextField("Name", text: $title, prompt: Text("A tea house by the river"))
                Picker("Kind", selection: $kind) {
                    Text("Site: a building, a garden").tag("site")
                    Text("Interior: a room").tag("interior")
                    Text("City: a whole district").tag("city")
                }
                LabeledContent("Reach") {
                    HStack { Slider(value: $radius, in: 10...2000); Text(distance(radius)).monospacedDigit().frame(width: 60, alignment: .trailing) }
                }
            }
            .formStyle(.grouped)
            Text("A project from the place template in ~/EarthRT/places, opened in dev mode: your agent builds it, the globe shows it as it changes. Nothing is published until you choose Publish.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Create") { model.create(title: title.isEmpty ? "A new place" : title, kind: kind, radius: radius) }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
            }
        }
        .padding(20).frame(width: 460)
    }
}

struct PublishSheet: View {
    @EnvironmentObject var model: Model
    @Environment(\.dismiss) var dismiss
    @State private var repo = ""
    @State private var dryRun = true
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Publish \(model.project?.title ?? "the Place")").font(.title3.weight(.semibold))
            if let gh = model.github {
                Label("Signed in to GitHub as \(gh.login)\(gh.via == "gh" ? " (gh)" : "")", systemImage: "person.crop.circle.badge.checkmark").foregroundStyle(.secondary)
            } else {
                Label("Not signed in to GitHub", systemImage: "person.crop.circle.badge.exclamationmark").foregroundStyle(.orange)
                Button("Sign In…") { model.signInGitHub() }
            }
            Form {
                if model.project?.repo == nil {
                    TextField("Repository", text: $repo, prompt: Text("\(model.github?.login ?? "you")/earth-\(model.project?.name ?? "place")"))
                } else {
                    LabeledContent("Repository", value: model.project?.repo ?? "")
                }
                Toggle("Dry run: check and say what would happen, change nothing", isOn: $dryRun)
            }
            .formStyle(.grouped)
            Text(dryRun ? "Runs the place's checks and shows the steps." : "Creates a public repository with the earthrt-place topic, pushes the place, and registers it on EarthRT's map.")
                .font(.callout).foregroundStyle(dryRun ? Color.secondary : Color.orange).fixedSize(horizontal: false, vertical: true)
            if let t = model.task("publish") { TaskLog(task: t, title: "Publish") }
            HStack {
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(dryRun ? "Check" : "Publish") {
                    let name = repo.isEmpty ? "\(model.github?.login ?? "")/earth-\(model.project?.name ?? "place")" : repo
                    model.publish(repo: name, dryRun: dryRun)
                }
                .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                .disabled(model.github == nil || model.task("publish")?.state == "running")
            }
        }
        .padding(20).frame(width: 500)
    }
}
