import { defaultConfig, defaultInputs } from "../sim/defaults";
import { createInitialState, step } from "../sim/step";
import type { ExportPayload, ScriptedPoint, SimConfig, SimInputs, SimState } from "../sim/types";

const DT = 0.05;

let config: SimConfig = structuredClone(defaultConfig);
let inputs: SimInputs = structuredClone(defaultInputs);
let state: SimState = createInitialState(config);
let running = true;
let speedMultiplier = 1;

let accumulator = 0;
let lastTime = performance.now();
let lastPost = performance.now();

let recording = false;
let recordedInputs: ScriptedPoint[] = [];
let replaying = false;
let replayStart = 0;

const sampleSeries = (series: ScriptedPoint[], t: number): ScriptedPoint => {
  if (series.length === 0) return { t, aps: inputs.aps, tps: inputs.tps };
  if (t <= series[0].t) return series[0];
  if (t >= series[series.length - 1].t) return series[series.length - 1];
  let i = 0;
  while (i < series.length - 1 && series[i + 1].t < t) i += 1;
  const a = series[i];
  const b = series[i + 1];
  const span = Math.max(1e-6, b.t - a.t);
  const u = (t - a.t) / span;
  return {
    t,
    aps: a.aps + (b.aps - a.aps) * u,
    tps: a.tps + (b.tps - a.tps) * u,
    gradePct:
      typeof a.gradePct === "number" && typeof b.gradePct === "number"
        ? a.gradePct + (b.gradePct - a.gradePct) * u
        : a.gradePct ?? b.gradePct,
  };
};

const postSnapshot = () => {
  (self as DedicatedWorkerGlobalScope).postMessage({
    type: "snapshot",
    state,
  });
};

const resetState = () => {
  state = createInitialState(config);
  accumulator = 0;
  replaying = false;
  replayStart = 0;
};

const tick = () => {
  const now = performance.now();
  const elapsed = ((now - lastTime) / 1000) * speedMultiplier;
  lastTime = now;

  if (!running) {
    if (now - lastPost > 200) {
      postSnapshot();
      lastPost = now;
    }
    setTimeout(tick, 16);
    return;
  }

  accumulator += elapsed;

  while (accumulator >= DT) {
    let effectiveInputs = inputs;

    if (replaying && recordedInputs.length > 1) {
      const t = state.timeSec - replayStart;
      if (t > recordedInputs[recordedInputs.length - 1].t) {
        replaying = false;
      } else {
        const sample = sampleSeries(recordedInputs, t);
        effectiveInputs = {
          ...inputs,
          aps: sample.tps,
          tps: sample.tps,
          gradePct: sample.gradePct ?? inputs.gradePct,
        };
      }
    }

    state = step(state, effectiveInputs, config, DT);

    if (recording) {
      recordedInputs.push({
        t: state.timeSec,
        aps: effectiveInputs.tps,
        tps: effectiveInputs.tps,
        gradePct: effectiveInputs.gradePct,
      });
    }

    accumulator -= DT;
  }

  if (now - lastPost > 40) {
    postSnapshot();
    lastPost = now;
  }

  setTimeout(tick, 16);
};

self.onmessage = (event: MessageEvent) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  switch (data.type) {
    case "init":
      config = structuredClone(data.config ?? defaultConfig);
      inputs = structuredClone(data.inputs ?? defaultInputs);
      resetState();
      postSnapshot();
      break;
    case "setRunning":
      running = Boolean(data.running);
      break;
    case "setSpeed":
      speedMultiplier = Math.max(0.1, Number(data.speed) || 1);
      break;
    case "setInputs":
      inputs = { ...inputs, ...data.inputs };
      break;
    case "setConfig":
      config = { ...config, ...data.config };
      if (data.config?.vehicle) config.vehicle = { ...config.vehicle, ...data.config.vehicle };
      if (data.config?.battery) config.battery = { ...config.battery, ...data.config.battery };
      if (data.config?.engine) config.engine = { ...config.engine, ...data.config.engine };
      if (data.config?.generator) config.generator = { ...config.generator, ...data.config.generator };
      if (data.config?.bus) config.bus = { ...config.bus, ...data.config.bus };
      break;
    case "setMode":
      config = { ...config, mode: "basic" };
      break;
    case "reset":
      resetState();
      break;
    case "startRecording":
      recording = true;
      recordedInputs = [];
      break;
    case "stopRecording":
      recording = false;
      break;
    case "startReplay":
      if (recordedInputs.length > 1) {
        replaying = true;
        replayStart = state.timeSec;
      }
      break;
    case "stopReplay":
      replaying = false;
      break;
    case "requestExport": {
      const payload: ExportPayload = {
        config,
        inputs,
        recordedInputs,
        finalState: state,
      };
      (self as DedicatedWorkerGlobalScope).postMessage({
        type: "export",
        payload,
      });
      break;
    }
    default:
      break;
  }
};

tick();
