// Spike: how big can a chunk be, how fast is it, and can chunks be played while they arrive?
import { api, getChunk, hex, putChunk, splitMp3 } from "./lib";
import { blake3 } from "@noble/hashes/blake3.js";

const log = document.getElementById("app")!;
log.textContent = "FreeTunes spike: drive it from the console (window.spike).";

/** Publish random chunks of growing size; report time, and read each back verifying its hash. */
async function limits(sizesKb: number[]) {
  const rows: Record<string, unknown>[] = [];
  for (const kb of sizesKb) {
    const data = new Uint8Array(kb * 1024);
    for (let o = 0; o < data.length; o += 65536) crypto.getRandomValues(data.subarray(o, Math.min(o + 65536, data.length)));
    const row: Record<string, unknown> = { kb };
    try {
      let t = performance.now();
      const addr = await putChunk(data);
      row.putMs = Math.round(performance.now() - t);
      t = performance.now();
      const back = await getChunk(addr);
      row.getMs = Math.round(performance.now() - t);
      row.ok = back.length === data.length && hex(blake3(back)) === hex(blake3(data));
    } catch (e) { row.err = String(e).slice(0, 120); }
    rows.push(row);
    if (row.err) break; // larger sizes will fail too
  }
  return rows;
}

/** Publish the test MP3 as chunks; returns the addresses. */
async function publishMp3(url: string, targetKb: number) {
  const file = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const pieces = splitMp3(file, targetKb * 1024);
  const t0 = performance.now();
  const addrs: string[] = [];
  for (const p of pieces) addrs.push(await putChunk(p));
  return { bytes: file.length, chunks: pieces.length, sizesKb: pieces.map((p) => Math.round(p.length / 1024)), totalMs: Math.round(performance.now() - t0), addrs };
}

/** Play the chunks progressively through MediaSource; report what happened. */
async function stream(addrs: string[]) {
  const audio = new Audio();
  audio.muted = true; // autoplay is only allowed when muted
  const type = "audio/mpeg";
  const info: Record<string, unknown> = { mseSupported: "MediaSource" in window && MediaSource.isTypeSupported(type) };
  if (!info.mseSupported) return info;
  const ms = new MediaSource();
  audio.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
  const sb = ms.addSourceBuffer(type);
  const t0 = performance.now();
  let firstPlayMs = -1;
  const fetched: number[] = [];
  for (let i = 0; i < addrs.length; i++) {
    const t = performance.now();
    const data = await getChunk(addrs[i]);
    fetched.push(Math.round(performance.now() - t));
    sb.appendBuffer(data);
    await new Promise((r) => sb.addEventListener("updateend", r, { once: true }));
    if (i === 0) {
      try { await audio.play(); firstPlayMs = Math.round(performance.now() - t0); } catch (e) { info.playError = String(e); }
    }
  }
  ms.endOfStream();
  await new Promise((r) => setTimeout(r, 1500));
  Object.assign(info, {
    chunks: addrs.length, fetchMsPerChunk: fetched, firstSoundMs: firstPlayMs,
    bufferedSec: audio.buffered.length ? Math.round(audio.buffered.end(audio.buffered.length - 1)) : 0,
    currentTime: Math.round(audio.currentTime * 10) / 10, durationSec: Math.round(audio.duration), paused: audio.paused, error: audio.error?.message ?? null,
  });
  return info;
}

Object.assign(window, { spike: { api, limits, publishMp3, stream } });
