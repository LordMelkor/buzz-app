// A fixed 20ms/48kHz mono frame matches the existing Huddle v2 Opus sender.
class HuddleCapture extends AudioWorkletProcessor {
  frame = new Float32Array(960);
  offset = 0;
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      for (const value of input) {
        this.frame[this.offset++] = Math.max(-1, Math.min(1, value));
        if (this.offset === this.frame.length) {
          this.port.postMessage(this.frame);
          this.frame = new Float32Array(960);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("buzz-huddle-capture", HuddleCapture);
