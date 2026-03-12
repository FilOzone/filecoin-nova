# Filecoin Nova

Move your website to the decentralized web. Nova creates an exact static copy of your site and deploys it to the Filecoin network in seconds -- no server migration, no infrastructure changes.

```bash
npx filecoin-nova demo https://your-site.com
```

Your site gets a permanent, censorship-resistant copy on [Filecoin Onchain Cloud](https://filecoin.cloud) with a live URL. Keep your existing hosting, or replace it entirely.

- **One command** -- point Nova at your site and it handles everything
- **No migration** -- your existing site stays exactly as it is
- **Low cost** -- a fraction of traditional hosting fees
- **No servers to manage** -- content is stored onchain, served via IPFS gateways
- **Works with any site** -- static sites, React, Next.js, Vue, Nuxt, WordPress, Webflow
- **ENS domains** -- give your decentralized site a human-readable `.eth.limo` address

---

## Try It Now

See what your site looks like on decentralized infrastructure. No account, no wallet, no cost.

**In your browser:** go to [focify.me](https://focify.me), paste a URL, and watch it deploy in real time.

**From the command line:**

```bash
npx filecoin-nova demo https://your-site.com
```

Your site is live in about 60 seconds at an IPFS gateway URL. This free demo uses the calibration testnet so you can evaluate before committing.

You can also deploy a local build directory:

```bash
npx filecoin-nova demo ./dist
```

---

## Make Your Site Decentralized

Nova captures a pixel-perfect static copy of your site using a real browser, so JavaScript-heavy frameworks render correctly. Cross-origin API responses are captured and replayed so the copy works standalone.

```bash
# Create a decentralized copy of your site
nova clone https://your-site.com

# Limit how many pages to capture
nova clone https://your-site.com --max-pages 10

# Deploy and point an ENS domain at it
nova clone https://your-site.com --ens mysite.eth

# Capture only, review before deploying
nova clone https://your-site.com --no-deploy
```

Already have a static build? Deploy it directly:

```bash
# Deploy a build output directory
nova deploy ./dist

# Deploy with an ENS domain
nova deploy ./public --ens mysite.eth

# Deploy and remove previous versions
nova deploy ./dist --clean

# Deploy an archive
nova deploy site.zip
```

Nova accepts directories and archives (`.zip`, `.tar.gz`, `.tgz`, `.tar`).

When it's done, your site is live at:

> `https://mysite.eth.limo` -- if you set up an ENS domain
>
> `https://<cid>.ipfs.dweb.link` -- always available via IPFS gateway

A **CID** (Content Identifier) is a unique fingerprint for your content on IPFS. Same content always produces the same CID.

---

## AI Editor Integration (MCP)

Nova includes an MCP server so your AI editor can deploy and manage sites through conversation.

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

- "Deploy my site to Filecoin"
- "Make a decentralized copy of example.com"
- "Update the ENS for mysite.eth"
- "What's currently deployed on mysite.eth?"
- "Clean up old deployments"

No wallet needed to start. The AI uses `nova_demo` for instant free deploys, and guides you through permanent hosting when you're ready.

### Tools

| Tool | What it does |
|------|-------------|
| `nova_demo` | Deploy for free, no wallet needed |
| `nova_deploy` | Deploy to mainnet with optional ENS |
| `nova_ens` | Point an ENS domain to a CID |
| `nova_status` | Check what an ENS domain points to |
| `nova_manage` | List all stored content |
| `nova_manage_clean` | Remove old content to reduce costs |
| `nova_poll` | Check if a browser-signed transaction completed |

### SKILL.md

Nova ships a `SKILL.md` in the npm package that teaches any AI assistant how to use the MCP tools. If your AI tool supports skill files, point it at `node_modules/filecoin-nova/SKILL.md`.

---

## Auth

Nova is designed so you never need to paste private keys.

### Demo mode (no auth)

`nova demo` works instantly. Free, calibration testnet, no wallet needed.

### Session keys (permanent hosting)

Session keys are scoped to storage operations only -- they cannot move funds, making them safe to use in AI chat sessions.

1. Go to [session.focify.eth.limo](https://session.focify.eth.limo)
2. Connect MetaMask (Filecoin network)
3. Sign the transaction
4. Use the session key with Nova

```bash
nova deploy ./dist
# Nova prompts for session key + wallet address
```

Or set as env vars for automation:
```bash
export NOVA_SESSION_KEY=0x...
export NOVA_WALLET_ADDRESS=0x...
nova deploy ./dist
```

### Browser signing (ENS)

ENS updates require an Ethereum wallet. Nova opens a browser page where you sign with MetaMask -- no keys to copy:

```bash
# Check what an ENS domain points to
nova ens mysite.eth

# Update ENS to point to a new CID
nova ens bafybei... --ens mysite.eth
# Opens signing page, waits for confirmation
```

### Environment variables

For CI/automation:

| Variable | What it does |
|----------|-------------|
| `NOVA_SESSION_KEY` | Session key for storage auth |
| `NOVA_WALLET_ADDRESS` | Wallet address for session key |
| `NOVA_PIN_KEY` | Raw Filecoin private key (CI fallback) |
| `NOVA_ENS_KEY` | Ethereum private key for ENS |
| `NOVA_ENS_NAME` | Default ENS domain |
| `NOVA_RPC_URL` | Custom Ethereum RPC |
| `NOVA_PROVIDER_ID` | Storage provider ID |

---

## Manage Storage

Each deploy creates pieces on Filecoin. Over time, previous versions accumulate. Nova helps you see what's stored and clean up what you don't need.

```bash
# See all stored content grouped by deploy (with timestamps and proof status)
nova manage

# Get details for a specific deployment
nova info bafybei...

# Check wallet balance and deposit status
nova wallet

# Download a previous deployment
nova download bafybei... ./local-copy

# Preview what would be cleaned up (safe dry-run)
nova manage clean

# Remove old/duplicate versions
nova manage clean --really-do-it

# Keep specific versions, remove everything else
nova manage clean --keep bafybei...,bafybei... --really-do-it
```

Cleanup is safe by default -- `nova manage clean` only shows a plan. You need `--really-do-it` and a confirmation to execute.

---

## What You Need

For **demo mode**: just [Node.js](https://nodejs.org/) 20.10+.

For **permanent hosting**:

| What | Why | Get started |
|------|-----|-------------|
| [Node.js](https://nodejs.org/) 20.10+ | Runs Nova | Download from [nodejs.org](https://nodejs.org/) |
| MetaMask with FIL and USDFC | FIL for gas, USDFC for storage | [Set up MetaMask for Filecoin](https://docs.filecoin.io/basics/assets/metamask-setup), then [swap for USDFC](https://www.sushi.com/filecoin/swap?token0=0x80b98d3aa09ffff255c3ba4a241111ff1262f045&token1=NATIVE) |
| MetaMask with ETH *(optional)* | Gas for ENS updates | Same MetaMask wallet |
| An ENS domain *(optional)* | Human-readable URL | Register at [app.ens.domains](https://app.ens.domains) |

---

## Commands

| Command | What it does |
|---------|-------------|
| `nova demo <url-or-path>` | Deploy for free, no wallet needed |
| `nova clone <url>` | Capture your site and deploy to Filecoin |
| `nova deploy [path]` | Deploy a local directory or archive |
| `nova ens <name>` | Check what an ENS domain points to |
| `nova ens <cid> --ens <name>` | Point an ENS domain to a CID |
| `nova info <cid>` | Show details for a specific deployment |
| `nova wallet` | Show wallet balance and deposit status |
| `nova download <cid> [dir]` | Download content from IPFS |
| `nova manage` | List all stored content |
| `nova manage clean` | Remove old/duplicate content |

**Options:**

| Flag | Commands | What it does |
|------|----------|-------------|
| `--no-deploy` | clone | Capture only, don't deploy |
| `--max-pages <n>` | clone, demo | Max pages to capture (default: 50, 0 = unlimited) |
| `--screenshots` | clone | Save before/after comparison |
| `--output <dir>` | clone | Output directory |
| `--ens <name>` | clone, deploy, ens | ENS domain (e.g. `mysite.eth`) |
| `--rpc-url <url>` | clone, deploy, ens | Custom Ethereum RPC |
| `--provider-id <id>` | clone, deploy | Storage provider ID |
| `--clean` | clone, deploy | Remove all previous versions after deploy |
| `--calibration` | clone, deploy, info, wallet, manage | Use testnet instead of mainnet |
| `--json` | clone, deploy, ens, info, wallet, download, manage | Machine-readable JSON output |
| `--really-do-it` | manage clean | Execute the cleanup |
| `--keep <cid,...>` | manage clean | Keep specific CIDs, remove the rest |
| `--remove <cid,...>` | manage clean | Remove specific CIDs only |
| `--keep-copies` | manage clean | Keep duplicate uploads |
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

1. **Capture** -- Nova renders your site in a real browser, downloads every page and asset, and rewrites URLs to local paths. The result is a self-contained static copy.
2. **Deploy** -- The copy is packaged as a CAR file and uploaded to [Filecoin Onchain Cloud](https://filecoin.cloud), stored onchain as content-addressed pieces. Your site gets an IPFS CID.
3. **Resolve** -- If you set up an ENS domain, Nova updates its contenthash so anyone can visit `yoursite.eth.limo`. The content is served through IPFS gateways worldwide.

## License

MIT
