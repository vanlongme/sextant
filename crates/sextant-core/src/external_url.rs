//! Which URLs may leave the app for a browser (section 5.5 of the milestone spec). This parses
//! the URL because a glob over the raw string would let `http://localhost:x@evil.example/`
//! through. Refusals quote nothing from the URL, which can hold anything.

use std::net::Ipv4Addr;

use url::{Host, Url};

use crate::error::CoreResult;
use crate::resources::invalid;

/// Returns the URL as parsed, which is the form to open. Allows `https`, and `http` to
/// `localhost` or `127.0.0.1`. Refuses anything with userinfo.
pub fn check_external_url(raw: &str) -> CoreResult<String> {
    let url = Url::parse(raw).map_err(|_| invalid("the URL cannot be read"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid(
            "a URL with a user name or password cannot be opened",
        ));
    }
    let allowed = match url.scheme() {
        "https" => true,
        "http" => match url.host() {
            Some(Host::Domain(domain)) => domain == "localhost",
            Some(Host::Ipv4(address)) => address == Ipv4Addr::LOCALHOST,
            _ => false,
        },
        _ => false,
    };
    if allowed {
        Ok(url.to_string())
    } else {
        Err(invalid(
            "only https, or http to this computer, can be opened",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn https_and_local_http_are_allowed() {
        for allowed in [
            "https://example.com/",
            "https://example.com:8443/path?x=1#y",
            "http://localhost:8080/",
            "http://127.0.0.1:18080/a",
            "http://LOCALHOST/",
        ] {
            assert!(check_external_url(allowed).is_ok(), "{allowed}");
        }
    }

    #[test]
    fn the_parsed_form_is_what_gets_opened() {
        assert_eq!(
            check_external_url("http://LOCALHOST:80").unwrap(),
            "http://localhost/"
        );
    }

    #[test]
    fn everything_else_is_refused() {
        for refused in [
            // What a glob on `http://localhost:*` would let through.
            "http://localhost:x@evil.example/",
            "http://user@localhost/",
            "https://user:password@example.com/",
            "https://user@example.com/",
            "http://example.com/",
            "http://localhost.evil.example/",
            "http://127.0.0.1.evil.example/",
            "http://127.0.0.2/",
            "http://[::1]/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com/",
            "localhost:8080",
            "not a url",
            "",
        ] {
            let error = check_external_url(refused).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{refused}");
        }
    }

    #[test]
    fn a_refusal_does_not_quote_the_url() {
        let error = check_external_url("http://secret-host.example/token").unwrap_err();
        assert!(!error.message.contains("secret"), "{}", error.message);
    }
}
