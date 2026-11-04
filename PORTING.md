# Protocol source and Node port

`protocol-source.json` records the exact source bytes imported from the sibling mini-program. This directory is standalone and has no runtime dependency on that checkout.

- `crypto`, `envelope`, `recovery`, `snapshot`, `payload`, `merge`, `cloud-records`: unchanged protocol implementations. Native Node Web Crypto supplies randomness.
- `sync`: installation display name changed to WatchRSS CLI. Cloud device `platform: phone` remains the encryption-device category accepted by the existing schema; access uses a distinct CLI credential, with no phone-license capacity operations.
- `cloud-reader`: installation display name changed; legacy account-wide conversion fails with an actionable consent-required error rather than calling WeChat UI.
- `vendor/url`: replaced mini-program URL polyfill with Node WHATWG URL.
- `storage`, `http`, `account`, `appaccess`, `login`, `user-error`, `cloud-storage-upgrade`: Node adapters. No WeChat login impersonation, phone access claim, or implicit records conversion.
- `library`, `cloud-library`, RSS and segmented readers keep the existing merge, tombstone, encryption, hash-checking and carry-forward behavior.
- The small WeChat-only filesystem download fallback in `sync` is unreachable: Node HTTP returns binary data directly. The random fallback in `crypto` is unreachable on supported Node versions.

Vendored noble and fflate bundles retain their upstream license notices. The redundant browser URL vendor bundle is not used.

## 2026-10-25 protocol refresh

The initial source was mini-program `6a673e878680cbb73f1567324aea4722169c497f`. The current alignment uses an explicitly marked, review-only mini working-tree pin (see below); it does not claim these new bytes belong to the old commit. `scripts/sync-protocol.py` imports the complete protocol dependency closure (39 modules) and records SHA-256 of original bytes in `protocol-source.json`, and hashes the independently adapted outputs in `protocol-port.json`. `npm run build` validates output pins and syntax. Tests verify original bytes at the recorded Git ref (or the explicitly recorded pending working tree) and all copied shared vectors. The sibling checkout is a development input only, never a runtime dependency.

Node adapters: native filesystem with atomic rename, CAS revisions, sparse state overlays, native fetch/Web Crypto, explicit terminal login, no wx global or mini-program UI imports. Runtime-root checks use the private `WATCHRSS_HOME`. The cloud mode keeps book packages and saved/public bodies in memory; only projections, ciphertext upload plans and key custody persist. HTTP passes caller headers, adds cached generation on content writes, and restricts credentialed uploads to the configured backend's authenticated epoch-proxy endpoint. External signed downloads carry no API/account/CLI credentials. R48 capability discovery does not enable Write/Migration.

The extra `cloud-reader` port hooks persist encrypted upload plans before PUT and retire them after complete; a new process refreshes reservation proofs, skips confirmed objects, and resumes completion. Missing/expired reservations discard the entire old plan; the normal writer reserves afresh from retained local originals. Generation/epoch changes retire derived plans without deleting local originals or keys. `WATCHRSS_PROGRESS=1` emits upload progress JSON to stderr; stdout remains one command result.

Production policy explicitly rejects CLI key commit/rotate (`key_migration_phone_required`) and watch pairing (`watch_pairing_phone_required`). `keys init` returns that actionable error; use an authorized phone/mini-program for first setup, then `keys recover`. The test-only phone fixture coordinator is isolated under `scripts/production-*`; ordinary CLI code never falls back to phone credentials or claims phone capacity.

R46/R47 are BLE optimization contracts; this CLI has no BLE transport and advertises neither fast-path capability. It consumes their current cloud projections via R44 book/book-reading records and current RSS interaction fields, preserving independent clocks/cancellations and retirement semantics. Notes objects remain authenticated snapshot objects, carried without dropping or inventing record kinds.

CLI adds one durable `progress` intent handler to the shared projection driver: progress edits must be replayable after a concurrent CAS conflict or a failed push, like saved-state edits. Without this port hook, a pull before the next push can overwrite an unacknowledged reading position. The wire record format remains unchanged. The CLI command adapter turns the driver's string error codes into proper Error objects and exits nonzero while preserving pending state.

## CLI stress round 2 (2026-10-25)

The Node-only transport retries reads and exact-byte PUTs at most twice, with
exponential jitter and Retry-After, inside one monotonic operation budget.
Ambiguous POSTs are returned to their durable intent/upload-plan owner. Retry
fences preserve account, lifecycle and content generation; no auth fallback.

Explicit recovery may bootstrap a revoked installation to re-register it. Normal
sync still rejects revoked devices. Existing local state edits use a single
post-intent sync and one membership check. The driver already pulls and rebases
before replaying those intents.

CLI metadata sync disables implicit public RSS refresh (use `sources refresh`).
Sparse RSS batching before cursor commit now comes directly from the mini source,
with no CLI transformation. Neither changes wire bytes, CAS or R48 gates.

Deferred local mutations reuse the existing account/session-bound member cache;
when none is valid they fetch entitlement once. A normal online command still
checks the server. Credential TTLs use a process monotonic clock anchored by
successful backend Date headers, so a running command's wall-clock correction
cannot invalidate a just-issued CLI credential. This does not alter the shared
protocol's wall-clock LWW merge policy.

A bounded (32 entries / 8 MiB), account/backend-scoped manifest ciphertext cache
also survives CLI process restarts. A current authenticated head must match its
hash, size and decrypted identity. If none of the requested legacy index objects
exist, the cached manifest suffices without another download-descriptor request.
R45 content clear removes this cache, and optional-cache failures cannot fail a
remote commit. Object bodies and R48 unknown/opaque content keep their existing
read/write gates.

Round 2 also merges duplicate sparse RSS projections with the existing CRDT
before encoding; a stale article projection cannot overwrite a retained tombstone.
Local article state operations stamp the writing device; RSS read application
retains that winning device for future tie breaks. Bootstrap capability flags
suppress redundant per-process declarations only when all three R48 flags match.
Stable empty deltas avoid whole-library record hashing while retaining pending
migration/retirement work and R45 rebuild paths.
