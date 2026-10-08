//! Content-addressed chunk of a file (audio or cover art).
//! Parameters = blake3(content), 32 bytes. The state is the content itself and can never change,
//! so anyone can verify a chunk against its address and any node can serve it.
use freenet_stdlib::prelude::*;

/// True when `content` hashes to the 32-byte `params`.
pub fn matches(params: &[u8], content: &[u8]) -> bool {
    !content.is_empty() && blake3::hash(content).as_bytes().as_slice() == params
}

struct Contract;

#[contract]
impl ContractInterface for Contract {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        Ok(if matches(parameters.as_ref(), state.as_ref()) { ValidateResult::Valid } else { ValidateResult::Invalid })
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        // immutable: an update is accepted only if it carries the very same bytes
        let new = match data.first() {
            Some(UpdateData::State(s)) => s.as_ref().to_vec(),
            Some(UpdateData::StateAndDelta { state: s, .. }) => s.as_ref().to_vec(),
            _ => return Err(ContractError::InvalidUpdate),
        };
        if state.as_ref().is_empty() && matches(parameters.as_ref(), &new) {
            return Ok(UpdateModification::valid(State::from(new))); // first write
        }
        if new == state.as_ref() {
            return Ok(UpdateModification::valid(State::from(new)));
        }
        Err(ContractError::InvalidUpdate)
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

    #[test]
    fn address_must_match_content() {
        let data = b"some audio bytes";
        let addr = blake3::hash(data);
        assert!(matches(addr.as_bytes(), data));
        assert!(!matches(addr.as_bytes(), b"other bytes"));
        assert!(!matches(&addr.as_bytes()[..31], data)); // wrong length
        assert!(!matches(blake3::hash(b"").as_bytes(), b"")); // empty chunks are not allowed
    }
}
