//! Native sealing ported from block/buzz#7849 (90c01a13).
//! Enrollment and expected context must come from the authenticated native service.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use buzz_nsec_backup::Enrollment;
use rustls::crypto::{
    aws_lc_rs::hpke::DH_KEM_P256_HKDF_SHA256_AES_256,
    hpke::{Hpke, HpkePublicKey},
};
use secp256k1::{PublicKey, Secp256k1, SecretKey, XOnlyPublicKey};
use uuid::Uuid;

const INFO: &[u8] = b"buzz/nsec-backup/v1";
const AAD_DOMAIN: &[u8] = b"buzz/nsec-backup/aad/v1";
const INVALID: &str = "Backup enrollment could not be verified";
const FAILED: &str = "Could not encrypt the backup";

struct Validated {
    recipient: [u8; 65],
    backup_id: Uuid,
    pubkey: [u8; 32],
}

/// Validate fresh enrollment before reusing an already sealed envelope.
pub(super) fn validate_enrollment(
    enrollment: &Enrollment,
    namespace: &str,
    owner: &str,
    pubkey: &str,
) -> Result<(), String> {
    validate(enrollment, namespace, owner, pubkey).map(|_| ())
}

/// Seal a local key only for its authenticated account and configured environment.
pub(super) fn seal(
    enrollment: &Enrollment,
    namespace: &str,
    owner: &str,
    pubkey: &str,
    secret: &[u8; 32],
) -> Result<Vec<u8>, String> {
    let context = validate(enrollment, namespace, owner, pubkey)?;
    let mut key = SecretKey::from_byte_array(*secret).map_err(|_| INVALID)?;
    let derived = PublicKey::from_secret_key(&Secp256k1::signing_only(), &key)
        .x_only_public_key()
        .0
        .serialize();
    key.non_secure_erase();
    if derived != context.pubkey {
        return Err(INVALID.into());
    }
    let aad = associated_data(enrollment, &context.backup_id, &context.pubkey);
    // The caller owns the zeroizing key buffer; provider allocations are not guaranteed wiped.
    let (enc, ciphertext) = DH_KEM_P256_HKDF_SHA256_AES_256
        .seal(
            INFO,
            &aad,
            secret,
            &HpkePublicKey(context.recipient.to_vec()),
        )
        .map_err(|_| FAILED)?;
    if enc.0.len() != 65 || enc.0.first() != Some(&0x04) || ciphertext.len() != 48 {
        return Err(FAILED.into());
    }
    serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "suite": { "kem_id": 0x0010, "kdf_id": 0x0001, "aead_id": 0x0002 },
        "recipient_key_id": enrollment.recipient_key_id,
        "service_namespace": enrollment.service_namespace,
        "owner_id": enrollment.owner_id,
        "backup_id": enrollment.backup_id,
        "nostr_pubkey": enrollment.nostr_pubkey,
        "enc": URL_SAFE_NO_PAD.encode(enc.0),
        "ciphertext": URL_SAFE_NO_PAD.encode(ciphertext),
    }))
    .map_err(|_| FAILED.into())
}

fn validate(
    enrollment: &Enrollment,
    namespace: &str,
    owner: &str,
    pubkey: &str,
) -> Result<Validated, String> {
    if enrollment.version != 1
        || enrollment.suite.kem_id != 0x0010
        || enrollment.suite.kdf_id != 0x0001
        || enrollment.suite.aead_id != 0x0002
        || enrollment.service_namespace != namespace
        || enrollment.owner_id != owner
        || enrollment.nostr_pubkey != pubkey
    {
        return Err(INVALID.into());
    }
    for value in [
        &enrollment.recipient_key_id,
        &enrollment.service_namespace,
        &enrollment.owner_id,
    ] {
        if value.is_empty() || value.len() > 255 || value.chars().any(char::is_control) {
            return Err(INVALID.into());
        }
    }
    let backup_id = Uuid::parse_str(&enrollment.backup_id).map_err(|_| INVALID)?;
    if backup_id.hyphenated().to_string() != enrollment.backup_id || pubkey.len() != 64 {
        return Err(INVALID.into());
    }
    let pubkey: XOnlyPublicKey = pubkey.parse().map_err(|_| INVALID)?;
    if pubkey.to_string() != enrollment.nostr_pubkey || enrollment.recipient_public_key.len() != 87
    {
        return Err(INVALID.into());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(&enrollment.recipient_public_key)
        .map_err(|_| INVALID)?;
    if URL_SAFE_NO_PAD.encode(&decoded) != enrollment.recipient_public_key {
        return Err(INVALID.into());
    }
    let recipient: [u8; 65] = decoded.try_into().map_err(|_| INVALID)?;
    if recipient[0] != 0x04 {
        return Err(INVALID.into());
    }
    Ok(Validated {
        recipient,
        backup_id,
        pubkey: pubkey.serialize(),
    })
}

fn associated_data(enrollment: &Enrollment, backup_id: &Uuid, pubkey: &[u8; 32]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(1024);
    aad.extend_from_slice(AAD_DOMAIN);
    aad.push(1);
    aad.extend_from_slice(&0x0010u16.to_be_bytes());
    aad.extend_from_slice(&0x0001u16.to_be_bytes());
    aad.extend_from_slice(&0x0002u16.to_be_bytes());
    for value in [
        &enrollment.recipient_key_id,
        &enrollment.service_namespace,
        &enrollment.owner_id,
    ] {
        // Validation bounds each UTF-8 field to 255 bytes before framing.
        aad.extend_from_slice(&(value.len() as u16).to_be_bytes());
        aad.extend_from_slice(value.as_bytes());
    }
    aad.extend_from_slice(backup_id.as_bytes());
    aad.extend_from_slice(pubkey);
    aad
}

#[cfg(test)]
#[path = "crypto_tests.rs"]
mod tests;
