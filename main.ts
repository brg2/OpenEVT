import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import Stats from "stats.js";
import GUI from "lil-gui";
import seedrandom from "seedrandom";
import { createNoise2D } from "simplex-noise";

import * as CANNON from "cannon-es";

function loadObjWithMtl(
  basePath: string,
  objFile: string,
  mtlFile: string,
): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    const mtlLoader = new MTLLoader();
    mtlLoader.setPath(basePath);
    mtlLoader.load(
      mtlFile,
      (materials) => {
        materials.preload();
        const objLoader = new OBJLoader();
        objLoader.setMaterials(materials);
        objLoader.setPath(basePath);
        objLoader.load(
          objFile,
          (obj) => resolve(obj),
          undefined,
          (err) => reject(err),
        );
      },
      undefined,
      (err) => reject(err),
    );
  });
}

function setModelShadowsAndColorSpace(model: THREE.Object3D) {
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if ((mesh as any).isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const mat = mesh.material as unknown as
        | THREE.Material
        | THREE.Material[]
        | undefined;
      const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
      for (const m of mats) {
        const anyM = m as any;
        if (anyM?.map) {
          anyM.map.colorSpace = THREE.SRGBColorSpace;
          anyM.map.needsUpdate = true;
        }
      }
    }
  });
}

function sanitizeObjMaterials(model: THREE.Object3D) {
  const isAllowedTransparent = (name: string) =>
    /(glass|window|windshield|lens|light)/i.test(name);
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as any).isMesh) return;
    const mat = mesh.material as unknown as
      | THREE.Material
      | THREE.Material[]
      | undefined;
    const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
    for (const m of mats) {
      const anyM = m as any;
      const name = `${anyM?.name ?? ""} ${mesh.name ?? ""}`.trim();
      const allow = isAllowedTransparent(name);

      // Many MTL exports incorrectly provide `map_d` for every material (often the diffuse texture),
      // which makes everything render semi-transparent in three.js. Strip alpha unless it's glass.
      if (!allow && anyM?.alphaMap) anyM.alphaMap = null;
      if (!allow) {
        anyM.transparent = false;
        anyM.opacity = 1.0;
        anyM.alphaTest = 0;
        anyM.depthWrite = true;
      } else {
        anyM.transparent = true;
        anyM.opacity =
          typeof anyM.opacity === "number"
            ? Math.min(anyM.opacity, 0.45)
            : 0.35;
        anyM.depthWrite = false;
        anyM.side = THREE.DoubleSide;
      }
      if (typeof anyM.needsUpdate !== "undefined") anyM.needsUpdate = true;
    }
  });
}

type WheelIndex = 0 | 1 | 2 | 3; // FL, FR, RL, RR

function collectWheelCandidateMeshesFromObj(
  model: THREE.Object3D,
): THREE.Mesh[] {
  const matchRe = /(wheel|tire|tyre|rim)/i;
  const candidates: THREE.Mesh[] = [];
  model.updateWorldMatrix(true, true);

  const modelBox = new THREE.Box3().setFromObject(model);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  modelBox.getCenter(center);
  modelBox.getSize(size);

  const tmp = new THREE.Vector3();
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as any).isMesh) return;

    const name = mesh.name || "";
    let matName = "";
    const mat = mesh.material as any;
    if (Array.isArray(mat)) matName = mat.map((m) => m?.name ?? "").join(" ");
    else matName = mat?.name ?? "";
    if (!(matchRe.test(name) || matchRe.test(matName))) return;

    // Filter out interior steering wheel / cabin bits: wheels are low and near the four corners.
    const p = mesh.getWorldPosition(tmp);
    const cornerish =
      Math.abs(p.x - center.x) > size.x * 0.22 ||
      Math.abs(p.z - center.z) > size.z * 0.22;
    const low = p.y < center.y - size.y * 0.05;
    if (!cornerish || !low) return;

    candidates.push(mesh);
  });
  return candidates;
}

function buildWheelTemplateFromCluster(
  meshes: THREE.Mesh[],
  clusterCenterWorld: THREE.Vector3,
  wheelRadiusMeters: number,
  wheelWidthMeters: number,
): THREE.Group {
  const invCenter = new THREE.Matrix4().makeTranslation(
    -clusterCenterWorld.x,
    -clusterCenterWorld.y,
    -clusterCenterWorld.z,
  );
  const template = new THREE.Group();

  for (const src of meshes) {
    const srcGeo = src.geometry as THREE.BufferGeometry | undefined;
    if (!srcGeo) continue;
    const geo = srcGeo.clone();
    const rel = new THREE.Matrix4().multiplyMatrices(
      invCenter,
      src.matrixWorld,
    );
    geo.applyMatrix4(rel);

    const srcMat = src.material as any;
    let mat: any;
    if (Array.isArray(srcMat))
      mat = srcMat.map((m: any) => (m?.clone ? m.clone() : m));
    else mat = srcMat?.clone ? srcMat.clone() : srcMat;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    template.add(mesh);
  }

  // Center template precisely (use bbox center, not mean point).
  template.updateWorldMatrix(true, true);
  const boxC = new THREE.Box3().setFromObject(template);
  const c = new THREE.Vector3();
  boxC.getCenter(c);
  template.position.sub(c);

  // Re-orient so the wheel's width axis aligns with +X (matching our wheel transform).
  template.updateWorldMatrix(true, true);
  const box0 = new THREE.Box3().setFromObject(template);
  const size0 = new THREE.Vector3();
  box0.getSize(size0);
  const widthAxis = ((): "x" | "y" | "z" => {
    if (size0.x <= size0.y && size0.x <= size0.z) return "x";
    if (size0.y <= size0.x && size0.y <= size0.z) return "y";
    return "z";
  })();
  if (widthAxis === "z") template.rotation.y = Math.PI / 2;
  if (widthAxis === "y") template.rotation.z = Math.PI / 2;

  // Scale to match our physics wheel radius/width (independent width vs radius).
  template.updateWorldMatrix(true, true);
  const box1 = new THREE.Box3().setFromObject(template);
  const size1 = new THREE.Vector3();
  box1.getSize(size1);
  const currentDiameter = Math.max(size1.y, size1.z);
  const scaleRadial =
    currentDiameter > 1e-6 ? (2 * wheelRadiusMeters) / currentDiameter : 1;
  const scaleWidth = size1.x > 1e-6 ? wheelWidthMeters / size1.x : 1;
  template.scale.set(scaleWidth, scaleRadial, scaleRadial);

  return template;
}

function extractWheelTemplatesFromObj(
  model: THREE.Object3D,
  wheelRadiusMeters: number,
  wheelWidthMeters: number,
): Partial<Record<WheelIndex, THREE.Group>> {
  const candidates = collectWheelCandidateMeshesFromObj(model);
  if (candidates.length === 0) return {};

  // K-means-ish clustering into 4 wheel corners.
  const tmp = new THREE.Vector3();
  const points = candidates.map((m) => m.getWorldPosition(tmp.clone()));

  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }

  const pickClosest = (x: number, z: number) => {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    return points[bestI].clone();
  };

  const centers: THREE.Vector3[] = [
    pickClosest(minX, maxZ), // FL-ish
    pickClosest(maxX, maxZ), // FR-ish
    pickClosest(minX, minZ), // RL-ish
    pickClosest(maxX, minZ), // RR-ish
  ];

  const assign: number[] = new Array(points.length).fill(0);
  for (let iter = 0; iter < 6; iter++) {
    // Assign
    for (let i = 0; i < points.length; i++) {
      let bestK = 0;
      let bestD = Infinity;
      for (let k = 0; k < 4; k++) {
        const dx = points[i].x - centers[k].x;
        const dz = points[i].z - centers[k].z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          bestK = k;
        }
      }
      assign[i] = bestK;
    }
    // Update
    const sum = [
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3(),
    ];
    const count = [0, 0, 0, 0];
    for (let i = 0; i < points.length; i++) {
      sum[assign[i]].add(points[i]);
      count[assign[i]]++;
    }
    for (let k = 0; k < 4; k++) {
      if (count[k] > 0) centers[k].copy(sum[k]).multiplyScalar(1 / count[k]);
    }
  }

  const clusterMeshes: THREE.Mesh[][] = [[], [], [], []];
  for (let i = 0; i < candidates.length; i++)
    clusterMeshes[assign[i]].push(candidates[i]);

  const out: Partial<Record<WheelIndex, THREE.Group>> = {};
  for (let k = 0; k < 4; k++) {
    if (clusterMeshes[k].length === 0) continue;
    // Determine which wheel index this cluster is based on centroid relative to model.
    const p = centers[k];
    const isFront = p.z >= (minZ + maxZ) * 0.5;
    const isLeft = p.x <= (minX + maxX) * 0.5;
    const idx: WheelIndex = (
      isFront ? (isLeft ? 0 : 1) : isLeft ? 2 : 3
    ) as WheelIndex;
    out[idx] = buildWheelTemplateFromCluster(
      clusterMeshes[k],
      centers[k],
      wheelRadiusMeters,
      wheelWidthMeters,
    );
  }
  return out;
}

function applyWheelTemplatesToVehicle(
  templates: Partial<Record<WheelIndex, THREE.Object3D>>,
) {
  const ud = vehicleGroup.userData as any;
  const roots = ud.wheelRoots as THREE.Object3D[] | undefined;
  const procedural = ud.proceduralWheelVisuals as THREE.Object3D[] | undefined;
  if (!roots || !procedural) {
    ud.pendingWheelTemplates = templates;
    return;
  }

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const proc = procedural[i];
    const tpl = (templates as any)[i] as THREE.Object3D | undefined;
    if (!tpl) continue;

    if (proc) proc.visible = false;
    // Remove previous OBJ wheel visuals (keep the procedural mesh around, just hidden).
    const toRemove: THREE.Object3D[] = [];
    for (const ch of root.children) {
      if (proc && ch === proc) continue;
      toRemove.push(ch);
    }
    for (const ch of toRemove) root.remove(ch);
    root.add(tpl.clone(true));
  }
}

function fitCenterAndPlaceOnRestGroundY(
  model: THREE.Object3D,
  targetLengthZ: number,
  restGroundYLocal: number,
  yawRadians = Math.PI,
) {
  // First, apply a likely forward-direction correction (many OBJ exports face -Z).
  model.rotation.set(0, yawRadians, 0);

  // Compute size, then scale to match our current vehicle visual length.
  const box0 = new THREE.Box3().setFromObject(model);
  const size0 = new THREE.Vector3();
  box0.getSize(size0);
  if (size0.z > 1e-6 && Number.isFinite(targetLengthZ)) {
    const s = targetLengthZ / size0.z;
    model.scale.setScalar(s);
  }

  // Center in X/Z and put the lowest point on the rest-ground height.
  const box = new THREE.Box3().setFromObject(model);
  const center = new THREE.Vector3();
  box.getCenter(center);
  model.position.sub(center);
  const box2 = new THREE.Box3().setFromObject(model);
  model.position.y += restGroundYLocal - box2.min.y;
}

type ChunkKey = string;

const canvas = document.querySelector<HTMLCanvasElement>("#c");
if (!canvas) throw new Error("Missing canvas #c");

// ---------- Render setup ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();

// Background color used for far fog blend; keep fog color synced to this.
const fogColor = new THREE.Color(0x87cfff);
scene.background = fogColor;

const fog = new THREE.Fog(fogColor, 80, 520);
scene.fog = fog;

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  6000,
);
camera.position.set(0, 6, 14);

// Sky + Sun
const sky = new Sky();
// Keep the sky within the camera far plane; we'll re-center it on the camera each frame.
sky.scale.setScalar(4500);
scene.add(sky);

const sun = new THREE.Vector3();
const skyUniforms = sky.material.uniforms;
skyUniforms["turbidity"].value = 6;
skyUniforms["rayleigh"].value = 2;
skyUniforms["mieCoefficient"].value = 0.005;
skyUniforms["mieDirectionalG"].value = 0.8;

// Sample the rendered sky color near the horizon and use it for fog/background.
const skySampleRT = new THREE.WebGLRenderTarget(1, 1, {
  depthBuffer: false,
  stencilBuffer: false,
});
const skySampleCam = new THREE.PerspectiveCamera(60, 1, 0.1, 10000);
skySampleCam.position.set(0, 0, 0);
skySampleCam.lookAt(0, 0.03, -1);
const skySamplePx = new Uint8Array(4);
function syncFogToSkyColor(hide: THREE.Object3D[] = []) {
  const prevVis = hide.map((o) => o.visible);
  for (const o of hide) o.visible = false;

  const prevRT = renderer.getRenderTarget();
  renderer.setRenderTarget(skySampleRT);
  renderer.clear(true, true, true);
  renderer.render(scene, skySampleCam);
  renderer.readRenderTargetPixels(skySampleRT, 0, 0, 1, 1, skySamplePx);
  renderer.setRenderTarget(prevRT);

  for (let i = 0; i < hide.length; i++) hide[i].visible = prevVis[i];

  // `readRenderTargetPixels` yields 0-255 bytes; treat as linear-ish for our fog/background.
  fogColor.setRGB(
    skySamplePx[0] / 255,
    skySamplePx[1] / 255,
    skySamplePx[2] / 255,
  );
  fog.color.copy(fogColor);
}

function setSun(elevationDeg: number, azimuthDeg: number) {
  const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
  const theta = THREE.MathUtils.degToRad(azimuthDeg);
  sun.setFromSphericalCoords(1, phi, theta);
  sky.material.uniforms["sunPosition"].value.copy(sun);
}

setSun(35, 135);
syncFogToSkyColor();

// Lighting
// Slightly brighter fill so the scene reads “daytime” even with fog.
const hemi = new THREE.HemisphereLight(0xdaf3ff, 0x3a3a3a, 0.78);
scene.add(hemi);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.35);
dirLight.position.set(40, 80, -20);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.bias = -0.0002;
dirLight.shadow.normalBias = 0.02;
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 220;
dirLight.shadow.camera.left = -70;
dirLight.shadow.camera.right = 70;
dirLight.shadow.camera.top = 70;
dirLight.shadow.camera.bottom = -70;
scene.add(dirLight);

// ---------- Physics setup ----------
const world = new CANNON.World({
  gravity: new CANNON.Vec3(0, -14.5, 0),
});
world.allowSleep = true;
world.broadphase = new CANNON.SAPBroadphase(world);
world.defaultContactMaterial.friction = 0.6;

const groundMaterial = new CANNON.Material("ground");
const tireMaterial = new CANNON.Material("tire");
const tireGround = new CANNON.ContactMaterial(tireMaterial, groundMaterial, {
  friction: 0.8,
  restitution: 0.0,
});
world.addContactMaterial(tireGround);

// ---------- Procedural terrain (infinite tiled chunks) ----------
function getSeedString() {
  const fromUrl = new URLSearchParams(window.location.search).get("seed");
  if (fromUrl && fromUrl.trim().length > 0) return fromUrl.trim();
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((n) => n.toString(16).padStart(8, "0"))
    .join("");
}

const hudEl = document.querySelector<HTMLDivElement>("#hud");
const hintEl = document.querySelector<HTMLDivElement>("#hud .hint");
const baseHintText = hintEl?.textContent ?? "";

const hudReadout = document.createElement("div");
hudReadout.style.marginTop = "6px";
hudReadout.style.fontSize = "12px";
hudReadout.style.opacity = "0.9";
hudReadout.textContent = "gear: 1 • rpm: 650";
hudEl?.appendChild(hudReadout);

const roadDebugEl = document.createElement("div");
roadDebugEl.style.marginTop = "2px";
roadDebugEl.style.fontSize = "12px";
roadDebugEl.style.opacity = "0.9";
roadDebugEl.textContent = "road: (init)";
hudEl?.appendChild(roadDebugEl);

let seed = getSeedString();
let rng = seedrandom(seed);
let noise2D = createNoise2D(rng);

function setHudSeed(nextSeed: string) {
  if (!hintEl) return;
  hintEl.textContent = `${baseHintText} • seed: ${nextSeed.slice(0, 10)}`;
}

function reseedTerrain(nextSeed?: string) {
  seed = nextSeed ?? getSeedString();
  rng = seedrandom(seed);
  noise2D = createNoise2D(rng);
  setHudSeed(seed);

  applyTerrainMaterial(seed);
  applyRoadMaterial(seed);
  updateRoadDebugLabel();

  const disposeRoadObject = (obj: THREE.Object3D) => {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      const geo = (mesh as any).geometry as THREE.BufferGeometry | undefined;
      if (geo && typeof geo.dispose === "function") geo.dispose();
    });
  };

  // Drop all current chunks so they regenerate using the new seed.
  for (const [, c] of chunks) {
    terrainGroup.remove(c.mesh);
    if (c.roadMesh) {
      terrainGroup.remove(c.roadMesh);
      disposeRoadObject(c.roadMesh);
    }
    c.mesh.geometry.dispose();
    const m = c.mesh.material as unknown as THREE.Material | THREE.Material[];
    if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
    else if (m && m !== terrainMat) m.dispose();
    world.removeBody(c.body);
  }
  chunks.clear();

  pendingChunkBuilds.length = 0;
  pendingChunkKeys.clear();
}

setHudSeed(seed);

const settings = {
  chunkSize: 80,
  resolution: 48,
  amplitude: 30,
  frequency: 0.012,
  octaves: 4,
  lacunarity: 2.0,
  gain: 0.5,
  roadHalfWidth: 3.6,
  sidewalkWidth: 0.9,
  roadShoulder: 1.1,
  roadHeight: 0,
  // Visual-only offset for the road overlay mesh to avoid z-fighting.
  roadEpsilon: 0.006,
  roadCurveStartZ: 220,
  roadCurveScale: 0.0018,
  roadCurveAmplitude: 28,
  viewRadiusChunks: 2,
  fogAuto: true,
  fogNear: 0,
  fogFar: 1600,
  fogEndMultiplier: 1.05,
  // Aerodynamics
  dragCoeff: 0.018, // N per (m/s)^2 (scaled for our lightweight chassis mass)
  windSound: true,
  windVolume: 0.55,
  // Audio
  engineVolume: 0.75,
};

function terrainMaxDistance() {
  // Approx max visible distance to the edge of generated chunks (diagonal).
  const r = settings.viewRadiusChunks + 0.75;
  return r * settings.chunkSize * Math.SQRT2;
}

function syncFogRange() {
  if (!settings.fogAuto) {
    fog.near = settings.fogNear;
    fog.far = settings.fogFar;
    return;
  }
  // Start fog essentially at the vehicle and blend very slowly to the chunk horizon.
  fog.near = 0;
  fog.far = terrainMaxDistance() * settings.fogEndMultiplier;
}

syncFogRange();

const terrainGroup = new THREE.Group();
scene.add(terrainGroup);

function makeGrassTextures(seedStr: string) {
  const texRng = seedrandom(`${seedStr}:tex`);
  const n2 = createNoise2D(texRng);

  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context");

  const img = ctx.createImageData(size, size);
  const data = img.data;

  const freq1 = 6.5;
  const freq2 = 22.0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const nA = n2(u * freq1, v * freq1);
      const nB = n2(u * freq2, v * freq2);
      const t = 0.55 + 0.18 * nA + 0.1 * nB;

      const r = Math.round(40 + 45 * t);
      const g = Math.round(90 + 130 * t);
      const b = Math.round(35 + 40 * t);

      const i = (y * size + x) * 4;
      data[i + 0] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  map.needsUpdate = true;

  // Lightweight normal map derived from noise gradient.
  const nCanvas = document.createElement("canvas");
  nCanvas.width = size;
  nCanvas.height = size;
  const nCtx = nCanvas.getContext("2d");
  if (!nCtx) throw new Error("No 2D context");

  const nImg = nCtx.createImageData(size, size);
  const nd = nImg.data;
  const eps = 1 / size;
  const strength = 2.6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const hL = n2((u - eps) * freq1, v * freq1);
      const hR = n2((u + eps) * freq1, v * freq1);
      const hD = n2(u * freq1, (v - eps) * freq1);
      const hU = n2(u * freq1, (v + eps) * freq1);
      const dx = (hR - hL) * strength;
      const dy = (hU - hD) * strength;

      const nx = -dx;
      const ny = 1.0;
      const nz = -dy;
      const invLen = 1 / Math.max(1e-6, Math.hypot(nx, ny, nz));
      const nnx = nx * invLen;
      const nny = ny * invLen;
      const nnz = nz * invLen;

      const i = (y * size + x) * 4;
      nd[i + 0] = Math.round((nnx * 0.5 + 0.5) * 255);
      nd[i + 1] = Math.round((nny * 0.5 + 0.5) * 255);
      nd[i + 2] = Math.round((nnz * 0.5 + 0.5) * 255);
      nd[i + 3] = 255;
    }
  }
  nCtx.putImageData(nImg, 0, 0);

  const normalMap = new THREE.CanvasTexture(nCanvas);
  normalMap.colorSpace = THREE.NoColorSpace;
  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  normalMap.needsUpdate = true;

  return { map, normalMap };
}

const terrainMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 1.0,
  metalness: 0.0,
  vertexColors: true,
});

function makeCementTexture(seedStr: string) {
  const texRng = seedrandom(`${seedStr}:cement`);
  const n2 = createNoise2D(texRng);
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context");
  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const speck = n2(u * 32, v * 32) * 0.06 + n2(u * 6, v * 6) * 0.04;
      const base = 0.86 + speck;
      const c = Math.round(THREE.MathUtils.clamp(base, 0.78, 0.93) * 255);
      const i = (y * size + x) * 4;
      d[i + 0] = c;
      d[i + 1] = c;
      d[i + 2] = c;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  map.needsUpdate = true;
  return map;
}

let cementMap = makeCementTexture(seed);
// Use an unlit material so the asphalt can't be tinted by scene lighting.
const roadMat = new THREE.MeshBasicMaterial({
  color: 0x2b2b2b,
});
roadMat.polygonOffset = true;
roadMat.polygonOffsetFactor = -6;
roadMat.polygonOffsetUnits = -6;

const sidewalkMat = new THREE.MeshStandardMaterial({
  color: 0xe7e7e7,
  roughness: 0.95,
  metalness: 0.0,
  map: cementMap,
});
sidewalkMat.polygonOffset = true;
sidewalkMat.polygonOffsetFactor = -7;
sidewalkMat.polygonOffsetUnits = -7;

function applyTerrainMaterial(seedStr: string) {
  const { map, normalMap } = makeGrassTextures(seedStr);
  terrainMat.map?.dispose();
  terrainMat.normalMap?.dispose();
  terrainMat.map = map;
  terrainMat.normalMap = normalMap;
  terrainMat.map.repeat.set(10, 10);
  terrainMat.normalMap.repeat.set(10, 10);
  terrainMat.normalScale.set(0.9, 0.9);
  terrainMat.needsUpdate = true;
}

applyTerrainMaterial(seed);

function applyRoadMaterial(seedStr: string) {
  const next = makeCementTexture(seedStr);
  cementMap.dispose();
  cementMap = next;
  sidewalkMat.map = cementMap;
  sidewalkMat.map.repeat.set(6, 6);
  sidewalkMat.needsUpdate = true;
}

applyRoadMaterial(seed);

function updateRoadDebugLabel() {
  const asphaltHex = roadMat.color.getHexString();
  const sidewalkHex = sidewalkMat.color.getHexString();
  const msg = `road asphalt:#${asphaltHex} sidewalk:#${sidewalkHex}`;
  roadDebugEl.textContent = msg;
  // Helpful for DevTools confirmation.
  console.log("[road]", msg);
}

updateRoadDebugLabel();

const chunks = new Map<
  ChunkKey,
  {
    mesh: THREE.Mesh;
    roadMesh?: THREE.Object3D;
    body: CANNON.Body;
    cx: number;
    cz: number;
  }
>();

const pendingChunkBuilds: Array<{ cx: number; cz: number }> = [];
const pendingChunkKeys = new Set<ChunkKey>();
const chunkFadeSeconds = 0.8;
const maxChunkBuildsPerFrame = 2;
let playerChunkCx = 0;
let playerChunkCz = 0;

function enqueueChunkBuild(cx: number, cz: number) {
  const key = keyFor(cx, cz);
  if (chunks.has(key) || pendingChunkKeys.has(key)) return;
  pendingChunkKeys.add(key);
  pendingChunkBuilds.push({ cx, cz });
}

function processChunkBuildQueue(maxBuilds: number) {
  for (let i = 0; i < maxBuilds; i++) {
    const next = pendingChunkBuilds.shift();
    if (!next) return;
    const key = keyFor(next.cx, next.cz);
    pendingChunkKeys.delete(key);

    // Skip stale queued chunks if the player has moved on.
    const r = settings.viewRadiusChunks;
    if (
      Math.abs(next.cx - playerChunkCx) > r + 1 ||
      Math.abs(next.cz - playerChunkCz) > r + 1
    ) {
      continue;
    }
    buildChunk(next.cx, next.cz);
  }
}

function fbm2(x: number, z: number) {
  let amp = 1;
  let freq = settings.frequency;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < settings.octaves; i++) {
    sum += amp * noise2D(x * freq, z * freq);
    norm += amp;
    amp *= settings.gain;
    freq *= settings.lacunarity;
  }
  return sum / Math.max(1e-6, norm);
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function roadCenterX(z: number) {
  // Completely straight road forever.
  void z;
  return 0;
}

function roadMask(x: number, z: number) {
  const dx = Math.abs(x - roadCenterX(z));
  const inner = settings.roadHalfWidth + settings.sidewalkWidth;
  const outer = inner + settings.roadShoulder;
  // 1 on the asphalt+sidewalk, 0 outside the blended shoulder.
  return 1 - smoothstep(inner, outer, dx);
}

function baseHeightAt(x: number, z: number) {
  const n = fbm2(x, z);
  const gentle = fbm2(x * 0.35, z * 0.35);
  return (n * 0.85 + gentle * 0.15) * settings.amplitude;
}

function heightAt(x: number, z: number) {
  const base = baseHeightAt(x, z);

  // Carve a driveable road: perfectly flat cement road with blended shoulders.
  const m = roadMask(x, z);
  if (m <= 0) return base;

  const roadY = settings.roadHeight;
  return THREE.MathUtils.lerp(base, roadY, THREE.MathUtils.clamp(m, 0, 1));
}

function keyFor(cx: number, cz: number): ChunkKey {
  return `${cx},${cz}`;
}

function buildChunk(cx: number, cz: number) {
  const key = keyFor(cx, cz);
  if (chunks.has(key)) return;

  const size = settings.chunkSize;
  const res = settings.resolution;
  const half = size / 2;
  const startX = cx * size;
  const startZ = cz * size;

  // Three.js mesh
  const geo = new THREE.PlaneGeometry(size, size, res, res);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const localX = pos.getX(i);
    const localZ = pos.getZ(i);
    const worldX = localX + startX;
    const worldZ = localZ + startZ;
    pos.setY(i, heightAt(worldX, worldZ));
  }
  geo.computeVertexNormals();

  // Vertex color variation (height + slope + low-frequency noise) to make bumps readable.
  const normals = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const tmpColor = new THREE.Color();
  const asphaltColor = new THREE.Color(0x303030);
  const sidewalkColor = new THREE.Color(0xcfcfcf);
  for (let i = 0; i < pos.count; i++) {
    const localX = pos.getX(i);
    const localZ = pos.getZ(i);
    const worldX = localX + startX;
    const worldZ = localZ + startZ;
    const h = pos.getY(i);
    const nY = normals.getY(i);
    const slope = THREE.MathUtils.clamp(1 - nY, 0, 1);
    const variation = noise2D(worldX * 0.05, worldZ * 0.05) * 0.08;
    const heightTint = (h / Math.max(1e-6, settings.amplitude)) * 0.08;
    const lightness = THREE.MathUtils.clamp(
      0.42 + variation + heightTint - slope * 0.35,
      0.18,
      0.62,
    );
    tmpColor.setHSL(0.32, 0.62, lightness);

    // Tint the immediate road area (asphalt + sidewalk) to make the straightaway readable.
    const dx = Math.abs(worldX - roadCenterX(worldZ));
    if (dx <= settings.roadHalfWidth) {
      tmpColor.copy(asphaltColor);
    } else if (dx <= settings.roadHalfWidth + settings.sidewalkWidth) {
      tmpColor.copy(sidewalkColor);
    }

    colors[i * 3 + 0] = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  // Clone material so we can fade this chunk in smoothly.
  const mat = terrainMat.clone();
  mat.transparent = true;
  mat.opacity = 0;
  const mesh = new THREE.Mesh(geo, mat);
  // Geometry remains local; position the mesh to chunk center.
  mesh.position.set(startX, 0, startZ);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.fadeInStart = performance.now();
  terrainGroup.add(mesh);

  // Road overlay mesh (flat cement ribbon) for visual clarity.
  const chunkMinX = startX - half;
  const chunkMaxX = startX + half;
  const segments = 40;
  const buildRibbon = (
    leftW: number,
    rightW: number,
    material: THREE.Material,
    renderOrder: number,
    extraY: number,
  ) => {
    const leftX = THREE.MathUtils.clamp(leftW, chunkMinX, chunkMaxX);
    const rightX = THREE.MathUtils.clamp(rightW, chunkMinX, chunkMaxX);
    if (rightX <= leftX + 0.01) return undefined;

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const worldZ = startZ - half + t * size;
      const lx = leftX - startX;
      const rx = rightX - startX;
      const lz = worldZ - startZ;
      const y = settings.roadHeight + settings.roadEpsilon + extraY;

      positions.push(lx, y, lz);
      positions.push(rx, y, lz);
      uvs.push(0, t * 6);
      uvs.push(1, t * 6);

      if (i < segments) {
        const base = i * 2;
        // Winding chosen so the ribbon's front face points upward (+Y).
        indices.push(base, base + 2, base + 1);
        indices.push(base + 1, base + 2, base + 3);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = renderOrder;
    return mesh;
  };

  const worldZ0 = startZ;
  const cxRoad0 = roadCenterX(worldZ0);
  const overlap = 0.06; // hide any seams between strips
  const leftAsphaltW0 = cxRoad0 - settings.roadHalfWidth;
  const rightAsphaltW0 = cxRoad0 + settings.roadHalfWidth;
  const leftSidewalkW0 = leftAsphaltW0 - settings.sidewalkWidth;
  const rightSidewalkW1 = rightAsphaltW0 + settings.sidewalkWidth;

  // Let asphalt extend slightly under sidewalks; sidewalks draw on top.
  const asphaltMesh = buildRibbon(
    leftAsphaltW0 - overlap,
    rightAsphaltW0 + overlap,
    roadMat,
    10,
    0.0,
  );
  const leftSidewalkMesh = buildRibbon(
    leftSidewalkW0,
    leftAsphaltW0 + overlap,
    sidewalkMat,
    11,
    0.01,
  );
  const rightSidewalkMesh = buildRibbon(
    rightAsphaltW0 - overlap,
    rightSidewalkW1,
    sidewalkMat,
    11,
    0.01,
  );

  let roadMesh: THREE.Object3D | undefined;
  if (asphaltMesh || leftSidewalkMesh || rightSidewalkMesh) {
    const group = new THREE.Group();
    group.position.set(startX, 0, startZ);
    if (asphaltMesh) group.add(asphaltMesh);
    if (leftSidewalkMesh) group.add(leftSidewalkMesh);
    if (rightSidewalkMesh) group.add(rightSidewalkMesh);
    terrainGroup.add(group);
    roadMesh = group;
  }

  // Cannon heightfield (local coords)
  const samples = res + 1;
  const heights: number[][] = [];
  for (let xi = 0; xi < samples; xi++) {
    const row: number[] = [];
    for (let zi = 0; zi < samples; zi++) {
      const x = startX - half + (xi / res) * size;
      // Cannon Heightfield uses a grid in its local X/Y with height along local Z.
      // We rotate the body so local Z becomes world Y, and local Y maps to -world Z.
      // Use a reversed Z sampling so heights line up with world +Z.
      const z = startZ + half - (zi / res) * size;
      row.push(heightAt(x, z));
    }
    heights.push(row);
  }

  const hf = new CANNON.Heightfield(heights, {
    elementSize: size / res,
  });

  const body = new CANNON.Body({
    mass: 0,
    material: groundMaterial,
  });
  body.addShape(hf);
  // Rotate heightfield so its local Z (height) becomes world Y (up).
  body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  // Place the heightfield so it spans [startX-half..startX+half] in X and [startZ-half..startZ+half] in Z.
  body.position.set(startX - half, 0, startZ + half);
  world.addBody(body);

  chunks.set(key, { mesh, roadMesh, body, cx, cz });
}

function ensureChunksAround(x: number, z: number) {
  const size = settings.chunkSize;
  const cx0 = Math.floor(x / size);
  const cz0 = Math.floor(z / size);
  const r = settings.viewRadiusChunks;

  playerChunkCx = cx0;
  playerChunkCz = cz0;

  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      enqueueChunkBuild(cx0 + dx, cz0 + dz);
    }
  }

  // prune far chunks
  for (const [key, c] of chunks) {
    if (Math.abs(c.cx - cx0) > r + 1 || Math.abs(c.cz - cz0) > r + 1) {
      terrainGroup.remove(c.mesh);
      if (c.roadMesh) {
        terrainGroup.remove(c.roadMesh);
        c.roadMesh.traverse((child) => {
          const mesh = child as THREE.Mesh;
          const geo = (mesh as any).geometry as
            | THREE.BufferGeometry
            | undefined;
          if (geo && typeof geo.dispose === "function") geo.dispose();
        });
      }
      c.mesh.geometry.dispose();
      const m = c.mesh.material as unknown as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else if (m && m !== terrainMat) m.dispose();
      world.removeBody(c.body);
      chunks.delete(key);
    }
  }
}

// ---------- Vehicle (RaycastVehicle) ----------
const vehicleGroup = new THREE.Group();
scene.add(vehicleGroup);

// Match fog/background to the actual sky tint near the horizon.
syncFogToSkyColor([terrainGroup, vehicleGroup]);

const chassisSize = new THREE.Vector3(1.9, 0.7, 3.8);
const chassisShapeOffsetY = 0.35;
const wheelRadius = 0.46;
const chassisMat = new THREE.MeshPhysicalMaterial({
  // Metallic silver paint.
  color: 0xc7cbd1,
  roughness: 0.38,
  metalness: 0.62,
  clearcoat: 0.45,
  clearcoatRoughness: 0.14,
});

// Visual root follows the physics body; meshes hang off this.
const chassisRoot = new THREE.Group();
vehicleGroup.add(chassisRoot);

// SUV visual details (match the reference: modern boxy SUV proportions)
const suvDetail = new THREE.Group();
chassisRoot.add(suvDetail);

// Optional: external OBJ model replacement (served from Vite's /public).
const objVehicleRoot = new THREE.Group();
chassisRoot.add(objVehicleRoot);
objVehicleRoot.visible = false;

// Drop the whole visual shell a bit so it sits on the wheels better.
suvDetail.position.y = -0.18;
// Don't show a placeholder body while the OBJ is loading.
suvDetail.visible = false;

const paintMat = chassisMat;
const claddingMat = new THREE.MeshStandardMaterial({
  color: 0x0f1012,
  roughness: 0.96,
  metalness: 0.02,
});
const trimMat = new THREE.MeshStandardMaterial({
  color: 0x15171a,
  roughness: 0.9,
  metalness: 0.05,
});
const interiorMat = new THREE.MeshStandardMaterial({
  color: 0x141517,
  roughness: 0.98,
  metalness: 0.0,
});
const glassMat = new THREE.MeshPhysicalMaterial({
  color: 0x222b35,
  roughness: 0.04,
  metalness: 0.0,
  transmission: 0.0,
  transparent: true,
  opacity: 0.28,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const lightLensMat = new THREE.MeshStandardMaterial({
  color: 0x101010,
  roughness: 0.25,
  metalness: 0.0,
  emissive: new THREE.Color(0xffcc66),
  emissiveIntensity: 1.2,
});
const rearLensMat = new THREE.MeshStandardMaterial({
  color: 0x101010,
  roughness: 0.25,
  metalness: 0.0,
  emissive: new THREE.Color(0xff3b2f),
  emissiveIntensity: 0.45,
});

// ---- Cohesive body shell (extruded profile with wheel wells) ----
// Wheel well centers in the chassis visual local space.
const wheelRest = 0.38;
// 4" lift (about 0.1016m): raise wheel connection points so the body sits higher.
const liftMeters = 0.1016;
const baseConnYLocal = -chassisSize.y * 0.1 + chassisShapeOffsetY;
const connYLocal = baseConnYLocal + liftMeters;
const wheelWellY = connYLocal - wheelRest + 0.02;
const frontWellZ = chassisSize.z * 0.42;
// Rear axle was sitting too far back under the OBJ body; pull it forward a bit.
const rearWellZ = -chassisSize.z * 0.28;

// Load the user-provided Chevy Suburban OBJ/MTL and swap it in as the vehicle shell.
// Keeps the physics and existing wheel meshes; tries to hide any wheels that are part of the OBJ.
const modelBaseUrl = `${import.meta.env.BASE_URL}models/chevy-suburban/`;
void loadObjWithMtl(
  modelBaseUrl,
  "chevy_suburban.obj",
  "chevy_suburban.mtl",
)
  .then((obj) => {
    setModelShadowsAndColorSpace(obj);
    sanitizeObjMaterials(obj);

    const hideRe = /(wheel|tire|tyre|rim|brake|rotor)/i;
    obj.traverse((o) => {
      const name = (o.name || "").toLowerCase();
      if (hideRe.test(name)) o.visible = false;
      const mesh = o as THREE.Mesh;
      if ((mesh as any).isMesh) {
        const mat = mesh.material as any;
        const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
        for (const m of mats) {
          const mName = (m?.name || "").toLowerCase();
          if (hideRe.test(mName)) mesh.visible = false;
        }
      }
    });

    // Extract wheel templates from the OBJ and use them for our physics wheels.
    // (The shell's own wheels are hidden above to avoid duplicates.)
    const wheelTemplates = extractWheelTemplatesFromObj(
      obj,
      wheelRadius,
      wheelWidth,
    );
    const hasAll4 =
      (wheelTemplates as any)[0] &&
      (wheelTemplates as any)[1] &&
      (wheelTemplates as any)[2] &&
      (wheelTemplates as any)[3];
    if (hasAll4) {
      for (const k of Object.keys(wheelTemplates)) {
        const tpl = (wheelTemplates as any)[k] as THREE.Object3D | undefined;
        if (!tpl) continue;
        sanitizeObjMaterials(tpl);
        setModelShadowsAndColorSpace(tpl);
      }
      applyWheelTemplatesToVehicle(wheelTemplates);
      console.log("[vehicle] using OBJ wheel templates (all 4)");
    } else {
      console.warn(
        "[vehicle] OBJ wheel extraction incomplete; using procedural cylinder wheels",
      );
    }

    const targetLengthZ = chassisSize.z * 1.22;
    const restGroundYLocal = connYLocal - wheelRest - wheelRadius;
    fitCenterAndPlaceOnRestGroundY(
      obj,
      targetLengthZ,
      restGroundYLocal,
      Math.PI,
    );

    objVehicleRoot.clear();
    objVehicleRoot.add(obj);
    objVehicleRoot.visible = true;
    suvDetail.visible = false;

    // Wheel track: move wheels inward so the tire sticks out ~1" past the body.
    // This uses the loaded OBJ's width (after scaling) for a good fit.
    try {
      const box = new THREE.Box3().setFromObject(obj);
      const size = new THREE.Vector3();
      box.getSize(size);
      const bodyHalfX = Math.max(0.2, size.x * 0.5);
      const protrusion = 0.0254; // 1 inch
      const wheelHalfWidth = wheelWidth * 0.5;
      const targetCenterX = Math.max(
        0.25,
        bodyHalfX - wheelHalfWidth + protrusion,
      );
      if (typeof vehicle !== "undefined" && vehicle?.wheelInfos?.length >= 4) {
        vehicle.wheelInfos[0].chassisConnectionPointLocal.x = -targetCenterX;
        vehicle.wheelInfos[1].chassisConnectionPointLocal.x = targetCenterX;
        vehicle.wheelInfos[2].chassisConnectionPointLocal.x = -targetCenterX;
        vehicle.wheelInfos[3].chassisConnectionPointLocal.x = targetCenterX;
        console.log("[vehicle] track set from OBJ width", {
          bodyHalfX,
          targetCenterX,
        });
      } else {
        (vehicleGroup.userData as any).pendingTrackCenterX = targetCenterX;
      }
    } catch {
      // ignore
    }
    console.log("[vehicle] loaded OBJ model: chevy_suburban");
  })
  .catch((err) => {
    console.warn(
      "[vehicle] failed to load OBJ model; using procedural SUV shell",
      err,
    );
    suvDetail.visible = true;
  });

function bendPlaneZ(geo: THREE.BufferGeometry, bend: number) {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i);
    const t = tmp.x;
    tmp.z += t * t * bend;
    pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

function makeBodyShape(bodyLen: number, yMin: number, yMax: number) {
  const zMin = -bodyLen / 2;
  const zMax = bodyLen / 2;
  const s = new THREE.Shape();
  // Bottom edge + front/rear tapers to avoid the “brick” look.
  s.moveTo(zMin + 0.08, yMin);
  s.lineTo(zMax - 0.22, yMin);
  s.quadraticCurveTo(zMax - 0.06, yMin, zMax, yMin + 0.14);
  s.lineTo(zMax - 0.22, yMax - 0.08);
  s.quadraticCurveTo(zMax - 0.3, yMax, zMax - 0.62, yMax);
  s.lineTo(zMin + 0.5, yMax);
  s.quadraticCurveTo(zMin + 0.15, yMax, zMin, yMax - 0.14);
  s.lineTo(zMin, yMin + 0.18);
  s.quadraticCurveTo(zMin, yMin, zMin + 0.08, yMin);

  const archR = wheelRadius + 0.14;
  const archF = new THREE.Path();
  archF.absellipse(
    frontWellZ,
    wheelWellY,
    archR,
    archR * 0.92,
    0,
    Math.PI * 2,
    false,
    0,
  );
  s.holes.push(archF);
  const archRr = new THREE.Path();
  archRr.absellipse(
    rearWellZ,
    wheelWellY,
    archR,
    archR * 0.92,
    0,
    Math.PI * 2,
    false,
    0,
  );
  s.holes.push(archRr);

  return s;
}

const bodyW = chassisSize.x * 1.18;
const bodyL = chassisSize.z * 1.22;
const bodyYMin = wheelWellY - wheelRadius - 0.18;
const bodyYMax = wheelWellY + 0.58;

const bodyShape = makeBodyShape(bodyL, bodyYMin, bodyYMax);
const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, {
  depth: bodyW,
  bevelEnabled: true,
  bevelSize: 0.045,
  bevelThickness: 0.045,
  bevelSegments: 2,
  curveSegments: 24,
  steps: 1,
});
bodyGeo.translate(0, 0, -bodyW / 2);
bodyGeo.rotateY(-Math.PI / 2);
bodyGeo.computeVertexNormals();

const bodyMesh = new THREE.Mesh(bodyGeo, paintMat);
bodyMesh.castShadow = true;
bodyMesh.receiveShadow = false;
suvDetail.add(bodyMesh);

// Lower cladding as a slightly inset duplicate
const cladGeo = bodyGeo.clone();
const cladMesh = new THREE.Mesh(cladGeo, claddingMat);
cladMesh.scale.set(0.995, 0.86, 0.99);
cladMesh.position.y = bodyYMin + (bodyYMax - bodyYMin) * 0.28;
cladMesh.castShadow = true;
suvDetail.add(cladMesh);

// Greenhouse (upper cabin) as a second extrude to avoid “two boxes”
const cabinW = bodyW * 0.82;
const cabinL = chassisSize.z * 0.86;
const cabinYMin = bodyYMax - 0.02;
const cabinYMax = cabinYMin + 0.58;
const cabinShape = (() => {
  const zMin = -cabinL / 2;
  const zMax = cabinL / 2;
  const s = new THREE.Shape();
  s.moveTo(zMin + 0.1, cabinYMin);
  s.lineTo(zMax - 0.18, cabinYMin);
  s.quadraticCurveTo(zMax, cabinYMin, zMax, cabinYMin + 0.14);
  s.lineTo(zMax - 0.22, cabinYMax - 0.06);
  s.quadraticCurveTo(zMax - 0.32, cabinYMax, zMax - 0.52, cabinYMax);
  s.lineTo(zMin + 0.42, cabinYMax);
  s.quadraticCurveTo(zMin + 0.15, cabinYMax, zMin, cabinYMax - 0.14);
  s.lineTo(zMin, cabinYMin + 0.2);
  s.quadraticCurveTo(zMin, cabinYMin, zMin + 0.1, cabinYMin);
  return s;
})();

const cabinGeo = new THREE.ExtrudeGeometry(cabinShape, {
  depth: cabinW,
  bevelEnabled: true,
  bevelSize: 0.04,
  bevelThickness: 0.04,
  bevelSegments: 2,
  curveSegments: 24,
  steps: 1,
});
cabinGeo.translate(0, 0, -cabinW / 2);
cabinGeo.rotateY(-Math.PI / 2);
cabinGeo.computeVertexNormals();

const cabinMesh = new THREE.Mesh(cabinGeo, paintMat);
cabinMesh.castShadow = true;
suvDetail.add(cabinMesh);

// Curved windshield glass (bent plane)
const windshieldGeo = new THREE.PlaneGeometry(cabinW * 0.86, 0.54, 18, 8);
bendPlaneZ(windshieldGeo, 0.085);
const windshield = new THREE.Mesh(windshieldGeo, glassMat);
windshield.position.set(0, cabinYMin + 0.28, cabinL / 2 + 0.03);
windshield.rotation.x = -0.62;
windshield.renderOrder = 10;
suvDetail.add(windshield);

// Side windows (simple panes) + rear window
const eps = 0.014;
const sideWinH = 0.34;
const sideWinL = cabinL * 0.34;
const sideWinY = cabinYMin + 0.28;
for (const sx of [-1, 1]) {
  const lf = new THREE.Mesh(
    new THREE.PlaneGeometry(sideWinL, sideWinH),
    glassMat,
  );
  lf.position.set(sx * (cabinW / 2 + eps), sideWinY, cabinL * 0.16);
  lf.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
  lf.renderOrder = 10;
  suvDetail.add(lf);

  const lr = new THREE.Mesh(
    new THREE.PlaneGeometry(sideWinL, sideWinH),
    glassMat,
  );
  lr.position.set(sx * (cabinW / 2 + eps), sideWinY, -cabinL * 0.16);
  lr.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
  lr.renderOrder = 10;
  suvDetail.add(lr);
}

const rearWin = new THREE.Mesh(
  new THREE.PlaneGeometry(cabinW * 0.82, 0.38),
  glassMat,
);
rearWin.position.set(0, cabinYMin + 0.28, -cabinL / 2 - 0.03);
rearWin.rotation.y = Math.PI;
rearWin.renderOrder = 10;
suvDetail.add(rearWin);

// Roof rack
const roofY = cabinYMax + 0.03;
const railGeo = new RoundedBoxGeometry(0.08, 0.05, cabinL * 0.92, 4, 0.02);
const railX = cabinW * 0.42;
const leftRail = new THREE.Mesh(railGeo, trimMat);
leftRail.position.set(-railX, roofY, 0);
leftRail.castShadow = true;
const rightRail = leftRail.clone();
rightRail.position.x = railX;
suvDetail.add(leftRail, rightRail);

const crossGeo = new RoundedBoxGeometry(cabinW * 0.92, 0.04, 0.08, 4, 0.02);
for (const z of [cabinL * 0.26, -cabinL * 0.06]) {
  const cross = new THREE.Mesh(crossGeo, trimMat);
  cross.position.set(0, roofY + 0.03, z);
  cross.castShadow = true;
  suvDetail.add(cross);
}

// Lights
const headGeo = new RoundedBoxGeometry(0.22, 0.1, 0.03, 3, 0.01);
for (const sx of [-1, 1]) {
  const head = new THREE.Mesh(headGeo, lightLensMat);
  head.position.set(sx * (bodyW * 0.32), wheelWellY + 0.05, bodyL / 2 + 0.02);
  head.renderOrder = 11;
  suvDetail.add(head);
}
const tailGeo = new RoundedBoxGeometry(0.12, 0.14, 0.03, 3, 0.01);
for (const sx of [-1, 1]) {
  const tail = new THREE.Mesh(tailGeo, rearLensMat);
  tail.position.set(sx * (bodyW * 0.46), wheelWellY + 0.1, -bodyL / 2 - 0.02);
  tail.rotation.y = Math.PI;
  tail.renderOrder = 11;
  suvDetail.add(tail);
}

// Interior (dark volume so windows read correctly)
const interiorGeo = new RoundedBoxGeometry(
  cabinW * 0.94,
  0.44,
  cabinL * 0.92,
  5,
  0.06,
);
const interior = new THREE.Mesh(interiorGeo, interiorMat);
interior.position.set(0, cabinYMin + 0.18, 0);
suvDetail.add(interior);

// Spare tire mount point (tire itself added later once wheel geometry exists)
const spareMount = new THREE.Group();
spareMount.position.set(
  bodyW * 0.5 + 0.06,
  wheelWellY + 0.18,
  -bodyL / 2 + 0.25,
);
spareMount.rotation.y = -Math.PI / 2;
suvDetail.add(spareMount);

const chassisShape = new CANNON.Box(
  new CANNON.Vec3(chassisSize.x / 2, chassisSize.y / 2, chassisSize.z / 2),
);
const chassisBody = new CANNON.Body({
  mass: 240,
  material: tireMaterial,
  angularDamping: 0.4,
  linearDamping: 0.06,
});

// Lower center of mass by raising collision geometry relative to body origin.
chassisBody.addShape(chassisShape, new CANNON.Vec3(0, chassisShapeOffsetY, 0));

function placeVehicle(x: number, z: number) {
  chassisBody.velocity.set(0, 0, 0);
  chassisBody.angularVelocity.set(0, 0, 0);
  chassisBody.quaternion.set(0, 0, 0, 1);
  chassisBody.position.set(x, heightAt(x, z) + 4.5, z);
}

placeVehicle(0, 0);
world.addBody(chassisBody);

const vehicle = new CANNON.RaycastVehicle({
  chassisBody,
  indexRightAxis: 0,
  indexUpAxis: 1,
  indexForwardAxis: 2,
});

const wheelWidth = 0.28;

// Tire: hollow cylinder with 16" inner hole (sidewalls included)
const innerRadius = wheelRadius * 0.55; // 16" diameter hole
const tireProfile: THREE.Vector2[] = [];
// Create profile in correct winding order for outward-facing normals
tireProfile.push(new THREE.Vector2(innerRadius, -wheelWidth / 2));
tireProfile.push(new THREE.Vector2(wheelRadius, -wheelWidth / 2));
tireProfile.push(new THREE.Vector2(wheelRadius, wheelWidth / 2));
tireProfile.push(new THREE.Vector2(innerRadius, wheelWidth / 2));
const tireGeo = new THREE.LatheGeometry(tireProfile, 32);
tireGeo.rotateX(Math.PI / 2);
tireGeo.rotateY(Math.PI / 2);
const tireMat = new THREE.MeshStandardMaterial({
  color: 0x0a0a0a,
  roughness: 0.95,
  metalness: 0.0,
  side: THREE.DoubleSide,
});

// Rim: chrome 5-spoke wheel
function make5SpokeRim(radius: number, width: number): THREE.Group {
  const rimGroup = new THREE.Group();
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xd4d4d4,
    roughness: 0.18,
    metalness: 0.92,
    envMapIntensity: 1.2,
  });

  // Center hub
  const hubGeo = new THREE.CylinderGeometry(
    radius * 0.22,
    radius * 0.22,
    width * 0.85,
    16,
  );
  hubGeo.rotateZ(Math.PI / 2);
  const hub = new THREE.Mesh(hubGeo, chromeMat);
  hub.castShadow = true;
  rimGroup.add(hub);

  // 5 spokes
  const spokeGeo = new THREE.BoxGeometry(
    radius * 0.65,
    width * 0.4,
    radius * 0.12,
  );
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(spokeGeo, chromeMat);
    spoke.castShadow = true;
    const angle = (i / 5) * Math.PI * 2;
    spoke.position.set(0, 0, Math.cos(angle) * radius * 0.38);
    spoke.position.y = Math.sin(angle) * radius * 0.38;
    spoke.rotation.x = angle;
    rimGroup.add(spoke);
  }

  return rimGroup;
}

const rimTemplate = make5SpokeRim(wheelRadius, wheelWidth);

const wheelMeshes: THREE.Object3D[] = [];
const proceduralWheelVisuals: THREE.Object3D[] = [];

// Wheel render interpolation state (prev/current -> interpolated each frame)
const prevWheelPos: THREE.Vector3[] = [];
const prevWheelQuat: THREE.Quaternion[] = [];
const currWheelPos: THREE.Vector3[] = [];
const currWheelQuat: THREE.Quaternion[] = [];
const wheelRenderPos: THREE.Vector3[] = [];
const wheelRenderQuat: THREE.Quaternion[] = [];

function initWheelInterpolation() {
  for (let i = 0; i < vehicle.wheelInfos.length; i++) {
    vehicle.updateWheelTransform(i);
    const t = vehicle.wheelInfos[i].worldTransform;
    const p = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
    const q = new THREE.Quaternion(
      t.quaternion.x,
      t.quaternion.y,
      t.quaternion.z,
      t.quaternion.w,
    );
    prevWheelPos[i] = p.clone();
    currWheelPos[i] = p.clone();
    wheelRenderPos[i] = p.clone();
    prevWheelQuat[i] = q.clone();
    currWheelQuat[i] = q.clone();
    wheelRenderQuat[i] = q.clone();
  }
}

function updateInterpolatedWheels(alpha: number) {
  const a = THREE.MathUtils.clamp(alpha, 0, 1);
  for (let i = 0; i < wheelMeshes.length; i++) {
    wheelRenderPos[i].copy(prevWheelPos[i]).lerp(currWheelPos[i], a);
    wheelRenderQuat[i].copy(prevWheelQuat[i]).slerp(currWheelQuat[i], a);
  }
}

const wheelOptions: CANNON.WheelInfoOptions = {
  radius: wheelRadius,
  directionLocal: new CANNON.Vec3(0, -1, 0),
  suspensionStiffness: 48,
  suspensionRestLength: 0.38,
  frictionSlip: 3.2,
  dampingRelaxation: 3.2,
  dampingCompression: 4.4,
  maxSuspensionForce: 120000,
  rollInfluence: 0.03,
  axleLocal: new CANNON.Vec3(-1, 0, 0),
  chassisConnectionPointLocal: new CANNON.Vec3(),
  maxSuspensionTravel: 0.35,
};

// Initial half-track; may be overridden once the OBJ body width is known.
let halfW = chassisSize.x * 0.52;
const frontZ = chassisSize.z * 0.42;
// Keep physics axle position consistent with the visual wheel-well reference.
const rearZ = -chassisSize.z * 0.28;
const connY = baseConnYLocal + liftMeters;

const wheelPoints: Array<[number, number, number]> = [
  // front-left, front-right, rear-left, rear-right
  [-halfW, connY, frontZ],
  [halfW, connY, frontZ],
  [-halfW, connY, rearZ],
  [halfW, connY, rearZ],
];

for (const [x, y, z] of wheelPoints) {
  vehicle.addWheel({
    ...wheelOptions,
    chassisConnectionPointLocal: new CANNON.Vec3(x, y, z),
  });

  const wheelRoot = new THREE.Group();

  // Build procedural wheel with tire + 5-spoke rim
  const tire = new THREE.Mesh(tireGeo, tireMat);
  tire.castShadow = true;
  tire.receiveShadow = false;

  const rim = rimTemplate.clone(true);
  tire.add(rim);

  wheelRoot.add(tire);
  wheelMeshes.push(wheelRoot);
  proceduralWheelVisuals.push(tire);
  vehicleGroup.add(wheelRoot);
}

(vehicleGroup.userData as any).wheelRoots = wheelMeshes;
(vehicleGroup.userData as any).proceduralWheelVisuals = proceduralWheelVisuals;

// Apply pending track adjustment computed during OBJ load (if it finished early).
const pendingTrackCenterX = (vehicleGroup.userData as any)
  .pendingTrackCenterX as number | undefined;
if (
  pendingTrackCenterX !== undefined &&
  Number.isFinite(pendingTrackCenterX) &&
  vehicle.wheelInfos.length >= 4
) {
  vehicle.wheelInfos[0].chassisConnectionPointLocal.x = -pendingTrackCenterX;
  vehicle.wheelInfos[1].chassisConnectionPointLocal.x = pendingTrackCenterX;
  vehicle.wheelInfos[2].chassisConnectionPointLocal.x = -pendingTrackCenterX;
  vehicle.wheelInfos[3].chassisConnectionPointLocal.x = pendingTrackCenterX;
  delete (vehicleGroup.userData as any).pendingTrackCenterX;
}

const pendingTemplates = (vehicleGroup.userData as any)
  .pendingWheelTemplates as Partial<Record<number, THREE.Object3D>> | undefined;
if (pendingTemplates) {
  applyWheelTemplatesToVehicle(pendingTemplates as any);
  delete (vehicleGroup.userData as any).pendingWheelTemplates;
}

// Rear-mounted spare tire
if (typeof spareMount !== "undefined" && spareMount) {
  const spareTire = new THREE.Mesh(tireGeo, tireMat);
  spareTire.castShadow = true;
  const spareRim = rimTemplate.clone(true);
  spareTire.add(spareRim);

  // Slightly smaller and tucked in.
  spareTire.scale.setScalar(0.92);
  spareMount.add(spareTire);
}

vehicle.addToWorld(world);

initWheelInterpolation();

// ---------- Controls ----------
const keys = {
  w: false,
  a: false,
  s: false,
  d: false,
  space: false,
};

let throttle = 0;

// 5-speed automatic (sound model; not a full drivetrain simulation)
const drivetrain = {
  gear: 1,
  isShifting: false,
  shiftTimer: 0,
  finalDrive: 2.9,
  gearRatios: [0, 3.06, 1.78, 1.19, 0.86, 0.68],
  idleRpm: 650,
  redlineRpm: 4200,
  upshiftRpm: 3200,
  downshiftRpm: 1050,
};

function resetDrivetrain() {
  drivetrain.gear = 1;
  drivetrain.isShifting = false;
  drivetrain.shiftTimer = 0;
}

class V8EngineAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineBus: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private exhaustGain: GainNode | null = null;
  private lp: BiquadFilterNode | null = null;
  private hp: BiquadFilterNode | null = null;
  private lowShelf: BiquadFilterNode | null = null;
  private bodyBp: BiquadFilterNode | null = null;
  private bodyBp2: BiquadFilterNode | null = null;
  private drive: WaveShaperNode | null = null;
  private comp: DynamicsCompressorNode | null = null;
  private noiseSrc: AudioBufferSourceNode | null = null;
  private exhaustGate: GainNode | null = null;
  private pulseShaper: WaveShaperNode | null = null;
  private pulseGain: GainNode | null = null;
  private windSrc: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windHp: BiquadFilterNode | null = null;
  private windLp: BiquadFilterNode | null = null;
  private oscA: OscillatorNode | null = null;
  private oscB: OscillatorNode | null = null;
  private oscC: OscillatorNode | null = null;
  private oscSub: OscillatorNode | null = null;
  private subGain: GainNode | null = null;
  private started = false;
  private wobblePhase = 0;
  private jitter = 0;
  private jitterTarget = 0;
  private jitterTimer = 0;

  start() {
    if (this.started) return;
    this.started = true;
    this.ctx = new AudioContext();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(ctx.destination);

    // Separate bus so we can control engine volume without touching wind.
    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 1.0;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0;

    this.exhaustGain = ctx.createGain();
    this.exhaustGain.gain.value = 0.0;

    this.lp = ctx.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.frequency.value = 380;
    this.lp.Q.value = 0.75;

    this.hp = ctx.createBiquadFilter();
    this.hp.type = "highpass";
    this.hp.frequency.value = 22;
    this.hp.Q.value = 0.7;

    this.lowShelf = ctx.createBiquadFilter();
    this.lowShelf.type = "lowshelf";
    this.lowShelf.frequency.value = 95;
    this.lowShelf.gain.value = 11;

    // "Engine body" resonances: adds throat/boom without buzzy harmonics.
    this.bodyBp = ctx.createBiquadFilter();
    this.bodyBp.type = "bandpass";
    this.bodyBp.frequency.value = 120;
    this.bodyBp.Q.value = 0.95;

    this.bodyBp2 = ctx.createBiquadFilter();
    this.bodyBp2.type = "bandpass";
    this.bodyBp2.frequency.value = 240;
    this.bodyBp2.Q.value = 0.8;

    this.drive = ctx.createWaveShaper();
    this.drive.oversample = "4x";
    const makeCurve = (amount: number) => {
      const n = 1024;
      const curve = new Float32Array(n);
      const k = typeof amount === "number" ? amount : 30;
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
      }
      return curve;
    };
    this.drive.curve = makeCurve(28);

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.knee.value = 22;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.12;

    // Oscillators: sine-based rumble (less "8-bit" than square/triangle).
    // oscB is used as a pulse driver (not audible directly).
    this.oscA = ctx.createOscillator();
    this.oscA.type = "sine";
    this.oscC = ctx.createOscillator();
    this.oscC.type = "sine";
    this.oscSub = ctx.createOscillator();
    this.oscSub.type = "sine";
    this.oscB = ctx.createOscillator();
    this.oscB.type = "sawtooth";

    const rumbleMix = ctx.createGain();
    rumbleMix.gain.value = 0.28;

    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.22;

    this.oscA.connect(rumbleMix);
    this.oscC.connect(rumbleMix);
    rumbleMix.connect(this.engineGain);

    this.oscSub.connect(this.subGain);
    this.subGain.connect(this.engineGain);

    // Exhaust-ish noise
    const noiseBuffer = ctx.createBuffer(
      1,
      Math.floor(ctx.sampleRate * 2.0),
      ctx.sampleRate,
    );
    const ch = noiseBuffer.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.7;

    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = noiseBuffer;
    this.noiseSrc.loop = true;

    const noiseBp = ctx.createBiquadFilter();
    noiseBp.type = "bandpass";
    noiseBp.frequency.value = 85;
    noiseBp.Q.value = 1.2;

    // Gate the exhaust noise with a pulse train at firing frequency.
    this.exhaustGate = ctx.createGain();
    this.exhaustGate.gain.value = 0.0;

    this.pulseShaper = ctx.createWaveShaper();
    this.pulseShaper.oversample = "4x";
    const pulseCurve = (() => {
      const n = 2048;
      const curve = new Float32Array(n);
      const thr = 0.86;
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        // sawtooth near +1 -> short pulse
        const v = x > thr ? (x - thr) / (1 - thr) : 0;
        curve[i] = Math.pow(v, 2.2);
      }
      return curve;
    })();
    this.pulseShaper.curve = pulseCurve;

    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 0.0;

    this.oscB.connect(this.pulseShaper);
    this.pulseShaper.connect(this.pulseGain);
    this.pulseGain.connect(this.exhaustGate.gain);

    this.noiseSrc.connect(noiseBp);
    noiseBp.connect(this.exhaustGate);
    this.exhaustGate.connect(this.exhaustGain);

    // Wind noise layer (separate filters + gain; goes to master)
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = noiseBuffer;
    this.windSrc.loop = true;

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.0;

    this.windHp = ctx.createBiquadFilter();
    this.windHp.type = "highpass";
    this.windHp.frequency.value = 120;
    this.windHp.Q.value = 0.7;

    this.windLp = ctx.createBiquadFilter();
    this.windLp.type = "lowpass";
    this.windLp.frequency.value = 1200;
    this.windLp.Q.value = 0.6;

    this.windSrc.connect(this.windHp);
    this.windHp.connect(this.windLp);
    this.windLp.connect(this.windGain);
    this.windGain.connect(this.master);

    this.engineGain.connect(this.lp);
    this.exhaustGain.connect(this.lp);
    this.lp.connect(this.hp);
    this.hp.connect(this.bodyBp);
    this.bodyBp.connect(this.bodyBp2);
    this.bodyBp2.connect(this.lowShelf);
    this.lowShelf.connect(this.drive);
    this.drive.connect(this.comp);
    this.comp.connect(this.engineBus);
    this.engineBus.connect(this.master);

    this.oscA.start();
    this.oscB.start();
    this.oscC.start();
    this.oscSub.start();
    this.noiseSrc.start();
    this.windSrc.start();
  }

  resumeIfNeeded() {
    if (!this.ctx) return;
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  update(
    params: { rpm: number; throttle: number; shifting: boolean },
    dt: number,
    wind?: { speedMps: number; enabled: boolean; volume: number },
    engine?: { volume: number },
  ) {
    if (
      !this.ctx ||
      !this.engineGain ||
      !this.exhaustGain ||
      !this.lp ||
      !this.exhaustGate ||
      !this.pulseGain ||
      !this.engineBus
    )
      return;
    const ctx = this.ctx;

    // Engine volume control (independent of wind).
    const t0 = ctx.currentTime;
    const vol = THREE.MathUtils.clamp(engine?.volume ?? 0.75, 0, 1.5);
    this.engineBus.gain.setTargetAtTime(vol, t0, 0.08);

    const rpm = Math.max(0, params.rpm);
    const thr = THREE.MathUtils.clamp(params.throttle, 0, 1);
    const shifting = params.shifting;

    // V8 4-stroke: 4 firing events per crank revolution.
    const fireHz = (rpm / 60) * 4;
    // Add subtle random wobble so it feels like an older, less-perfect big-block.
    this.jitterTimer -= dt;
    if (this.jitterTimer <= 0) {
      // Update jitter target more often at idle, slightly smoother at high RPM.
      const rate = THREE.MathUtils.clamp(1.6 - rpm / 6000, 0.55, 1.6);
      this.jitterTimer = THREE.MathUtils.lerp(0.04, 0.22, Math.random()) * rate;
      this.jitterTarget = Math.random() * 2 - 1;
    }
    const jitterFollow = 1 - Math.exp(-dt * 8.0);
    this.jitter = THREE.MathUtils.lerp(
      this.jitter,
      this.jitterTarget,
      jitterFollow,
    );
    const lowRpm01 = THREE.MathUtils.clamp((1200 - rpm) / 900, 0, 1);
    const jitterPct =
      this.jitter *
      (0.006 + 0.014 * thr) *
      (0.5 + 0.9 * lowRpm01 + 0.3 * (rpm / 4200));

    const baseHz = Math.max(15, fireHz * (1 + jitterPct));

    const t = ctx.currentTime;
    const shiftDip = shifting ? 0.22 : 1.0;
    const baseLoud = (0.12 + 0.55 * thr) * shiftDip;
    const baseExhaust = (0.22 + 0.95 * thr) * shiftDip;

    // Throaty low RPM emphasis; less fizz at high RPM.
    const rumbleBoost = 1.0 + lowRpm01 * 0.65;
    this.engineGain.gain.setTargetAtTime(
      baseLoud * 0.85 * rumbleBoost,
      t,
      0.04,
    );
    this.exhaustGain.gain.setTargetAtTime(baseExhaust * 0.55, t, 0.06);

    // Gate strength = perceived "pops" (more at low RPM, less at high).
    const pop = (0.22 + 0.68 * thr) * (1.15 - 0.35 * (rpm / 4200));
    this.pulseGain.gain.setTargetAtTime(pop, t, 0.05);

    // Filter opens up with RPM + throttle, but keep it dark for a big-block.
    const lpHz = THREE.MathUtils.clamp(
      160 + rpm * 0.105 + thr * 420,
      140,
      1200,
    );
    this.lp.frequency.setTargetAtTime(lpHz, t, 0.05);

    // Body resonances track RPM slightly.
    this.bodyBp?.frequency.setTargetAtTime(
      THREE.MathUtils.clamp(92 + rpm * 0.03, 85, 210),
      t,
      0.06,
    );
    this.bodyBp2?.frequency.setTargetAtTime(
      THREE.MathUtils.clamp(200 + rpm * 0.04, 160, 420),
      t,
      0.06,
    );

    // Rumble oscillators (subharmonics of firing frequency).
    const rumbleHz = Math.max(18, baseHz * 0.5);
    const harmonicHz = Math.max(22, baseHz * 0.75);
    const subHz = Math.max(10, baseHz * 0.25);
    this.oscA?.frequency.setTargetAtTime(rumbleHz, t, 0.03);
    this.oscC?.frequency.setTargetAtTime(harmonicHz, t, 0.03);
    this.oscSub?.frequency.setTargetAtTime(subHz, t, 0.03);

    // Pulse driver
    this.oscB?.frequency.setTargetAtTime(baseHz, t, 0.02);

    // Irregularity: lumpy idle + cammy wobble, stronger at low RPM.
    this.wobblePhase += dt;
    const cam =
      Math.sin(this.wobblePhase * (3.1 + thr * 1.7)) * (18 * lowRpm01);
    const detuneJitter = this.jitter * (28 * (0.5 + lowRpm01));
    this.oscA?.detune.setTargetAtTime(cam + detuneJitter, t, 0.09);
    this.oscC?.detune.setTargetAtTime(detuneJitter * 0.6, t, 0.09);
    this.oscB?.detune.setTargetAtTime(detuneJitter * 0.9, t, 0.07);

    // Wind: loudness + brightness ramps with speed
    if (this.windGain && this.windHp && this.windLp) {
      const enabled = wind?.enabled ?? true;
      const volume = THREE.MathUtils.clamp(wind?.volume ?? 0.55, 0, 1.5);
      const speed = Math.max(0, wind?.speedMps ?? 0);
      // Start being audible at ~10 mph; approach full around ~90 mph.
      const wind01 = THREE.MathUtils.clamp((speed - 4.5) / 36.0, 0, 1);
      const shaped = Math.pow(wind01, 1.35);
      // slight gusting so it doesn't feel static
      const gust = 0.85 + 0.15 * Math.sin(this.wobblePhase * 0.7);
      const targetGain = enabled ? shaped * 0.42 * volume * gust : 0.0;
      this.windGain.gain.setTargetAtTime(targetGain, t, 0.08);

      const hpHz = 80 + shaped * 420;
      const lpHz = 900 + shaped * 3200;
      this.windHp.frequency.setTargetAtTime(hpHz, t, 0.08);
      this.windLp.frequency.setTargetAtTime(lpHz, t, 0.08);
    }
  }
}

const engineAudio = new V8EngineAudio();

function downloadScreenshot() {
  try {
    const dataUrl = renderer.domElement.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `openevt_${seed.slice(0, 10)}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    console.log("[screenshot] downloaded");
  } catch (err) {
    console.warn("[screenshot] failed", err);
  }
}

window.addEventListener("keydown", (e) => {
  if (e.code === "KeyW") keys.w = true;
  if (e.code === "KeyA") keys.a = true;
  if (e.code === "KeyS") keys.s = true;
  if (e.code === "KeyD") keys.d = true;
  if (e.code === "Space") keys.space = true;
  if (e.code === "KeyP") downloadScreenshot();
  if (e.code === "KeyB") {
    // Rebuild chunks/road meshes using the same seed (useful after tuning visuals).
    reseedTerrain(seed);
    ensureChunksAround(chassisBody.position.x, chassisBody.position.z);
  }
  if (e.code === "KeyR") {
    // Full reset: new terrain seed + respawn vehicle.
    reseedTerrain();
    placeVehicle(0, 0);
    resetDrivetrain();
    ensureChunksAround(0, 0);
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "KeyW") keys.w = false;
  if (e.code === "KeyA") keys.a = false;
  if (e.code === "KeyS") keys.s = false;
  if (e.code === "KeyD") keys.d = false;
  if (e.code === "Space") keys.space = false;
});

const control = {
  maxSteer: 0.42,
  maxForce: 1500,
  brakeForce: 22,
};

function updateDrive() {
  // reset controls
  for (let i = 0; i < vehicle.wheelInfos.length; i++) {
    vehicle.setBrake(0, i);
    vehicle.applyEngineForce(0, i);
  }

  // Steering sign depends on RaycastVehicle convention; map A->left, D->right.
  const steer = (keys.a ? 1 : 0) + (keys.d ? -1 : 0);
  const speed = chassisBody.velocity.length();
  const steerScale = THREE.MathUtils.clamp(1 - speed / 28, 0.35, 1);
  const steerValue = steer * control.maxSteer * steerScale;

  vehicle.setSteeringValue(steerValue, 0);
  vehicle.setSteeringValue(steerValue, 1);

  const forward = keys.w ? 1 : 0;
  const reverse = keys.s ? 1 : 0;

  const braking = keys.space;
  throttle =
    !braking && forward && !reverse
      ? 1
      : !braking && reverse && !forward
        ? 0.55
        : 0;

  if (braking) {
    // Brake all wheels; keep engine force at zero.
    for (let i = 0; i < vehicle.wheelInfos.length; i++) {
      vehicle.setBrake(control.brakeForce, i);
      vehicle.applyEngineForce(0, i);
    }
    return;
  }

  if (forward && !reverse) {
    const force = -control.maxForce;
    vehicle.applyEngineForce(force, 2);
    vehicle.applyEngineForce(force, 3);
  } else if (reverse && !forward) {
    const force = control.maxForce * 0.65;
    vehicle.applyEngineForce(force, 2);
    vehicle.applyEngineForce(force, 3);
  }
  // When coasting, let wheels roll freely (no brake, no engine force)
}

const tmpFwd = new CANNON.Vec3(0, 0, 1);
const tmpFwdW = new CANNON.Vec3(0, 0, 1);
function signedForwardSpeed() {
  chassisBody.quaternion.vmult(tmpFwd, tmpFwdW);
  const v = chassisBody.velocity;
  return v.x * tmpFwdW.x + v.y * tmpFwdW.y + v.z * tmpFwdW.z;
}

function updateTransmissionAndAudio(dt: number) {
  const speed = Math.abs(signedForwardSpeed());
  const speedMph = speed * 2.2369362920544;
  const wheelOmega = speed / Math.max(1e-3, wheelRadius); // rad/s
  const wheelRpm = wheelOmega * (60 / (2 * Math.PI));

  // Torque-converter style slip: enough for launch, but avoid constant high-rev flare.
  const slip = THREE.MathUtils.lerp(0.04, 0.22, throttle);
  const ratio = drivetrain.gearRatios[drivetrain.gear] * drivetrain.finalDrive;
  const rpmFromWheels = wheelOmega * ratio * (60 / (2 * Math.PI));
  const targetRpm = Math.max(drivetrain.idleRpm, rpmFromWheels * (1 + slip));

  if (drivetrain.isShifting) {
    drivetrain.shiftTimer -= dt;
    if (drivetrain.shiftTimer <= 0) {
      drivetrain.isShifting = false;
      drivetrain.shiftTimer = 0;
    }
  } else {
    const maxGear = drivetrain.gearRatios.length - 1;
    if (
      throttle > 0.12 &&
      drivetrain.gear < maxGear &&
      targetRpm > drivetrain.upshiftRpm
    ) {
      drivetrain.gear++;
      drivetrain.isShifting = true;
      drivetrain.shiftTimer = 0.22;
    } else if (drivetrain.gear > 1 && targetRpm < drivetrain.downshiftRpm) {
      drivetrain.gear--;
      drivetrain.isShifting = true;
      drivetrain.shiftTimer = 0.16;
    }
  }

  const ratio2 = drivetrain.gearRatios[drivetrain.gear] * drivetrain.finalDrive;
  const rpmFromWheels2 = wheelOmega * ratio2 * (60 / (2 * Math.PI));
  const rpm = THREE.MathUtils.clamp(
    Math.max(drivetrain.idleRpm, rpmFromWheels2 * (1 + slip)),
    drivetrain.idleRpm,
    drivetrain.redlineRpm,
  );

  engineAudio.update(
    { rpm, throttle, shifting: drivetrain.isShifting },
    dt,
    {
      speedMps: speed,
      enabled: settings.windSound,
      volume: settings.windVolume,
    },
    { volume: settings.engineVolume },
  );
  hudReadout.textContent = `gear: ${drivetrain.gear} • rpm: ${Math.round(rpm)} • wheel rpm: ${Math.round(wheelRpm)} • mph: ${Math.round(speedMph)}${drivetrain.isShifting ? " (shift)" : ""}`;
}

function applyAeroDrag() {
  // Quadratic drag in the horizontal plane: F = -k * v^2
  const k = Math.max(0, settings.dragCoeff);
  if (k <= 0) return;

  const v = chassisBody.velocity;
  const vx = v.x;
  const vz = v.z;
  const speed = Math.hypot(vx, vz);
  if (speed < 0.05) return;

  const dragMag = k * speed * speed;
  const inv = 1 / speed;
  chassisBody.applyForce(
    new CANNON.Vec3(-vx * inv * dragMag, 0, -vz * inv * dragMag),
    chassisBody.position,
  );
}

// ---------- Camera follow ----------
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
const sunDir = new THREE.Vector3();

// Rendered/interpolated chassis transform (avoids jitter between physics steps)
const chassisRenderPos = new THREE.Vector3();
const chassisRenderQuat = new THREE.Quaternion();

const camTargetSmoothed = new THREE.Vector3();
const camPosSmoothed = new THREE.Vector3();
let headingSmoothed = 0;

let camDistance = 11;
const camDistanceMin = 2.2;
const camDistanceMax = 32;

function dampVec3(
  current: THREE.Vector3,
  target: THREE.Vector3,
  lambda: number,
  dt: number,
) {
  const t = 1 - Math.exp(-lambda * dt);
  current.lerp(target, t);
}

function dampAngle(
  current: number,
  target: number,
  lambda: number,
  dt: number,
) {
  // shortest-path angular interpolation
  let delta = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  const t = 1 - Math.exp(-lambda * dt);
  return current + delta * t;
}

// User-controlled orbit offset around the vehicle heading.
let yawOffset = 0;
let pitch = 0.18;
let isPointerLocked = false;

canvas.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  if (target) {
    // Defensive: never capture pointer when clicking UI overlays.
    if (gui?.domElement?.contains(target)) return;
    if (stats?.dom?.contains(target)) return;
    if (hudEl?.contains(target)) return;
    if (target.closest?.(".lil-gui")) return;
    if (target.closest?.("#hud")) return;
  }

  canvas.requestPointerLock();
  engineAudio.start();
  engineAudio.resumeIfNeeded();
});

document.addEventListener("pointerlockchange", () => {
  isPointerLocked = document.pointerLockElement === canvas;
});

document.addEventListener("mousemove", (e) => {
  if (!isPointerLocked) return;
  yawOffset -= e.movementX * 0.002;
  pitch -= e.movementY * 0.002;
  // Allow full underside orbit while avoiding singularities at +/- 90deg.
  pitch = THREE.MathUtils.clamp(pitch, -1.25, 1.0);
});

// Mouse wheel zoom (works without pointer lock)
window.addEventListener(
  "wheel",
  (e) => {
    // deltaY > 0 usually means scroll down -> zoom out
    camDistance = THREE.MathUtils.clamp(
      camDistance + e.deltaY * 0.01,
      camDistanceMin,
      camDistanceMax,
    );
  },
  { passive: true },
);

function updateCamera(dt: number) {
  camTarget.set(
    chassisRenderPos.x,
    chassisRenderPos.y + 1.2,
    chassisRenderPos.z,
  );

  // Smooth target to absorb suspension/physics jitter.
  if (camTargetSmoothed.lengthSq() === 0) camTargetSmoothed.copy(camTarget);
  dampVec3(camTargetSmoothed, camTarget, 20, dt);

  const distance = camDistance;

  // Compute vehicle heading from chassis orientation, then place camera behind it.
  const q = chassisBody.quaternion;
  const fwd = new CANNON.Vec3(0, 0, 1);
  const fwdW = q.vmult(fwd);
  const heading = Math.atan2(fwdW.x, fwdW.z);
  if (headingSmoothed === 0) headingSmoothed = heading;
  headingSmoothed = dampAngle(headingSmoothed, heading, 10, dt);
  const yaw = headingSmoothed + yawOffset + Math.PI;

  // True orbit camera: pitch controls vertical angle around the target.
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const offset = new THREE.Vector3(
    Math.sin(yaw) * cp * distance,
    sp * distance,
    Math.cos(yaw) * cp * distance,
  );
  camPos.copy(camTargetSmoothed).add(offset);

  if (camPosSmoothed.lengthSq() === 0) camPosSmoothed.copy(camPos);
  dampVec3(camPosSmoothed, camPos, 10, dt);

  camera.position.copy(camPosSmoothed);
  camera.lookAt(camTargetSmoothed);
}

// ---------- Debug UI ----------
const stats = new Stats();
stats.showPanel(0);
document.body.appendChild(stats.dom);

// ---------- Saved defaults (localStorage) ----------
const DEFAULTS_KEY = "openevt:defaults:v1";
type SavedDefaults = {
  settings?: Partial<typeof settings>;
  control?: Partial<typeof control>;
  render?: { exposure?: number };
  lights?: { hemi?: number; sun?: number };
  camera?: { distance?: number };
};

function applyPartial<T extends Record<string, unknown>>(
  target: T,
  source: unknown,
) {
  if (!source || typeof source !== "object") return;
  for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
    if (!(k in target)) continue;
    const cur = target[k];
    if (typeof cur === "number" && typeof v === "number" && Number.isFinite(v))
      (target as any)[k] = v;
    if (typeof cur === "boolean" && typeof v === "boolean")
      (target as any)[k] = v;
  }
}

function loadSavedDefaults() {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as SavedDefaults;

    applyPartial(settings as any, parsed.settings);
    applyPartial(control as any, parsed.control);

    if (
      parsed.render?.exposure !== undefined &&
      Number.isFinite(parsed.render.exposure)
    ) {
      renderer.toneMappingExposure = THREE.MathUtils.clamp(
        parsed.render.exposure,
        0.6,
        2.5,
      );
    }
    if (
      parsed.lights?.hemi !== undefined &&
      Number.isFinite(parsed.lights.hemi)
    ) {
      hemi.intensity = THREE.MathUtils.clamp(parsed.lights.hemi, 0, 2.5);
    }
    if (
      parsed.lights?.sun !== undefined &&
      Number.isFinite(parsed.lights.sun)
    ) {
      dirLight.intensity = THREE.MathUtils.clamp(parsed.lights.sun, 0, 3.5);
    }
    if (
      parsed.camera?.distance !== undefined &&
      Number.isFinite(parsed.camera.distance)
    ) {
      camDistance = THREE.MathUtils.clamp(
        parsed.camera.distance,
        camDistanceMin,
        camDistanceMax,
      );
    }

    syncFogRange();
    ensureChunksAround(chassisBody.position.x, chassisBody.position.z);
    processChunkBuildQueue(32);
    console.log("[defaults] loaded");
  } catch (err) {
    console.warn("[defaults] failed to load", err);
  }
}

function saveDefaults() {
  const payload: SavedDefaults = {
    settings: {
      amplitude: settings.amplitude,
      frequency: settings.frequency,
      octaves: settings.octaves,
      lacunarity: settings.lacunarity,
      gain: settings.gain,
      viewRadiusChunks: settings.viewRadiusChunks,
      fogAuto: settings.fogAuto,
      fogNear: settings.fogNear,
      fogFar: settings.fogFar,
      fogEndMultiplier: settings.fogEndMultiplier,
      dragCoeff: settings.dragCoeff,
      windSound: settings.windSound,
      windVolume: settings.windVolume,
      engineVolume: settings.engineVolume,
    },
    control: {
      maxForce: control.maxForce,
      maxSteer: control.maxSteer,
      brakeForce: control.brakeForce,
    },
    render: {
      exposure: renderer.toneMappingExposure,
    },
    lights: {
      hemi: hemi.intensity,
      sun: dirLight.intensity,
    },
    camera: {
      distance: camDistance,
    },
  };
  localStorage.setItem(DEFAULTS_KEY, JSON.stringify(payload));
  console.log("[defaults] saved");
}

loadSavedDefaults();

const gui = new GUI({ width: 320 });
gui.title("Sim");
gui.add(settings, "amplitude", 1, 60, 0.1).onFinishChange(() => {
  reseedTerrain(seed);
  ensureChunksAround(chassisBody.position.x, chassisBody.position.z);
  processChunkBuildQueue(32);
});
gui.add(settings, "frequency", 0.002, 0.03, 0.001).onFinishChange(() => {
  reseedTerrain(seed);
  ensureChunksAround(chassisBody.position.x, chassisBody.position.z);
  processChunkBuildQueue(32);
});
gui
  .add(settings, "viewRadiusChunks", 1, 12, 1)
  .name("Terrain Render Distance")
  .onChange(() => {
    ensureChunksAround(chassisBody.position.x, chassisBody.position.z);
    syncFogRange();
  });

gui
  .add(settings, "fogAuto")
  .name("Fog Auto")
  .onChange(() => syncFogRange());
gui
  .add(settings, "fogEndMultiplier", 0.6, 2.0, 0.01)
  .name("Fog End ×")
  .onChange(() => syncFogRange());
gui
  .add(settings, "fogNear", 0, 600, 1)
  .name("Fog Near")
  .onChange((v: number) => {
    settings.fogAuto = false;
    fog.near = v;
  });
gui
  .add(settings, "fogFar", 200, 6000, 1)
  .name("Fog Far")
  .onChange((v: number) => {
    settings.fogAuto = false;
    fog.far = v;
  });

gui.add(renderer, "toneMappingExposure", 0.6, 2.0, 0.01).name("Exposure");
gui.add(hemi, "intensity", 0.1, 1.5, 0.01).name("Fill Light");
gui.add(dirLight, "intensity", 0.2, 2.5, 0.01).name("Sun Light");

gui.add({ saveDefaults }, "saveDefaults").name("Save Defaults");

const aeroFolder = gui.addFolder("Aero");
aeroFolder.add(settings, "dragCoeff", 0, 0.06, 0.001).name("Wind Drag");
aeroFolder.add(settings, "windSound").name("Wind Audio");
aeroFolder.add(settings, "windVolume", 0, 1.25, 0.01).name("Wind Volume");

const audioFolder = gui.addFolder("Audio");
audioFolder.add(settings, "engineVolume", 0, 1.5, 0.01).name("Engine Volume");
gui.add(control, "maxForce", 800, 6000, 50);
gui.add(control, "maxSteer", 0.1, 0.7, 0.01);

// ---------- Resize ----------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Main loop ----------
const clock = new THREE.Clock();
let accumulator = 0;
const fixedTimeStep = 1 / 60;
const maxSubSteps = 4;

const prevBodyPos = new CANNON.Vec3();
const prevBodyQuat = new CANNON.Quaternion();
const tmpPrevQuat3 = new THREE.Quaternion();
const tmpCurrQuat3 = new THREE.Quaternion();

function updateInterpolatedChassis(alpha: number) {
  const a = THREE.MathUtils.clamp(alpha, 0, 1);
  const p0 = prevBodyPos;
  const p1 = chassisBody.position;
  chassisRenderPos.set(
    THREE.MathUtils.lerp(p0.x, p1.x, a),
    THREE.MathUtils.lerp(p0.y, p1.y, a),
    THREE.MathUtils.lerp(p0.z, p1.z, a),
  );

  const q0 = prevBodyQuat;
  const q1 = chassisBody.quaternion;
  tmpPrevQuat3.set(q0.x, q0.y, q0.z, q0.w);
  tmpCurrQuat3.set(q1.x, q1.y, q1.z, q1.w);
  chassisRenderQuat.copy(tmpPrevQuat3).slerp(tmpCurrQuat3, a);
}

// Init interpolation state.
prevBodyPos.copy(chassisBody.position);
prevBodyQuat.copy(chassisBody.quaternion);
updateInterpolatedChassis(1);

function syncVisuals() {
  chassisRoot.quaternion.copy(chassisRenderQuat);
  chassisRoot.position.copy(chassisRenderPos);
  // Keep the visible chassis aligned with the offset collision shape.
  const visualOffset = new THREE.Vector3(
    0,
    chassisShapeOffsetY,
    0,
  ).applyQuaternion(chassisRenderQuat);
  chassisRoot.position.add(visualOffset);

  for (let i = 0; i < vehicle.wheelInfos.length; i++) {
    wheelMeshes[i].position.copy(wheelRenderPos[i]);
    wheelMeshes[i].quaternion.copy(wheelRenderQuat[i]);
  }
}

function animate() {
  stats.begin();
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  ensureChunksAround(chassisBody.position.x, chassisBody.position.z);
  processChunkBuildQueue(maxChunkBuildsPerFrame);

  // Keep the fog range matched to current terrain horizon.
  if (settings.fogAuto) syncFogRange();

  // Fade in newly created chunks to avoid horizon popping.
  const now = performance.now();
  for (const [, c] of chunks) {
    const start = c.mesh.userData.fadeInStart as number | undefined;
    if (!start) continue;
    const t = THREE.MathUtils.clamp(
      (now - start) / (chunkFadeSeconds * 1000),
      0,
      1,
    );
    const mat = c.mesh.material as unknown as THREE.Material;
    if ((mat as any).opacity !== undefined) {
      (mat as any).opacity = t;
      const nextTransparent = t < 1;
      if ((mat as any).transparent !== nextTransparent) {
        (mat as any).transparent = nextTransparent;
        mat.needsUpdate = true;
      }
      if (t >= 1) delete c.mesh.userData.fadeInStart;
    }
  }
  updateDrive();
  updateTransmissionAndAudio(dt);

  accumulator += dt;
  let subSteps = 0;
  while (accumulator >= fixedTimeStep && subSteps < maxSubSteps) {
    // Track previous state for interpolation.
    prevBodyPos.copy(chassisBody.position);
    prevBodyQuat.copy(chassisBody.quaternion);

    // Wheel prev snapshot is just the last curr snapshot.
    for (let i = 0; i < wheelMeshes.length; i++) {
      prevWheelPos[i].copy(currWheelPos[i]);
      prevWheelQuat[i].copy(currWheelQuat[i]);
    }

    applyAeroDrag();
    world.step(fixedTimeStep);

    // Capture current wheel transforms after the physics step.
    for (let i = 0; i < wheelMeshes.length; i++) {
      vehicle.updateWheelTransform(i);
      const t = vehicle.wheelInfos[i].worldTransform;
      currWheelPos[i].set(t.position.x, t.position.y, t.position.z);
      currWheelQuat[i].set(
        t.quaternion.x,
        t.quaternion.y,
        t.quaternion.z,
        t.quaternion.w,
      );
    }

    accumulator -= fixedTimeStep;
    subSteps++;
  }

  // Interpolate rendered transform between last two physics states.
  updateInterpolatedChassis(accumulator / fixedTimeStep);
  updateInterpolatedWheels(accumulator / fixedTimeStep);

  syncVisuals();
  updateCamera(dt);

  // Keep the sky dome centered on the camera.
  sky.position.copy(camera.position);

  // keep sun direction roughly consistent
  dirLight.target.position.set(
    chassisRenderPos.x,
    chassisRenderPos.y,
    chassisRenderPos.z,
  );
  // Follow the vehicle with the shadow frustum to keep shadows visible and crisp.
  sunDir.copy(sun).normalize();
  dirLight.position.set(
    chassisRenderPos.x + sunDir.x * 140,
    chassisRenderPos.y + sunDir.y * 140 + 30,
    chassisRenderPos.z + sunDir.z * 140,
  );
  scene.add(dirLight.target);

  renderer.render(scene, camera);
  stats.end();
}

// Prime initial terrain
ensureChunksAround(0, 0);
processChunkBuildQueue(64);
animate();
