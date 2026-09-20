class PitchCorrector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    this.g = { depth: 0.70, speed: 0.16 };
    this.analysisRate = this.sr * 0.5;
    this.analysisSize = 1024;
    this.analysis = new Float32Array(this.analysisSize);
    this.analysisWork = new Float32Array(this.analysisSize);
    this.diff = new Float32Array(512);
    this.cmnd = new Float32Array(512);
    this.analysisIndex = 0;
    this.analysisCount = 0;
    this.decimate = 0;
    this.nextAnalysis = 1024;
    this.forceFull = true;
    this.minHz = 70;
    this.maxHz = 1000;
    this.previousLag = 0;
    this.previousF0 = 0;
    this.pitch = 0;
    this.target = 1;
    this.ratio = 1;
    this.voice = 0;
    this.confidence = 0;
    this.level = 0;
    this.prevLevel = 0;
    this.hpX = 0;
    this.hpY = 0;
    this.warm = 0;
    this.ringSize = 16384;
    this.left = new Float32Array(this.ringSize);
    this.right = new Float32Array(this.ringSize);
    this.write = 0;
    this.window = 1536;
    this.baseDelay = 96;
    this.phase = 0;
    this.minRatio = 0.80;
    this.maxRatio = 1.25;
    this.port.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'strength') {
        const value = data.value;
        if (value && typeof value === 'object') {
          const depth = Number(value.depth);
          const speed = Number(value.speed);
          if (Number.isFinite(depth)) this.g.depth = Math.max(0, Math.min(1, depth));
          if (Number.isFinite(speed)) this.g.speed = Math.max(0.005, Math.min(1, speed));
        } else {
          const strength = Math.max(0, Math.min(1, Number(value) || 0));
          this.g.depth = strength;
          this.g.speed = 0.04 + strength * 0.38;
        }
      } else if (data.type === 'reset') {
        this.reset();
      }
    };
  }

  reset() {
    this.analysis.fill(0);
    this.analysisWork.fill(0);
    this.diff.fill(0);
    this.cmnd.fill(0);
    this.analysisIndex = 0;
    this.analysisCount = 0;
    this.decimate = 0;
    this.nextAnalysis = 1024;
    this.forceFull = true;
    this.previousLag = 0;
    this.previousF0 = 0;
    this.pitch = 0;
    this.target = 1;
    this.ratio = 1;
    this.voice = 0;
    this.confidence = 0;
    this.level = 0;
    this.prevLevel = 0;
    this.hpX = 0;
    this.hpY = 0;
    this.warm = 0;
    this.write = 0;
    this.phase = 0;
    this.left.fill(0);
    this.right.fill(0);
  }

  putAnalysis(sample) {
    this.analysis[this.analysisIndex] = sample;
    this.analysisIndex++;
    if (this.analysisIndex >= this.analysisSize) this.analysisIndex = 0;
    this.analysisCount = Math.min(this.analysisCount + 1, this.analysisSize);
  }

  snapshotAnalysis() {
    const count = this.analysisCount;
    const end = this.analysisIndex;
    const start = (end - count + this.analysisSize) % this.analysisSize;
    for (let i = 0; i < count; i++) this.analysisWork[i] = this.analysis[(start + i) % this.analysisSize];
    return count;
  }

  yinSearch(data, n, minLag, maxLag) {
    let cumulative = 0;
    let bestLag = minLag;
    let bestValue = 1;
    const limit = Math.min(maxLag, this.diff.length - 2);
    for (let lag = 1; lag <= limit; lag++) {
      let sum = 0;
      const stop = n - lag;
      for (let i = 0; i < stop; i++) {
        const delta = data[i] - data[i + lag];
        sum += delta * delta;
      }
      this.diff[lag] = sum;
      cumulative += sum;
      this.cmnd[lag] = cumulative > 1e-12 ? sum * lag / cumulative : 1;
    }
    let thresholdLag = 0;
    const threshold = 0.16;
    for (let lag = minLag; lag < limit - 1; lag++) {
      const value = this.cmnd[lag];
      if (value < threshold && value <= this.cmnd[lag + 1]) {
        thresholdLag = lag;
        break;
      }
    }
    if (thresholdLag) {
      bestLag = thresholdLag;
      bestValue = this.cmnd[bestLag];
    } else {
      for (let lag = minLag; lag <= limit; lag++) {
        if (this.cmnd[lag] < bestValue) {
          bestValue = this.cmnd[lag];
          bestLag = lag;
        }
      }
    }
    const left = this.cmnd[Math.max(minLag, bestLag - 1)];
    const center = this.cmnd[bestLag];
    const right = this.cmnd[Math.min(limit, bestLag + 1)];
    const denominator = left - 2 * center + right;
    let lag = bestLag;
    if (Math.abs(denominator) > 1e-8) lag += 0.5 * (left - right) / denominator;
    return { lag, score: Math.max(0, Math.min(1, 1 - bestValue)) };
  }

  detectPitch() {
    const n = this.snapshotAnalysis();
    if (n < 900) return null;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += this.analysisWork[i];
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = this.analysisWork[i] - mean;
      this.analysisWork[i] = v;
      energy += v * v;
    }
    const rms = Math.sqrt(energy / n);
    this.prevLevel = this.level;
    this.level += (rms - this.level) * 0.22;
    if (rms < 0.004) return { f0: 0, confidence: 0, level: rms };
    const minLag = Math.max(2, Math.floor(this.analysisRate / this.maxHz));
    const maxLag = Math.min(n - 8, Math.ceil(this.analysisRate / this.minHz), this.diff.length - 2);
    const result = this.yinSearch(this.analysisWork, n, minLag, maxLag);
    if (!result.lag || result.score < 0.62) {
      this.forceFull = true;
      return { f0: 0, confidence: result.score, level: rms };
    }
    let lag = result.lag;
    let f0 = this.analysisRate / lag;
    if (this.previousF0 > 0) {
      if (f0 > this.previousF0 * 1.80) {
        const candidate = lag * 2;
        if (candidate <= maxLag) {
          const score = this.cmnd[Math.max(2, Math.min(maxLag, Math.round(candidate)))];
          if (1 - score >= result.score - 0.08) {
            lag = candidate;
            f0 = this.analysisRate / lag;
          }
        }
      } else if (f0 < this.previousF0 * 0.56) {
        const candidate = lag * 0.5;
        if (candidate >= minLag) {
          const score = this.cmnd[Math.max(2, Math.min(maxLag, Math.round(candidate)))];
          if (1 - score >= result.score - 0.08) {
            lag = candidate;
            f0 = this.analysisRate / lag;
          }
        }
      }
    }
    if (f0 < this.minHz || f0 > this.maxHz) {
      this.forceFull = true;
      return { f0: 0, confidence: 0, level: rms };
    }
    this.previousLag = lag;
    this.previousF0 = f0;
    this.forceFull = false;
    return { f0, confidence: result.score, level: rms };
  }

  updatePitch() {
    const result = this.detectPitch();
    if (!result) return;
    const attack = Math.abs(result.level - this.prevLevel) / Math.max(0.01, result.level + this.prevLevel);
    const transientPenalty = Math.min(0.5, attack * 0.9);
    const confidence = Math.max(0, result.confidence - transientPenalty);
    this.confidence = confidence;
    if (!result.f0 || confidence < 0.63) {
      this.voice += (0 - this.voice) * 0.30;
      this.target += (1 - this.target) * 0.10;
      if (this.voice < 0.03) this.pitch = 0;
      return;
    }
    if (!this.pitch) this.pitch = result.f0;
    else {
      const jump = Math.abs(Math.log2(result.f0 / this.pitch));
      const coeff = jump > 0.20 ? 0.08 : 0.22;
      this.pitch = Math.exp(Math.log(this.pitch) * (1 - coeff) + Math.log(result.f0) * coeff);
    }
    const midi = 69 + 12 * Math.log2(this.pitch / 440);
    const nearest = Math.round(midi);
    const targetFreq = 440 * Math.pow(2, (nearest - 69) / 12);
    const cents = 1200 * Math.log2(targetFreq / this.pitch);
    const raw = Math.max(this.minRatio, Math.min(this.maxRatio, targetFreq / this.pitch));
    const shaped = Math.exp(Math.log(raw) * this.g.depth);
    const activity = Math.max(0, Math.min(1, confidence * (1 - transientPenalty * 1.5)));
    const desired = 1 + (shaped - 1) * activity;
    this.target += (desired - this.target) * (0.12 + this.g.speed * 0.25);
    this.voice += (1 - this.voice) * (0.16 + confidence * 0.12);
    if (Math.abs(cents) < 8) this.target += (1 - this.target) * 0.08;
  }

  read(buffer, delay) {
    let position = this.write - delay;
    position %= this.ringSize;
    if (position < 0) position += this.ringSize;
    const index = position | 0;
    const frac = position - index;
    const next = index + 1 === this.ringSize ? 0 : index + 1;
    return buffer[index] + (buffer[next] - buffer[index]) * frac;
  }

  shiftSample(buffer) {
    const phase = this.phase;
    const phaseB = phase + 0.5 >= 1 ? phase - 0.5 : phase + 0.5;
    const delayA = this.baseDelay + phase * this.window;
    const delayB = this.baseDelay + phaseB * this.window;
    const a = this.read(buffer, delayA);
    const b = this.read(buffer, delayB);
    const weightA = Math.sin(Math.PI * phase) ** 2;
    return a * weightA + b * (1 - weightA);
  }

  advancePhase() {
    let step = (1 - this.ratio) / this.window;
    step = Math.max(-0.004, Math.min(0.004, step));
    this.phase += step;
    while (this.phase >= 1) this.phase -= 1;
    while (this.phase < 0) this.phase += 1;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const leftIn = input?.[0];
    const rightIn = input?.[1] || leftIn;
    const length = output[0].length;
    for (let i = 0; i < length; i++) {
      const l = leftIn?.[i] || 0;
      const r = rightIn?.[i] ?? l;
      this.left[this.write] = l;
      this.right[this.write] = r;
      this.warm = Math.min(this.warm + 1, this.baseDelay + this.window + 8);
      this.decimate ^= 1;
      if (this.decimate === 0) {
        const mono = (l + r) * 0.5;
        const hp = mono - this.hpX + 0.995 * this.hpY;
        this.hpX = mono;
        this.hpY = hp;
        this.putAnalysis(hp);
        this.nextAnalysis--;
        if (this.analysisCount >= 900 && this.nextAnalysis <= 0) {
          this.updatePitch();
          this.nextAnalysis = 1024;
        }
      }
      const coefficient = 1 - Math.exp(-(0.7 + this.g.speed * 3) / this.sr);
      this.ratio += (this.target - this.ratio) * coefficient * (this.voice + 0.15);
      this.ratio = Math.max(this.minRatio, Math.min(this.maxRatio, this.ratio));
      const correction = Math.abs(this.ratio - 1);
      const wet = correction < 0.0012 ? 0 : Math.min(1, this.voice * 1.25);
      if (wet === 0 || this.warm < this.baseDelay + this.window + 2) {
        output[0][i] = l;
        if (output[1]) output[1][i] = r;
      } else {
        const shiftedL = this.shiftSample(this.left);
        const shiftedR = this.shiftSample(this.right);
        output[0][i] = l * (1 - wet) + shiftedL * wet;
        if (output[1]) output[1][i] = r * (1 - wet) + shiftedR * wet;
        this.advancePhase();
      }
      this.write++;
      if (this.write >= this.ringSize) this.write = 0;
    }
    return true;
  }
}

registerProcessor('pitch-corrector', PitchCorrector);
