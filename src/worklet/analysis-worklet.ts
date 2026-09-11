/**
 * AudioWorklet Processor — Analysis Branch
 * 
 * Bounded, lightweight PCM collection only.
 * - Computes RMS and peak levels for the upstream level meter
 * - Emits silence (zeros) to its output so it doesn't add to playback
 * - No inference, database access, blocking work, or unbounded allocation
 */

class AnalysisWorkletProcessor extends AudioWorkletProcessor {
  private _rms: number = 0;
  private _peak: number = 0;
  private _sendInterval: number = 0; // send level every N frames (~100ms)
  private _frameCount: number = 0;

  constructor() {
    super();
    // Send level updates ~every 100ms (at 48kHz that's ~4800 samples)
    this._sendInterval = Math.round(sampleRate * 0.1);
  }

  /**
   * Called for each render quantum (~128 frames at 48kHz ≈ 2.67ms).
   * We process the input, compute levels, and output silence.
   */
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
    _processorOutputs: Record<string, Float32Array>
  ): boolean {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) return true;

    const numChannels = input.length;
    const frameCount = input[0].length;

    // Compute RMS and peak across all channels (downmix to mono for analysis)
    let sumSquares = 0;
    let maxVal = 0;
    let totalSamples = 0;

    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = input[ch];
      for (let i = 0; i < frameCount; i++) {
        const sample = channelData[i];
        sumSquares += sample * sample;
        const absVal = Math.abs(sample);
        if (absVal > maxVal) maxVal = absVal;
        totalSamples++;
      }
    }

    this._rms = Math.sqrt(sumSquares / totalSamples);
    this._peak = maxVal;

    // Output silence to avoid duplicate playback on the analysis branch
    for (let ch = 0; ch < output.length; ch++) {
      output[ch].fill(0);
    }

    // Send level data back to the offscreen document periodically
    this._frameCount += frameCount;
    if (this._frameCount >= this._sendInterval) {
      this._frameCount = 0;
      this.port.postMessage({
        type: "WORKLET_LEVEL",
        rms: this._rms,
        peak: this._peak,
        sampleRate: sampleRate,
        timestamp: currentTime,
      });
    }

    return true; // keep processor alive
  }
}

registerProcessor("analysis-worklet", AnalysisWorkletProcessor);
