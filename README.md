# FreeTunes

> **Experiment.** FreeTunes is an experiment on [Freenet](https://freenet.org): a minimal, Bandcamp-like place to publish and stream music with no server. It is unfinished, may break or lose data, and should not be relied on for anything.

> **Rights disclaimer.** Only publish music you own, music in the public domain, or music whose licence allows you to publish it (for example Creative Commons). Everything you publish is **public and permanent**: Freenet has no global delete, so you will not be able to remove it. You are responsible for what you publish.

## Idea

An artist creates an identity, publishes a release (cover, title, tracks, licence), and anyone can stream it. No accounts, no hosting, no payments.

## Design

Everything is a Freenet contract:

| Contract | What it holds | Address |
| --- | --- | --- |
| **Chunk** (`chunk/`) | A slice of a file (audio or cover). Immutable. | `blake3(code \|\| blake3(content))`: anyone can verify a chunk against its address |
| **Release** (planned) | Title, artist, licence, cover, and per track the ordered list of chunk addresses and durations. Signed by the artist. | owner key + random salt |
| **Directory** (planned) | Public list of releases, with proof-of-work against spam and an admin blocklist | one shared instance |

Identity, signing, the directory and publishing the site will come from [FreePolls](https://github.com/scobru/freepolls) (delegate, registry, salted parameters, `fdev website`).

### Streaming

Tracks are split at MP3 frame boundaries into chunks of about 512 KB, so every chunk is a valid stand-alone stream. The player appends them to a `MediaSource` in order and starts playing after the first one, instead of waiting for the whole file.

## Spike results

Measured on a local dev node (no network latency), browser to node over WebSocket:

| Chunk size | Publish | Read back |
| --- | --- | --- |
| 64 KB | 0.3 s | 11 ms |
| 1 MB | 0.3 s | 0.1 s |
| 4 MB | 0.95 s | 0.4 s |
| 16 MB | 4.2 s | 2.0 s |
| 48 MB | 13 s | 5.9 s |
| 55 MB | rejected | — |

- **Hard limit: 50 MiB (52,428,800 bytes) per contract state.** The node rejects larger states; the client only sees a timeout, so the app must check sizes itself.
- A 4.8 MB, 5-minute MP3 split into 10 chunks of 512 KB published in 1.4 s. Reading a chunk took about 50 ms.
- `MediaSource` accepted all 10 chunks as `audio/mpeg` (300 s buffered, no decoder error) in Chromium. Audible playback was not checked in the test environment (background media is paused there), and `audio/mpeg` support in other browsers still needs to be checked.
- These are local numbers. Real-network latency and availability are unknown.

## Known limits

- Content can disappear if no node hosts it: nodes drop the least requested contracts. The artist must keep a node running, or someone must seed the release.
- Streaming starts after the first chunk, but seeking inside a track is not designed yet (it needs a time to chunk index).
- No transcoding: files are published as they are. MP3 (MPEG-1 Layer III) is the only format the splitter understands so far.
- No payments, no downloads page, no comments, no profile pages.

## Development

Requirements: `rustup` with the `wasm32-unknown-unknown` target, `freenet` and `fdev`, Node 20+, ffmpeg (only to make the test file).

```bash
cargo test
cargo build --release --target wasm32-unknown-unknown -p freetunes-chunk
cp target/wasm32-unknown-unknown/release/freetunes_chunk.wasm ui/src/chunk.wasm

# isolated dev node on :7510
mkdir -p .devnode/config .devnode/data .devnode/log
freenet local local --ws-api-port 7510 --config-dir .devnode/config --data-dir .devnode/data --log-dir .devnode/log --disable-auto-update

# a 5-minute test track, then the UI
ffmpeg -f lavfi -i "sine=frequency=440:duration=300" -c:a libmp3lame -b:a 128k ui/public/test.mp3
cd ui && npm install && npm run dev
```

The spike is driven from the browser console: `spike.limits([64, 1024, 4096])`, `spike.publishMp3("/test.mp3", 512)`, `spike.stream(addresses)`.

## License

MIT, see [LICENSE](LICENSE).
