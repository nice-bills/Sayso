// Regenerates tests/fixtures/say-pay-kreuzberg.wav: a synthetic voice (MMS-TTS; SpeechT5 fails in transformers 4.3.1) saying a payment,
// padded so the app's 1.8 s silence stop fires. Needs Hugging Face. Run: node scripts/make-say-fixture.ts
import { pipeline } from "@huggingface/transformers";
import { writeFileSync } from "node:fs";

// Spelled for the ear. The voice is random, so the committed WAV is one take Whisper read right; regenerating may need retries.
const SAY = "Please pay Kroysberg Studio two hundred and eighty euros for invoice one thirty.";
const tts = await pipeline("text-to-speech", "Xenova/mms-tts-eng", { dtype: "fp32" });
const out = await tts(SAY);
const rate = out.sampling_rate, voice = out.audio as Float32Array;
const lead = Math.round(rate * 0.3), tail = Math.round(rate * 2.5);
const pcm = new Int16Array(lead + voice.length + tail);
voice.forEach((v, i) => { pcm[lead + i] = Math.max(-1, Math.min(1, v)) * 32767; });
const head = Buffer.alloc(44);
head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.byteLength, 4); head.write("WAVEfmt ", 8);
head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(pcm.byteLength, 40);
writeFileSync("tests/fixtures/say-pay-kreuzberg.wav", Buffer.concat([head, Buffer.from(pcm.buffer)]));
console.log(`wrote ${rate} Hz, ${((lead + voice.length + tail) / rate).toFixed(1)} s`);
