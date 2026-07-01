#[derive(Debug, PartialEq, Eq)]
pub struct ServerConfig {
	pub port: u16,
}

#[derive(Debug)]
pub enum ConfigError {
	MissingPort,
	InvalidPort(std::num::ParseIntError),
}

impl std::fmt::Display for ConfigError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::MissingPort => f.write_str("missing port"),
			Self::InvalidPort(_) => f.write_str("invalid port"),
		}
	}
}

impl std::error::Error for ConfigError {
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		match self {
			Self::MissingPort => None,
			Self::InvalidPort(err) => Some(err),
		}
	}
}

pub fn parse_config(input: &str) -> Result<ServerConfig, ConfigError> {
	let raw_port = input
		.strip_prefix("port=")
		.ok_or(ConfigError::MissingPort)?;
	let port = raw_port.parse::<u16>().map_err(ConfigError::InvalidPort)?;
	Ok(ServerConfig { port })
}

#[cfg(test)]
mod tests {
	use std::error::Error;

	use super::*;

	#[test]
	fn parses_valid_port() {
		match parse_config("port=8080") {
			Ok(config) => assert_eq!(config, ServerConfig { port: 8080 }),
			Err(err) => panic!("expected valid config, got {err}"),
		}
	}

	#[test]
	fn reports_missing_port() {
		assert!(matches!(parse_config("host=localhost"), Err(ConfigError::MissingPort)));
	}

	#[test]
	fn reports_invalid_port_message() {
		let err = match parse_config("port=abc") {
			Ok(config) => panic!("expected invalid port, got {config:?}"),
			Err(err) => err,
		};
		assert_eq!(err.to_string(), "invalid port");
		assert!(err.source().is_some());
	}
}
