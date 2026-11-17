import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { KeyStoreProvider, SignRequest } from "x402-contracts";
import { verifyApprovalToken } from "../delegation/approvalToken.js";

const ALGO = "aes-256-gcm";

interface StoredWallet {
  address: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class LocalKeyStoreProvider implements KeyStoreProvider {
  readonly type = "local" as const;
  private readonly key: Buffer;
  private readonly consumedNonces = new Set<string>();

  constructor(private readonly dataDir: string, passphrase: string) {
    this.key = createHash("sha256").update(passphrase).digest();
    mkdirSync(this.dataDir, { recursive: true });
  }

  private filePath(agentId: string): string {
    return path.join(this.dataDir, `${agentId}.json`);
  }

  private encrypt(plaintext: string): Omit<StoredWallet, "address"> {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("hex"),
      authTag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    };
  }

  private decrypt(stored: StoredWallet): string {
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(stored.iv, "hex"));
    decipher.setAuthTag(Buffer.from(stored.authTag, "hex"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(stored.ciphertext, "hex")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }

  private load(agentId: string): StoredWallet {
    if (!existsSync(this.filePath(agentId))) {
      throw new Error(`no wallet found for agent ${agentId}`);
    }
    return JSON.parse(readFileSync(this.filePath(agentId), "utf8")) as StoredWallet;
  }

  async createWallet(agentId: string): Promise<{ address: string }> {
    if (existsSync(this.filePath(agentId))) {
      throw new Error(`wallet already exists for agent ${agentId}`);
    }
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;
    const stored: StoredWallet = { address, ...this.encrypt(privateKey) };
    writeFileSync(this.filePath(agentId), JSON.stringify(stored));
    return { address };
  }

  async getAddress(agentId: string): Promise<string> {
    return this.load(agentId).address;
  }

  async sign(req: SignRequest): Promise<{ signature: string }> {
    const claims = verifyApprovalToken(req.approvalToken);
    if (claims.agentId !== req.agentId) {
      throw new Error("approval token agentId mismatch");
    }
    if (claims.chain !== req.chain) {
      throw new Error("approval token chain mismatch");
    }
    if (this.consumedNonces.has(claims.nonce)) {
      throw new Error("approval token already used");
    }
    this.consumedNonces.add(claims.nonce);

    const stored = this.load(req.agentId);
    const privateKey = this.decrypt(stored) as `0x${string}`;
    const account = privateKeyToAccount(privateKey);
    const typedData = req.payload as Parameters<typeof account.signTypedData>[0];
    const signature = await account.signTypedData(typedData);
    return { signature };
  }
}
