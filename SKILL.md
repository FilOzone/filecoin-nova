---
name: filecoin-nova
description: Deploy websites to Filecoin Onchain Cloud. Use when the user asks to "deploy a website", "put this on IPFS", "deploy to Filecoin", "host this site", "clone a website", "update ENS", or mentions Nova. Always start with nova_demo for new users.
---

# Filecoin Nova -- Deploy Websites to Filecoin Onchain Cloud

Nova deploys static websites to Filecoin Onchain Cloud (decentralized IPFS hosting) and optionally points ENS domains to them.

## Golden Rules

1. **`nova_demo`, `nova_clone`, and `nova_download` need NO auth.** They work instantly with zero setup. `nova_demo` is free and the recommended starting point for new users.
2. **`nova_deploy` and `nova_manage_clean` REQUIRE `NOVA_PIN_KEY` env var** (or browser signing via https://fil.focify.eth.limo). NEVER call these tools without auth configured. If the user hasn't set `NOVA_PIN_KEY`, tell them to set it or use browser signing.
3. **`nova_info`, `nova_wallet`, and `nova_manage` (list) only need a wallet address** -- pass `walletAddress` param or set `NOVA_WALLET_ADDRESS` env var. These are read-only operations.
4. **`nova_status` and `nova_ens` need NO auth** for basic lookups. `nova_ens` needs `NOVA_ENS_KEY` or returns a browser signing URL.

## Tools

### nova_demo (start here)
Clone any website by URL or deploy a local directory. Free, instant, no wallet needed.

```
nova_demo({ path: "filoz.org" })           // Clone and deploy a website
nova_demo({ path: "./dist" })              // Deploy a local directory
nova_demo({ path: "example.com", maxPages: 10 })  // Clone with page limit
```

Returns: `{ cid, gatewayUrl, directory }` -- the site is live immediately at the gateway URL.

After a successful demo, tell the user:
- Their site is live at the gateway URL
- This is a free demo on the calibration testnet
- For permanent hosting, they need a Filecoin wallet and `NOVA_PIN_KEY` (guide them through the upgrade flow below)

### nova_deploy (permanent mainnet hosting)
Requires `NOVA_PIN_KEY` env var (or browser signing via https://fil.focify.eth.limo). Deploy to mainnet with optional ENS domain.

```
nova_deploy({
  path: "./dist",
  ensName: "mysite.eth"        // optional
})
```

If no auth is configured, suggest `nova_demo` instead.

If ENS is requested but no ENS key is configured, the response includes a `signingUrl` -- show it to the user and tell them to sign with MetaMask. Then poll with `nova_poll`.

### nova_poll (check browser-signed transactions)
After giving the user a signing URL, poll to check if they signed it.

```
// Check if ENS update was signed
nova_poll({ operation: "ens_update", ensName: "mysite.eth", targetCid: "bafybei..." })

// Check any transaction
nova_poll({ operation: "tx_receipt", txHash: "0x...", chain: "ethereum" })
```

Returns `{ confirmed: true/false }`. If false, wait a few seconds and poll again.

### nova_ens (update ENS domain)
Point an ENS domain to an IPFS CID.

```
nova_ens({ cid: "bafybei...", ensName: "mysite.eth" })
```

If no ENS key is configured, returns a signing URL for MetaMask. Show it to the user, then poll with `nova_poll`.

### nova_status (check current state)
Check what an ENS domain currently points to. No auth needed.

```
nova_status({ ensName: "mysite.eth" })
```

### nova_clone (clone a website)
Clone a website into a static directory. Crawls pages, downloads assets, rewrites URLs to relative paths, handles Next.js image optimization, and injects an API response cache for JS-heavy sites. Returns the output directory -- deploy it with `nova_deploy` or `nova_demo`.

```
nova_clone({ url: "example.com" })
nova_clone({ url: "https://mysite.com", maxPages: 10 })
```

### nova_info (deployment details)
Show details for a specific IPFS CID: dataset, pieces, size, proof status. Only needs a wallet address.

```
nova_info({ cid: "bafybei...", walletAddress: "0x..." })
```

### nova_wallet (balance and deposits)
Show FIL and USDFC balance plus FOC deposit status. Only needs a wallet address.

```
nova_wallet({ walletAddress: "0x..." })
```

### nova_download (download from IPFS)
Download content from IPFS by CID to a local directory. No auth needed.

```
nova_download({ cid: "bafybei..." })
nova_download({ cid: "bafybei...", directory: "./my-site" })
```

### nova_manage (list stored content)
List all pinned pieces grouped by IPFS CID. Shows what's deployed and what can be cleaned up. Only needs a wallet address.

```
nova_manage({ walletAddress: "0x..." })
```

### nova_manage_clean (remove old content)
Remove old/duplicate deployments to reduce storage costs. Requires `NOVA_PIN_KEY` env var (or browser signing). Always run `nova_manage` first to review, and confirm with the user before cleaning.

```
nova_manage_clean({
  keepCids: "bafybei..."    // keep this CID, remove everything else
})
```

## Auth Model

Nova has three auth levels, from easiest to most permanent:

1. **No auth (nova_demo)** -- works instantly, calibration testnet, free
2. **Wallet address only (read-only)** -- for `nova_info`, `nova_wallet`, `nova_manage` (list). Set `NOVA_WALLET_ADDRESS` env var or pass `walletAddress` param or use `--wallet`/`-w` flag.
3. **Private key (write operations)** -- for `nova_deploy`, `nova_manage_clean`. Set `NOVA_PIN_KEY` env var, or sign via https://fil.focify.eth.limo (browser signing with MetaMask).
4. **ENS key** -- for ENS contenthash updates. Set `NOVA_ENS_KEY` env var, or use browser signing via https://ens.focify.eth.limo.

## Upgrade Flow (demo to permanent)

When the user wants to move from demo to permanent hosting:

1. **Get a Filecoin wallet**: Install MetaMask (https://metamask.io/download) and add Filecoin network (https://chainlist.org/chain/314)
2. **Fund the wallet with USDFC**: Buy FIL on an exchange, send to MetaMask, swap for USDFC (https://sushi.com/filecoin/swap)
3. **Set `NOVA_PIN_KEY`**: Export the wallet's private key and set it as the `NOVA_PIN_KEY` environment variable. Alternatively, sign transactions via https://fil.focify.eth.limo (browser signing with MetaMask).
4. **Deploy permanently**: Run `nova_deploy` with the path to the site
5. **Optional ENS domain**: Use `nova_ens` or pass `ensName` to `nova_deploy`

## Common Workflows

### "I want to deploy my website"
1. Use `nova_demo({ path: "./dist" })` (or whatever their build output directory is)
2. Show them the gateway URL
3. Ask if they want permanent hosting

### "Deploy this to Filecoin permanently"
1. Check if `NOVA_PIN_KEY` is set. If not, tell them to set it or sign via https://fil.focify.eth.limo
2. Use `nova_deploy({ path: "..." })`

### "Clone example.com and put it on Filecoin"
1. Use `nova_clone({ url: "example.com" })` to clone to a local directory
2. Use `nova_demo({ path: "<directory>" })` or `nova_deploy(...)` to deploy it
3. Show the gateway URL

### "Update my ENS domain"
1. Use `nova_ens({ cid: "...", ensName: "mysite.eth" })`
2. If signing URL returned, show it and poll with `nova_poll`

### "What's deployed on mysite.eth?"
1. Use `nova_status({ ensName: "mysite.eth" })`

### "Show me details about this CID"
1. Use `nova_info({ cid: "bafybei...", walletAddress: "0x..." })`

### "What's my balance?"
1. Use `nova_wallet({ walletAddress: "0x..." })`

### "Download this site from IPFS"
1. Use `nova_download({ cid: "bafybei..." })`

### "Clean up old deployments"
1. Use `nova_manage({ walletAddress: "0x..." })` to list everything
2. Review with the user
3. Use `nova_manage_clean({ keepCids: "bafybei..." })` with their confirmation (requires `NOVA_PIN_KEY`)
