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
- **Artist page** (`#/a/<key>`): the releases an artist key has listed in the directory (plus, for you, your unlisted ones), linked from every release page.
- **About box**: an optional free-text description (credits, notes, links) on each release, edited with the rest of the release.
- **Comment**: people with an identity can comment on each track; everyone can read.
- **Report**: anyone can report a release or a track (for example one that may infringe copyright). Reports are public, rate-limited with [ante](https://github.com/soudasuwa/ante) proofs of work, and reach the moderator's queue.

## Design

Everything is a Freenet contract:

| Contract | What it holds | Address |
| --- | --- | --- |
| **Chunk** (`chunk/`) | A slice of a file (audio or cover). Immutable. | `blake3(code \|\| blake3(content))`: a chunk can be checked against its address |
| **Release** (`release/`) | Title, artist, licence, rights declaration, cover and, per track, the ordered chunk addresses with sizes and durations. Signed by the artist (a whoiam persona, through a delegated app key). The artist can replace it with a newer signed state (last write wins by timestamp) or with a signed tombstone that drops every reference to the audio. | `blake3(code \|\| owner persona \|\| random salt \|\| app path)` |
| **Directory** (`directory/`) | Public list of releases. Each entry (title, artist, cover address) is signed by the release owner and carries a proof-of-work. The owner can replace it or mark it removed; the tombstone stays so an older entry cannot come back. The newest 500 are kept. The admin key can publish a signed blocklist. | one shared instance (its parameter is the admin public key) |
| **Comments** (`comments/`) | The comments of one release, per track. Each comment is signed by its author and carries a small proof-of-work; removals are signed too and only count when made by the comment's author or the release owner. The newest 1000 are kept. | `blake3(code \|\| release parameters)`: one per release, created by the owner when publishing or editing |
| **Reports** (`reports/`) | Reports about releases and tracks: kind (copyright, illegal, other), a note, an optional contact and an **ante proof**. One report per release, track and ante identity. The newest 2000 are kept. | one shared instance (no parameters) |
| **Identity delegate** (`delegate/`) | The node's app key (disposable, delegated by your whoiam persona), plus a small per-app store (session, artist name, your releases, published chunk addresses). | one per calling web app |

The release contract refuses anything that does not carry `rights: true`, a known licence and valid, signed metadata, edits included. Only the key the release was created with can edit or remove it. Signatures are bound to the full contract parameters, so a signed release cannot be cloned into another contract.

### Comments

Comments live in one contract per release (parameters = the release's own parameters, so the contract knows the owner). Reading needs nothing; writing needs an identity (the page says so to everyone else). A comment is signed `ftc1|<params>|<author>|<track>|<ts>|<name>|<text>` and mined to 16 bits of sha256 proof-of-work (about a second), so posting is not free. A removal (`ftc2|...`) is stored under `<comment id>:<signer>` so nobody can shadow someone else's, and it hides the comment only when the signer is its author or the release owner. Removals are permanent, which keeps the merge a plain union.

### Reports and ante

A report about a track that may be copyrighted (or anything else that should not be here) is a record in the **reports** contract. It hides nothing by itself: visitors see the count on the release and per track, and the moderator sees a queue at `#/admin` from which a release can be added to the directory blocklist.

[ante](https://github.com/soudasuwa/ante) (MIT or Apache-2.0) is the anti-spam. Each report carries an `AnteProof`: a proof-of-work commitment signed by the reporter's *ante identity*, which lives in the ante delegate on their own node. The proof is bound to the report: its purpose is `freetunes:report:v1:<blake3 of the report>`, so it cannot be reused for other content, and the contract checks at least 18 bits of work and the signature (one hash and one signature, via `ante-core`). The flow in the browser:

1. `GetIdentity` (no prompt), then `RequestGrind` for that purpose: **the node asks the reporter's permission** before any work is spent.
2. The page grinds the nonce (about 2^18 blake3 hashes, a few seconds) and the delegate signs it (`Commit`). The page checks the proof itself before sending, because the node only answers a bad update with "Request timeout".
3. The report goes to the contract as a delta.

The ante delegate is shipped in `ui/src/ante-delegate.wasm` and pinned: the page refuses to register code whose blake3 differs from the published ante delegate (`f10f40a3...925f`; its key is `6c1db69c...08de`). Proofs are not tokens and never expire, so the contract keeps one report per (release, track, ante identity). More identities cost more work each; ante does not stop someone willing to grind many (see ante's own notes on "whales").

### Streaming

Tracks are split at MP3 frame boundaries into chunks of about 512 KB, so every chunk is a valid stand-alone stream. The player appends them to a `MediaSource` in order, fetching the next while the current one is appended, and falls back to downloading the whole track when the browser cannot stream `audio/mpeg` that way.

### Identity: your whoiam persona

There is no FreeTunes account and no key to back up. Your identity is your [whoiam](https://github.com/skandragon/freenet-whoiam) persona, the same one other Freenet apps (FreeNames, FreePolls) use. Sign in once per node on the Identity page:

1. The node keeps a random **app key** (identity delegate). FreeTunes opens whoiam's sign-in with the challenge `wd1.<app key>.<nonce>`.
2. whoiam signs, with the persona you pick, `"whoiam-connect-v1" ‖ persona ‖ len ‖ return_base ‖ len ‖ challenge ‖ ts`, where `return_base` is FreeTunes' address: *this app key may act for me in FreeTunes*. That is the **delegation**.
3. Releases, directory entries, comments and comment removals are signed by the app key and carry the delegation. The contracts check it with [`whoiam-delegation`](https://github.com/scobru/freenames/tree/main/delegation) (a git dependency on the FreeNames repo), including that its path is the app path in the release parameters. The owner of a release and the author of a comment is the **persona**.

A new node or a lost one is just another sign-in. The release page shows the owner persona; the artist page (`#/a/<persona key>`) lists that persona's releases. Releases published before personas are not supported any more.

Limits: delegations do not expire or get revoked yet (contracts have no clock), so whoever controls a node you signed in from can publish and comment as your persona in FreeTunes; and whoiam's sign-in is used for something it does not advertise (it shows "sign in to <origin>", not "authorize this key"). Switch to whoiam's own cross-app delegation when it exists.

## Stack

| Layer | What is used |
| --- | --- |
| Contracts and delegate | Rust (stable, `wasm32-unknown-unknown`), `freenet-stdlib` 0.8, `serde_json` state, `ed25519-dalek`, `sha2`, `blake3`, and `ante-core` (git, pinned commit, protocol feature off) in the reports contract. Five contracts and one delegate, in a Cargo workspace. |
| Node | [Freenet](https://freenet.org) (`freenet`, `fdev` for publishing), served to the browser through the node's web container (sandboxed iframe, WebSocket to the node). |
| UI | TypeScript 5, Vite 6, no framework (plain DOM and a hash router). `@freenetorg/freenet-stdlib` 0.4 (WebSocket API; delegate requests go through `sendRequest`, the SDK has no method), `@noble/ed25519` 2, `@noble/hashes` 2 (blake3, sha256). |
| Vendored | `ui/src/cbor.ts` from ante (minimal CBOR codec, MIT or Apache-2.0; only its Reader constructor was rewritten) and `ui/src/ante-delegate.wasm` (the published ante delegate, hash-pinned). |
| External flows | whoiam "sign in with whoiam" for persona linking; ante for report anti-spam. |
| Streaming | MP3 split at frame boundaries, `MediaSource` Extensions. |
| Tests | `cargo test` (contracts, including reports checked against ante-core proofs) and `npm test` in `ui/` (`node --test`: whoiam golden vector, ante purpose/grind/proof checks). The Rust and TypeScript sides share one report vector, so a proof made by the UI code is accepted by the contract. |

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
- No payments, downloads page or artist profile pages.
- **Reports are claims.** Nothing is hidden automatically: a person must read the queue and publish a blocklist. A determined spammer can still grind many ante identities (each costs 18 bits), and the reports contract keeps only the newest 2000.
- The ante consent prompt belongs to the node's own interface. A headless dev node cannot show it (it answers with a "request user input" message), so the full report flow needs a normal Freenet node; the rest of the path (proof format, contract acceptance, rejection of tampered reports) is tested without it.
- **Removing a release does not erase its audio.** Chunks are content-addressed and immutable: they stay on the network while nodes host them, and anyone who already has their addresses can fetch them. Removal only deletes the references (the track list) from the release and the directory.
- Editing and removing need the whoiam persona the release was published with: sign in with it on any node.
- Releases published before editing existed (an older release contract) cannot be edited or removed: the node refuses any update to them and the client only sees a timeout. The release page says so instead of offering the buttons; publish the release again to get an editable one.
- The blocklist only hides a release from the directory. It cannot remove it from Freenet.

## Development

Requirements: `rustup` with the `wasm32-unknown-unknown` target, `freenet` and `fdev`, Node 20+, ffmpeg (only to make test files).

```bash
cargo test
cargo build --release --target wasm32-unknown-unknown -p freetunes-chunk -p freetunes-release -p freetunes-directory -p freetunes-identity -p freetunes-comments -p freetunes-reports
for n in chunk release directory identity comments reports; do cp target/wasm32-unknown-unknown/release/freetunes_$n.wasm ui/src/$n.wasm; done

# isolated dev node on :7510 (does not touch a node on :7509)
mkdir -p .devnode/config .devnode/data .devnode/log
freenet local local --ws-api-port 7510 --config-dir .devnode/config --data-dir .devnode/data --log-dir .devnode/log --disable-auto-update

# a test track (kept out of ui/public, which is published with the site), then the UI
mkdir -p ui/test-assets
ffmpeg -f lavfi -i "sine=frequency=440:duration=300" -c:a libmp3lame -b:a 128k ui/test-assets/test.mp3
cd ui && npm install && npm test && echo VITE_NODE=127.0.0.1:7510 > .env.local && npm run dev
```

On Windows, put `~/.cargo/bin` before any standalone Rust install in `PATH`, otherwise `cargo` will not see the wasm target.

### Updating ante

`ui/src/ante-delegate.wasm` is the published ante delegate, extracted from ante's own vault app. `ANTE_CODE_HASH` in `ui/src/ante.ts` is the blake3 of those bytes (it matches ante's `DEPLOYMENTS.md`). A new delegate means a new hash, a new ante identity for every user, and a change of that constant: do it deliberately. The contract only depends on `ante-core`'s proof format (pinned by `rev` in `reports/Cargo.toml`), not on the delegate.

### Directory admin

The admin public key is `DIRECTORY_ADMIN` in `ui/src/lib.ts`; the secret is not in the repo (`.secrets/` is ignored). The admin page is at `#/admin` (not linked anywhere): paste the secret and the release ids to hide. The same page lists the reports, grouped by release, with a button that adds a release to the blocklist box. Changing the admin key or the directory code creates a new, empty directory.

### Publishing the site

```bash
cd ui && npm run build
fdev website init freetunes
fdev website publish dist --key freetunes     # later: fdev website update dist --key freetunes
```

Back up the signing key file: without it the site can no longer be updated.

## License

MIT, see [LICENSE](LICENSE).
