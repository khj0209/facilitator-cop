#!/usr/bin/env node
// Demo page server for the x402 demo.
//
// Starts Facilitator, Resource Server and Agent Wallet from the sibling repos, serves the demo
// page, and proxies the browser's calls to them (the services don't send CORS headers). Also
// answers the chain questions the page needs: balances and which tx settled a given payment.

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const UI_PORT = Number(process.env.PORT ?? 4000);
const PORTS = { facilitator: 4001, resourceServer: 4002, agentWallet: 4003 };
const RPC_URL = process.env.ETHEREUM_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const ASSET = "0x025311Ca250150E9c3684b614566c9f187a47e16"; // DemoCoin, coin-contract/README.md
const EXPLORER = "https://sepolia.etherscan.io";
const AGENT_ID = "demo-agent";
const TOP_UP_AMOUNT = "1000000"; // 1 DEMO
// keccak256("AuthorizationUsed(address,bytes32)"), emitted by DemoCoin on every EIP-3009 transfer
const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

const SERVICE_URL = {
  rs: `http://localhost:${PORTS.resourceServer}`,
  aw: `http://localhost:${PORTS.agentWallet}`,
  fac: `http://localhost:${PORTS.facilitator}`,
};

// ------------------------------------------------------------------ helpers

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

const pad32 = (hex) => "0x" + hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

async function tokenBalance(address) {
  const data = "0x70a08231" + pad32(address).slice(2);
  return BigInt(await rpc("eth_call", [{ to: ASSET, data }, "latest"])).toString();
}

const ethBalance = async (address) => BigInt(await rpc("eth_getBalance", [address, "latest"])).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ services

const children = [];
let settlerAddress = null;
// Settlement failures reported in the Resource Server log, keyed by payer:nonce, so the page
// can show the reason instead of waiting for a transaction that will never come.
const settlementFailures = new Map();
const paymentKey = (from, nonce) => `${from.toLowerCase()}:${nonce.toLowerCase()}`;

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
        const entry = JSON.parse(line);
        if (entry.settler) settlerAddress = entry.settler;
        if (entry.msg === "payment settlement failed" && entry.payer && entry.nonce) {
          settlementFailures.set(paymentKey(entry.payer, entry.nonce), entry.reason ?? "unknown");
        }
      } catch {
        // non-JSON output
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    if (!shuttingDown) console.error(`${name} exited (code ${code}), see demo-ui/logs/${name}.log`);
  });
  children.push(child);
}

let shuttingDown = false;
function stopAll() {
  shuttingDown = true;
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
process.on("SIGTERM", () => process.exit(143));

async function assertPortsFree() {
  for (const [name, port] of Object.entries({ ...PORTS, ui: UI_PORT })) {
    try {
      await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(500) });
      throw new Error(`port ${port} (${name}) is already in use; stop that process first`);
    } catch (err) {
      if (err.message.startsWith("port")) throw err;
    }
  }
}

async function waitHealthy() {
  const deadline = Date.now() + 30_000;
  for (const url of Object.values(SERVICE_URL)) {
    while (true) {
      try {
        if ((await fetch(`${url}/health`)).ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`${url} did not become healthy (see demo-ui/logs/)`);
      await sleep(300);
    }
  }
}

// ------------------------------------------------------------------ demo state

let agentAddress = null;
let payTo = null;
let delegation = null; // { id, policy }

async function ensureAgent() {
  const res = await fetch(`${SERVICE_URL.aw}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: AGENT_ID, keyStoreProvider: "local" }),
  });
  if (res.ok) return (await res.json()).address;
  if (res.status === 409) {
    return JSON.parse(readFileSync(path.join(HERE, ".keystore", `${AGENT_ID}.json`), "utf8")).address;
  }
  throw new Error(`create wallet failed: ${res.status} ${await res.text()}`);
}

async function revokeDelegation() {
  if (!delegation) return;
  await fetch(`${SERVICE_URL.aw}/delegations/${delegation.id}`, { method: "DELETE" });
  delegation = null;
}

// The Agent Wallet uses the first active policy it finds for an agent, so the previous one is
// revoked before a replacement is issued.
async function setDelegation(input) {
  await revokeDelegation();
  const policy = {
    agentId: AGENT_ID,
    allowedResources: input.allowedResources,
    maxAmountPerTx: String(input.maxAmountPerTx),
    maxAmountPerWindow: String(input.maxAmountPerWindow),
    windowSeconds: Number(input.windowSeconds),
    allowedChains: ["ethereum"],
    expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
    nonce: `demo-${Date.now()}`,
  };
  const res = await fetch(`${SERVICE_URL.aw}/delegations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(policy),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `delegation failed (${res.status})`);
  delegation = { id: body.id, policy };
  return delegation;
}

async function state() {
  const [agentDemo, agentEth, payToDemo, settlerEth, block] = await Promise.all([
    tokenBalance(agentAddress),
    ethBalance(agentAddress),
    tokenBalance(payTo),
    settlerAddress ? ethBalance(settlerAddress) : null,
    rpc("eth_blockNumber", []),
  ]);
  return {
    network: "ethereum (Sepolia)",
    explorer: EXPLORER,
    asset: ASSET,
    resourceServerUrl: SERVICE_URL.rs,
    agent: { id: AGENT_ID, address: agentAddress, demo: agentDemo, eth: agentEth },
    payTo: { address: payTo, demo: payToDemo },
    settler: { address: settlerAddress, eth: settlerEth },
    delegation,
    block: parseInt(block, 16),
  };
}

function topUp() {
  const coinEnv = readEnvFile(path.join(ROOT, "coin-contract", ".env"));
  if (!coinEnv.DEPLOYER_PRIVATE_KEY) {
    throw new Error("coin-contract/.env has no DEPLOYER_PRIVATE_KEY to top up from");
  }
  const foundryCast = path.join(process.env.HOME ?? "", ".foundry/bin/cast");
  const out = execFileSync(
    existsSync(foundryCast) ? foundryCast : "cast",
    ["send", ASSET, "transfer(address,uint256)", agentAddress, TOP_UP_AMOUNT,
      "--rpc-url", RPC_URL, "--private-key", coinEnv.DEPLOYER_PRIVATE_KEY, "--json"],
    { encoding: "utf8" },
  );
  return JSON.parse(out).transactionHash;
}

async function findSettlement(from, nonce, fromBlock) {
  const logs = await rpc("eth_getLogs", [{
    address: ASSET,
    fromBlock: "0x" + Math.max(0, Number(fromBlock) - 2).toString(16),
    toBlock: "latest",
    topics: [AUTHORIZATION_USED_TOPIC, pad32(from), pad32(nonce)],
  }]);
  if (logs.length === 0) {
    const failure = settlementFailures.get(paymentKey(from, nonce));
    return failure ? { settled: false, failed: true, reason: failure } : { settled: false };
  }
  const txHash = logs[0].transactionHash;
  const [receipt, tx] = await Promise.all([
    rpc("eth_getTransactionReceipt", [txHash]),
    rpc("eth_getTransactionByHash", [txHash]),
  ]);
  return {
    settled: true,
    txHash,
    blockNumber: parseInt(logs[0].blockNumber, 16),
    status: receipt?.status === "0x1" ? "success" : "reverted",
    sender: tx.from,
    gasUsed: receipt ? parseInt(receipt.gasUsed, 16) : null,
  };
}

// ------------------------------------------------------------------ http

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function proxy(req, res, service, rest) {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (req.headers["x-payment"]) headers["x-payment"] = req.headers["x-payment"];
  const upstream = await fetch(SERVICE_URL[service] + rest, { method: req.method, headers, body });
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  res.end(await upstream.text());
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${UI_PORT}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(res, 200, readFileSync(path.join(HERE, "index.html"), "utf8"), "text/html; charset=utf-8");
    }
    const proxied = url.pathname.match(/^\/api\/(rs|aw|fac)(\/.*)$/);
    if (proxied) return await proxy(req, res, proxied[1], proxied[2] + url.search);

    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, await state());
    if (req.method === "POST" && url.pathname === "/api/delegation") {
      return send(res, 200, await setDelegation(JSON.parse(await readBody(req))));
    }
    if (req.method === "DELETE" && url.pathname === "/api/delegation") {
      await revokeDelegation();
      return send(res, 200, { revoked: true });
    }
    if (req.method === "POST" && url.pathname === "/api/topup") return send(res, 200, { txHash: topUp() });
    if (req.method === "GET" && url.pathname === "/api/settlement") {
      const { from, nonce, fromBlock } = Object.fromEntries(url.searchParams);
      return send(res, 200, await findSettlement(from, nonce, fromBlock));
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

// ------------------------------------------------------------------ main

async function main() {
  await assertPortsFree();
  console.log("Starting Facilitator, Resource Server, Agent Wallet...");
  start("facilitator", "facilitator", { PORT: String(PORTS.facilitator), ETHEREUM_RPC_URL: RPC_URL });
  start("resourceServer", "resourceServer", {
    PORT: String(PORTS.resourceServer),
    FACILITATOR_URL: SERVICE_URL.fac,
    ASSET_ADDRESS: ASSET,
  });
  start("agentWallet", "agentWallet", {
    PORT: String(PORTS.agentWallet),
    KEYSTORE_DIR: path.join(HERE, ".keystore"),
  });
  await waitHealthy();

  agentAddress = await ensureAgent();
  const unpaid = await fetch(`${SERVICE_URL.rs}/securities/quotes/005930`).then((r) => r.json());
  payTo = unpaid.requirements.payTo;
  await setDelegation({
    allowedResources: [`${SERVICE_URL.rs}/securities/*`, `${SERVICE_URL.rs}/shop/*`],
    maxAmountPerTx: "100000",
    maxAmountPerWindow: "500000",
    windowSeconds: 3600,
  });

  server.listen(UI_PORT, () => {
    console.log(`\n  Demo page: http://localhost:${UI_PORT}`);
    console.log(`  Agent wallet: ${agentAddress}`);
    console.log(`  Settler:      ${settlerAddress ?? "(FACILITATOR_PRIVATE_KEY not set: settlement disabled)"}`);
    console.log("\n  Ctrl+C stops everything.");
  });
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
