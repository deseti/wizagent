# wizagent

Isolated Next.js scaffold extracted from the main WizPay repo for Circle Wallet SDK experiments on Arc Testnet.

What is included:
- minimal Circle W3S server proxy in `app/api/w3s/route.ts`
- minimal Circle browser hook in `hooks/useCircleW3S.ts`
- Arc Testnet wagmi/viem config in `lib/wagmi.ts`
- StableFXAdapter V2 address and ABI constants in `constants/`
- WizPay agentic batch-payment contract in `contracts/WizPayAgenticPro.sol`
- Arc Testnet deployment script in `contracts/deploy-arc-testnet.mjs`

What is intentionally not included:
- production WizPay routes, UI flows, and business logic
- the hackathon nano-payment contract and simulator
- the full Circle auth/passkey UI from the production frontend

## Setup

1. Copy `.env.example` to `.env.local`.
2. Fill `NEXT_PUBLIC_CIRCLE_APP_ID`, `CIRCLE_API_KEY`, and `CIRCLE_ALLOWED_ORIGINS`.
3. Install dependencies with `npm install`.
4. Start the app with `npm run dev`.

## Notes

- This scaffold stores the Circle `userToken` and `encryptionKey` in browser session storage for the current tab, not in persistent local storage.
- The included page is a thin sandbox for `listWallets`, `getWalletBalances`, and contract execution challenge flows against Arc Testnet.
- The Circle proxy only accepts same-origin browser requests and only forwards the contract execution targets configured for this deployment.
- The terminal uses the contract treasury route by default. Set `NEXT_PUBLIC_ENABLE_CUSTOM_TREASURY_ROUTE=true` only if you explicitly want manual treasury override in the UI.

## Vercel

1. Add the values from `.env.example` to your Vercel project settings.
2. Set `CIRCLE_ALLOWED_ORIGINS` to your production URL and any preview URLs you intentionally trust.
3. Keep `NEXT_PUBLIC_ENABLE_CUSTOM_TREASURY_ROUTE=false` unless you need manual treasury override during testing.
4. Set `NEXT_PUBLIC_WIZPAY_AGENTIC_PRO_ADDRESS` to the live Arc deployment you want the UI to execute against.

## Smart Contract Deploy

1. Fill the `WIZPAY_*` deployment variables in `.env.local`.
2. Install dependencies with `npm install`.
3. Run `npm run deploy:arc-testnet:dry-run` to compile and validate constructor arguments.
4. Run `npm run deploy:arc-testnet` to deploy to Arc Testnet.
