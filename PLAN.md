# Agentic Payment Demo — 개발 계획

## 0. 개요

에이전트가 자율적으로 유료 API(증권사 API)를 호출하고, 그 대가를 온체인 결제로 정산하는 **x402 스타일 결제 프로토콜**의 3대 컴포넌트를 구현한다.

| 컴포넌트 | 역할 |
|---|---|
| **Agent Wallet** | 에이전트를 대신해 결제를 서명. **키 보관(Key Custody)** 과 **권한 위임(Permission Delegation)** 을 별도 모듈로 분리 |
| **Resource Server** | 유료 API 제공자 예시 = 증권사 API 서버 (시세 조회, 주문, 잔고 등) |
| **Facilitator** | 결제 검증/정산을 대행하는 서버. `/verify`, `/settle`, `/supported` 3개 엔드포인트 |

- **스택**: Node.js + TypeScript (모든 컴포넌트 공통), Fastify (또는 Express), viem
- **네트워크**: 기와체인, 이더리움 (2개 체인 동시 지원)
- **결제 자산**: 자체 발행 코인 (스테이블코인 아님 — 체인별 어댑터 필요, [미정 사항](#6-미정-사항--확인-필요) 참고)
- **저장소 구조**: Agent Wallet / Resource Server / Facilitator를 **각각 독립된 레포**로 운영 (모노레포 아님). 세 레포가 공유해야 하는 타입(`PaymentRequirements`, `PaymentPayload` 등)은 별도 배포 패키지 또는 스펙 문서로 관리 ([Phase 0](#5-개발-단계-phases) 참고)

---

## 1. 전체 아키텍처

```
┌─────────────┐   1. API 호출 (무결제)    ┌──────────────────┐
│   Agent     │ ─────────────────────────▶ │  Resource Server │
│ (호출 주체) │ ◀───────────────────────── │  (증권사 API)     │
└─────┬───────┘   2. 402 + PaymentReq      └────────┬─────────┘
      │                                              │
      │ 3. 서명 요청                          4. X-PAYMENT 검증/정산 요청
      ▼                                              ▼
┌─────────────┐                            ┌──────────────────┐
│ Agent Wallet │                           │   Facilitator    │
│ ┌──────────┐│                           │ POST /verify      │
│ │Permission ││                           │ POST /settle      │
│ │Delegation ││                           │ GET  /supported   │
│ └────┬─────┘│                           └─────────┬──────────┘
│      │ 위임 스코프 검증                              │
│ ┌────▼─────┐│                                       │
│ │   Key     ││                                       ▼
│ │  Custody  ││                            ┌──────────────────┐
│ └──────────┘│                            │  체인 어댑터       │
└──────────────┘                           │ 기와체인 / Ethereum│
                                            └──────────────────┘
```

**흐름**
1. Agent가 Resource Server의 증권사 API를 호출
2. Resource Server가 결제가 안 된 요청이면 `HTTP 402` + `PaymentRequirements`(가격, 자산, 체인, 수신 주소 등) 반환
3. Agent가 Agent Wallet에 "이 요청에 대해 결제 서명해줘" 요청
4. Agent Wallet 내부: **Permission Delegation**이 위임 스코프(한도/대상/만료) 확인 → 통과 시 **Key Custody**가 실제 서명 수행 (Delegation은 절대 키에 직접 접근하지 않음)
5. Agent가 서명된 `X-PAYMENT` 헤더를 담아 재요청
6. Resource Server가 Facilitator에 `/verify` 호출 → 통과 시 API 응답 제공, 백그라운드로 `/settle` 호출해 온체인 정산
7. Facilitator는 요청받은 체인(기와체인/이더리움)에 맞는 어댑터로 실제 검증·브로드캐스트 수행

---

## 2. Agent Wallet — 키 보관 / 권한 위임 분리

**설계 원칙**: Key Custody는 "무엇을 서명해도 되는지" 모르고, Permission Delegation은 "개인키가 무엇인지" 모른다. 두 모듈은 프로세스/모듈 경계로 분리하고, 내부 API로만 통신한다.

### 2.1 Key Custody 모듈 — 키 저장소 Provider 인터페이스

키를 **어디에 보관할지는 사용자(에이전트 운영자)가 선택**할 수 있어야 한다. Key Custody는 이 선택을 `KeyStoreProvider` 인터페이스 뒤로 숨기고, 상위(Permission Delegation, Resource Server 등)는 어떤 Provider가 붙어 있는지 몰라도 동일하게 동작해야 한다.

```ts
interface SignRequest {
  agentId: string;
  chain: "giwa" | "ethereum";
  payload: unknown;          // 서명 대상 (typed data 등)
  approvalToken: string;     // Permission Delegation이 발급한 승인 토큰 (JWT, 필수 — 6.3 참고)
}

interface KeyStoreProvider {
  readonly type: "local" | "custodial" | "external-wallet";
  getAddress(agentId: string): Promise<string>;
  sign(req: SignRequest): Promise<{ signature: string }>;
}
```

- Permission Delegation은 `approvalToken`만 만들어 넘기고, 실제 서명이 어느 Provider에서 일어나는지는 알 필요 없음 → Provider를 교체해도 상위 로직 변경 없음
- Provider는 에이전트 생성 시점에 선택 (`POST /wallets`에 `keyStoreProvider` 파라미터로 지정), 이후 교체(마이그레이션)도 가능하게 설계

**지원할 Provider 종류**

| Provider | 설명 | 장점 | 고려사항 |
|---|---|---|---|
| **Local** | 에이전트가 실행되는 기기/서버에 암호화된 keystore 파일로 개인키 보관, 서명도 로컬에서 수행 | 구현 간단, 외부 의존성 없음, 완전 자동화 가능 | 기기 탈취 시 키 노출, 백업/복구 전략 필요 |
| **Custodial (수탁 서비스)** | Fireblocks/Turnkey/자체 KMS 등 외부 서명 서비스에 키 보관·서명을 위임, Key Custody는 API 클라이언트 역할만 수행 | 키가 자체 프로세스에 존재하지 않아 노출 표면 최소화, 서비스 자체 정책/감사 로그 활용 가능 | 외부 서비스 종속성, 네트워크 지연, 비용, 서비스 장애 시 서명 불가 |
| **External Wallet (기존 지갑 연동)** | 사용자가 이미 쓰는 MetaMask 등 외부 지갑에 서명을 위임 (JSON-RPC `eth_signTypedData_v4` 또는 WalletConnect 세션 경유) | 사용자가 키를 직접 통제(자체 커스터디 유지), 새 키 생성/이관 불필요 | 서명 시 사람의 승인(팝업/딥링크)이 필요해 완전 자동화된 에이전트 플로우와 상충 → 자동화하려면 세션키/스마트 계정(예: ERC-4337) 방식으로 사전 위임하는 보완 설계 필요 |

- 세 Provider 모두 "서명 전 반드시 `approvalToken` 검증"이라는 동일 계약을 지켜야 함 (Local/Custodial은 Key Custody 내부에서 검증, External Wallet은 위임 세션 생성 시점에 이미 스코프가 고정되어 있어야 함)
- 키 생성/로테이션/export 금지(export 없음) API — Local/Custodial 공통. External Wallet은 애초에 키 자체가 이 시스템 밖에 있으므로 해당 없음

### 2.2 Permission Delegation 모듈
- 에이전트별 위임 정책(Capability) 정의 및 저장
  - 허용 리소스(도메인/엔드포인트 패턴)
  - 최대 결제 한도 (단건 / 기간 누적)
  - 허용 체인·자산
  - 만료 시각, nonce/재사용 방지
- 결제 요청이 들어오면 정책과 대조 → 승인 시 **단기 승인 토큰**(예: JWT 또는 EIP-712 typed data)을 발급해 Key Custody로 전달
- 위임 발급/철회(revoke) API 제공 (사람 또는 상위 시스템이 정책 관리)

### 2.3 데이터 모델 (초안)
```ts
interface DelegationPolicy {
  agentId: string;
  allowedResources: string[];      // e.g. ["api.securities.example.com/*"]
  maxAmountPerTx: bigint;
  maxAmountPerWindow: bigint;
  windowSeconds: number;
  allowedChains: ("giwa" | "ethereum")[];
  expiresAt: number;
  nonce: string;
}
```

### 2.4 API 표면 (초안)
- `POST /wallets` — 에이전트용 지갑 생성, `keyStoreProvider: "local" | "custodial" | "external-wallet"` 지정 (Key Custody가 해당 Provider로 라우팅)
- `POST /delegations` — 위임 정책 발급
- `DELETE /delegations/:id` — 위임 철회
- `POST /sign-payment` — Resource Server가 요구한 PaymentRequirements를 받아 (위임 검증 → 승인 토큰 발급 → 지정된 Provider로 서명) 하여 `X-PAYMENT` 페이로드 반환

---

## 3. Resource Server — 증권사 API + 쇼핑몰 API 예시

데모용 최소 API 세트를 **하나의 Resource Server 레포 안에 경로로 구분**해 운영 (프로토콜이 서로 다른 종류의 유료 API에 범용적으로 적용됨을 보여주기 위해 두 번째 예시로 쇼핑몰 API 추가).

**증권사 API** (`/securities/*`)

| 엔드포인트 | 설명 | 과금 |
|---|---|---|
| `GET /securities/quotes/:symbol` | 실시간(모의) 시세 조회 | 소액 과금 |
| `GET /securities/portfolio` | 보유 잔고/포지션 조회 | 소액 과금 |
| `POST /securities/orders` | 매수/매도 주문 실행 | 과금 (금액 큼) |

**쇼핑몰 API** (`/shop/*`)

| 엔드포인트 | 설명 | 과금 |
|---|---|---|
| `GET /shop/products` | 상품 목록 조회 | 무료 |
| `POST /shop/cart/checkout` | 장바구니 결제 (금액은 상품가 × 수량으로 요청마다 동적 계산) | 과금 |
| `GET /shop/orders/:id` | 주문 내역 조회 | 소액 과금 |

**결제 미들웨어 동작**
1. 요청 헤더에 `X-PAYMENT` 없으면 → `402 Payment Required` + body에 `PaymentRequirements`(가격, 자산 컨트랙트, 체인, receiver 주소, scheme) 반환
2. `X-PAYMENT` 있으면 → Facilitator `/verify` 호출
3. 검증 통과 → 실제 비즈니스 로직 실행 후 응답, 응답 후(또는 비동기) Facilitator `/settle` 호출
4. 검증 실패 → `402` 재반환 (에러 사유 포함)

기존 x402 미들웨어 패턴(`x402-express`/`x402-fastify` 유사)을 참고해 자체 미들웨어로 구현 (자체 코인·2개 체인 지원이 필요해 표준 라이브러리 그대로 쓰기 어려움).

---

## 4. Facilitator — 3개 엔드포인트

| 엔드포인트 | 메서드 | 역할 |
|---|---|---|
| `/supported` | GET | 지원하는 (scheme, network, asset) 조합 목록 반환 — Resource Server가 PaymentRequirements 구성 시 참조 |
| `/verify` | POST | 서명된 결제 페이로드가 유효한지 검증(서명 검증, 잔액/한도, nonce 재사용 여부) — **온체인 제출은 하지 않음** |
| `/settle` | POST | 실제로 온체인 트랜잭션을 제출/브로드캐스트하고 결과(tx hash, 성공 여부) 반환 |

**내부 구조**: 체인별 어댑터 인터페이스로 분리해 기와체인/이더리움을 동시 지원.

```ts
interface ChainAdapter {
  network: "giwa" | "ethereum";
  verifyPayment(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult>;
  settlePayment(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult>;
}
```

- `EthereumAdapter`: viem 사용, 자체 코인(EIP-3009 지원 ERC-20)의 `transferWithAuthorization`으로 `scheme: "exact"` 구현 (6.2 참고)
- `GiwaAdapter`: GIWA가 EVM 호환 OP Stack L2이므로 `EthereumAdapter`와 동일 로직에 chain 설정(rpcUrl: GIWA Sepolia, chainId: 91342)만 다르게 주입해 구현 (6.1 참고, 별도 SDK 불필요)

---

## 5. 개발 단계 (Phases)

- **Phase 0 — 스캐폴딩 (독립 레포 3개)**
  - `agent-wallet`, `resource-server`, `facilitator` 각각 별도 git 레포로 초기화 (공통 tsconfig/lint 설정은 레포마다 복사하거나 각자 관리)
  - 레포 간 공유가 필요한 타입(`PaymentRequirements`, `PaymentPayload`, `VerifyResult` 등)은 별도 경량 레포 `x402-contracts`(타입 + zod 스키마)로 관리, 각 레포에서 `npm install github:<org>/x402-contracts#<tag>`로 설치 (6.4 참고)
  - 각 레포에 최소 "hello world" 서버 + 헬스체크 엔드포인트로 실행 확인

- **Phase 1 — Facilitator 뼈대** ✅ 완료
  - `/supported`, `/verify`, `/settle` 라우트, `ChainAdapter` 인터페이스 확정
  - `EvmAdapter`: viem으로 EIP-712/EIP-3009 서명을 실제 검증 (RPC 불필요), `settlePayment`는 Phase 4 전까지 미구현 스텁

- **Phase 2 — Resource Server** ✅ 완료
  - 증권사 API 3개 엔드포인트 + 쇼핑몰 API 3개 엔드포인트 (모두 mock 데이터), 경로로 구분(`/securities/*`, `/shop/*`)
  - `requirePayment()` 402 미들웨어: 결제 없으면 402+`PaymentRequirements`, 있으면 Facilitator `/verify` 호출 후 통과 시 비즈니스 로직 실행, 응답 후 비동기로 `/settle` 호출
  - 실제 EIP-712 서명으로 전체 흐름(402 → 서명 → 재요청 → 통과) e2e 테스트 완료

- **Phase 3 — Agent Wallet** ✅ 완료
  - Key Custody: `KeyStoreProvider` 구현 (`local` — 에이전트별 private key를 AES-256-GCM으로 암호화해 디스크에 저장, 서명 전 JWT 승인 토큰 검증 + nonce 재사용 방지; custodial/external-wallet은 이후 단계)
  - Permission Delegation: 정책 저장소(allowedResources/allowedChains/maxAmountPerTx/maxAmountPerWindow), 통과 시 단기 JWT 승인 토큰 발급 (6.3), 실제 서명 성공 후에만 윈도우 사용량 반영
  - `POST /wallets`, `POST /delegations`, `DELETE /delegations/:id`, `POST /sign-payment` 구현, Resource Server+Facilitator와 연결한 e2e 테스트 및 정책 한도 초과/범위 밖 자원 차단 확인 완료

- **Phase 4 — End-to-End 데모** 🔶 진행 중
  - Agent(테스트 스크립트) → Resource Server → 402 → Agent Wallet 서명 → 재요청 → Facilitator 검증/정산까지 전체 흐름 통합 테스트 (Ethereum 테스트넷 기준) — Phase 1~3에서 로컬로는 이미 검증됨, 남은 건 실제 테스트넷 RPC + 배포된 코인 컨트랙트로 `settlePayment` 구현
  - ✅ 코인 컨트랙트 Ethereum Sepolia 배포 완료 (2026-10-29) — `DemoCoin`(DEMO, 6 decimals) `0x025311Ca250150E9c3684b614566c9f187a47e16`, owner에 1,000,000 DEMO mint. 상세는 `coin-contract/README.md`
    - 처음엔 Circle `FiatTokenV2_2`(USDC 코드)로 배포를 시도했으나 실패: Sepolia의 컨트랙트 생성 가스 비용이 forge 로컬 시뮬레이션의 약 5배라 out-of-gas, 특히 FiatTokenV2_2(23KB)는 약 3,690만 gas가 필요해 트랜잭션당 상한(2²⁴ ≈ 1,678만, EIP-7825)을 넘음 → 외부 의존성 없는 경량 EIP-3009 토큰(5.4KB, 약 900만 gas)으로 교체 (6.2의 설계 방향은 그대로)
  - ✅ Facilitator `settlePayment` 구현 (2026-10-29) — 정산 전 재검증, `simulateContract` 후 `transferWithAuthorization`(v/r/s) 전송·receipt 확인, 정산 직렬화(settler nonce 충돌 방지), 동일 authorization 중복 제출 방지. `/verify`에 허용 asset 검사 + 온체인 잔액/nonce 사용 여부 확인 추가, `/supported`에 asset 포함. env: `FACILITATOR_PRIVATE_KEY`(없으면 settle 거부), `ETHEREUM_RPC_URL`, `ETHEREUM_ASSET_ADDRESS`
  - ✅ Resource Server — 기본 asset/payTo를 배포된 DemoCoin·owner 주소로, 가격을 6 decimals 기준으로 환산(기존 값은 18 decimals 가정), **결제 재사용(replay) 방지**(정산이 비동기라 온체인 nonce 확인만으로는 정산 확정 전 같은 X-PAYMENT 재사용을 못 막음 → 서버에서 `from:nonce` 선점), 4xx/5xx 응답은 정산하지 않음, 정산 결과(txHash) 로깅
  - ✅ 테스트넷 e2e 통과 — ETH 0인 에이전트 지갑이 402 → 서명 → 200 → Facilitator 대납 정산 성공(예: `0x31d16469…cf9f`), 순차/동시 5건 replay 차단, 정책 한도 초과 403, 잔액 변화 = 정산 건수와 일치
  - ✅ Facilitator 전용 정산 키 분리 — `0x215c85C49A969BBa2633263C55f973Ec5918265A` (배포자/owner 키와 별개, `facilitator/.env`, Sepolia ETH 0.05 충전). `npm run dev/start`가 `.env`를 자동 로드
  - ✅ 재현 가능한 테스트넷 e2e — 5번째 레포 `e2e/` (`npm run test:testnet`): 세 서버를 4101~4103 포트로 띄워 14개 항목 검증(402/결제/replay/동시 replay/서명 변조/위임 한도·범위/온체인 정산 tx 발신자·잔액 변화/에이전트 ETH 0), 에이전트 DEMO 부족 시 owner가 자동 충전
  - 남은 것: replay 방지 저장소가 메모리라 재시작/다중 인스턴스 시 유실 (운영 시 Redis 등 필요)

- **Phase 4.5 — 데모 페이지 (`demo-ui`)** ✅ 완료 (2026-10-29) — `cd demo-ui && npm start` → http://localhost:4000. 헤드리스 Chrome으로 전체 흐름·공격 3종·한도 초과 거부·모바일 폭까지 확인
  - 작업 중 발견해 수정한 버그
    - Agent Wallet이 `validAfter = now − 5초`로 서명 → 정산 시뮬레이션 기준인 최신 블록 타임스탬프가 그보다 이전일 수 있어 `AuthorizationNotYetValid`로 정산 실패(간헐적). `now − 600초`로 수정
    - 형식이 깨진 서명(곡선 밖의 점)에 viem `verifyTypedData`가 예외를 던져 Facilitator `/verify`가 500 → 예외를 잡아 `isValid: false` 반환
    - Resource Server 정산 로그에 payer·nonce 포함 (데모 페이지가 정산 실패 사유를 즉시 표시)
  - 6번째 레포 `demo-ui`: 브라우저에서 결제 흐름을 단계별로 시연하는 단일 페이지 + 작은 Node 서버(외부 의존성 없음)
  - Node 서버 역할: 정적 페이지 서빙, 세 서비스 프록시(브라우저 CORS 회피, 세 서비스 코드는 무변경), 체인 조회(잔액, `AuthorizationUsed(from, nonce)` 이벤트로 정산 tx 탐색), `npm start` 한 번으로 세 서비스까지 함께 기동
  - 화면 구성
    - 셋업: 데모 에이전트 지갑 생성/재사용, DEMO·ETH 잔액, owner로부터 DEMO 충전, Facilitator 정산 주소·ETH 잔액
    - 위임 정책: 허용 리소스·단건/기간 한도 설정(기존 정책 철회 후 재발급), 철회
    - 결제 흐름: API 선택(시세/포트폴리오/주문/쇼핑 결제) → ① 호출(402·요구사항) ② 지갑 서명(정책 판정·서명 페이로드) ③ X-PAYMENT 재요청(200) ④ 정산 확인(tx·Etherscan·잔액 변화), "전체 실행" 버튼
    - 공격 시나리오: 같은 결제 재사용, 동시 5건 재사용, 서명 변조 → 차단되는지 확인

- **Phase 5 — 기와체인 어댑터 추가**
  - `GiwaAdapter` 구현 (GIWA Sepolia RPC/chainId 설정, `EthereumAdapter`와 동일 로직 재사용), Facilitator `/supported`에 추가
  - 자체 코인 컨트랙트를 GIWA Sepolia에도 동일하게 배포

- **Phase 6 — Key Custody Provider 확장**
  - `custodial` Provider: 외부 서명 서비스(Fireblocks/Turnkey 또는 자체 KMS) 연동
  - `external-wallet` Provider: MetaMask/WalletConnect 연동, 자동화 플로우와의 승인 방식 충돌을 세션키/스마트 계정 등으로 보완

---

## 6. 설계 결정 (확정)

조사 및 논의를 거쳐 아래와 같이 확정. (2026-10-11)

### 6.1 기와체인(GIWA) 스펙
GIWA는 업비트(두나무)가 운영하는 **OP Stack 기반 이더리움 L2**로 완전 EVM 호환.
- 현재 메인넷 미출시, **GIWA Sepolia 테스트넷**만 운영 중
- Chain ID `91342`, 네이티브 가스 토큰 `ETH`
- RPC: `https://sepolia-rpc.giwa.io` (프로덕션 비권장), Flashblocks 전용 RPC 별도 존재
- Explorer: `https://sepolia-explorer.giwa.io`
- **별도 SDK 불필요** — EVM 툴체인(viem) 그대로 사용 가능
- → `GiwaAdapter`는 `EthereumAdapter`와 동일 코드 경로를 쓰고 **chain 설정(rpcUrl, chainId)만 다르게 주입**하는 구조로 구현 (완전히 별도로 만들지 않음)
- 참고: [GIWA 공식 문서](https://docs.giwa.io/get-started/connect-to-giwa), [The Block 보도](https://www.theblock.co/news/business/2025-09-08-upbit-launches-giwa-testnet-369947), [GIWA Sepolia Faucet](https://faucet.lambda256.io/giwa-sepolia)

### 6.2 자체 코인 표준
코인이 아직 미배포 상태이므로 **처음부터 EIP-3009(`transferWithAuthorization`)를 지원하는 ERC-20으로 설계**한다 (Coinbase x402 공식 스펙이 EIP-2612 permit이 아니라 EIP-3009를 기준으로 하기 때문 — [x402 specification v2](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)).
- 이더리움(Sepolia)·기와체인(Sepolia) 양쪽에 **동일한 컨트랙트 코드**를 배포 (둘 다 EVM이므로 가능)
- `scheme: "exact"` + EIP-3009 서명으로 가스리스 결제 구현 — Agent Wallet(Key Custody)이 EIP-712 typed data(`TransferWithAuthorization`)에 서명하고, Facilitator가 `/settle`에서 컨트랙트의 `transferWithAuthorization`을 호출해 대신 gas 지불
- **폴백 전략(만약 추후 컨트랙트가 EIP-3009/2612를 지원하지 못하는 상황이 생기면)**: Facilitator가 relayer로 동작 — 사용자가 `approve` 선서명 후 Facilitator가 `transferFrom`을 대신 호출해 gas 대납. `ChainAdapter`에 scheme별 분기(`exact-3009` vs `exact-approve-relay`)로 흡수 가능하도록 인터페이스에 여지를 남긴다.

### 6.3 위임 승인 토큰 포맷 — JWT
x402 표준상 온체인에 실제로 제출되는 서명은 Key Custody가 수행하는 EIP-712(EIP-3009) 서명뿐이다. Permission Delegation → Key Custody 사이의 `approvalToken`은 **같은 Agent Wallet 레포 내부 모듈 간 통신**이라 온체인 검증 대상이 아니므로, 무거운 EIP-712 대신 **단기 만료 JWT**로 충분하다.
- Permission Delegation이 자신의 서명 키로 JWT 발급 (exp 짧게, agentId/허용 리소스/금액 한도/nonce를 claim에 포함)
- Key Custody는 서명 검증 + exp/nonce 확인 후에만 실제 서명 수행

### 6.4 레포 간 타입 공유 방식 — git 의존성 패키지
데모 규모(3레포)에서 사설 npm 레지스트리 운영은 과함. 4번째 경량 레포 `x402-contracts`(타입 + zod 스키마만)를 만들고, 각 레포는 `npm install github:<org>/x402-contracts#<tag>`로 설치. 버전은 git tag로 고정하며, 필요 시 이후 npm 레지스트리로 승격 가능.

### 6.5 External Wallet Provider 자동화 — ERC-4337 세션키 방향
MetaMask 등 외부 지갑은 서명 시 사람 승인이 필요해 자동화와 상충. 업계 표준 해법인 **ERC-4337 세션키**(또는 ERC-7715 wallet permissions) 방향으로 `KeyStoreProvider` 인터페이스를 설계해두고, 실제 구현은 Phase 6에서 진행.

### 6.6 Custodial Provider 대상 — 데모용 Mock KMS
실제 Fireblocks/Turnkey 연동은 계정·비용이 필요해 데모 목적상 과함. 별도 프로세스 + 네트워크 호출로 동작을 흉내 내는 자체 Mock KMS로 Phase 6을 시작하고, 인터페이스가 동일하므로 추후 실제 서비스로 교체 가능하게 둔다.
