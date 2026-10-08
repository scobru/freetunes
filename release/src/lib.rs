//! A release: title, artist, licence, cover and tracks; each track is an ordered list of chunk addresses.
//! Parameters = hex(owner pubkey (32 bytes) || random salt), so one artist can publish any number of releases.
//! The state is signed by the owner (message bound to the full parameters). The owner can edit it: a newer
//! signed state replaces the older one (last write wins by `ts`), everything else is refused.
//! The owner can also take it down with a signed tombstone (`deleted: true`, no content). The chunks themselves
//! cannot be erased from Freenet; the tombstone only removes the references to them.
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};

pub const LICENSES: [&str; 5] = ["own", "cc-by", "cc-by-sa", "cc0", "public-domain"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Release {
    pub meta_json: String, // the exact string that was signed
    pub sig: String,       // hex ed25519 over `ftr1|<params_hex>|<meta_json>`
}

#[derive(Deserialize)]
struct Meta {
    #[serde(default)]
    title: String,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    license: String,
    /// The artist's declaration that they may publish this music.
    #[serde(default)]
    rights: bool,
    cover: Option<Cover>,
    #[serde(default)]
    tracks: Vec<Track>,
    /// The artist took the release down. A tombstone carries no content, only this flag and the timestamp.
    #[serde(default)]
    deleted: bool,
    /// Milliseconds since the epoch; a newer one wins.
    ts: u64,
}

#[derive(Deserialize)]
struct Cover {
    addr: String,
    n: u32,
}

#[derive(Deserialize)]
struct Track {
    title: String,
    chunks: Vec<ChunkRef>,
}

#[derive(Deserialize)]
struct ChunkRef {
    a: String, // chunk address (base58 instance id)
    ms: u32,   // duration of this chunk
    n: u32,    // size in bytes
}

type R<T> = Result<T, String>;

const MAX_TRACKS: usize = 50;
const MAX_CHUNKS_PER_TRACK: usize = 4000;
const MAX_CHUNK_BYTES: u32 = 8 * 1024 * 1024;

fn is_addr(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn is_text(s: &str, max: usize) -> bool {
    let n = s.chars().count();
    n >= 1 && n <= max && !s.chars().any(char::is_control)
}

fn check_meta(m: &Meta) -> R<()> {
    if m.deleted {
        // nothing but the flag: the audio references are dropped from the state
        return if m.tracks.is_empty() && m.cover.is_none() { Ok(()) } else { Err("a removed release carries no content".into()) };
    }
    if !m.rights {
        return Err("rights not declared".into());
    }
    if !is_text(&m.title, 120) || !is_text(&m.artist, 80) || !LICENSES.contains(&m.license.as_str()) {
        return Err("bad title, artist or license".into());
    }
    if let Some(c) = &m.cover {
        if !is_addr(&c.addr) || c.n == 0 || c.n > MAX_CHUNK_BYTES {
            return Err("bad cover".into());
        }
    }
    if m.tracks.is_empty() || m.tracks.len() > MAX_TRACKS {
        return Err("bad track count".into());
    }
    for t in &m.tracks {
        if !is_text(&t.title, 120) || t.chunks.is_empty() || t.chunks.len() > MAX_CHUNKS_PER_TRACK {
            return Err("bad track".into());
        }
        if t.chunks.iter().any(|c| !is_addr(&c.a) || c.ms == 0 || c.n == 0 || c.n > MAX_CHUNK_BYTES) {
            return Err("bad chunk reference".into());
        }
    }
    Ok(())
}

fn verify(params: &str, s: &Release) -> R<()> {
    let owner: [u8; 32] = hex::decode(params.get(..64).ok_or("params too short")?)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "owner key must be 32 bytes")?;
    let key = VerifyingKey::from_bytes(&owner).map_err(|e| e.to_string())?;
    let sig = Signature::from_slice(&hex::decode(&s.sig).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    key.verify(format!("ftr1|{params}|{}", s.meta_json).as_bytes(), &sig).map_err(|_| "bad signature".to_string())
}

/// Validate a signed release; returns its timestamp.
pub fn check(params: &str, s: &Release) -> R<u64> {
    verify(params, s)?;
    let m: Meta = serde_json::from_str(&s.meta_json).map_err(|e| e.to_string())?;
    check_meta(&m)?;
    Ok(m.ts)
}

/// Last write wins by timestamp; equal timestamps are broken by the metadata text so every node converges.
fn rank(s: &Release, ts: u64) -> (u64, &str) {
    (ts, s.meta_json.as_str())
}

/// Merge an incoming signed release into the current one (if any). Invalid input is an error.
pub fn merge(params: &str, current: Option<Release>, incoming: Release) -> R<Release> {
    let its = check(params, &incoming)?;
    match current {
        Some(cur) => {
            let cts = check(params, &cur)?;
            Ok(if rank(&incoming, its) > rank(&cur, cts) { incoming } else { cur })
        }
        None => Ok(incoming),
    }
}

/// Timestamp of a state, 0 if it is empty or unreadable.
fn ts_of(state: &[u8]) -> u64 {
    serde_json::from_slice::<Release>(state)
        .ok()
        .and_then(|s| serde_json::from_str::<Meta>(&s.meta_json).ok())
        .map_or(0, |m| m.ts)
}

/// Delta for a peer that knows the state with timestamp `peer_ts`: the whole release if ours is newer.
pub fn delta_for(state: &[u8], peer_ts: u64) -> Vec<u8> {
    if ts_of(state) > peer_ts { state.to_vec() } else { Vec::new() }
}

// ---- Freenet glue ----

fn params_hex(p: &Parameters) -> String {
    hex::encode(p.as_ref())
}

fn parse_release(b: &[u8]) -> Result<Release, ContractError> {
    serde_json::from_slice(b).map_err(|e| ContractError::Deser(e.to_string()))
}

#[derive(Serialize, Deserialize, Default)]
struct Summary {
    ts: u64,
}

struct Contract;

#[contract]
impl ContractInterface for Contract {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let ok = serde_json::from_slice::<Release>(state.as_ref()).is_ok_and(|s| check(&params_hex(&parameters), &s).is_ok());
        Ok(if ok { ValidateResult::Valid } else { ValidateResult::Invalid })
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let params = params_hex(&parameters);
        let mut cur = if state.as_ref().is_empty() { None } else { Some(parse_release(state.as_ref())?) };
        for u in data {
            let payloads: Vec<Vec<u8>> = match u {
                UpdateData::State(s) => vec![s.as_ref().to_vec()],
                UpdateData::Delta(d) => vec![d.as_ref().to_vec()],
                UpdateData::StateAndDelta { state, delta } => vec![state.as_ref().to_vec(), delta.as_ref().to_vec()],
                _ => return Err(ContractError::InvalidUpdate),
            };
            for p in payloads.into_iter().filter(|p| !p.is_empty()) { // an empty delta means "nothing newer"
                cur = Some(merge(&params, cur, parse_release(&p)?).map_err(|_| ContractError::InvalidUpdate)?);
            }
        }
        let out = cur.ok_or(ContractError::InvalidUpdate)?;
        let bytes = serde_json::to_vec(&out).map_err(|e| ContractError::Deser(e.to_string()))?;
        Ok(UpdateModification::valid(State::from(bytes)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let s = serde_json::to_vec(&Summary { ts: ts_of(state.as_ref()) }).map_err(|e| ContractError::Deser(e.to_string()))?;
        Ok(StateSummary::from(s))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        // an empty summary (a subscriber that knows nothing yet) means ts 0
        let peer = if summary.as_ref().is_empty() { 0 } else { serde_json::from_slice::<Summary>(summary.as_ref()).unwrap_or_default().ts };
        Ok(StateDelta::from(delta_for(state.as_ref(), peer)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sk(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }
    fn params(k: &SigningKey, salt: &str) -> String {
        format!("{}{}", hex::encode(k.verifying_key().to_bytes()), salt.repeat(16))
    }
    fn signed(k: &SigningKey, params: &str, meta: &str) -> Release {
        Release { meta_json: meta.into(), sig: hex::encode(k.sign(format!("ftr1|{params}|{meta}").as_bytes()).to_bytes()) }
    }
    fn meta(title: &str, ts: u64) -> String {
        format!(
            r#"{{"title":"{title}","artist":"Someone","license":"cc-by","rights":true,"ts":{ts},
            "cover":{{"addr":"CoverAddr1","n":40000}},
            "tracks":[{{"title":"One","chunks":[{{"a":"ChunkAddrA","ms":30000,"n":524288}},{{"a":"ChunkAddrB","ms":12000,"n":200000}}]}}]}}"#
        )
    }

    #[test]
    fn owner_edits_win_when_newer() {
        let k = sk(1);
        let p = params(&k, "aa");
        let v1 = signed(&k, &p, &meta("First EP", 100));
        let v2 = signed(&k, &p, &meta("First EP (remaster)", 200));
        assert_eq!(check(&p, &v1), Ok(100));
        // first write, then a newer edit replaces it
        let cur = merge(&p, None, v1.clone()).unwrap();
        let cur = merge(&p, Some(cur), v2.clone()).unwrap();
        assert_eq!(cur, v2);
        // an older state arriving later (another node, replayed message) does not win, in any order
        assert_eq!(merge(&p, Some(cur.clone()), v1.clone()).unwrap(), v2);
        assert_eq!(merge(&p, Some(v1), v2.clone()).unwrap(), v2);
        // equal timestamps converge on the same winner whichever arrives first
        let a = signed(&k, &p, &meta("A", 300));
        let b = signed(&k, &p, &meta("B", 300));
        assert_eq!(merge(&p, Some(a.clone()), b.clone()).unwrap(), merge(&p, Some(b), a).unwrap());
    }

    #[test]
    fn only_the_owner_can_edit_and_rules_still_apply() {
        let (owner, thief) = (sk(1), sk(2));
        let p = params(&owner, "aa");
        let v1 = signed(&owner, &p, &meta("Mine", 100));
        // someone else signs a newer version: refused
        assert!(merge(&p, Some(v1.clone()), signed(&thief, &p, &meta("Hijacked", 999))).is_err());
        // a signed copy for another release of the same owner is refused
        assert!(merge(&p, Some(v1.clone()), signed(&owner, &params(&owner, "bb"), &meta("Other", 999))).is_err());
        // the rules apply to edits too
        for bad in [
            meta("x", 200).replace(r#""rights":true"#, r#""rights":false"#),
            meta("x", 200).replace("cc-by", "all-rights-stolen"),
            meta("x", 200).replace(r#""title":"x""#, r#""title":"""#),
            meta("x", 200).replace("ChunkAddrA", "bad addr!"),
            meta("x", 200).replace(r#""ms":30000"#, r#""ms":0"#),
            meta("x", 200).replace(r#""n":524288"#, r#""n":99999999"#),
        ] {
            assert!(merge(&p, Some(v1.clone()), signed(&owner, &p, &bad)).is_err(), "{bad}");
        }
        assert!(check(&p, &signed(&owner, &p, r#"{"title":"x","artist":"y","license":"cc0","rights":true,"ts":1,"tracks":[]}"#)).is_err());
        assert!(check("abcd", &v1).is_err()); // params too short
    }

    #[test]
    fn tombstone_removes_references_and_stays_removed() {
        let k = sk(1);
        let p = params(&k, "aa");
        let live = signed(&k, &p, &meta("EP", 100));
        let gone = signed(&k, &p, r#"{"deleted":true,"ts":200}"#);
        assert_eq!(check(&p, &gone), Ok(200));
        // the tombstone replaces the live release...
        assert_eq!(merge(&p, Some(live.clone()), gone.clone()).unwrap(), gone);
        // ...and an older copy replayed later cannot bring it back, in either order
        assert_eq!(merge(&p, Some(gone.clone()), live).unwrap(), gone);
        // only the owner can take it down
        assert!(check(&p, &signed(&sk(2), &p, r#"{"deleted":true,"ts":300}"#)).is_err());
        // a tombstone must not smuggle content
        assert!(check(&p, &signed(&k, &p, &meta("EP", 300).replace(r#""rights":true"#, r#""rights":true,"deleted":true"#))).is_err());
        // the owner may publish again later with a newer state
        let again = signed(&k, &p, &meta("EP again", 400));
        assert_eq!(merge(&p, Some(gone), again.clone()).unwrap(), again);
    }

    #[test]
    fn delta_only_when_newer() {
        let k = sk(1);
        let p = params(&k, "aa");
        let bytes = serde_json::to_vec(&signed(&k, &p, &meta("EP", 500))).unwrap();
        assert_eq!(ts_of(&bytes), 500);
        assert_eq!(delta_for(&bytes, 0), bytes); // a new subscriber gets the release
        assert_eq!(delta_for(&bytes, 400), bytes); // a peer with an older one gets the newer
        assert!(delta_for(&bytes, 500).is_empty()); // up to date
        assert!(delta_for(&bytes, 600).is_empty()); // the peer is ahead
        assert_eq!(ts_of(b""), 0);
    }
}
