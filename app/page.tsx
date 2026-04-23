import { HackerTerminal } from "@/components/HackerTerminal";
import { STABLE_FX_ADAPTER_V2_ADDRESS } from "@/constants/addresses";
import { ARC_TESTNET_RPC_URL, arcTestnet } from "@/lib/wagmi";

const WIZPAY_AGENTIC_PRO_ADDRESS =
  process.env.NEXT_PUBLIC_WIZPAY_AGENTIC_PRO_ADDRESS ??
  process.env.WIZPAY_AGENTIC_PRO_ADDRESS ??
  process.env.NEXT_PUBLIC_WIZPAY_AGENTIC_PRO_CONTRACT_ADDRESS ??
  process.env.WIZPAY_AGENTIC_PRO_CONTRACT_ADDRESS ??
  "0xc443367fddbd617436ea0842f118a3a5dee9982f";

const WIZPAY_TREASURY_ADDRESS =
  process.env.NEXT_PUBLIC_WIZPAY_TREASURY_ADDRESS ??
  process.env.WIZPAY_TREASURY_ADDRESS ??
  "";

export default function Home() {
  return (
    <HackerTerminal
      chainId={arcTestnet.id}
      chainName={arcTestnet.name}
      contractAddress={WIZPAY_AGENTIC_PRO_ADDRESS}
      initialTreasuryAddress={WIZPAY_TREASURY_ADDRESS}
      rpcUrl={ARC_TESTNET_RPC_URL}
      stableFxAdapterAddress={STABLE_FX_ADAPTER_V2_ADDRESS}
    />
  );
}
