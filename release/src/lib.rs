//! A release: title, artist, licence, cover and tracks; each track is an ordered list of chunk addresses.
//! Parameters = hex(owner pubkey (32 bytes) || random salt), so one artist can publish any number of releases.
//! The state is signed by the owner (message bound to the full parameters) and never changes afterwards.
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
    title: String,
    artist: String,
    license: String,
    /// The artist's declaration that they may publish this music.
    rights: bool,
    cover: Option<Cover>,
    tracks: Vec<Track>,
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

pub fn check(params: &str, s: &Release) -> R<()> {
    verify(params, s)?;
    check_meta(&serde_json::from_str(&s.meta_json).map_err(|e| e.to_string())?)
}

/// First write, or the very same state again. Anything else is refused: releases are immutable.
pub fn accept_update(params: &str, old: &[u8], new: &[u8]) -> bool {
    if new == old {
        return true;
    }
    old.is_empty() && serde_json::from_slice::<Release>(new).is_ok_and(|s| check(params, &s).is_ok())
}

// ---- Freenet glue ----

fn params_hex(p: &Parameters) -> String {
    hex::encode(p.as_ref())
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
        let new = match data.first() {
            Some(UpdateData::State(s)) => s.as_ref().to_vec(),
            Some(UpdateData::StateAndDelta { state: s, .. }) => s.as_ref().to_vec(),
            _ => return Err(ContractError::InvalidUpdate),
        };
        if accept_update(&params_hex(&parameters), state.as_ref(), &new) {
            Ok(UpdateModification::valid(State::from(new)))
        } else {
            Err(ContractError::InvalidUpdate)
        }
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        _state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        Ok(StateSummary::from(Vec::new()))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        _state: State<'static>,
        _summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        Ok(StateDelta::from(Vec::new()))
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
    fn state(k: &SigningKey, params: &str, meta: &str) -> Release {
        Release { meta_json: meta.into(), sig: hex::encode(k.sign(format!("ftr1|{params}|{meta}").as_bytes()).to_bytes()) }
    }
    const META: &str = r#"{"title":"First EP","artist":"Someone","license":"cc-by","rights":true,
        "cover":{"addr":"CoverAddr1","n":40000},
        "tracks":[{"title":"One","chunks":[{"a":"ChunkAddrA","ms":30000,"n":524288},{"a":"ChunkAddrB","ms":12000,"n":200000}]}]}"#;

    #[test]
    fn valid_release_and_immutability() {
        let k = sk(1);
        let p = params(&k, "aa");
        let s = state(&k, &p, META);
        check(&p, &s).unwrap();
        let bytes = serde_json::to_vec(&s).unwrap();
        assert!(accept_update(&p, b"", &bytes)); // first write
        assert!(accept_update(&p, &bytes, &bytes)); // same again
        let other = serde_json::to_vec(&state(&k, &p, &META.replace("First EP", "Changed"))).unwrap();
        assert!(!accept_update(&p, &bytes, &other)); // immutable
    }

    #[test]
    fn rules_are_enforced() {
        let k = sk(1);
        let p = params(&k, "aa");
        for bad in [
            META.replace(r#""rights":true"#, r#""rights":false"#),      // no rights declaration
            META.replace("cc-by", "all-rights-stolen"),                 // unknown licence
            META.replace(r#""title":"First EP""#, r#""title":"""#),     // empty title
            META.replace("ChunkAddrA", "bad addr!"),                    // bad chunk address
            META.replace(r#""ms":30000"#, r#""ms":0"#),                 // zero duration
            META.replace(r#""n":524288"#, r#""n":99999999"#),           // oversized chunk
        ] {
            assert!(check(&p, &state(&k, &p, &bad)).is_err(), "{bad}");
        }
        assert!(check(&p, &state(&k, &p, r#"{"title":"x","artist":"y","license":"cc0","rights":true,"tracks":[]}"#)).is_err());
    }

    #[test]
    fn signature_is_bound_to_owner_and_params() {
        let (a, b) = (sk(1), sk(2));
        let p = params(&a, "aa");
        let s = state(&a, &p, META);
        assert!(check(&params(&a, "bb"), &s).is_err()); // same owner, other release: no cloning
        assert!(check(&p, &state(&b, &p, META)).is_err()); // signed by someone else
        assert!(check("abcd", &s).is_err()); // params too short
    }
}
