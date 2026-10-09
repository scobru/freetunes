//! Reports about releases and tracks (for example a track that may infringe copyright). One global contract, no parameters.
//!
//! Spam protection is ante (github.com/soudasuwa/ante): every report carries an `AnteProof`, a proof-of-work
//! commitment signed by the reporter's ante identity, whose purpose binds the work to this exact report
//! (`freetunes:report:v1:<blake3 of the report>`). A report can therefore not be replayed with other content,
//! and each one costs `MIN_BITS` of work from one identity. Verifying it is one hash and one signature.
//!
//! - A report never hides anything by itself: it is public information for visitors and the moderator.
//! - One report per (release, track, ante identity): a second one from the same identity is ignored, so one
//!   identity cannot inflate the count. (Another identity costs another proof of work.)
//! - The newest MAX_REPORTS are kept, with a deterministic rule, so merge order does not matter.
use ante_core::AnteProof;
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MIN_BITS: u32 = 18;
pub const MAX_REPORTS: usize = 2000;
pub const WHOLE_RELEASE: u8 = 255;
const MAX_TRACK: u8 = 50;
const MAX_NOTE: usize = 300;
const MAX_CONTACT: usize = 100;
pub const KINDS: [&str; 3] = ["copyright", "illegal", "other"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Report {
    pub target: String, // release instance id, as listed in the directory
    pub track: u8,      // track index, or WHOLE_RELEASE
    pub kind: String,   // one of KINDS
    pub note: String,   // what is wrong, who owns the rights
    pub contact: String, // optional: how the moderator can reach the reporter
    pub ts: u64,
    pub a: String,     // reporter's ante identity (verifying key), hex
    pub proof: String, // hex of the CBOR `AnteProof`
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct State {
    #[serde(default)]
    pub reports: BTreeMap<String, Report>, // "<target>:<track>:<ante identity>" -> report
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Summary {
    #[serde(default)]
    pub reports: BTreeSet<String>,
}

type R<T> = Result<T, String>;

pub fn report_key(r: &Report) -> String {
    format!("{}:{}:{}", r.target, r.track, r.a)
}

/// The text the ante purpose commits to. Free text never contains a line break (checked), so the fields cannot blur.
pub fn digest(r: &Report) -> String {
    let s = format!("ftr1\n{}\n{}\n{}\n{}\n{}\n{}", r.target, r.track, r.kind, r.note, r.contact, r.ts);
    hex::encode(blake3::hash(s.as_bytes()).as_bytes())
}

pub fn purpose(r: &Report) -> String {
    format!("freetunes:report:v1:{}", digest(r))
}

fn plain(s: &str, max: usize) -> bool {
    s.chars().count() <= max && !s.chars().any(char::is_control)
}

pub fn check_report(key: &str, r: &Report) -> R<()> {
    let target_ok = (1..=64).contains(&r.target.len()) && r.target.bytes().all(|b| b.is_ascii_alphanumeric());
    let track_ok = r.track < MAX_TRACK || r.track == WHOLE_RELEASE;
    if !target_ok || !track_ok || !KINDS.contains(&r.kind.as_str()) || !plain(&r.note, MAX_NOTE) || !plain(&r.contact, MAX_CONTACT) {
        return Err("bad report".into());
    }
    if r.kind == "other" && r.note.trim().is_empty() {
        return Err("say what is wrong".into());
    }
    if key != report_key(r) {
        return Err("key does not match the content".into());
    }
    let proof: AnteProof = ante_core::from_cbor(&hex::decode(&r.proof).map_err(|e| e.to_string())?)?;
    if hex::encode(proof.identity_vk) != r.a {
        return Err("proof belongs to another identity".into());
    }
    if proof.purpose != purpose(r) {
        return Err("proof is for another report".into());
    }
    proof.verify(MIN_BITS).map(|_| ()).map_err(|e| e.to_string())
}

fn prune(m: &mut BTreeMap<String, Report>) {
    if m.len() <= MAX_REPORTS {
        return;
    }
    let mut order: Vec<_> = m.iter().map(|(k, v)| (std::cmp::Reverse(v.ts), k.clone())).collect();
    order.sort();
    for (_, k) in order.into_iter().skip(MAX_REPORTS) {
        m.remove(&k);
    }
}

pub fn validate(s: &State) -> R<()> {
    if s.reports.len() > MAX_REPORTS {
        return Err("state out of bounds".into());
    }
    s.reports.iter().try_for_each(|(k, r)| check_report(k, r))
}

/// Merge a delta: anything invalid rejects the update; a known key keeps its first report.
pub fn apply(s: &mut State, d: State) -> R<()> {
    for (k, r) in d.reports {
        if !s.reports.contains_key(&k) {
            check_report(&k, &r)?;
            s.reports.insert(k, r);
        }
    }
    prune(&mut s.reports);
    Ok(())
}

pub fn summarize(s: &State) -> Summary {
    Summary { reports: s.reports.keys().cloned().collect() }
}

pub fn delta(s: &State, sum: &Summary) -> State {
    State { reports: s.reports.iter().filter(|(k, _)| !sum.reports.contains(*k)).map(|(k, v)| (k.clone(), v.clone())).collect() }
}

// ---- Freenet glue ----

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
        _parameters: Parameters<'static>,
        state: freenet_stdlib::prelude::State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let s: State = de_or_default(state.as_ref())?;
        Ok(match validate(&s) {
            Ok(()) => ValidateResult::Valid,
            Err(_) => ValidateResult::Invalid,
        })
    }

    fn update_state(
        _parameters: Parameters<'static>,
        state: freenet_stdlib::prelude::State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let mut s: State = de_or_default(state.as_ref())?;
        for u in data {
            let payloads: Vec<Vec<u8>> = match u {
                UpdateData::State(st) => vec![st.as_ref().to_vec()],
                UpdateData::Delta(d) => vec![d.as_ref().to_vec()],
                UpdateData::StateAndDelta { state, delta } => vec![state.as_ref().to_vec(), delta.as_ref().to_vec()],
                _ => return Err(ContractError::InvalidUpdate),
            };
            for p in payloads.into_iter().filter(|p| !p.is_empty()) {
                apply(&mut s, de(&p)?).map_err(|_| ContractError::InvalidUpdate)?;
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
    use ante_core::pow;
    use ed25519_dalek::SigningKey;

    fn ante_key(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }

    /// A report with a real ante proof (18 bits of work, about 2^18 blake3 hashes).
    fn report(who: &SigningKey, target: &str, track: u8, kind: &str, note: &str, ts: u64) -> (String, Report) {
        let vk = who.verifying_key().to_bytes();
        let mut r = Report { target: target.into(), track, kind: kind.into(), note: note.into(), contact: String::new(), ts, a: hex::encode(vk), proof: String::new() };
        let p = purpose(&r);
        let nonce = pow::grind(&p, &vk, MIN_BITS).unwrap();
        r.proof = hex::encode(ante_core::to_cbor(&AnteProof::create(who, p, nonce, ts)));
        (report_key(&r), r)
    }

    fn state(items: Vec<(String, Report)>) -> State {
        State { reports: items.into_iter().collect() }
    }

    #[test]
    fn a_report_needs_a_valid_proof_bound_to_its_content() {
        let k = ante_key(1);
        let (key, r) = report(&k, "AbC123", 2, "copyright", "This is a song by X", 10);
        check_report(&key, &r).unwrap();
        // edited content, another track, another kind: the purpose no longer matches
        let edits: [fn(&mut Report); 5] = [
            |r| r.note = "changed".into(),
            |r| r.target = "Other1".into(),
            |r| r.kind = "other".into(),
            |r| r.ts += 1,
            |r| r.contact = "me@example.com".into(),
        ];
        for edit in edits {
            let mut e = r.clone();
            edit(&mut e);
            assert!(check_report(&report_key(&e), &e).is_err());
        }
        let mut moved = r.clone();
        moved.track = 3;
        assert!(check_report(&report_key(&moved), &moved).is_err());
        // somebody else's identity on the same proof, key not matching, garbage proof
        let mut theirs = r.clone();
        theirs.a = hex::encode(ante_key(2).verifying_key().to_bytes());
        assert!(check_report(&report_key(&theirs), &theirs).is_err());
        assert!(check_report("AbC123:2:nope", &r).is_err());
        let mut junk = r.clone();
        junk.proof = "00".into();
        assert!(check_report(&key, &junk).is_err());
    }

    #[test]
    fn too_little_work_is_refused() {
        let who = ante_key(3);
        let vk = who.verifying_key().to_bytes();
        let mut r = Report { target: "T1".into(), track: WHOLE_RELEASE, kind: "copyright".into(), note: String::new(), contact: String::new(), ts: 1, a: hex::encode(vk), proof: String::new() };
        let p = purpose(&r);
        // honestly signed, but only the first nonce that clears 4 bits (below the bar unless very lucky)
        let nonce = (0u64..).find(|n| pow::bits(&p, &vk, *n) >= 4 && pow::bits(&p, &vk, *n) < MIN_BITS).unwrap();
        r.proof = hex::encode(ante_core::to_cbor(&AnteProof::create(&who, p, nonce, 1)));
        assert!(check_report(&report_key(&r), &r).is_err());
    }

    #[test]
    fn bad_content_is_refused() {
        let k = ante_key(4);
        let long = "x".repeat(MAX_NOTE + 1);
        for (kind, note, track) in [("spam", "x", 0u8), ("other", "", 0), ("copyright", "line\nbreak", 0), ("copyright", long.as_str(), 0), ("copyright", "x", 51)] {
            let (key, r) = report(&k, "T1", track, kind, note, 1);
            assert!(check_report(&key, &r).is_err(), "{kind:?} {note:?} {track}");
        }
    }

    #[test]
    fn merge_dedupes_per_identity_and_is_order_independent() {
        let (a, b) = (ante_key(5), ante_key(6));
        let r1 = report(&a, "T1", 0, "copyright", "first", 10);
        let r1_again = report(&a, "T1", 0, "copyright", "second", 20); // same identity, same track
        let r2 = report(&b, "T1", 0, "copyright", "other person", 11);
        let r3 = report(&a, "T1", 1, "copyright", "other track", 12);
        let mut s = State::default();
        apply(&mut s, state(vec![r1.clone(), r2.clone()])).unwrap();
        assert_eq!(s.reports.len(), 2);
        apply(&mut s, state(vec![r1_again, r3.clone()])).unwrap();
        // the same key keeps the first report; the other track is a new report
        assert_eq!(s.reports.len(), 3);
        assert_eq!(s.reports[&r1.0].note, "first");
        validate(&s).unwrap();
        // one invalid entry rejects the whole delta
        let mut bad = r3.1.clone();
        bad.note = "tampered".into();
        let mut t = State::default(); // (a known key is skipped without a check)
        assert!(apply(&mut t, state(vec![(report_key(&bad), bad)])).is_err());
        // summaries and deltas
        let sum = summarize(&State { reports: [r1].into_iter().collect() });
        assert_eq!(delta(&s, &sum).reports.len(), 2);
    }

    /// Made by the browser side (ui/src/ante.ts, same vector in ui/src/ante.test.ts): both agree on the purpose
    /// digest and on the ante wire format, so a report built in the UI is accepted here.
    #[test]
    fn a_proof_made_by_the_ui_code_verifies() {
        let r = Report {
            target: "AbC123".into(), track: 2, kind: "copyright".into(), note: "This is a song by X".into(), contact: String::new(), ts: 1_700_000_000_000,
            a: "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c".into(),
            proof: "a56b6964656e746974795f766b982018ea184a186c186318e2189c18520a18be18f51850187b13182e18c518f918951847187618ae18be18be187b18921842181e18ea186914184618d2182c67707572706f736578546672656574756e65733a7265706f72743a76313a66643435366637376232353465663464353436376536363638643534656335636137316333623164663461393565613039353236656530383033366339336633656e6f6e63651a000125026274731b0000018bcfe56800697369676e6174757265984018f2189418f5181c182618d618bb171847185618d4183818f4187e184d18bb186a0d18330a183614183d181c18c81882188715189018ea18de18fd18a418431857183a13188018ed18d518eb18e8183c183218650c185018740e1892181c188205183b18eb121833188218a9181a189c18f018c606".into(),
        };
        assert_eq!(purpose(&r), "freetunes:report:v1:fd456f77b254ef4d5467e6668d54ec5ca71c3b1df4a95ea09526ee08036c93f3");
        check_report(&report_key(&r), &r).unwrap();
    }
}
