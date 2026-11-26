// The map embedded in an <iframe> (SPEC § 6.1, `parent=`): every earth.* message it should send arrives, and it does
// what the host asks. web/dev/embed.html is the host page.
//   bun tools/embed-test.ts [--base http://127.0.0.1:8795] [--api https://earth.threert.dev]
import { launch } from "./cdp.ts";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = arg("--base", "http://127.0.0.1:8795")!;
const api = arg("--api", "https://earth.threert.dev")!;
const q = encodeURIComponent(`at=34.9875,135.7592,2500,0,-30&time=2026-06-21T06:00:00Z&api=${api}`);
const b = await launch({ log: (l) => { if (/exception|error/i.test(l) && !l.includes("net failed")) console.log(l); } });
const fails: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
try {
  const p = await b.open(`${base}/dev/embed.html?q=${q}`);
  const got = <T = any>(t: string) => p.evaluate<T[]>(`window.got.filter(m => m.t === ${JSON.stringify(t)})`);
  await p.waitFor("window.got && window.got.some(m => m.t === 'earth.ready')", 30_000);
  check(true, "earth.ready");
  await p.waitFor("window.got.some(m => m.t === 'earth.view') && window.got.some(m => m.t === 'earth.status')", 15_000);
  const v = (await got("earth.view")).at(-1);
  check(Math.abs(v.lat - 34.9875) < 0.01 && Math.abs(v.alt - 2500) < 300, `earth.view at the start (${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}, ${Math.round(v.alt)} m)`);
  check(!(await p.evaluate<boolean>("(() => { const d = document.getElementById('map').contentDocument; return [...d.querySelectorAll('#top, #panel, #timebox')].some(e => e.offsetParent !== null); })()")), "no interface of its own");
  await p.waitFor("window.got.some(m => m.t === 'earth.places' && m.list.length > 0)", 30_000);
  const places = (await got("earth.places")).at(-1).list;
  check(places.some((x: any) => x.id.includes("kyoto-tower")), `earth.places lists the Kyoto places (${places.length})`);
  // goto near the tower (within a site's enterFrom, 400 m)
  await p.evaluate(`window.send({ t: "earth.goto", lat: 34.9850, lon: 135.7592, alt: 250, heading: 0, pitch: -20, seconds: 0 })`);
  await p.waitFor("window.got.some(m => m.t === 'earth.near')", 20_000).catch(() => {});
  const near = await got("earth.near");
  check(near.some((n) => n.id.includes("kyoto-tower")), `earth.near for the tower (${near.map((n) => `${n.id} ${n.distance} m`).join(", ")})`);
  await p.evaluate(`window.send({ t: "earth.select", id: ${JSON.stringify(places.find((x: any) => x.id.includes("kyoto-tower")).id)} })`);
  await p.waitFor("window.got.some(m => m.t === 'earth.selected')", 15_000).catch(() => {});
  const sel = (await got("earth.selected")).at(-1);
  check(!!sel && sel.versions.length >= 2, `earth.selected with the tower's versions (${sel?.versions.map((x: any) => x.title).join(" / ")})`);
  await p.evaluate(`window.send({ t: "earth.time", solarHour: 18.5 })`);
  await Bun.sleep(400);
  const tv = (await got("earth.view")).at(-1);
  const hour = ((tv.utc / 3600000 + tv.lon / 15) % 24 + 24) % 24;
  check(Math.abs(hour - 18.5) < 0.1, `earth.time → utc in earth.view (${hour.toFixed(2)} h solar)`);
  // a click without a drag → earth.pick
  await p.mouse("mousePressed", 640, 500); await p.mouse("mouseReleased", 640, 500);
  await p.waitFor("window.got.some(m => m.t === 'earth.pick')", 5_000).catch(() => {});
  const pick = (await got("earth.pick")).at(-1);
  check(!!pick && Math.abs(pick.lat - 34.99) < 0.05, `earth.pick (${pick ? `${pick.lat.toFixed(4)}, ${pick.lon.toFixed(4)}, ${pick.h?.toFixed(1)} m` : "none"})`);
  await p.evaluate(`window.send({ t: "earth.fly", from: { lat: 34.9875, lon: 135.7592 }, to: "35.6812,139.7671" })`);
  await p.waitFor("window.got.some(m => m.t === 'earth.flight' && m.state === 'flying')", 10_000).catch(() => {});
  await Bun.sleep(1500);
  await p.evaluate(`window.send({ t: "earth.stop" })`);
  await p.waitFor("window.got.some(m => m.t === 'earth.flight' && m.state === 'done')", 5_000).catch(() => {});
  const fl = await got("earth.flight");
  check(fl.some((f) => f.state === "flying") && fl.some((f) => f.state === "done"), `earth.flight flying → done (${fl.length} messages, duration ${fl[0]?.duration?.toFixed(0)} s)`);
  const n0 = (await got("earth.view")).length;
  await p.evaluate(`window.send({ t: "earth.pause", paused: true })`);
  await p.evaluate(`window.send({ t: "earth.goto", lat: 35.0, lon: 135.76, alt: 3000, seconds: 0 })`);
  await Bun.sleep(1200);
  const n1 = (await got("earth.view")).length;
  await p.evaluate(`window.send({ t: "earth.pause", paused: false })`);
  await Bun.sleep(800);
  const n2 = (await got("earth.view")).length;
  check(n1 - n0 <= 1 && n2 > n1, `earth.pause stops the frame (views ${n0} → ${n1} paused → ${n2} resumed)`);
  await p.evaluate(`window.send({ t: "earth.settings", quality: "app", sse: 5, labels: false })`);
  await Bun.sleep(300);
  const st = await p.evaluate<any>("(() => { const e = document.getElementById('map').contentWindow.earth; return { sse: e.sse, budget: e.tiles.gpuBudget / 1048576, q: e.settings.quality }; })()");
  check(st.sse === 5 && st.budget === 1024 && st.q === "app", `earth.settings (sse ${st.sse}, budget ${st.budget} MB, quality ${st.q})`);
  console.log("messages:", JSON.stringify(await p.evaluate("window.kinds()")));
  await p.screenshot("out/s3/embedded.jpg");
} finally {
  b.close();
}
if (fails.length) {
  console.log(`${fails.length} failed`);
  process.exit(1);
}
