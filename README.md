# FreeTunes

> **Experiment.** FreeTunes is an experiment on [Freenet](https://freenet.org): a minimal, Bandcamp-like place to publish and stream music with no server. It is unfinished, may break or lose data, and should not be relied on for anything.

> **Rights disclaimer.** Only publish music you own, music in the public domain, or music whose licence allows you to publish it (for example Creative Commons). Everything you publish is **public and permanent**: Freenet has no global delete, so you will not be able to remove it. You are responsible for what you publish.

## What it does

An artist publishes a release (cover, title, licence, MP3 tracks) and anyone can stream it. No accounts, no hosting, no payments.

- **Publish**: pick the MP3 files and an optional cover, choose a licence, tick the rights declaration, publish. Optionally list the release in the public directory.
- **Edit**: the artist can change title, artist, licence and cover, rename, reorder and remove tracks, and add new ones. The release keeps its address; listeners are told when it changes.
- **Remove**: the artist can take a release down. It disappears from FreeTunes and from the directory, and the contract is replaced by a signed notice. **This does not erase the audio** (see below).
- **Stream**: a release page with the cover, track list and a player. Playback starts after the first chunk arrives instead of waiting for the whole file, and you can seek once the track is buffered.
- **Explore**: the public directory, newest first.

## Design

Everything is a Freenet contract:

| Contract | What it holds | Address |
| --- | --- | --- |
| **Chunk** (`chunk/`) | A slice of a file (audio or cover). Immutable. | `blake3(code \|\| blake3(content))`: a chunk can be checked against its address |
| **Release** (`release/`) | Title, artist, licence, rights declaration, cover and, per track, the ordered chunk addresses with sizes and durations. Signed by the artist. The artist can replace it with a newer signed state (last write wins by timestamp) or with a signed tombstone that drops every reference to the audio. | `blake3(code \|\| owner key \|\| random salt)` |
| **Directory** (`directory/`) | Public list of releases. Each entry (title, artist, cover address) is signed by the release owner and carries a proof-of-work. The owner can replace it or mark it removed; the tombstone stays so an older entry cannot come back. The newest 500 are kept. The admin key can publish a signed blocklist. | one shared instance (its parameter is the admin public key) |
| **Identity delegate** (`delegate/`) | The artist's signing key, plus a small per-app store (artist name, your releases, published chunk addresses). | one per calling web app |

The release contract refuses anything that does not carry `rights: true`, a known licence and valid, signed metadata, edits included. Only the key the release was created with can edit or remove it. Signatures are bound to the full contract parameters, so a signed release cannot be cloned into another contract.

### Streaming

Tracks are split at MP3 frame boundaries into chunks of about 512 KB, so every chunk is a valid stand-alone stream. The player appends them to a `MediaSource` in order, fetching the next while the current one is appended, and falls back to downloading the whole track when the browser cannot stream `audio/mpeg` that way.

### Identity

An identity is an ed25519 key kept by the identity delegate in your node. It is created **on purpose**, on the Identity page (menu), with an artist name: nothing creates a key for people who only browse and listen, and publishing without one sends you there. Right after creating it the page asks you to download a backup.

- **Export**: a file with the key, the artist name and your list of releases. With a passphrase it is encrypted (AES-GCM, key derived with PBKDF2); without one it is plain JSON, and anyone who has it can publish and edit as you.
- **Import**: restores an identity from a backup, on this node or a new one, together with the name and the release list. It replaces the current identity, so it asks for confirmation.
- **Start over**: a new key. The old one is gone unless it was exported.

The delegate is optional: if it does not answer, the app falls back to `localStorage`, then to memory, and the Identity page warns that the browser cannot keep the key. The identity otherwise belongs to your node; a backup is how you use it elsewhere.

## Measured limits

On a local dev node (no network latency):

| Chunk size | Publish | Read back |
| --- | --- | --- |
| 64 KB | 0.3 s | 11 ms |
| 1 MB | 0.3 s | 0.1 s |
| 4 MB | 0.95 s | 0.4 s |
| 16 MB | 4.2 s | 2.0 s |
| 48 MB | 13 s | 5.9 s |
| 55 MB | rejected | n/a |

- **Hard limit: 50 MiB (52,428,800 bytes) per contract state.** The node rejects larger states and the client only sees a timeout.
- A 4.8 MB, 5-minute MP3 (10 chunks) plus a cover published and listed in about 11 s. Reading a chunk takes about 50 ms.
- **Publishing a chunk the node already hosts is never answered**, and the stale request misaligns the replies to later ones. The app therefore remembers the chunk addresses it published, skips them, and treats a silent put as "already there": it resets the socket and checks with a read.
- These are local numbers; real-network latency and availability are unknown.

## Known limits

- **Availability.** Nodes drop the least requested contracts. The artist must keep a node running, or someone must seed the release.
- **MP3 only** (MPEG-1 Layer III). No transcoding. Other formats are rejected at publish time.
- Streaming through `MediaSource` was checked in Chromium (buffering, duration, seeking). Audible playback was not checked in the test environment, and `audio/mpeg` support in other browsers is untested.
- Limits in the UI: 30 tracks and 250 MB per release, 60 MB per track.
- No payments, downloads page, comments or artist profile pages.
- **Removing a release does not erase its audio.** Chunks are content-addressed and immutable: they stay on the network while nodes host them, and anyone who already has their addresses can fetch them. Removal only deletes the references (the track list) from the release and the directory.
- Editing and removing need the identity the release was published with: use it on the node where you created it, or import a backup elsewhere.
- Releases published before editing existed (an older release contract) cannot be edited or removed: the node refuses any update to them and the client only sees a timeout. The release page says so instead of offering the buttons; publish the release again to get an editable one.
- The blocklist only hides a release from the directory. It cannot remove it from Freenet.

## Development

Requirements: `rustup` with the `wasm32-unknown-unknown` target, `freenet` and `fdev`, Node 20+, ffmpeg (only to make test files).

```bash
cargo test
cargo build --release --target wasm32-unknown-unknown -p freetunes-chunk -p freetunes-release -p freetunes-directory -p freetunes-identity
for n in chunk release directory identity; do cp target/wasm32-unknown-unknown/release/freetunes_$n.wasm ui/src/$n.wasm; done

# isolated dev node on :7510 (does not touch a node on :7509)
mkdir -p .devnode/config .devnode/data .devnode/log
freenet local local --ws-api-port 7510 --config-dir .devnode/config --data-dir .devnode/data --log-dir .devnode/log --disable-auto-update

# a test track (kept out of ui/public, which is published with the site), then the UI
mkdir -p ui/test-assets
ffmpeg -f lavfi -i "sine=frequency=440:duration=300" -c:a libmp3lame -b:a 128k ui/test-assets/test.mp3
cd ui && npm install && echo VITE_NODE=127.0.0.1:7510 > .env.local && npm run dev
```

On Windows, put `~/.cargo/bin` before any standalone Rust install in `PATH`, otherwise `cargo` will not see the wasm target.

### Directory admin

The admin public key is `DIRECTORY_ADMIN` in `ui/src/lib.ts`; the secret is not in the repo (`.secrets/` is ignored). The admin page is at `#/admin` (not linked anywhere): paste the secret and the release ids to hide. Changing the admin key or the directory code creates a new, empty directory.

### Publishing the site

```bash
cd ui && npm run build
fdev website init freetunes
fdev website publish dist --key freetunes     # later: fdev website update dist --key freetunes
```

Back up the signing key file: without it the site can no longer be updated.

## License

MIT, see [LICENSE](LICENSE).
