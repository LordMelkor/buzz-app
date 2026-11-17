//! `host.relayKinds`: event kinds a plugin may sign as the viewer and publish.
//! The reserved list is the one place that says which kinds Buzz keeps for its
//! own signing paths; admission and every publish both ask it.

/// Most kinds one plugin may declare.
pub const MAX_RELAY_KINDS: usize = 8;

/// Kinds Buzz signs for its own purposes. The sources are
/// the native writer's set (`nativeWriteKinds`, `WORKFLOW_KINDS`), the
/// packaged-relay signer's allow-list (`validate_event` in `relay.rs`), the
/// purpose-bound signers (auth proofs, DM, reminders, read state, sidebar,
/// channel recipes, Huddles, observer archives, pairing, Mesh status) and the
/// kinds the credential provider and app agents sign.
const RESERVED: &[u16] = &[
    0, 3, 5, 7, 9, 1064, 1617, 1618, 1619, 1621, 1984, 10000, 10001, 10002, 10003, 10030, 10100,
    13534, 13535, 20001, 20002, 20003, 22242, 24134, 24200, 24242, 24243, 27235, 28936, 30000,
    30003, 30023, 30030, 30078, 30174, 30175, 30176, 30177, 30178, 30179, 30300, 30315, 30617,
    30618, 30620, 30621, 39002, 40100, 41010, 41011, 41012, 42000, 44100, 44200, 45010, 45011,
    46020, 46030, 46031,
];
/// Inclusive ranges. 9000-9999 is every channel admin and command kind.
const RESERVED_RANGES: &[(u16, u16)] = &[
    (1630, 1633),
    (9000, 9999),
    (40002, 40008),
    (43001, 43006),
    (45001, 45003),
    (48100, 48103),
];

/// Private messages and remote signing: NIP-04 kind 4, NIP-17 kinds 14 and 15
/// and its inbox relay list 10050, NIP-59 seal 13 and gift wrap 1059, and
/// NIP-46 signer messages 24133. No plugin may send a private message as the
/// viewer, move where the viewer's private messages arrive, or speak for their
/// signer.
const PRIVATE: &[u16] = &[4, 13, 14, 15, 1059, 10050, 24133];

/// Whether Buzz keeps `kind` for its own signing or as private, so no grant may
/// include it.
pub fn reserved_relay_kind(kind: u16) -> bool {
    RESERVED.contains(&kind)
        || PRIVATE.contains(&kind)
        || RESERVED_RANGES
            .iter()
            .any(|(first, last)| (*first..=*last).contains(&kind))
}

pub(crate) fn validate(kinds: &[u16]) -> Result<(), String> {
    if kinds.len() > MAX_RELAY_KINDS {
        return Err(format!(
            "At most {MAX_RELAY_KINDS} relay kinds may be declared"
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for kind in kinds {
        if *kind == 0 || reserved_relay_kind(*kind) || !seen.insert(kind) {
            return Err("Invalid relay kind declaration".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The integer literals of the first `[...]` after `marker` in `source`.
    fn literals(source: &str, marker: &str) -> Vec<u16> {
        let list = &source[source.find(marker).unwrap()..];
        let list = &list[list.find('[').unwrap() + 1..list.find(']').unwrap()];
        list.split(',')
            .filter_map(|item| item.trim().parse().ok())
            .collect()
    }

    #[test]
    fn every_kind_the_native_writer_signs_is_reserved() {
        let native = include_str!("../../../src/features/relay/native.ts");
        let workflows = include_str!("../../../src/features/workflows/protocol.ts");
        let kinds: Vec<_> = literals(native, "nativeWriteKinds = [")
            .into_iter()
            .chain(literals(workflows, "WORKFLOW_KINDS = ["))
            .collect();
        assert!(kinds.len() > 15, "the TypeScript lists were not found");
        for kind in kinds {
            assert!(reserved_relay_kind(kind), "{kind} is not reserved");
        }
    }

    #[test]
    fn purpose_bound_kinds_are_reserved_and_example_kinds_are_not() {
        for kind in [
            0, 5, 7, 1984, 9000, 9007, 9999, 22242, 24242, 27235, 30078, 30300, 41010, 41012,
            45010, 48103,
        ] {
            assert!(reserved_relay_kind(kind), "{kind}");
        }
        for kind in [1, 47000, 47001, 65535] {
            assert!(!reserved_relay_kind(kind), "{kind}");
        }
    }

    #[test]
    fn no_grant_may_include_a_private_message_or_signer_kind() {
        for kind in [4, 13, 14, 15, 1059, 10050, 24133] {
            assert!(validate(&[47000, kind]).is_err(), "{kind}");
        }
    }

    #[test]
    fn a_declaration_has_at_most_eight_distinct_unreserved_kinds() {
        assert!(validate(&[]).is_ok());
        assert!(validate(&[47000, 47001]).is_ok());
        assert!(validate(&[47000, 47001, 47002, 47003, 47004, 47005, 47006, 47007]).is_ok());
        assert!(
            validate(&[47000, 47001, 47002, 47003, 47004, 47005, 47006, 47007, 47008]).is_err()
        );
        assert!(validate(&[47000, 47000]).is_err());
        assert!(validate(&[0]).is_err());
        assert!(validate(&[47000, 9000]).is_err());
    }
}
