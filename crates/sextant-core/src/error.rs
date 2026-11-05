use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub enum ErrorCode {
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Unreachable,
    InvalidInput,
    ToolMissing,
    Cancelled,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IpcError {
    pub code: ErrorCode,
    pub message: String,
    pub details: Option<String>,
}

impl IpcError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }
}

impl From<kube::Error> for IpcError {
    fn from(err: kube::Error) -> Self {
        match &err {
            kube::Error::Api(status) => {
                let code = match status.code {
                    401 => ErrorCode::Unauthorized,
                    403 => ErrorCode::Forbidden,
                    404 => ErrorCode::NotFound,
                    409 => ErrorCode::Conflict,
                    408 | 429 | 502 | 503 | 504 => ErrorCode::Unreachable,
                    _ => ErrorCode::Internal,
                };
                let message = if status.message.is_empty() {
                    status.reason.clone()
                } else {
                    status.message.clone()
                };
                IpcError::new(code, message).with_details(format!("HTTP {}", status.code))
            }
            kube::Error::Auth(e) => {
                IpcError::new(ErrorCode::Unauthorized, e.to_string()).with_details(format!("{e:?}"))
            }
            kube::Error::HyperError(_)
            | kube::Error::HttpError(_)
            | kube::Error::Service(_)
            | kube::Error::RustlsTls(_)
            | kube::Error::TlsRequired => IpcError::new(ErrorCode::Unreachable, err.to_string())
                .with_details(format!("{err:?}")),
            _ => {
                IpcError::new(ErrorCode::Internal, err.to_string()).with_details(format!("{err:?}"))
            }
        }
    }
}

impl From<std::io::Error> for IpcError {
    fn from(err: std::io::Error) -> Self {
        use std::io::ErrorKind;
        let code = match err.kind() {
            ErrorKind::NotFound => ErrorCode::NotFound,
            ErrorKind::PermissionDenied => ErrorCode::Forbidden,
            ErrorKind::ConnectionRefused
            | ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
            | ErrorKind::TimedOut
            | ErrorKind::NotConnected => ErrorCode::Unreachable,
            ErrorKind::InvalidInput | ErrorKind::InvalidData => ErrorCode::InvalidInput,
            _ => ErrorCode::Internal,
        };
        IpcError::new(code, err.to_string()).with_details(format!("{err:?}"))
    }
}

pub type CoreResult<T> = Result<T, IpcError>;

#[cfg(test)]
mod tests {
    use super::*;
    use kube::core::Status;

    fn api(code: u16, message: &str) -> kube::Error {
        kube::Error::Api(Status::failure(message, "Reason").with_code(code).boxed())
    }

    #[test]
    fn kube_api_statuses_map_to_codes() {
        for (status, code) in [
            (401, ErrorCode::Unauthorized),
            (403, ErrorCode::Forbidden),
            (404, ErrorCode::NotFound),
            (409, ErrorCode::Conflict),
            (500, ErrorCode::Internal),
        ] {
            let e: IpcError = api(status, "server said no").into();
            assert_eq!(e.code, code, "status {status}");
            assert_eq!(e.message, "server said no");
        }
    }

    #[test]
    fn io_errors_map() {
        let e: IpcError = std::io::Error::from(std::io::ErrorKind::NotFound).into();
        assert_eq!(e.code, ErrorCode::NotFound);
    }

    #[test]
    fn serializes_camel_case() {
        let e = IpcError::new(ErrorCode::NotFound, "x").with_details("d");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "NotFound");
        assert_eq!(v["details"], "d");
    }
}
