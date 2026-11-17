#!/usr/bin/env node
// Testnet end-to-end test for the x402 demo (Ethereum Sepolia).
//
// Starts Facilitator, Resource Server and Agent Wallet from the sibling repos on spare ports,
// drives the full 402 -> sign -> pay -> settle flow plus the abuse cases, and checks the
// results on-chain. See README.md for prerequisites.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const RPC_URL = process.env.ETHEREUM_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const ASSET = "0x025311Ca250150E9c3684b614566c9f187a47e16"; // DemoCoin, coin-contract/README.md
const PORTS = { facilitator: 4101, resourceServer: 4102, agentWallet: 4103 };
const AGENT_ID = "e2e-agent";
const QUOTE_PRICE = 10_000n; // /securities/quotes price in raw units (0.01 DEMO)
const MIN_AGENT_BALANCE = 100_000n; // top up below 0.1 DEMO
const TOP_UP_AMOUNT = 1_000_000n; // 1 DEMO
const SETTLE_TIMEOUT_MS = 180_000;

const RS = `http://localhost:${PORTS.resourceServer}`;
const AW = `http://localhost:${PORTS.agentWallet}`;
const FAC = `http://localhost:${PORTS.facilitator}`;
const QUOTE_URL = `${RS}/securities/quotes/005930`;

// ------------------------------------------------------------------ helpers

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function readEnvFile(file) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result;
}

async function tokenBalance(address) {
  const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  return BigInt(await rpc("eth_call", [{ to: ASSET, data }, "latest"]));
}

const ethBalance = async (address) => BigInt(await rpc("eth_getBalance", [address, "latest"]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

// ------------------------------------------------------------------ servers

const children = [];
const logs = { facilitator: [], resourceServer: [], agentWallet: [] };

function start(name, repo, env) {
  const logDir = path.join(HERE, "logs");
  mkdirSync(logDir, { recursive: true });
  const out = createWriteStream(path.join(logDir, `${name}.log`));
  const tsx = path.join(ROOT, repo, "node_modules", ".bin", "tsx");
  const child = spawn(tsx, ["--env-file-if-exists=.env", "src/index.ts"], {
    cwd: path.join(ROOT, repo),
    env: { ...process.env, ...env },
    detached: true, // own process group, so the whole tree can be stopped
  });
  let buf = "";
  const onData = (chunk) => {
    out.write(chunk);
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        logs[name].push(JSON.parse(line));
      } catch {
        // non-JSON output (e.g. npm notices)
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  children.push(child);
}

function stopAll() {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already exited
    }
  }
}
process.on("exit", stopAll);
process.on("SIGINT", () => process.exit(130));

async function waitHealthy() {
  const deadline = Date.now() + 30_000;
  for (const url of [FAC, RS, AW]) {
    while (true) {
      try {
        if ((await fetch(`${url}/health`)).ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`${url} did not become healthy`);
      await sleep(300);
    }
  }
}

// ------------------------------------------------------------------ agent setup

async function ensureAgent() {
  const res = await json("POST", `${AW}/wallets`, { agentId: AGENT_ID, keyStoreProvider: "local" });
  if (res.status === 200) return res.data.address;
  if (res.status === 409) {
    const stored = JSON.parse(readFileSync(path.join(HERE, ".keystore", `${AGENT_ID}.json`), "utf8"));
    return stored.address;
  }
  throw new Error(`create wallet failed: ${res.status} ${JSON.stringify(res.data)}`);
}

function topUp(agent) {
  const coinEnv = readEnvFile(path.join(ROOT, "coin-contract", ".env"));
  if (!coinEnv.DEPLOYER_PRIVATE_KEY) {
    throw new Error("agent needs DEMO but coin-contract/.env has no DEPLOYER_PRIVATE_KEY to top up from");
  }
  const cast = existsSync(path.join(process.env.HOME, ".foundry/bin/cast"))
    ? path.join(process.env.HOME, ".foundry/bin/cast")
    : "cast";
  execFileSync(
    cast,
    ["send", ASSET, "transfer(address,uint256)", agent, TOP_UP_AMOUNT.toString(),
      "--rpc-url", RPC_URL, "--private-key", coinEnv.DEPLOYER_PRIVATE_KEY],
    { stdio: "ignore" },
  );
}

async function signPayment(resource, requirements) {
  return json("POST", `${AW}/sign-payment`, { agentId: AGENT_ID, resource, requirements });
}

async function payAndSign(url) {
  const unpaid = await json("GET", url);
  const signed = await signPayment(url, unpaid.data.requirements);
  if (signed.status !== 200) throw new Error(`sign-payment failed: ${JSON.stringify(signed.data)}`);
  return { requirements: unpaid.data.requirements, ...signed.data };
}

// ------------------------------------------------------------------ main

async function main() {
  const facEnv = readEnvFile(path.join(ROOT, "facilitator", ".env"));
  if (!facEnv.FACILITATOR_PRIVATE_KEY && !process.env.FACILITATOR_PRIVATE_KEY) {
    throw new Error("facilitator/.env must define FACILITATOR_PRIVATE_KEY (see facilitator/.env.example)");
  }

  console.log("Starting servers...");
  start("facilitator", "facilitator", { PORT: String(PORTS.facilitator), ETHEREUM_RPC_URL: RPC_URL });
  start("resourceServer", "resourceServer", {
    PORT: String(PORTS.resourceServer),
    FACILITATOR_URL: FAC,
    ASSET_ADDRESS: ASSET,
  });
  start("agentWallet", "agentWallet", {
    PORT: String(PORTS.agentWallet),
    KEYSTORE_DIR: path.join(HERE, ".keystore"),
  });
  await waitHealthy();

  const settler = logs.facilitator.find((l) => l.settler)?.settler;
  if (!settler) throw new Error("facilitator did not report a settler address");
  console.log(`  facilitator settler: ${settler}`);

  const agent = await ensureAgent();
  console.log(`  agent wallet:        ${agent}`);
  if ((await tokenBalance(agent)) < MIN_AGENT_BALANCE) {
    console.log("  topping up agent with 1 DEMO from the token owner...");
    topUp(agent);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const delegation = await json("POST", `${AW}/delegations`, {
    agentId: AGENT_ID,
    allowedResources: [`${RS}/securities/*`],
    maxAmountPerTx: "100000",
    maxAmountPerWindow: "500000",
    windowSeconds: 3600,
    allowedChains: ["ethereum"],
    expiresAt,
    nonce: `e2e-${Date.now()}`,
  });
  if (delegation.status !== 200) throw new Error(`delegation failed: ${JSON.stringify(delegation.data)}`);

  const supported = await json("GET", `${FAC}/supported`);
  const payTo = (await json("GET", QUOTE_URL)).data.requirements.payTo;
  const agentBefore = await tokenBalance(agent);
  const payToBefore = await tokenBalance(payTo);

  console.log("\nScenarios");

  check(
    "facilitator /supported lists DemoCoin on ethereum",
    supported.data.kinds.some((k) => k.network === "ethereum" && k.asset.toLowerCase() === ASSET.toLowerCase()),
  );

  const unpaid = await json("GET", QUOTE_URL);
  check("unpaid request -> 402 with requirements", unpaid.status === 402 && unpaid.data.requirements?.amount === QUOTE_PRICE.toString());

  const p1 = await payAndSign(QUOTE_URL);
  const paid = await json("GET", QUOTE_URL, undefined, { "x-payment": p1.xPayment });
  check("paid request -> 200 with data", paid.status === 200 && paid.data.price != null, `HTTP ${paid.status}`);

  const replay = await json("GET", QUOTE_URL, undefined, { "x-payment": p1.xPayment });
  check("replaying the same X-PAYMENT -> 402", replay.status === 402, replay.data?.error);

  const p2 = await payAndSign(QUOTE_URL);
  const burst = await Promise.all(
    Array.from({ length: 5 }, () => json("GET", QUOTE_URL, undefined, { "x-payment": p2.xPayment })),
  );
  const ok = burst.filter((r) => r.status === 200).length;
  check("5 concurrent uses of one payment -> exactly one 200", ok === 1, burst.map((r) => r.status).join(" "));

  const p3 = await payAndSign(QUOTE_URL);
  const sig = p3.paymentPayload.payload.signature;
  const tampered = structuredClone(p3.paymentPayload);
  tampered.payload.signature = sig.slice(0, 10) + (sig[10] === "0" ? "1" : "0") + sig.slice(11);
  const bad = await json("GET", QUOTE_URL, undefined, {
    "x-payment": Buffer.from(JSON.stringify(tampered)).toString("base64"),
  });
  check("tampered signature -> 402", bad.status === 402, bad.data?.error);

  const order = await json("POST", `${RS}/securities/orders`, { symbol: "005930", side: "buy", quantity: 1 });
  const overLimit = await signPayment(`${RS}/securities/orders`, order.data.requirements);
  check("payment over delegation maxAmountPerTx -> wallet refuses (403)", overLimit.status === 403, overLimit.data?.error);

  const outOfScope = await signPayment(`${RS}/shop/orders`, unpaid.data.requirements);
  check("resource outside delegation scope -> wallet refuses (403)", outOfScope.status === 403, outOfScope.data?.error);

  console.log("\nWaiting for on-chain settlement (2 payments)...");
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let settled = [];
  let settleErrors = [];
  while (Date.now() < deadline) {
    settled = logs.resourceServer.filter((l) => l.msg === "payment settled").map((l) => l.txHash);
    settleErrors = logs.resourceServer.filter((l) => l.msg?.startsWith("payment settlement failed") || l.msg === "settle call failed");
    if (settled.length + settleErrors.length >= 2) break;
    await sleep(2000);
  }
  check("exactly 2 settlements, no settlement errors", settled.length === 2 && settleErrors.length === 0,
    `${settled.length} settled, ${settleErrors.length} failed`);

  for (const hash of settled) {
    const [receipt, tx] = await Promise.all([
      rpc("eth_getTransactionReceipt", [hash]),
      rpc("eth_getTransactionByHash", [hash]),
    ]);
    check(
      `tx ${hash.slice(0, 10)}… succeeded, sent by settler to DemoCoin`,
      receipt?.status === "0x1" &&
        tx.from.toLowerCase() === settler.toLowerCase() &&
        tx.to.toLowerCase() === ASSET.toLowerCase(),
    );
  }

  const agentAfter = await tokenBalance(agent);
  const payToAfter = await tokenBalance(payTo);
  check("agent paid exactly 2 x 0.01 DEMO", agentBefore - agentAfter === 2n * QUOTE_PRICE, `${agentBefore - agentAfter}`);
  check("payTo received exactly 2 x 0.01 DEMO", payToAfter - payToBefore === 2n * QUOTE_PRICE, `${payToAfter - payToBefore}`);
  check("agent holds no ETH (gasless payments)", (await ethBalance(agent)) === 0n);

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}  (server logs in e2e/logs/)`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\nERROR: ${err.message}  (server logs in e2e/logs/)`);
    process.exit(1);
  });
