"use client";

import { useState } from "react";
import { isAddress, type Address } from "viem";
import { usePublicClient } from "wagmi";

import {
  STABLE_FX_ADAPTER_V2_ADDRESS,
  USDC_ADDRESS,
} from "@/constants/addresses";
import { STABLE_FX_ADAPTER_V2_ABI } from "@/constants/stablefx-abi";
import { useCircleW3S } from "@/hooks/useCircleW3S";
import { arcTestnet } from "@/lib/wagmi";

function stringify(value: unknown) {
  return JSON.stringify(
    value,
    (_key, currentValue) =>
      typeof currentValue === "bigint" ? currentValue.toString() : currentValue,
    2
  );
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

export function CircleSandbox() {
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const {
    clearSession,
    createContractExecutionChallenge,
    error,
    executeChallenge,
    getDeviceId,
    getWalletBalances,
    initializeUser,
    listWallets,
    ready,
    session,
    setSession,
    status,
  } = useCircleW3S();

  const [challengeId, setChallengeId] = useState("");
  const [contractAddress, setContractAddress] = useState(
    STABLE_FX_ADAPTER_V2_ADDRESS
  );
  const [encryptionKeyInput, setEncryptionKeyInput] = useState(
    () => session?.encryptionKey ?? ""
  );
  const [latestBlock, setLatestBlock] = useState<string | null>(null);
  const [output, setOutput] = useState<string>("");
  const [userTokenInput, setUserTokenInput] = useState(
    () => session?.userToken ?? ""
  );
  const [walletId, setWalletId] = useState("");

  const runAction = async (label: string, action: () => Promise<unknown>) => {
    try {
      const result = await action();
      setOutput(`${label}\n\n${stringify(result)}`);
    } catch (nextError) {
      setOutput(`${label}\n\n${normalizeError(nextError)}`);
    }
  };

  const handleSaveSession = () => {
    if (!userTokenInput || !encryptionKeyInput) {
      setOutput("Session\n\nProvide both userToken and encryptionKey.");
      return;
    }

    setSession({
      encryptionKey: encryptionKeyInput,
      userToken: userTokenInput,
    });
    setOutput("Session\n\nCircle session stored locally.");
  };

  const handleCreateChallenge = async () => {
    if (!walletId) {
      setOutput("Create challenge\n\nwalletId is required.");
      return;
    }

    if (!isAddress(contractAddress)) {
      setOutput("Create challenge\n\ncontractAddress must be a valid EVM address.");
      return;
    }

    await runAction("Create challenge", async () => {
      const handle = await createContractExecutionChallenge({
        walletId,
        contractAddress: contractAddress as Address,
        callData: "0x",
        feeLevel: "MEDIUM",
        memo: "wizagent sandbox",
        refId: `wizagent-${Date.now().toString(36)}`,
      });

      setChallengeId(handle.challengeId);
      return handle;
    });
  };

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Circle W3S Hook</p>
          <h2>Manual Session Sandbox</h2>
        </div>
        <div className="status-stack">
          <span className={`pill ${ready ? "is-ready" : "is-waiting"}`}>
            {ready ? "SDK ready" : "SDK booting"}
          </span>
          <span className="pill">Arc chain {arcTestnet.id}</span>
          <span className="pill">ABI items {STABLE_FX_ADAPTER_V2_ABI.length}</span>
        </div>
      </div>

      <div className="grid two-up">
        <label className="field">
          <span>User token</span>
          <textarea
            rows={4}
            value={userTokenInput}
            onChange={(event) => setUserTokenInput(event.target.value.trim())}
            placeholder="Paste Circle userToken"
          />
        </label>
        <label className="field">
          <span>Encryption key</span>
          <textarea
            rows={4}
            value={encryptionKeyInput}
            onChange={(event) => setEncryptionKeyInput(event.target.value.trim())}
            placeholder="Paste Circle encryptionKey"
          />
        </label>
      </div>

      <div className="actions">
        <button type="button" onClick={handleSaveSession}>
          Store Session
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            clearSession();
            setUserTokenInput("");
            setEncryptionKeyInput("");
          }}
        >
          Clear Session
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => runAction("Device ID", getDeviceId)}
        >
          Get Device ID
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            runAction("Arc latest block", async () => {
              if (!publicClient) {
                throw new Error("Arc public client is not ready.");
              }

              const blockNumber = await publicClient.getBlockNumber();
              setLatestBlock(blockNumber.toString());
              return { blockNumber: blockNumber.toString() };
            })
          }
        >
          Load Arc Block
        </button>
      </div>

      <div className="grid three-up compact-grid">
        <label className="field">
          <span>Wallet ID</span>
          <input
            value={walletId}
            onChange={(event) => setWalletId(event.target.value.trim())}
            placeholder="Circle wallet ID"
          />
        </label>
        <label className="field">
          <span>Contract address</span>
          <input
            value={contractAddress}
            onChange={(event) => setContractAddress(event.target.value.trim() as Address)}
            placeholder={STABLE_FX_ADAPTER_V2_ADDRESS}
          />
        </label>
        <label className="field">
          <span>Challenge ID</span>
          <input
            value={challengeId}
            onChange={(event) => setChallengeId(event.target.value.trim())}
            placeholder="Challenge returned by Circle"
          />
        </label>
      </div>

      <div className="actions">
        <button
          type="button"
          onClick={() => runAction("Initialize user", initializeUser)}
        >
          Initialize ARC Wallet Set
        </button>
        <button
          type="button"
          onClick={() =>
            runAction("List wallets", async () => {
              const wallets = await listWallets();
              if (wallets[0]?.id) {
                setWalletId(wallets[0].id);
              }
              return wallets;
            })
          }
        >
          List Wallets
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            runAction("Wallet balances", async () => getWalletBalances(walletId))
          }
        >
          Get Balances
        </button>
        <button type="button" onClick={handleCreateChallenge}>
          Create Contract Challenge
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            runAction("Execute challenge", async () => executeChallenge(challengeId))
          }
        >
          Execute Challenge
        </button>
      </div>

      <div className="grid two-up compact-grid">
        <div className="info-card">
          <p className="info-label">StableFXAdapter V2</p>
          <code>{STABLE_FX_ADAPTER_V2_ADDRESS}</code>
        </div>
        <div className="info-card">
          <p className="info-label">Arc USDC</p>
          <code>{USDC_ADDRESS}</code>
        </div>
        <div className="info-card">
          <p className="info-label">SDK status</p>
          <span>{status ?? "idle"}</span>
        </div>
        <div className="info-card">
          <p className="info-label">Latest Arc block</p>
          <span>{latestBlock ?? "not loaded"}</span>
        </div>
      </div>

      {(error || output) && (
        <div className="output-wrap">
          {error ? <p className="error-copy">{error}</p> : null}
          <pre>{output}</pre>
        </div>
      )}
    </section>
  );
}
