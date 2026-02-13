export type EngineSoundMode = "idle" | "island";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const createPulseCurve = (n = 1024, threshold = 0.4, power = 4) => {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1; // [-1, 1]
    const t = (x - threshold) / Math.max(1e-6, 1 - threshold);
    const y = t <= 0 ? 0 : Math.pow(t, power);
    curve[i] = y;
  }
  return curve;
};

const createNoiseBuffer = (ctx: AudioContext, seconds = 2) => {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) ch[i] = Math.random() * 2 - 1;
  return buf;
};

export class EngineSound {
  private ctx: AudioContext;
  private enabledGain: GainNode;
  private volumeGain: GainNode;

  private toneOsc: OscillatorNode;
  private tone2Osc: OscillatorNode;
  private tone2Gain: GainNode;
  private throatOsc: OscillatorNode;
  private throatGain: GainNode;
  private throatFilter: BiquadFilterNode;
  private toneFilter: BiquadFilterNode;
  private preSat: GainNode;
  private toneMix: GainNode;
  private toneVca: GainNode;
  private lowShelf: BiquadFilterNode;

  private lfoOsc: OscillatorNode;
  private lfoShape: WaveShaperNode;
  private lfoGain: GainNode;

  private noiseSrc: AudioBufferSourceNode;
  private noiseFilter: BiquadFilterNode;
  private noiseVca: GainNode;
  private noiseGain: GainNode;

  private sat: WaveShaperNode;

  private started = false;
  private disposed = false;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });

    this.enabledGain = this.ctx.createGain();
    this.enabledGain.gain.value = 0;
    this.volumeGain = this.ctx.createGain();
    this.volumeGain.gain.value = 0.4;
    this.enabledGain.connect(this.volumeGain);
    this.volumeGain.connect(this.ctx.destination);

    // Use triangle + a subtle 2nd harmonic to avoid harsh/buzzy timbre at low RPM.
    this.toneOsc = this.ctx.createOscillator();
    this.toneOsc.type = "triangle";
    this.toneOsc.frequency.value = 80;

    this.tone2Osc = this.ctx.createOscillator();
    this.tone2Osc.type = "sine";
    this.tone2Osc.frequency.value = 160;

    // Keep pitch the same but reduce high harmonic energy.
    this.tone2Gain = this.ctx.createGain();
    this.tone2Gain.gain.value = 0.22;

    // Subharmonic "throat" component: keeps perceived pitch but adds low-end rumble/body.
    this.throatOsc = this.ctx.createOscillator();
    this.throatOsc.type = "sine";
    this.throatOsc.frequency.value = 40;

    this.throatGain = this.ctx.createGain();
    this.throatGain.gain.value = 0.0;

    this.throatFilter = this.ctx.createBiquadFilter();
    this.throatFilter.type = "lowpass";
    this.throatFilter.frequency.value = 260;
    this.throatFilter.Q.value = 0.7;

    this.toneFilter = this.ctx.createBiquadFilter();
    this.toneFilter.type = "lowpass";
    this.toneFilter.frequency.value = 800;
    this.toneFilter.Q.value = 0.6;

    this.preSat = this.ctx.createGain();
    this.preSat.gain.value = 1.2;

    this.toneMix = this.ctx.createGain();
    this.toneMix.gain.value = 0.8;

    this.sat = this.ctx.createWaveShaper();
    this.sat.curve = (() => {
      const n = 1024;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(1.6 * x);
      }
      return curve;
    })();
    this.sat.oversample = "2x";

    this.lowShelf = this.ctx.createBiquadFilter();
    this.lowShelf.type = "lowshelf";
    this.lowShelf.frequency.value = 180;
    this.lowShelf.gain.value = 0;

    this.toneVca = this.ctx.createGain();
    this.toneVca.gain.value = 0;

    // Pulse train: LFO -> waveshaper (rectified spikes) -> gain -> VCA.gain
    this.lfoOsc = this.ctx.createOscillator();
    this.lfoOsc.type = "sine";
    this.lfoOsc.frequency.value = 10;

    this.lfoShape = this.ctx.createWaveShaper();
    // Softer amplitude "bangs" to reduce uncomfortable buzzing at low frequencies.
    this.lfoShape.curve = createPulseCurve(2048, 0.25, 3);

    this.lfoGain = this.ctx.createGain();
    this.lfoGain.gain.value = 0;

    this.noiseSrc = this.ctx.createBufferSource();
    this.noiseSrc.buffer = createNoiseBuffer(this.ctx, 2);
    this.noiseSrc.loop = true;

    this.noiseFilter = this.ctx.createBiquadFilter();
    this.noiseFilter.type = "bandpass";
    this.noiseFilter.frequency.value = 180;
    this.noiseFilter.Q.value = 0.9;

    this.noiseVca = this.ctx.createGain();
    this.noiseVca.gain.value = 0;

    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.value = 0.35;

    // Routing
    this.toneOsc.connect(this.toneMix);
    this.tone2Osc.connect(this.tone2Gain);
    this.tone2Gain.connect(this.toneMix);
    this.throatOsc.connect(this.throatGain);
    this.throatGain.connect(this.throatFilter);
    this.throatFilter.connect(this.toneMix);
    this.toneMix.connect(this.toneFilter);
    this.toneFilter.connect(this.preSat);
    this.preSat.connect(this.sat);
    this.sat.connect(this.lowShelf);
    this.lowShelf.connect(this.toneVca);
    this.toneVca.connect(this.enabledGain);

    this.lfoOsc.connect(this.lfoShape);
    this.lfoShape.connect(this.lfoGain);
    this.lfoGain.connect(this.toneVca.gain);
    this.lfoGain.connect(this.noiseVca.gain);

    this.noiseSrc.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseVca);
    this.noiseVca.connect(this.noiseGain);
    this.noiseGain.connect(this.enabledGain);

  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    if (this.disposed) return false;
    if (enabled) {
      if (!this.started) {
        try {
          await this.ctx.resume();
          this.toneOsc.start();
          this.tone2Osc.start();
          this.throatOsc.start();
          this.lfoOsc.start();
          this.noiseSrc.start();
          this.started = true;
        } catch {
          // Autoplay policies can block audio until a user gesture; stay silent.
          this.enabledGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
          return false;
        }
      } else {
        try {
          await this.ctx.resume();
        } catch {
          this.enabledGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
          return false;
        }
      }
      // Fade in; actual loudness comes from LFO gain.
      this.enabledGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.01);
      return true;
    } else {
      // Fade out quickly.
      this.enabledGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      return true;
    }
  }

  setVolume(volume01: number) {
    if (this.disposed) return;
    const v = clamp01(volume01);
    this.volumeGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  update(params: {
    rpm: number;
    cylinders: number;
    mode: EngineSoundMode;
    genKw: number;
    genKwMax: number;
    tqNmMax: number;
  }) {
    if (this.disposed) return;
    if (!this.started) return;

    const rpm = clamp(params.rpm || 0, 0, 8000);
    const cyl = Math.max(1, Math.round(params.cylinders || 8));
    const firingPerRev = Math.max(1, Math.floor(cyl / 2)); // 4-stroke approximation
    const firingHz = Math.max(1, (rpm / 60) * firingPerRev);

    const load01 = clamp01((params.genKwMax > 1e-6 ? params.genKw / params.genKwMax : 0) || 0);
    const rpm01 = clamp01((rpm - 800) / 4200);
    // Keep idle audible; many browsers/users run volume < 50% and otherwise the engine
    // can disappear when the generator is off.
    const modeBase = params.mode === "island" ? 0.06 : 0.03;
    // Add a little RPM-based loudness so 1500-2500 RPM doesn't read like "idle" when lightly loaded.
    const amp = clamp01(modeBase + load01 * 0.7 + rpm01 * 0.12);
    const noiseAmp = clamp01(
      (params.mode === "island" ? 0.02 : 0.008) + load01 * 0.35 + rpm01 * 0.05,
    );

    const now = this.ctx.currentTime;
    this.lfoOsc.frequency.setTargetAtTime(firingHz, now, 0.03);

    // Tone tracks firing rate, but perceived "engine pitch" is dominated by harmonics.
    // Use a higher harmonic at low RPM so a V8 doesn't read as sub-bass, then ease down
    // slightly as RPM increases to avoid getting too piercing.
    const harmonic = clamp(2.4 - rpm01 * 0.6, 1.8, 2.4);
    const toneHz = firingHz * harmonic;
    this.toneOsc.frequency.setTargetAtTime(toneHz, now, 0.03);
    this.tone2Osc.frequency.setTargetAtTime(toneHz * 2.0, now, 0.03);
    // Keep the same base pitch but darken/weight the timbre.
    const cutoff = clamp(110 + rpm * 0.55 + load01 * 1300, 90, 4200);
    this.toneFilter.frequency.setTargetAtTime(cutoff, now, 0.03);

    // Noise is the "bang" component; center frequency follows RPM.
    const bangCenter = clamp(80 + rpm * 0.5, 70, 2100);
    this.noiseFilter.frequency.setTargetAtTime(bangCenter, now, 0.05);

    this.lfoGain.gain.setTargetAtTime(amp, now, 0.02);
    this.noiseGain.gain.setTargetAtTime(noiseAmp, now, 0.02);

    // Throat oscillator follows half firing rate (subharmonic).
    this.throatOsc.frequency.setTargetAtTime(Math.max(18, firingHz * 0.5), now, 0.04);
    const throatAmt = clamp01((params.mode === "island" ? 0.12 : 0.05) + load01 * 0.55 + (1 - rpm01) * 0.18);
    this.throatGain.gain.setTargetAtTime(throatAmt, now, 0.06);

    // Low-end weight increases with load and at lower RPM.
    const lowShelfDb = clamp(3 + load01 * 10 + (1 - rpm01) * 4, 0, 16);
    this.lowShelf.gain.setTargetAtTime(lowShelfDb, now, 0.08);

    // A little more saturation under load.
    this.preSat.gain.setTargetAtTime(1.0 + load01 * 2.4, now, 0.06);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.enabledGain.gain.value = 0;
      this.toneOsc.stop();
      this.tone2Osc.stop();
      this.throatOsc.stop();
      this.lfoOsc.stop();
      this.noiseSrc.stop();
    } catch {
      // ignore
    }
    try {
      void this.ctx.close();
    } catch {
      // ignore
    }
  }
}
