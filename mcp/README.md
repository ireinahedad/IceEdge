# arakice-nhl-mcp

An MCP server for [ArakIce](https://arakice.com) NHL pre-game probabilities. It runs locally (stdio) and is a
thin client over the public API at `https://agents.arakice.com`.

| Tool | Cost | Returns |
|---|---|---|
| `nhl_track_record` | free | Settled games with the probability published before puck drop, final score, log-loss, Brier, accuracy, calibration |
| `nhl_pregame_probabilities` | flat price per date, USDC on Base ([x402](https://x402.org)) | Home win, home −1.5 and away −1.5 for every game of the date not yet started, with starting goalies when known |

The model takes no market odds as input. Every morning's numbers are also committed to a public repository
before the games: [arakice-nhl-predictions](https://github.com/ireinahedad/arakice-nhl-predictions).
No odds, no betting returns, no picks.

## Setup

Node 20+. In your MCP client's configuration (for example Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "arakice-nhl": {
      "command": "npx",
      "args": ["-y", "arakice-nhl-mcp@0.1.0"],
      "env": {
        "ARAKICE_BUYER_PRIVATE_KEY": "0x…",
        "ARAKICE_MAX_PER_CALL_USD": "0.25",
        "ARAKICE_MAX_PER_DAY_USD": "1.00"
      }
    }
  }
}
```

Without `ARAKICE_BUYER_PRIVATE_KEY` the free tool works and the paid tool explains what is missing.

| Variable | Default | Meaning |
|---|---|---|
| `ARAKICE_BUYER_PRIVATE_KEY` | — | Key of the wallet that pays. **Use a dedicated wallet holding a few dollars of USDC on Base**, never your main one |
| `ARAKICE_MAX_PER_CALL_USD` | `0.25` | Refuse any call priced above this |
| `ARAKICE_MAX_PER_DAY_USD` | `1.00` | Budget per UTC day, counted in this process (a restart resets it; the per-call cap always applies) |
| `ARAKICE_PAY_TO` | — | Optional: only pay this seller address |
| `ARAKICE_NETWORK` | `eip155:8453` | Base. `eip155:84532` = Base Sepolia, for testing |
| `ARAKICE_API` | `https://agents.arakice.com` | API base URL |

## How payment works

The key never leaves your machine. On a paid call the API answers `402 Payment Required` with its price; this
server checks it against your caps, network and (optional) pinned seller, then signs a USDC transfer
authorization for that exact amount (EIP-3009) and retries. No gas is needed. The API settles the payment only
when it returns a successful response, so an error, an unknown date or a day without games is not charged.
Each paid result includes the amount and the transaction hash.

## Develop

```sh
npm install
npm test          # unit tests + end-to-end MCP run against a fake x402 API
```

---

_Model estimates. Not financial, legal or betting advice. Check the rules where you live._
