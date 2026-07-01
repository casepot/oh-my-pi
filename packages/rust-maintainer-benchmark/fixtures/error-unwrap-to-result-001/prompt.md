# Return typed config parse errors instead of panicking

`parse_config` currently panics on missing or invalid `port=` input.

Change it to return `Result<ServerConfig, ConfigError>` with a typed error enum. Preserve the `ServerConfig` fields. Use the display messages `missing port` and `invalid port`, and keep the parse error as the source for invalid ports.

The fixture includes tests for valid input, missing port, invalid port display text, and invalid port source; make those tests pass.
