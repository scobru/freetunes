import "./style.css";
import {
  blockReleases, fmtTime, getChunk, LICENSES, listRelease, loadDirectory, loadRelease, makeCover, publishRelease,
  flushKnown, putChunk, splitMp3, storeGet, storePut, Streamer, type ChunkRef, type Mp3Piece, type TrackMeta,
} from "./lib";

const app = document.getElementById("app")!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const $ = <T extends HTMLElement>(sel: string, root: ParentNode = app) => root.querySelector(sel) as T;
// page URL without the container's ?__sandbox=1 query
const pageUrl = (hash: string) => `${location.protocol}//${location.host}${location.pathname}${hash}`;

const CHUNK_BYTES = 512 * 1024; // small enough to start playing quickly, far below the 50 MiB state limit
const MAX_TRACK_BYTES = 60 * 1024 * 1024;
const MAX_RELEASE_BYTES = 250 * 1024 * 1024;
const MAX_TRACKS = 30;

const RIGHTS_TEXT =
  "I confirm that this music is mine, or in the public domain, or licensed so that I may publish it (for example " +
  "Creative Commons). I understand that it will be public and permanent and that I cannot remove it.";

// route: #/ explore | #/publish | #/r/<instanceB58>.<paramsHex> release | #/admin (not linked anywhere)
function route() {
  // inside the Freenet container, keep the address bar in sync so the URL is shareable
  if (window.parent !== window) parent.postMessage({ __freenet_shell__: true, type: "hash", hash: location.hash || "#/" }, "*");
  const h = location.hash;
  if (h === "#/publish") return publish();
  if (h === "#/admin") return admin();
  const m = h.match(/^#\/r\/([1-9A-HJ-NP-Za-km-z]+)\.([0-9a-f]{96})$/);
  return m ? releasePage(m[1], m[2]) : explore();
}

// ---------------- my releases (kept by the identity delegate, or localStorage as a fallback) ----------------
type Saved = { title: string; artist: string; hash: string };
const myReleases = async (): Promise<Saved[]> => { try { return JSON.parse((await storeGet("releases")) ?? "[]"); } catch { return []; } };
const saveRelease = async (r: Saved) => storePut("releases", JSON.stringify([r, ...(await myReleases())]));

// ---------------- explore ----------------
async function explore() {
  app.innerHTML = `
    <h1>FreeTunes <small>publish and stream music on Freenet</small></h1>
    <p><a class="btn primary" href="#/publish">Publish a release</a></p>
    <div id="mine"></div>
    <h2>Latest releases</h2>
    <div id="list">Loading... (the first visit on a node can take up to 30 s)</div>`;
  void myReleases().then((mine) => {
    if (mine.length) $("#mine").innerHTML = `<h2>Your releases</h2><ul>${mine.map((r) => `<li><a href="${esc(r.hash)}">${esc(r.title)}</a> <span class="muted">by ${esc(r.artist)}</span></li>`).join("")}</ul>`;
  });
  try {
    const rows = Object.entries((await loadDirectory()).entries).sort(([, a], [, b]) => b.ts - a.ts);
    $("#list").innerHTML = rows.length
      ? `<ul>${rows.map(([id, e]) => `<li><a href="#/r/${esc(id)}.${esc(e.params)}">${esc(e.title)}</a> <span class="muted">by ${esc(e.artist)} · ${new Date(e.ts).toLocaleDateString()}</span></li>`).join("")}</ul>`
      : "<p>No releases listed yet.</p>";
  } catch (e) { $("#list").textContent = `Could not load the directory: ${e}`; }
}

// ---------------- publish ----------------
interface Pending { file: File; title: string }

function publish() {
  const tracks: Pending[] = [];
  let cover: File | undefined;
  app.innerHTML = `
    <p><a href="#/">← Back</a></p>
    <h1>Publish a release</h1>
    <p class="notice"><b>Experiment.</b> FreeTunes is unfinished and may lose data. Publish only music you have the right to publish.
      Everything you publish is public and permanent: Freenet has no global delete.</p>
    <input id="artist" placeholder="Artist name" maxlength="80" />
    <input id="title" placeholder="Release title" maxlength="120" />
    <select id="license">${Object.entries(LICENSES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
    <label>Cover (optional) <input id="cover" type="file" accept="image/*" /></label>
    <label>Tracks (MP3, MPEG-1 Layer III) <input id="files" type="file" accept=".mp3,audio/mpeg" multiple /></label>
    <ol id="tracklist"></ol>
    <label><input id="rights" type="checkbox" /> ${esc(RIGHTS_TEXT)}</label>
    <label><input id="list" type="checkbox" checked /> List in the public directory (the title and artist name become discoverable)</label>
    <p><button id="go" type="button" class="primary">Publish</button></p>
    <progress id="bar" max="100" value="0" hidden></progress>
    <p id="msg"></p>`;
  void storeGet("artist").then((a) => { if (a && !$<HTMLInputElement>("#artist").value) $<HTMLInputElement>("#artist").value = a; });

  const drawTracks = () => {
    $("#tracklist").innerHTML = tracks.map((t, i) =>
      `<li><input data-i="${i}" value="${esc(t.title)}" maxlength="120" /> <small class="muted">${(t.file.size / 1048576).toFixed(1)} MB</small> <button data-del="${i}" type="button">Remove</button></li>`).join("");
    app.querySelectorAll<HTMLInputElement>("#tracklist input").forEach((inp) => (inp.oninput = () => (tracks[+inp.dataset.i!].title = inp.value)));
    app.querySelectorAll<HTMLButtonElement>("#tracklist button").forEach((b) => (b.onclick = () => { tracks.splice(+b.dataset.del!, 1); drawTracks(); }));
  };
  $<HTMLInputElement>("#files").onchange = (e) => {
    for (const f of Array.from((e.target as HTMLInputElement).files ?? [])) tracks.push({ file: f, title: f.name.replace(/\.[^.]+$/, "") });
    (e.target as HTMLInputElement).value = "";
    drawTracks();
  };
  $<HTMLInputElement>("#cover").onchange = (e) => (cover = (e.target as HTMLInputElement).files?.[0]);

  $("#go").onclick = async () => {
    const msg = $("#msg"), bar = $<HTMLProgressElement>("#bar"), go = $<HTMLButtonElement>("#go");
    const artist = $<HTMLInputElement>("#artist").value.trim(), title = $<HTMLInputElement>("#title").value.trim();
    const license = $<HTMLSelectElement>("#license").value;
    const problem =
      !artist || !title ? "Artist name and release title are required."
      : !tracks.length ? "Add at least one MP3 track."
      : tracks.length > MAX_TRACKS ? `At most ${MAX_TRACKS} tracks.`
      : tracks.some((t) => !t.title.trim()) ? "Every track needs a title."
      : tracks.some((t) => t.file.size > MAX_TRACK_BYTES) ? `A track is larger than ${MAX_TRACK_BYTES / 1048576} MB.`
      : tracks.reduce((n, t) => n + t.file.size, 0) > MAX_RELEASE_BYTES ? `The release is larger than ${MAX_RELEASE_BYTES / 1048576} MB.`
      : !$<HTMLInputElement>("#rights").checked ? "Please confirm that you have the right to publish this music."
      : "";
    if (problem) return void (msg.textContent = problem);
    go.disabled = true;
    bar.hidden = false;
    try {
      msg.textContent = "Preparing files...";
      const prepared: { title: string; pieces: Mp3Piece[] }[] = [];
      for (const t of tracks) {
        const pieces = splitMp3(new Uint8Array(await t.file.arrayBuffer()), CHUNK_BYTES);
        if (!pieces) throw new Error(`"${t.file.name}" is not an MPEG-1 Layer III MP3.`);
        prepared.push({ title: t.title.trim(), pieces });
      }
      const coverBytes = cover ? await makeCover(cover) : undefined;
      const total = prepared.reduce((n, p) => n + p.pieces.length, 0) + (coverBytes ? 1 : 0);
      let done = 0;
      const tick = () => { bar.value = (++done / total) * 100; msg.textContent = `Publishing... ${done}/${total}`; };

      const coverRef = coverBytes ? { addr: await putChunk(coverBytes), n: coverBytes.length } : undefined;
      if (coverRef) tick();
      const metaTracks: TrackMeta[] = [];
      for (const p of prepared) {
        const chunks: ChunkRef[] = [];
        for (const piece of p.pieces) { chunks.push({ a: await putChunk(piece.data), ms: piece.ms, n: piece.data.length }); tick(); }
        metaTracks.push({ title: p.title, chunks });
      }
      await flushKnown();
      msg.textContent = "Publishing the release...";
      const { instance, params } = await publishRelease({ title, artist, license, rights: true, cover: coverRef, tracks: metaTracks });
      const hash = `#/r/${instance}.${params}`;
      await saveRelease({ title, artist, hash });
      await storePut("artist", artist);
      if ($<HTMLInputElement>("#list").checked) {
        msg.textContent = "Listing in the public directory (a few seconds of proof-of-work)...";
        try { await listRelease(instance, params, title.slice(0, 120), artist.slice(0, 80)); }
        catch (e) { return void (msg.innerHTML = `Published, but listing failed: ${esc(String(e))}. <a href="${esc(hash)}">Open the release</a>`); }
      }
      location.hash = hash;
    } catch (e) {
      void flushKnown(); // keep what was already published, so a retry skips it
      msg.textContent = `Error: ${e}`;
      go.disabled = false;
    }
  };
}

// ---------------- release page ----------------
async function releasePage(instance: string, params: string) {
  app.innerHTML = "<p>Loading...</p>";
  let rel;
  try { rel = await loadRelease(instance, params); }
  catch (e) { return void (app.innerHTML = `<p class="err">Could not load the release: ${esc(String(e))}</p><p><a href="#/">← Back</a></p>`); }
  const m = rel.meta;
  const total = m.tracks.reduce((n, t) => n + t.chunks.reduce((s, c) => s + c.ms, 0), 0);
  app.innerHTML = `
    <p><a href="#/">← All releases</a></p>
    <div class="head">
      <img id="cover" alt="" hidden />
      <div>
        <h1>${esc(m.title)}</h1>
        <p>by <b>${esc(m.artist)}</b></p>
        <p class="muted">${esc(LICENSES[m.license] ?? m.license)} · ${m.tracks.length} track${m.tracks.length === 1 ? "" : "s"} · ${fmtTime(total)}</p>
      </div>
    </div>
    <audio id="player" controls preload="none"></audio>
    <p id="status" class="muted"></p>
    <ol class="tracks">${m.tracks.map((t, i) => `
      <li data-i="${i}"><button type="button" class="play" aria-label="Play ${esc(t.title)}">▶</button>
        <span>${esc(t.title)}</span> <small class="muted">${fmtTime(t.chunks.reduce((s, c) => s + c.ms, 0))}</small></li>`).join("")}</ol>
    <p class="muted">Link to share: <input readonly value="${esc(pageUrl(`#/r/${instance}.${params}`))}" onfocus="this.select()" /></p>
    <p class="notice">The artist declared having the right to publish this music. FreeTunes is an experiment and cannot verify that claim or remove a release.</p>`;

  if (m.cover) {
    void getChunk(m.cover.addr).then((b) => {
      const img = $<HTMLImageElement>("#cover");
      img.src = URL.createObjectURL(new Blob([b as BlobPart], { type: "image/jpeg" }));
      img.hidden = false;
    }).catch(() => {});
  }

  const audio = $<HTMLAudioElement>("#player"), status = $("#status");
  const streamer = new Streamer(audio);
  let current = -1;
  const start = (i: number) => {
    current = i;
    app.querySelectorAll("ol.tracks li").forEach((li, k) => li.classList.toggle("on", k === i));
    status.textContent = "Buffering...";
    void streamer.play(m.tracks[i].chunks, (d, n) => (status.textContent = d < n ? `Buffering ${d}/${n}` : "")).catch((e) => (status.textContent = `Playback failed: ${e}`));
  };
  app.querySelectorAll<HTMLButtonElement>("button.play").forEach((b, i) => (b.onclick = () => start(i)));
  audio.onended = () => { if (current + 1 < m.tracks.length) start(current + 1); };
}

// ---------------- admin: hide releases from the directory with the admin key (hash #/admin) ----------------
async function admin() {
  app.innerHTML = `
    <p><a href="#/">← Back</a></p>
    <h1>Directory admin</h1>
    <p class="muted">Admin secret (hex) and the release ids to hide, one per line. This replaces the whole blocklist.</p>
    <input id="sk" type="password" autocomplete="off" placeholder="Admin secret" />
    <textarea id="bl" rows="6"></textarea>
    <p><button id="go" class="primary" type="button">Publish blocklist</button> <span id="msg"></span></p>`;
  try { $<HTMLTextAreaElement>("#bl").value = (await loadDirectory()).blocked.list.join("\n"); }
  catch (e) { $("#msg").textContent = `Could not load the directory: ${e}`; }
  $("#go").onclick = async () => {
    const list = $<HTMLTextAreaElement>("#bl").value.split("\n").map((l) => l.trim()).filter(Boolean);
    $("#msg").textContent = "Sending...";
    try { await blockReleases($<HTMLInputElement>("#sk").value.trim(), list); $("#msg").textContent = `Done: ${list.length} blocked.`; }
    catch (e) { $("#msg").textContent = `Error: ${e}`; }
  };
}

// start last: route() uses consts declared above (TDZ otherwise)
addEventListener("hashchange", route);
route();
