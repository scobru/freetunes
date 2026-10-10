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
import { personaName, verifyProof } from "./whoiam";
import { ANTE_CODE_HASH, REPORT_BITS, WHOLE_RELEASE, challengeBytes, checkProof, clean, grind, reportPurpose, type Kind, type ReportBody } from "./ante";
import { asBytes, cborDecode, cborEncode, enumVariant, mapGet, type CborValue } from "./cbor";
export { WHOLE_RELEASE, KINDS, type Kind } from "./ante";
export { personaName };
import chunkWasm from "./chunk.wasm?url";
import releaseWasm from "./release.wasm?url";
import directoryWasm from "./directory.wasm?url";
import commentsWasm from "./comments.wasm?url";
import identityWasm from "./identity.wasm?url";
import reportsWasm from "./reports.wasm?url";
import anteWasm from "./ante-delegate.wasm?url";

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
  /** Address of the release's comments contract. Absent on releases published before comments existed. */
  comments?: string;
  /** Free text about the release (credits, notes, links), shown on the release page. */
  about?: string;
}
export interface Comment { a: string; name: string; track: number; ts: number; text: string; nonce: number; sig: string; cert: Cert }
export interface Removal { by: string; ts: number; nonce: number; sig: string; cert: Cert }
export interface CommentsState { items: Record<string, Comment>; removed: Record<string, Removal> }
export interface DirEntry {
  params: string; title: string; artist: string; cover?: string; removed?: boolean; ts: number; nonce: number; sig: string; cert: Cert;
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
/** A whoiam delegation: the persona's signature over `wd1.<app key>.<nonce>` for this app's address. */
export interface Cert { base: string; challenge: string; ts: number; sig: string }
/** `pk` is the whoiam persona; `sign` uses the app key it delegated, and `cert` is that delegation. */
export interface Identity { pk: string; cert: Cert; persisted: boolean; sign: (msg: string) => Promise<string> }

let delegateKey: DelegateKeyT | undefined;
let delegateChain: Promise<unknown> = Promise.resolve();

// Every delegate request, registration included, gets one DelegateResponse with no request id: go one at a time.
function sendDelegate(req: DelegateRequest, timeoutMs = 8000): Promise<DelegateResponse> {
  const run = async () => {
    let waiter!: Waiter;
    const reply = new Promise<DelegateResponse>((resolve, reject) => {
      waiter = { resolve, reject };
      delegateWaiters.push(waiter);
      setTimeout(() => {
        const i = delegateWaiters.indexOf(waiter);
        if (i >= 0) { delegateWaiters.splice(i, 1); reject(new Error("delegate timeout")); }
      }, timeoutMs);
    });
    const a = (await api()) as unknown as { sendRequest(r: ClientRequestT): void }; // the SDK has no delegate method yet
    a.sendRequest(new ClientRequestT(ClientRequestType.DelegateRequest, req));
    return reply;
  };
  const p = delegateChain.then(run);
  delegateChain = p.catch(() => {});
  return p;
}

/** Hand a delegate's wasm to the node (idempotent) and return its key: blake3(blake3(wasm)) for empty parameters. */
async function registerWasmDelegate(wasmUrl: string, expectHash?: string): Promise<DelegateKeyT> {
  const code = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const codeHash = blake3(code);
  if (expectHash && hex(codeHash) !== expectHash) throw new Error("unexpected delegate code");
  const key = new DelegateKeyT(Array.from(blake3(codeHash)), Array.from(codeHash));
  const wasm = new WasmDelegateV1T([], new DelegateCodeT(Array.from(code), Array.from(codeHash)), key);
  const container = new DelegateContainerT(DelegateType.WasmDelegateV1, wasm);
  // the node ignores cipher and nonce (secrets use a node-side key) but still checks their sizes
  await sendDelegate(new DelegateRequest(DelegateRequestType.RegisterDelegate, new RegisterDelegateT(container, new Array(32).fill(0), new Array(24).fill(0))));
  return key;
}

/** One application message to a registered delegate; resolves with the payload of its reply. */
async function messageDelegate(key: DelegateKeyT, payload: Uint8Array, timeoutMs?: number): Promise<Uint8Array> {
  const msg = new InboundDelegateMsgT(InboundDelegateMsgType.common_ApplicationMessage, new ApplicationMessageT(Array.from(payload), [], false));
  const r = await sendDelegate(new DelegateRequest(DelegateRequestType.ApplicationMessages, new ApplicationMessagesT(key, [], [msg])), timeoutMs);
  // duck-typed: bundlers can duplicate the SDK classes, which breaks instanceof
  const m = r.values.map((v) => v.inbound).find((x) => Array.isArray((x as ApplicationMessageT | null)?.payload)) as ApplicationMessageT | undefined;
  if (!m) throw new Error(`empty delegate reply (the node sent: ${r.values.map((v) => v.inboundType).join(", ") || "nothing"})`);
  return new Uint8Array(m.payload);
}

async function registerDelegate() {
  delegateKey = await registerWasmDelegate(identityWasm);
}

// every delegate operation is safe to repeat (init keeps the first key, the rest are reads, signatures and overwrites)
const callDelegate = (payload: object) => retrying(() => callDelegateOnce(payload));

async function callDelegateOnce(payload: object): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out = JSON.parse(new TextDecoder().decode(await messageDelegate(delegateKey!, enc.encode(JSON.stringify(payload)))));
  if (out.err) throw new Error(out.err);
  return out;
}

// The delegate is optional: if it is missing or silent we fall back to localStorage, then to memory.
let delegateReady: Promise<boolean> | undefined;
const hasDelegate = () =>
  (delegateReady ??= retrying(registerDelegate).then(() => true, (e) => {
    console.warn("identity delegate unavailable, using the local key store:", e);
    return false;
  }));

/** Where the app key lives. It is disposable: whoiam delegates it, and a lost one is replaced by signing in again. */
interface KeyStore {
  persisted: boolean;
  pk(): Promise<string | null>;
  create(sk: string): Promise<string>; // keeps the existing one, if any
  sign(msg: string): Promise<string>;
}

const delegateStore: KeyStore = {
  persisted: true,
  pk: async () => {
    try { return (await callDelegate({ op: "pubkey" })).pk as string; }
    catch (e) { if (/no identity/.test(String(e))) return null; throw e; }
  },
  create: async (sk) => (await callDelegate({ op: "init", sk })).pk,
  sign: async (msg) => (await callDelegate({ op: "sign", msg })).sig,
};

let memKey: string | null = null;
let lsWorks = true;
const readKey = () => { try { return localStorage.getItem("ft-sk"); } catch { lsWorks = false; return memKey; } };
const writeKey = (h: string) => { memKey = h; try { localStorage.setItem("ft-sk", h); } catch { lsWorks = false; } };
const localStore: KeyStore = {
  get persisted() { return lsWorks; },
  pk: async () => { const h = readKey(); return h ? hex(await ed.getPublicKeyAsync(unhex(h))) : null; },
  create: async (sk) => { if (!readKey()) writeKey(sk); return hex(await ed.getPublicKeyAsync(unhex(readKey()!))); },
  sign: async (msg) => hex(await ed.signAsync(enc.encode(msg), unhex(readKey()!))),
};

const keyStore = async () => ((await hasDelegate()) ? delegateStore : localStore);
/** The app key (hex), created on first use. */
const appKey = async () => { const s = await keyStore(); return (await s.pk()) ?? s.create(hex(ed.utils.randomPrivateKey())); };

// ---- identity: a whoiam persona, through a delegated app key ----
// whoiam signs `wd1.<app key>.<nonce>` for this app's address: "this app key may act for me in FreeTunes"
// (whoiam-delegation, in the freenames repo). The persona owns releases and comments; the app key signs for it.

/** The app's own path: delegations and release parameters are bound to it (in dev, "/"). */
const APP_PATH = location.pathname;
export const APP_PATH_HEX = hex(enc.encode(APP_PATH));

/** The signed-in persona, if its delegation still holds for this node's app key. Never creates anything. */
export async function peekIdentity(): Promise<Identity | null> {
  const raw = await storeGet("session");
  if (!raw) return null;
  const { persona, cert } = JSON.parse(raw) as { persona: string; cert: Cert };
  const s = await keyStore(), k = await s.pk();
  if (!k || cert.challenge.split(".")[1] !== k) return null; // the app key changed: sign in again
  return { pk: persona, cert, persisted: s.persisted, sign: (m) => s.sign(m) };
}

/** The identity, or an error telling the user to sign in. For everything that signs. */
export async function requireIdentity(): Promise<Identity> {
  const me = await peekIdentity();
  if (!me) throw new Error("Sign in with Viso first (Identity in the menu).");
  return me;
}

export const signOut = () => storePut("session", "");

/** The official Viso web contract; any other Viso site on this node can be used instead. */
export const VISO_KEY = "GzHy3jnEtj26EoGqMsBpoawcY378hK9kp91rTcNYiAac";
export const WHOIAM_KEY = VISO_KEY;
export const officialViso = () => `${location.protocol}//${location.host}/v1/contract/web/${VISO_KEY}/`;
export const officialWhoiam = officialViso;
const LINK_MAX_AGE_MS = 10 * 60 * 1000;
/** Our own address without query or hash: Viso binds its proof to it. */
export const linkBase = () => `${location.protocol}//${location.host}${APP_PATH}`;

/** Where to send the user to sign in. Remembers the one-time challenge in the delegate store. */
export async function startSignIn(visoUrl: string): Promise<string> {
  const u = new URL(visoUrl);
  if (u.host !== location.host || !/^\/v[12]\/contract\/web\/[^/]+\/?$/.test(u.pathname)) {
    throw new Error("Paste the address of your Viso site on this node (it starts with the same host as this page).");
  }
  const challenge = `wd1.${await appKey()}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  await storePut("signin-pending", challenge);
  await storePut("whoiam-url", u.origin + u.pathname);
  return `${u.origin}${u.pathname}?connect=v1&challenge=${challenge}&return=${encodeURIComponent(linkBase())}`;
}

/** Handle Viso's callback: check challenge, freshness and signature, then keep the delegation. Returns the persona. */
export async function finishSignIn(q: URLSearchParams): Promise<string> {
  if (q.get("viso") === "denied" || q.get("whoiam") === "denied") throw new Error("You chose not to share a persona.");
  const pending = await storeGet("signin-pending");
  await storePut("signin-pending", ""); // one use: burn it whatever happens next
  const persona = q.get("pk") ?? "";
  const cert: Cert = { base: linkBase(), challenge: q.get("challenge") ?? "", ts: Number(q.get("ts")), sig: q.get("sig") ?? "" };
  if (!pending || cert.challenge !== pending) throw new Error("This sign-in is unknown or was already used. Start again from the Identity page.");
  if (!Number.isFinite(cert.ts) || Math.abs(Date.now() - cert.ts) > LINK_MAX_AGE_MS) throw new Error("The proof is too old or its clock is off. Start again.");
  if (!(await verifyProof({ ...cert, pk: persona }))) throw new Error("Viso signature does not verify.");
  await storePut("session", JSON.stringify({ persona, cert }));
  return persona;
}

// small per-app store (artist name, my releases): the delegate when available, else localStorage, else memory
const mem = new Map<string, string>();
export async function storeGet(key: string): Promise<string | null> {
  const d = await hasDelegate();
  let local: string | null = null;
  try { local = localStorage.getItem(`ft-${key}`); } catch { /* sandbox: no storage */ }
  if (d) { try { return (await callDelegate({ op: "get", key })).value ?? local; } catch { /* use local */ } }
  return local ?? mem.get(key) ?? null;
}
export async function storePut(key: string, value: string) {
  mem.set(key, value);
  try { localStorage.setItem(`ft-${key}`, value); } catch { /* sandbox: no storage */ }
  if (await hasDelegate()) { try { await callDelegate({ op: "put", key, value }); } catch (e) { console.warn("delegate store failed:", e); } }
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

/** Publish a release. Parameters = owner persona || random salt || app path, so one artist can publish any number of releases. */
export async function publishRelease(meta: Omit<ReleaseMeta, "ts">) {
  const me = await requireIdentity();
  const params = me.pk + hex(crypto.getRandomValues(new Uint8Array(16))) + APP_PATH_HEX;
  const comments = meta.comments ?? (await createComments(params));
  const meta_json = JSON.stringify({ ...meta, comments, ts: Date.now() });
  const sig = await me.sign(`ftr1|${params}|${meta_json}`);
  const instance = await retrying(() => putContract(releaseWasm, unhex(params), enc.encode(JSON.stringify({ meta_json, sig, cert: me.cert }))));
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
  const me = await requireIdentity(); // must be the release owner
  const meta_json = JSON.stringify({ ...meta, ts: Math.max(Date.now(), current + 1) });
  const sig = await me.sign(`ftr1|${params}|${meta_json}`);
  try { await retrying(() => sendDelta(instance, { meta_json, sig, cert: me.cert })); }
  catch (e) {
    // a refused update is never answered: the client only sees a timeout
    if (!/timeout/i.test(String(e))) throw e;
    throw new Error("The node did not accept the change. Releases published with an older version of FreeTunes cannot be edited or removed; otherwise check your connection and try again.");
  }
}

/** Owner only: replace the release with an edited version. `current` is the timestamp of the version being edited. */
export const updateRelease = async (instance: string, params: string, meta: Omit<ReleaseMeta, "ts">, current: number) =>
  pushState(instance, params, { ...meta, comments: meta.comments ?? (await createComments(params)) }, current);

/**
 * Owner only: take the release down. The state becomes a tombstone without any reference to the audio. The chunks
 * themselves stay on Freenet for as long as nodes host them, and anyone who already has their addresses can fetch them.
 */
export const deleteRelease = (instance: string, params: string, current: number) =>
  pushState(instance, params, { deleted: true }, current);

/**
 * Take down a release published before whoiam personas (parameters = old node key || salt), signed with that old
 * key, which the identity delegate still holds as the app key. Releases from before editing existed refuse it.
 */
export async function takeDownOld(instance: string, params: string) {
  const s = await keyStore();
  if ((await s.pk()) !== params.slice(0, 64)) throw new Error("This node no longer has the key that published it.");
  const meta_json = JSON.stringify({ deleted: true, ts: Math.max(Date.now(), (await loadRelease(instance, params)).meta.ts + 1) });
  const sig = await s.sign(`ftr1|${params}|${meta_json}`);
  try { await retrying(() => sendDelta(instance, { meta_json, sig })); }
  catch (e) {
    if (!/timeout/i.test(String(e))) throw e; // a refused update is never answered
    throw new Error("The node refused it: this release was published before removal existed.");
  }
}

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

/** Find a nonce so that sha256(`<msg>|<nonce>`) starts with `bits` zero bits (a moment of CPU). */
async function mine(msg: string, bits: number): Promise<number> {
  let nonce = 0;
  while (zeroBits(sha256(enc.encode(`${msg}|${nonce}`))) < bits) {
    if (++nonce % 20000 === 0) await new Promise((r) => setTimeout(r)); // let the page breathe while mining
  }
  return nonce;
}

/** List a release you own, or (with `removed`) take its entry down: sign it and mine the proof-of-work (a few seconds). */
export async function listRelease(instance: string, params: string, title: string, artist: string, cover = "", removed = false) {
  const me = await requireIdentity(); // must be the release owner (first 32 bytes of params)
  const ts = Date.now(), msg = `ftl1|${instance}|${params}|${title}|${artist}|${cover}|${ts}|${removed ? 1 : 0}`;
  const sig = await me.sign(msg);
  const nonce = await mine(msg, POW_BITS);
  await loadDirectory(); // makes sure it exists and caches its full key for the update
  await sendDelta(await directoryId(), { entries: { [instance]: { params, title, artist, cover, removed, ts, nonce, sig, cert: me.cert } } });
}

/** Admin only: replace the blocklist (blocked releases disappear from the directory). */
export async function blockReleases(adminSecretHex: string, list: string[]) {
  const ts = Date.now();
  const sig = hex(await ed.signAsync(enc.encode(`ftb1|${ts}|${list.join(",")}`), unhex(adminSecretHex)));
  await loadDirectory();
  await sendDelta(await directoryId(), { blocked: { ts, list, sig } });
}

// ---------------------------------------------------------------- comments (see comments/src/lib.rs)
const COMMENT_POW_BITS = 16; // must match the contract (about a second of CPU)

/** The comments contract of a release. Its address follows from the release parameters, and anyone can create it. */
export const createComments = (params: string) =>
  retrying(() => putContract(commentsWasm, unhex(params), enc.encode(JSON.stringify({ items: {}, removed: {} }))));

export const loadComments = (addr: string) => getJson<CommentsState>(addr);

/** Post a comment on a track. Needs an identity; the proof-of-work makes spam cost something. */
export async function postComment(addr: string, params: string, track: number, name: string, text: string) {
  const me = await requireIdentity();
  const ts = Date.now(), msg = `ftc1|${params}|${me.pk}|${track}|${ts}|${name}|${text}`;
  const sig = await me.sign(msg), nonce = await mine(msg, COMMENT_POW_BITS);
  const id = hex(sha256(enc.encode(msg))).slice(0, 32); // the contract derives the same id from the content
  await retrying(() => sendDelta(addr, { items: { [id]: { a: me.pk, name, track, ts, text, nonce, sig, cert: me.cert } } }));
}

/** Remove a comment: allowed for its author and for the release owner (anyone else's removal is ignored). */
export async function removeComment(addr: string, params: string, id: string) {
  const me = await requireIdentity();
  const ts = Date.now(), msg = `ftc2|${params}|${id}|${ts}`;
  const sig = await me.sign(msg), nonce = await mine(msg, COMMENT_POW_BITS);
  await retrying(() => sendDelta(addr, { removed: { [`${id}:${me.pk}`]: { by: me.pk, ts, nonce, sig, cert: me.cert } } }));
}

/** Is this comment hidden? Same rule as the contract: a removal by its author or by the release owner. */
export function isRemoved(params: string, s: CommentsState, id: string): boolean {
  const owner = params.slice(0, 64), c = s.items[id];
  return `${id}:${owner}` in s.removed || (!!c && `${id}:${c.a}` in s.removed);
}

// ---------------------------------------------------------------- reports (see reports/src/lib.rs)
// A report is rate-limited by ante (github.com/soudasuwa/ante): the reporter's node signs a proof of work whose purpose
// is bound to this exact report, and the contract checks it. The reporter's own node asks for consent first.
export interface Report extends ReportBody { a: string; proof: string }
export interface ReportsState { reports: Record<string, Report> }

let repId: Promise<string> | undefined;
const reportsId = () => (repId ??= keyOf(reportsWasm, new Uint8Array()).then((k) => k.encode()));

/** All reports. The first visitor on a node creates the (empty) contract. */
export async function loadReports(): Promise<ReportsState> {
  const id = await reportsId();
  try { return await getJson<ReportsState>(id); }
  catch {
    await putContract(reportsWasm, new Uint8Array(), enc.encode(JSON.stringify({ reports: {} })));
    return getJson<ReportsState>(id);
  }
}

/** Reports of one release, newest first. */
export const reportsFor = (s: ReportsState, target: string) =>
  Object.values(s.reports).filter((r) => r.target === target).sort((a, b) => b.ts - a.ts);

const CONSENT_MS = 75_000; // the node keeps the consent prompt open for 60 s
let anteKey: Promise<DelegateKeyT> | undefined;
async function anteCall(req: CborValue, timeoutMs?: number) {
  const key = await (anteKey ??= registerWasmDelegate(anteWasm, ANTE_CODE_HASH).catch((e) => { anteKey = undefined; throw e; }));
  const out = enumVariant(cborDecode(await messageDelegate(key, cborEncode(req), timeoutMs)));
  if (out.variant === "Error") throw new Error(`ante: ${String(mapGet(out.fields!, "message"))}`);
  return out;
}

export interface ReportInput { target: string; track: number; kind: Kind; note: string; contact: string }
export class ReportDeclined extends Error { constructor() { super("You declined to spend the work."); } }

/**
 * File a report: get consent on the reporter's node, grind about a second or two of proof of work, have the node sign
 * it, and send it to the reports contract. `step` narrates what is happening.
 */
export async function sendReport(input: ReportInput, step: (msg: string) => void = () => {}) {
  const body: ReportBody = { ...input, note: clean(input.note, 300), contact: clean(input.contact, 100), ts: Date.now() };
  const purpose = reportPurpose(body);
  step("Opening your ante identity…");
  const vk = asBytes(mapGet((await anteCall("GetIdentity")).fields!, "verifying_key"));
  step("Your Freenet node asks you to allow the work. Approve it there…");
  const grant = await anteCall({ RequestGrind: { purpose, min_bits: REPORT_BITS } }, CONSENT_MS);
  if (grant.variant === "Denied") throw new ReportDeclined();
  const challenge = asBytes(mapGet(grant.fields!, "bytes"));
  if (hex(challenge) !== hex(challengeBytes(purpose, vk))) throw new Error("ante returned an unexpected challenge");
  step("Working… (anti-spam proof, a few seconds)");
  const nonce = await grind(challenge, REPORT_BITS, (n) => step(`Working… ${n.toLocaleString()} tries`));
  step("Signing…");
  const signed = await anteCall({ Commit: { purpose, nonce, min_bits: REPORT_BITS, ts: Date.now() } }, CONSENT_MS);
  if (signed.variant === "Denied") throw new ReportDeclined();
  const proof = asBytes(mapGet(signed.fields!, "proof"));
  await checkProof(proof, purpose); // catch a bad proof here: the node would only answer "Request timeout"
  step("Publishing…");
  await submitReport({ ...body, a: hex(vk), proof: hex(proof) });
}

/** Send a finished report (with its ante proof) to the reports contract. */
export async function submitReport(report: Report) {
  const id = await reportsId();
  await loadReports(); // makes sure it exists and caches its full key for the update
  await retrying(() => sendDelta(id, { reports: { [`${report.target}:${report.track}:${report.a}`]: report } }));
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
