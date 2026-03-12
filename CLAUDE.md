# Nova

## Overview
Nova - deploy and manage websites on Filecoin Onchain Cloud with ENS resolution.

Single package with two entry points:
- `nova` CLI - interactive deploy, ENS update, status check, storage management
- `nova-mcp` - MCP server (5 tools for Claude Code, Claude Desktop, Cursor, Windsurf, VS Code)

## Architecture
```
CLI (nova)                  MCP Server (nova-mcp)
nova deploy [path]    <-->  nova_deploy tool
nova ens <cid>        <-->  nova_ens tool
nova status           <-->  nova_status tool
nova manage           <-->  nova_manage tool
nova manage clean     <-->  nova_manage_clean tool
```

## CLI Commands
- `nova deploy [path]` - Deploy directory or archive to FOC, optionally update ENS
- `nova deploy --clean` - Deploy and remove ALL other pieces (only new deploy kept)
- `nova ens <name>` - Check ENS contenthash + pin status (read-only)
- `nova ens <cid> --ens <name>` - Point ENS domain to an IPFS CID (write mode)
- `nova info <cid>` - Show details for a specific deployment (dataset, pieces, size, proofs)
- `nova wallet` - Show wallet FIL/USDFC balance and deposit status
- `nova download <cid> [dir]` - Download content from IPFS to local directory
- `nova manage` - List all pieces grouped by IPFS root CID (with deploy times, proof status)
- `nova manage clean` - Dry-run by default, `--really-do-it` to execute
- `nova demo <url-or-path>` - Zero-config demo deploy to calibnet (no wallet needed)
- `nova clone <url>` - Clone a website and deploy to Filecoin
- `nova status` - Deprecated, use `nova ens <name>` instead

## Source Files
```
src/cli.ts       - CLI entry point, arg parsing, prompts
src/auth.ts      - Shared Filecoin auth (createSynapse, resolveWalletAddress, StorageAuth)
src/car.ts       - CAR file builder (directory -> UnixFS DAG -> CAR on disk)
src/upload.ts    - Direct upload to FOC via synapse-sdk (streams CAR to provider, IPNI metadata)
src/subgraph.ts  - PDP Scan subgraph queries (Goldsky) for timestamps, sizes, proof data
src/deploy.ts    - Orchestrates upload + ENS
src/ens.ts       - ENS contenthash encoding/updating/reading (ethers v6)
src/archive.ts   - Archive detection and extraction to temp dir
src/manage.ts    - Storage management (list pieces, clean duplicates/old deploys)
src/mcp.ts       - MCP server (7 tools: deploy, demo, ens, status, manage, manage_clean, poll)
src/prompt.ts    - Readline wrapper (lazy init)
src/config.ts    - Environment variable resolution (no credentials file)
src/poll.ts      - On-chain state polling for browser wallet signing flows
src/signing-url.ts - Browser signing page URL construction
src/demo.ts      - Demo mode (embedded calibnet session key)
src/clone.ts     - Site cloning via Playwright (crawl, asset download, locale detection)
src/ui.ts        - Visual design system (colours, gutter, labels)
```

## Key Dependencies
- `@filoz/synapse-sdk` + `@filoz/synapse-core` - Direct SDK for uploads and storage management
- `@helia/unixfs` + `@ipld/car` + `blockstore-core` - CAR file construction
- `ethers` v6 - ENS contenthash updates
- `multiformats` - IPFS CID parsing, encoding, v0/v1 normalization
- `viem` - Wallet account derivation for Synapse SDK
- `@modelcontextprotocol/sdk` - MCP server
- `zod` v4 - MCP input schema validation
- `playwright` - Headless browser for site cloning (crawl + render JS-heavy sites)

## ENS Details
- Test domain: `ezpdpz.eth`
- ENS contenthash stores IPFS CID in encoded format (EIP-1577)
- Resolution: `ezpdpz.eth.limo` serves content from IPFS gateway
- Mainnet ENS - requires mainnet ETH for gas
- Auth: session key + wallet address (preferred), or env vars for CI
- Env vars: `NOVA_SESSION_KEY`, `NOVA_WALLET_ADDRESS`, `NOVA_PIN_KEY`, `NOVA_ENS_KEY`, `NOVA_ENS_NAME`, `NOVA_RPC_URL`, `NOVA_PROVIDER_ID`
- Browser signing: ENS updates via MetaMask at ens.focify.eth.limo, session keys at session.focify.eth.limo, Filecoin tx at fil.focify.eth.limo
- Wallet pages branded "FOCify.ME", default to mainnet, logo as focify.png (transparent, not base64)
- Footer: "Built for & powered by Filecoin Onchain Cloud"
- Web frontend (focify.me): deployed to 77.42.75.71:8090, PM2 `focify-me`, streams `nova demo` via SSE

## Storage Management
Uses `@filoz/synapse-sdk` (v0.38.0+) directly, NOT filecoin-pin CLI.
- `WarmStorageService.getClientDataSetsWithDetails(address)` - list datasets
- `StorageContext.getPieces()` - iterate pieces in a dataset
- `StorageContext.getScheduledRemovals()` - track pending removal status
- `StorageContext.deletePiece()` - schedule piece removal (one per tx, no batching)
- `WarmStorageService.getPieceMetadataByKey()` - get ipfsRootCID per piece
- `getSizeFromPieceCID()` from `@filoz/synapse-core/piece` - derive piece size from PieceCID

**Key constraints:**
- No local database - all state from on-chain queries
- No batch deletion - HTTP API accepts one piece per DELETE call
- Piece ID ordering identifies latest vs old deploys; subgraph provides real timestamps + proof data when available
- `deletePiece` schedules removal - provider processes on its own schedule
- ENS returns CIDv0 (`Qm...`), FOC stores CIDv1 (`bafybei...`) - must normalize before comparing

## Gotchas
- **CRITICAL: `withIPFSIndexing` metadata** - Must set `withIPFSIndexing: ""` in both `pieceMetadata` AND `metadata` (dataset-level) on `StorageManager.upload()`. Without it, providers don't advertise to IPNI and IPFS gateways return 504. This is the #1 cause of "deploy works but gateway fails".
- **Dataset metadata matching** - SDK reuses datasets only when metadata exactly matches. `metadata: { withIPFSIndexing: "" }` matches filecoin-pin datasets. `withCDN: false` produces empty metadata `{}` which won't match.
- CID format mismatch: ENS stores CIDv0, FOC metadata stores CIDv1 - use `CID.parse().toV1()` to normalize
- MCP stdout reserved for JSON-RPC - all console output redirected to stderr via `redirectConsole()`
- Session key auth: synapse.client must use root wallet address (for dataset lookups), sessionClient uses session key (for signing). See auth.ts.
- CAR streaming: pass ReadableStream (not Uint8Array) to StorageManager.upload() to bypass 200 MiB limit, routing through uploadPieceStreaming (1 GiB limit)
- `--clean` on first-ever deploy may fail with "No datasets found" - handled gracefully by catch

## Crawling (clone.ts)

### Core principle: clone everything, fight nothing
Don't strip scripts or hack around framework behaviour. Instead, capture everything the site needs to function (including cross-origin API responses) and serve it from the clone. Detection and download, not hacks.

### API response cache (cross-origin replay)
Frameworks (Nuxt, Next.js, React) re-fetch data after hydration. On IPFS, cross-origin API calls fail (CORS) and the framework wipes SSR content. During the crawl, `page.on('response')` captures all cross-origin data responses (JSON, text, XML -- not binary assets or scripts). In the rewrite pass, a `<script>` is injected as the first element in `<head>` that patches `fetch` and `XMLHttpRequest`:
- Cache hit: returns the captured response (framework hydrates with real data)
- Cache miss + cross-origin: returns a never-resolving promise (no CORS error, SSR content preserved)
- Same-origin: passes through normally (scripts, CSS, images load from clone)

### Rewrite pass fixes (in the evaluate block)
- **API response cache** -- see above; injected as first `<script>` in `<head>`
- **SRI removal** -- strips `integrity`, `crossorigin`, `nonce` attributes. `crossorigin="anonymous"` triggers CORS for external CDN images (e.g. Sanity) -- the CDN rejects the IPFS gateway origin and images fail to load
- **Video muted** -- adds `muted` attribute to `<video autoplay>` elements (React/Vue set via JS property, Safari blocks without HTML attribute)
- **MutationObserver for muted + crossorigin** -- injected script catches dynamically-created autoplay videos AND strips `crossorigin` from images added during framework hydration
- **Scripts are kept** -- JS runs fine on IPFS static hosting; stripping scripts breaks animations, scroll effects, nav dropdowns, and loaders

### XHR shim must include response headers
The XHR shim's `send` override must set `getResponseHeader` and `getAllResponseHeaders` on the shimmed request. Libraries like `get-it` (used by Sanity client) call `getAllResponseHeaders()` to detect `content-type: application/json` -- without it, JSON parsing is skipped, responses stay as raw strings, and framework data becomes `undefined`.

### Debugging cloned sites
Test fixes on the deployed clone via Playwright route interception before editing source code. Use `browser_evaluate` to inject patched JS and verify the fix works on the live IPFS clone, then apply to `src/clone.ts` only after confirming. Never guess at fixes -- trace the actual runtime path (which library, which HTTP method, which parsing step) to find the root cause.

### Other crawl notes
- Radix UI NavigationMenu opens on `onPointerMove` (hover), NOT click -- use Playwright `hover()` not `click()`
- Radix UI DropdownMenu opens on `onPointerDown`, NOT `onClick` -- DOM `el.click()` fires click, not pointerdown
- React ignores synthetic events dispatched via `evaluate()` -- only real Playwright input methods work
- Nav dropdown discovery: hover `nav [aria-expanded]` triggers only -- never click all `[aria-expanded]` (FAQ accordions hang)
- Locale detection: 3-tier approach (hreflang tags → og:locale meta → JS bundle scan for ISO 639-1 arrays)
- Next.js App Router does NOT expose `__NEXT_DATA__` with locale arrays -- must scan compiled JS bundles
- IPFS has no SPA fallback -- every URL path needs a real HTML file, so all locale roots must be crawled

## Roadmap

### Done
1. CLI engine: deploy + ENS + verify + `--json` + `--clean` ✅
2. MCP server: 7 tools for Claude Code/Desktop/Cursor/Windsurf/VS Code ✅
3. Storage management: list, clean, dedup, `--keep`/`--remove` ✅
4. Enhanced status: pin lookup with CIDv0/v1 normalization ✅
5. Session key auth: MCP params, env vars, browser signing ✅
6. Browser wallet pages: session key (session.focify.eth.limo), ENS (ens.focify.eth.limo), Filecoin tx (fil.focify.eth.limo) ✅
7. On-chain polling: nova_poll MCP tool + CLI polling for browser-signed transactions ✅
8. Demo mode: zero-config calibnet deploys with embedded session key ✅
9. Config removed: no credentials file, env vars + browser signing only ✅

### TODO

### Next: Session Keys + Demo Mode + Browser Wallet Flows

#### 5. Session key auth (replaces raw private keys everywhere)

**Why:** Raw private keys can drain wallets. Session keys (Synapse SDK) are scoped to storage operations only (AddPiecesPermission). filecoin-pin already supports `--session-key` + `--wallet-address`. Synapse SDK accepts `sessionKey` in its constructor. Session keys work on both mainnet and calibnet.

**How session keys work:**
- `SessionKey.fromSecp256k1()` from `@filoz/synapse-core/session-key`
- Creates a separate keypair authorized to act on behalf of the wallet
- Permissions: `AddPiecesPermission`, `CreateDataSetPermission`, `SchedulePieceRemovalsPermission`
- Session key can manage storage but CANNOT transfer funds
- `login()` registers the session key on-chain

**Changes to existing code:**
- `src/auth.ts`: shared createSynapse uses session key auth with root wallet for reads, session key for writes
- `src/manage.ts`: session key auth via shared auth module
- `src/config.ts`: store `sessionKey` + `walletAddress` instead of raw `pinKey`
- `src/mcp.ts`: all tools accept `sessionKey` + `walletAddress` as params
- `nova deploy` CLI: if no session key found, prompt for private key, create session key inline, deploy
- Backwards compatible: `NOVA_PIN_KEY` env var still works as raw key fallback for CI

**Auth precedence:** tool params > env vars > browser signing (interactive prompt)

#### 6. Browser wallet flows (no private keys in chat)

**nova.filoz.org/setup -- Session key creation page**
- User clicks link from MCP chat
- Connects MetaMask (Filecoin network, chain ID 314)
- Page generates session key, sends `login()` tx via MetaMask
- User signs in wallet -- raw key never leaves the browser
- Page displays session key for user to copy back into chat
- Session key is safe to paste in chat (scoped, can't move funds)

**nova.filoz.org/ens -- ENS contenthash update page**
- MCP returns link with CID + ENS name pre-filled: `nova.filoz.org/ens?name=mysite.eth&cid=bafybei...`
- User clicks, connects MetaMask (Ethereum mainnet)
- Signs contenthash update transaction in wallet
- ENS key NEVER touches the chat at all

**Implementation:** Simple static site using ethers.js + window.ethereum. Could be hosted on Filecoin via Nova itself.

**Fallback for users without MetaMask/Filecoin wallet setup:**
- Paste raw Filecoin key in MCP chat once, get session key back, delete chat session
- MCP response includes platform-specific instructions for deleting chat history
- Detect client from MCP handshake `clientInfo` to tailor deletion instructions

#### 7. Demo mode (zero-config calibnet deploys)

**Why:** New users try Nova without any wallet, keys, or crypto. Lowers barrier to zero.

**Setup (one-time, our side):**
- User provides a funded calibnet wallet private key
- We create a session key (AddPiecesPermission only) from it
- Embed session key + wallet address in the npm package (safe -- scoped, calibnet only)
- Raw key stays with user, never in code

**New CLI command: `nova demo [path]`**
- Uses embedded calibnet session key -- no credentials needed
- Deploys to calibnet (CIDs work on IPFS gateways regardless of network)
- Returns CID + gateway URL + "expires in 24 hours"
- Post-deploy message guides user to permanent hosting with links

**New MCP tool: `nova_demo`**
- `nova_demo({ path: "./dist" })` -- no credentials needed
- Same result as CLI

**New file: `src/demo.ts`**
- Embedded session key + wallet address
- If calibnet wallet drained: generate new wallet, create new session key, bump version

**Upgrade flow (all links, no jargon):**
After demo deploy, MCP walks user through permanent setup:
1. Install MetaMask: https://metamask.io/download
2. Add Filecoin network: https://chainlist.org/chain/314
3. Get FIL: buy on exchange, send to MetaMask
4. Swap for USDFC: https://sushi.com/filecoin/swap?token0=0x80b98d3aa09ffff255c3ba4a241111ff1262f045&token1=NATIVE
5. Create session key: https://nova.filoz.org/setup
6. Deploy permanently: `nova_deploy({ sessionKey: "0x...", walletAddress: "0x...", path: "./dist" })`

#### 8. 24-hour demo cleanup

**PDP Scan subgraph provides piece timestamps (createdAt on roots):**
- Mainnet: `https://api.goldsky.com/.../pdp-explorer/mainnet311a/gn`
- Calibnet: `https://api.goldsky.com/.../pdp-explorer/calibration311a/gn`
- Query: `dataSets(where: { owner: "<wallet>" }) { roots(where: { removed: false }) { rootId createdAt } }`
- Root entity fields: `rootId`, `rawSize`, `cid` (hex-encoded PieceCID), `removed`, `createdAt` (unix timestamp)

**Cleanup cron:**
- Runs hourly on our server
- Queries calibnet subgraph for all roots owned by demo wallet
- Removes pieces where `createdAt < now - 86400` via Synapse SDK `deletePiece()`
- Could be `nova demo clean` CLI command or standalone script

**Subgraph also improves `nova manage`:**
- Replace piece ID ordering heuristic with real timestamps from subgraph
- Show actual deploy dates in manage output

#### 9. Future
- **Notifications** - Slack webhook, email, status.json after deploy
- **Content on FOC datasets** - Store source content on Filecoin (not just build output)
- **Standalone AI agent** (optional) - Only if justified by real user demand

## Publishing
- Package: `filecoin-nova` on npm (unscoped)
- npm auth via token in `~/.npmrc` (passkey login doesn't work headless)
- Generate tokens at npmjs.com/settings/tokens (Classic, Publish type, no 2FA)
- Publish: `npm publish` (token already configured)
- Bump version in package.json before publishing (mcp.ts reads version from package.json automatically)
- Always bump after pushing changes - don't wait for user to ask

## Development
- Language: TypeScript
- Runtime: Node.js
- Package manager: pnpm
- Build: `pnpm build`
- Test: `pnpm test`
- Lint: `pnpm lint`

## Critical Rules
- ALWAYS use context7 (resolve-library-id + query-docs) to read docs for ANY new tool/library/dependency BEFORE writing code that uses it
- Never use arbitrary timeouts (waitForTimeout, sleep, setTimeout with fixed ms) -- use proper wait conditions (networkidle, waitForLoadState, waitForSelector, etc.)
- Never commit .env files or private keys
- Never add Co-Authored-By or "Generated with Claude" lines to git commits
- Always use viem over ethers.js where appropriate (wallet interactions, contract calls, chain utilities)
- ENS wallet key must come from env var or secure config, never hardcoded
- ENS updates require mainnet ETH for gas — always confirm before sending tx
- pnpm commands must run from project dir, not parent ~/claude/
- Filecoin Onchain Cloud URL is https://filecoin.cloud (NOT filecoin.io)
- README must be factually accurate — verify every claim (no "permanent" storage, no features that don't exist)
- README targets non-dev audience — avoid jargon, explain concepts like CID, link prerequisites
- Repo: github.com/FilOzone/filecoin-nova, branch `main`
