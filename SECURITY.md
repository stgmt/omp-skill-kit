# Security

Report vulnerabilities privately to the repository maintainers before public disclosure.

The plugin downloads only HTTPS artifacts whose SHA-256 digests are pinned in `runtime-manifest.json`. Archives reject absolute paths, traversal, links, duplicates, and bounded-size violations. The bridge binds to loopback, requires a per-process bearer token, and bounds JSONL requests and responses.

Raw prompts are sent only over the local bridge for ranking. The bridge does not log or persist raw prompts; route analytics receive a hash through mega-tron.
