# Local patches to the vendored OpenViking sources

Everything under this directory is copied verbatim from `@openviking/opencode-plugin` (version in
`VERSION`), except:

- `config.mjs`: the User-Agent version is read from this package's `package.json`
  (`../../package.json` instead of `../package.json`).

Files not copied: `mcp-proxy-core.mjs`, `mcp-proxy-config.mjs` (the v2 host connects to the OpenViking
MCP endpoint directly as a remote server), `setup-wizard.mjs`, `debug-log.mjs`.

The `.d.mts` files next to each module are ours: they declare only the exports the host layer uses.

To refresh: copy `lib/shared/*.mjs`, `lib/utils.mjs` and `lib/config.mjs` from the new package, reapply
the patch above, bump `VERSION`, and re-run the tests.
