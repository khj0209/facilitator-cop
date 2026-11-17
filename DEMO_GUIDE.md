# x402 에이전트 결제 데모 가이드

서버를 띄우는 것부터 시연 순서, 문제 해결까지 정리한 문서입니다. 모든 결제는 실제 **Ethereum Sepolia** 테스트넷에서 이루어집니다.

## 데모로 보여주는 것

AI 에이전트가 유료 API(증권사·쇼핑몰)를 호출하면 다음 순서로 진행됩니다.

1. API 서버(**Resource Server**)가 `402 Payment Required`로 가격을 알려줍니다.
2. 에이전트 지갑(**Agent Wallet**)이 결제에 서명합니다.
   - 먼저 **위임 정책(Permission Delegation)** 이 한도와 허용 범위를 확인합니다.
   - 통과하면 **키 보관(Key Custody)** 모듈이 실제 서명을 합니다. 두 모듈은 분리되어 있어서, 정책 모듈은 개인키에 접근할 수 없습니다.
3. 서명을 담아 다시 요청하면 **Facilitator** 가 결제를 검증하고 API 응답이 나갑니다.
4. Facilitator가 **가스를 대신 내고** 온체인 정산(`transferWithAuthorization`)을 합니다. 에이전트 지갑에는 ETH가 0이어도 됩니다.

## 1. 사전 준비 (처음 한 번)

현재 PC에는 아래 항목이 모두 준비돼 있습니다. 다른 PC에서 하거나 무언가 안 될 때 확인하세요.

| 항목 | 확인 방법 |
|---|---|
| Node.js 22.9 이상 | `node -v` |
| 각 레포의 의존성 설치 | `agentWallet`, `facilitator`, `resourceServer`, `x402-contracts` 폴더마다 `npm install` |
| 공유 타입 빌드 | `cd x402-contracts && npm run build` (`dist/`가 있으면 생략) |
| Facilitator 정산 키 | `facilitator/.env`에 `FACILITATOR_PRIVATE_KEY` (예시: `facilitator/.env.example`) |
| 토큰 owner 키 (DEMO 충전 버튼용) | `coin-contract/.env`에 `DEPLOYER_PRIVATE_KEY` |
| Foundry `cast` (DEMO 충전 버튼용) | `~/.foundry/bin/cast --version` |
| 포트 4000~4003 비어 있음 | `lsof -iTCP:4000-4003 -sTCP:LISTEN` 결과가 비어 있어야 함 |

폴더 구조는 이렇습니다. 모두 같은 상위 폴더 아래에 있어야 합니다.

```
CoP/code/
├── agentWallet/      # Agent Wallet (:4003)
├── resourceServer/   # Resource Server (:4002)
├── facilitator/      # Facilitator (:4001)
├── x402-contracts/   # 공유 타입
├── coin-contract/    # DemoCoin 컨트랙트
├── demo-ui/          # 데모 페이지 (:4000)  ← 여기서 실행
└── e2e/              # 자동 테스트
```

## 2. 서버 띄우기

```bash
cd ~/CoP/code/demo-ui
npm start
```

이 명령 하나로 Facilitator, Resource Server, Agent Wallet과 데모 페이지가 함께 뜹니다. 서버를 따로 띄울 필요는 없습니다. 몇 초 뒤 터미널에 이렇게 나오면 준비된 것입니다.

```
  Demo page: http://localhost:4000
  Agent wallet: 0xbB3F10a86d809C5dF3689bAEe7821Ac8826EA611
  Settler:      0x215c85C49A969BBa2633263C55f973Ec5918265A
```

브라우저에서 **http://localhost:4000** 을 엽니다.

> **터미널도 같이 띄워두세요.** 세 서비스의 로그가 서비스별 색으로 한 줄씩 실시간 출력됩니다. 페이지 하단의 "서비스 로그" 패널에도 같은 내용이 서비스별 3열로 표시됩니다. 화면이 하나뿐이면 페이지 하단 패널만 보여줘도 충분합니다.

## 3. 시연 전 체크 (1분)

페이지 왼쪽 패널에서 확인합니다.

- **에이전트 지갑 DEMO**가 0.1 이상인지 확인합니다. 부족하면 **"owner에게서 1 DEMO 충전"** 을 누릅니다. 블록 확정까지 10~20초 걸립니다.
- **Facilitator ETH**가 0보다 큰지 확인합니다. 현재 약 0.05 ETH이고, 정산 1건에 드는 가스는 매우 적습니다.
- **위임 정책**이 기본값인지 확인합니다. 허용 리소스 `/securities/*`, `/shop/*`, 건당 0.1, 누적 0.5 DEMO / 3600초입니다. 서버를 시작할 때마다 이 기본 정책이 자동으로 발급됩니다.

## 4. 시연 시나리오

추천 순서는 A → B → C → D → E이고, 전체 10~15분 정도 걸립니다. 각 단계에서 "서비스 로그" 패널의 어느 열에 무엇이 찍히는지 함께 보여주면 이해가 빠릅니다.

### A. 기본 결제 흐름: 증권 시세 조회 (핵심)

1. 결제 흐름에서 **"증권 · 시세 조회 (005930)"** 를 선택합니다.
2. **①을 실행**합니다.
   - 화면: `HTTP 402`와 결제 요구 금액 0.01 DEMO, 받는 주소
   - 로그(Resource Server): `402 결제 요구`
   - 설명: "결제 없이 호출하면 API 서버가 가격표를 돌려줍니다."
3. **②를 실행**합니다.
   - 화면: `HTTP 200`, 서명 완료, 결제 태그 `#xxxxxx`
   - 로그(Agent Wallet) 네 줄:
     - `결제 서명 요청`
     - `[Permission Delegation] 승인 · 건당 한도 …, 누적 …`
     - `승인 토큰(JWT) 발급 → Key Custody`
     - `[Key Custody] 토큰 검증 후 EIP-3009 서명`
   - 설명: "정책 모듈이 한도를 확인하고 승인 토큰만 넘깁니다. 실제 개인키 서명은 키 보관 모듈만 합니다."
4. **③을 실행**합니다.
   - 화면: `HTTP 200`과 시세 데이터
   - 로그:
     - Resource Server: `X-PAYMENT 수신`
     - Facilitator: `검증 통과 · 서명·금액·수신자·잔액·nonce 확인`
     - Resource Server: `검증 통과 → API 응답 제공`, `정산 요청 (비동기)`
5. **④를 실행**합니다. Sepolia 블록 시간 때문에 10~20초 기다립니다.
   - 화면: `정산 완료`, 트랜잭션 링크, 가스를 낸 주소(Facilitator), 에이전트 −0.01 / 판매자 +0.01, 에이전트 ETH 0
   - 로그(Facilitator): `transferWithAuthorization 전송` → `블록 #… 확정`
   - 설명: "에이전트는 ETH가 하나도 없습니다. 가스는 Facilitator가 냈습니다."
6. **결제 태그(`#xxxxxx`)를 클릭**합니다. 세 열이 이 결제의 로그만 남도록 필터링되어, 결제 하나가 세 서비스를 거치는 흐름이 한눈에 보입니다. **"필터 해제"** 로 되돌립니다.
7. (선택) 트랜잭션 링크를 눌러 Etherscan에서 실제 온체인 기록을 보여줍니다.

> 빠르게 보여줄 때는 **"전체 실행"** 을 누르면 ①~④가 자동으로 이어서 실행됩니다.

### B. 다른 서비스: 쇼핑몰 결제

**"쇼핑 · 장바구니 결제 (USB-C 허브)"** 를 선택하고 **"전체 실행"** 을 누릅니다. 같은 지갑과 정책으로 0.03 DEMO가 결제되고 주문번호가 나옵니다. "한 번 위임해 두면 여러 서비스를 같은 방식으로 이용한다"는 점을 보여주는 단계입니다.

### C. 위임 한도 초과: 주식 주문

**"증권 · 주식 주문 (한도 초과)"** 를 선택하고 **"전체 실행"** 을 누릅니다.

- 주문 가격은 1 DEMO로, 건당 한도 0.1을 넘습니다.
- ②에서 `HTTP 403 · amount exceeds maxAmountPerTx`가 나오고 흐름이 멈춥니다.
- 로그(Agent Wallet): `[Permission Delegation] 거부`. Key Custody 줄은 나오지 않습니다.
- 설명: "정책을 벗어난 결제는 키 보관 모듈까지 가지도 못합니다."

### D. 공격 시나리오

A를 끝낸 상태에서 진행합니다. "같은 결제 다시 보내기"는 ③을 마쳐야 활성화됩니다.

| 버튼 | 기대 결과 | 로그 |
|---|---|---|
| 같은 결제 다시 보내기 | `HTTP 402 → 차단됨 (payment already used)` | Resource Server: `이미 사용된 결제 → 402 차단` |
| 같은 결제 동시 5건 | 200 한 건, 402 네 건, 온체인 정산도 1번만 | Resource Server에 차단 4줄, Facilitator 정산 1건 |
| 서명 변조 | `HTTP 402 → 차단됨 (signature verification failed)` | Facilitator: `검증 실패` → Resource Server: `결제 거부` |

"동시 5건"과 "서명 변조"는 현재 선택된 API로 새 결제를 서명해서 시도합니다. 시세 조회처럼 한도 안의 API를 선택해 두고 누르세요.

### E. 위임 정책을 바꿔보기 (선택)

왼쪽 "위임 정책"을 수정하고 **"정책 재발급"** 을 누릅니다. 재발급하면 기존 정책은 철회되고, 누적 사용량도 0부터 다시 셉니다.

| 바꿔볼 것 | 시도 | 기대 결과 (②에서) |
|---|---|---|
| 건당 최대를 `0.005`로 | 시세 조회 (0.01) | 403 `amount exceeds maxAmountPerTx` |
| 허용 리소스에서 `/shop/*` 줄 삭제 | 쇼핑 결제 | 403 `resource … not allowed by delegation policy` |
| 기간 누적 최대를 `0.02`로 | 시세 조회 3번 | 세 번째에 403 `amount exceeds maxAmountPerWindow` |
| "철회" 버튼 | 아무 API | 403 `no active delegation policy for agent` |

끝나면 기본값(허용 리소스 두 줄, 0.1 / 0.5 / 3600)으로 되돌리고 다시 재발급합니다. 서버를 재시작해도 기본값으로 돌아갑니다.

## 5. 종료

`npm start`를 실행한 터미널에서 **Ctrl+C** 를 누릅니다. 네 프로세스가 모두 함께 종료됩니다.

## 6. 문제 해결

| 증상 | 원인과 해결 |
|---|---|
| `port 400x (...) is already in use` | 이전 실행이 남아 있습니다. `lsof -tiTCP:4000-4003 -sTCP:LISTEN \| xargs kill` 후 다시 실행하세요. |
| `... did not become healthy` | 서비스 하나가 시작하지 못했습니다. `demo-ui/logs/<서비스>.log`에서 원인을 확인하세요(대개 `npm install` 누락). |
| 정산 활성화 줄이 안 나오고 `Settler: (... not set ...)` | `facilitator/.env`에 `FACILITATOR_PRIVATE_KEY`가 없습니다. ③까지는 되지만 정산은 거부됩니다. |
| ③에서 `insufficient balance` | 에이전트 DEMO가 부족합니다. "owner에게서 1 DEMO 충전"을 누르세요. |
| 충전 버튼 오류 | `coin-contract/.env`의 `DEPLOYER_PRIVATE_KEY` 또는 Foundry `cast`가 없습니다. |
| ④에서 `정산 실패`이고, 왼쪽 패널의 Facilitator ETH가 0에 가까움 | Facilitator가 가스비를 낼 ETH가 없습니다. 배포자 지갑에서 보내세요: `cd coin-contract && source .env && cast send 0x215c85C49A969BBa2633263C55f973Ec5918265A --value 0.05ether --rpc-url $SEPOLIA_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY` |
| ④가 오래 걸림 (30초 이상) | 공용 RPC나 Sepolia가 느린 경우입니다. 3분까지 기다리고, 그래도 안 되면 다른 RPC로 실행하세요: `ETHEREUM_RPC_URL=<RPC 주소> npm start` |
| 화면에 `데모 서버 오류: ... eth_...` | RPC 호출 실패입니다. 위와 같이 RPC를 바꿔보세요. |
| ②에서 `no active delegation policy for agent` | 정책이 철회된 상태입니다. "정책 재발급"을 누르세요. |
| 누적 한도에 걸림 (`maxAmountPerWindow`) | 1시간 동안 0.5 DEMO를 넘게 썼습니다. "정책 재발급"을 누르면 사용량이 초기화됩니다. |

시연 전에 전체 동작을 자동으로 점검하고 싶으면 다음을 실행합니다(약 1분, 포트 4101~4103 사용). 14개 항목이 모두 PASS면 정상입니다.

```bash
cd ~/CoP/code/e2e && npm run test:testnet
```

## 7. 참고 정보

| 항목 | 값 |
|---|---|
| 네트워크 | Ethereum Sepolia (chainId 11155111) |
| 토큰 DemoCoin (DEMO, 소수점 6자리) | [`0x025311Ca250150E9c3684b614566c9f187a47e16`](https://sepolia.etherscan.io/address/0x025311Ca250150E9c3684b614566c9f187a47e16) |
| Facilitator 정산(가스 지불) 주소 | [`0x215c85C49A969BBa2633263C55f973Ec5918265A`](https://sepolia.etherscan.io/address/0x215c85C49A969BBa2633263C55f973Ec5918265A) |
| 판매자(payTo) = 토큰 owner | [`0x0E79409e5f2b822d2046cC28E99FF6b411B3beBE`](https://sepolia.etherscan.io/address/0x0E79409e5f2b822d2046cC28E99FF6b411B3beBE) |
| 데모 에이전트 지갑 | [`0xbB3F10a86d809C5dF3689bAEe7821Ac8826EA611`](https://sepolia.etherscan.io/address/0xbB3F10a86d809C5dF3689bAEe7821Ac8826EA611) (키: `demo-ui/.keystore/`) |
| API 가격 | 시세·잔고 조회 0.01 / 쇼핑 결제 상품별(USB-C 허브 0.03) / 주식 주문 1 DEMO |
| 서비스 원본 로그(JSON) | `demo-ui/logs/facilitator.log`, `resourceServer.log`, `agentWallet.log` |

판매자 주소가 토큰 owner라서 판매자 DEMO 잔액이 약 100만으로 크게 보입니다. 화면에서는 잔액 자체보다 **변화량(+0.01)** 을 가리키며 설명하세요.
