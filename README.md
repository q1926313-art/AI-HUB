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

사이드바 하단의 **AI 팀**을 열고 프로젝트 폴더, 작업 이름, 목표와 완료 조건을 입력하세요.
여러 AI가 역할을 나누고, 앞 단계의 보고서를 받아 순서대로 작업합니다.

| 순서 | 기본 담당 | 하는 일 |
|---|---|---|
| 계획 | Claude Code | 요청 범위와 구현 순서, 확인 기준 정리 |
| 구현 | OpenCode Go · DeepSeek V4.1 Flash | 코드 변경과 필요한 검사 실행 |
| 검토 | Codex | 변경 내용과 회귀 가능성 검토 |
| 검증 | Claude Code | 검사 결과와 남은 문제 확인 |

**역할 설정**에서 역할 이름·순서·지침·작업 방식을 바꾸고, 최대 8개 역할을 추가·삭제하거나 끌 수 있습니다.
담당 도구와 모델도 역할마다 지정합니다. OpenCode는 설치된 CLI의 모델 목록을 불러와 선택하거나
정확한 `provider/model` 값을 입력할 수 있습니다. Claude Code·Codex는 모델 이름을 직접 지정할 수 있습니다.

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

1. [Releases](https://github.com/q1926313-art/AI-HUB/releases)에서 Windows 배포본을 확인합니다.
2. 배포본이 생성되어 있으면 PowerShell에서 다음 설치 명령을 실행합니다.

```powershell
irm https://raw.githubusercontent.com/q1926313-art/AI-HUB/main/distribution/install.ps1 | iex
```

설치 스크립트는 이 저장소의 배포 목록과 SHA-256을 확인하고, 기본적으로
`%LOCALAPPDATA%\Programs\AI-Hub`에 설치한 뒤 **AI Hub** 시작 메뉴 바로가기를 만듭니다.
필요한 `herdr-core` 실행 엔진이 없으면 공식 실행 엔진 설치 프로그램을 사용합니다.

아직 Releases가 없다면 [Actions](https://github.com/q1926313-art/AI-HUB/actions)의
Windows 빌드 결과를 확인하거나 아래 절차로 소스에서 빌드할 수 있습니다.
빌드 중이거나 실패한 실행을 설치 성공으로 간주하지 마세요.

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

## 업데이트와 개인정보

- AI Hub 앱 업데이트는 **이 저장소의 GitHub Releases**를 확인합니다.
- `herdr-core`는 별도 의존성이므로 공식 실행 엔진의 설치·업데이트 경로를 유지합니다.
- 소스에서 직접 빌드한 개발용 앱은 기본적으로 자동 업데이트하지 않습니다.
- 사용 통계 전송 주소는 기본값이 없습니다. 로컬 통계 및 기존 설정 기능은 남겨 두며,
  외부 전송은 `AI_HUB_TELEMETRY_URL` 또는 명시적 호환용 환경변수를 설정한 경우에만 가능합니다.
- 오류 보고의 기본 대상은 이 저장소입니다. 원본 프로젝트의 수집 서버로 자동 전송하지 않습니다.

앱 업데이트용 테스트·미러 주소는 `AI_HUB_RELEASES_URL`, 실행 엔진용 주소는
기존 `HERDR_RELEASES_URL`로 분리합니다. 두 주소는 서로 바꾸어 사용하지 않습니다.

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
`v*` 태그를 사용하는 릴리스 흐름은 이 저장소에 배포 파일과 업데이트 목록을 게시합니다.
상위 프로젝트의 서명 인증서나 배포용 비밀값은 사용하지 않습니다.

## 출처와 라이선스

원본 기준 커밋은 `2d1464e02ddad5484eaaf9a5b59b594e3930aeba`입니다.
소스·변경 내역은 Git 이력으로 추적하며, 원본 라이선스와 의존성 고지를 보존합니다.

- [LICENSE](LICENSE): Apache License 2.0
- [NOTICE](NOTICE): 독립 배포판 안내와 초기 수정 범위
- [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES): 포함된 제3자 라이선스
- [원본 README 보관본](docs/upstream/README.md)
- [터미널 실행 엔진 herdr-core](https://github.com/herdrdev/herdr-core)
