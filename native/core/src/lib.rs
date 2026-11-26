//! The EarthRT app's traced view: ThreeRT's live path tracer running the traced view's scene script (`traced/`: one
//! place and its surroundings, ARCHITECTURE § 1), drawn on a CAMetalLayer the app shows over the map when a place is
//! entered. The map itself is the web's map engine in a WKWebView (native/macos); this core draws only places. The SwiftUI app calls in through the C ABI at the end
//! of this file (`native/macos/App/Core.h`). Derived from threert/native-app-template's `core/` (MIT, Meshy LLC).
//!
//! Everything runs on one thread of its own: the GPU device, the script runtime and the present. Calls from the app
//! are commands in a channel; what the script posts and what the renderer reports wait in a queue the app polls.
//!
//! The host channel (docs/SPEC.md § 6) is answered here, natively, for the families the app lists in `launch.caps`:
//! - `assets.*`: downloads into the asset root's `cache/` (the engine's `AssetFetcher`), which the app links to its
//!   disk cache;
//! - `net.*`: `net.fetch` for the registry's JSON (src/net.rs);
//! - `audio.*`: the engine's mixer;
//! - everything else (the `traced.*` family, `log`s, the script's own) goes to the app.
//!
//! While the map is shown the app pauses the view (`ert_pause`): no frames, no GPU work; the script's clock stops.
//!
//! Messages the core sends the script: `launch {params: {width, height, …the app's}, caps: ["assets", "traced"]}`
//! once after setup (and after a reload), `view {width, height}` when the size changes, and `input` every frame.
//!
//! Messages the core itself posts (besides the script's):
//!   {"t":"rt.ready","bundle","adapter","hwrt","width","height"}   the view is up
//!   {"t":"rt.fatal","message"}                                     it could not start
//!   {"t":"rt.error","where","message","bundle"?}                   a frame, a message or a reload failed
//!   {"t":"rt.reloaded","bundle"}                                   a new build of the script runs
//!   {"t":"rt.stats","fps","gpuMs","scale","spp","bounces","scriptMs","shown","width","height","rendering","assets"}
//!                                                                  once a second (`rendering`: the engine's status
//!                                                                  of quality and reconstruction; `assets`: downloads
//!                                                                  under way, waiting, done, bytes)
//!   {"t":"rt.snapshot","path","width","height"}                    a snapshot was written
//!   {"t":"log","level","text"}                                     a console line of the script

pub mod net;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use threert_render::host::{launch_message_with_caps, HostServices, InputTracker};
use threert_render::live::{next_spp, save_bgra, LiveCore, RenderingRequest};
use threert_render::assets::AssetFetcher;
use threert_render::script::{set_asset_root, set_log_sink, GameSession};
use threert_render::{audio::Audio, gpu};

/// The room id the script gets (`setup(roomId)`): empty, the launch message carries the parameters.
const ROOM: &str = "";

/// The families of the host channel the app answers (SPEC § 6.2), for `launch.caps`.
pub const CAPS: &[&str] = &["assets", "traced"];

enum Cmd {
    Resize(u32, u32, f32),
    Pointer(f32, f32),
    Button(u8, bool),
    Wheel(f32),
    Key(String, String, bool),
    Send(Vec<Value>),
    Snapshot(PathBuf),
    Reload(PathBuf),
    Rendering(Value),
    Pause(bool),
    Quit,
}

#[derive(Default)]
struct Shared {
    posts: Mutex<Vec<String>>,
    quit: AtomicBool,
}

impl Shared {
    fn post(&self, v: Value) {
        let mut q = self.posts.lock().unwrap();
        if q.len() > 4096 {
            q.drain(..2048);
        }
        q.push(v.to_string());
    }
}

static LOGS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn log_sink(level: &str, text: &str) {
    let mut logs = LOGS.lock().unwrap();
    if logs.len() < 2048 {
        logs.push((level.to_string(), text.to_string()));
    }
}

/// Where a post of the script goes.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// The core's own services (`assets.*`, `net.*`).
    Services,
    /// The engine's mixer (`audio.*`).
    Audio,
    /// The app: `traced.*`, the HUD (which the app does not draw), the script's own.
    App,
}

pub fn route(m: &Value) -> Route {
    let t = m["t"].as_str().unwrap_or("");
    if t.starts_with("assets.") || t.starts_with("net.") {
        Route::Services
    } else if t.starts_with("audio.") {
        Route::Audio
    } else {
        Route::App
    }
}

/// The host side of one run of the script: the services (fresh for each reload: dropping the old ones stops their
/// downloads) and the launch parameters.
pub struct Host {
    pub assets: AssetFetcher,
    pub net: net::NetFetch,
    pub params: Value,
}

impl Host {
    pub fn new(root: PathBuf, params: Value, agent: ureq::Agent) -> Host {
        Host { assets: AssetFetcher::new(root).with_agent(agent.clone()), net: net::NetFetch::new(agent).with_direct(net::default_agent()), params }
    }

    /// The `launch` message for a view of `width` x `height`: the app's parameters (SPEC § 7) and the view's size.
    pub fn launch(&self, width: u32, height: u32) -> Value {
        let mut p = self.params.as_object().cloned().unwrap_or_default();
        p.insert("width".into(), json!(width));
        p.insert("height".into(), json!(height));
        launch_message_with_caps(Some(&Value::Object(p)), CAPS)
    }

    /// The script's posts: the services' are handed to them, the rest returned (in order) for the app or the mixer.
    pub fn take(&mut self, posts: Vec<Value>) -> Vec<Value> {
        let mut rest = vec![];
        for p in posts {
            if route(&p) == Route::Services {
                self.assets.post(&p);
                self.net.post(&p);
            } else {
                rest.push(p);
            }
        }
        rest
    }

    /// The services' answers since the last call.
    pub fn answers(&mut self) -> Vec<Value> {
        let mut a = self.assets.poll();
        a.extend(self.net.poll());
        a
    }

    pub fn stats(&self) -> Value {
        let (running, waiting) = self.assets.pending();
        let c = self.assets.counts();
        json!({ "running": running, "waiting": waiting, "requests": c.requests, "downloaded": c.downloaded, "cached": c.cached, "failed": c.failed, "bytes": c.bytes })
    }
}

pub struct ErtView {
    tx: mpsc::Sender<Cmd>,
    shared: Arc<Shared>,
    thread: Option<std::thread::JoinHandle<()>>,
}

struct Args {
    layer: usize,
    width: u32,
    height: u32,
    scale: f32,
    bundle: PathBuf,
    root: PathBuf,
    presets: PathBuf,
    options: Value,
}

struct State {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    core: LiveCore,
    game: GameSession,
    host: Host,
    input: InputTracker,
    audio: Audio,
    blit: wgpu::RenderPipeline,
    blit_layout: wgpu::BindGroupLayout,
    blit_size: wgpu::Buffer,
    blit_bg: wgpu::BindGroup,
    want: (u32, u32),
    shown: bool,
    spp: u32,
    fps: u32,
    max_bounces: u32,
    last: Instant,
    frames: u32,
    stats_t: Instant,
    snapshot: Option<PathBuf>,
    root: PathBuf,
    agent: ureq::Agent,
    paused: bool,
}

fn init(a: &Args) -> Result<State> {
    let g = gpu::Gpu::new()?;
    let surface = unsafe { g.instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(a.layer as *mut c_void)) }.context("surface on the layer")?;
    let caps = surface.get_capabilities(&g.adapter);
    let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width: a.width.max(1),
        height: a.height.max(1),
        present_mode: wgpu::PresentMode::Fifo,
        desired_maximum_frame_latency: 2,
        alpha_mode: caps.alpha_modes[0],
        view_formats: vec![],
        color_space: Default::default(),
    };
    surface.configure(&g.device, &config);
    let agent = net::agent(a.options["proxy"].as_str(), Duration::from_secs(300));
    let host = Host::new(a.root.clone(), a.options["params"].clone(), agent.clone());
    // (readAsset and preloadModel read under it: the cache the downloads go to, the places in dev mode.)
    set_asset_root(&a.root);
    let (game, mut core) = GameSession::start(&a.bundle, ROOM, &a.root, g, &a.presets, config.width, config.height)?;
    core.bounces = 4;
    core.set_scale(0.0);
    core.set_display_scale(a.scale);
    if let Some(r) = a.options.get("rendering") {
        match RenderingRequest::from_json(r) {
            Ok(r) => core.set_rendering(r),
            Err(e) => eprintln!("earthrt-core: rendering: {e:#}"),
        }
    }
    let d = &core.g.device;
    let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("blit"), source: wgpu::ShaderSource::Wgsl(BLIT.into()) });
    let buffer = |binding, ty| wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None }, count: None };
    let layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[buffer(0, wgpu::BufferBindingType::Storage { read_only: true }), buffer(1, wgpu::BufferBindingType::Uniform)] });
    let pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
    let blit = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("blit"),
        layout: Some(&pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(format.into())], compilation_options: Default::default() }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    let blit_size = d.create_buffer(&wgpu::BufferDescriptor { label: Some("blit size"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    core.g.queue.write_buffer(&blit_size, 0, bytemuck::cast_slice(&[core.w as f32, core.h as f32, config.width as f32, config.height as f32]));
    let blit_bg = blit_bind_group(d, &layout, &core.targets.out, &blit_size);
    let mut audio = Audio::new();
    audio.open(&a.root);
    let mut s = State {
        want: (config.width, config.height),
        surface,
        config,
        core,
        game,
        host,
        input: InputTracker::new(),
        audio,
        blit,
        blit_layout: layout,
        blit_size,
        blit_bg,
        shown: false,
        spp: 1,
        fps: a.options["fps"].as_u64().map_or(60, |f| f as u32).clamp(15, 120),
        max_bounces: 4,
        last: Instant::now(),
        frames: 0,
        stats_t: Instant::now(),
        snapshot: None,
        root: a.root.clone(),
        agent,
        paused: false,
    };
    let launch = s.host.launch(s.config.width, s.config.height);
    if let Err(e) = s.game.host_messages(&mut s.core, &[launch]) {
        eprintln!("earthrt-core: launch: {e:#}");
    }
    Ok(s)
}

fn blit_bind_group(d: &wgpu::Device, layout: &wgpu::BindGroupLayout, out: &wgpu::Buffer, size: &wgpu::Buffer) -> wgpu::BindGroup {
    d.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("blit"), layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: out.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: size.as_entire_binding() }] })
}

fn fit(s: &mut State) -> bool {
    let (w, h) = s.want;
    if w == 0 || h == 0 || (w, h) == (s.config.width, s.config.height) {
        return false;
    }
    (s.config.width, s.config.height) = (w, h);
    s.surface.configure(&s.core.g.device, &s.config);
    if let Err(e) = s.core.resize(w, h) {
        eprintln!("earthrt-core: {e:#}");
    }
    s.core.g.queue.write_buffer(&s.blit_size, 0, bytemuck::cast_slice(&[s.core.w as f32, s.core.h as f32, w as f32, h as f32]));
    s.blit_bg = blit_bind_group(&s.core.g.device, &s.blit_layout, &s.core.targets.out, &s.blit_size);
    true
}

fn acquire(s: &mut State) -> Result<Option<wgpu::SurfaceTexture>> {
    use wgpu::CurrentSurfaceTexture as T;
    let tex = match s.surface.get_current_texture() {
        T::Success(t) | T::Suboptimal(t) => Some(t),
        T::Timeout | T::Occluded => None,
        T::Outdated | T::Lost => {
            s.surface.configure(&s.core.g.device, &s.config);
            None
        }
        T::Validation => return Err(anyhow!("surface: a validation error")),
    };
    s.shown = tex.is_some();
    Ok(tex)
}

fn pass(e: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, blit: &wgpu::RenderPipeline, bg: &wgpu::BindGroup) {
    let mut rp = e.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("blit"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    rp.set_pipeline(blit);
    rp.set_bind_group(0, bg, &[]);
    rp.draw(0..3, 0..1);
}

fn reshow(s: &mut State) -> Result<()> {
    let Some(tex) = acquire(s)? else {
        std::thread::sleep(Duration::from_millis(4));
        return Ok(());
    };
    let view = tex.texture.create_view(&Default::default());
    let mut e = s.core.g.device.create_command_encoder(&Default::default());
    pass(&mut e, &view, &s.blit, &s.blit_bg);
    s.core.g.queue.submit([e.finish()]);
    s.core.g.queue.present(tex);
    Ok(())
}

/// Hands the script what the services answered and the app sent, and routes what it posted.
fn exchange(s: &mut State, shared: &Shared, messages: &[Value], what: &str) {
    if !messages.is_empty() {
        if let Err(e) = s.game.host_messages(&mut s.core, messages) {
            shared.post(json!({ "t": "rt.error", "where": what, "message": format!("{e:#}") }));
        }
    }
    let posts = s.game.take_posts();
    for p in s.host.take(posts) {
        if s.audio.post(&p) {
            continue;
        }
        // (The engine's HUD is not drawn: the app's interface is SwiftUI, from the `traced.*` family.)
        if p["t"] == "hud" {
            continue;
        }
        shared.post(p);
    }
}

fn frame(s: &mut State, shared: &Shared) -> Result<()> {
    let resized = fit(s);
    if resized {
        let view = json!({ "t": "view", "width": s.config.width, "height": s.config.height });
        exchange(s, shared, &[view], "message");
    }
    let period = Duration::from_secs_f64(1.0 / s.fps as f64);
    if !resized && s.last.elapsed() + Duration::from_millis(2) < period {
        return reshow(s);
    }
    let dt = s.last.elapsed().as_secs_f32().min(0.1);
    s.last = Instant::now();
    s.core.advance_time(dt);
    let mut messages = s.host.answers();
    messages.push(s.input.message());
    exchange(s, shared, &messages, "input");
    if let Err(e) = s.game.frame(&mut s.core, dt) {
        shared.post(json!({ "t": "rt.error", "where": "frame", "message": format!("{e:#}") }));
    }
    exchange(s, shared, &[], "frame");
    let c = s.core.cam;
    s.audio.listener(c.pos, c.fwd, c.right);
    for (level, text) in s.audio.take_log() {
        eprintln!("earthrt-core: audio: {level}: {text}");
    }

    let tex = acquire(s)?;
    if tex.is_none() {
        std::thread::sleep(Duration::from_millis(16));
    }
    let view = tex.as_ref().map(|t| t.texture.create_view(&Default::default()));
    let (blit, bg) = (&s.blit, &s.blit_bg);
    let snap = s.snapshot.take().map(|p| {
        let buf = s.core.g.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (s.core.w * s.core.h * 4) as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        (p, buf)
    });
    s.core.render(s.spp, |e, out| {
        if let Some(view) = &view {
            pass(e, view, blit, bg);
        }
        if let Some((_, buf)) = &snap {
            e.copy_buffer_to_buffer(out, 0, buf, 0, buf.size());
        }
    });
    if let Some(tex) = tex {
        s.core.g.queue.present(tex);
    }
    if let Some((path, buf)) = snap {
        buf.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        s.core.g.device.poll(wgpu::PollType::wait_indefinitely())?;
        let px = buf.slice(..).get_mapped_range()?.to_vec();
        save_bgra(&path, &px, s.core.w, s.core.h);
        shared.post(json!({ "t": "rt.snapshot", "path": path, "width": s.core.w, "height": s.core.h }));
    }
    s.core.govern_resolution(s.fps);
    s.spp = if s.core.render_scale < 1.0 { 1 } else { next_spp(s.spp, s.core.gpu_ms, s.fps).min(8) };
    if s.core.frame % 30 == 1 {
        let budget = 1000.0 / s.fps as f32;
        let lowest = !s.core.dynamic_res || s.core.render_scale <= s.core.min_scale;
        if s.spp == 1 && lowest && s.core.gpu_ms > budget * 0.92 && s.core.bounces > 2 {
            s.core.bounces -= 1;
        } else if s.core.gpu_ms < budget * 0.55 && s.core.bounces < s.max_bounces {
            s.core.bounces += 1;
        }
    }
    s.frames += 1;
    if s.stats_t.elapsed() >= Duration::from_millis(1000) {
        let fps = s.frames as f32 / s.stats_t.elapsed().as_secs_f32();
        s.frames = 0;
        s.stats_t = Instant::now();
        shared.post(json!({
            "t": "rt.stats", "fps": fps, "gpuMs": s.core.gpu_ms, "scale": s.core.render_scale, "spp": s.spp, "bounces": s.core.bounces,
            "scriptMs": s.game.frame_ms, "shown": s.shown, "width": s.core.w, "height": s.core.h,
            "rendering": s.core.rendering_status().json(), "assets": s.host.stats(),
        }));
    }
    Ok(())
}

fn run(a: Args, rx: mpsc::Receiver<Cmd>, shared: Arc<Shared>) {
    let mut s = match init(&a) {
        Ok(s) => s,
        Err(e) => {
            shared.post(json!({ "t": "rt.fatal", "message": format!("{e:#}") }));
            return;
        }
    };
    shared.post(json!({ "t": "rt.ready", "bundle": a.bundle, "adapter": s.core.g.adapter_info.name, "hwrt": s.core.g.hwrt, "width": s.core.w, "height": s.core.h }));
    while !shared.quit.load(Ordering::Relaxed) {
        let mut cmds: Vec<Cmd> = rx.try_iter().collect();
        if let Some(last) = cmds.iter().rposition(|c| matches!(c, Cmd::Reload(_))) {
            cmds = cmds.into_iter().enumerate().filter(|(i, c)| *i == last || !matches!(c, Cmd::Reload(_))).map(|(_, c)| c).collect();
        }
        for c in cmds {
            match c {
                Cmd::Resize(w, h, scale) => {
                    s.want = (w.max(1), h.max(1));
                    s.core.set_display_scale(scale);
                }
                Cmd::Pointer(u, v) => s.input.pointer(u, v),
                Cmd::Button(n, down) => s.input.button(n, down),
                Cmd::Wheel(d) => s.input.wheel(d),
                Cmd::Key(code, name, down) => s.input.key(&code, &name, down),
                Cmd::Send(messages) => exchange(&mut s, &shared, &messages, "message"),
                Cmd::Snapshot(p) => s.snapshot = Some(p),
                Cmd::Reload(bundle) => match GameSession::open(&bundle, ROOM, &s.root, &mut s.core) {
                    Ok(game) => {
                        s.game = game;
                        let params = s.host.params.clone();
                        s.host = Host::new(s.root.clone(), params, s.agent.clone());
                        s.input = InputTracker::new();
                        let launch = s.host.launch(s.config.width, s.config.height);
                        exchange(&mut s, &shared, &[launch], "message");
                        shared.post(json!({ "t": "rt.reloaded", "bundle": bundle }));
                    }
                    Err(e) => shared.post(json!({ "t": "rt.error", "where": "reload", "message": format!("{e:#}"), "bundle": bundle })),
                },
                Cmd::Rendering(v) => {
                    if let Some(f) = v["fps"].as_u64() {
                        s.fps = (f as u32).clamp(15, 120);
                    }
                    if let Some(b) = v["bounces"].as_u64() {
                        s.max_bounces = (b as u32).clamp(1, 8);
                        s.core.bounces = s.max_bounces;
                    }
                    let mut r = v.as_object().cloned().unwrap_or_default();
                    r.retain(|k, _| matches!(k.as_str(), "quality" | "reconstruction" | "frameGeneration" | "latency"));
                    if !r.is_empty() {
                        match RenderingRequest::from_json(&Value::Object(r)) {
                            Ok(r) => s.core.set_rendering(r),
                            Err(e) => shared.post(json!({ "t": "rt.error", "where": "rendering", "message": format!("{e:#}") })),
                        }
                    }
                }
                Cmd::Pause(p) => {
                    s.paused = p;
                    s.last = Instant::now();
                }
                Cmd::Quit => return,
            }
        }
        if s.paused {
            // (Messages still reach the script, answers still come: a place can load while the map is shown.)
            let answers = s.host.answers();
            exchange(&mut s, &shared, &answers, "message");
            std::thread::sleep(Duration::from_millis(16));
            continue;
        }
        if let Err(e) = frame(&mut s, &shared) {
            shared.post(json!({ "t": "rt.error", "where": "render", "message": format!("{e:#}") }));
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

const BLIT: &str = r#"
struct Size { view: vec2<f32>, surface: vec2<f32> }
@group(0) @binding(0) var<storage, read> px: array<u32>;
@group(0) @binding(1) var<uniform> size: Size;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn texel(x: i32, y: i32) -> vec4<f32> {
    let c = px[u32(clamp(y, 0, i32(size.view.y) - 1)) * u32(size.view.x) + u32(clamp(x, 0, i32(size.view.x) - 1))];
    return vec4<f32>(f32((c >> 16u) & 255u), f32((c >> 8u) & 255u), f32(c & 255u), 255.0) / 255.0;
}

@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let q = p.xy / size.surface * size.view - 0.5;
    let f = fract(q);
    let i = vec2<i32>(floor(q));
    let a = mix(texel(i.x, i.y), texel(i.x + 1, i.y), f.x);
    let b = mix(texel(i.x, i.y + 1), texel(i.x + 1, i.y + 1), f.x);
    return mix(a, b, f.y);
}
"#;

// ----- the C ABI (native/macos/App/Core.h) -----

unsafe fn text(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}

/// Starts the globe on `metal_layer` (kept alive by the caller until `ert_destroy`), `width` x `height` pixels,
/// `scale` pixels a point. `bundle`: the globe's script; `root`: the asset root (its `cache/` is the disk cache, its
/// `dev/<name>/` the places under development); `presets`: the engine's presets; `options`: JSON
/// `{ params: {at?, place?, fly?, api?, time?}, proxy?: "http://host:port", rendering?: {quality, reconstruction},
/// fps? }`. Returns at once; `rt.ready` or `rt.fatal` arrives in `ert_poll`.
#[no_mangle]
pub unsafe extern "C" fn ert_create(metal_layer: *mut c_void, width: u32, height: u32, scale: f32, bundle: *const c_char, root: *const c_char, presets: *const c_char, options: *const c_char) -> *mut ErtView {
    set_log_sink(Some(log_sink));
    let options = serde_json::from_str(&text(options)).unwrap_or(json!({}));
    let args = Args { layer: metal_layer as usize, width, height, scale, bundle: PathBuf::from(text(bundle)), root: PathBuf::from(text(root)), presets: PathBuf::from(text(presets)), options };
    let (tx, rx) = mpsc::channel();
    let shared = Arc::new(Shared::default());
    let theirs = shared.clone();
    let thread = std::thread::Builder::new().name("earthrt-render".into()).stack_size(64 << 20).spawn(move || run(args, rx, theirs)).ok();
    Box::into_raw(Box::new(ErtView { tx, shared, thread }))
}

unsafe fn send(h: *mut ErtView, c: Cmd) {
    if let Some(h) = h.as_ref() {
        let _ = h.tx.send(c);
    }
}

#[no_mangle]
pub unsafe extern "C" fn ert_resize(h: *mut ErtView, width: u32, height: u32, scale: f32) {
    send(h, Cmd::Resize(width, height, scale));
}

/// The pointer's place in the view, 0..1 from its top left.
#[no_mangle]
pub unsafe extern "C" fn ert_pointer(h: *mut ErtView, u: f32, v: f32) {
    send(h, Cmd::Pointer(u, v));
}

/// A pointer button (0 left, 1 middle, 2 right) went down or up.
#[no_mangle]
pub unsafe extern "C" fn ert_button(h: *mut ErtView, button: u8, down: bool) {
    send(h, Cmd::Button(button, down));
}

/// Wheel notches (a trackpad's scroll and pinch, in notches), away from the user positive.
#[no_mangle]
pub unsafe extern "C" fn ert_wheel(h: *mut ErtView, notches: f32) {
    send(h, Cmd::Wheel(notches));
}

/// A key by its place (`code`: "KeyW") and the name script code reads ("W").
#[no_mangle]
pub unsafe extern "C" fn ert_key(h: *mut ErtView, code: *const c_char, name: *const c_char, down: bool) {
    send(h, Cmd::Key(text(code), text(name), down));
}

/// Host-channel messages for the script (`traced.open`, …): a JSON object or an array of them.
#[no_mangle]
pub unsafe extern "C" fn ert_send(h: *mut ErtView, json: *const c_char) {
    let messages = match serde_json::from_str::<Value>(&text(json)) {
        Ok(Value::Array(a)) => a,
        Ok(v) => vec![v],
        Err(_) => return,
    };
    send(h, Cmd::Send(messages));
}

/// What happened since the last call: a JSON array, or null. Free it with `ert_free`.
#[no_mangle]
pub unsafe extern "C" fn ert_poll(h: *mut ErtView) -> *mut c_char {
    let Some(h) = h.as_ref() else { return std::ptr::null_mut() };
    let mut posts = std::mem::take(&mut *h.shared.posts.lock().unwrap());
    for (level, text) in std::mem::take(&mut *LOGS.lock().unwrap()) {
        posts.push(json!({ "t": "log", "level": level, "text": text }).to_string());
    }
    if posts.is_empty() {
        return std::ptr::null_mut();
    }
    CString::new(format!("[{}]", posts.join(","))).map_or(std::ptr::null_mut(), CString::into_raw)
}

#[no_mangle]
pub unsafe extern "C" fn ert_free(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

/// Saves the next traced frame as a PNG (`rt.snapshot` when written).
#[no_mangle]
pub unsafe extern "C" fn ert_snapshot(h: *mut ErtView, path: *const c_char) {
    send(h, Cmd::Snapshot(PathBuf::from(text(path))));
}

/// Runs another build of the globe's script in the same view (`rt.reloaded`, or `rt.error` and the old one goes on).
#[no_mangle]
pub unsafe extern "C" fn ert_reload(h: *mut ErtView, bundle: *const c_char) {
    send(h, Cmd::Reload(PathBuf::from(text(bundle))));
}

/// The Graphics settings, JSON, any of: `quality` ("auto", "native", "quality", "balanced", "performance",
/// "ultra-performance" or a scale), `reconstruction` ("auto", a method or a list: "metalfx-denoised", "metalfx",
/// "builtin", …), `frameGeneration`, `latency` (ThreeRT docs/RUNTIME.md "Live rendering settings"), `fps` (content
/// frames a second), `bounces` (the most).
#[no_mangle]
pub unsafe extern "C" fn ert_rendering(h: *mut ErtView, json: *const c_char) {
    if let Ok(v) = serde_json::from_str::<Value>(&text(json)) {
        send(h, Cmd::Rendering(v));
    }
}

/// Stops drawing (the map is shown) or starts again. Messages and downloads go on while paused.
#[no_mangle]
pub unsafe extern "C" fn ert_pause(h: *mut ErtView, paused: bool) {
    send(h, Cmd::Pause(paused));
}

#[no_mangle]
pub unsafe extern "C" fn ert_destroy(h: *mut ErtView) {
    if h.is_null() {
        return;
    }
    let mut h = Box::from_raw(h);
    h.shared.quit.store(true, Ordering::Relaxed);
    let _ = h.tx.send(Cmd::Quit);
    if let Some(t) = h.thread.take() {
        let until = Instant::now() + Duration::from_secs(2);
        while !t.is_finished() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        if t.is_finished() {
            let _ = t.join();
        }
    }
}

/// The bytes under a directory (the cache's size for the app's Storage settings), following no links.
pub fn dir_bytes(p: &std::path::Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_bytes(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map_or(0, |m| m.len()),
            _ => 0,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posts_are_routed() {
        assert_eq!(route(&json!({ "t": "assets.fetch" })), Route::Services);
        assert_eq!(route(&json!({ "t": "assets.cancel" })), Route::Services);
        assert_eq!(route(&json!({ "t": "net.fetch" })), Route::Services);
        assert_eq!(route(&json!({ "t": "audio.play" })), Route::Audio);
        for t in ["traced.ready", "traced.view", "traced.exit", "traced.loading", "traced.status", "hud", "my.thing"] {
            assert_eq!(route(&json!({ "t": t })), Route::App, "{t}");
        }
        assert_eq!(route(&json!({})), Route::App);
    }

    /// The launch message carries the app's parameters, the view's size and the families the app answers.
    #[test]
    fn launch_has_params_and_caps() {
        let dir = std::env::temp_dir().join(format!("ert-launch-{}", std::process::id()));
        let h = Host::new(dir, json!({ "place": "threert/earth-sample-kyoto-tower/kyoto-tower" }), net::default_agent());
        let l = h.launch(1280, 720);
        assert_eq!(l["t"], "launch");
        assert_eq!(l["caps"], json!(["assets", "traced"]));
        assert_eq!(l["params"]["place"], "threert/earth-sample-kyoto-tower/kyoto-tower");
        assert_eq!((l["params"]["width"].as_u64(), l["params"]["height"].as_u64()), (Some(1280), Some(720)));
        let none = Host::new(std::env::temp_dir(), Value::Null, net::default_agent()).launch(2, 1);
        assert_eq!(none["params"], json!({ "width": 2, "height": 1 }));
    }

    /// The services take their own posts and answer them; the rest pass through in order.
    #[test]
    fn host_takes_its_own_and_passes_the_rest() {
        let dir = std::env::temp_dir().join(format!("ert-host-{}", std::process::id()));
        let mut h = Host::new(dir.clone(), json!({}), net::default_agent());
        let rest = h.take(vec![
            json!({ "t": "traced.view", "lat": 35 }),
            json!({ "t": "assets.fetch", "id": "x", "url": "https://example.invalid/a", "path": "../etc/passwd" }),
            json!({ "t": "net.fetch", "id": "y", "url": "file:///etc/passwd" }),
            json!({ "t": "traced.status" }),
        ]);
        assert_eq!(rest.iter().map(|m| m["t"].as_str().unwrap()).collect::<Vec<_>>(), ["traced.view", "traced.status"]);
        let mut got = vec![];
        for _ in 0..100 {
            got.extend(h.answers());
            if got.len() == 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        got.sort_by_key(|m| m["t"].as_str().map(String::from));
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!((got[0]["t"].as_str(), got[0]["status"].as_u64()), (Some("assets.fetched"), Some(0)));
        assert_eq!((got[1]["t"].as_str(), got[1]["status"].as_u64()), (Some("net.fetched"), Some(0)));
        assert_eq!(h.stats()["requests"], 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dir_bytes_counts_files() {
        let dir = std::env::temp_dir().join(format!("ert-bytes-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::write(dir.join("a/x"), [0u8; 10]).unwrap();
        std::fs::write(dir.join("a/b/y"), [0u8; 5]).unwrap();
        assert_eq!(dir_bytes(&dir), 15);
        let _ = std::fs::remove_dir_all(dir);
    }
}
