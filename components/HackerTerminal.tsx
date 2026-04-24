"use client";

import {
  useCallback,
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  encodeFunctionData,
  formatUnits,
  isAddress,
  keccak256,
  parseEventLogs,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { usePublicClient } from "wagmi";

import { ERC20_ABI } from "@/constants/erc20-abi";
import { USDC_ADDRESS } from "@/constants/addresses";
import { WIZPAY_AGENTIC_PRO_ABI } from "@/constants/wizpay-agentic-pro-abi";
import { useCircleW3S } from "@/hooks/useCircleW3S";
import { arcTestnet } from "@/lib/wagmi";

type LogTone = "matrix" | "cyan" | "amber" | "muted";

type LogEntry = {
  id: string;
  tag: string;
  message: string;
  tone: LogTone;
  href?: string;
  hrefLabel?: string;
};

type ActivePayrollExecution = {
  executionId: number;
  expectedAgentCount: number;
  observedTaskHashes: Set<Hex>;
  payer: Address;
  seenEventKeys: Set<string>;
  taskHashes: Set<Hex>;
  txHash: Hex | null;
};

type SmartPastePayload = {
  token: string;
  key: string;
  walletId: string;
  treasuryAddress?: string;
};

type AgentEconomyDebugState = {
  allowance?: string | null;
  approvalTxHash?: string | null;
  balance?: string | null;
  contract?: string | null;
  signer?: string | null;
  treasury?: string | null;
};

type AgentEconomyResultRow = {
  href: string;
  taskId: string;
  txHash: string;
};

type AgentEconomyStreamMessage =
  | {
      debug: AgentEconomyDebugState;
      total: number;
      type: "debug";
    }
  | {
      message: string;
      progress: number;
      task_id?: string;
      total: number;
      txHash?: string;
      type: "status";
    }
  | {
      progress: number;
      result: {
        href: string;
        task_id: string;
        txHash: string;
      };
      total: number;
      type: "result";
    }
  | {
      debug: AgentEconomyDebugState;
      progress: number;
      total: number;
      type: "done";
    }
  | {
      cause: string;
      debug: AgentEconomyDebugState;
      error: string;
      progress: number;
      task_id?: string;
      total: number;
      type: "error";
    };

type HackerTerminalProps = {
  chainId: number;
  chainName: string;
  contractAddress: string;
  initialTreasuryAddress?: string;
  rpcUrl: string;
  stableFxAdapterAddress: string;
};

const MAX_LOG_LINES = 120;
const ARCSCAN_BASE_URL = arcTestnet.blockExplorers.default.url;
const DEFAULT_USDC_DECIMALS = 6;
const DEFAULT_APPROVAL_WHOLE_UNITS = 1_000_000n;
const AGENT_ECONOMY_TASK_COUNT = 50;
const AGENT_ECONOMY_IDLE_MESSAGE =
  "Idle. Launch the agent economy lane to watch 50 separate Arc transactions appear one by one.";
const DEFAULT_AGENT_ECONOMY_AGENTS = [
  {
    id: "a",
    role: "analyst",
    wallet: "0x1111111111111111111111111111111111111111",
    cost: 0.002,
  },
  {
    id: "b",
    role: "validator",
    wallet: "0x2222222222222222222222222222222222222222",
    cost: 0.001,
  },
  {
    id: "c",
    role: "executor",
    wallet: "0x3333333333333333333333333333333333333333",
    cost: 0.003,
  },
] as const;
const CUSTOM_TREASURY_ROUTE_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_CUSTOM_TREASURY_ROUTE === "true";

const divisions = [
  {
    id: "DIV-01",
    name: "Signal Hunters",
    description: "Task intake, duplicate trap, and payroll queue formation.",
    status: "50 task hashes primed",
  },
  {
    id: "DIV-02",
    name: "Validation Mesh",
    description: "Anti-spam screening and settlement policy enforcement.",
    status: "taskHash shield active",
  },
  {
    id: "DIV-03",
    name: "Translator (EURC)",
    description: "Cross-currency routing for agents that require EURC settlement.",
    status: "fx lanes and LP fee taps armed",
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSmartPastePayload(value: unknown): value is SmartPastePayload {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.token === "string" &&
    typeof value.key === "string" &&
    typeof value.walletId === "string" &&
    (typeof value.treasuryAddress === "undefined" ||
      typeof value.treasuryAddress === "string")
  );
}

function isAgentEconomyDebugState(value: unknown): value is AgentEconomyDebugState {
  return isRecord(value);
}

function isAgentEconomyResultPayload(
  value: unknown
): value is { href: string; task_id: string; txHash: string } {
  return (
    isRecord(value) &&
    typeof value.task_id === "string" &&
    typeof value.txHash === "string" &&
    typeof value.href === "string"
  );
}

function getNestedString(source: unknown, path: string[]) {
  let current: unknown = source;

  for (const key of path) {
    if (!isRecord(current) || typeof current[key] === "undefined") {
      return null;
    }

    current = current[key];
  }

  return typeof current === "string" && current ? current : null;
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

function maskSecret(value: string) {
  if (!value) {
    return "";
  }

  return "*".repeat(Math.min(Math.max(value.length, 16), 48));
}

function waitFor(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatAmount(
  amount: bigint,
  decimals: number,
  minimumFractionDigits: number,
  maximumFractionDigits = minimumFractionDigits
) {
  const [whole, rawFraction = ""] = formatUnits(amount, decimals).split(".");

  const paddedFraction = rawFraction.padEnd(minimumFractionDigits, "0");
  const trimmedFraction = paddedFraction.slice(0, maximumFractionDigits);
  const compactFraction =
    maximumFractionDigits === minimumFractionDigits
      ? trimmedFraction
      : trimmedFraction.replace(/0+$/, "");

  return compactFraction ? `${whole}.${compactFraction}` : whole;
}

function shortenAddress(address: string) {
  if (address.length < 12) {
    return address;
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function createLogId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function extractTxHash(result: unknown) {
  const txHash =
    getNestedString(result, ["data", "txHash"]) ??
    getNestedString(result, ["txHash"]) ??
    getNestedString(result, ["transactionHash"]);

  return txHash && txHash.startsWith("0x") ? (txHash as Hex) : null;
}

function extractTransactionId(result: unknown) {
  return (
    getNestedString(result, ["data", "transactionId"]) ??
    getNestedString(result, ["transactionId"]) ??
    getNestedString(result, ["transaction", "id"]) ??
    getNestedString(result, ["transaction", "transactionId"])
  );
}

function buildBatchPayload(walletAddress: Address, runSalt: string) {
  const agents = Array.from({ length: 50 }, () => walletAddress);
  const taskHashes = Array.from({ length: 50 }, (_, index) =>
    keccak256(stringToHex(`wizpay:${walletAddress}:${runSalt}:${index + 1}`))
  );

  return {
    agents,
    taskHashes,
  };
}

function shortenHex(value: string) {
  if (value.length < 18) {
    return value;
  }

  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function buildBootLogs(contractAddress: string): LogEntry[] {
  return [
    {
      id: createLogId(),
      tag: "BOOT",
      message: "WizPay hacker terminal online. Three AI divisions and Treasury-Bot linked.",
      tone: "matrix",
    },
    {
      id: createLogId(),
      tag: "ARC",
      message: "Arc Testnet control plane synced for sponsored execution.",
      tone: "cyan",
    },
    {
      id: createLogId(),
      tag: "ROUTER",
      message: `Payroll router detected at ${contractAddress}.`,
      tone: "matrix",
    },
    {
      id: createLogId(),
      tag: "GAS",
      message: "Gas Fee: $0.00 (ERC-4337 Sponsored)",
      tone: "cyan",
    },
    {
      id: createLogId(),
      tag: "READY",
      message:
        "Awaiting Circle auth. Use the click controls to sync wallet, approve USDC, and run payroll.",
      tone: "muted",
    },
  ];
}

export function HackerTerminal({
  chainId,
  chainName,
  contractAddress,
  initialTreasuryAddress = "",
  rpcUrl,
  stableFxAdapterAddress,
}: HackerTerminalProps) {
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const {
    clearSession,
    createContractExecutionChallenge,
    error,
    executeChallenge,
    getChallengeTransactionStatus,
    initializeUser,
    listWallets,
    ready,
    session,
    setSession,
    status,
  } = useCircleW3S();
  const [logs, setLogs] = useState<LogEntry[]>(() => buildBootLogs(contractAddress));
  const deferredLogs = useDeferredValue(logs);
  const [isRunning, setIsRunning] = useState(false);
  const [runCount, setRunCount] = useState(0);
  const [userTokenInput, setUserTokenInput] = useState(() => session?.userToken ?? "");
  const [encryptionKeyInput, setEncryptionKeyInput] = useState(
    () => session?.encryptionKey ?? ""
  );
  const [areCredentialsConcealed, setAreCredentialsConcealed] = useState(
    () => Boolean(session?.userToken || session?.encryptionKey)
  );
  const [walletIdInput, setWalletIdInput] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [walletUsdcBalance, setWalletUsdcBalance] = useState<bigint | null>(null);
  const [treasuryAddress, setTreasuryAddress] = useState(() => initialTreasuryAddress.trim());
  const [contractTreasuryAddress, setContractTreasuryAddress] = useState("");
  const [isApprovingAllowance, setIsApprovingAllowance] = useState(false);
  const [isSmartPasting, setIsSmartPasting] = useState(false);
  const [isInjectionGlowActive, setIsInjectionGlowActive] = useState(false);
  const [treasuryBalance, setTreasuryBalance] = useState<bigint | null>(null);
  const [usdcDecimals, setUsdcDecimals] = useState(DEFAULT_USDC_DECIMALS);
  const [sessionFeeLift, setSessionFeeLift] = useState<bigint>(0n);
  const [lastTxHash, setLastTxHash] = useState<Hex | null>(null);
  const [lastGrossCharge, setLastGrossCharge] = useState<bigint | null>(null);
  const [lastSwapCount, setLastSwapCount] = useState<bigint>(0n);
  const [lastTreasuryFeeQuote, setLastTreasuryFeeQuote] = useState<bigint>(0n);
  const [agentEconomyDebug, setAgentEconomyDebug] = useState<AgentEconomyDebugState>({});
  const [agentEconomyError, setAgentEconomyError] = useState<string | null>(null);
  const [agentEconomyResults, setAgentEconomyResults] = useState<AgentEconomyResultRow[]>(
    []
  );
  const [isAgentEconomyRunning, setIsAgentEconomyRunning] = useState(false);
  const [agentEconomyStatus, setAgentEconomyStatus] = useState(
    AGENT_ECONOMY_IDLE_MESSAGE
  );
  const [agentEconomyTotal, setAgentEconomyTotal] = useState(
    AGENT_ECONOMY_TASK_COUNT
  );
  const executionRef = useRef(0);
  const activeExecutionRef = useRef<ActivePayrollExecution | null>(null);
  const agentEconomyAbortRef = useRef<AbortController | null>(null);
  const agentEconomyViewportRef = useRef<HTMLDivElement | null>(null);
  const glowTimeoutRef = useRef<number | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const explorerLink = lastTxHash ? `${ARCSCAN_BASE_URL}/tx/${lastTxHash}` : null;
  const lastAgentEconomyResult =
    agentEconomyResults[agentEconomyResults.length - 1] ?? null;
  const payrollRouterAddress = isAddress(contractAddress)
    ? (contractAddress as Address)
    : null;
  const envTreasuryAddress = initialTreasuryAddress.trim();
  const displayedTreasuryAddress = CUSTOM_TREASURY_ROUTE_ENABLED
    ? treasuryAddress.trim() || contractTreasuryAddress.trim() || envTreasuryAddress
    : contractTreasuryAddress.trim() || envTreasuryAddress || treasuryAddress.trim();
  const approvalAmount = DEFAULT_APPROVAL_WHOLE_UNITS * 10n ** BigInt(usdcDecimals);
  const hasCredentialInputs = Boolean(userTokenInput.trim() || encryptionKeyInput.trim());

  const refreshTreasuryBalance = useCallback(async () => {
    if (!publicClient || !displayedTreasuryAddress || !isAddress(displayedTreasuryAddress)) {
      setTreasuryBalance(null);
      return;
    }

    try {
      const nextBalance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [displayedTreasuryAddress as Address],
      });

      setTreasuryBalance(nextBalance);
    } catch {
      setTreasuryBalance(null);
    }
  }, [displayedTreasuryAddress, publicClient]);

  useEffect(() => {
    return () => {
      executionRef.current += 1;
      activeExecutionRef.current = null;

      if (glowTimeoutRef.current !== null) {
        window.clearTimeout(glowTimeoutRef.current);
      }

      if (agentEconomyAbortRef.current) {
        agentEconomyAbortRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [deferredLogs]);

  useEffect(() => {
    const viewport = agentEconomyViewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [agentEconomyResults, agentEconomyStatus]);

  useEffect(() => {
    let cancelled = false;

    async function loadTreasuryAddress() {
      if (!publicClient || !payrollRouterAddress) {
        return;
      }

      try {
        const nextTreasuryAddress = await publicClient.readContract({
          address: payrollRouterAddress,
          abi: WIZPAY_AGENTIC_PRO_ABI,
          functionName: "treasury",
        });

        if (!cancelled) {
          setContractTreasuryAddress(nextTreasuryAddress);
        }
      } catch {
        if (!cancelled) {
          setContractTreasuryAddress("");
        }
      }
    }

    void loadTreasuryAddress();

    return () => {
      cancelled = true;
    };
  }, [payrollRouterAddress, publicClient]);

  useEffect(() => {
    let cancelled = false;

    async function loadUsdcDecimals() {
      if (!publicClient) {
        return;
      }

      try {
        const nextDecimals = await publicClient.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "decimals",
        });

        if (!cancelled) {
          setUsdcDecimals(Number(nextDecimals));
        }
      } catch {
        if (!cancelled) {
          setUsdcDecimals(DEFAULT_USDC_DECIMALS);
        }
      }
    }

    void loadUsdcDecimals();

    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  useEffect(() => {
    const refreshTimer = window.setTimeout(() => {
      void refreshTreasuryBalance();
    }, 0);

    return () => {
      window.clearTimeout(refreshTimer);
    };
  }, [refreshTreasuryBalance, runCount]);

  const appendLog = useCallback((entry: Omit<LogEntry, "id">) => {
    startTransition(() => {
      setLogs((currentLogs) => [
        ...currentLogs.slice(-(MAX_LOG_LINES - 1)),
        {
          id: createLogId(),
          ...entry,
        },
      ]);
    });
  }, []);

  const handleAgentEconomyMessage = useCallback(
    (message: AgentEconomyStreamMessage) => {
      setAgentEconomyTotal(message.total);

      if (message.type === "debug") {
        setAgentEconomyDebug((current) => ({
          ...current,
          ...message.debug,
        }));
        return;
      }

      if (message.type === "status") {
        setAgentEconomyStatus(message.message);

        if (message.message !== "Holding for 1 second before the next task transaction.") {
          appendLog({
            tag: "AGENT",
            message: message.message,
            tone: "amber",
            ...(message.txHash
              ? {
                  href: `${ARCSCAN_BASE_URL}/tx/${message.txHash}`,
                  hrefLabel: "Open ArcScan TX",
                }
              : {}),
          });
        }

        return;
      }

      if (message.type === "result") {
        setAgentEconomyResults((current) => [
          ...current,
          {
            href: message.result.href,
            taskId: message.result.task_id,
            txHash: message.result.txHash,
          },
        ]);
        setAgentEconomyStatus(
          `${message.progress}/${message.total} task transactions confirmed on Arc.`
        );
        appendLog({
          tag: `AE-${String(message.progress).padStart(2, "0")}`,
          message: `${message.result.task_id} confirmed as its own transaction ${shortenHex(message.result.txHash)}.`,
          tone: "amber",
          href: message.result.href,
          hrefLabel: "Open ArcScan TX",
        });
        return;
      }

      if (message.type === "done") {
        setAgentEconomyDebug((current) => ({
          ...current,
          ...message.debug,
        }));
        setAgentEconomyStatus(
          `Agent economy complete. ${message.progress}/${message.total} separate task transactions confirmed.`
        );
        appendLog({
          tag: "AGENT",
          message: `Agent economy complete with ${message.progress} separate task transactions.`,
          tone: "matrix",
        });
        return;
      }

      setAgentEconomyDebug((current) => ({
        ...current,
        ...message.debug,
      }));
      setAgentEconomyError(message.error);
      setAgentEconomyStatus(
        message.task_id
          ? `${message.task_id} failed: ${message.error}`
          : message.error
      );
      appendLog({
        tag: "AGENT",
        message: message.task_id
          ? `Agent economy failed at ${message.task_id}: ${message.error}`
          : `Agent economy failed: ${message.error}`,
        tone: "amber",
      });
    },
    [appendLog]
  );

  const handleRunAgentEconomy = useCallback(async () => {
    if (isAgentEconomyRunning) {
      return;
    }

    agentEconomyAbortRef.current?.abort();

    const abortController = new AbortController();
    const decoder = new TextDecoder();
    let lineBuffer = "";

    agentEconomyAbortRef.current = abortController;
    setIsAgentEconomyRunning(true);
    setAgentEconomyError(null);
    setAgentEconomyResults([]);
    setAgentEconomyDebug({});
    setAgentEconomyTotal(AGENT_ECONOMY_TASK_COUNT);
    setAgentEconomyStatus(
      "Booting the 50-task agent economy lane. Separate contract calls will arrive one by one."
    );
    appendLog({
      tag: "AGENT",
      message:
        "Agent economy request dispatched to /api/agent-economy. Expect 50 separate Arc transactions, not one batch sweep.",
      tone: "amber",
    });

    const processStreamLine = (line: string) => {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        return;
      }

      const parsedValue = JSON.parse(trimmedLine) as unknown;
      if (!isRecord(parsedValue) || typeof parsedValue.type !== "string") {
        return;
      }

      if (
        parsedValue.type === "debug" &&
        isAgentEconomyDebugState(parsedValue.debug) &&
        typeof parsedValue.total === "number"
      ) {
        handleAgentEconomyMessage({
          debug: parsedValue.debug,
          total: parsedValue.total,
          type: "debug",
        });
        return;
      }

      if (
        parsedValue.type === "status" &&
        typeof parsedValue.message === "string" &&
        typeof parsedValue.progress === "number" &&
        typeof parsedValue.total === "number"
      ) {
        handleAgentEconomyMessage({
          message: parsedValue.message,
          progress: parsedValue.progress,
          ...(typeof parsedValue.task_id === "string"
            ? { task_id: parsedValue.task_id }
            : {}),
          total: parsedValue.total,
          ...(typeof parsedValue.txHash === "string"
            ? { txHash: parsedValue.txHash }
            : {}),
          type: "status",
        });
        return;
      }

      if (
        parsedValue.type === "result" &&
        typeof parsedValue.progress === "number" &&
        typeof parsedValue.total === "number" &&
        isAgentEconomyResultPayload(parsedValue.result)
      ) {
        handleAgentEconomyMessage({
          progress: parsedValue.progress,
          result: {
            href: parsedValue.result.href,
            task_id: parsedValue.result.task_id,
            txHash: parsedValue.result.txHash,
          },
          total: parsedValue.total,
          type: "result",
        });
        return;
      }

      if (
        parsedValue.type === "done" &&
        typeof parsedValue.progress === "number" &&
        typeof parsedValue.total === "number" &&
        isAgentEconomyDebugState(parsedValue.debug)
      ) {
        handleAgentEconomyMessage({
          debug: parsedValue.debug,
          progress: parsedValue.progress,
          total: parsedValue.total,
          type: "done",
        });
        return;
      }

      if (
        parsedValue.type === "error" &&
        typeof parsedValue.error === "string" &&
        typeof parsedValue.progress === "number" &&
        typeof parsedValue.total === "number" &&
        isAgentEconomyDebugState(parsedValue.debug)
      ) {
        handleAgentEconomyMessage({
          cause:
            typeof parsedValue.cause === "string"
              ? parsedValue.cause
              : "invalid contract config",
          debug: parsedValue.debug,
          error: parsedValue.error,
          progress: parsedValue.progress,
          ...(typeof parsedValue.task_id === "string"
            ? { task_id: parsedValue.task_id }
            : {}),
          total: parsedValue.total,
          type: "error",
        });
      }
    };

    try {
      const response = await fetch("/api/agent-economy", {
        body: JSON.stringify({
          execute: true,
          task_count: AGENT_ECONOMY_TASK_COUNT,
          agents: DEFAULT_AGENT_ECONOMY_AGENTS,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        const fallbackText = await response.text().catch(() => "");
        throw new Error(
          fallbackText || `Agent economy request failed with status ${response.status}.`
        );
      }

      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        lineBuffer += decoder.decode(value, { stream: true });

        let newlineIndex = lineBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          processStreamLine(lineBuffer.slice(0, newlineIndex));
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          newlineIndex = lineBuffer.indexOf("\n");
        }
      }

      const trailingLine = `${lineBuffer}${decoder.decode()}`.trim();
      if (trailingLine) {
        processStreamLine(trailingLine);
      }
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        return;
      }

      const message = normalizeError(error);
      setAgentEconomyError(message);
      setAgentEconomyStatus(message);
      appendLog({
        tag: "AGENT",
        message: `Agent economy request failed before the stream completed: ${message}`,
        tone: "amber",
      });
    } finally {
      if (agentEconomyAbortRef.current === abortController) {
        agentEconomyAbortRef.current = null;
      }

      setIsAgentEconomyRunning(false);
    }
  }, [appendLog, handleAgentEconomyMessage, isAgentEconomyRunning]);

  const recordAgentPaidEvent = useCallback(
    ({
      agent,
      logIndex,
      settlementAmount,
      settlementToken,
      taskHash,
      transactionHash,
      treasuryFee,
    }: {
      agent: Address;
      logIndex: bigint | number | null | undefined;
      settlementAmount: bigint;
      settlementToken: Address;
      taskHash: Hex;
      transactionHash: Hex | null;
      treasuryFee: bigint;
    }) => {
      const activeExecution = activeExecutionRef.current;
      if (!activeExecution || !activeExecution.taskHashes.has(taskHash)) {
        return false;
      }

      if (
        activeExecution.txHash !== null &&
        transactionHash !== null &&
        activeExecution.txHash !== transactionHash
      ) {
        return false;
      }

      const eventKey = `${transactionHash ?? "pending"}:${String(logIndex ?? -1)}:${taskHash}`;
      if (activeExecution.seenEventKeys.has(eventKey)) {
        return false;
      }

      activeExecution.seenEventKeys.add(eventKey);
      activeExecution.observedTaskHashes.add(taskHash);

      if (transactionHash !== null) {
        activeExecution.txHash = transactionHash;
        setLastTxHash(transactionHash);
      }

      if (treasuryFee > 0n) {
        setSessionFeeLift((current) => current + treasuryFee);
      }

      const settlementLabel =
        settlementToken.toLowerCase() === USDC_ADDRESS.toLowerCase() ? "USDC" : "EURC";

      appendLog({
        tag: `EVENT-${String(activeExecution.observedTaskHashes.size).padStart(2, "0")}`,
        message:
          settlementLabel === "USDC"
            ? `AgentPaid detected on-chain for ${shortenHex(taskHash)} -> ${shortenAddress(agent)} settled ${formatAmount(settlementAmount, usdcDecimals, 6, 6)} USDC.`
            : `AgentPaid detected on-chain for ${shortenHex(taskHash)} -> ${shortenAddress(agent)} settled ${formatAmount(settlementAmount, usdcDecimals, 6, 6)} EURC and routed ${formatAmount(treasuryFee, usdcDecimals, 6, 6)} USDC treasury fee.`,
        tone: settlementLabel === "USDC" ? "matrix" : "cyan",
        href: transactionHash ? `${ARCSCAN_BASE_URL}/tx/${transactionHash}` : undefined,
        hrefLabel: transactionHash ? "Open Event TX" : undefined,
      });

      return true;
    },
    [appendLog, usdcDecimals]
  );

  useEffect(() => {
    if (!publicClient || !payrollRouterAddress) {
      return;
    }

    return publicClient.watchContractEvent({
      address: payrollRouterAddress,
      abi: WIZPAY_AGENTIC_PRO_ABI,
      eventName: "AgentPaid",
      poll: true,
      pollingInterval: 4_000,
      onLogs(nextLogs) {
        for (const log of nextLogs) {
          if ("removed" in log && log.removed) {
            continue;
          }

          const activeExecution = activeExecutionRef.current;
          if (!activeExecution) {
            continue;
          }

          const { args } = log;
          if (
            !args.taskHash ||
            !args.payer ||
            !args.agent ||
            !args.settlementToken ||
            typeof args.settlementAmount !== "bigint" ||
            typeof args.treasuryFee !== "bigint"
          ) {
            continue;
          }

          if (args.payer.toLowerCase() !== activeExecution.payer.toLowerCase()) {
            continue;
          }

          recordAgentPaidEvent({
            agent: args.agent,
            logIndex: log.logIndex,
            settlementAmount: args.settlementAmount,
            settlementToken: args.settlementToken,
            taskHash: args.taskHash,
            transactionHash: log.transactionHash ?? null,
            treasuryFee: args.treasuryFee,
          });
        }
      },
      onError(nextError) {
        if (!activeExecutionRef.current) {
          return;
        }

        appendLog({
          tag: "WATCH",
          message: `AgentPaid watcher error: ${normalizeError(nextError)}`,
          tone: "amber",
        });
      },
    });
  }, [appendLog, payrollRouterAddress, publicClient, recordAgentPaidEvent]);

  function handleSaveSession() {
    const userToken = userTokenInput.trim();
    const encryptionKey = encryptionKeyInput.trim();

    if (!userToken || !encryptionKey) {
      appendLog({
        tag: "AUTH",
        message: "Provide both Circle userToken and encryptionKey before storing the session.",
        tone: "amber",
      });
      return;
    }

    setSession({
      encryptionKey,
      userToken,
    });
    setAreCredentialsConcealed(true);
    appendLog({
      tag: "AUTH",
      message: "Circle operator session stored for this browser tab.",
      tone: "cyan",
    });
  }

  function handleClearSession() {
    clearSession();
    setUserTokenInput("");
    setEncryptionKeyInput("");
    setAreCredentialsConcealed(false);
    setWalletIdInput("");
    setTreasuryAddress(envTreasuryAddress);
    setWalletAddress("");
    appendLog({
      tag: "AUTH",
      message: "Circle session cleared from this browser tab.",
      tone: "muted",
    });
  }

  function triggerInjectionGlow() {
    if (glowTimeoutRef.current !== null) {
      window.clearTimeout(glowTimeoutRef.current);
    }

    setIsInjectionGlowActive(true);
    glowTimeoutRef.current = window.setTimeout(() => {
      setIsInjectionGlowActive(false);
      glowTimeoutRef.current = null;
    }, 900);
  }

  async function resolveChallengeTxHash({
    challengeId,
    initialResult,
    logContext,
    transactionId,
  }: {
    challengeId: string;
    initialResult: unknown;
    logContext: string;
    transactionId?: string | null;
  }) {
    const immediateTxHash = extractTxHash(initialResult);
    if (immediateTxHash) {
      return immediateTxHash;
    }

    const immediateTransactionId = extractTransactionId(initialResult) ?? transactionId ?? null;
    if (immediateTransactionId) {
      appendLog({
        tag: "SYSTEM",
        message: `${logContext} accepted by Circle. Transaction ${immediateTransactionId} is pending hash propagation.`,
        tone: "muted",
      });
    }

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      appendLog({
        tag: "SYSTEM",
        message: `WAITING FOR ON-CHAIN CONFIRMATION (POLLING ATTEMPT ${attempt}/5)...`,
        tone: "amber",
      });

      await waitFor(2_000);

      const statusPayload = await getChallengeTransactionStatus(
        challengeId,
        immediateTransactionId
      );
      const polledTxHash = extractTxHash(statusPayload) ??
        (statusPayload.txHash && statusPayload.txHash.startsWith("0x")
          ? (statusPayload.txHash as Hex)
          : null);

      if (polledTxHash) {
        return polledTxHash;
      }
    }

    throw new Error(
      `${logContext} was approved by Circle, but the transaction hash was still unavailable after 5 polling attempts.`
    );
  }

  async function handleSmartPaste() {
    if (isSmartPasting) {
      return;
    }

    setIsSmartPasting(true);

    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
        throw new Error("Clipboard API is not available in this browser context.");
      }

      appendLog({
        tag: "ACCESS",
        message: "INCOMING ENCRYPTED PAYLOAD DETECTED...",
        tone: "cyan",
      });

      const clipboardText = await navigator.clipboard.readText();
      const parsedPayload = JSON.parse(clipboardText) as unknown;

      if (!isSmartPastePayload(parsedPayload)) {
        throw new Error(
          "Smart Paste expects JSON in the format {\"token\":\"...\",\"key\":\"...\",\"walletId\":\"...\",\"treasuryAddress\":\"0x...\"}."
        );
      }

      const token = parsedPayload.token.trim();
      const key = parsedPayload.key.trim();
      const walletId = parsedPayload.walletId.trim();
      const nextTreasuryAddress = parsedPayload.treasuryAddress?.trim() ?? "";

      if (!token || !key || !walletId) {
        throw new Error(
          "Smart Paste received an incomplete payload. token, key, and walletId are all required."
        );
      }
      if (nextTreasuryAddress && !isAddress(nextTreasuryAddress)) {
        throw new Error("Smart Paste received an invalid treasuryAddress.");
      }

      await waitFor(180);
      appendLog({
        tag: "DECRYPT",
        message: "PARSING JSON KERNEL... SUCCESS.",
        tone: "matrix",
      });

      setUserTokenInput(token);
      setEncryptionKeyInput(key);
      setWalletIdInput(walletId);
      if (CUSTOM_TREASURY_ROUTE_ENABLED && nextTreasuryAddress) {
        setTreasuryAddress(nextTreasuryAddress);
      }
      setSession({
        encryptionKey: key,
        userToken: token,
      });
      setAreCredentialsConcealed(true);
      triggerInjectionGlow();

      await waitFor(220);
      appendLog({
        tag: "SYSTEM",
        message: "SESSION INJECTED. AGENTIC ENGINE READY.",
        tone: "matrix",
      });

      if (CUSTOM_TREASURY_ROUTE_ENABLED && nextTreasuryAddress) {
        await waitFor(180);
        appendLog({
          tag: "SYSTEM",
          message: `LP AGENT RE-ROUTED TO: ${nextTreasuryAddress}`,
          tone: "matrix",
        });
      } else if (nextTreasuryAddress) {
        await waitFor(180);
        appendLog({
          tag: "SYSTEM",
          message: "Custom treasury override ignored. The deployed contract treasury stays authoritative.",
          tone: "muted",
        });
      }
    } catch (nextError) {
      appendLog({
        tag: "ERROR",
        message: normalizeError(nextError),
        tone: "amber",
      });
    } finally {
      setIsSmartPasting(false);
    }
  }

  async function handleApprovePayrollAllowance() {
    if (isApprovingAllowance) {
      return;
    }

    setIsApprovingAllowance(true);

    try {
      if (!ready) {
        throw new Error("Circle Web SDK is still booting. Wait for the SDK ready indicator.");
      }
      if (!publicClient) {
        throw new Error("Arc public client is not ready.");
      }
      if (!payrollRouterAddress) {
        throw new Error("WizPayAgenticPro contract address is missing or invalid.");
      }

      ensureCircleSessionForExecution();
      const { address: operatorAddress, id: operatorWalletId } =
        await resolveOperatorWallet();
      const approvalRef = `wizagent-approve-${Date.now().toString(36)}`;

      appendLog({
        tag: "SECURITY",
        message: `Requesting persistent USDC allowance for ${shortenAddress(payrollRouterAddress)} from ${operatorAddress}.`,
        tone: "amber",
      });

      const callData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [payrollRouterAddress, approvalAmount],
      });

      const challenge = await createContractExecutionChallenge({
        walletId: operatorWalletId,
        contractAddress: USDC_ADDRESS,
        callData,
        feeLevel: "MEDIUM",
        memo: "WizPay payroll USDC approval",
        refId: approvalRef,
      });

      appendLog({
        tag: "CIRCLE",
        message: `Allowance challenge ${challenge.challengeId.slice(0, 12)}... created. Awaiting Circle approval modal.`,
        tone: "muted",
      });

      const challengeResult = await executeChallenge(challenge.challengeId);
      const txHash = await resolveChallengeTxHash({
        challengeId: challenge.challengeId,
        initialResult: challengeResult,
        logContext: "Allowance request",
        transactionId: challenge.transactionId,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status !== "success") {
        throw new Error(`USDC approval transaction ${txHash} was mined but reverted.`);
      }

      appendLog({
        tag: "SYSTEM",
        message: `USDC allowance granted for ${formatAmount(approvalAmount, usdcDecimals, 2, 2)} USDC.`,
        tone: "matrix",
        href: `${ARCSCAN_BASE_URL}/tx/${txHash}`,
        hrefLabel: "Open Approval TX",
      });
    } catch (nextError) {
      appendLog({
        tag: "ERROR",
        message: normalizeError(nextError),
        tone: "amber",
      });
    } finally {
      setIsApprovingAllowance(false);
    }
  }

  function ensureCircleSessionForExecution() {
    const userToken = userTokenInput.trim();
    const encryptionKey = encryptionKeyInput.trim();

    if (userToken && encryptionKey) {
      if (session?.userToken !== userToken || session?.encryptionKey !== encryptionKey) {
        setSession({
          encryptionKey,
          userToken,
        });
      }

      return;
    }

    if (!session?.userToken || !session.encryptionKey) {
      throw new Error(
        "Circle session is missing. Paste userToken and encryptionKey, then execute again."
      );
    }
  }

  async function resolveOperatorWallet() {
    let wallets = await listWallets();
    let arcWallets = wallets.filter(
      (wallet) => wallet.blockchain.toUpperCase() === "ARC-TESTNET"
    );

    if (arcWallets.length === 0) {
      appendLog({
        tag: "WALLET",
        message: "No ARC-TESTNET wallet found. Initializing Circle wallet set now.",
        tone: "amber",
      });

      await initializeUser();
      wallets = await listWallets();
      arcWallets = wallets.filter(
        (wallet) => wallet.blockchain.toUpperCase() === "ARC-TESTNET"
      );
    }

    const preferredWalletId = walletIdInput.trim();
    const selectedWallet = preferredWalletId
      ? arcWallets.find((wallet) => wallet.id === preferredWalletId)
      : arcWallets[0];

    if (!selectedWallet) {
      throw new Error(
        preferredWalletId
          ? `Circle wallet ${preferredWalletId} was not found on ARC-TESTNET.`
          : "Circle did not return an ARC-TESTNET wallet."
      );
    }

    if (!isAddress(selectedWallet.address)) {
      throw new Error("Circle returned a wallet with an invalid EVM address.");
    }

    setWalletIdInput(selectedWallet.id);
    setWalletAddress(selectedWallet.address);

    return {
      address: selectedWallet.address as Address,
      id: selectedWallet.id,
      wallet: selectedWallet,
    };
  }

  async function handleSyncWallet() {
    try {
      ensureCircleSessionForExecution();
      const resolvedWallet = await resolveOperatorWallet();

      appendLog({
        tag: "WALLET",
        message: `Circle ARC wallet ${resolvedWallet.id} resolved at ${resolvedWallet.address}.`,
        tone: "cyan",
      });
    } catch (nextError) {
      appendLog({
        tag: "ERROR",
        message: normalizeError(nextError),
        tone: "amber",
      });
    }
  }

  async function handleExecute() {
    if (isRunning) {
      appendLog({
        tag: "LOCK",
        message: "A payroll cycle is already live. Wait for the Arc hash before re-triggering.",
        tone: "amber",
      });
      return;
    }

    const currentExecution = executionRef.current + 1;
    executionRef.current = currentExecution;
    setIsRunning(true);
    setLastTxHash(null);
    setSessionFeeLift(0n);

    appendLog({
      tag: "EXEC",
      message: "Operator command accepted. Building the payroll request from the live on-chain preview.",
      tone: "cyan",
    });

    try {
      if (!ready) {
        throw new Error("Circle Web SDK is still booting. Wait for the SDK ready indicator.");
      }
      if (!publicClient) {
        throw new Error("Arc public client is not ready.");
      }
      if (!payrollRouterAddress) {
        throw new Error("WizPayAgenticPro contract address is missing or invalid.");
      }

      ensureCircleSessionForExecution();

      const { address: operatorAddress, id: operatorWalletId } =
        await resolveOperatorWallet();
      const runSalt = `${Date.now().toString(36)}-${runCount + 1}`;
      const { agents, taskHashes } = buildBatchPayload(operatorAddress, runSalt);
      const desiredTreasuryAddress = displayedTreasuryAddress;

      activeExecutionRef.current = {
        executionId: currentExecution,
        expectedAgentCount: agents.length,
        observedTaskHashes: new Set(),
        payer: operatorAddress,
        seenEventKeys: new Set(),
        taskHashes: new Set(taskHashes),
        txHash: null,
      };

      appendLog({
        tag: "WALLET",
        message: `Circle ARC wallet ${operatorWalletId} locked at ${operatorAddress}.`,
        tone: "muted",
      });

      if (!desiredTreasuryAddress) {
        throw new Error(
          "Treasury route is missing. Load the deployed contract treasury or provide NEXT_PUBLIC_WIZPAY_TREASURY_ADDRESS as a fallback."
        );
      }

      if (!isAddress(desiredTreasuryAddress)) {
        throw new Error("The treasury route in the terminal is not a valid EVM address.");
      }

      appendLog({
        tag: "TREASURY",
        message: `Treasury route locked to ${desiredTreasuryAddress} for this payroll batch.`,
        tone: "cyan",
      });

      const [preview, allowance, operatorUsdcBalance] = await Promise.all([
        publicClient.readContract({
          address: payrollRouterAddress,
          abi: WIZPAY_AGENTIC_PRO_ABI,
          functionName: "previewBatchCost",
          args: [agents],
        }),
        publicClient.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [operatorAddress, payrollRouterAddress],
        }),
        publicClient.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [operatorAddress],
        }),
      ]);

      const [grossCharge, swapCount, treasuryFeeTotal] = preview;
      setLastGrossCharge(grossCharge);
      setLastSwapCount(swapCount);
      setLastTreasuryFeeQuote(treasuryFeeTotal);
      setWalletUsdcBalance(operatorUsdcBalance);

      appendLog({
        tag: "QUOTE",
        message:
          treasuryFeeTotal > 0n
            ? `On-chain preview requires ${formatAmount(grossCharge, usdcDecimals, 6, 6)} USDC with ${swapCount.toString()} routed FX leg(s) and ${formatAmount(treasuryFeeTotal, usdcDecimals, 6, 6)} USDC treasury fee.`
            : `On-chain preview requires ${formatAmount(grossCharge, usdcDecimals, 6, 6)} USDC with no extra FX treasury surcharge.`,
        tone: "cyan",
      });

      if (operatorUsdcBalance < grossCharge) {
        throw new Error(
          `Wallet USDC balance ${formatAmount(operatorUsdcBalance, usdcDecimals, 6, 6)} is below required ${formatAmount(grossCharge, usdcDecimals, 6, 6)}. The deployed WizPayAgenticPro is currently priced in units that do not match Arc USDC decimals, so sending a payroll challenge now would not be a real executable payroll.`
        );
      }

      if (allowance < grossCharge) {
        throw new Error(
          `USDC allowance ${formatAmount(allowance, usdcDecimals, 6, 6)} is below required ${formatAmount(grossCharge, usdcDecimals, 6, 6)}. One-signature mode assumes the Circle wallet has already approved ${shortenAddress(payrollRouterAddress)}.`
        );
      }

      const callData = encodeFunctionData({
        abi: WIZPAY_AGENTIC_PRO_ABI,
        functionName: "batchPayAgents",
        args: [agents, taskHashes, desiredTreasuryAddress as Address],
      });

      const challenge = await createContractExecutionChallenge({
        walletId: operatorWalletId,
        contractAddress: payrollRouterAddress,
        callData,
        feeLevel: "MEDIUM",
        memo: "WizPay global agentic payroll (50 tasks)",
        refId: `wizagent-payroll-${runSalt}`,
      });

      appendLog({
        tag: "CIRCLE",
        message: `Challenge ${challenge.challengeId.slice(0, 12)}... created. Awaiting Circle approval modal.`,
        tone: "muted",
      });

      const challengeResult = await executeChallenge(challenge.challengeId);
      const txHash = await resolveChallengeTxHash({
        challengeId: challenge.challengeId,
        initialResult: challengeResult,
        logContext: "Payroll batch",
        transactionId: challenge.transactionId,
      });

      activeExecutionRef.current.txHash = txHash;
      setLastTxHash(txHash);
      appendLog({
        tag: "SIGN",
        message: `Circle approval complete. Provider transaction hash confirmed: ${txHash}.`,
        tone: "cyan",
        href: `${ARCSCAN_BASE_URL}/tx/${txHash}`,
        hrefLabel: "Open ArcScan TX",
      });
      appendLog({
        tag: "CHAIN",
        message: "Watching WizPayAgenticPro.AgentPaid events from Arc in real time.",
        tone: "muted",
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status !== "success") {
        throw new Error(`Arc transaction ${txHash} was mined but marked as reverted.`);
      }

      const touchedAddresses = Array.from(
        new Set(receipt.logs.map((log) => log.address.toLowerCase()))
      );

      const agentPaidEvents = parseEventLogs({
        abi: WIZPAY_AGENTIC_PRO_ABI,
        eventName: "AgentPaid",
        logs: receipt.logs,
        strict: false,
      });

      const batchEvents = parseEventLogs({
        abi: WIZPAY_AGENTIC_PRO_ABI,
        eventName: "BatchPaymentExecuted",
        logs: receipt.logs,
        strict: false,
      });

      for (const eventLog of agentPaidEvents) {
        const { args } = eventLog;
        if (
          !args.taskHash ||
          !args.agent ||
          !args.settlementToken ||
          typeof args.settlementAmount !== "bigint" ||
          typeof args.treasuryFee !== "bigint"
        ) {
          continue;
        }

        recordAgentPaidEvent({
          agent: args.agent,
          logIndex: eventLog.logIndex,
          settlementAmount: args.settlementAmount,
          settlementToken: args.settlementToken,
          taskHash: args.taskHash,
          transactionHash: receipt.transactionHash,
          treasuryFee: args.treasuryFee,
        });
      }

      if (agentPaidEvents.length === 0) {
        throw new Error(
          `Arc transaction ${txHash} confirmed, but WizPayAgenticPro emitted no AgentPaid events. Receipt touched ${touchedAddresses.length > 0 ? touchedAddresses.join(", ") : "no contract logs"}.`
        );
      }

      if (agentPaidEvents.length !== agents.length) {
        throw new Error(
          `Arc transaction ${txHash} confirmed with ${agentPaidEvents.length}/${agents.length} AgentPaid events. Terminal output would be incomplete.`
        );
      }

      const batchSummary = batchEvents[0]?.args;

      appendLog({
        tag: "ARC",
        message: `Arc Testnet TX confirmed at block ${receipt.blockNumber.toString()}.`,
        tone: "cyan",
        href: `${ARCSCAN_BASE_URL}/tx/${txHash}`,
        hrefLabel: "Open ArcScan TX",
      });
      appendLog({
        tag: "GAS",
        message: "Gas Fee: $0.00 (ERC-4337 Sponsored)",
        tone: "cyan",
      });
      appendLog({
        tag: "DONE",
        message:
          batchSummary &&
          typeof batchSummary.agentCount === "bigint" &&
          typeof batchSummary.totalUsdcCharged === "bigint" &&
          typeof batchSummary.swapCount === "bigint" &&
          typeof batchSummary.treasuryFeeTotal === "bigint"
            ? `Global Agentic Payroll complete on-chain with ${batchSummary.agentCount.toString()} AgentPaid events, ${formatAmount(batchSummary.totalUsdcCharged, usdcDecimals, 6, 6)} USDC charged, and ${batchSummary.swapCount.toString()} FX swap leg(s).`
            : `Global Agentic Payroll complete on-chain with ${agentPaidEvents.length.toString()} AgentPaid events.`,
        tone: "matrix",
      });

      setRunCount((current) => current + 1);
      await refreshTreasuryBalance();
      activeExecutionRef.current = null;
    } catch (nextError) {
      activeExecutionRef.current = null;
      appendLog({
        tag: "ERROR",
        message: normalizeError(nextError),
        tone: "amber",
      });
    } finally {
      if (executionRef.current === currentExecution) {
        setIsRunning(false);
      }
    }
  }

  return (
    <main className="terminal-page">
      <section className="hero-panel">
        <div>
          <h1>Payroll</h1>
          <p className="hero-copy">Use the controls on the right, then run payroll.</p>
        </div>

        <div className="hero-status-row">
          <span className="system-chip is-live">{chainName}</span>
          <span className="system-chip">Chain ID {chainId}</span>
          <span className="system-chip">Circle SDK {ready ? "Ready" : "Booting"}</span>
          <span className="system-chip is-cold">Gas Fee: $0.00 (ERC-4337 Sponsored)</span>
        </div>
      </section>

      <section className="terminal-grid">
        <div className="terminal-main-column">
          <div className="division-grid">
            {divisions.map((division) => (
              <article className="division-card" key={division.id}>
                <p className="division-id">{division.id}</p>
                <h2>{division.name}</h2>
                <p>{division.description}</p>
                <span className="division-status">{division.status}</span>
              </article>
            ))}
          </div>

          <section className="window-card">
            <div className="window-bar">
              <div className="window-controls" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <p>agentic-payroll://live-stream</p>
              <span className="window-badge">REAL-TIME LOGS</span>
            </div>

            <div className="telemetry-grid">
              <article className="telemetry-card">
                <span>Payroll Router</span>
                <strong>{shortenAddress(contractAddress)}</strong>
                <code>{contractAddress}</code>
              </article>
              <article className="telemetry-card">
                <span>StableFXAdapter</span>
                <strong>{shortenAddress(stableFxAdapterAddress)}</strong>
                <code>{stableFxAdapterAddress}</code>
              </article>
              <article className="telemetry-card">
                <span>Primary RPC</span>
                <strong>{shortenAddress(rpcUrl)}</strong>
                <code>{rpcUrl}</code>
              </article>
            </div>

            <div className="terminal-window" ref={viewportRef}>
              {deferredLogs.map((entry) => (
                <div className={`terminal-line tone-${entry.tone}`} key={entry.id}>
                  <span className="terminal-tag">[{entry.tag}]</span>
                  <span className="terminal-message">
                    {entry.message}
                    {entry.href ? (
                      <>
                        {" "}
                        <a
                          className="terminal-link"
                          href={entry.href}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {entry.hrefLabel ?? "Open"}
                        </a>
                      </>
                    ) : null}
                  </span>
                </div>
              ))}

              <div className="terminal-line tone-muted">
                <span className="terminal-tag">[STATUS]</span>
                <span className="terminal-message">
                  {isRunning ? (
                    <>
                      payroll and Circle execution live{" "}
                      <span className="terminal-cursor" aria-hidden="true" />
                    </>
                  ) : (
                    status ?? "system idle"
                  )}
                </span>
              </div>
            </div>

            <div className="action-row">
              <div className="action-stack">
                <button
                  className="execute-button"
                  disabled={isRunning || !ready || !payrollRouterAddress}
                  onClick={() => {
                    void handleExecute();
                  }}
                  type="button"
                >
                  Execute Global Agentic Payroll (50 Tasks)
                </button>
                <p className="action-hint">
                  One payroll sweep submits 1 sponsored batch transaction that emits 50 AgentPaid events and 50+ transfer rows on the explorer.
                </p>
              </div>

              <div className="run-metrics" aria-live="polite">
                <span>Runs: {String(runCount).padStart(2, "0")}</span>
                <span>Agents per sweep: 50</span>
                <span>
                  Preview: {lastGrossCharge !== null ? `${formatAmount(lastGrossCharge, usdcDecimals, 2, 2)} USDC` : "pending"}
                </span>
                <span>{isRunning ? "State: Watching Chain" : "State: Armed"}</span>
              </div>
            </div>
          </section>

          <section className="window-card agent-economy-card">
            <div className="window-bar agent-economy-bar">
              <div className="window-controls" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <p>agent-economy://50-separate-txs</p>
              <span className="window-badge is-amber">INDIVIDUAL RECEIPTS</span>
            </div>

            <div className="agent-economy-body">
              <div className="agent-economy-launch-row">
                <div className="agent-economy-copy">
                  <p className="intel-label">Agent Economy</p>
                  <h2>50 independent task transactions</h2>
                  <p className="agent-economy-hint">
                    This lane does not reuse the batch payroll sweep. It fires 50
                    separate <code>batchPayAgents([wallet], [taskHash], treasury)</code>{" "}
                    calls and reveals every tx hash as it lands.
                  </p>
                </div>

                <div className="agent-economy-actions">
                  <button
                    className="agent-economy-button"
                    disabled={isAgentEconomyRunning}
                    onClick={() => {
                      void handleRunAgentEconomy();
                    }}
                    type="button"
                  >
                    {isAgentEconomyRunning
                      ? "Running Agent Economy..."
                      : "RUN AGENT ECONOMY (50 TASKS)"}
                  </button>
                  <p className="agent-economy-button-hint">
                    One task equals one on-chain transaction, with a 1-second hold
                    between task sends.
                  </p>
                </div>
              </div>

              <div className="agent-economy-metrics" aria-live="polite">
                <span>Mode: 50 separate txs</span>
                <span>
                  Confirmed: {agentEconomyResults.length}/{agentEconomyTotal}
                </span>
                <span>
                  Signer:{" "}
                  {agentEconomyDebug.signer
                    ? shortenAddress(agentEconomyDebug.signer)
                    : "pending"}
                </span>
                <span>
                  Allowance: {agentEconomyDebug.allowance ?? "pending"}
                </span>
                <span>
                  Last TX:{" "}
                  {lastAgentEconomyResult
                    ? shortenHex(lastAgentEconomyResult.txHash)
                    : "awaiting first receipt"}
                </span>
              </div>

              <div className="agent-economy-stream-shell">
                <div
                  className="agent-economy-stream"
                  ref={agentEconomyViewportRef}
                >
                  {agentEconomyResults.length > 0 ? (
                    agentEconomyResults.map((result, index) => (
                      <article className="agent-economy-row" key={result.txHash}>
                        <span className="agent-economy-index">
                          #{String(index + 1).padStart(2, "0")}
                        </span>
                        <div className="agent-economy-result-copy">
                          <strong>{result.taskId}</strong>
                          <code>{result.txHash}</code>
                        </div>
                        <a
                          className="terminal-link"
                          href={result.href}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open ArcScan TX
                        </a>
                      </article>
                    ))
                  ) : (
                    <div className="agent-economy-empty">
                      <p>No task receipts yet.</p>
                      <span>
                        Batch payroll still shows one hash. This stream will fill with
                        50 separate explorer links.
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <p
                className={`agent-economy-status-copy ${
                  agentEconomyError ? "is-error" : ""
                }`}
              >
                {agentEconomyError ?? agentEconomyStatus}
              </p>
            </div>
          </section>
        </div>

        <aside className="terminal-sidebar">
          <section className="ops-card">
            <p className="intel-label">Circle Access</p>
            <p className="ops-copy">
              Fill in the Circle fields here, then run every step with the buttons. No terminal commands are required.
            </p>
            <ol className="ops-steps">
              <li>
                Open <a className="terminal-link" href="https://app.wizpay.xyz" rel="noreferrer" target="_blank">app.wizpay.xyz</a>.
              </li>
              <li>Sign in with Google only.</li>
              <li>Complete the email OTP verification until login succeeds.</li>
              <li>Do not use other login methods because Circle session retrieval will fail.</li>
              <li>After login, copy Dev Credential, then paste them into this form.</li>
            </ol>

            <div className="ops-security-row">
              <p>
                Smart Paste and Store Session now hide the Circle credentials automatically.
              </p>
              <button
                className="subtle-button ops-security-button"
                disabled={!hasCredentialInputs}
                onClick={() => setAreCredentialsConcealed((current) => !current)}
                type="button"
              >
                {areCredentialsConcealed ? "Reveal Credentials" : "Hide Credentials"}
              </button>
            </div>

            <div className="ops-field-grid">
              <label
                className={`terminal-field terminal-field--full ${
                  isInjectionGlowActive ? "is-injected" : ""
                }`}
              >
                <span>User Token</span>
                <textarea
                  onChange={(event) => setUserTokenInput(event.target.value.trim())}
                  placeholder="Paste userToken from app.wizpay.xyz"
                  readOnly={areCredentialsConcealed}
                  rows={3}
                  spellCheck={false}
                  value={areCredentialsConcealed ? maskSecret(userTokenInput) : userTokenInput}
                />
              </label>
              <label
                className={`terminal-field terminal-field--full ${
                  isInjectionGlowActive ? "is-injected" : ""
                }`}
              >
                <span>Encryption Key</span>
                <textarea
                  onChange={(event) => setEncryptionKeyInput(event.target.value.trim())}
                  placeholder="Paste encryptionKey from app.wizpay.xyz"
                  readOnly={areCredentialsConcealed}
                  rows={3}
                  spellCheck={false}
                  value={
                    areCredentialsConcealed
                      ? maskSecret(encryptionKeyInput)
                      : encryptionKeyInput
                  }
                />
              </label>
              <label
                className={`terminal-field terminal-field--full ${
                  isInjectionGlowActive ? "is-injected" : ""
                }`}
              >
                <span>Wallet ID</span>
                <input
                  onChange={(event) => setWalletIdInput(event.target.value.trim())}
                  placeholder="Optional: paste Circle ARC wallet ID"
                  value={walletIdInput}
                />
              </label>
              <label
                className={`terminal-field terminal-field--full ${
                  isInjectionGlowActive ? "is-injected" : ""
                }`}
              >
                <span>Treasury Route</span>
                <input
                  disabled={!CUSTOM_TREASURY_ROUTE_ENABLED}
                  onChange={(event) => setTreasuryAddress(event.target.value.trim())}
                  placeholder={
                    CUSTOM_TREASURY_ROUTE_ENABLED
                      ? "Optional: paste treasury override address"
                      : "Contract treasury route is locked for this deployment"
                  }
                  value={CUSTOM_TREASURY_ROUTE_ENABLED ? treasuryAddress : displayedTreasuryAddress}
                />
              </label>
            </div>

            <div className="ops-actions">
              <button
                className="security-step-button"
                disabled={isApprovingAllowance}
                onClick={() => {
                  void handleApprovePayrollAllowance();
                }}
                type="button"
              >
                {isApprovingAllowance
                  ? "[Enabling Payroll...]"
                  : "[Enable Payroll (Approve USDC)]"}
              </button>
              <button
                className="smart-paste-button"
                disabled={isSmartPasting}
                onClick={() => {
                  void handleSmartPaste();
                }}
                type="button"
              >
                {isSmartPasting ? "Injecting Payload..." : "Smart Paste from WizPay"}
              </button>
              <button onClick={handleSaveSession} type="button">
                Store Session
              </button>
              <button
                className="subtle-button"
                onClick={() => {
                  void handleSyncWallet();
                }}
                type="button"
              >
                Sync ARC Wallet
              </button>
              <button
                className="subtle-button"
                onClick={() => {
                  handleClearSession();
                }}
                type="button"
              >
                Clear Session
              </button>
            </div>

            <div className="status-strip">
              <span>SDK: {ready ? "ready" : "booting"}</span>
              <span>Wallet: {walletAddress ? shortenAddress(walletAddress) : "not linked"}</span>
              <span>
                Treasury: {displayedTreasuryAddress ? shortenAddress(displayedTreasuryAddress) : "contract route unknown"}
              </span>
              <span>
                Charge: {lastGrossCharge ? `${formatAmount(lastGrossCharge, usdcDecimals, 6, 6)} USDC` : "pending"}
              </span>
              <span>
                Wallet USDC: {walletUsdcBalance !== null ? formatAmount(walletUsdcBalance, usdcDecimals, 6, 6) : "pending"}
              </span>
            </div>

            <p className={`status-copy ${error ? "is-error" : ""}`}>
              {error ?? status ?? "Circle operator console idle."}
            </p>
          </section>

          <section className="treasury-card">
            <p className="treasury-label">Treasury-Bot (LP Agent)</p>
            <h2>
              {treasuryBalance !== null
                ? `${formatAmount(treasuryBalance, usdcDecimals, 6, 6)} USDC`
                : "Loading real balance..."}
            </h2>
            <p className="treasury-copy">
              Live USDC balance for the active contract treasury route on Arc Testnet.
            </p>
            <code className="treasury-route-copy">
              {displayedTreasuryAddress || "Awaiting treasury route..."}
            </code>

            <div className="treasury-metrics">
              <div>
                <span>LP Fee</span>
                <strong>
                  {lastSwapCount > 0n
                    ? `${formatAmount(lastTreasuryFeeQuote, usdcDecimals, 6, 6)} USDC this run`
                    : "0.300% on EURC swaps"}
                </strong>
              </div>
              <div>
                <span>Settlement Mode</span>
                <strong>{lastSwapCount > 0n ? "USDC + EURC this run" : "USDC only this run"}</strong>
              </div>
              <div>
                <span>Bundler Cost</span>
                <strong>$0.00 sponsored</strong>
              </div>
              <div>
                <span>Session Fee Lift</span>
                <strong>
                  {sessionFeeLift > 0n
                    ? `+${formatAmount(sessionFeeLift, usdcDecimals, 6, 6)} USDC`
                    : "No treasury fees captured yet"}
                </strong>
              </div>
            </div>
          </section>

          <section className="intel-card">
            <p className="intel-label">Ops Snapshot</p>
            <ul>
              <li>Three AI divisions online.</li>
              <li>One Circle signature dispatches the full 50-task payroll call.</li>
              <li>Agentic logs are emitted only from on-chain AgentPaid events.</li>
              <li>Gas Fee: $0.00 (ERC-4337 Sponsored).</li>
              <li>Contract anchor: {shortenAddress(contractAddress)}</li>
              <li>Wallet anchor: {walletAddress ? shortenAddress(walletAddress) : "waiting for Circle wallet"}</li>
            </ul>

            {explorerLink ? (
              <a className="terminal-link last-hash-link" href={explorerLink} rel="noreferrer" target="_blank">
                Last Arc TX: {shortenAddress(lastTxHash ?? "")}
              </a>
            ) : null}
          </section>
        </aside>
      </section>
    </main>
  );
}
