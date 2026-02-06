# BuffFi Trading Agent

Standalone trading agent for Base chain. Connects to BuffFi market data feed, evaluates policies against live trade data, executes swaps via on-chain contracts.

## Setup

1. Wallet must exist at `../.wallet/key.json`
2. Auth session at `../.wallet/bufffi-session.json`
3. Wallet needs ETH for gas + trading

## Running

```bash
./start.sh
```

Or via OpenClaw dashboard: Projects > BuffFi Agent > Start

## Control API

While running, HTTP control server on port 18802:

- `GET /status` — agent status, open positions, PnL
- `GET /positions` — current open trades
- `GET /config` — active policy config
- `POST /config` — update config live
- `POST /pause` — pause trading
- `POST /resume` — resume trading

## Policies

- **P52 Breakout Scale-Out** — primary strategy. Fresh pair breakout entry, 50% exit at +60%, trail remainder with 4x arm / 35% drawdown.
