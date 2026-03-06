# Nova

## Overview
Nova — deploy static sites to Filecoin Onchain Cloud with ENS resolution.

Two packages:
- `@filoz/filecoin-nova` — CLI engine (pin to FOC, update ENS contenthash, notifications)
- `@filoz/filecoin-nova-agent` — MCP server (wraps CLI, adds intelligence for agent directories)

## Architecture
```
CLI (engine)                MCP Server (agent, Phase 3)
nova deploy [path]    <──   nova_deploy tool
nova ens <cid>        <──   nova_ens tool
nova status           <──   nova_status tool
                            nova_diagnose (agent-only)
                            nova_preview (agent-only)
```

## CLI Commands
- `nova deploy [path]` — Deploy directory or archive (.zip, .tar.gz, .tgz, .tar) to FOC, optionally update ENS
- `nova ens <cid> --ens <name>` — Point ENS domain to an IPFS CID (no deploy)
- `nova status --ens <name>` — Check current ENS contenthash

## Source Files
```
src/cli.ts       — CLI entry point, arg parsing, prompts
src/deploy.ts    — Orchestrates pin + ENS
src/ens.ts       — ENS contenthash encoding/updating/reading (ethers v6)
src/pin.ts       — filecoin-pin subprocess management
src/archive.ts   — Archive detection and extraction to temp dir
src/prompt.ts    — Readline wrapper (lazy init, askSecret for masked input)
src/config.ts    — Env var resolution
src/ui.ts        — Visual design system (colours, gutter, labels)
```

## Key Dependencies
- `filecoin-pin` — FOC pinning (proven with filoz-home-desite)
- `ethers` v6 — ENS contenthash updates
- `multiformats` — IPFS CID parsing and encoding
- `@modelcontextprotocol/sdk` — MCP server (Phase 3)

## ENS Details
- Test domain: `ezpdpz.eth`
- ENS contenthash stores IPFS CID in encoded format (EIP-1577)
- Resolution: `ezpdpz.eth.limo` serves content from IPFS gateway
- Mainnet ENS — requires mainnet ETH for gas
- Env vars: `NOVA_ENS_KEY` (ETH wallet), `NOVA_PIN_KEY` (FIL wallet)

## Phases
1. CLI engine: pin + ENS update + verify ✅
2. Notifications: Slack webhook, email, status.json
3. MCP server: thin wrapper around CLI, listed on Smithery/MCP Registry
4. Content on FOC datasets: source content stored on Filecoin
5. (Optional) Standalone AI agent — see caveats below

### Phase 5 — Standalone Agent (Optional)
Built with Anthropic's Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
An autonomous agent that reasons about deployments: detects build output,
runs builds, diagnoses gateway/DNS/ENS issues, handles errors intelligently.

**Caveats — only pursue if justified by real user demand:**
- Requires an Anthropic API key and billing account (ongoing token costs)
- Adds latency — Claude reasons before every action
- Extra dependency on Anthropic API availability
- The CLI already handles the core workflow in a single command with zero API costs
- MCP server (Phase 3) already enables AI-assisted deploys via Claude Desktop/Cursor
- Agent SDK is new and evolving — API surface may change

**When it makes sense:** Complex multi-site management, automated diagnosis
pipelines, or if users consistently struggle with workflows that the CLI
can't simplify further. Build based on real feedback, not speculation.

## Development
- Language: TypeScript
- Runtime: Node.js
- Package manager: pnpm
- Build: `pnpm build`
- Test: `pnpm test`
- Lint: `pnpm lint`

## Critical Rules
- Never commit .env files or private keys
- ENS wallet key must come from env var or secure config, never hardcoded
- filecoin-pin v0.17.0+ required (older versions use incompatible contracts)
- ENS updates require mainnet ETH for gas — always confirm before sending tx
- pnpm commands must run from project dir, not parent ~/claude/
- Subprocess output may contain ANSI codes — always stripAnsi() before regex parsing
- Not yet in git — needs initial commit and repo setup
