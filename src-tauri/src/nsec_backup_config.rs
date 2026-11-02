//! Trusted build inputs for the desktop backup service. Unset means disabled.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Config {
    pub(crate) service_url: String,
    pub(crate) namespace: String,
}

pub(crate) fn configured(
    service: Option<&str>,
    namespace: Option<&str>,
) -> Result<Option<Config>, String> {
    let (service, namespace) = match (service, namespace) {
        (None, None) => return Ok(None),
        (Some(service), Some(namespace)) => (service, namespace),
        _ => return Err("Configure both backup service URL and namespace".into()),
    };
    let url = url::Url::parse(service).map_err(|_| "Invalid backup service URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Backup service URL must use HTTPS without credentials, query or fragment".into(),
        );
    }
    if namespace.is_empty() || namespace.len() > 255 || namespace.chars().any(char::is_control) {
        return Err("Invalid backup service namespace".into());
    }
    Ok(Some(Config {
        service_url: url.as_str().trim_end_matches('/').to_owned(),
        namespace: namespace.to_owned(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_is_disabled_until_both_trusted_inputs_are_valid() {
        assert_eq!(configured(None, None).unwrap(), None);
        assert!(configured(Some("https://service.example"), None).is_err());
        assert!(configured(None, Some("buzz")).is_err());
        for service in [
            "",
            "http://service.example",
            "https://user@service.example",
            "https://service.example?key=value",
            "https://service.example#key",
        ] {
            assert!(configured(Some(service), Some("buzz")).is_err());
        }
        for namespace in ["", "buzz\n", &"a".repeat(256)] {
            assert!(configured(Some("https://service.example"), Some(namespace)).is_err());
        }
        assert_eq!(
            configured(Some("https://service.example/api/goose/"), Some("buzz")).unwrap(),
            Some(Config {
                service_url: "https://service.example/api/goose".into(),
                namespace: "buzz".into()
            })
        );
    }
}
