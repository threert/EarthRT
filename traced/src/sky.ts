// The sun and the sky over the place: the sun's real direction for the map's moment (core `sunDirection`, ECEF) turned
// into the scene's frame, on a `DirectionalLight` that drives ThreeRT's physical atmosphere (`dynamic`: re-baked in
// place as the sun moves) seen from the camera's real height (`altitude`: the engine re-bakes past 5 % or 250 m).
import { DirectionalLight, SkyAtmosphere, type Scene } from "@threert/scene";
import { sunDirection, type Frame } from "../../packages/core/src/index.ts";

export class Sky {
  sun = new DirectionalLight(0xfff4e8, 100_000);
  atmosphere: SkyAtmosphere;
  private lastDir = [0, 0, 0];

  constructor(scene: Scene) {
    scene.add(this.sun);
    // (a planet's sky from the first frame: `altitude` set, not null)
    this.atmosphere = new SkyAtmosphere({ sun: this.sun, dynamic: true, aerialPerspective: 1, altitude: 100 });
    scene.environment = this.atmosphere;
  }

  /** The sun for a UTC time (ms), the sky for the camera's height above the ellipsoid (m). */
  update(frame: Frame, utcMs: number, altitude: number) {
    const d = frame.dir(sunDirection(utcMs));
    // (moved only when it turned a few hundredths of a degree: every move re-describes the environment)
    if (Math.abs(d[0] - this.lastDir[0]) + Math.abs(d[1] - this.lastDir[1]) + Math.abs(d[2] - this.lastDir[2]) > 5e-4) {
      this.lastDir = [...d];
      this.sun.position.set(d[0] * 100, d[1] * 100, d[2] * 100);
    }
    this.atmosphere.altitude = Math.max(0, altitude);
  }
}
