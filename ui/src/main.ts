import "./style.css";
import {
  APP_PATH_HEX, blockReleases, deleteRelease, finishSignIn, flushKnown, officialWhoiam, fmtTime, getChunk,
  isRemoved, LICENSES, listRelease, loadComments, loadDirectory, loadRelease, makeCover, onRemoteChange, peekIdentity, personaName, publishRelease,
  postComment, putChunk, removeComment, signOut, takeDownOld, splitMp3, startSignIn, storeGet, storePut, Streamer, updateRelease,
  watchRelease, loadReports, reportsFor, sendReport, ReportDeclined, WHOLE_RELEASE, type ReportsState, type Kind, type ChunkRef, type CommentsState, type Identity, type Mp3Piece, type Release, type TrackMeta,
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
  "Creative Commons). I understand that it will be public and permanent: Freenet cannot erase it.";

const ICON_PLAY = `<svg class="play-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5v13l11-6.5z"/></svg>`;
const ICON_CHAT = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5h12v8H8.5L5 13.5v-3H2z"/></svg>`;
const ICON_FLAG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5h1.5V15H3zM5 2h8l-2 3 2 3H5z"/></svg>`;
const ICON_PAUSE = `<svg class="pause-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5h3.5v13H3zM9.5 1.5H13v13H9.5z"/></svg>`;

// route: #/ explore | #/publish | #/identity | #/r/<id>.<params> | #/edit/<id>.<params> | #/a/<owner key> artist | #/admin (not linked anywhere)
function route() {
  // inside the Freenet container, keep the address bar in sync so the URL is shareable
  if (window.parent !== window) parent.postMessage({ __freenet_shell__: true, type: "hash", hash: location.hash || "#/" }, "*");
  const h = location.hash;
  const q = new URLSearchParams(location.search);
  if (q.has("whoiam")) return signInCallback(q);
  const here = h === "#/publish" ? "publish" : h === "#/identity" ? "identity" : h === "" || h === "#/" ? "explore" : "";
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((a) => a.toggleAttribute("aria-current", a.dataset.nav === here));
  window.scrollTo(0, 0);
  if (h === "#/publish") return publishPage();
  if (h === "#/identity") return identityPage();
  if (h === "#/admin") return admin();
  const ar = h.match(/^#\/a\/([0-9a-f]{64})$/);
  if (ar) return artistPage(ar[1]);
  const m = h.match(/^#\/(r|edit)\/([1-9A-HJ-NP-Za-km-z]+)\.([0-9a-f]{96,})$/);
  if (m?.[1] === "edit") return editPage(m[2], m[3]);
  return m ? releasePage(m[2], m[3]) : explore();
}

// ---------------- helpers ----------------
const hueOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;

const coverCache = new Map<string, Promise<string>>();
const coverUrl = (addr: string) => {
  let p = coverCache.get(addr);
  if (!p) coverCache.set(addr, (p = getChunk(addr).then((b) => URL.createObjectURL(new Blob([b as BlobPart], { type: "image/jpeg" })))));
  return p;
};

/** Cover art: a gradient from the id until the real image loads (see `lazyCovers`). */
const art = (id: string, title: string, cover?: string, cls = "") =>
  `<div class="art ${cls}" style="--h:${hueOf(id)}"><span>${esc((title.trim()[0] ?? "♪"))}</span>${cover ? `<img data-cover="${esc(cover)}" alt="" />` : ""}</div>`;

/** Load covers only when they scroll into view: every one is a separate fetch from the node. */
function lazyCovers(root: ParentNode) {
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    io.unobserve(e.target);
    const img = e.target as HTMLImageElement;
    void coverUrl(img.dataset.cover!).then((u) => { img.src = u; img.classList.add("on"); img.parentElement?.classList.add("loaded"); }).catch(() => {});
  }), { rootMargin: "200px" });
  root.querySelectorAll<HTMLImageElement>("img[data-cover]").forEach((i) => io.observe(i));
}

const card = (hash: string, id: string, title: string, artist: string, cover?: string, extra = "") =>
  `<a class="rel" href="${esc(hash)}">${art(id, title, cover)}<b>${esc(title)}</b><small>${esc(artist)}${extra}</small></a>`;

// ---------------- my releases (kept by the identity delegate, or localStorage as a fallback) ----------------
type Saved = { title: string; artist: string; hash: string; cover?: string };
const myReleases = async (): Promise<Saved[]> => { try { return JSON.parse((await storeGet("releases")) ?? "[]"); } catch { return []; } };
const saveRelease = async (r: Saved) => storePut("releases", JSON.stringify([r, ...(await myReleases()).filter((x) => x.hash !== r.hash)]));
const forgetRelease = async (hash: string) => storePut("releases", JSON.stringify((await myReleases()).filter((x) => x.hash !== hash)));
const idOfHash = (hash: string) => hash.split("/")[2]?.split(".")[0] ?? hash;

// ---------------- explore ----------------
async function explore() {
  app.innerHTML = `
    <section class="hero">
      <h1>Music on Freenet.</h1>
      <p>Publish a release, share the link, and anyone can stream it. No accounts, no servers, no payments.</p>
      <a class="btn primary" href="#/publish">Publish a release</a>
    </section>
    <div id="mine"></div>
    <h2>Latest releases</h2>
    <div id="list"><p class="muted">Loading... (the first visit on a node can take up to 30 s)</p></div>`;
  void myReleases().then((all) => {
    // releases from before whoiam personas have 48-byte parameters (96 hex): offer to take them down
    const isOld = (r: Saved) => (r.hash.split(".")[1] ?? "").length === 96;
    const mine = all.filter((r) => !isOld(r)), old = all.filter(isOld);
    $("#mine").innerHTML = (mine.length ? `<h2>Your releases</h2><div class="grid">${mine.map((r) => card(r.hash, idOfHash(r.hash), r.title, r.artist, r.cover)).join("")}</div>` : "") +
      (old.length ? `<h2>Old releases</h2><p class="muted"><small>Published before whoiam sign-in. Taking one down replaces it with a signed notice, as Remove release did; the audio chunks stay on Freenet.</small></p>
        <ul class="old">${old.map((r) => `<li><a href="${esc(r.hash)}">${esc(r.title)}</a> <button type="button" class="danger" data-down="${esc(r.hash)}">Take down</button> <button type="button" data-forget="${esc(r.hash)}">Forget</button> <small class="muted" data-out="${esc(r.hash)}"></small></li>`).join("")}</ul>` : "");
    lazyCovers($("#mine"));
    const out = (h: string) => app.querySelector<HTMLElement>(`[data-out="${CSS.escape(h)}"]`)!;
    app.querySelectorAll<HTMLButtonElement>("[data-down]").forEach((b) => (b.onclick = async () => {
      const h = b.dataset.down!, [inst, params] = h.slice(4).split(".");
      if (!confirm("Take this release down? It cannot be undone.")) return;
      b.disabled = true; out(h).textContent = "Taking down...";
      try { await takeDownOld(inst, params); await forgetRelease(h); void explore(); }
      catch (e) { out(h).textContent = String((e as Error).message ?? e); b.disabled = false; }
    }));
    app.querySelectorAll<HTMLButtonElement>("[data-forget]").forEach((b) => (b.onclick = async () => { await forgetRelease(b.dataset.forget!); void explore(); }));
  });
  try {
    // only releases of this app: an entry is checked against the app path in its own parameters
    const rows = Object.entries((await loadDirectory()).entries).filter(([, e]) => !e.removed && e.params.slice(96) === APP_PATH_HEX).sort(([, a], [, b]) => b.ts - a.ts);
    $("#list").innerHTML = rows.length
      ? `<div class="grid">${rows.map(([id, e]) => card(`#/r/${id}.${e.params}`, id, e.title, e.artist, e.cover, ` · ${new Date(e.ts).toLocaleDateString()}`)).join("")}</div>`
      : `<div class="empty">No releases listed yet. Be the first to publish one.</div>`;
    lazyCovers($("#list"));
  } catch (e) { $("#list").innerHTML = `<p class="err">Could not load the directory: ${esc(String(e))}</p>`; }
}

// ---------------- artist page: the directory entries signed by one key ----------------
async function artistPage(pk: string) {
  app.innerHTML = `<p class="muted">Loading... (the first visit on a node can take up to 30 s)</p>`;
  try {
    const [dir, me] = await Promise.all([loadDirectory(), peekIdentity()]);
    const rows = Object.entries(dir.entries).filter(([, e]) => e.params.slice(0, 64) === pk && !e.removed && e.params.slice(96) === APP_PATH_HEX).sort(([, a], [, b]) => b.ts - a.ts);
    const yours = me?.pk === pk;
    // your own releases that are not in the directory (private links) show up on your page too
    const listed = new Set(rows.map(([id]) => id));
    const unlisted = yours ? (await myReleases()).filter((r) => !listed.has(idOfHash(r.hash))) : [];
    const name = rows[0]?.[1].artist ?? unlisted[0]?.artist ?? "Unknown artist";
    app.innerHTML = `
      <p><a href="#/">← All releases</a></p>
      <p class="eyebrow">Artist</p>
      <h1>${esc(name)}</h1>
      <div class="chips"><span class="chip">${rows.length + unlisted.length} release${rows.length + unlisted.length === 1 ? "" : "s"}</span>
        <span class="chip" title="${esc(pk)}">key ${esc(pk.slice(0, 8))}…</span>${yours ? `<span class="chip hot">you</span>` : ""}</div>
      ${rows.length + unlisted.length ? `<div class="grid">${rows.map(([id, e]) => card(`#/r/${id}.${e.params}`, id, e.title, e.artist, e.cover, ` · ${new Date(e.ts).toLocaleDateString()}`)).join("")}${unlisted.map((r) => card(r.hash, idOfHash(r.hash), r.title, r.artist, r.cover, " · not listed")).join("")}</div>`
        : `<div class="empty">No releases listed in the directory for this artist.</div>`}
      <label class="field share"><span>Link to share</span><input readonly value="${esc(pageUrl(`#/a/${pk}`))}" onfocus="this.select()" /></label>
      <p class="notice">Only releases listed in the public directory appear here. The page is identified by the artist's key, not by the name.</p>`;
    lazyCovers(app);
  } catch (e) { app.innerHTML = `<p class="err">Could not load the artist: ${esc(String(e))}</p>`; }
}

// ---------------- publish / edit ----------------
type Item = { kind: "old"; title: string; chunks: ChunkRef[]; size: number } | { kind: "new"; title: string; file: File };
const sizeOf = (it: Item) => (it.kind === "old" ? it.size : it.file.size);

async function editPage(instance: string, params: string) {
  app.innerHTML = `<p class="muted">Loading...</p>`;
  try {
    const rel = await loadRelease(instance, params);
    const me = await peekIdentity();
    if (me?.pk !== params.slice(0, 64)) return void (app.innerHTML = `<div class="gone"><h1>Not your release</h1><p class="muted">Only the artist who published it can edit it, signed in with the same whoiam persona.</p><a class="btn" href="#/r/${esc(instance)}.${esc(params)}">Back to the release</a></div>`);
    if (rel.meta.deleted) return void (app.innerHTML = `<div class="gone"><h1>Release removed</h1><a class="btn" href="#/">Back</a></div>`);
    if (rel.legacy) return void (app.innerHTML = `<div class="gone"><h1>Cannot edit this release</h1><p class="muted">It was published with an older version of FreeTunes, before editing existed. Publish it again to get a release you can edit.</p><a class="btn" href="#/r/${esc(instance)}.${esc(params)}">Back to the release</a></div>`);
    return releaseForm(rel);
  } catch (e) { app.innerHTML = `<p class="err">Could not load the release: ${esc(String(e))}</p>`; }
}

/** The form to publish a new release, or (with `existing`) to edit one you own. */
function releaseForm(existing?: Release) {
  const edit = !!existing, m = existing?.meta;
  const items: Item[] = (m?.tracks ?? []).map((t) => ({ kind: "old", title: t.title, chunks: t.chunks, size: t.chunks.reduce((n, c) => n + c.n, 0) }));
  let coverFile: File | undefined, removeCover = false;
  const back = edit ? `#/r/${existing.instance}.${existing.params}` : "#/";

  app.innerHTML = `
    <p><a href="${esc(back)}">← Back</a></p>
    <h1>${edit ? "Edit release" : "Publish a release"}</h1>
    <p class="notice"><b>Experiment.</b> FreeTunes is unfinished and may lose data. Publish only music you have the right to publish.
      ${edit ? "Changes replace what listeners see, but audio you already published stays on Freenet while nodes host it." : "Everything you publish is public and permanent: Freenet has no global delete."}</p>

    <div class="card">
      <h2>Details</h2>
      <div class="cols">
        <label class="field"><span>Artist</span><input id="artist" placeholder="Artist name" maxlength="80" value="${esc(m?.artist ?? "")}" /></label>
        <label class="field"><span>Title</span><input id="title" placeholder="Release title" maxlength="120" value="${esc(m?.title ?? "")}" /></label>
      </div>
      <label class="field"><span>About this release (optional)</span>
        <textarea id="about" rows="4" maxlength="2000" placeholder="Credits, recording notes, where to find more, licence details...">${esc(m?.about ?? "")}</textarea></label>
      <label class="field"><span>Licence</span>
        <select id="license">${Object.entries(LICENSES).map(([k, v]) => `<option value="${k}" ${k === (m?.license ?? "own") ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
    </div>

    <div class="card">
      <h2>Cover</h2>
      <div class="cover-pick">
        <div id="prev">${art(existing?.instance ?? "new", m?.title || "♪", m?.cover?.addr)}</div>
        <div>
          <input id="cover" type="file" accept="image/*" />
          ${m?.cover ? `<label class="check"><input id="nocover" type="checkbox" />Remove the cover</label>` : ""}
          <p class="muted"><small>Resized to 600 px in your browser. Optional.</small></p>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Tracks</h2>
      <p class="muted"><small>MP3 files (MPEG-1 Layer III). Up to ${MAX_TRACKS} tracks, ${MAX_TRACK_BYTES / 1048576} MB each.</small></p>
      <ol id="tracklist"></ol>
      <label class="drop" id="drop"><input id="files" type="file" accept=".mp3,audio/mpeg" multiple />
        <b>Drop MP3 files here</b><br /><small>or click to choose</small></label>
    </div>

    <label class="check"><input id="rights" type="checkbox" />${esc(RIGHTS_TEXT)}</label>
    <label class="check" id="list-row" ${edit ? "hidden" : ""}><input id="list" type="checkbox" checked />${edit ? "Update the public directory entry" : "List in the public directory (the title, artist and cover become discoverable)"}</label>
    <div class="actions"><button id="go" type="button" class="primary">${edit ? "Save changes" : "Publish"}</button><span id="msg" class="muted"></span></div>
    <progress id="bar" max="100" value="0" hidden></progress>`;

  if (!edit) void storeGet("artist").then((a) => { if (a && !$<HTMLInputElement>("#artist").value) $<HTMLInputElement>("#artist").value = a; });
  if (existing) { // show the "update directory" option only if the release is listed
    void loadDirectory().then((d) => { const e = d.entries[existing.instance]; if (e && !e.removed) $("#list-row").hidden = false; }).catch(() => {});
  }
  lazyCovers($("#prev"));

  const drawTracks = () => {
    $("#tracklist").innerHTML = items.map((t, i) => `
      <li><span class="n">${i + 1}</span><input data-i="${i}" value="${esc(t.title)}" maxlength="120" aria-label="Track ${i + 1} title" />
        <small class="tag">${(sizeOf(t) / 1048576).toFixed(1)} MB${t.kind === "new" ? " · new" : ""}</small>
        <button data-up="${i}" type="button" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
        <button data-down="${i}" type="button" aria-label="Move down" ${i === items.length - 1 ? "disabled" : ""}>↓</button>
        <button data-del="${i}" type="button" aria-label="Remove track">✕</button></li>`).join("");
    app.querySelectorAll<HTMLInputElement>("#tracklist input").forEach((inp) => (inp.oninput = () => (items[+inp.dataset.i!].title = inp.value)));
    const move = (i: number, d: number) => { [items[i], items[i + d]] = [items[i + d], items[i]]; drawTracks(); };
    app.querySelectorAll<HTMLButtonElement>("#tracklist button").forEach((b) => (b.onclick = () => {
      if (b.dataset.up) move(+b.dataset.up, -1);
      else if (b.dataset.down) move(+b.dataset.down, 1);
      else { items.splice(+b.dataset.del!, 1); drawTracks(); }
    }));
  };
  drawTracks();

  const addFiles = (files: File[]) => {
    files.filter((f) => /\.mp3$/i.test(f.name) || f.type === "audio/mpeg").forEach((f) => items.push({ kind: "new", file: f, title: f.name.replace(/\.[^.]+$/, "") }));
    drawTracks();
  };
  $<HTMLInputElement>("#files").onchange = (e) => { addFiles(Array.from((e.target as HTMLInputElement).files ?? [])); (e.target as HTMLInputElement).value = ""; };
  const drop = $("#drop");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(Array.from(e.dataTransfer?.files ?? [])); };

  $<HTMLInputElement>("#cover").onchange = (e) => {
    coverFile = (e.target as HTMLInputElement).files?.[0];
    if (coverFile) $("#prev").innerHTML = `<div class="art loaded"><img class="on" src="${URL.createObjectURL(coverFile)}" alt="" /></div>`;
  };
  const noCover = app.querySelector<HTMLInputElement>("#nocover");
  if (noCover) noCover.onchange = () => (removeCover = noCover.checked);

  $("#go").onclick = async () => {
    const msg = $("#msg"), bar = $<HTMLProgressElement>("#bar"), go = $<HTMLButtonElement>("#go");
    const artist = $<HTMLInputElement>("#artist").value.trim(), title = $<HTMLInputElement>("#title").value.trim();
    const license = $<HTMLSelectElement>("#license").value;
    const fresh = items.filter((t): t is Extract<Item, { kind: "new" }> => t.kind === "new");
    const problem =
      !artist || !title ? "Artist name and release title are required."
      : !items.length ? "Add at least one MP3 track."
      : items.length > MAX_TRACKS ? `At most ${MAX_TRACKS} tracks.`
      : items.some((t) => !t.title.trim()) ? "Every track needs a title."
      : fresh.some((t) => t.file.size > MAX_TRACK_BYTES) ? `A track is larger than ${MAX_TRACK_BYTES / 1048576} MB.`
      : items.reduce((n, t) => n + sizeOf(t), 0) > MAX_RELEASE_BYTES ? `The release is larger than ${MAX_RELEASE_BYTES / 1048576} MB.`
      : !$<HTMLInputElement>("#rights").checked ? "Please confirm that you have the right to publish this music."
      : "";
    if (problem) return void (msg.textContent = problem);
    go.disabled = true;
    bar.hidden = false;
    try {
      msg.textContent = "Preparing files...";
      const prepared = new Map<Item, Mp3Piece[]>();
      for (const t of fresh) {
        const pieces = splitMp3(new Uint8Array(await t.file.arrayBuffer()), CHUNK_BYTES);
        if (!pieces) throw new Error(`"${t.file.name}" is not an MPEG-1 Layer III MP3.`);
        prepared.set(t, pieces);
      }
      const coverBytes = coverFile ? await makeCover(coverFile) : undefined;
      const total = [...prepared.values()].reduce((n, p) => n + p.length, 0) + (coverBytes ? 1 : 0);
      let done = 0;
      const tick = () => { bar.value = total ? (++done / total) * 100 : 100; msg.textContent = `Publishing... ${done}/${total}`; };

      const cover = coverBytes ? { addr: await putChunk(coverBytes), n: coverBytes.length } : removeCover ? undefined : m?.cover;
      if (coverBytes) tick();
      const tracks: TrackMeta[] = [];
      for (const it of items) {
        if (it.kind === "old") { tracks.push({ title: it.title.trim(), chunks: it.chunks }); continue; }
        const chunks: ChunkRef[] = [];
        for (const piece of prepared.get(it)!) { chunks.push({ a: await putChunk(piece.data), ms: piece.ms, n: piece.data.length }); tick(); }
        tracks.push({ title: it.title.trim(), chunks });
      }
      await flushKnown();
      const meta = { title, artist, license, rights: true, cover, tracks, comments: m?.comments, about: $<HTMLTextAreaElement>("#about").value.trim().slice(0, 2000) || undefined };
      msg.textContent = edit ? "Saving..." : "Publishing the release...";
      let instance: string, params: string;
      if (existing) {
        await updateRelease(existing.instance, existing.params, meta, existing.meta.ts);
        ({ instance, params } = existing);
      } else ({ instance, params } = await publishRelease(meta));
      const hash = `#/r/${instance}.${params}`;
      await saveRelease({ title, artist, hash, cover: cover?.addr });
      await storePut("artist", artist);
      if (!$("#list-row").hidden && $<HTMLInputElement>("#list").checked) {
        msg.textContent = "Updating the public directory (a few seconds of proof-of-work)...";
        try { await listRelease(instance, params, title.slice(0, 120), artist.slice(0, 80), cover?.addr ?? ""); }
        catch (e) { return void (msg.innerHTML = `Saved, but the directory update failed: ${esc(String(e))}. <a href="${esc(hash)}">Open the release</a>`); }
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
  app.innerHTML = `<p class="muted">Loading...</p>`;
  let rel: Release;
  try { rel = await loadRelease(instance, params); }
  catch (e) { return void (app.innerHTML = `<p class="err">Could not load the release: ${esc(String(e))}</p><p><a href="#/">← Back</a></p>`); }
  const m = rel.meta, hash = `#/r/${instance}.${params}`;
  void watchRelease(instance).catch(() => {}); // may not resolve in local mode; only the notification matters

  if (m.deleted) {
    void forgetRelease(hash);
    return void (app.innerHTML = `<div class="gone"><h1>Release removed</h1><p class="muted">The artist took this release down.</p><a class="btn" href="#/">Back to Explore</a></div>`);
  }
  const total = m.tracks.reduce((n, t) => n + t.chunks.reduce((s, c) => s + c.ms, 0), 0);
  app.innerHTML = `
    <p><a href="#/">← All releases</a></p>
    <section class="release">
      ${art(instance, m.title, m.cover?.addr)}
      <div>
        <p class="eyebrow">Release</p>
        <h1>${esc(m.title)}</h1>
        <p class="by">by <a href="#/a/${esc(params.slice(0, 64))}"><b>${esc(m.artist)}</b></a></p>
        <div class="chips">
          <span class="chip hot">${esc(LICENSES[m.license] ?? m.license)}</span>
          <span class="chip">${m.tracks.length} track${m.tracks.length === 1 ? "" : "s"}</span>
          <span class="chip">${fmtTime(total)}</span>
          <span class="chip">${new Date(m.ts).toLocaleDateString()}</span>
        </div>
        <div id="owner" class="owner-tools"></div>
      </div>
    </section>
    ${m.about ? `<div class="card about"><h2>About</h2><p>${esc(m.about)}</p></div>` : ""}
    <div id="changed" class="notice" hidden>The artist updated this release. <a href="#" id="refresh">Refresh</a></div>
    <div class="card player"><audio id="player" controls preload="none"></audio><p id="status" class="muted"></p></div>
    <ol class="tracks">${m.tracks.map((t, i) => `
      <li data-i="${i}"><button type="button" class="play" aria-label="Play ${esc(t.title)}">${ICON_PLAY}${ICON_PAUSE}</button>
        <span class="tt">${esc(t.title)}</span><span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
        <small class="muted">${fmtTime(t.chunks.reduce((s, c) => s + c.ms, 0))}</small>
        <button type="button" class="cbtn" data-c="${i}" aria-expanded="false" aria-label="Comments on ${esc(t.title)}">${ICON_CHAT}<span class="cn"></span></button>
        <button type="button" class="cbtn rbtn" data-r="${i}" aria-expanded="false" aria-label="Report ${esc(t.title)}" title="Report this track">${ICON_FLAG}<span class="rn"></span></button>
        <div class="cpanel" hidden></div><div class="rpanel" hidden></div></li>`).join("")}</ol>
    <div id="reports" class="notice" hidden></div>
    <label class="field share"><span>Link to share</span><input readonly value="${esc(pageUrl(hash))}" onfocus="this.select()" /></label>
    <p class="notice">The artist declared having the right to publish this music. FreeTunes is an experiment and cannot verify that claim or erase a release.
      Think it is not theirs to publish? <a href="#" id="report-release">Report this release</a>.</p>
    <div class="rpanel" id="rel-rpanel" hidden></div>
    <div id="confirm"></div>`;
  lazyCovers(app);

  const audio = $<HTMLAudioElement>("#player"), status = $("#status");
  const streamer = new Streamer(audio);
  const rows = Array.from(app.querySelectorAll<HTMLLIElement>("ol.tracks li"));
  let current = -1;
  const start = (i: number) => {
    current = i;
    rows.forEach((li, k) => { li.classList.toggle("on", k === i); li.classList.remove("playing"); });
    status.textContent = "Buffering...";
    void streamer.play(m.tracks[i].chunks, (d, n) => (status.textContent = d < n ? `Buffering ${d}/${n}` : "")).catch((e) => (status.textContent = `Playback failed: ${e}`));
  };
  rows.forEach((li, i) => ($<HTMLButtonElement>("button.play", li).onclick = () => {
    if (i === current) return void (audio.paused ? audio.play() : audio.pause());
    start(i);
  }));
  audio.onplaying = () => rows[current]?.classList.add("playing");
  audio.onpause = () => rows[current]?.classList.remove("playing");
  audio.onended = () => { if (current + 1 < m.tracks.length) start(current + 1); };

  // ---- comments: everyone reads, only people with an identity write ----
  const owner = params.slice(0, 64);
  let cs: CommentsState = { items: {}, removed: {} };
  let me: Identity | null = null, myName = "";
  const opened = new Set<number>();
  const panels = rows.map((li) => $<HTMLElement>(".cpanel", li));
  const meReady = peekIdentity().then((i) => (me = i), () => null);
  void Promise.all([storeGet("commentname"), storeGet("artist")]).then(([a, b]) => (myName = a ?? b ?? ""));

  const visible = (t: number) =>
    Object.entries(cs.items).filter(([id, c]) => c.track === t && !isRemoved(params, cs, id)).sort(([, a], [, b]) => a.ts - b.ts);
  const drawCounts = () => rows.forEach((li, t) => { $(".cn", li).textContent = String(visible(t).length || ""); });
  const reloadComments = async () => { cs = await loadComments(m.comments!); drawCounts(); opened.forEach(drawList); };

  function drawList(t: number) {
    const box = $(".clist", panels[t]), items = visible(t);
    box.innerHTML = items.length ? items.map(([id, c]) => `
      <div class="comment"><div class="chead"><b>${esc(c.name || "anonymous")}</b>${c.a === owner ? ` <span class="chip hot">artist</span>` : ""}
        <small class="muted">${esc(c.a.slice(0, 8))}\u2026 \u00b7 ${new Date(c.ts).toLocaleString()}</small></div>
        <p>${esc(c.text)}</p>${me && (me.pk === c.a || me.pk === owner) ? `<button type="button" class="link" data-rm="${id}">Remove</button>` : ""}</div>`).join("")
      : `<p class="muted">No comments on this track yet.</p>`;
    box.querySelectorAll<HTMLButtonElement>("[data-rm]").forEach((b) => (b.onclick = async () => {
      if (b.dataset.sure !== "1") { // two clicks, so a stray click does not remove anything
        b.dataset.sure = "1"; b.textContent = "Click again to remove";
        setTimeout(() => { b.dataset.sure = ""; b.textContent = "Remove"; }, 4000);
        return;
      }
      b.disabled = true; b.textContent = "Removing...";
      try { await removeComment(m.comments!, params, b.dataset.rm!); await reloadComments(); }
      catch (e) { b.textContent = `Error: ${(e as Error).message ?? e}`; }
    }));
  }

  function buildPanel(t: number) {
    const p = panels[t];
    const body = !m.comments
      ? `<p class="muted"><small>Comments are not available on this release${me?.pk === owner && !rel.legacy ? ": edit it to turn them on." : ", which was published before comments existed."}</small></p>`
      : me
        ? `<label class="field"><span>Your name</span><input class="cname" maxlength="40" value="${esc(myName)}" /></label>
           <textarea class="ctext" rows="3" maxlength="500" placeholder="Write a comment"></textarea>
           <div class="actions"><button type="button" class="primary cpost">Post comment</button><span class="cmsg muted"></span></div>`
        : `<div class="notice"><b>Only people with an identity can comment.</b> Everyone can read. <a href="#/identity">Create or import an identity</a> to join in.</div>`;
    p.innerHTML = `<div class="clist"></div>${body}`;
    drawList(t);
    const btn = p.querySelector<HTMLButtonElement>(".cpost");
    if (btn) btn.onclick = async () => {
      const name = $<HTMLInputElement>(".cname", p).value.trim(), text = $<HTMLTextAreaElement>(".ctext", p).value.trim(), msg = $(".cmsg", p);
      if (!text) return void (msg.textContent = "Write something first.");
      btn.disabled = true; msg.textContent = "Posting (a second of proof-of-work)...";
      try {
        await postComment(m.comments!, params, t, name, text);
        myName = name; void storePut("commentname", name);
        $<HTMLTextAreaElement>(".ctext", p).value = ""; msg.textContent = "";
        await reloadComments();
      } catch (e) { msg.textContent = `Error: ${(e as Error).message ?? e}`; }
      btn.disabled = false;
    };
  }

  rows.forEach((li, t) => ($<HTMLButtonElement>(".cbtn", li).onclick = (e) => {
    const open = panels[t].hidden;
    panels[t].hidden = !open;
    (e.currentTarget as HTMLElement).setAttribute("aria-expanded", String(open));
    if (open) { opened.add(t); buildPanel(t); } else opened.delete(t);
  }));
  void meReady.then(() => opened.forEach(buildPanel)); // the identity may arrive after a panel was opened
  if (m.comments) {
    void loadComments(m.comments).then((st) => { cs = st; drawCounts(); opened.forEach(drawList); }).catch(() => {});
    void watchRelease(m.comments).catch(() => {});
  }

  // ---- reports: anyone can report (ante proof of work against spam); a report is public information, it hides nothing ----
  let rs: ReportsState = { reports: {} };
  const drawReports = () => {
    const all = reportsFor(rs, instance), box = $("#reports");
    rows.forEach((li, t) => { const n = all.filter((r) => r.track === t).length; $(".rn", li).textContent = String(n || ""); });
    const copyright = all.filter((r) => r.kind === "copyright").length;
    box.hidden = !all.length;
    box.innerHTML = all.length
      ? `<b>${all.length} report${all.length === 1 ? "" : "s"}</b> about this release${copyright ? ` (${copyright} about copyright)` : ""}. Reports are claims, not verdicts: nothing is hidden automatically.`
      : "";
  };
  const reloadReports = async () => { rs = await loadReports(); drawReports(); };
  const reportPanels = rows.map((li) => $<HTMLElement>(".rpanel", li));
  function buildReport(panel: HTMLElement, track: number, what: string) {
    panel.innerHTML = `
      <p><b>Report ${esc(what)}</b></p>
      <div class="radios">
        <label><input type="radio" name="k${track}" value="copyright" checked /> It may infringe copyright</label>
        <label><input type="radio" name="k${track}" value="illegal" /> It is illegal content</label>
        <label><input type="radio" name="k${track}" value="other" /> Something else</label>
      </div>
      <textarea class="rnote" rows="3" maxlength="300" placeholder="What is wrong? For copyright: who owns the rights, where to check."></textarea>
      <label class="field"><span>Contact (optional, public)</span><input class="rcontact" maxlength="100" /></label>
      <p class="muted"><small>To keep spam out, your Freenet node asks you to allow a few seconds of proof of work (<a href="https://github.com/soudasuwa/ante" target="_blank" rel="noopener noreferrer">ante</a>). The report is public and permanent.</small></p>
      <div class="actions"><button type="button" class="primary rsend">Send report</button><span class="rmsg muted"></span></div>`;
    const btn = $<HTMLButtonElement>(".rsend", panel), msg = $(".rmsg", panel);
    btn.onclick = async () => {
      const kind = (panel.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value ?? "copyright") as Kind;
      const note = $<HTMLTextAreaElement>(".rnote", panel).value, contact = $<HTMLInputElement>(".rcontact", panel).value;
      if (kind === "other" && !note.trim()) return void (msg.textContent = "Say what is wrong.");
      btn.disabled = true;
      try {
        await sendReport({ target: instance, track, kind, note, contact }, (t) => (msg.textContent = t));
        panel.innerHTML = `<p class="ok">Thank you. Your report was sent.</p>`;
        await reloadReports();
      } catch (e) {
        msg.textContent = e instanceof ReportDeclined ? "Cancelled: nothing was sent." : `Error: ${(e as Error).message ?? e}`;
        btn.disabled = false;
      }
    };
  }
  rows.forEach((li, t) => ($<HTMLButtonElement>(".rbtn", li).onclick = (e) => {
    const open = reportPanels[t].hidden;
    reportPanels[t].hidden = !open;
    (e.currentTarget as HTMLElement).setAttribute("aria-expanded", String(open));
    if (open) buildReport(reportPanels[t], t, `“${m.tracks[t].title}”`);
  }));
  $("#report-release").onclick = (e) => {
    e.preventDefault();
    const panel = $("#rel-rpanel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) buildReport(panel, WHOLE_RELEASE, `the release “${m.title}”`);
  };
  void reloadReports().catch(() => {}); // after the rest is loaded: the first visitor on a node creates the contract

  // any subscribed contract can notify us: look at what changed
  const off = onRemoteChange(async () => {
    if (location.hash !== hash) return;
    try { if ((await loadRelease(instance, params)).meta.ts !== m.ts) $("#changed").hidden = false; } catch { /* keep the page as it is */ }
    if (m.comments) { try { await reloadComments(); } catch { /* keep the page as it is */ } }
  });
  window.addEventListener("hashchange", off, { once: true });
  $("#refresh").onclick = (e) => { e.preventDefault(); void releasePage(instance, params); };

  // owner tools: only the artist's own key matches the first 32 bytes of the contract parameters
  if (params.length > 96) { // the owner is a whoiam persona (releases from before personas carry no app path)
    const p = params.slice(0, 64);
    $(".chips").insertAdjacentHTML("beforeend", `<span class="chip hot" title="whoiam persona ${esc(personaName(p))}">whoiam ${esc(personaName(p).slice(0, 8))}\u2026</span>`);
  }
  void meReady.then((id) => {
    if (id?.pk !== params.slice(0, 64)) return;
    if (rel.legacy) { // the node would refuse every change, so do not offer them
      $("#owner").innerHTML = `<p class="muted"><small>Published with an older version of FreeTunes: it cannot be edited or removed. Publish it again for a release you can edit.</small></p>`;
      return;
    }
    $("#owner").innerHTML = `<a class="btn" href="#/edit/${esc(instance)}.${esc(params)}">Edit release</a><button id="del" class="danger" type="button">Remove release</button>`;
    $("#del").onclick = () => confirmRemoval(rel);
  });
}

/** Owner only: take the release down. Explained plainly, because the audio itself cannot be erased from Freenet. */
function confirmRemoval(rel: Release) {
  const box = $("#confirm");
  box.innerHTML = `<div class="confirm">
    <h3>Remove this release?</h3>
    <p>It disappears from FreeTunes and from the public directory, and the release is replaced by a notice that you removed it.</p>
    <p><b>Freenet cannot erase data.</b> The audio files stay on the network while nodes host them, and anyone who already has their addresses can still fetch them.</p>
    <label class="check"><input id="understand" type="checkbox" />I understand that this does not erase the audio from Freenet.</label>
    <div class="actions"><button id="yes" class="danger" type="button" disabled>Remove release</button><button id="no" type="button">Cancel</button><span id="rmsg" class="muted"></span></div></div>`;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  $<HTMLInputElement>("#understand").onchange = (e) => ($<HTMLButtonElement>("#yes").disabled = !(e.target as HTMLInputElement).checked);
  $("#no").onclick = () => (box.innerHTML = "");
  $("#yes").onclick = async () => {
    const msg = $("#rmsg"), yes = $<HTMLButtonElement>("#yes");
    yes.disabled = true;
    try {
      msg.textContent = "Removing...";
      await deleteRelease(rel.instance, rel.params, rel.meta.ts);
      const entry = (await loadDirectory()).entries[rel.instance];
      if (entry && !entry.removed) {
        msg.textContent = "Removing it from the public directory (a few seconds of proof-of-work)...";
        await listRelease(rel.instance, rel.params, entry.title, entry.artist, entry.cover ?? "", true);
      }
      await forgetRelease(`#/r/${rel.instance}.${rel.params}`);
      location.hash = "#/";
    } catch (e) { msg.textContent = `Error: ${e}`; yes.disabled = false; }
  };
}

// ---------------- identity ----------------

/** Publishing needs an identity. Listening does not, so nothing asks for one until the user chooses to. */
async function publishPage() {
  if (await peekIdentity()) return releaseForm();
  app.innerHTML = `
    <h1>Publish a release</h1>
    <div class="card">
      <h2>First, sign in</h2>
      <p class="muted">Your releases belong to your <b>whoiam</b> persona, which proves they are yours and lets you edit or remove them from any node.</p>
      <div class="actions"><a class="btn primary" href="#/identity">Sign in with whoiam</a></div>
    </div>`;
}

/** Sign in with a whoiam persona (once per node), set the artist name, sign out. */
async function identityPage() {
  app.innerHTML = `<h1>Identity</h1><div id="idbox"><p class="muted">Loading...</p></div>`;
  const box = $("#idbox");
  let me: Identity | null;
  try { me = await peekIdentity(); } catch (e) { box.innerHTML = `<p class="err">Could not read the identity: ${esc(String(e))}</p>`; return; }

  if (!me) {
    const saved = (await storeGet("whoiam-url")) || officialWhoiam();
    box.innerHTML = `
      <p class="muted">Your identity is your <b>whoiam</b> persona: the same one you use in other Freenet apps. Sign in once on this node: whoiam opens, you pick a persona, and it lets FreeTunes publish and comment on its behalf. No key or seed is shared, and there is nothing to back up here.</p>
      <div class="card">
        <h2>Sign in with whoiam</h2>
        <label class="field"><span>Address of your whoiam site <small class="muted">(official by default, or paste your own)</small></span><input id="wurl" value="${esc(saved)}" placeholder="${esc(officialWhoiam())}" spellcheck="false" /></label>
        <div class="actions"><button id="wgo" class="primary" type="button">Sign in with whoiam</button><button id="wofficial" type="button">Use official</button><span id="wmsg" class="muted"></span></div>
      </div>`;
    $("#wofficial").onclick = () => { $<HTMLInputElement>("#wurl").value = officialWhoiam(); };
    $("#wgo").onclick = async () => {
      try {
        $("#wmsg").textContent = "Opening whoiam...";
        goTo(await startSignIn($<HTMLInputElement>("#wurl").value.trim()));
      } catch (e) { $("#wmsg").textContent = String((e as Error).message ?? e); }
    };
    return;
  }

  const name = (await storeGet("artist")) ?? "";
  box.innerHTML = `
    <div class="card">
      <h2>Signed in</h2>
      <p>whoiam persona <code title="${esc(me.pk)}">${esc(personaName(me.pk))}</code></p>
      <label class="field"><span>Artist name</span><input id="name" maxlength="80" value="${esc(name)}" placeholder="Used as the default artist when you publish" /></label>
      <div class="actions"><button id="savename" type="button">Save name</button><a class="btn primary" href="#/publish">Publish a release</a><a class="btn" href="#/a/${esc(me.pk)}">Your artist page</a><span id="nmsg" class="muted"></span></div>
    </div>
    <div class="card">
      <h2>Sign out</h2>
      <p class="muted">This node forgets the sign-in. Your releases stay yours: sign in again, here or on another node, to edit them.</p>
      <div class="actions"><button id="out" type="button">Sign out</button></div>
    </div>`;
  $("#savename").onclick = async () => { await storePut("artist", $<HTMLInputElement>("#name").value.trim()); $("#nmsg").textContent = "Saved."; };
  $("#out").onclick = async () => { await signOut(); await identityPage(); };
}

/** Open another page of this node (or any URL outside the sandbox) the way the Freenet shell allows. */
const goTo = (href: string) => (window.parent !== window ? parent.postMessage({ __freenet_shell__: true, type: "navigate", href }, "*") : void (location.href = href));

/** whoiam sent the user back here with its proof (or a refusal). */
async function signInCallback(q: URLSearchParams) {
  app.innerHTML = `<h1>whoiam</h1><p class="muted">Checking the proof...</p>`;
  let html: string;
  try {
    html = `<div class="notice"><b>Signed in</b> as the whoiam persona <code>${esc(personaName(await finishSignIn(q)))}</code>.</div>`;
  } catch (e) {
    html = `<div class="notice"><b>Not signed in.</b> ${esc(String((e as Error).message ?? e))}</div>`;
  }
  history.replaceState(null, "", location.pathname + "#/identity"); // the query must not run twice
  app.innerHTML = `<h1>whoiam</h1>${html}<div class="actions"><a class="btn primary" href="#/identity">Continue</a></div>`;
}

// ---------------- admin: hide releases from the directory with the admin key (hash #/admin) ----------------
async function admin() {
  app.innerHTML = `
    <p><a href="#/">← Back</a></p>
    <h1>Directory admin</h1>
    <p class="muted">Admin secret (hex) and the release ids to hide, one per line. This replaces the whole blocklist.</p>
    <div class="card">
      <input id="sk" type="password" autocomplete="off" placeholder="Admin secret" />
      <textarea id="bl" rows="6" style="margin-top:10px"></textarea>
      <div class="actions"><button id="go" class="primary" type="button">Publish blocklist</button><span id="msg" class="muted"></span></div>
    </div>`;
  try { $<HTMLTextAreaElement>("#bl").value = (await loadDirectory()).blocked.list.join("\n"); }
  catch (e) { $("#msg").textContent = `Could not load the directory: ${e}`; }
  app.insertAdjacentHTML("beforeend", `<h2>Reports</h2><div id="reps" class="card"><p class="muted">Loading...</p></div>`);
  try {
    const all = Object.values((await loadReports()).reports).sort((a, b) => b.ts - a.ts), box = $("#reps");
    const byRelease = new Map<string, typeof all>();
    for (const r of all) byRelease.set(r.target, [...(byRelease.get(r.target) ?? []), r]);
    box.innerHTML = all.length ? [...byRelease].sort(([, a], [, b]) => b.length - a.length).map(([target, rs]) => `
      <div class="rep"><b>${rs.length} report${rs.length === 1 ? "" : "s"}</b> · <code>${esc(target)}</code>
        <button type="button" class="link" data-block="${esc(target)}">Add to blocklist</button>
        ${rs.map((r) => `<p><span class="chip">${esc(r.kind)}</span> ${r.track === WHOLE_RELEASE ? "release" : `track ${r.track + 1}`} · ${esc(r.note || "(no note)")}
          <small class="muted">${r.contact ? `contact: ${esc(r.contact)} · ` : ""}ante ${esc(r.a.slice(0, 8))}… · ${new Date(r.ts).toLocaleString()}</small></p>`).join("")}</div>`).join("")
      : `<p class="muted">No reports.</p>`;
    box.querySelectorAll<HTMLButtonElement>("[data-block]").forEach((b) => (b.onclick = () => {
      const t = $<HTMLTextAreaElement>("#bl"), id = b.dataset.block!;
      if (!t.value.split("\n").includes(id)) t.value = (t.value.trim() ? t.value.trim() + "\n" : "") + id;
      b.textContent = "Added: now publish the blocklist";
    }));
  } catch (e) { $("#reps").innerHTML = `<p class="err">Could not load the reports: ${esc(String(e))}</p>`; }
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
