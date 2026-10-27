// Whisper, run in this browser: the owner's voice is transcribed on their own device and never sent
// anywhere. The model (about 75 MB) downloads from Hugging Face once and is cached by the browser.
import { pipeline, env } from "/vendor/transformers/transformers.min.js";

const MODEL = "onnx-community/whisper-base.en";
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = "/vendor/ort/";

let asr;
const files = {};
const progress_callback = (p) => {
  // Megabytes of model weights so far (a percentage would jump back as each new file starts).
  if (p.status !== "progress" || !p.total || p.total < 1_000_000) return;
  files[p.file] = [p.loaded, p.total];
  const got = Object.values(files).reduce((a, [x]) => a + x, 0);
  postMessage({ type: "progress", mb: Math.round(got / 1_000_000) });
};
// The GPU where the browser has WebGPU (several times faster), else WebAssembly on the CPU.
const load = () => asr ??= (async () => {
  const gpu = await navigator.gpu?.requestAdapter().catch(() => null);
  const p = await (gpu
    ? pipeline("automatic-speech-recognition", MODEL, { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" }, progress_callback }).catch(() => null)
    : null) ?? await pipeline("automatic-speech-recognition", MODEL, { device: "wasm", dtype: "q8", progress_callback });
  postMessage({ type: "ready" });
  return p;
})();

// Whisper wants 16 kHz mono; the microphone gives whatever the device runs at.
function to16k(audio, rate) {
  if (rate === 16000) return audio;
  const out = new Float32Array(Math.floor(audio.length * 16000 / rate));
  const step = rate / 16000;
  for (let i = 0; i < out.length; i++) {
    const x = i * step, j = Math.floor(x), f = x - j;
    out[i] = audio[j] * (1 - f) + (audio[j + 1] ?? audio[j]) * f;
  }
  return out;
}

onmessage = async ({ data }) => {
  try {
    if (data.type === "load") return void await load();
    if (data.type === "transcribe") {
      const out = await (await load())(to16k(data.audio, data.rate));
      // Whisper marks silence and noise like "[BLANK_AUDIO]" or "(wind blowing)": that's not something said.
      const text = String(out.text ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
      postMessage({ type: "text", id: data.id, text });
    }
  } catch (e) {
    postMessage({ type: "error", id: data.id, message: String(e?.message ?? e).slice(0, 200) });
  }
};
