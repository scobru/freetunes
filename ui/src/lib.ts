import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  FreenetWsApi, ContractKey, ContractContainer, ContractType, WasmContractV1, PutRequest, GetRequest,
  type ResponseHandler,
} from "@freenetorg/freenet-stdlib";
import { ContractCodeT } from "@freenetorg/freenet-stdlib/common";
import { RelatedContractsT } from "@freenetorg/freenet-stdlib/client-request";
import chunkWasmUrl from "./chunk.wasm?url";

export const hex = bytesToHex;

// ---- node connection ----
let apiP: Promise<FreenetWsApi> | undefined;
export function api(): Promise<FreenetWsApi> {
  return (apiP ??= new Promise((resolve, reject) => {
    const url = new URL(import.meta.env.DEV
      ? `ws://${import.meta.env.VITE_NODE ?? "127.0.0.1:7509"}/v1/contract/command`
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/contract/command`);
    const h: ResponseHandler = {
      onContractPut() {}, onContractGet() {}, onContractUpdate() {}, onContractUpdateNotification() {},
      onContractNotFound: () => console.warn("contract not found"),
      onDelegateResponse() {},
      onErr: (e) => console.error(e.cause),
      onOpen: () => resolve(a),
      onClose: () => { apiP = undefined; reject(new Error("socket closed")); },
    };
    const a = new FreenetWsApi(url, h, "");
  }));
}

// get() responses are matched by arrival order: serialize them
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const p = chain.then(f);
  chain = p.catch(() => {});
  return p;
};

// ---- chunks: content-addressed contracts (see chunk/src/lib.rs) ----
let codeP: Promise<{ code: Uint8Array; codeHash: Uint8Array }> | undefined;
const chunkCode = () =>
  (codeP ??= fetch(chunkWasmUrl).then(async (r) => {
    const code = new Uint8Array(await r.arrayBuffer());
    return { code, codeHash: blake3(code) };
  }));

/** Contract key of a chunk: instance id = blake3(blake3(wasm) || blake3(content)), as in freenet-stdlib. */
async function chunkKey(params: Uint8Array) {
  const { codeHash } = await chunkCode();
  return new ContractKey(blake3(new Uint8Array([...codeHash, ...params])), codeHash);
}

/** Publish one chunk. Returns its address (base58 instance id). */
export async function putChunk(content: Uint8Array): Promise<string> {
  const { code, codeHash } = await chunkCode();
  const params = blake3(content);
  const key = await chunkKey(params);
  const contract = new WasmContractV1(new ContractCodeT(Array.from(code), Array.from(codeHash)), Array.from(params), key);
  const container = new ContractContainer(ContractType.WasmContractV1, contract);
  await (await api()).put(new PutRequest(container, Array.from(content), new RelatedContractsT()));
  return key.encode();
}

/** Fetch one chunk by address. */
export const getChunk = (address: string) =>
  serial(async () => {
    const r = await (await api()).get(new GetRequest(ContractKey.fromInstanceId(address), false));
    return new Uint8Array(r.state);
  });

// ---- MP3: split at frame boundaries so every piece is a valid stand-alone stream ----
const BITRATES_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]; // MPEG1 Layer III
const SAMPLE_RATES = [44100, 48000, 32000, 0];

function frameLength(b: Uint8Array, i: number): number {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0;
  const version = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
  if (version !== 3 || layer !== 1) return 0; // only MPEG1 Layer III for now
  const br = BITRATES_L3[b[i + 2] >> 4], sr = SAMPLE_RATES[(b[i + 2] >> 2) & 3], pad = (b[i + 2] >> 1) & 1;
  if (!br || !sr) return 0;
  return Math.floor((144 * br * 1000) / sr) + pad;
}

/** Cut an MP3 into pieces of about `target` bytes, each starting on a frame boundary. */
export function splitMp3(file: Uint8Array, target: number): Uint8Array[] {
  let pos = 0;
  if (file[0] === 0x49 && file[1] === 0x44 && file[2] === 0x33) { // skip an ID3v2 tag
    pos = 10 + ((file[6] & 0x7f) << 21 | (file[7] & 0x7f) << 14 | (file[8] & 0x7f) << 7 | (file[9] & 0x7f));
  }
  const out: Uint8Array[] = [];
  let start = pos;
  while (pos < file.length) {
    const len = frameLength(file, pos);
    if (!len) { pos++; continue; } // junk between frames: resync
    pos += len;
    if (pos - start >= target) { out.push(file.subarray(start, pos)); start = pos; }
  }
  if (start < file.length) out.push(file.subarray(start));
  return out;
}
