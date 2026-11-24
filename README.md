<!-- AI Hub fork modification, 2026-11-24. Original README: docs/upstream/README.md. -->
# AI Hub

**여러 코딩 에이전트와 터미널을 한 창에서 관리하는 Windows 데스크톱 앱.**

AI Hub는 [Herdr 데스크톱 앱](https://github.com/herdrdev/herdr-app) `0.1.17` 소스를 바탕으로,
기존 구현을 가져와 앱 이름과 설치·배포 구성을 조정한 독립 프로젝트입니다.
원본 프로젝트의 공식 배포판은 아닙니다.

[Windows 배포 파일](https://github.com/q1926313-art/AI-HUB/releases)
· [빌드 상태](https://github.com/q1926313-art/AI-HUB/actions)
· [원본과 변경 범위](docs/UPSTREAM.md)
· [AI 팀 사용 안내](docs/TEAM.md)
· [문제 신고](https://github.com/q1926313-art/AI-HUB/issues)

## 가져온 기능

- **작업 공간, 탭, 화면 분할:** 프로젝트와 여러 터미널을 원하는 배치로 관리합니다.
- **코딩 에이전트 실행:** Claude Code, Codex 등 터미널 프로그램을 실행합니다.
- **에이전트 상태:** 상태 보고를 지원하는 프로그램의 작업 중·입력 대기·완료 상태를 표시합니다.
- **창과 실행 엔진 분리:** 앱 창을 닫아도 실행 엔진이 유지되는 동안 작업이 계속됩니다.
  탭이나 패널을 닫으면 그 안의 터미널이 종료됩니다. PC 재부팅은 실행 중인 작업을 보존하지 않습니다.
- **SSH 원격 연결:** 다른 컴퓨터의 실행 엔진과 연결하여 작업을 관리합니다.
- **화면과 단축키 사용자 설정:** 레이아웃, JavaScript 모드, 글꼴, 색상, 알림 등을 조정합니다.
- **명령행 제어:** 창 상태 조회, 앱 명령 실행, 모드 검사, 화면 캡처 기능을 유지합니다.

원본 구현을 보존한 범위이며, 모든 에이전트·운영체제 조합의 실제 동작을 검증했다는 뜻은 아닙니다.
에이전트 프로그램의 설치와 계정 로그인은 각각 필요합니다. AI Hub는 모델 이용권을 제공하지 않습니다.

## 추가 기능: AI 팀

사이드바 하단의 **AI 팀**을 누르면 전용 **AI 팀 Space**의 **팀 관리** 탭으로 이동합니다.
프로젝트 폴더, 작업 이름, 목표와 완료 조건을 입력하세요.
여러 AI가 역할을 나누고, 앞 단계의 보고서를 받아 순서대로 작업합니다.

| 순서 | 기본 담당 | 하는 일 |
|---|---|---|
| 계획 | Claude Code | 요청 범위와 구현 순서, 확인 기준 정리 |
| 구현 | OpenCode Go · DeepSeek V4.1 Flash | 코드 변경과 필요한 검사 실행 |
| 검토 | Codex | 변경 내용과 회귀 가능성 검토 |
| 검증 | Claude Code | 검사 결과와 남은 문제 확인 |

**역할 설정**에서 역할 이름·순서·지침·작업 방식을 바꾸고, 최대 8개 역할을 추가·삭제하거나 끌 수 있습니다.
담당 도구·모델·추론 강도를 역할마다 지정합니다. Claude Code·Codex는 모델 선택 목록과 직접 입력을
지원하며, OpenCode는 설치된 CLI의 목록에서 정확한 `provider/model`을 선택합니다.
추론 강도는 선택한 모델과 도구에서 확인되는 지원값을 사용하며, 비워 두면 도구의 기본값을 유지합니다.

같은 Space의 **실시간 작업** 탭에서는 팀이 실제 실행한 터미널을 봅니다. 기본 배치는 Claude 왼쪽 65%,
Codex 오른쪽 위, OpenCode 오른쪽 아래입니다. 각 칸의 담당을 바꾸거나 왼쪽 너비를 55/65/75%로
설정할 수 있습니다. 아직 차례가 오지 않은 역할은 대기 상태로 표시하고, Claude 칸은 계획에서
검증 역할로 이어집니다. **팀 관리 · 보고서**를 눌러 관리 탭의 인수인계와 중지 버튼으로 돌아옵니다.
다른 탭·Space로 이동하거나 역할 설정을 보는 동안에도 기존 자동 진행을 유지합니다.
앱을 다시 열거나 다른 작업 기록을 선택한 경우에는 자동 실행을 다시 켜야 합니다.

기본 DeepSeek 선택값은 `opencode-go/deepseek-v4.1-flash`입니다.
[공식 Go 모델 목록](https://models.opencode.ai/providers/opencode-go/)에서 2026-11-24에
**DeepSeek V4.1 Flash 1017**로 확인한 모델입니다. 이 API 이름은 제공자의 별칭이므로
향후에도 1017 버전을 고정한다는 뜻은 아닙니다.

각 도구는 해당 PC에 설치하고 로그인해야 합니다. 계획·검토·검증의 기본 읽기 전용 지침은
AI에 전달되는 요청이며 운영체제의 쓰기 권한을 제한하는 장치는 아닙니다.

기본값은 보고서를 읽은 뒤 **인수인계 확인 · 다음 단계 실행**을 누르는 방식입니다.
자동 진행을 켜면 유효한 보고서와 실행 상태를 확인해 다음 역할로 연결합니다.
입력 대기, 실패한 검사, 보고된 문제, 실행 중단을 확인하면 자동 진행을 멈춥니다.
처음부터 실행이 보이지 않는 경우에는 중복 실행을 막기 위해 상태 확인을 기다립니다.

첫 버전은 **현재 컴퓨터의 프로젝트에서 순차 실행**합니다. 보고서는 프로젝트의
`.ai-hub/team/`에 남고, **기록 내보내기**로 Markdown 인수인계 문서를 만들 수 있습니다.
보고서에 표시하는 테스트 결과는 AI가 제출한 내용입니다.
자세한 조작법과 자동 진행 조건은 [AI 팀 사용 안내](docs/TEAM.md)를 참고하세요.

## Windows 설치

Windows x64용 패키지를 우선 배포합니다. PowerShell, Windows의 `curl.exe`와 `tar.exe`가 필요합니다.

1. [최신 안정 버전 ZIP](https://github.com/q1926313-art/AI-HUB/releases/latest/download/AI-Hub-windows-x86_64.zip)을 내려받습니다.
2. ZIP 전체의 압축을 풀고, 풀린 폴더 안의 **`herdr-app/Install.cmd`**를 실행합니다.
3. 설치가 끝나면 시작 메뉴의 **AI Hub**를 엽니다.

기존 버전을 다시 설치할 때는 먼저 앱 창을 종료하세요. PowerShell에서 설치하려면
정식 배포본에 포함된 설치 스크립트를 사용할 수도 있습니다.

```powershell
irm https://github.com/q1926313-art/AI-HUB/releases/latest/download/install.ps1 | iex
```

PowerShell 설치 명령은 이 저장소의 배포 목록과 SHA-256을 확인해 패키지를 내려받습니다.
기본 설치 위치는 `%LOCALAPPDATA%\Programs\AI-Hub`이며 **AI Hub** 시작 메뉴 바로가기를 만듭니다.
필요한 `herdr-core` 실행 엔진이 없으면 공식 실행 엔진 설치 프로그램을 사용합니다.
버전별 파일과 변경 사항은 [Releases](https://github.com/q1926313-art/AI-HUB/releases)에서 확인할 수 있습니다.

## 사용

시작 메뉴에서 **AI Hub**를 열고 탭 표시줄의 `+`에서 프로그램을 실행합니다.
작업별로 공간과 탭을 나누고, 사이드바에서 에이전트를 선택합니다.

호환성을 위해 내부 실행 파일과 명령 이름은 `herdr-app`을 유지합니다.
원본 Herdr도 설치되어 있다면 시작 메뉴의 **AI Hub**를 사용하거나 PowerShell에서
`& "$env:LOCALAPPDATA\Programs\AI-Hub\herdr-app.exe"`로 명시적으로 실행하세요.

```sh
herdr-app --help
herdr-app ls
herdr-app status
herdr-app commands
herdr-app --skill
```

앱의 기본 설정 폴더는 `~/.config/ai-hub`입니다. `AI_HUB_HOME`으로 바꿀 수 있습니다.
기존 도구의 격리 실행을 보존하기 위해 `HERDR_APP_HOME`이 명시되어 있으면 그 값을 우선합니다.
`herdr-core`의 프로토콜, 공유 작업 문서, JavaScript 모듈 이름 `herdr`는 유지합니다.

## 앱 업데이트

설치된 Windows 패키지는 **이 저장소의 GitHub Releases**에서 새 버전을 자동으로 확인하고 내려받습니다.
바로 확인하려면 **Settings → Updates → Check now**를 누르세요.
다운로드가 준비되면 **Restart to update**를 눌러 새 버전으로 다시 엽니다.

같은 설정 폴더를 사용하면 개인 설정, 사용자 정의 팀 역할과 기존 팀 작업 기록을 이어서 사용합니다.
프로젝트 파일과 프로젝트 안의 팀 보고서는 재설치 대상에 포함되지 않습니다.
역할 설정 변경은 새 팀 작업에 적용하며, 이미 만든 작업의 담당과 보고서는 유지합니다.

- `herdr-core`는 별도 의존성이므로 공식 실행 엔진의 설치·업데이트 경로를 유지합니다.
- 소스에서 직접 빌드한 개발용 앱은 기본적으로 자동 업데이트하지 않습니다.

앱 업데이트용 테스트·미러 주소는 `AI_HUB_RELEASES_URL`, 실행 엔진용 주소는
기존 `HERDR_RELEASES_URL`로 분리합니다. 두 주소는 서로 바꾸어 사용하지 않습니다.

## 개인정보

- 사용 통계 전송 주소는 기본값이 없습니다. 로컬 통계 및 기존 설정 기능은 남겨 두며,
  외부 전송은 `AI_HUB_TELEMETRY_URL` 또는 명시적 호환용 환경변수를 설정한 경우에만 가능합니다.
- 오류 보고의 기본 대상은 이 저장소입니다. 원본 프로젝트의 수집 서버로 자동 전송하지 않습니다.

## 소스에서 빌드

```sh
git clone --recurse-submodules https://github.com/q1926313-art/AI-HUB.git
cd AI-HUB
just build
just test
just install
```

원본 기준 도구는 **Rust 1.95.0, Zig 0.16.0, just**입니다.
Windows에서는 MSVC 빌드 도구와 LLVM/libclang도 필요합니다.
운영체제별 의존성과 정확한 명령은 [CI 구성](.github/workflows/ci.yml)을 참고하세요.
하위 모듈을 누락했다면 `git submodule update --init --recursive`로 받습니다.

Windows 빌드 자동화는 실행 파일, 설치 스크립트, 라이선스가 포함된 산출물을 만듭니다.
`main`에 새 숫자 버전을 반영하면 같은 커밋의 Linux·macOS·Windows 검사와 Windows 패키징이
통과한 뒤, 배포 파일과 태그 검증을 마친 정식 버전을 Releases에 자동 공개합니다.
검사에 실패한 버전은 공개하지 않으며, 이미 공개한 버전을 다른 커밋으로 덮어쓰지 않습니다.
버전을 올리는 방법과 재시도 조건은 [배포 관리 안내](docs/RELEASING.md)에 있습니다.
상위 프로젝트의 서명 인증서나 배포용 비밀값은 사용하지 않습니다.

## 출처와 라이선스

원본 기준 커밋은 `2d1464e02ddad5484eaaf9a5b59b594e3930aeba`입니다.
소스·변경 내역은 Git 이력으로 추적하며, 원본 라이선스와 의존성 고지를 보존합니다.

- [LICENSE](LICENSE): Apache License 2.0
- [NOTICE](NOTICE): 독립 배포판 안내와 초기 수정 범위
- [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES): 포함된 제3자 라이선스
- [원본 README 보관본](docs/upstream/README.md)
- [터미널 실행 엔진 herdr-core](https://github.com/herdrdev/herdr-core)
