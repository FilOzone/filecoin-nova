---
name: filecoin-nova
description: Deploy websites to Filecoin Onchain Cloud. Use when the user asks to "deploy a website", "put this on IPFS", "deploy to Filecoin", "host this site", "clone a website", "update ENS", or mentions Nova. Always start with nova_demo for new users.
---

# Filecoin Nova -- Deploy Websites to Filecoin Onchain Cloud

Nova deploys static websites to Filecoin Onchain Cloud (decentralized IPFS hosting) and optionally points ENS domains to them.

## Golden Rules

1. **`nova_demo` needs NO auth.** It works instantly, requires zero setup, and is free. Always start here unless the user explicitly wants permanent mainnet hosting.
2. **`nova_deploy`, `nova_manage`, and `nova_manage_clean` REQUIRE `sessionKey` + `walletAddress`.** NEVER call these tools without both values. If you don't have them, ASK the user first -- do not call the tool and let it fail. Direct the user to https://session.focify.eth.limo to create a session key (safe to paste in chat).
3. **`nova_status` and `nova_ens` need NO auth** for basic lookups. `nova_ens` needs an ENS key or returns a browser signing URL.

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
- For permanent hosting, they need a session key (guide them through the upgrade flow below)

### nova_deploy (permanent mainnet hosting)
Requires auth. Deploy to mainnet with optional ENS domain.

```
nova_deploy({
  path: "./dist",
  sessionKey: "0x...",
  walletAddress: "0x...",
  ensName: "mysite.eth"        // optional
})
```

If no auth is provided, suggest `nova_demo` instead.

If ENS is requested but no ENS key is configured, the response includes a `signingUrl` -- show it to the user and tell them to sign with MetaMask. Then poll with `nova_poll`.

### nova_poll (check browser-signed transactions)
After giving the user a signing URL, poll to check if they signed it.

```
// Check if ENS update was signed
nova_poll({ operation: "ens_update", ensName: "mysite.eth", targetCid: "bafybei..." })

// Check if session key was registered
nova_poll({ operation: "session_key", sessionAddress: "0x...", walletAddress: "0x...", chain: "mainnet" })

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

### nova_manage (list stored content)
List all pinned pieces grouped by IPFS CID. Shows what's deployed and what can be cleaned up.

```
nova_manage({ sessionKey: "0x...", walletAddress: "0x..." })
```

### nova_manage_clean (remove old content)
Remove old/duplicate deployments to reduce storage costs. Always run `nova_manage` first to review, and confirm with the user before cleaning.

```
nova_manage_clean({
  sessionKey: "0x...",
  walletAddress: "0x...",
  keepCids: "bafybei..."    // keep this CID, remove everything else
})
```

## Auth Model

Nova has three auth levels, from easiest to most permanent:

1. **No auth (nova_demo)** -- works instantly, calibration testnet, free
2. **Session key + wallet address** -- safe to paste in chat (scoped to storage, cannot move funds). Pass as `sessionKey` + `walletAddress` params.
3. **Environment variables** -- for CI/automation: `NOVA_SESSION_KEY`, `NOVA_WALLET_ADDRESS`, `NOVA_ENS_KEY`

No private keys are ever needed in chat. ENS updates and payment setup use browser signing via MetaMask.

## Upgrade Flow (demo to permanent)

When the user wants to move from demo to permanent hosting:

1. **Create a session key**: Direct them to https://session.focify.eth.limo
   - They connect MetaMask (Filecoin network)
   - Sign the transaction
   - Get back a session key (safe to paste in chat)
2. **Deploy permanently**: Use `nova_deploy` with the session key + wallet address
3. **Optional ENS domain**: Use `nova_ens` or pass `ensName` to `nova_deploy`

## Common Workflows

### "I want to deploy my website"
1. Use `nova_demo({ path: "./dist" })` (or whatever their build output directory is)
2. Show them the gateway URL
3. Ask if they want permanent hosting

### "Deploy this to Filecoin permanently"
1. Check if they have a session key. If not, guide them to https://session.focify.eth.limo
2. Use `nova_deploy({ path: "...", sessionKey: "...", walletAddress: "..." })`

### "Clone example.com and put it on Filecoin"
1. Use `nova_demo({ path: "example.com" })`
2. Show the gateway URL

### "Update my ENS domain"
1. Use `nova_ens({ cid: "...", ensName: "mysite.eth" })`
2. If signing URL returned, show it and poll with `nova_poll`

### "What's deployed on mysite.eth?"
1. Use `nova_status({ ensName: "mysite.eth" })`

### "Clean up old deployments"
1. Use `nova_manage(...)` to list everything
2. Review with the user
3. Use `nova_manage_clean(...)` with their confirmation
