# Provider cassettes

Pi workers wrap `fetch`. Set:

- `STATION_CASSETTE=record` to save redacted request/response pairs
- `STATION_CASSETTE=replay` to serve those pairs and **refuse unmatched live calls**
- `STATION_CASSETTE_FILE=/absolute/path.json`

```sh
STATION_CASSETTE=record STATION_CASSETTE_FILE="$PWD/test/cassettes/demo-pi.json" pnpm start
```

Replay in CI after a cassette exists:

```sh
STATION_CASSETTE=replay STATION_CASSETTE_FILE="$PWD/test/cassettes/demo-pi.json" pnpm test
```

Authorization headers and `*key*` / `*token*` query parameters are replaced with `[redacted]` before the file is written. Do not commit cassettes that still contain secrets.
