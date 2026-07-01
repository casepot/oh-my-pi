#[derive(Debug, PartialEq, Eq)]
pub struct ServerConfig {
	pub port: u16,
}

// Benchmark fixture rationale: this intentionally panics so the task can
// migrate it to typed errors.
pub fn parse_config(input: &str) -> ServerConfig {
	let port = input.strip_prefix("port=").unwrap().parse::<u16>().unwrap();
	ServerConfig { port }
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
