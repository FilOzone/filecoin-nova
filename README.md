# Filecoin Nova

Deploy websites to [Filecoin Onchain Cloud](https://filecoin.cloud) in one command. Your site is stored onchain on the Filecoin network — no traditional hosting, no servers to manage.

- **One-command deploy** — `nova deploy ./dist` and you're live
- **ENS integration** — point an ENS domain to your site so anyone can visit `yoursite.eth.limo`
- **Storage management** — list, inspect, and clean up old deploys to control costs
- **CI-ready** — `--json` output and env var config for GitHub Actions and other pipelines
- **MCP server** — deploy and manage storage directly from Claude Code, Claude Desktop, Cursor, Windsurf, or VS Code
- **Library API** — import `deploy` into your own tools and scripts

Storage costs under $0.10/month for a typical website. No servers, no infrastructure, no monthly hosting bills.

---

## Quick Start

```bash
npm install -g filecoin-nova
nova deploy
```

Nova will walk you through everything - no setup needed beforehand.

---

## What You Need

| What | Why | Get started |
|------|-----|-------------|
| [Node.js](https://nodejs.org/) 20.10+ | Runs Nova | Download from [nodejs.org](https://nodejs.org/) |
| A wallet with FIL and USDFC | FIL for gas, USDFC for storage | [Set up MetaMask for Filecoin](https://docs.filecoin.io/basics/assets/metamask-setup), then [swap for USDFC](https://www.sushi.com/filecoin/swap?token0=0x80b98d3aa09ffff255c3ba4a241111ff1262f045&token1=NATIVE) |
| A wallet with ETH *(optional)* | Pays gas for ENS updates | Same MetaMask wallet works |
| An ENS domain *(optional)* | Human-readable name for your site | Register at [app.ens.domains](https://app.ens.domains) |

---

## Deploy Your Site

```bash
# Interactive - prompts for everything
nova deploy

# Specify a directory
nova deploy ./public

# Deploy with an ENS domain
nova deploy ./dist --ens mysite.eth

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

## Commands

| Command | What it does |
|---------|-------------|
| `nova deploy [path]` | Deploy a website to Filecoin Onchain Cloud |
| `nova ens <cid> --ens <name>` | Point an ENS domain to an existing CID |
| `nova status --ens <name>` | Check what an ENS domain currently points to |
| `nova manage [clean]` | List or clean up old pinned pieces to reduce storage costs |
| `nova config` | Save your wallet keys and defaults so you don't have to enter them each time |

**Options:**

| Flag | Commands | What it does |
|------|----------|-------------|
| `--ens <name>` | deploy, ens, status | ENS domain (e.g. `mysite.eth`) |
| `--rpc-url <url>` | deploy, ens, status | Custom Ethereum RPC |
| `--provider-id <id>` | deploy | Storage provider ID |
| `--calibration` | deploy | Use testnet instead of mainnet |
| `--json` | deploy, ens, status | Machine-readable JSON output (for CI/scripts) |

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

## MCP Server

Nova includes an MCP server for AI-assisted deploys. Save your wallet keys first, then add the server to your editor.

```bash
npm install -g filecoin-nova
nova config
```

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

1. Nova uploads your site to [Filecoin Onchain Cloud](https://filecoin.cloud) using [filecoin-pin](https://github.com/filecoin-project/filecoin-pin), making it available via IPFS
2. If you specified an ENS domain, Nova updates its contenthash to point to your site's CID
3. Anyone can access your site through an IPFS gateway or via `yourname.eth.limo`

Storage costs are paid in USDFC (a stablecoin on Filecoin). A typical website costs well under 0.10 USDFC/month. FIL is needed for transaction gas on the Filecoin network.

## License

MIT
