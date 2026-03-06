# Nova

Deploy static websites to [Filecoin Onchain Cloud](https://filecoin.io) with optional ENS domain resolution.

## Install

```bash
npm install -g @filoz/filecoin-nova
```

## Quick Start

```bash
# Deploy a directory
nova deploy ./public --ens mysite.eth

# Deploy an archive
nova deploy site.zip --ens mysite.eth

# Point ENS to an existing CID (no deploy)
nova ens bafybei... --ens mysite.eth

# Deploy with prompts
nova deploy

# Check ENS status
nova status --ens mysite.eth

# JSON output for CI/scripts
nova deploy ./dist --json
nova status --ens mysite.eth --json
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NOVA_PIN_KEY` | Filecoin wallet private key (for deploying to FOC) |
| `NOVA_ENS_KEY` | Ethereum wallet private key (for ENS updates) |
| `NOVA_ENS_NAME` | ENS domain (e.g. `mysite.eth`) |
| `NOVA_RPC_URL` | Ethereum RPC URL (override default RPCs) |
| `NOVA_PROVIDER_ID` | Storage provider ID |

## CLI Options

```
nova deploy [path] [options]        Deploy a directory or archive
nova ens <cid> --ens <name>         Point ENS domain to an IPFS CID
nova status [--ens <name>]          Check ENS contenthash
nova help                           Show help
nova --version                      Show version

Options:
  --ens <name>          ENS domain (e.g. mysite.eth)
  --rpc-url <url>       Ethereum RPC URL
  --provider-id <id>    Storage provider ID
  --calibration         Use calibration testnet (default: mainnet)
  --json                Output result as JSON (for CI/scripts)

Supported formats: directories, .zip, .tar.gz, .tgz, .tar
```

## Library Usage

```typescript
import { deploy } from "@filoz/filecoin-nova";

const result = await deploy({
  directory: "./public",
  ensName: "mysite.eth",
  ensKey: process.env.NOVA_ENS_KEY,
});

console.log(result.cid);        // IPFS CID
console.log(result.ethLimoUrl);  // https://mysite.eth.limo
```

## Requirements

- Node.js >= 20.10.0
- [filecoin-pin](https://www.npmjs.com/package/filecoin-pin) >= 0.17.0 (installed automatically)
- USDFC for Filecoin storage costs
- ETH for ENS gas fees (only if using ENS)

## License

MIT
