// The smoke test as a game: setup runs it in the engine's QuickJS; the scheduler's answers come with the promise jobs.
import { PerspectiveCamera, Scene } from "@threert/scene";
import { defineGame } from "@threert/gameplay";
import { run } from "./core-smoke.ts";

export default defineGame({
  state: {},
  handlers: {},
  setup() {
    const log = (k: string, v: unknown) => console.log(`core-smoke ${k} ${JSON.stringify(v)}`);
    try {
      const s = run(log);
      void Promise.resolve().then(() => 0).then(() => 0).then(() => 0).then(() => log("scheduler", s.take().map((x) => x.id)));
    } catch (e) {
      console.log(`core-smoke error ${String(e)} ${(e as Error)?.stack ?? ""}`);
    }
    return { scene: new Scene(), camera: new PerspectiveCamera() };
  },
});
