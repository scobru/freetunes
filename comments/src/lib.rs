//! Comments on one release, per track. One contract per release; its parameters are the release's own parameters
//! (hex: owner persona || salt || app path), so the contract knows who the release owner is. Authors and owners
//! are whoiam personas: every comment and removal is signed by an app key the persona delegated for that app path
//! (see `whoiam-delegation`) and carries the delegation.
//!
//! - A comment is signed by its author (`ftc1|...`) and carries a small proof-of-work, so posting costs a moment
//!   of CPU and spam is not free. Anyone with a key can post; reading needs nothing.
//! - A removal is signed too (`ftc2|...`) and filed under `<comment id>:<signer>`, so a removal by someone else can
//!   never shadow the real one. It takes effect when the signer is the comment's author or the release owner;
//!   anyone else's is stored but ignored. Removals are permanent, which keeps the merge a plain union.
//! - The newest MAX_ITEMS comments and removals are kept, with a deterministic rule, so merge order does not matter.
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use whoiam_delegation::{check as check_cert, verify as verify_sig, Cert};

pub const POW_BITS: u32 = 16;
pub const MAX_ITEMS: usize = 1000;
const MAX_TEXT: usize = 500;
const MAX_NAME: usize = 40;
const MAX_TRACK: u8 = 50;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Comment {
    pub a: String,    // author public key, hex
    pub name: String, // display name chosen by the author, signed with the comment
    pub track: u8,
    pub ts: u64,
    pub text: String,
    pub nonce: u64,
    pub sig: String, // hex, by the author's delegated app key, over `ftc1|<params>|<a>|<track>|<ts>|<name>|<text>`
    pub cert: Cert,  // the author's delegation to that key
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Removal {
    pub by: String, // signer persona, hex
    pub ts: u64,
    pub nonce: u64,
    pub sig: String, // hex, by the signer's delegated app key, over `ftc2|<params>|<comment id>|<ts>`
    pub cert: Cert,  // the signer's delegation to that key
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct State {
    #[serde(default)]
    pub items: BTreeMap<String, Comment>, // comment id -> comment
    #[serde(default)]
    pub removed: BTreeMap<String, Removal>, // "<comment id>:<signer public key>" -> removal
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Summary {
    #[serde(default)]
    pub items: BTreeSet<String>,
    #[serde(default)]
    pub removed: BTreeSet<String>,
}

type R<T> = Result<T, String>;

/// The app path at the end of the release parameters (after owner and salt).
fn app_of(params: &str) -> R<String> {
    let raw = hex::decode(params).map_err(|e| e.to_string())?;
    String::from_utf8(raw.get(48..).ok_or("params too short")?.to_vec()).map_err(|e| e.to_string())
}

/// `msg` is signed by an app key that persona `who` delegated for this release's app.
fn verify(params: &str, who: &str, cert: &Cert, msg: &str, sig_hex: &str) -> R<()> {
    verify_sig(&check_cert(who, &app_of(params)?, cert)?, msg.as_bytes(), sig_hex)
}

fn zero_bits(h: &[u8]) -> u32 {
    let mut n = 0;
    for b in h {
        n += b.leading_zeros();
        if *b != 0 {
            break;
        }
    }
    n
}

fn pow_ok(msg: &str, nonce: u64) -> bool {
    zero_bits(&Sha256::digest(format!("{msg}|{nonce}").as_bytes())) >= POW_BITS
}

fn comment_msg(params: &str, c: &Comment) -> String {
    format!("ftc1|{params}|{}|{}|{}|{}|{}", c.a, c.track, c.ts, c.name, c.text)
}

/// A comment's id is derived from its signed content, so nobody can file a comment under another one's id.
pub fn comment_id(params: &str, c: &Comment) -> String {
    hex::encode(Sha256::digest(comment_msg(params, c).as_bytes()))[..32].to_string()
}

fn removal_msg(params: &str, id: &str, r: &Removal) -> String {
    format!("ftc2|{params}|{id}|{}", r.ts)
}

fn is_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn check_comment(params: &str, id: &str, c: &Comment) -> R<()> {
    let name_ok = c.name.chars().count() <= MAX_NAME && !c.name.chars().any(char::is_control);
    let text = c.text.trim();
    // text may contain line breaks but no other control characters
    let text_ok = !text.is_empty() && c.text.chars().count() <= MAX_TEXT && !c.text.chars().any(|ch| ch.is_control() && ch != '\n');
    if !name_ok || !text_ok || c.track >= MAX_TRACK {
        return Err("bad comment".into());
    }
    if id != comment_id(params, c) {
        return Err("id does not match the content".into());
    }
    let msg = comment_msg(params, c);
    if !pow_ok(&msg, c.nonce) {
        return Err("insufficient proof of work".into());
    }
    verify(params, &c.a, &c.cert, &msg, &c.sig)
}

pub fn removal_key(id: &str, by: &str) -> String {
    format!("{id}:{by}")
}

pub fn check_removal(params: &str, key: &str, r: &Removal) -> R<()> {
    let (id, by) = key.split_once(':').ok_or("bad removal key")?;
    if !is_id(id) || by != r.by {
        return Err("bad removal key".into());
    }
    let msg = removal_msg(params, id, r);
    if !pow_ok(&msg, r.nonce) {
        return Err("insufficient proof of work".into());
    }
    verify(params, &r.by, &r.cert, &msg, &r.sig)
}

fn owner_of(params: &str) -> R<&str> {
    app_of(params)?; // also checks the length
    Ok(&params[..64])
}

/// Does a removal actually hide this comment? Only the comment's author and the release owner may remove it.
pub fn is_removed(params: &str, s: &State, id: &str) -> bool {
    let Ok(owner) = owner_of(params) else { return false };
    s.removed.contains_key(&removal_key(id, owner))
        || s.items.get(id).is_some_and(|c| s.removed.contains_key(&removal_key(id, &c.a)))
}

fn prune<T>(m: &mut BTreeMap<String, T>, ts: impl Fn(&T) -> u64) {
    if m.len() <= MAX_ITEMS {
        return;
    }
    let mut order: Vec<_> = m.iter().map(|(k, v)| (std::cmp::Reverse(ts(v)), k.clone())).collect();
    order.sort();
    for (_, k) in order.into_iter().skip(MAX_ITEMS) {
        m.remove(&k);
    }
}

pub fn validate(params: &str, s: &State) -> R<()> {
    owner_of(params)?;
    if s.items.len() > MAX_ITEMS || s.removed.len() > MAX_ITEMS {
        return Err("state out of bounds".into());
    }
    s.items.iter().try_for_each(|(id, c)| check_comment(params, id, c))?;
    s.removed.iter().try_for_each(|(k, r)| check_removal(params, k, r))
}

/// Merge a delta: anything invalid rejects the update; known entries are skipped.
pub fn apply(params: &str, s: &mut State, d: State) -> R<()> {
    owner_of(params)?;
    for (id, c) in d.items {
        if !s.items.contains_key(&id) {
            check_comment(params, &id, &c)?;
            s.items.insert(id, c);
        }
    }
    for (k, r) in d.removed {
        if !s.removed.contains_key(&k) {
            check_removal(params, &k, &r)?;
            s.removed.insert(k, r);
        }
    }
    prune(&mut s.items, |c| c.ts);
    prune(&mut s.removed, |r| r.ts);
    Ok(())
}

pub fn summarize(s: &State) -> Summary {
    Summary { items: s.items.keys().cloned().collect(), removed: s.removed.keys().cloned().collect() }
}

pub fn delta(s: &State, sum: &Summary) -> State {
    State {
        items: s.items.iter().filter(|(k, _)| !sum.items.contains(*k)).map(|(k, v)| (k.clone(), v.clone())).collect(),
        removed: s.removed.iter().filter(|(k, _)| !sum.removed.contains(*k)).map(|(k, v)| (k.clone(), v.clone())).collect(),
    }
}

// ---- Freenet glue ----

fn params_hex(p: &Parameters) -> String {
    hex::encode(p.as_ref())
}

fn de<T: for<'a> Deserialize<'a>>(b: &[u8]) -> Result<T, ContractError> {
    serde_json::from_slice(b).map_err(|e| ContractError::Deser(e.to_string()))
}

/// Empty bytes (a subscriber that knows nothing yet) mean the default value.
fn de_or_default<T: for<'a> Deserialize<'a> + Default>(b: &[u8]) -> Result<T, ContractError> {
    if b.is_empty() { Ok(T::default()) } else { de(b) }
}

fn ser<T: Serialize>(v: &T) -> Result<Vec<u8>, ContractError> {
    serde_json::to_vec(v).map_err(|e| ContractError::Deser(e.to_string()))
}

struct Contract;

#[contract]
impl ContractInterface for Contract {
    fn validate_state(
        parameters: Parameters<'static>,
        state: freenet_stdlib::prelude::State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let s: State = de_or_default(state.as_ref())?;
        Ok(match validate(&params_hex(&parameters), &s) {
            Ok(()) => ValidateResult::Valid,
            Err(_) => ValidateResult::Invalid,
        })
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: freenet_stdlib::prelude::State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let params = params_hex(&parameters);
        let mut s: State = de_or_default(state.as_ref())?;
        for u in data {
            let payloads: Vec<Vec<u8>> = match u {
                UpdateData::State(st) => vec![st.as_ref().to_vec()],
                UpdateData::Delta(d) => vec![d.as_ref().to_vec()],
                UpdateData::StateAndDelta { state, delta } => vec![state.as_ref().to_vec(), delta.as_ref().to_vec()],
                _ => return Err(ContractError::InvalidUpdate),
            };
            for p in payloads.into_iter().filter(|p| !p.is_empty()) {
                apply(&params, &mut s, de(&p)?).map_err(|_| ContractError::InvalidUpdate)?;
            }
        }
        Ok(UpdateModification::valid(freenet_stdlib::prelude::State::from(ser(&s)?)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: freenet_stdlib::prelude::State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        Ok(StateSummary::from(ser(&summarize(&de_or_default(state.as_ref())?))?))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: freenet_stdlib::prelude::State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        Ok(StateDelta::from(ser(&delta(&de_or_default(state.as_ref())?, &de_or_default(summary.as_ref())?))?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sk(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }
    fn pk(k: &SigningKey) -> String {
        hex::encode(k.verifying_key().to_bytes())
    }
    const APP: &str = "/v1/contract/web/Tunes1/";
    fn release(owner: &SigningKey, salt: &str) -> String {
        format!("{}{}{}", pk(owner), salt.repeat(16), hex::encode(APP))
    }
    /// Persona `who` delegates the app key `sk(100 + n)` for this app.
    fn cert(who: &SigningKey) -> Cert {
        let app_key = pk(&app_key_of(who));
        let (base, challenge) = (format!("http://127.0.0.1:7509{APP}"), format!("wd1.{app_key}.n1"));
        let sig = who.sign(&whoiam_delegation::connect_message(who.verifying_key().as_bytes(), &base, &challenge, 1));
        Cert { base, challenge, ts: 1, sig: hex::encode(sig.to_bytes()) }
    }
    fn app_key_of(who: &SigningKey) -> SigningKey {
        SigningKey::from_bytes(&[who.to_bytes()[0].wrapping_add(100); 32])
    }
    fn mine(msg: &str) -> u64 {
        (0u64..).find(|n| pow_ok(msg, *n)).unwrap()
    }

    /// A valid comment with a real proof of work (about 2^16 hashes).
    fn comment(params: &str, who: &SigningKey, track: u8, ts: u64, text: &str) -> (String, Comment) {
        let mut c = Comment { a: pk(who), name: "Ann".into(), track, ts, text: text.into(), nonce: 0, sig: String::new(), cert: cert(who) };
        let msg = comment_msg(params, &c);
        c.sig = hex::encode(app_key_of(who).sign(msg.as_bytes()).to_bytes());
        c.nonce = mine(&msg);
        (comment_id(params, &c), c)
    }

    /// A removal of comment `id` by `who`, as (key, removal).
    fn removal(params: &str, who: &SigningKey, id: &str, ts: u64) -> (String, Removal) {
        let mut r = Removal { by: pk(who), ts, nonce: 0, sig: String::new(), cert: cert(who) };
        let msg = removal_msg(params, id, &r);
        r.sig = hex::encode(app_key_of(who).sign(msg.as_bytes()).to_bytes());
        r.nonce = mine(&msg);
        (removal_key(id, &r.by), r)
    }

    fn delta_of(items: Vec<(String, Comment)>, removed: Vec<(String, Removal)>) -> State {
        State { items: items.into_iter().collect(), removed: removed.into_iter().collect() }
    }

    #[test]
    fn comments_are_signed_and_bound_to_the_release() {
        let (owner, ann) = (sk(1), sk(2));
        let params = release(&owner, "aa");
        let (id, c) = comment(&params, &ann, 0, 10, "Great track");
        check_comment(&params, &id, &c).unwrap();
        // another release (same owner, other salt): the signature does not carry over
        assert!(check_comment(&release(&owner, "bb"), &id, &c).is_err());
        // edited text, forged author, wrong id, no proof of work, bad content
        let mut edited = c.clone();
        edited.text = "Terrible track".into();
        assert!(check_comment(&params, &id, &edited).is_err());
        let mut forged = c.clone();
        forged.a = pk(&sk(3));
        assert!(check_comment(&params, &id, &forged).is_err());
        assert!(check_comment(&params, &"0".repeat(32), &c).is_err());
        let mut lazy = c.clone();
        lazy.nonce += 1; // fails with probability 2^-16 only
        assert!(check_comment(&params, &id, &lazy).is_err());
        for bad in ["", "   ", &"x".repeat(MAX_TEXT + 1), "bell \u{7}"] {
            let (i, b) = comment(&params, &ann, 0, 10, bad);
            assert!(check_comment(&params, &i, &b).is_err(), "{bad:?}");
        }
        let (i, b) = comment(&params, &ann, MAX_TRACK, 10, "track out of range");
        assert!(check_comment(&params, &i, &b).is_err());
    }

    #[test]
    fn who_may_remove_what() {
        let (owner, ann, eve) = (sk(1), sk(2), sk(3));
        let params = release(&owner, "aa");
        let mut s = State::default();
        let (id, c) = comment(&params, &ann, 1, 10, "hello");
        apply(&params, &mut s, delta_of(vec![(id.clone(), c)], vec![])).unwrap();
        assert!(!is_removed(&params, &s, &id));
        // a stranger's removal is accepted as data but does nothing...
        apply(&params, &mut s, delta_of(vec![], vec![removal(&params, &eve, &id, 20)])).unwrap();
        assert!(!is_removed(&params, &s, &id));
        // ...and cannot shadow the author's: the removal filed first does not block the real one
        let mut s2 = s.clone();
        apply(&params, &mut s2, delta_of(vec![], vec![removal(&params, &ann, &id, 21)])).unwrap();
        assert!(is_removed(&params, &s2, &id));
        // the release owner can remove any comment
        let mut s3 = s.clone();
        apply(&params, &mut s3, delta_of(vec![], vec![removal(&params, &owner, &id, 22)])).unwrap();
        assert!(is_removed(&params, &s3, &id));
        // a removal filed under someone else's name, or with a forged signature, is refused
        let mut clean = State::default();
        clean.items = s.items.clone();
        let (k, mut bad) = removal(&params, &eve, &id, 23);
        bad.by = pk(&ann);
        assert!(apply(&params, &mut clean, delta_of(vec![], vec![(k, bad)])).is_err());
        let (_, forged) = removal(&params, &eve, &id, 24);
        assert!(apply(&params, &mut clean, delta_of(vec![], vec![(removal_key(&id, &pk(&ann)), forged)])).is_err());
        validate(&params, &s3).unwrap();
    }

    #[test]
    fn merge_delta_and_prune() {
        let (owner, ann) = (sk(1), sk(2));
        let params = release(&owner, "aa");
        let (i1, c1) = comment(&params, &ann, 0, 10, "one");
        let (i2, c2) = comment(&params, &ann, 0, 20, "two");
        // same entries in either order give the same state
        let (mut a, mut b) = (State::default(), State::default());
        apply(&params, &mut a, delta_of(vec![(i1.clone(), c1.clone())], vec![])).unwrap();
        apply(&params, &mut a, delta_of(vec![(i2.clone(), c2.clone())], vec![])).unwrap();
        apply(&params, &mut b, delta_of(vec![(i2.clone(), c2)], vec![])).unwrap();
        apply(&params, &mut b, delta_of(vec![(i1.clone(), c1)], vec![])).unwrap();
        assert_eq!(a, b);
        // a peer that has only one comment gets just the other
        let d = delta(&a, &Summary { items: [i1.clone()].into(), removed: BTreeSet::new() });
        assert_eq!(d.items.keys().collect::<Vec<_>>(), [&i2]);
        assert!(delta(&a, &summarize(&a)).items.is_empty());
        // pruning keeps the newest
        let mut m: BTreeMap<String, u64> = (0..(MAX_ITEMS as u64 + 5)).map(|i| (format!("{i:032}"), i)).collect();
        prune(&mut m, |t| *t);
        assert_eq!(m.len(), MAX_ITEMS);
        assert!(m.values().all(|t| *t >= 5));
    }
}
