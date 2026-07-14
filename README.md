# swamp-datadog-readonly

[swamp](https://swamp.club) extension `@mgreten/datadog-readonly` — a read-only
Datadog incident-context surface (monitors, logs, error events, deploy
correlation). No write methods by design.

📖 **Extension documentation:** [extensions/models/README.md](extensions/models/README.md)

📦 **Install:** `swamp extension pull @mgreten/datadog-readonly`

## Repository layout

This repository is a swamp workspace (its own `.swamp.yaml` repo). The
publishable extension lives under [extensions/models/](extensions/models/):

```
swamp-datadog-readonly/
  extensions/
    models/
      datadog.ts        # model implementation
      datadog_test.ts   # unit tests
      manifest.yaml     # swamp extension manifest
      README.md         # extension documentation
      LICENSE.txt       # MIT license
  README.md             # this file
```

## License

MIT — see [extensions/models/LICENSE.txt](extensions/models/LICENSE.txt).
