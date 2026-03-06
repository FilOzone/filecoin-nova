# Filecoin Nova

Put your website on [Filecoin Onchain Cloud](https://filecoin.cloud) in one command. Optionally give it an ENS domain so anyone can visit it at `yoursite.eth.limo`.

Your site is stored onchain on the Filecoin network - no traditional hosting, no servers to manage.

Use it as a **CLI** (`nova deploy`) or as an **MCP server** for AI-assisted deploys from Claude Desktop, Cursor, and other MCP clients.

## Install

```bash
npm install -g @filoz/filecoin-nova
```

## What You Need

| What | Why | How to get it |
|------|-----|---------------|
| A Filecoin wallet with FIL and USDFC | FIL for gas, USDFC for storage | Swap on [Sushi](https://www.sushi.com/filecoin/swap?token0=0x80b98d3aa09ffff255c3ba4a241111ff1262f045&token1=NATIVE) |
| An Ethereum wallet with ETH | Pays gas for ENS updates (optional) | Any Ethereum wallet |
| An ENS domain (optional) | Gives your site a human-readable name | Register at [app.ens.domains](https://app.ens.domains) |

## Deploy Your Site

The simplest way - Nova will walk you through everything:

```bash
nova deploy
```

Or specify everything upfront:

```bash
export NOVA_PIN_KEY=your-filecoin-wallet-private-key
nova deploy ./public --ens mysite.eth
```

Nova accepts directories or archives (`.zip`, `.tar.gz`, `.tgz`, `.tar`).

When it's done, your site is live at:
- `https://mysite.eth.limo` (if you used ENS)
- `https://<cid>.ipfs.dweb.link` (always available via IPFS gateway)

## Commands

### `nova deploy [path]`

Deploy a website to Filecoin Onchain Cloud.

```bash
# Deploy a directory
nova deploy ./public

# Deploy with an ENS domain
nova deploy ./dist --ens mysite.eth

# Deploy an archive
nova deploy site.zip
```

### `nova ens <cid> --ens <name>`

Point an ENS domain to an existing IPFS CID (without deploying).

```bash
nova ens bafybei... --ens mysite.eth
```

### `nova status --ens <name>`

Check what an ENS domain currently points to.

```bash
nova status --ens mysite.eth
```

## Configuration

Set these environment variables so you don't have to enter them each time:

```bash
export NOVA_PIN_KEY=your-filecoin-wallet-private-key
export NOVA_ENS_KEY=your-ethereum-wallet-private-key  # only if using ENS
export NOVA_ENS_NAME=mysite.eth                       # default ENS domain
```

All variables:

| Variable | Purpose |
|----------|---------|
| `NOVA_PIN_KEY` | Filecoin wallet key - pays for storage |
| `NOVA_ENS_KEY` | Ethereum wallet key - updates your ENS domain |
| `NOVA_ENS_NAME` | Default ENS domain (so you don't need `--ens` every time) |
| `NOVA_RPC_URL` | Custom Ethereum RPC (Nova uses public RPCs by default) |
| `NOVA_PROVIDER_ID` | Specific storage provider ID |

## Options

| Flag | What it does |
|------|-------------|
| `--ens <name>` | ENS domain to point to your site |
| `--rpc-url <url>` | Ethereum RPC URL |
| `--provider-id <id>` | Storage provider ID |
| `--calibration` | Use testnet instead of mainnet |
| `--json` | Machine-readable JSON output (for CI/scripts) |

## CI / GitHub Actions

Use `--json` for clean machine-readable output:

```bash
nova deploy ./dist --json
# {"cid":"bafybei...","directory":"./dist","gatewayUrl":"https://bafybei....ipfs.dweb.link"}

nova status --ens mysite.eth --json
# {"ensName":"mysite.eth","contenthash":"...","url":"https://mysite.eth.limo"}
```

## MCP Server

Nova includes an MCP server for AI-assisted deploys. No global install needed.

**Claude Code:**

```bash
claude mcp add filecoin-nova \
  -e NOVA_PIN_KEY=your-filecoin-wallet-key \
  -e NOVA_ENS_KEY=your-ethereum-wallet-key \
  -- npx -y --package @filoz/filecoin-nova nova-mcp
```

**Claude Desktop** - add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "filecoin-nova": {
      "command": "npx",
      "args": ["-y", "--package", "@filoz/filecoin-nova", "nova-mcp"],
      "env": {
        "NOVA_PIN_KEY": "your-filecoin-wallet-key",
        "NOVA_ENS_KEY": "your-ethereum-wallet-key"
      }
    }
  }
}
```

This gives your AI assistant three tools:

| Tool | What it does |
|------|-------------|
| `nova_deploy` | Deploy a website to Filecoin, optionally update ENS |
| `nova_ens` | Point an ENS domain to an IPFS CID |
| `nova_status` | Check what an ENS domain points to |

## Use as a Library

```typescript
import { deploy } from "@filoz/filecoin-nova";

const result = await deploy({
  path: "./public",
  ensName: "mysite.eth",
  ensKey: process.env.NOVA_ENS_KEY,
});

console.log(result.cid);        // bafybei...
console.log(result.ethLimoUrl);  // https://mysite.eth.limo
```

## How It Works

1. Nova uploads your site to [Filecoin Onchain Cloud](https://filecoin.cloud) using [filecoin-pin](https://github.com/filecoin-project/filecoin-pin), making it available via IPFS
2. If you specified an ENS domain, Nova updates its contenthash to point to your site's IPFS CID
3. Anyone can access your site through an IPFS gateway or via `yourname.eth.limo`

Storage costs are paid in USDFC (a stablecoin on Filecoin). A typical website costs well under 0.10 USDFC/month. FIL is needed for transaction gas on the Filecoin network.

## Requirements

- Node.js 20.10 or later
- FIL for Filecoin gas fees
- USDFC for storage costs
- ETH for ENS gas fees (only if using ENS)

## License

MIT
