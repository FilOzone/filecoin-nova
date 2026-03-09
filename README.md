# Filecoin Nova

Clone any website, store it onchain on the Filecoin network, and give it an ENS name -- all in one command.

```bash
nova clone https://example.com --ens mysite.eth
```

Nova crawls a website with a headless browser, captures every page and asset, rewrites all URLs to local paths, deploys the static copy to [Filecoin Onchain Cloud](https://filecoin.cloud), and optionally points an ENS domain at it. The result is an exact clone hosted on decentralized infrastructure -- no servers, no traditional hosting.

- **End-to-end cloning** - crawl, capture, rewrite, deploy, and ENS update in a single command
- **Deploy your own sites** - `nova deploy ./dist` works with any static directory or archive
- **MCP server** - clone and deploy directly from Claude Code, Claude Desktop, Cursor, Windsurf, or VS Code
- **Storage management** - list, inspect, and clean up old deploys to control costs
- **CI-ready** - `--json` output and env var config for GitHub Actions and other pipelines

Storage costs under $0.10/month for a typical website.

---

## Quick Start

### CLI

```bash
npm install -g filecoin-nova
nova clone https://example.com
```

Clone any website to Filecoin in one command. Or deploy your own site:

```bash
nova deploy ./dist
```

Nova will walk you through everything - no setup needed beforehand.

### MCP (Claude Code)

```bash
npm install -g filecoin-nova
nova config
claude mcp add filecoin-nova -s user -- npx -y --package filecoin-nova nova-mcp
```

Then ask Claude to deploy your site.

---

## What You Need

| What | Why | Get started |
|------|-----|-------------|
| [Node.js](https://nodejs.org/) 20.10+ | Runs Nova | Download from [nodejs.org](https://nodejs.org/) |
| A wallet with FIL and USDFC | FIL for gas, USDFC for storage | [Set up MetaMask for Filecoin](https://docs.filecoin.io/basics/assets/metamask-setup), then [swap for USDFC](https://www.sushi.com/filecoin/swap?token0=0x80b98d3aa09ffff255c3ba4a241111ff1262f045&token1=NATIVE) |
| A wallet with ETH *(optional)* | Pays gas for ENS updates | Same MetaMask wallet works |
| An ENS domain *(optional)* | Human-readable name for your site | Register at [app.ens.domains](https://app.ens.domains) |

---

## MCP Server

Nova includes an MCP server so your AI editor can deploy and manage sites for you. Save your wallet keys with `nova config`, then add the server to your editor.

### Claude Code

```bash
claude mcp add filecoin-nova -s user -- npx -y --package filecoin-nova nova-mcp
```

### Claude Desktop

Settings > MCP > Add MCP Server. Set command to `npx`, args to `-y --package filecoin-nova nova-mcp`.

### Cursor / Windsurf / VS Code

| Editor | Config file |
|--------|------------|
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `.vscode/mcp.json` |

```json
{
  "mcpServers": {
    "filecoin-nova": {
      "command": "npx",
      "args": ["-y", "--package", "filecoin-nova", "nova-mcp"]
    }
  }
}
```

### Tools

| Tool | What it does |
|------|-------------|
| `nova_deploy` | Deploy a website to Filecoin, optionally update ENS |
| `nova_ens` | Point an ENS domain to a CID |
| `nova_status` | Check what an ENS domain points to |
| `nova_manage` | List all pinned pieces grouped by IPFS root CID |
| `nova_manage_clean` | Remove old/duplicate pieces to reduce storage costs |

---

## Clone a Website

```bash
# Clone and deploy to Filecoin in one command
nova clone https://example.com

# Clone only, don't deploy
nova clone https://example.com --no-deploy

# Limit crawl depth
nova clone https://example.com --max-pages 10

# Clone, deploy, and update ENS
nova clone https://example.com --ens mysite.eth

# Clone and remove old deploys
nova clone https://example.com --clean
```

Nova uses a headless browser to crawl the site, capture all pages and assets, rewrite URLs to local paths, then deploy the static copy to Filecoin.

---

## Deploy Your Site

```bash
# Interactive - prompts for everything
nova deploy

# Specify a directory
nova deploy ./public

# Deploy with an ENS domain
nova deploy ./dist --ens mysite.eth

# Deploy and remove ALL old pieces (only the new deploy is kept)
nova deploy ./dist --clean

# Deploy an archive
nova deploy site.zip
```

Nova accepts directories or archives (`.zip`, `.tar.gz`, `.tgz`, `.tar`).

When it's done, your site is live at:

> `https://mysite.eth.limo` - if you used ENS
>
> `https://<cid>.ipfs.dweb.link` - always available via IPFS gateway

A **CID** (Content Identifier) is a unique fingerprint for your site's content on IPFS. It looks like `bafybei...` and never changes for the same content.

---

## Manage Your Storage

Every deploy creates pieces on the Filecoin network. Over time, old deploys accumulate and keep costing storage fees. Nova helps you see what's stored and clean up what you don't need.

```bash
# See all your pinned pieces grouped by deploy
nova manage

# Preview what would be cleaned up (dry-run, safe to run)
nova manage clean

# Actually remove old/duplicate pieces
nova manage clean --really-do-it

# Keep specific CIDs, remove everything else
nova manage clean --keep bafybei...,bafybei... --really-do-it

# Remove specific CIDs only
nova manage clean --remove bafybei... --really-do-it
```

Cleanup is safe by default - `nova manage clean` only shows a plan without deleting anything. You need `--really-do-it` and a confirmation prompt to execute.

---

## Commands

| Command | What it does |
|---------|-------------|
| `nova clone <url>` | Clone a website and deploy to Filecoin |
| `nova deploy [path]` | Deploy a directory or archive to Filecoin Onchain Cloud |
| `nova ens <cid> --ens <name>` | Point an ENS domain to an existing CID |
| `nova status --ens <name>` | Check what an ENS domain currently points to |
| `nova manage` | List all pinned pieces grouped by deploy |
| `nova manage clean` | Preview and remove old/duplicate pieces |
| `nova config` | Save your wallet keys and defaults so you don't have to enter them each time |

**Options:**

| Flag | Commands | What it does |
|------|----------|-------------|
| `--no-deploy` | clone | Clone only, don't deploy to Filecoin |
| `--max-pages <n>` | clone | Max pages to crawl (default: 50, 0 = unlimited) |
| `--screenshots` | clone | Save before/after screenshot comparison |
| `--output <dir>` | clone | Output directory for cloned site |
| `--ens <name>` | clone, deploy, ens, status | ENS domain (e.g. `mysite.eth`) |
| `--rpc-url <url>` | clone, deploy, ens, status | Custom Ethereum RPC |
| `--provider-id <id>` | clone, deploy | Storage provider ID |
| `--clean` | clone, deploy | After deploying, remove ALL other pieces (only new deploy is kept) |
| `--calibration` | clone, deploy, manage | Use testnet instead of mainnet |
| `--json` | clone, deploy, ens, status, manage | Machine-readable JSON output (for CI/scripts) |
| `--really-do-it` | manage clean | Execute the cleanup (without this, clean is a dry-run) |
| `--keep <cid,...>` | manage clean | Keep specific CIDs, remove everything else |
| `--remove <cid,...>` | manage clean | Remove specific CIDs only |
| `--keep-copies` | manage clean | Keep duplicate uploads of the same content |
| `--dataset-id <id>` | manage | Target a specific dataset (if wallet has multiple) |

---

## Configuration

You don't need to configure anything upfront - `nova deploy` will prompt you. To avoid re-entering values:

- **`nova config`** - saves wallet keys and defaults to `~/.config/filecoin-nova/credentials` *(recommended)*
- **Environment variables** - `NOVA_PIN_KEY`, `NOVA_ENS_KEY`, `NOVA_ENS_NAME`, `NOVA_RPC_URL`, `NOVA_PROVIDER_ID`

Environment variables override the credentials file.

---

## CI / GitHub Actions

Set your wallet key as a secret, then use `--json` for clean output:

```yaml
env:
  NOVA_PIN_KEY: ${{ secrets.NOVA_PIN_KEY }}

steps:
  - run: npx filecoin-nova deploy ./dist --json
```

```bash
# Output:
# {"cid":"bafybei...","directory":"./dist","gatewayUrl":"https://bafybei....ipfs.dweb.link"}
```

In CI there are no interactive prompts - `NOVA_PIN_KEY` must be set as an environment variable (and `NOVA_ENS_KEY` if using ENS).

---

## Use as a Library

```typescript
import { deploy } from "filecoin-nova";

const result = await deploy({
  path: "./public",
  pinKey: process.env.NOVA_PIN_KEY,
  ensName: "mysite.eth",
  ensKey: process.env.NOVA_ENS_KEY,
});

console.log(result.cid);        // bafybei...
console.log(result.ethLimoUrl);  // https://mysite.eth.limo
```

---

## How It Works

1. **Deploy** - Nova uploads your site to [Filecoin Onchain Cloud](https://filecoin.cloud) using [filecoin-pin](https://github.com/filecoin-project/filecoin-pin), splitting it into pieces stored onchain on the Filecoin network. Your site gets an IPFS CID, making it accessible through any IPFS gateway.
2. **ENS** - If you specified an ENS domain, Nova updates its contenthash to point to your site's CID, so anyone can visit `yoursite.eth.limo`.
3. **Manage** - Each deploy creates new pieces. Over time, old deploys accumulate. `nova manage` lets you see what's stored and `nova manage clean` removes old and duplicate pieces so you only pay for what you're using.

Storage costs are paid in USDFC (a stablecoin on Filecoin). A typical website costs well under 0.10 USDFC/month. FIL is needed for transaction gas on the Filecoin network.

## License

MIT
