//! HTTP transport for backup enrollment, encrypted uploads, and native recovery.
//! The caller supplies a trusted service URL and a BBIdentity native session credential.
//! Encryption, sign-in, and installing the recovered key belong to the caller.

#![deny(unsafe_code)]

use std::{fmt, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::header::{HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Deserializer};
use url::{Host, Url};
use zeroize::Zeroizing;

const BACKUPS: &str = "v1/buzz/nsec-backups";
const MAX_JSON_BYTES: usize = 4096;
const MAX_RECOVERY_BYTES: usize = 64 * 1024;

/// Metadata and recipient public key returned by enrollment.
/// The encryption layer must validate the version, suite, and public key before sealing.
#[derive(Debug, Deserialize)]
pub struct Enrollment {
    pub version: u8,
    pub suite: Suite,
    pub recipient_key_id: String,
    pub service_namespace: String,
    pub owner_id: String,
    pub backup_id: String,
    pub nostr_pubkey: String,
    pub recipient_public_key: String,
}

/// RFC 9180 algorithm identifiers supplied by the service.
#[derive(Debug, Deserialize)]
pub struct Suite {
    pub kem_id: u16,
    pub kdf_id: u16,
    pub aead_id: u16,
}

/// The service's acknowledgment of an upload.
#[derive(Debug, Deserialize)]
pub struct UploadReceipt {
    pub backup_id: String,
    pub stored: bool,
}

/// All recovered backups and failed IDs, in the service's order.
#[derive(Debug, Deserialize)]
pub struct Recovery {
    pub backups: Vec<RecoveredBackup>,
    pub failed_backup_ids: Vec<String>,
}

/// A recovered key and its public metadata. Debug output omits the secret.
#[derive(Deserialize)]
pub struct RecoveredBackup {
    pub backup_id: String,
    pub nostr_pubkey: String,
    #[serde(deserialize_with = "deserialize_secret")]
    // Keep key bytes in a stable allocation when the recovery list grows.
    secret_key: Box<Zeroizing<[u8; 32]>>,
}

impl RecoveredBackup {
    /// Borrow the decoded secret; any copies made by the caller need their own cleanup.
    pub fn secret_key(&self) -> &[u8; 32] {
        &self.secret_key
    }
}

impl fmt::Debug for RecoveredBackup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RecoveredBackup")
            .field("backup_id", &self.backup_id)
            .field("nostr_pubkey", &self.nostr_pubkey)
            .field("secret_key", &"[REDACTED]")
            .finish()
    }
}

fn deserialize_secret<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Box<Zeroizing<[u8; 32]>>, D::Error> {
    let encoded = Zeroizing::new(String::deserialize(deserializer)?);
    let mut secret = Box::new(Zeroizing::new([0; 32]));
    if encoded.len() != 43
        || URL_SAFE_NO_PAD.decode_slice(encoded.as_bytes(), &mut **secret) != Ok(32)
    {
        return Err(serde::de::Error::custom("invalid recovery secret"));
    }
    Ok(secret)
}

/// Transport and response errors. HTTP errors retain the status without the response body.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(
        "service URL must use HTTPS (or loopback HTTP), without credentials, query, or fragment"
    )]
    InvalidServiceUrl,
    #[error("invalid BBIdentity session credential")]
    InvalidCredential,
    #[error("backup service transport failed")]
    Transport,
    #[error("backup service returned HTTP {0}")]
    HttpStatus(u16),
    #[error("invalid backup service JSON or recovery secret")]
    InvalidResponse,
    #[error("backup body exceeds {0} bytes")]
    BodyTooLarge(usize),
}

/// A native session's client for the three backup endpoints.
pub struct Client {
    http: reqwest::Client,
    base_url: Url,
    header: HeaderName,
    credential: HeaderValue,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client").finish_non_exhaustive()
    }
}

impl Client {
    /// Create a client from the service root, including any API path prefix.
    /// Routes are appended to that prefix whether or not it has a trailing slash.
    pub fn new(service_url: &str, credential: &str) -> Result<Self, Error> {
        Self::build(
            service_url,
            HeaderName::from_static("x-bb-session-credential"),
            credential,
        )
    }

    /// Like `new`, but authenticates with `Authorization: Bearer <token>`.
    pub fn bearer(service_url: &str, token: &str) -> Result<Self, Error> {
        if token.is_empty() {
            return Err(Error::InvalidCredential);
        }
        Self::build(
            service_url,
            AUTHORIZATION,
            &Zeroizing::new(format!("Bearer {token}")),
        )
    }

    fn build(service_url: &str, header: HeaderName, credential: &str) -> Result<Self, Error> {
        let mut base_url = Url::parse(service_url).map_err(|_| Error::InvalidServiceUrl)?;
        let loopback = match base_url.host() {
            Some(Host::Ipv4(ip)) => ip.is_loopback(),
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            Some(Host::Domain(host)) => host == "localhost",
            None => false,
        };
        if !(base_url.scheme() == "https" || (base_url.scheme() == "http" && loopback))
            || !base_url.username().is_empty()
            || base_url.password().is_some()
            || base_url.query().is_some()
            || base_url.fragment().is_some()
        {
            return Err(Error::InvalidServiceUrl);
        }
        base_url
            .path_segments_mut()
            .map_err(|_| Error::InvalidServiceUrl)?
            .pop_if_empty()
            .push("");
        if credential.is_empty() {
            return Err(Error::InvalidCredential);
        }
        let mut credential =
            HeaderValue::from_str(credential).map_err(|_| Error::InvalidCredential)?;
        credential.set_sensitive(true);
        let mut http = reqwest::Client::builder()
            // The session header must never follow a redirect to another destination.
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(30));
        if base_url.scheme() == "http" {
            // Loopback HTTP must not send credentials through an ambient proxy.
            http = http.no_proxy();
        }
        let http = http.build().map_err(|_| Error::Transport)?;
        Ok(Self {
            http,
            base_url,
            header,
            credential,
        })
    }

    /// Get the recipient key and metadata for encrypting a backup.
    pub async fn enroll(&self) -> Result<Enrollment, Error> {
        let body = self
            .post(&format!("{BACKUPS}/enrollment"), &[], MAX_JSON_BYTES)
            .await?;
        serde_json::from_slice(&body).map_err(|_| Error::InvalidResponse)
    }

    /// Upload a serialized HPKE envelope. Reuse the same bytes when retrying.
    pub async fn upload(&self, envelope_json: &[u8]) -> Result<UploadReceipt, Error> {
        if envelope_json.len() > MAX_JSON_BYTES {
            return Err(Error::BodyTooLarge(MAX_JSON_BYTES));
        }
        let body = self.post(BACKUPS, envelope_json, MAX_JSON_BYTES).await?;
        serde_json::from_slice(&body).map_err(|_| Error::InvalidResponse)
    }

    /// Recover all keys without selecting or installing one.
    /// HTTP 404 can mean no backups or an unavailable recovery endpoint.
    /// A successful response may contain only failed backup IDs.
    pub async fn recover(&self) -> Result<Recovery, Error> {
        let body = self
            .post(&format!("{BACKUPS}/recovery"), &[], MAX_RECOVERY_BYTES)
            .await?;
        serde_json::from_slice(&body).map_err(|_| Error::InvalidResponse)
    }

    async fn post(
        &self,
        path: &str,
        body: &[u8],
        limit: usize,
    ) -> Result<Zeroizing<Vec<u8>>, Error> {
        let url = self
            .base_url
            .join(path)
            .map_err(|_| Error::InvalidServiceUrl)?;
        let mut response = self
            .http
            .post(url)
            .header(&self.header, &self.credential)
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_vec())
            .send()
            .await
            .map_err(|_| Error::Transport)?;
        if !response.status().is_success() {
            return Err(Error::HttpStatus(response.status().as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|len| len > limit as u64)
        {
            return Err(Error::BodyTooLarge(limit));
        }
        // Reserve the bound so growing the buffer does not leave earlier secret copies.
        let mut bytes = Zeroizing::new(Vec::with_capacity(limit));
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Transport)? {
            if chunk.len() > limit - bytes.len() {
                return Err(Error::BodyTooLarge(limit));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}
