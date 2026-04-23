"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";

const CIRCLE_APP_ID = process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? "";
const SESSION_STORAGE_KEY = "wizagent.circle.session";

export type CircleWallet = {
  id: string;
  address: string;
  blockchain: string;
  accountType?: string;
  [key: string]: unknown;
};

export type CircleSession = {
  encryptionKey: string;
  userToken: string;
};

export type CircleChallengeHandle = {
  challengeId: string;
  raw: Record<string, unknown>;
  transactionId: string | null;
};

export type CircleChallengeTransactionStatus = {
  attemptedPaths?: string[];
  challengeId: string;
  raw?: Record<string, unknown>;
  status: string | null;
  transactionId: string | null;
  txHash: string | null;
};

type CircleWalletBalance = {
  amount: string;
  [key: string]: unknown;
};

type W3SSdkInstance = {
  execute: (
    challengeId: string,
    callback: (error?: unknown, result?: unknown) => void
  ) => void;
  getDeviceId: () => Promise<string>;
  setAuthentication: (auth: CircleSession) => void;
};

type W3SSdkModule = {
  W3SSdk?: new (
    config: Record<string, unknown>,
    onLoginComplete: (error: unknown, result: unknown) => void
  ) => W3SSdkInstance;
};

type ContractExecutionPayload = {
  walletId: string;
  contractAddress: Address;
  callData: Hex;
  feeLevel?: "LOW" | "MEDIUM" | "HIGH";
  memo?: string;
  refId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStoredSession() {
  if (typeof window === "undefined") {
    return null;
  }

  const rawValue = window.sessionStorage.getItem(SESSION_STORAGE_KEY);

  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue) as CircleSession;
  } catch {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

function writeStoredSession(session: CircleSession | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (!session) {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
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

function extractChallengeId(payload: unknown) {
  return (
    getNestedString(payload, ["challengeId"]) ??
    getNestedString(payload, ["challenge", "id"]) ??
    getNestedString(payload, ["challenge", "challengeId"]) ??
    getNestedString(payload, ["data", "challengeId"]) ??
    getNestedString(payload, ["data", "challenge", "id"])
  );
}

function extractTransactionId(payload: unknown) {
  return (
    getNestedString(payload, ["transactionId"]) ??
    getNestedString(payload, ["data", "transactionId"]) ??
    getNestedString(payload, ["transaction", "id"]) ??
    getNestedString(payload, ["transaction", "transactionId"]) ??
    getNestedString(payload, ["challenge", "transactionId"]) ??
    getNestedString(payload, ["challenge", "transaction", "id"]) ??
    getNestedString(payload, ["challenge", "transaction", "transactionId"])
  );
}

async function readResponsePayload(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as unknown;

  if (!response.ok) {
    const message =
      (isRecord(payload) && typeof payload.error === "string" && payload.error) ||
      `Circle request failed with status ${response.status}.`;

    throw new Error(message);
  }

  return payload;
}

export function useCircleW3S() {
  const sdkRef = useRef<W3SSdkInstance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [session, setSessionState] = useState<CircleSession | null>(() =>
    readStoredSession()
  );
  const sessionRef = useRef<CircleSession | null>(session);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    let cancelled = false;

    async function initializeSdk() {
      if (!cancelled) {
        setReady(false);
        setStatus("Booting Circle Web SDK...");
        setError(null);
      }

      try {
        if (!CIRCLE_APP_ID) {
          throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID is missing.");
        }

        const sdkModule = (await import(
          "@circle-fin/w3s-pw-web-sdk"
        )) as unknown as W3SSdkModule;

        if (!sdkModule.W3SSdk) {
          throw new Error("Circle Web SDK did not expose W3SSdk.");
        }

        const sdk = new sdkModule.W3SSdk(
          {
            appSettings: {
              appId: CIRCLE_APP_ID,
            },
          },
          () => {
            // This scaffold keeps auth manual on purpose.
          }
        );

        sdkRef.current = sdk;

        if (session) {
          sdk.setAuthentication(session);
        }

        if (!cancelled) {
          setReady(true);
          setStatus("Circle Web SDK ready.");
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setReady(false);
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Failed to initialize Circle Web SDK."
          );
        }
      }
    }

    void initializeSdk();

    return () => {
      cancelled = true;
      sdkRef.current = null;
    };
  }, [session]);

  const setSession = useCallback((nextSession: CircleSession) => {
    sessionRef.current = nextSession;
    writeStoredSession(nextSession);
    setSessionState(nextSession);
    setError(null);
    setStatus("Circle session stored for this browser tab.");

    sdkRef.current?.setAuthentication(nextSession);
  }, []);

  const clearSession = useCallback(() => {
    sessionRef.current = null;
    writeStoredSession(null);
    setSessionState(null);
    setError(null);
    setStatus("Circle session cleared from this browser tab.");
  }, []);

  const ensureSession = useCallback(() => {
    const currentSession = sessionRef.current;

    if (!currentSession?.userToken || !currentSession.encryptionKey) {
      throw new Error(
        "Set a Circle userToken and encryptionKey before calling W3S actions."
      );
    }

    return currentSession;
  }, []);

  const postW3sAction = useCallback(async <T,>(
    action: string,
    params: Record<string, unknown>
  ): Promise<T> => {
    setError(null);

    const response = await fetch("/api/w3s", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action,
        ...params,
      }),
    });

    return (await readResponsePayload(response)) as T;
  }, []);

  const getDeviceId = useCallback(async () => {
    const sdk = sdkRef.current;

    if (!sdk) {
      throw new Error("Circle Web SDK is not ready yet.");
    }

    const deviceId = await sdk.getDeviceId();
    setStatus("Circle device ID resolved.");
    return deviceId;
  }, []);

  const initializeUser = useCallback(async () => {
    const currentSession = ensureSession();
    setStatus("Initializing Circle wallet set on ARC-TESTNET...");

    const payload = await postW3sAction<Record<string, unknown>>(
      "initializeUser",
      {
        userToken: currentSession.userToken,
      }
    );

    setStatus("Circle user initialization request completed.");
    return payload;
  }, [ensureSession, postW3sAction]);

  const listWallets = useCallback(async () => {
    const currentSession = ensureSession();
    setStatus("Loading Circle wallets...");

    const payload = await postW3sAction<{ wallets?: CircleWallet[] }>(
      "listWallets",
      {
        userToken: currentSession.userToken,
      }
    );

    const wallets = Array.isArray(payload.wallets) ? payload.wallets : [];
    setStatus(`Loaded ${wallets.length} Circle wallet(s).`);
    return wallets;
  }, [ensureSession, postW3sAction]);

  const getWalletBalances = useCallback(
    async (walletId: string) => {
      const currentSession = ensureSession();

      if (!walletId) {
        throw new Error("walletId is required.");
      }

      setStatus(`Loading balances for wallet ${walletId}...`);

      const payload = await postW3sAction<{
        tokenBalances?: CircleWalletBalance[];
      }>("getWalletBalances", {
        userToken: currentSession.userToken,
        walletId,
      });

      const balances = Array.isArray(payload.tokenBalances)
        ? payload.tokenBalances
        : [];

      setStatus(`Loaded ${balances.length} balance row(s).`);
      return balances;
    },
    [ensureSession, postW3sAction]
  );

  const createContractExecutionChallenge = useCallback(
    async (payload: ContractExecutionPayload): Promise<CircleChallengeHandle> => {
      const currentSession = ensureSession();
      setStatus("Creating Circle contract execution challenge...");

      const response = await postW3sAction<Record<string, unknown>>(
        "createContractExecutionChallenge",
        {
          userToken: currentSession.userToken,
          payload,
        }
      );

      const challengeId = extractChallengeId(response);

      if (!challengeId) {
        throw new Error("Circle did not return a challengeId.");
      }

      setStatus(`Challenge ${challengeId} created.`);

      return {
        challengeId,
        raw: response,
        transactionId: extractTransactionId(response),
      };
    },
    [ensureSession, postW3sAction]
  );

  const executeChallenge = useCallback(
    async (challengeId: string) => {
      const currentSession = ensureSession();
      const sdk = sdkRef.current;

      if (!sdk) {
        throw new Error("Circle Web SDK is not ready yet.");
      }

      sdk.setAuthentication(currentSession);
      setStatus(`Executing challenge ${challengeId}...`);

      const result = await new Promise<unknown>((resolve, reject) => {
        sdk.execute(challengeId, (nextError, response) => {
          if (nextError) {
            reject(
              nextError instanceof Error
                ? nextError
                : new Error("Circle challenge execution failed.")
            );
            return;
          }

          resolve(response);
        });
      });

      setStatus(`Challenge ${challengeId} executed.`);
      return result;
    },
    [ensureSession]
  );

  const getChallengeTransactionStatus = useCallback(
    async (challengeId: string, transactionId?: string | null) => {
      const currentSession = ensureSession();

      if (!challengeId) {
        throw new Error("challengeId is required.");
      }

      setStatus(`Checking Circle transaction status for ${challengeId}...`);

      const payload = await postW3sAction<CircleChallengeTransactionStatus>(
        "getChallengeTransactionStatus",
        {
          challengeId,
          transactionId,
          userToken: currentSession.userToken,
        }
      );

      setStatus(
        payload.txHash
          ? `Circle transaction hash resolved for ${challengeId}.`
          : `Challenge ${challengeId} executed; waiting for Circle transaction hash.`
      );

      return payload;
    },
    [ensureSession, postW3sAction]
  );

  return {
    clearSession,
    createContractExecutionChallenge,
    error,
    executeChallenge,
    getChallengeTransactionStatus,
    getDeviceId,
    getWalletBalances,
    initializeUser,
    listWallets,
    ready,
    session,
    setSession,
    status,
  };
}
