// The Kyoto places the traced view is judged at (SPEC § 5 registry ids, or a dev folder under the asset root), with a
// camera each (lat,lon,alt,heading,pitch) and a local solar hour.
export const PLACES: Record<string, { place?: string; dev?: string; at?: string; time?: string }> = {
  // the back parlour, from the place's own start, toward the garden and the andon
  machiya: { place: "threert/earth-sample-gion-machiya/gion-machiya", time: "15" },
  "machiya-dusk": { place: "threert/earth-sample-gion-machiya/gion-machiya", time: "18.6" },
  // over the roofs of Karasuma street, 400 m north of the tower, looking south at it
  tower: { place: "threert/earth-sample-kyoto-tower/kyoto-tower", at: "34.9912,135.7596,95,184,4", time: "15" },
  "tower-lowpoly": { place: "threert/earth-sample-kyoto-tower-lowpoly/kyoto-tower", at: "34.9912,135.7596,95,184,4", time: "15" },
  "tower-street": { place: "threert/earth-sample-kyoto-tower/kyoto-tower", at: "34.9893,135.75945,31.5,186,20", time: "15" },
  "tower-air": { place: "threert/earth-sample-kyoto-tower/kyoto-tower", at: "34.9830,135.7550,250,35,-12", time: "15" },
  cube: { place: "threert/earth-sample-cube/sample-cube", time: "15" },
  // the city at street level (threert/earth-kyoto; dev: out/real/dev/kyoto links to its build)
  "kyoto-hanamikoji": { dev: "dev/kyoto", at: "35.0025,135.7750,40,180,0", time: "15" },
  "kyoto-sannenzaka": { dev: "dev/kyoto", at: "34.9975,135.7800,60,300,2", time: "15" },
  "kyoto-air": { dev: "dev/kyoto", at: "34.9900,135.7700,400,330,-15", time: "15" },
};
