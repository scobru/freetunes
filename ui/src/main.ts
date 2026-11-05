import "./style.css";
import {
  APP_PATH_HEX, blockReleases, createLocalIdentity, deleteRelease, finishSignIn, flushKnown, officialViso, fmtTime, getChunk,
  isRemoved, LICENSES, listRelease, loadComments, loadDirectory, loadRelease, makeCover, onRemoteChange, peekIdentity, personaName, publishRelease,
  localIdentityKey, postComment, putChunk, removeComment, signOut, takeDownOld, splitMp3, startSignIn, storeGet, storePut, Streamer, updateRelease,
  watchRelease, loadReports, reportsFor, sendReport, ReportDeclined, WHOLE_RELEASE,
  FREETUNES_MAINTAINER, FREETUNES_DEFAULT_MODS, isMaintainer, isModerator,
  type ReportsState, type Kind, type ChunkRef, type CommentsState, type Identity, type Mp3Piece, type Release, type TrackMeta, type ReleaseMeta,
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
const ICON_LINK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5l3-3M7 4.5l1.5-1.5a2.5 2.5 0 013.5 3.5L10.5 8M9 11.5L7.5 13A2.5 2.5 0 014 9.5L5.5 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const ICON_PAUSE = `<svg class="pause-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5h3.5v13H3zM9.5 1.5H13v13H9.5z"/></svg>`;

// ---------------- route ----------------
// route: #/ explore | #/artists | #/search[/<query>] | #/publish | #/identity | #/r/<id>.<params>[/<track index>] | #/edit/<id>.<params> | #/a/<owner key> artist | #/admin
function route() {
  // inside the Freenet container, keep the address bar in sync so the URL is shareable
  if (window.parent !== window) parent.postMessage({ __freenet_shell__: true, type: "hash", hash: location.hash || "#/" }, "*");
  const h = location.hash;
  const q = new URLSearchParams(location.search);
  if (q.has("viso") || q.has("whoiam")) return signInCallback(q);
  const here = h === "#/publish" ? "publish" : h === "#/identity" ? "identity" : h === "#/artists" ? "artists" : h === "" || h === "#/" ? "explore" : "";
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((a) => a.toggleAttribute("aria-current", a.dataset.nav === here));
  window.scrollTo(0, 0);

  if (h === "#/publish") return publishPage();
  if (h === "#/identity") return identityPage();
  if (h === "#/admin") return admin();
  if (h === "#/artists") return artistsPage();
  if (h.startsWith("#/search")) {
    const raw = h.slice(8).replace(/^\/?(\?q=)?/, "");
    return searchPage(decodeURIComponent(raw));
  }
  const ar = h.match(/^#\/a\/([0-9a-f]{64})$/);
  if (ar) return artistPage(ar[1]);
  const m = h.match(/^#\/(r|edit)\/([1-9A-HJ-NP-Za-km-z]+)\.([0-9a-f]{96,})(?:\/(\d+))?$/);
  if (m?.[1] === "edit") return editPage(m[2], m[3]);
  return m ? releasePage(m[2], m[3], m[4] ? Number(m[4]) : -1) : explore();
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

// ---------------- track caching & indexing for instant search ----------------
interface CachedTrack {
  albumId: string;
  albumParams: string;
  albumTitle: string;
  artist: string;
  cover?: string;
  trackIndex: number;
  trackTitle: string;
  durationMs: number;
}

let trackCache: CachedTrack[] = [];
try {
  trackCache = JSON.parse(localStorage.getItem("ft-track-cache") || "[]");
} catch {}

function saveTrackCache(tracks: CachedTrack[]) {
  const map = new Map<string, CachedTrack>();
  for (const t of trackCache) map.set(`${t.albumId}:${t.trackIndex}`, t);
  for (const t of tracks) map.set(`${t.albumId}:${t.trackIndex}`, t);
  trackCache = Array.from(map.values()).slice(-2500);
  try { localStorage.setItem("ft-track-cache", JSON.stringify(trackCache)); } catch {}
}

function indexReleaseTracks(instance: string, params: string, meta: ReleaseMeta) {
  if (!meta.tracks) return;
  const list: CachedTrack[] = meta.tracks.map((t, i) => ({
    albumId: instance,
    albumParams: params,
    albumTitle: meta.title,
    artist: meta.artist,
    cover: meta.cover?.addr,
    trackIndex: i,
    trackTitle: t.title,
    durationMs: t.chunks.reduce((s, c) => s + c.ms, 0),
  }));
  saveTrackCache(list);
}

// ---------------- artist profile caching & management ----------------
export interface ArtistProfile {
  avatar?: string;
  bio?: string;
  name?: string;
  updatedAt?: number;
}

const profileCache = new Map<string, ArtistProfile>();

export async function getArtistProfile(pk: string): Promise<ArtistProfile | null> {
  if (profileCache.has(pk)) return profileCache.get(pk)!;
  try {
    const raw = await storeGet(`profile:${pk}`);
    if (raw) {
      const p = JSON.parse(raw) as ArtistProfile;
      profileCache.set(pk, p);
      return p;
    }
  } catch {}
  try {
    const raw = localStorage.getItem(`ft-profile-${pk}`);
    if (raw) {
      const p = JSON.parse(raw) as ArtistProfile;
      profileCache.set(pk, p);
      return p;
    }
  } catch {}
  return null;
}

export async function saveArtistProfile(pk: string, prof: Partial<ArtistProfile>): Promise<ArtistProfile> {
  const existing = await getArtistProfile(pk);
  const merged: ArtistProfile = { ...existing, ...prof, updatedAt: Date.now() };
  profileCache.set(pk, merged);
  const str = JSON.stringify(merged);
  try { localStorage.setItem(`ft-profile-${pk}`, str); } catch {}
  try { await storePut(`profile:${pk}`, str); } catch {}
  return merged;
}

// ---------------- my releases (kept by the identity delegate, or localStorage as a fallback) ----------------
type Saved = { title: string; artist: string; hash: string; cover?: string };
const myReleases = async (): Promise<Saved[]> => { try { return JSON.parse((await storeGet("releases")) ?? "[]"); } catch { return []; } };
const saveRelease = async (r: Saved) => storePut("releases", JSON.stringify([r, ...(await myReleases()).filter((x) => x.hash !== r.hash)]));
const forgetRelease = async (hash: string) => storePut("releases", JSON.stringify((await myReleases()).filter((x) => x.hash !== hash)));
const idOfHash = (hash: string) => hash.split("/")[2]?.split(".")[0] ?? hash;

// ---------------- search catalog logic ----------------
async function searchCatalog(query: string) {
  const q = query.trim().toLowerCase();
  const dir = await loadDirectory().catch(() => ({ entries: {}, blocked: { ts: 0, list: [], sig: "" } }));
  const rows = Object.entries(dir.entries).filter(([, e]) => !e.removed && e.params.slice(96) === APP_PATH_HEX);

  // Group by artist
  const artistMap = new Map<string, { pk: string; name: string; releases: typeof rows; latestCover?: string; latestTs: number }>();
  for (const [id, e] of rows) {
    const pk = e.params.slice(0, 64);
    const ex = artistMap.get(pk);
    if (!ex) {
      artistMap.set(pk, { pk, name: e.artist, releases: [[id, e]], latestCover: e.cover, latestTs: e.ts });
    } else {
      ex.releases.push([id, e]);
      if (e.ts > ex.latestTs) { ex.latestTs = e.ts; ex.name = e.artist; if (e.cover) ex.latestCover = e.cover; }
    }
  }

  const artists = q ? Array.from(artistMap.values()).filter((a) => a.name.toLowerCase().includes(q) || a.pk.startsWith(q)) : Array.from(artistMap.values());
  const albums = q ? rows.filter(([, e]) => e.title.toLowerCase().includes(q) || e.artist.toLowerCase().includes(q)) : rows;
  const tracks = q ? trackCache.filter((t) => t.trackTitle.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.albumTitle.toLowerCase().includes(q)) : trackCache;

  return { artists, albums, tracks, allRows: rows };
}

// ---------------- header search bar ----------------
function initHeaderSearch() {
  const form = document.getElementById("header-search-form") as HTMLFormElement | null;
  const input = document.getElementById("header-search-input") as HTMLInputElement | null;
  const quick = document.getElementById("search-quick-results") as HTMLElement | null;
  if (!form || !input || !quick) return;

  const closeQuick = () => { quick.hidden = true; quick.innerHTML = ""; };

  form.onsubmit = (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) {
      closeQuick();
      location.hash = `#/search/${encodeURIComponent(q)}`;
    }
  };

  let debounceTimer: ReturnType<typeof setTimeout>;
  input.oninput = () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (!q) return closeQuick();
    debounceTimer = setTimeout(async () => {
      try {
        const { artists, albums, tracks } = await searchCatalog(q);
        if (!input.value.trim()) return closeQuick();
        if (!artists.length && !albums.length && !tracks.length) {
          quick.innerHTML = `<div class="quick-empty">No results for “${esc(q)}”. <a href="#/search/${encodeURIComponent(q)}">Open full search</a></div>`;
          quick.hidden = false;
          return;
        }
        quick.innerHTML = `
          ${artists.length ? `
            <div class="quick-section">
              <span class="quick-label">Artists</span>
              ${artists.slice(0, 3).map((a) => `
                <a class="quick-item" href="#/a/${esc(a.pk)}">
                  <span class="quick-dot">●</span>
                  <b>${esc(a.name)}</b>
                  <small class="muted">${a.releases.length} rel</small>
                </a>
              `).join("")}
            </div>
          ` : ""}
          ${albums.length ? `
            <div class="quick-section">
              <span class="quick-label">Albums</span>
              ${albums.slice(0, 3).map(([id, e]) => `
                <a class="quick-item" href="#/r/${id}.${e.params}">
                  <span class="quick-dot">💿</span>
                  <b>${esc(e.title)}</b>
                  <small class="muted">by ${esc(e.artist)}</small>
                </a>
              `).join("")}
            </div>
          ` : ""}
          ${tracks.length ? `
            <div class="quick-section">
              <span class="quick-label">Songs</span>
              ${tracks.slice(0, 3).map((t) => `
                <a class="quick-item" href="#/r/${t.albumId}.${t.albumParams}/${t.trackIndex}">
                  <span class="quick-dot">▶</span>
                  <b>${esc(t.trackTitle)}</b>
                  <small class="muted">${esc(t.artist)}</small>
                </a>
              `).join("")}
            </div>
          ` : ""}
          <a class="quick-all" href="#/search/${encodeURIComponent(q)}">See all results for “${esc(q)}” →</a>
        `;
        quick.hidden = false;
      } catch {}
    }, 180);
  };

  document.addEventListener("click", (e) => {
    if (!form.contains(e.target as Node) && !quick.contains(e.target as Node)) {
      closeQuick();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeQuick();
  });
}

// ---------------- explore ----------------
async function explore() {
  app.innerHTML = `
    <section class="hero">
      <h1>Music on Freenet.</h1>
      <p>Discover, stream, and publish music with no servers and no middleman. Pure peer-to-peer music in Bandcamp style.</p>
      <div class="hero-actions">
        <a class="btn primary" href="#/publish">Publish a release</a>
        <a class="btn" href="#/artists">Browse artists</a>
      </div>
    </section>
    <div id="mine"></div>
    <h2>Latest releases</h2>
    <div id="list"><p class="muted">Loading... (the first visit on a node can take up to 30 s)</p></div>`;

  void myReleases().then((all) => {
    const isOld = (r: Saved) => (r.hash.split(".")[1] ?? "").length === 96;
    const mine = all.filter((r) => !isOld(r)), old = all.filter(isOld);
    $("#mine").innerHTML = (mine.length ? `<h2>Your releases</h2><div class="grid">${mine.map((r) => card(r.hash, idOfHash(r.hash), r.title, r.artist, r.cover)).join("")}</div>` : "") +
      (old.length ? `<h2>Old releases</h2><p class="muted"><small>Published before Viso sign-in. Taking one down replaces it with a signed notice, as Remove release did; the audio chunks stay on Freenet.</small></p>
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
    const rows = Object.entries((await loadDirectory()).entries).filter(([, e]) => !e.removed && e.params.slice(96) === APP_PATH_HEX).sort(([, a], [, b]) => b.ts - a.ts);
    $("#list").innerHTML = rows.length
      ? `<div class="grid">${rows.map(([id, e]) => card(`#/r/${id}.${e.params}`, id, e.title, e.artist, e.cover, ` · ${new Date(e.ts).toLocaleDateString()}`)).join("")}</div>`
      : `<div class="empty">No releases listed yet. Be the first to publish one.</div>`;
    lazyCovers($("#list"));
  } catch (e) { $("#list").innerHTML = `<p class="err">Could not load the directory: ${esc(String(e))}</p>`; }
}

// ---------------- artists directory tab (#/artists) ----------------
async function artistsPage() {
  app.innerHTML = `
    <div class="bc-section-header">
      <div>
        <p class="eyebrow">Catalog</p>
        <h1>All Artists</h1>
        <p class="muted">Musicians, bands, and sound creators publishing on FreeTunes.</p>
      </div>
      <div class="artists-controls">
        <input type="search" id="artist-filter" placeholder="Filter artists by name..." autocomplete="off" />
      </div>
    </div>
    <div id="artists-list"><p class="muted">Loading artists from directory...</p></div>`;

  try {
    const dir = await loadDirectory();
    const rows = Object.entries(dir.entries).filter(([, e]) => !e.removed && e.params.slice(96) === APP_PATH_HEX);

    const artists = new Map<string, {
      pk: string;
      name: string;
      releases: { id: string; params: string; title: string; cover?: string; ts: number }[];
      latestTs: number;
      latestCover?: string;
    }>();

    for (const [id, e] of rows) {
      const pk = e.params.slice(0, 64);
      let a = artists.get(pk);
      if (!a) {
        a = { pk, name: e.artist, releases: [], latestTs: e.ts, latestCover: e.cover };
        artists.set(pk, a);
      }
      a.releases.push({ id, params: e.params, title: e.title, cover: e.cover, ts: e.ts });
      if (e.ts > a.latestTs) {
        a.latestTs = e.ts;
        a.name = e.artist;
        if (e.cover) a.latestCover = e.cover;
      }
    }

    const artistList = Array.from(artists.values()).sort((a, b) => b.releases.length - a.releases.length || b.latestTs - a.latestTs);
    const profMap = new Map<string, ArtistProfile>();
    await Promise.all(artistList.map(async (a) => {
      const p = await getArtistProfile(a.pk);
      if (p) profMap.set(a.pk, p);
    }));

    const render = (filter = "") => {
      const f = filter.toLowerCase().trim();
      const filtered = artistList.filter((a) => {
        const p = profMap.get(a.pk);
        const nm = p?.name || a.name;
        return nm.toLowerCase().includes(f) || a.pk.startsWith(f);
      });
      const box = $("#artists-list");
      if (!filtered.length) {
        box.innerHTML = `<div class="empty">No artists found${f ? ` matching “${esc(filter)}”` : ""}.</div>`;
        return;
      }
      box.innerHTML = `
        <div class="artists-grid">
          ${filtered.map((a) => {
            const p = profMap.get(a.pk);
            const aName = p?.name || a.name;
            const aAvatar = p?.avatar || a.latestCover;
            return `
            <a class="artist-card card" href="#/a/${esc(a.pk)}">
              <div class="artist-card-top">
                <div class="artist-avatar" style="--h:${hueOf(a.pk)}">
                  ${aAvatar ? `<img data-cover="${esc(aAvatar)}" alt="" />` : ""}
                  <span>${esc((aName.trim()[0] ?? "A").toUpperCase())}</span>
                </div>
                <div class="artist-card-info">
                  <h3 class="artist-card-name">${esc(aName)}</h3>
                  <div class="chips">
                    <span class="chip hot">${a.releases.length} release${a.releases.length === 1 ? "" : "s"}</span>
                    <span class="chip" title="${esc(a.pk)}">key ${esc(a.pk.slice(0, 8))}…</span>
                  </div>
                </div>
              </div>
              ${a.releases.length ? `
                <div class="artist-card-disco">
                  ${a.releases.slice(0, 4).map((r) => `
                    <div class="artist-disco-thumb" title="${esc(r.title)}">
                      ${art(r.id, r.title, r.cover, "mini-art")}
                    </div>
                  `).join("")}
                </div>
              ` : ""}
            </a>`;
          }).join("")}
        </div>`;
      lazyCovers(box);
    };

    render();
    const filterInput = $<HTMLInputElement>("#artist-filter");
    if (filterInput) filterInput.oninput = () => render(filterInput.value);
  } catch (e) {
    $("#artists-list").innerHTML = `<p class="err">Could not load artists: ${esc(String(e))}</p>`;
  }
}

// ---------------- search page (#/search[/<query>]) ----------------
async function searchPage(initialQuery = "") {
  app.innerHTML = `
    <div class="bc-search-page">
      <div class="search-hero">
        <p class="eyebrow">Search</p>
        <h1>Search Catalog</h1>
        <p class="muted">Find artists, releases, and individual songs on FreeTunes.</p>
        <div class="search-input-wrap">
          <svg class="search-ic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z" fill="currentColor"/>
          </svg>
          <input id="search-main-input" type="search" placeholder="Type artist name, album, or song title..." value="${esc(initialQuery)}" autofocus />
          <button id="search-clear-btn" type="button" class="search-clear-btn" ${initialQuery ? "" : "hidden"}>✕</button>
        </div>
      </div>
      <div class="search-tabs">
        <button type="button" class="search-tab on" data-tab="all">All</button>
        <button type="button" class="search-tab" data-tab="artists">Artists <span id="cnt-artists" class="tab-count"></span></button>
        <button type="button" class="search-tab" data-tab="albums">Albums <span id="cnt-albums" class="tab-count"></span></button>
        <button type="button" class="search-tab" data-tab="tracks">Songs <span id="cnt-tracks" class="tab-count"></span></button>
      </div>
      <div id="search-results"><p class="muted">Loading search data...</p></div>
    </div>`;

  let currentTab = "all";
  const searchInput = $<HTMLInputElement>("#search-main-input");
  const clearBtn = $<HTMLButtonElement>("#search-clear-btn");
  const resultsBox = $("#search-results");

  const runSearch = async () => {
    const q = searchInput.value.trim();
    clearBtn.hidden = !q;
    const { artists, albums, tracks, allRows } = await searchCatalog(q);

    $<HTMLElement>("#cnt-artists").textContent = `(${artists.length})`;
    $<HTMLElement>("#cnt-albums").textContent = `(${albums.length})`;
    $<HTMLElement>("#cnt-tracks").textContent = `(${tracks.length})`;

    if (!q) {
      resultsBox.innerHTML = `
        <div class="empty">Type a song, artist, or album name above to search across FreeTunes.</div>
        <h3 class="search-group-title">Browse all albums (${allRows.length})</h3>
        <div class="grid">${allRows.slice(0, 18).map(([id, e]) => card(`#/r/${id}.${e.params}`, id, e.title, e.artist, e.cover)).join("")}</div>`;
      lazyCovers(resultsBox);
      return;
    }

    if (!artists.length && !albums.length && !tracks.length) {
      resultsBox.innerHTML = `<div class="empty">No artists, albums, or songs matching “${esc(q)}”.</div>`;
      return;
    }

    let html = "";

    // Artists section
    if ((currentTab === "all" || currentTab === "artists") && artists.length) {
      html += `
        <h3 class="search-group-title">Artists <span class="search-group-count">(${artists.length})</span></h3>
        <div class="artists-grid">
          ${artists.map((a) => `
            <a class="artist-card card" href="#/a/${esc(a.pk)}">
              <div class="artist-card-top">
                <div class="artist-avatar" style="--h:${hueOf(a.pk)}">
                  ${a.latestCover ? `<img data-cover="${esc(a.latestCover)}" alt="" />` : ""}
                  <span>${esc((a.name.trim()[0] ?? "A").toUpperCase())}</span>
                </div>
                <div class="artist-card-info">
                  <h3 class="artist-card-name">${esc(a.name)}</h3>
                  <div class="chips"><span class="chip hot">${a.releases.length} release${a.releases.length === 1 ? "" : "s"}</span></div>
                </div>
              </div>
            </a>
          `).join("")}
        </div>`;
    }

    // Songs section
    if ((currentTab === "all" || currentTab === "tracks") && tracks.length) {
      html += `
        <h3 class="search-group-title">Songs <span class="search-group-count">(${tracks.length})</span></h3>
        <ul class="track-results-list">
          ${tracks.map((t) => `
            <li class="track-result-item">
              <a class="track-result-play" href="#/r/${t.albumId}.${t.albumParams}/${t.trackIndex}" title="Play ${esc(t.trackTitle)}">
                ${ICON_PLAY}
              </a>
              <div class="track-result-info">
                <a class="track-result-title" href="#/r/${t.albumId}.${t.albumParams}/${t.trackIndex}">${esc(t.trackTitle)}</a>
                <span class="track-result-meta">
                  from <a href="#/r/${t.albumId}.${t.albumParams}">${esc(t.albumTitle)}</a> by <b>${esc(t.artist)}</b>
                </span>
              </div>
              <span class="track-result-time">${fmtTime(t.durationMs)}</span>
            </li>
          `).join("")}
        </ul>`;
    }

    // Albums section
    if ((currentTab === "all" || currentTab === "albums") && albums.length) {
      html += `
        <h3 class="search-group-title">Albums <span class="search-group-count">(${albums.length})</span></h3>
        <div class="grid">
          ${albums.map(([id, e]) => card(`#/r/${id}.${e.params}`, id, e.title, e.artist, e.cover, ` · ${new Date(e.ts).toLocaleDateString()}`)).join("")}
        </div>`;
    }

    resultsBox.innerHTML = html;
    lazyCovers(resultsBox);
  };

  // Progressive background track indexer for unindexed directory releases
  void loadDirectory().then(async (dir) => {
    const unindexed = Object.entries(dir.entries)
      .filter(([id, e]) => !e.removed && e.params.slice(96) === APP_PATH_HEX && !trackCache.some((t) => t.albumId === id))
      .slice(0, 10);
    for (const [id, e] of unindexed) {
      try {
        const rel = await loadRelease(id, e.params);
        indexReleaseTracks(id, e.params, rel.meta);
        if (searchInput.value.trim()) void runSearch();
      } catch {}
    }
  }).catch(() => {});

  app.querySelectorAll<HTMLButtonElement>(".search-tab").forEach((btn) => {
    btn.onclick = () => {
      app.querySelectorAll(".search-tab").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      currentTab = btn.dataset.tab!;
      void runSearch();
    };
  });

  let debounceTimer: ReturnType<typeof setTimeout>;
  searchInput.oninput = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const q = searchInput.value.trim();
      history.replaceState(null, "", pageUrl(q ? `#/search/${encodeURIComponent(q)}` : "#/search"));
      void runSearch();
    }, 150);
  };

  clearBtn.onclick = () => {
    searchInput.value = "";
    searchInput.focus();
    history.replaceState(null, "", pageUrl("#/search"));
    void runSearch();
  };

  void runSearch();
}

// ---------------- artist page: directory entries signed by one key ----------------
async function artistPage(pk: string) {
  app.innerHTML = `<p class="muted">Loading... (the first visit on a node can take up to 30 s)</p>`;
  try {
    const [dir, me] = await Promise.all([loadDirectory(), peekIdentity()]);
    const rows = Object.entries(dir.entries).filter(([, e]) => e.params.slice(0, 64) === pk && !e.removed && e.params.slice(96) === APP_PATH_HEX).sort(([, a], [, b]) => b.ts - a.ts);
    const yours = me?.pk === pk;
    const listed = new Set(rows.map(([id]) => id));
    const unlisted = yours ? (await myReleases()).filter((r) => !listed.has(idOfHash(r.hash))) : [];

    // Load profile: check local store, then inspect latest release if available
    let prof = await getArtistProfile(pk);
    let releaseWithProfile: Release | null = null;
    if (rows.length > 0) {
      try {
        releaseWithProfile = await loadRelease(rows[0][0], rows[0][1].params);
        if (releaseWithProfile.meta.artist_avatar || releaseWithProfile.meta.artist_bio) {
          prof = await saveArtistProfile(pk, {
            avatar: prof?.avatar || releaseWithProfile.meta.artist_avatar,
            bio: prof?.bio || releaseWithProfile.meta.artist_bio,
            name: prof?.name || releaseWithProfile.meta.artist,
          });
        }
      } catch {}
    }

    const name = prof?.name || (rows[0]?.[1].artist ?? unlisted[0]?.artist ?? (yours ? (await storeGet("artist")) : null) ?? "Unknown artist");
    const avatarAddr = prof?.avatar || rows[0]?.[1].cover;
    const bio = prof?.bio || "";
    let avatarFile: File | undefined;
    let removeAvatar = false;

    app.innerHTML = `
      <p><a href="#/artists">← All artists</a></p>
      <div class="bc-section-header">
        <div style="display:flex; align-items:center; gap:18px;">
          <div class="artist-avatar" id="artist-header-avatar" style="--h:${hueOf(pk)}; width:80px; height:80px; font-size:2rem;">
            ${avatarAddr ? `<img data-cover="${esc(avatarAddr)}" alt="" />` : ""}
            <span>${esc((name.trim()[0] ?? "A").toUpperCase())}</span>
          </div>
          <div>
            <p class="eyebrow" style="margin-bottom:2px;">Artist</p>
            <h1 style="margin-bottom:4px;" id="artist-header-name">${esc(name)}</h1>
            <div class="chips">
              <span class="chip hot">${rows.length + unlisted.length} release${rows.length + unlisted.length === 1 ? "" : "s"}</span>
              <span class="chip" title="${esc(pk)}">key ${esc(pk.slice(0, 8))}…</span>
              ${isMaintainer(pk) ? `<span class="chip" style="background:#00a8ff; color:#fff; font-weight:700;" title="FreeTunes Creator & Maintainer">Maintainer</span>` : ""}
              ${isModerator(pk) && !isMaintainer(pk) ? `<span class="chip" style="background:#00a878; color:#fff; font-weight:700;" title="FreeTunes Moderator">Moderator</span>` : ""}
              ${yours ? `<span class="chip hot">you</span>` : ""}
              ${yours ? `<button type="button" class="btn small" id="edit-profile-btn" style="margin-left:6px;">Edit Profile</button>` : ""}
            </div>
          </div>
        </div>
      </div>

      ${yours ? `
        <div class="card profile-editor-card" id="profile-editor" hidden>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <h3 style="margin:0;">Edit Artist Profile</h3>
            <button type="button" class="btn small" id="prof-close-btn">✕</button>
          </div>
          <p class="muted"><small>Customize your public artist avatar and bio. Saved to your identity and your published releases on Freenet.</small></p>

          <div class="profile-avatar-pick">
            <div id="prof-avatar-prev" class="artist-avatar" style="--h:${hueOf(pk)}; width:74px; height:74px; font-size:1.8rem;">
              ${avatarAddr ? `<img data-cover="${esc(avatarAddr)}" class="on" alt="" />` : ""}
              <span>${esc((name.trim()[0] ?? "A").toUpperCase())}</span>
            </div>
            <div>
              <label class="btn small" style="cursor:pointer; display:inline-flex;">
                Choose new avatar image
                <input type="file" id="prof-avatar-file" accept="image/*" style="display:none;" />
              </label>
              ${avatarAddr ? `<button type="button" class="btn small danger" id="prof-avatar-remove" style="margin-left:8px;">Reset avatar</button>` : ""}
              <p class="muted" style="margin-top:6px;"><small>Square photo or artwork. Automatically resized to 600 px.</small></p>
            </div>
          </div>

          <label class="field">
            <span>Artist Name</span>
            <input id="prof-name" maxlength="80" value="${esc(name)}" placeholder="Your artist or band name" />
          </label>

          <label class="field">
            <span>Artist Bio & Info</span>
            <textarea id="prof-bio" rows="4" maxlength="2000" placeholder="Write about yourself, musical background, influences, social links, location...">${esc(bio)}</textarea>
          </label>

          <div class="actions">
            <button type="button" class="btn primary" id="prof-save-btn">Save profile</button>
            <button type="button" class="btn" id="prof-cancel-btn">Cancel</button>
            <span id="prof-msg" class="muted"></span>
          </div>
        </div>
      ` : ""}

      ${bio ? `
        <div class="card bc-artist-bio">
          <h3 class="bc-subhead" style="margin-top:0;">About ${esc(name)}</h3>
          <p>${esc(bio)}</p>
        </div>
      ` : ""}

      <h2>Releases</h2>
      ${rows.length + unlisted.length ? `<div class="grid">${rows.map(([id, e]) => card(`#/r/${id}.${e.params}`, id, e.title, e.artist, e.cover, ` · ${new Date(e.ts).toLocaleDateString()}`)).join("")}${unlisted.map((r) => card(r.hash, idOfHash(r.hash), r.title, r.artist, r.cover, " · not listed")).join("")}</div>`
        : `<div class="empty">No releases listed in the directory for this artist.</div>`}
      <label class="field share"><span>Link to share</span><input readonly value="${esc(pageUrl(`#/a/${pk}`))}" onfocus="this.select()" /></label>
      <p class="notice">Only releases listed in the public directory appear here. The page is identified by the artist's key, not by the name.</p>`;

    lazyCovers(app);

    if (yours) {
      const editBtn = $<HTMLButtonElement>("#edit-profile-btn");
      const editor = $<HTMLElement>("#profile-editor");
      const closeBtn = $<HTMLButtonElement>("#prof-close-btn");
      const cancelBtn = $<HTMLButtonElement>("#prof-cancel-btn");
      const saveBtn = $<HTMLButtonElement>("#prof-save-btn");
      const fileInput = $<HTMLInputElement>("#prof-avatar-file");
      const removeBtn = app.querySelector<HTMLButtonElement>("#prof-avatar-remove");
      const prevBox = $("#prof-avatar-prev");
      const msg = $("#prof-msg");

      const toggleEditor = () => {
        editor.hidden = !editor.hidden;
        if (!editor.hidden) editor.scrollIntoView({ behavior: "smooth", block: "center" });
      };
      editBtn.onclick = toggleEditor;
      closeBtn.onclick = () => (editor.hidden = true);
      cancelBtn.onclick = () => (editor.hidden = true);

      fileInput.onchange = (e) => {
        avatarFile = (e.target as HTMLInputElement).files?.[0];
        if (avatarFile) {
          removeAvatar = false;
          prevBox.innerHTML = `<img src="${URL.createObjectURL(avatarFile)}" class="on" alt="" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />`;
        }
      };

      if (removeBtn) {
        removeBtn.onclick = () => {
          removeAvatar = true;
          avatarFile = undefined;
          prevBox.innerHTML = `<span>${esc((name.trim()[0] ?? "A").toUpperCase())}</span>`;
        };
      }

      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        msg.textContent = "Saving...";
        try {
          let newAvatarAddr = removeAvatar ? undefined : prof?.avatar;
          if (avatarFile) {
            msg.textContent = "Uploading avatar to Freenet...";
            const bytes = await makeCover(avatarFile);
            newAvatarAddr = await putChunk(bytes);
            await flushKnown();
          }

          const newName = $<HTMLInputElement>("#prof-name").value.trim() || name;
          const newBio = $<HTMLTextAreaElement>("#prof-bio").value.trim();

          await saveArtistProfile(pk, { avatar: newAvatarAddr, bio: newBio, name: newName });
          await storePut("artist", newName);

          // Sync to latest release if one exists and is editable
          if (rows.length > 0) {
            msg.textContent = "Updating release with profile...";
            try {
              const [inst, entry] = rows[0];
              const rel = releaseWithProfile || await loadRelease(inst, entry.params);
              if (rel && !rel.legacy && !rel.meta.deleted) {
                await updateRelease(inst, entry.params, {
                  ...rel.meta,
                  artist: newName,
                  artist_avatar: newAvatarAddr,
                  artist_bio: newBio,
                }, rel.meta.ts);
              }
            } catch (e) {
              console.warn("Could not sync profile to release:", e);
            }
          }

          msg.textContent = "Profile saved!";
          setTimeout(() => void artistPage(pk), 500);
        } catch (e) {
          msg.textContent = `Error: ${e}`;
          saveBtn.disabled = false;
        }
      };
    }
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
    if (me?.pk !== params.slice(0, 64)) return void (app.innerHTML = `<div class="gone"><h1>Not your release</h1><p class="muted">Only the artist who published it can edit it, signed in with the same Viso persona.</p><a class="btn" href="#/r/${esc(instance)}.${esc(params)}">Back to the release</a></div>`);
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
  if (existing) {
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
      const meId = await peekIdentity();
      const meProf = meId ? await getArtistProfile(meId.pk) : null;
      const meta = {
        title, artist, license, rights: true, cover, tracks,
        comments: m?.comments,
        about: $<HTMLTextAreaElement>("#about").value.trim().slice(0, 2000) || undefined,
        artist_avatar: m?.artist_avatar ?? meProf?.avatar,
        artist_bio: m?.artist_bio ?? meProf?.bio,
      };
      msg.textContent = edit ? "Saving..." : "Publishing the release...";
      let instance: string, params: string;
      if (existing) {
        await updateRelease(existing.instance, existing.params, meta, existing.meta.ts);
        ({ instance, params } = existing);
      } else ({ instance, params } = await publishRelease(meta));

      // Cache tracks immediately
      indexReleaseTracks(instance, params, { ...meta, ts: Date.now() });

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
      void flushKnown();
      msg.textContent = `Error: ${e}`;
      go.disabled = false;
    }
  };
}

// ---------------- release page in Bandcamp style ----------------
/** `track`: a shared link to one track (its index), highlighted and ready to play; -1 for the whole release. */
async function releasePage(instance: string, params: string, track = -1) {
  app.innerHTML = `<p class="muted">Loading...</p>`;
  let rel: Release;
  try { rel = await loadRelease(instance, params); }
  catch (e) { return void (app.innerHTML = `<p class="err">Could not load the release: ${esc(String(e))}</p><p><a href="#/">← Back</a></p>`); }
  const m = rel.meta, hash = `#/r/${instance}.${params}`;
  indexReleaseTracks(instance, params, m);
  void watchRelease(instance).catch(() => {});

  if (m.deleted) {
    void forgetRelease(hash);
    return void (app.innerHTML = `<div class="gone"><h1>Release removed</h1><p class="muted">The artist took this release down.</p><a class="btn" href="#/">Back to Explore</a></div>`);
  }
  const total = m.tracks.reduce((n, t) => n + t.chunks.reduce((s, c) => s + c.ms, 0), 0);
  const initialTrackIdx = track >= 0 && track < m.tracks.length ? track : 0;
  const initialTrack = m.tracks[initialTrackIdx];

  app.innerHTML = `
    <p><a href="#/">← All releases</a></p>
    <div class="bc-album-page" style="--h:${hueOf(instance)}">
      <!-- MAIN / LEFT COLUMN -->
      <div class="bc-main">
        <div class="bc-album-header">
          <h1 class="bc-title">${esc(m.title)}</h1>
          <p class="bc-by">by <a href="#/a/${esc(params.slice(0, 64))}"><b>${esc(m.artist)}</b></a></p>
        </div>

        <!-- BANDCAMP EMBEDDED PLAYER -->
        <div class="bc-player">
          <div class="bc-player-row">
            <button type="button" class="bc-big-play" id="big-play" aria-label="Play or pause release">
              ${ICON_PLAY}${ICON_PAUSE}
            </button>
            <div class="bc-player-details">
              <div class="bc-track-line">
                <span class="bc-now-title" id="now-title">${esc(initialTrack?.title ?? m.title)}</span>
                <span class="bc-now-time" id="now-time">0:00 / ${fmtTime(initialTrack ? initialTrack.chunks.reduce((s, c) => s + c.ms, 0) : total)}</span>
              </div>
              <div class="bc-seeker-wrap">
                <input type="range" class="bc-seeker" id="bc-seeker" min="0" max="100" value="0" step="0.1" aria-label="Seek track" />
              </div>
              <div id="status" class="bc-status muted"></div>
            </div>
          </div>
          <audio id="player" preload="none"></audio>
        </div>

        <!-- METADATA & BADGES -->
        <div class="bc-meta-bar">
          <span class="chip hot">${esc(LICENSES[m.license] ?? m.license)}</span>
          <span class="chip">${m.tracks.length} track${m.tracks.length === 1 ? "" : "s"}</span>
          <span class="chip">${fmtTime(total)}</span>
          <span class="chip">${new Date(m.ts).toLocaleDateString()}</span>
        </div>

        <div id="changed" class="notice" hidden>The artist updated this release. <a href="#" id="refresh">Refresh</a></div>

        <!-- TRACKLIST -->
        <div class="bc-tracklist-wrap">
          <h3 class="bc-subhead">Tracks</h3>
          <ol class="tracks">${m.tracks.map((t, i) => `
            <li data-i="${i}">
              <button type="button" class="play" aria-label="Play ${esc(t.title)}">${ICON_PLAY}${ICON_PAUSE}</button>
              <span class="tnum">${i + 1}.</span>
              <span class="tt">${esc(t.title)}</span>
              <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
              <small class="muted">${fmtTime(t.chunks.reduce((s, c) => s + c.ms, 0))}</small>
              <button type="button" class="cbtn" data-c="${i}" aria-expanded="false" aria-label="Comments on ${esc(t.title)}">${ICON_CHAT}<span class="cn"></span></button>
              <button type="button" class="cbtn rbtn" data-r="${i}" aria-expanded="false" aria-label="Report ${esc(t.title)}" title="Report this track">${ICON_FLAG}<span class="rn"></span></button>
              <button type="button" class="cbtn lbtn" data-l="${i}" aria-label="Link to ${esc(t.title)}" title="Link to this track">${ICON_LINK}</button>
              <div class="cpanel" hidden></div>
              <div class="rpanel" hidden></div>
            </li>`).join("")}
          </ol>
        </div>

        <!-- ABOUT / CREDITS -->
        ${m.about ? `
          <div class="bc-about-wrap">
            <h3 class="bc-subhead">About this release</h3>
            <div class="card about"><p>${esc(m.about)}</p></div>
          </div>` : ""}

        <div id="reports" class="notice" hidden></div>
      </div>

      <!-- RIGHT COLUMN: SIDEBAR -->
      <aside class="bc-sidebar">
        <div class="bc-art-container">
          ${art(instance, m.title, m.cover?.addr, "bc-cover-art")}
        </div>

        <div class="card bc-artist-card">
          <div class="bc-artist-header">
            <div class="bc-artist-avatar" style="--h:${hueOf(params.slice(0, 64))}">
              ${(m.artist_avatar) ? `<img data-cover="${esc(m.artist_avatar)}" alt="" />` : ""}
              <span>${esc((m.artist.trim()[0] ?? "A").toUpperCase())}</span>
            </div>
            <div>
              <p class="eyebrow" style="margin:0 0 2px;">Artist</p>
              <h4 class="bc-artist-name"><a href="#/a/${esc(params.slice(0, 64))}">${esc(m.artist)}</a></h4>
            </div>
          </div>
          ${m.artist_bio ? `<p class="muted" style="font-size:0.84rem; margin:6px 0 2px; line-height:1.4;">${esc(m.artist_bio)}</p>` : "" }
          <div class="chips">
            <span class="chip" title="${esc(params.slice(0, 64))}">key ${esc(params.slice(0, 8))}…</span>
            ${params.length > 96 ? `<span class="chip hot" title="Viso persona ${esc(personaName(params.slice(0, 64)))}">Viso ${esc(personaName(params.slice(0, 64)).slice(0, 8))}…</span>` : ""}
          </div>

          <!-- DISCOGRAPHY PREVIEW -->
          <div id="bc-disco" class="bc-disco-section"></div>

          <!-- SHARE BOX -->
          <div class="bc-share-box">
            <label class="field share">
              <span id="share-what">Share this release</span>
              <div class="share-row">
                <input id="share" readonly value="${esc(pageUrl(hash))}" onfocus="this.select()" />
                <button type="button" class="btn small" id="copy-btn">Copy</button>
              </div>
            </label>
          </div>

          <!-- OWNER TOOLS -->
          <div id="owner" class="owner-tools"></div>
        </div>

        <div class="bc-report-link-wrap">
          <a href="#" id="report-release" class="muted small link">Report release</a>
          <div class="rpanel" id="rel-rpanel" hidden></div>
        </div>
      </aside>
    </div>
    <div id="confirm"></div>`;

  lazyCovers(app);

  // Load other releases by this artist into sidebar discography
  void loadDirectory().then((dir) => {
    const pk = params.slice(0, 64);
    const others = Object.entries(dir.entries)
      .filter(([id, e]) => e.params.slice(0, 64) === pk && id !== instance && !e.removed && e.params.slice(96) === APP_PATH_HEX)
      .sort(([, a], [, b]) => b.ts - a.ts);
    const disco = $("#bc-disco");
    if (!disco) return;
    if (others.length) {
      disco.innerHTML = `
        <div class="bc-disco-title">Discography</div>
        <div class="bc-disco-grid">
          ${others.slice(0, 6).map(([id, e]) => `
            <a class="bc-disco-item" href="#/r/${id}.${e.params}" title="${esc(e.title)}">
              ${art(id, e.title, e.cover)}
              <small>${esc(e.title)}</small>
            </a>
          `).join("")}
        </div>`;
      lazyCovers(disco);
    }
  }).catch(() => {});

  const audio = $<HTMLAudioElement>("#player");
  const status = $("#status");
  const bigPlay = $<HTMLButtonElement>("#big-play");
  const nowTitle = $("#now-title");
  const nowTime = $("#now-time");
  const seeker = $<HTMLInputElement>("#bc-seeker");
  const streamer = new Streamer(audio);
  const rows = Array.from(app.querySelectorAll<HTMLLIElement>("ol.tracks li"));
  let current = -1;

  const start = (i: number) => {
    current = i;
    rows.forEach((li, k) => { li.classList.toggle("on", k === i); li.classList.remove("playing"); });
    const trackObj = m.tracks[i];
    nowTitle.textContent = trackObj.title;
    const durMs = trackObj.chunks.reduce((s, c) => s + c.ms, 0);
    nowTime.textContent = `0:00 / ${fmtTime(durMs)}`;
    seeker.value = "0";
    status.textContent = "Buffering...";
    bigPlay.classList.add("playing");
    void streamer.play(trackObj.chunks, (d, n) => (status.textContent = d < n ? `Buffering ${d}/${n}` : "")).catch((e) => {
      status.textContent = `Playback failed: ${e}`;
      bigPlay.classList.remove("playing");
    });
  };

  rows.forEach((li, i) => ($<HTMLButtonElement>("button.play", li).onclick = () => {
    if (i === current) {
      if (audio.paused) void audio.play(); else audio.pause();
      return;
    }
    start(i);
  }));

  bigPlay.onclick = () => {
    if (current === -1) {
      start(initialTrackIdx);
    } else {
      if (audio.paused) void audio.play(); else audio.pause();
    }
  };

  // Seeker & time sync
  audio.ontimeupdate = () => {
    const cur = audio.currentTime || 0;
    const dur = audio.duration || (current >= 0 ? m.tracks[current].chunks.reduce((s, c) => s + c.ms, 0) / 1000 : 0);
    if (dur > 0 && !seeker.matches(":active")) {
      seeker.value = String((cur / dur) * 100);
    }
    nowTime.textContent = `${fmtTime(cur * 1000)} / ${fmtTime(dur * 1000)}`;
  };

  seeker.oninput = () => {
    const dur = audio.duration || 0;
    if (dur > 0) audio.currentTime = (Number(seeker.value) / 100) * dur;
  };

  const shareTrack = (i: number) => {
    $("#share-what").textContent = `Link to “${m.tracks[i].title}”`;
    $<HTMLInputElement>("#share").value = pageUrl(`${hash}/${i}`);
  };
  rows.forEach((li, i) => ($<HTMLButtonElement>(".lbtn", li).onclick = () => {
    shareTrack(i);
    $<HTMLInputElement>("#share").focus();
  }));

  // Copy share link button
  const copyBtn = $<HTMLButtonElement>("#copy-btn");
  if (copyBtn) {
    copyBtn.onclick = () => {
      const shareVal = $<HTMLInputElement>("#share").value;
      void navigator.clipboard.writeText(shareVal).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy"), 2000);
      });
    };
  }

  if (track >= 0 && rows[track]) {
    rows[track].classList.add("on");
    rows[track].scrollIntoView({ block: "center" });
    status.textContent = `Press ▶ to play “${m.tracks[track].title}”`;
    shareTrack(track);
  }

  audio.onplaying = () => {
    rows[current]?.classList.add("playing");
    bigPlay.classList.add("playing");
  };
  audio.onpause = () => {
    rows[current]?.classList.remove("playing");
    bigPlay.classList.remove("playing");
  };
  audio.onended = () => {
    if (current + 1 < m.tracks.length) start(current + 1);
    else bigPlay.classList.remove("playing");
  };

  // ---- comments ----
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
      if (b.dataset.sure !== "1") {
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
  void meReady.then(() => opened.forEach(buildPanel));
  if (m.comments) {
    void loadComments(m.comments).then((st) => { cs = st; drawCounts(); opened.forEach(drawList); }).catch(() => {});
    void watchRelease(m.comments).catch(() => {});
  }

  // ---- reports ----
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
  void reloadReports().catch(() => {});

  const off = onRemoteChange(async () => {
    if (!location.hash.startsWith(hash)) return;
    try { if ((await loadRelease(instance, params)).meta.ts !== m.ts) $("#changed").hidden = false; } catch {}
    if (m.comments) { try { await reloadComments(); } catch {} }
  });
  window.addEventListener("hashchange", off, { once: true });
  $("#refresh").onclick = (e) => { e.preventDefault(); void releasePage(instance, params); };

  void meReady.then((id) => {
    if (id?.pk !== params.slice(0, 64)) return;
    if (rel.legacy) {
      $("#owner").innerHTML = `<p class="muted"><small>Published with an older version of FreeTunes: cannot be edited.</small></p>`;
      return;
    }
    $("#owner").innerHTML = `<a class="btn small" href="#/edit/${esc(instance)}.${esc(params)}">Edit release</a><button id="del" class="danger small" type="button">Remove</button>`;
    $("#del").onclick = () => confirmRemoval(rel);
  });
}

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
async function publishPage() {
  if (await peekIdentity()) return releaseForm();
  app.innerHTML = `
    <h1>Publish a release</h1>
    <div class="card">
      <h2>First, sign in</h2>
      <p class="muted">Your releases belong to your <b>Viso</b> persona, which proves they are yours and lets you edit or remove them from any node.</p>
      <div class="actions"><a class="btn primary" href="#/identity">Sign in with Viso</a></div>
    </div>`;
}

async function identityPage() {
  app.innerHTML = `<h1>Identity</h1><div id="idbox"><p class="muted">Loading...</p></div>`;
  const box = $("#idbox");
  let me: Identity | null;
  try { me = await peekIdentity(); } catch (e) { box.innerHTML = `<p class="err">Could not read the identity: ${esc(String(e))}</p>`; return; }

  if (!me) {
    const kept = await localIdentityKey();
    if (kept) { try { await createLocalIdentity(kept); return void (await identityPage()); } catch {} }
    const saved = (await storeGet("viso-url")) || officialViso();
    box.innerHTML = `
      <p class="muted">Your identity is your <b>Viso</b> persona: the same one you use in other Freenet apps. Sign in once on this node: Viso opens, you pick a persona, and it lets FreeTunes publish and comment on its behalf. No key or seed is shared, and there is nothing to back up here.</p>
      <div class="card">
        <h2>Sign in with Viso</h2>
        <label class="field"><span>Address of your Viso site <small class="muted">(official by default, or paste your own)</small></span><input id="wurl" value="${esc(saved)}" placeholder="${esc(officialViso())}" spellcheck="false" /></label>
        <div class="actions"><button id="wgo" class="primary" type="button">Sign in with Viso</button><button id="wofficial" type="button">Use official</button><span id="wmsg" class="muted"></span></div>
      </div>
      <div class="card">
        <h2>Or create an identity here</h2>
        <p class="muted">No Viso needed: FreeTunes makes a new key on this node. You get a key to back up, and pasting it here (in this or another Freenet app, on any node) brings the same identity back.</p>
        <div class="actions"><button id="lnew" type="button">Create identity</button><span id="lmsg" class="muted"></span></div>
        <label class="field"><span>Already have a key? Paste it</span><input id="lkey" type="password" spellcheck="false" autocomplete="off" placeholder="64 hexadecimal characters" /></label>
        <div class="actions"><button id="limport" type="button">Use this key</button></div>
      </div>`;
    const local = async (key?: string) => {
      try { await createLocalIdentity(key); await identityPage(); } catch (e) { $("#lmsg").textContent = String((e as Error).message ?? e); }
    };
    $("#lnew").onclick = () => local();
    $("#limport").onclick = () => local($<HTMLInputElement>("#lkey").value);
    $("#wofficial").onclick = () => { $<HTMLInputElement>("#wurl").value = officialViso(); };
    $("#wgo").onclick = async () => {
      try {
        $("#wmsg").textContent = "Opening Viso...";
        goTo(await startSignIn($<HTMLInputElement>("#wurl").value.trim()));
      } catch (e) { $("#wmsg").textContent = String((e as Error).message ?? e); }
    };
    return;
  }

  const name = (await storeGet("artist")) ?? "";
  const key = await localIdentityKey();
  box.innerHTML = `
    <div class="card">
      <h2>Signed in</h2>
      <p>${key ? "Identity" : "Viso persona"} <code title="${esc(me.pk)}">${esc(personaName(me.pk))}</code></p>
      <label class="field"><span>Artist name</span><input id="name" maxlength="80" value="${esc(name)}" placeholder="Used as the default artist when you publish" /></label>
      <div class="actions"><button id="savename" type="button">Save name</button><a class="btn primary" href="#/publish">Publish a release</a><a class="btn" href="#/a/${esc(me.pk)}">Your artist page</a><span id="nmsg" class="muted"></span></div>
    </div>
    ${key ? `<div class="card">
      <h2>Back up your key</h2>
      <p class="muted">This identity was made here, so this key is the only way to get it back. Keep it secret: whoever has it can publish as you.</p>
      <div class="actions"><button id="kshow" type="button">Show key</button><button id="kdl" type="button">Download key</button></div>
      <p><code id="kval" hidden>${esc(key)}</code></p>
    </div>` : ""}
    <div class="card">
      <h2>Sign out</h2>
      <p class="muted">This node forgets the sign-in. Your releases stay yours: sign in again, here or on another node, to edit them.</p>
      <div class="actions"><button id="out" type="button">Sign out</button></div>
    </div>`;
  $("#savename").onclick = async () => { await storePut("artist", $<HTMLInputElement>("#name").value.trim()); $("#nmsg").textContent = "Saved."; };
  if (key) {
    $("#kshow").onclick = () => { $("#kval").hidden = !$("#kval").hidden; };
    $("#kdl").onclick = () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([`FreeTunes identity key: keep it secret.\n${key}\n`], { type: "text/plain" }));
      a.download = `identity-${personaName(me!.pk).slice(0, 8)}.txt`;
      a.click();
    };
  }
  $("#out").onclick = async () => {
    if (key && !confirm("Signing out deletes the key from this node. Without your backup this identity is lost. Sign out?")) return;
    await signOut(); await identityPage();
  };
}

const goTo = (href: string) => (window.parent !== window ? parent.postMessage({ __freenet_shell__: true, type: "navigate", href }, "*") : void (location.href = href));

async function signInCallback(q: URLSearchParams) {
  app.innerHTML = `<h1>Viso</h1><p class="muted">Checking the proof...</p>`;
  let html: string;
  try {
    html = `<div class="notice"><b>Signed in</b> as the Viso persona <code>${esc(personaName(await finishSignIn(q)))}</code>.</div>`;
  } catch (e) {
    html = `<div class="notice"><b>Not signed in.</b> ${esc(String((e as Error).message ?? e))}</div>`;
  }
  history.replaceState(null, "", location.pathname + "#/identity");
  app.innerHTML = `<h1>Viso</h1>${html}<div class="actions"><a class="btn primary" href="#/identity">Continue</a></div>`;
}

// ---------------- admin ----------------
async function admin() {
  const me = await peekIdentity();
  const userIsMaintainer = isMaintainer(me?.pk);
  const userIsMod = isModerator(me?.pk);

  app.innerHTML = `
    <p><a href="#/">← Back to Explore</a></p>
    <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:1rem; flex-wrap:wrap; gap:10px;">
      <h1 style="margin:0;">Directory Moderation</h1>
      <span class="muted" style="font-size:0.85rem;">FreeTunes Public Governance</span>
    </div>

    ${userIsMod ? `
      <div class="banner ok" style="margin-bottom:1.5rem; display:flex; align-items:center; gap:12px; padding:14px 18px; background:rgba(0,168,255,0.08); border:1px solid rgba(0,168,255,0.3); border-radius:8px;">
        <span class="chip" style="background:#00a8ff; color:#fff; font-weight:700; margin:0;">${userIsMaintainer ? "Maintainer" : "Moderator"}</span>
        <div style="font-size:0.9rem;">
          Signed in with Viso as <b>${esc(me!.pk.slice(0, 8))}…${esc(me!.pk.slice(-6))}</b>.
          <span class="muted">You are authorized to publish signed blocklists directly using your delegated session key (no raw secret key needed).</span>
        </div>
      </div>
    ` : `
      <div class="banner warn" style="margin-bottom:1.5rem; padding:14px 18px; background:rgba(255,165,0,0.08); border:1px solid rgba(255,165,0,0.3); border-radius:8px;">
        <div style="font-weight:700; color:#ffb020; margin-bottom:4px;">Not signed in as Maintainer or Moderator</div>
        <p class="muted" style="margin:0; font-size:0.9rem;">
          To moderate using your Viso persona, <a href="#/identity">sign in with Viso</a> using the maintainer persona (<code>${esc(FREETUNES_MAINTAINER.slice(0, 8))}…</code>) or an authorized moderator key.
          Alternatively, you can provide an admin secret key below.
        </p>
      </div>
    `}

    <div class="card" style="margin-bottom:1.5rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <h3 style="margin:0;">Active Blocklist</h3>
        <span id="bl-count" class="muted" style="font-size:0.85rem;">Loading...</span>
      </div>
      <p class="muted" style="font-size:0.85rem; margin-top:0;">Release IDs hidden from the public directory (Explore, Artists, and Search), one ID per line.</p>

      ${userIsMod ? `
        <details style="margin-bottom:10px;">
          <summary class="muted" style="cursor:pointer; font-size:0.8rem;">Manual secret key fallback (optional)</summary>
          <input id="sk" type="password" autocomplete="off" placeholder="Optional raw admin secret (hex)" style="margin-top:6px;" />
        </details>
      ` : `
        <input id="sk" type="password" autocomplete="off" placeholder="Admin secret (hex)" style="margin-bottom:10px;" />
      `}

      <textarea id="bl" rows="6" placeholder="Release IDs, one per line (e.g. 5x...)" style="font-family:monospace; font-size:0.85rem;"></textarea>
      <div class="actions" style="margin-top:10px; display:flex; align-items:center; gap:12px;">
        <button id="go" class="primary" type="button">${userIsMod ? "Sign & Publish Blocklist" : "Publish Blocklist"}</button>
        <span id="msg" class="muted" style="font-size:0.9rem;"></span>
      </div>
    </div>

    <div class="card" style="margin-bottom:1.5rem; background:rgba(255,255,255,0.02); font-size:0.85rem;">
      <h4 style="margin:0 0 8px;">Federated Governance & Roles</h4>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">
        <div>
          <b>Maintainer:</b> <span class="chip" style="background:#00a8ff; color:#fff; font-size:0.75rem;">Root Admin</span><br/>
          <code style="word-break:break-all;">${FREETUNES_MAINTAINER}</code>
        </div>
        <div>
          <b>Default Moderators:</b> <span class="chip" style="background:#00a878; color:#fff; font-size:0.75rem;">Mod</span><br/>
          ${FREETUNES_DEFAULT_MODS.map((m) => `<code style="word-break:break-all;">${m}</code>`).join("<br/>")}
        </div>
      </div>
      <p class="muted" style="margin:8px 0 0; font-size:0.8rem;">
        Blocklists are verified by the smart contract in Freenet (<code>directory.wasm</code>). Signed updates from the Maintainer or authorized Moderators take effect immediately on-chain.
      </p>
    </div>

    <h2>Community Reports Queue</h2>
    <div id="reps" class="card"><p class="muted">Loading reports...</p></div>
  `;

  try {
    const dir = await loadDirectory();
    $<HTMLTextAreaElement>("#bl").value = dir.blocked.list.join("\n");
    const countEl = $("#bl-count");
    if (countEl) countEl.textContent = `${dir.blocked.list.length} release${dir.blocked.list.length === 1 ? "" : "s"} currently blocked`;
  } catch (e) {
    $("#msg").textContent = `Could not load the directory: ${e}`;
  }

  try {
    const all = Object.values((await loadReports()).reports).sort((a, b) => b.ts - a.ts);
    const box = $("#reps");
    const byRelease = new Map<string, typeof all>();
    for (const r of all) byRelease.set(r.target, [...(byRelease.get(r.target) ?? []), r]);

    box.innerHTML = all.length
      ? [...byRelease].sort(([, a], [, b]) => b.length - a.length).map(([target, rs]) => {
          const blText = $<HTMLTextAreaElement>("#bl")?.value ?? "";
          const isAlreadyBlocked = blText.split("\n").map((s) => s.trim()).includes(target);
          return `
            <div class="rep" style="padding:12px; margin-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.06);">
              <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                <div>
                  <b>${rs.length} report${rs.length === 1 ? "" : "s"}</b> · <code>${esc(target)}</code>
                  ${isAlreadyBlocked ? `<span class="chip" style="background:#e74c3c; color:#fff; margin-left:6px;">Blocked</span>` : ""}
                </div>
                <button type="button" class="btn small ${isAlreadyBlocked ? "" : "primary"}" data-block="${esc(target)}">
                  ${isAlreadyBlocked ? "Already in blocklist" : "+ Add to blocklist"}
                </button>
              </div>
              <div style="margin-top:8px;">
                ${rs.map((r) => `
                  <p style="margin:4px 0;"><span class="chip">${esc(r.kind)}</span> ${r.track === WHOLE_RELEASE ? "release" : `track ${r.track + 1}`} · ${esc(r.note || "(no note)")}
                  <small class="muted" style="display:block; margin-top:2px;">${r.contact ? `contact: ${esc(r.contact)} · ` : ""}ante ${esc(r.a.slice(0, 8))}… · ${new Date(r.ts).toLocaleString()}</small></p>
                `).join("")}
              </div>
            </div>`;
        }).join("")
      : `<p class="muted">No community reports.</p>`;

    box.querySelectorAll<HTMLButtonElement>("[data-block]").forEach((b) => (b.onclick = () => {
      const t = $<HTMLTextAreaElement>("#bl");
      const id = b.dataset.block!;
      const current = t.value.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!current.includes(id)) {
        current.push(id);
        t.value = current.join("\n");
      }
      b.textContent = "✓ Added to list";
      b.classList.remove("primary");
      const countEl = $("#bl-count");
      if (countEl) countEl.textContent = `${current.length} release${current.length === 1 ? "" : "s"} in blocklist`;
    }));
  } catch (e) {
    $("#reps").innerHTML = `<p class="err">Could not load the reports: ${esc(String(e))}</p>`;
  }

  $("#go").onclick = async () => {
    const list = $<HTMLTextAreaElement>("#bl").value.split("\n").map((l) => l.trim()).filter(Boolean);
    const skVal = $<HTMLInputElement>("#sk")?.value?.trim() || "";
    $("#msg").textContent = "Signing and publishing blocklist...";
    try {
      await blockReleases(skVal, list);
      $("#msg").textContent = `✓ Success: ${list.length} release${list.length === 1 ? "" : "s"} blocked in public directory.`;
      const countEl = $("#bl-count");
      if (countEl) countEl.textContent = `${list.length} release${list.length === 1 ? "" : "s"} currently blocked`;
    } catch (e) {
      $("#msg").textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
}

// Initialize header search bar and start routing
initHeaderSearch();
addEventListener("hashchange", route);
route();
