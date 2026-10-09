import * as ed from "@noble/ed25519";
import { blake3 } from "@noble/hashes/blake3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  FreenetWsApi, ContractKey, ContractContainer, ContractType, WasmContractV1, PutRequest, GetRequest,
  UpdateRequest, UpdateData, UpdateDataType, DeltaUpdate, SubscribeRequest,
  DelegateRequest, type DelegateResponse, type ResponseHandler,
} from "@freenetorg/freenet-stdlib";
import { ApplicationMessageT, ContractCodeT } from "@freenetorg/freenet-stdlib/common";
import {
  ApplicationMessagesT, ClientRequestT, ClientRequestType, DelegateCodeT, DelegateContainerT, DelegateKeyT,
  DelegateRequestType, DelegateType, InboundDelegateMsgT, InboundDelegateMsgType, RegisterDelegateT,
  RelatedContractsT, WasmDelegateV1T,
} from "@freenetorg/freenet-stdlib/client-request";
import chunkWasm from "./chunk.wasm?url";
import releaseWasm from "./release.wasm?url";
import directoryWasm from "./directory.wasm?url";
import identityWasm from "./identity.wasm?url";

const { bytesToHex: hex, hexToBytes: unhex } = ed.etc;
const enc = new TextEncoder();
const bytes = (s: string) => Array.from(enc.encode(s));

// ---- shapes shared with release/src/lib.rs and directory/src/lib.rs ----
export const LICENSES: Record<string, string> = {
  own: "Own work, free to listen",
  "cc-by": "Creative Commons BY",
  "cc-by-sa": "Creative Commons BY-SA",
  cc0: "CC0 (public domain dedication)",
  "public-domain": "Public domain",
};
export interface ChunkRef { a: string; ms: number; n: number } // address, duration, size
export interface TrackMeta { title: string; chunks: ChunkRef[] }
export interface ReleaseMeta {
  title: string; artist: string; license: string; rights: boolean;
  cover?: { addr: string; n: number }; tracks: TrackMeta[]; ts: number;
  /** The artist took the release down (a tombstone: no title, no tracks). */
  deleted?: boolean;
}
export interface DirEntry {
  params: string; title: string; artist: string; cover?: string; removed?: boolean; ts: number; nonce: number; sig: string;
}
export interface DirState { entries: Record<string, DirEntry>; blocked: { ts: number; list: string[]; sig: string } }

// The directory address depends on this admin key (its parameter): changing it creates a new, empty directory.
export const DIRECTORY_ADMIN = "4498bd4c2ab992afa152bc9b968e246cf70dc4fa5a670b23c33e73b8516ce9f3";
const POW_BITS = 18; // must match directory/src/lib.rs (sha256, a few seconds of mining)

// ---------------------------------------------------------------- node connection
interface Waiter { resolve(r: DelegateResponse): void; reject(e: Error): void }
const delegateWaiters: Waiter[] = [];

type Listener = () => void;
const listeners = new Set<Listener>();
/** Called when a contract we subscribed to changes. Returns an unsubscribe function. */
export const onRemoteChange = (l: Listener) => { listeners.add(l); return () => listeners.delete(l); };

let apiP: Promise<FreenetWsApi> | undefined;
export function api(): Promise<FreenetWsApi> {
  return (apiP ??= new Promise((resolve, reject) => {
    const url = new URL(import.meta.env.DEV
      ? `ws://${import.meta.env.VITE_NODE ?? "127.0.0.1:7509"}/v1/contract/command`
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/contract/command`); // the shell only proxies its own origin
    const h: ResponseHandler = {
      onContractPut() {}, onContractGet() {}, onContractUpdate() {}, onContractUpdateNotification: () => listeners.forEach((l) => l()),
      onContractNotFound: () => console.warn("contract not found"),
      onDelegateResponse: (r) => delegateWaiters.shift()?.resolve(r),
      onErr: (e) => console.error(e.cause),
      onOpen: () => resolve(a),
      onClose: () => {
        apiP = undefined;
        delegateWaiters.splice(0).forEach((w) => w.reject(new Error("socket closed"))); // their replies will never come
        reject(new Error("socket closed"));
      },
    };
    const a = new FreenetWsApi(url, h, "");
  }));
}

// The socket can drop right after the page opens (for example while the shell re-authenticates):
// retry a couple of times instead of failing the first load.
async function retrying<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await f(); }
    catch (e) {
      if (i >= tries || !/closed/i.test(String(e))) throw e;
      console.warn(`connection dropped, retrying (${i}/${tries - 1}):`, e);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

// get() responses are matched by arrival order: serialize them
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const p = chain.then(f);
  chain = p.catch(() => {});
  return p;
};

// ---------------------------------------------------------------- contracts
const codes = new Map<string, Promise<{ code: Uint8Array; codeHash: Uint8Array }>>();
const codeOf = (url: string) => {
  let p = codes.get(url);
  if (!p) codes.set(url, (p = fetch(url).then(async (r) => { const code = new Uint8Array(await r.arrayBuffer()); return { code, codeHash: blake3(code) }; })));
  return p;
};

/** Contract key. Instance id = blake3(blake3(wasm) || params), as in freenet-stdlib. */
async function keyOf(wasm: string, params: Uint8Array) {
  const { codeHash } = await codeOf(wasm);
  return new ContractKey(blake3(new Uint8Array([...codeHash, ...params])), codeHash);
}

async function putContract(wasm: string, params: Uint8Array, state: Uint8Array) {
  const { code, codeHash } = await codeOf(wasm);
  const key = await keyOf(wasm, params);
  const contract = new WasmContractV1(new ContractCodeT(Array.from(code), Array.from(codeHash)), Array.from(params), key);
  await (await api()).put(new PutRequest(new ContractContainer(ContractType.WasmContractV1, contract), Array.from(state), new RelatedContractsT()));
  return key.encode();
}

// full keys (instance + code hash) learned from get(); UPDATE needs the code hash
const keys = new Map<string, ContractKey>();
const fullKey = (instance: string) => keys.get(instance) ?? ContractKey.fromInstanceId(instance);

/** Raw state of a contract. */
export const getState = (instance: string) =>
  serial(() => retrying(async () => {
    const r = await (await api()).get(new GetRequest(fullKey(instance), false));
    if (r.key?.codePart()?.length === 32) keys.set(instance, r.key);
    return new Uint8Array(r.state);
  }));
const getJson = async <T>(instance: string) => JSON.parse(new TextDecoder().decode(await getState(instance))) as T;

async function sendDelta(instance: string, delta: object) {
  const d = new UpdateData(UpdateDataType.DeltaUpdate, new DeltaUpdate(bytes(JSON.stringify(delta))));
  await (await api()).update(new UpdateRequest(fullKey(instance), d));
}

// ---------------------------------------------------------------- identity delegate
// The signing key lives in the node (one per calling web app), so it survives sessions even inside the sandboxed
// container where the page has no storage. If the delegate is missing or silent, fall back to localStorage, then memory.
export interface Identity { pk: string; persisted: boolean; sign: (msg: string) => Promise<string> }

let delegateKey: DelegateKeyT | undefined;
let delegateChain: Promise<unknown> = Promise.resolve();

// Every delegate request, registration included, gets one DelegateResponse with no request id: go one at a time.
function sendDelegate(req: DelegateRequest): Promise<DelegateResponse> {
  const run = async () => {
    let waiter!: Waiter;
    const reply = new Promise<DelegateResponse>((resolve, reject) => {
      waiter = { resolve, reject };
      delegateWaiters.push(waiter);
      setTimeout(() => {
        const i = delegateWaiters.indexOf(waiter);
        if (i >= 0) { delegateWaiters.splice(i, 1); reject(new Error("delegate timeout")); }
      }, 8000);
    });
    const a = (await api()) as unknown as { sendRequest(r: ClientRequestT): void }; // the SDK has no delegate method yet
    a.sendRequest(new ClientRequestT(ClientRequestType.DelegateRequest, req));
    return reply;
  };
  const p = delegateChain.then(run);
  delegateChain = p.catch(() => {});
  return p;
}

async function registerDelegate() {
  const code = new Uint8Array(await (await fetch(identityWasm)).arrayBuffer());
  const codeHash = blake3(code);
  delegateKey = new DelegateKeyT(Array.from(blake3(codeHash)), Array.from(codeHash)); // empty params: blake3(codeHash)
  const wasm = new WasmDelegateV1T([], new DelegateCodeT(Array.from(code), Array.from(codeHash)), delegateKey);
  const container = new DelegateContainerT(DelegateType.WasmDelegateV1, wasm);
  // the node ignores cipher and nonce (secrets use a node-side key) but still checks their sizes
  await sendDelegate(new DelegateRequest(DelegateRequestType.RegisterDelegate, new RegisterDelegateT(container, new Array(32).fill(0), new Array(24).fill(0))));
}

// every delegate operation is safe to repeat (init keeps the first key, the rest are reads, signatures and overwrites)
const callDelegate = (payload: object) => retrying(() => callDelegateOnce(payload));

async function callDelegateOnce(payload: object): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const msg = new InboundDelegateMsgT(InboundDelegateMsgType.common_ApplicationMessage, new ApplicationMessageT(bytes(JSON.stringify(payload)), [], false));
  const r = await sendDelegate(new DelegateRequest(DelegateRequestType.ApplicationMessages, new ApplicationMessagesT(delegateKey, [], [msg])));
  // duck-typed: bundlers can duplicate the SDK classes, which breaks instanceof
  const m = r.values.map((v) => v.inbound).find((x) => Array.isArray((x as ApplicationMessageT | null)?.payload)) as ApplicationMessageT | undefined;
  if (!m) throw new Error("empty delegate reply");
  const out = JSON.parse(new TextDecoder().decode(new Uint8Array(m.payload)));
  if (out.err) throw new Error(out.err);
  return out;
}

let delegateIdentity: Promise<Identity | null> | undefined;
function viaDelegate(): Promise<Identity | null> {
  return (delegateIdentity ??= (async () => {
    try {
      const { pk } = await retrying(async () => {
        await registerDelegate();
        let sk: string | null = null;
        try { sk = localStorage.getItem("ft-sk"); } catch { /* sandbox: no storage */ }
        return callDelegate({ op: "init", sk: sk ?? hex(ed.utils.randomPrivateKey()) });
      });
      return { pk, persisted: true, sign: async (msg: string) => (await callDelegate({ op: "sign", msg })).sig };
    } catch (e) {
      console.warn("identity delegate unavailable, using a local key:", e);
      return null;
    }
  })());
}

let memKey: string | undefined;
export async function identity(): Promise<Identity> {
  const d = await viaDelegate();
  if (d) return d;
  let h: string | null | undefined, persisted = true;
  try { h = localStorage.getItem("ft-sk"); } catch { persisted = false; h = memKey; }
  if (!h) {
    h = hex(ed.utils.randomPrivateKey());
    try { localStorage.setItem("ft-sk", h); } catch { persisted = false; }
  }
  memKey = h;
  const sk = unhex(h);
  return { pk: hex(await ed.getPublicKeyAsync(sk)), persisted, sign: async (m) => hex(await ed.signAsync(enc.encode(m), sk)) };
}

// small per-app store (artist name, my releases): the delegate when available, else localStorage, else memory
const mem = new Map<string, string>();
export async function storeGet(key: string): Promise<string | null> {
  const d = await viaDelegate();
  let local: string | null = null;
  try { local = localStorage.getItem(`ft-${key}`); } catch { /* sandbox: no storage */ }
  if (d) { try { return (await callDelegate({ op: "get", key })).value ?? local; } catch { /* use local */ } }
  return local ?? mem.get(key) ?? null;
}
export async function storePut(key: string, value: string) {
  mem.set(key, value);
  try { localStorage.setItem(`ft-${key}`, value); } catch { /* sandbox: no storage */ }
  if (await viaDelegate()) { try { await callDelegate({ op: "put", key, value }); } catch (e) { console.warn("delegate store failed:", e); } }
}

// ---------------------------------------------------------------- chunks
// Publishing a chunk the node already hosts is never answered, and the stale request would then misalign the
// replies to every later one. So: skip addresses we know are published, and treat a silent put as "already there".
const PUT_TIMEOUT_MS = 8000;
const MAX_KNOWN = 4000; // the delegate store holds 256 KB, about 4000 addresses
let known: Set<string> | undefined;
const loadKnown = async () => (known ??= new Set<string>(JSON.parse((await storeGet("chunks")) ?? "[]")));

/** Remember published chunk addresses (call after a batch of putChunk). */
export async function flushKnown() {
  if (known) await storePut("chunks", JSON.stringify([...known].slice(-MAX_KNOWN)));
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/** Drop the socket: this clears requests the node will never answer. */
async function resetSocket() {
  const a = (await api()) as unknown as { ws?: { close(): void } };
  a.ws?.close();
  await new Promise((r) => setTimeout(r, 300)); // let onClose clear the cached connection
}

/** Publish one chunk (audio or cover). Its address is derived from its content. */
export async function putChunk(content: Uint8Array): Promise<string> {
  const params = blake3(content);
  const addr = (await keyOf(chunkWasm, params)).encode();
  const seen = await loadKnown();
  if (seen.has(addr)) return addr;
  const put = retrying(() => putContract(chunkWasm, params, content));
  try { await withTimeout(put, PUT_TIMEOUT_MS); }
  catch (e) {
    put.catch(() => {}); // abandoned: it may still fail when the socket is reset
    if (!/timeout/.test(String(e))) throw e;
    await resetSocket();
    try { await withTimeout(getState(addr), PUT_TIMEOUT_MS); } // there if the node already hosted it
    catch { throw new Error("the node did not accept a chunk"); }
  }
  seen.add(addr);
  return addr;
}
/** Fetch a chunk and check it against its address. */
export async function getChunk(addr: string): Promise<Uint8Array> {
  return getState(addr); // the contract refuses to store anything that does not hash to the address
}

// ---------------------------------------------------------------- releases
export interface Release {
  instance: string; params: string; meta: ReleaseMeta;
  /** Published with an older release contract (before editing existed). The node refuses any change to it. */
  legacy: boolean;
}

/** Publish a release. Parameters = owner pubkey || random salt, so one artist can publish any number of releases. */
export async function publishRelease(meta: Omit<ReleaseMeta, "ts">) {
  const me = await identity();
  const params = me.pk + hex(crypto.getRandomValues(new Uint8Array(16)));
  const meta_json = JSON.stringify({ ...meta, ts: Date.now() });
  const sig = await me.sign(`ftr1|${params}|${meta_json}`);
  const instance = await retrying(() => putContract(releaseWasm, unhex(params), enc.encode(JSON.stringify({ meta_json, sig }))));
  return { instance, params };
}

export async function loadRelease(instance: string, params: string): Promise<Release> {
  const s = await getJson<{ meta_json: string; sig: string }>(instance);
  const blank: ReleaseMeta = { title: "", artist: "", license: "own", rights: false, tracks: [], ts: 0 };
  // the key learned from the node carries the code hash the release was published with
  const have = keys.get(instance)?.codePart(), now = (await codeOf(releaseWasm)).codeHash;
  const legacy = !!have && hex(have) !== hex(now);
  return { instance, params, legacy, meta: { ...blank, ...JSON.parse(s.meta_json) } as ReleaseMeta };
}

/** Sign a new state and send it to the release contract. A newer timestamp wins, so it must beat the current one. */
async function pushState(instance: string, params: string, meta: object, current: number) {
  const me = await identity(); // must be the release owner
  const meta_json = JSON.stringify({ ...meta, ts: Math.max(Date.now(), current + 1) });
  const sig = await me.sign(`ftr1|${params}|${meta_json}`);
  try { await retrying(() => sendDelta(instance, { meta_json, sig })); }
  catch (e) {
    // a refused update is never answered: the client only sees a timeout
    if (!/timeout/i.test(String(e))) throw e;
    throw new Error("The node did not accept the change. Releases published with an older version of FreeTunes cannot be edited or removed; otherwise check your connection and try again.");
  }
}

/** Owner only: replace the release with an edited version. `current` is the timestamp of the version being edited. */
export const updateRelease = (instance: string, params: string, meta: Omit<ReleaseMeta, "ts">, current: number) =>
  pushState(instance, params, meta, current);

/**
 * Owner only: take the release down. The state becomes a tombstone without any reference to the audio. The chunks
 * themselves stay on Freenet for as long as nodes host them, and anyone who already has their addresses can fetch them.
 */
export const deleteRelease = (instance: string, params: string, current: number) =>
  pushState(instance, params, { deleted: true }, current);

/** Follow a release: `onRemoteChange` listeners run when its owner edits or removes it. */
export async function watchRelease(instance: string) {
  await (await api()).subscribe(new SubscribeRequest(fullKey(instance)));
}

// ---------------------------------------------------------------- directory
let dirId: Promise<string> | undefined;
const directoryId = () => (dirId ??= keyOf(directoryWasm, unhex(DIRECTORY_ADMIN)).then((k) => k.encode()));
const EMPTY_DIR = { entries: {}, blocked: { ts: 0, list: [], sig: "" } };

/** Load the directory. The first visitor on a node creates it (empty). */
export async function loadDirectory(): Promise<DirState> {
  const id = await directoryId();
  try { return await getJson<DirState>(id); }
  catch {
    await putContract(directoryWasm, unhex(DIRECTORY_ADMIN), enc.encode(JSON.stringify(EMPTY_DIR)));
    return getJson<DirState>(id);
  }
}

const zeroBits = (h: Uint8Array) => {
  let n = 0;
  for (const b of h) { n += Math.clz32(b) - 24; if (b) break; }
  return n;
};

/** List a release you own, or (with `removed`) take its entry down: sign it and mine the proof-of-work (a few seconds). */
export async function listRelease(instance: string, params: string, title: string, artist: string, cover = "", removed = false) {
  const me = await identity(); // must be the release owner (first 32 bytes of params)
  const ts = Date.now(), msg = `ftl1|${instance}|${params}|${title}|${artist}|${cover}|${ts}|${removed ? 1 : 0}`;
  const sig = await me.sign(msg);
  let nonce = 0;
  while (zeroBits(sha256(enc.encode(`${msg}|${nonce}`))) < POW_BITS) {
    if (++nonce % 20000 === 0) await new Promise((r) => setTimeout(r)); // let the page breathe while mining
  }
  await loadDirectory(); // makes sure it exists and caches its full key for the update
  await sendDelta(await directoryId(), { entries: { [instance]: { params, title, artist, cover, removed, ts, nonce, sig } } });
}

/** Admin only: replace the blocklist (blocked releases disappear from the directory). */
export async function blockReleases(adminSecretHex: string, list: string[]) {
  const ts = Date.now();
  const sig = hex(await ed.signAsync(enc.encode(`ftb1|${ts}|${list.join(",")}`), unhex(adminSecretHex)));
  await loadDirectory();
  await sendDelta(await directoryId(), { blocked: { ts, list, sig } });
}

// ---------------------------------------------------------------- MP3
const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]; // MPEG1 Layer III, kbit/s
const RATES = [44100, 48000, 32000, 0];

/** Length and duration of the MPEG1 Layer III frame at `i`, or null if there is none. */
function frameAt(b: Uint8Array, i: number): { len: number; ms: number } | null {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  if (((b[i + 1] >> 3) & 3) !== 3 || ((b[i + 1] >> 1) & 3) !== 1) return null; // only MPEG1 Layer III for now
  const br = BITRATES[b[i + 2] >> 4], sr = RATES[(b[i + 2] >> 2) & 3];
  if (!br || !sr) return null;
  return { len: Math.floor((144 * br * 1000) / sr) + ((b[i + 2] >> 1) & 1), ms: (1152 * 1000) / sr };
}

export interface Mp3Piece { data: Uint8Array; ms: number }

/**
 * Cut an MP3 into pieces of about `target` bytes that start on a frame boundary, so each one is a valid stand-alone
 * stream. Tags and junk between frames are dropped. Returns null when no frame is found (not an MP3).
 */
export function splitMp3(file: Uint8Array, target: number): Mp3Piece[] | null {
  let pos = 0;
  if (file[0] === 0x49 && file[1] === 0x44 && file[2] === 0x33) { // skip an ID3v2 tag
    pos = 10 + ((file[6] & 0x7f) << 21 | (file[7] & 0x7f) << 14 | (file[8] & 0x7f) << 7 | (file[9] & 0x7f));
  }
  const frames: { off: number; len: number; ms: number }[] = [];
  while (pos < file.length) {
    const f = frameAt(file, pos);
    if (!f || pos + f.len > file.length) { pos++; continue; } // junk or a cut-off last frame: resync
    frames.push({ off: pos, len: f.len, ms: f.ms });
    pos += f.len;
  }
  if (!frames.length) return null;
  const pieces: Mp3Piece[] = [];
  for (let i = 0; i < frames.length;) {
    let j = i, size = 0, ms = 0;
    while (j < frames.length && (size < target || j === i)) { size += frames[j].len; ms += frames[j].ms; j++; }
    const data = new Uint8Array(size);
    let o = 0;
    for (let k = i; k < j; k++) { data.set(file.subarray(frames[k].off, frames[k].off + frames[k].len), o); o += frames[k].len; }
    pieces.push({ data, ms: Math.max(1, Math.round(ms)) });
    i = j;
  }
  return pieces;
}

/** Shrink a cover image to at most 600 px and encode it as JPEG (a few tens of KB). */
export async function makeCover(file: File): Promise<Uint8Array> {
  const img = await createImageBitmap(file);
  const k = Math.min(1, 600 / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * k));
  canvas.height = Math.max(1, Math.round(img.height * k));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  if (!blob) throw new Error("could not encode the cover");
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------- streaming player
const once = (t: EventTarget, ev: string) => new Promise<void>((r) => t.addEventListener(ev, () => r(), { once: true }));

/**
 * Plays a track from its chunks while they arrive: each chunk is appended to a MediaSource as soon as it is
 * fetched and playback starts after the first one. Falls back to downloading everything first when the browser
 * cannot stream MP3 this way.
 */
export class Streamer {
  private gen = 0;
  constructor(private audio: HTMLAudioElement) {}

  async play(chunks: ChunkRef[], onProgress: (done: number, total: number) => void) {
    const gen = ++this.gen;
    const a = this.audio;
    a.pause();
    const canStream = "MediaSource" in window && MediaSource.isTypeSupported("audio/mpeg");
    if (canStream) {
      try { await this.stream(gen, chunks, onProgress); return; }
      catch (e) { if (gen !== this.gen) return; console.warn("streaming failed, downloading instead:", e); }
    }
    const parts: Uint8Array[] = [];
    for (let i = 0; i < chunks.length; i++) {
      parts.push(await getChunk(chunks[i].a));
      if (gen !== this.gen) return;
      onProgress(i + 1, chunks.length);
    }
    a.src = URL.createObjectURL(new Blob(parts as BlobPart[], { type: "audio/mpeg" }));
    await a.play().catch(() => {});
  }

  private async stream(gen: number, chunks: ChunkRef[], onProgress: (done: number, total: number) => void) {
    const a = this.audio, ms = new MediaSource();
    a.src = URL.createObjectURL(ms);
    await once(ms, "sourceopen");
    const sb = ms.addSourceBuffer("audio/mpeg");
    let next = getChunk(chunks[0].a);
    for (let i = 0; i < chunks.length; i++) {
      const data = await next;
      if (gen !== this.gen) return; // another track was chosen
      if (i + 1 < chunks.length) next = getChunk(chunks[i + 1].a); // fetch the next one while this one is appended
      const done = once(sb, "updateend");
      sb.appendBuffer(data as BufferSource);
      await done;
      if (i === 0) await a.play().catch(() => {}); // blocked autoplay: the user presses play
      onProgress(i + 1, chunks.length);
    }
    if (gen === this.gen && ms.readyState === "open") ms.endOfStream();
  }
}

export const fmtTime = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
