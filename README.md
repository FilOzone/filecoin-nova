# Filecoin Nova

Clone any website and put it on the Filecoin network in one command. No wallet, no setup, completely free.

```bash
npx filecoin-nova demo https://example.com
```

Nova crawls the site with a headless browser, captures every page and asset, deploys it to [Filecoin Onchain Cloud](https://filecoin.cloud), and gives you a live URL. The result is an exact clone hosted on decentralized infrastructure.

---

## Try It Now

```bash
npx filecoin-nova demo https://your-favorite-site.com
```

That's it. No account, no wallet, no API keys. Your cloned site is live in about 60 seconds at an IPFS gateway URL like `https://bafybei....ipfs.dweb.link`.

You can also deploy a local directory:

```bash
npx filecoin-nova demo ./my-site
```

Demo mode uses a free calibration testnet. When you're ready for permanent hosting, Nova walks you through the upgrade.

---

## Clone a Website

```bash
# Clone and deploy in one command
nova clone https://example.com

# Limit how many pages to crawl
nova clone https://example.com --max-pages 10

# Clone, deploy, and point an ENS domain at it
nova clone https://example.com --ens mysite.eth

# Clone only, don't deploy
nova clone https://example.com --no-deploy
```

Nova uses a real browser to render the site, so JavaScript-heavy frameworks (React, Next.js, Nuxt, Vue) are captured correctly. Cross-origin API responses are cached and replayed so the clone works standalone on IPFS.

---

## Deploy Your Own Site

```bash
# Deploy a build output directory
nova deploy ./dist

# Deploy with an ENS domain
nova deploy ./public --ens mysite.eth

# Deploy and remove all old versions (only new deploy kept)
nova deploy ./dist --clean

# Deploy an archive
nova deploy site.zip
```

Nova accepts directories or archives (`.zip`, `.tar.gz`, `.tgz`, `.tar`).

When it's done, your site is live at:

> `https://mysite.eth.limo` -- if you used ENS
>
> `https://<cid>.ipfs.dweb.link` -- always available via IPFS gateway

A **CID** (Content Identifier) is a unique fingerprint for your content on IPFS. It looks like `bafybei...` and never changes for the same content.

---

## AI Editor Integration (MCP)

Nova includes an MCP server so your AI editor can clone, deploy, and manage sites through conversation. Install once, then just ask it to deploy.

### Setup

**Claude Code:**
```bash
npm install -g filecoin-nova
claude mcp add filecoin-nova -s user -- nova-mcp
```

**Claude Desktop:**
Settings > MCP > Add MCP Server. Set command to `nova-mcp`.

**Cursor / Windsurf / VS Code:**

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

### What you can ask

- "Clone example.com and deploy it to Filecoin"
- "Deploy my dist folder"
- "Update the ENS for mysite.eth"
- "What's currently deployed on mysite.eth?"
- "Clean up old deployments"

No wallet or credentials needed to start. The AI will use `nova_demo` for instant free deploys, and guide you through setting up permanent hosting when you're ready.

### Tools

| Tool | What it does |
|------|-------------|
| `nova_demo` | Clone a website or deploy a directory for free (no wallet needed) |
| `nova_deploy` | Deploy to mainnet with optional ENS |
| `nova_ens` | Point an ENS domain to a CID |
| `nova_status` | Check what an ENS domain points to |
| `nova_manage` | List all stored content grouped by deploy |
| `nova_manage_clean` | Remove old/duplicate content to reduce costs |
| `nova_poll` | Check if a browser-signed transaction completed |

### SKILL.md

Nova ships a `SKILL.md` in the npm package that teaches any AI assistant how to use the MCP tools effectively. If your AI tool supports skill files, point it at `node_modules/filecoin-nova/SKILL.md` for the best experience.

---

## Auth

Nova is designed so you never need to paste private keys. There are three levels:

### 1. No auth (demo mode)

`nova demo` works instantly. Free, calibration testnet, no wallet needed.

### 2. Session keys (recommended for permanent hosting)

Session keys are scoped to storage operations only -- they cannot move funds, so they're safe to use in AI chat sessions.

**Create a session key:**
1. Go to [session.focify.eth.limo](https://session.focify.eth.limo)
2. Connect MetaMask (Filecoin network)
3. Sign the transaction
4. Copy the session key back

**Use it:**
```bash
nova deploy ./dist
# Nova prompts for session key + wallet address
```

Or pass as env vars for CI:
```bash
export NOVA_SESSION_KEY=0x...
export NOVA_WALLET_ADDRESS=0x...
nova deploy ./dist
```

### 3. Browser signing (ENS updates)

ENS updates require an Ethereum wallet key. Instead of pasting it, Nova opens a browser page where you sign with MetaMask:

```bash
nova ens bafybei... --ens mysite.eth
# Opens browser signing page, waits for your signature
```

The MCP server does the same -- it returns a signing URL for the user to click and polls the chain for confirmation.

### Environment variables

For CI/automation, set env vars instead of interactive prompts:

| Variable | What it does |
|----------|-------------|
| `NOVA_SESSION_KEY` | Session key for storage auth (recommended) |
| `NOVA_WALLET_ADDRESS` | Wallet address for session key auth |
| `NOVA_PIN_KEY` | Raw Filecoin private key (CI fallback) |
| `NOVA_ENS_KEY` | Ethereum private key for ENS updates |
| `NOVA_ENS_NAME` | Default ENS domain |
| `NOVA_RPC_URL` | Custom Ethereum RPC |
| `NOVA_PROVIDER_ID` | Storage provider ID |

---

## Manage Storage

Every deploy creates pieces on Filecoin. Over time, old deploys accumulate. Nova helps you see what's stored and clean up what you don't need.

```bash
# See all stored content grouped by deploy
nova manage

# Preview what would be cleaned up (safe dry-run)
nova manage clean

# Actually remove old/duplicate pieces
nova manage clean --really-do-it

# Keep specific CIDs, remove everything else
nova manage clean --keep bafybei...,bafybei... --really-do-it
```

Cleanup is safe by default -- `nova manage clean` only shows a plan. You need `--really-do-it` and a confirmation to execute.

---

## What You Need

For **demo mode**: just [Node.js](https://nodejs.org/) 20.10+. That's it.

For **permanent hosting**:

| What | Why | Get started |
|------|-----|-------------|
| [Node.js](https://nodejs.org/) 20.10+ | Runs Nova | Download from [nodejs.org](https://nodejs.org/) |
| MetaMask with FIL and USDFC | FIL for gas, USDFC for storage | [Set up MetaMask for Filecoin](https://docs.filecoin.io/basics/assets/metamask-setup), then [swap for USDFC](https://www.sushi.com/filecoin/swap?token0=0x80b98d3aa09ffff255c3ba4a241111ff1262f045&token1=NATIVE) |
| MetaMask with ETH *(optional)* | Gas for ENS updates | Same MetaMask wallet |
| An ENS domain *(optional)* | Human-readable URL | Register at [app.ens.domains](https://app.ens.domains) |

Storage costs under $0.10/month for a typical website.

---

## Commands

| Command | What it does |
|---------|-------------|
| `nova demo <url-or-path>` | Clone and deploy for free (no wallet needed) |
| `nova clone <url>` | Clone a website and deploy to Filecoin |
| `nova deploy [path]` | Deploy a directory or archive |
| `nova ens <cid> --ens <name>` | Point an ENS domain to a CID |
| `nova status --ens <name>` | Check what an ENS domain points to |
| `nova manage` | List all stored content |
| `nova manage clean` | Preview and remove old/duplicate content |

**Options:**

| Flag | Commands | What it does |
|------|----------|-------------|
| `--no-deploy` | clone | Clone only, don't deploy |
| `--max-pages <n>` | clone, demo | Max pages to crawl (default: 50, 0 = unlimited) |
| `--screenshots` | clone | Save before/after screenshot comparison |
| `--output <dir>` | clone | Output directory for cloned site |
| `--ens <name>` | clone, deploy, ens, status | ENS domain (e.g. `mysite.eth`) |
| `--rpc-url <url>` | clone, deploy, ens, status | Custom Ethereum RPC |
| `--provider-id <id>` | clone, deploy | Storage provider ID |
| `--clean` | clone, deploy | Remove all old pieces after deploy |
| `--calibration` | clone, deploy, manage | Use testnet instead of mainnet |
| `--json` | clone, deploy, ens, status, manage | Machine-readable JSON output |
| `--really-do-it` | manage clean | Execute the cleanup |
| `--keep <cid,...>` | manage clean | Keep specific CIDs, remove everything else |
| `--remove <cid,...>` | manage clean | Remove specific CIDs only |
| `--keep-copies` | manage clean | Keep duplicate uploads of the same content |
| `--dataset-id <id>` | manage | Target a specific dataset |

---

## CI / GitHub Actions

```yaml
env:
  NOVA_SESSION_KEY: ${{ secrets.NOVA_SESSION_KEY }}
  NOVA_WALLET_ADDRESS: ${{ secrets.NOVA_WALLET_ADDRESS }}

steps:
  - run: npx filecoin-nova deploy ./dist --json
```

In CI there are no interactive prompts -- session key and wallet address must be set as environment variables.

---

## Use as a Library

```typescript
import { deploy } from "filecoin-nova";

const result = await deploy({
  path: "./public",
  sessionKey: process.env.NOVA_SESSION_KEY,
  walletAddress: process.env.NOVA_WALLET_ADDRESS,
  ensName: "mysite.eth",
  ensKey: process.env.NOVA_ENS_KEY,
});

console.log(result.cid);        // bafybei...
console.log(result.ethLimoUrl);  // https://mysite.eth.limo
```

---

## How It Works

1. **Deploy** -- Nova uploads your site to [Filecoin Onchain Cloud](https://filecoin.cloud) via [filecoin-pin](https://github.com/filecoin-project/filecoin-pin), splitting it into pieces stored onchain. Your site gets an IPFS CID, making it accessible through any IPFS gateway.
2. **ENS** -- If you specified an ENS domain, Nova updates its contenthash to point to your CID, so anyone can visit `yoursite.eth.limo`.
3. **Manage** -- Each deploy creates new pieces. `nova manage` shows what's stored and `nova manage clean` removes old versions so you only pay for what you're using.

## License

MIT
