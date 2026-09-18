# 천안 AX 인사이트

정부 부처와 **천안시**의 인공지능 전환(AX) 보도자료를 한곳에서 보는 정적 웹사이트입니다.
지식재산처용 [Gov.AX Insight](https://kklique.github.io/ipax-govnews/)를 천안시 관점으로 개조했습니다.

- 정부 부처 보도자료: 대한민국 정책브리핑(korea.kr) 수집분 — 2025-07 이후 1,979건
- 천안시 보도자료: 천안시 누리집 보도자료 게시판 직접 수집분 — 61건
- 화면 어디에서나 **천안시가 기관 목록 맨 위에 고정**됩니다(보도자료 건수와 무관).

## 미리보기

`data/*.json` 을 `fetch()` 로 읽기 때문에 `index.html` 을 파일로 직접 열면(`file://`) 아무것도
표시되지 않습니다. 반드시 HTTP 로 띄우세요.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\serve.ps1          # http://localhost:8000
powershell -ExecutionPolicy Bypass -File scripts\serve.ps1 -Port 8080
```

윈도우 기본 PowerShell만 있으면 되고 별도 설치가 필요 없습니다.

## 폴더 구조

```
index.html              화면 전체(탭 6개: 뉴스·마일스톤·히트맵·월별추이·AI 리포트·안내)
assets/
  app.js                모든 렌더링 로직
  style.css             천안시 CI 기반 디자인 시스템
  fonts.css, fonts/     Pretendard 로컬 호스팅(내부망 대응 — CDN 미사용)
data/
  agencies.json         기관 마스터(분류 5종: 대통령실·위원회·부·처청·지자체)
  news/YYYY-MM.json     월별 보도자료 배열
  news/index.json       총계·기관별·등급별 집계(월별 파일에서 재계산)
  summaries/YYYY-MM.json  기사 id → AI 요약
  topics.json           13개 AX 주제 × 기관 매트릭스(히트맵 원본)
  keywords.json         키워드 관계망(사전 계산된 좌표 포함)
  milestones.json       정책 마일스톤 타임라인
  reports/index.json    리포트 탭 보고서 목록(reports) + 지식재산처 관점 원본 보관 목록(archived)
  reports/highlights.json  리포트 탭 「AX 주요 동향」(최신 전체 보고서의 한눈에 보기)
  reports/cheonan/      천안시 관점 AI 동향보고서(json/md/html) — build_reports.py 가 생성
  reports/*.md|html|pdf 지식재산처 관점 원본 보고서 보관본(화면 비노출)
scripts/
  _common.py            두 수집기가 공유하는 키워드·주제분류·파일 IO·AI 요약 로직
  collect_korea.py      정부 부처 보도자료 수집기 (korea.kr)
  collect_cheonan.py    천안시 보도자료 수집기 (cheonan.go.kr)
  build_reports.py      천안시 관점 AI 동향보고서(분기·전체) 생성기
  serve.ps1             로컬 미리보기 서버
.github/workflows/collect.yml   매일 07:20 KST 정부 부처+천안시 자동 수집·커밋
.github/workflows/reports.yml   매월 1일 12:00 KST AI 동향보고서 생성·커밋(수동 실행 가능)
```

## 보도자료 수집기

정책브리핑(korea.kr)은 정부 부처만 다루고 지자체 보도자료는 없기 때문에, 정부 부처와
천안시를 서로 다른 수집기로 나눠 각자의 출처에서 직접 수집합니다. 둘 다 `scripts/_common.py`의
같은 키워드·주제분류 규칙과 파일 병합/재계산 로직을 공유합니다.

```bash
python scripts/collect_korea.py                    # 정부 부처(46곳) 수집
python scripts/collect_korea.py --lookback-days 30  # 조회 기간 조정(기본 10일, 겹쳐서 조회)
python scripts/collect_cheonan.py                   # 천안시 수집
python scripts/collect_cheonan.py --no-summary      # AI 요약 생략(두 스크립트 공통 옵션)
python scripts/collect_cheonan.py --dry-run         # 파일을 쓰지 않고 결과만 출력(두 스크립트 공통)
python scripts/collect_korea.py --budget-min 0      # 시간 예산 해제(기본 부처 25분 / 천안시 10분)
python scripts/collect_cheonan.py --refresh         # 저장된 기사 본문까지 전부 다시 읽기
```

- **판정**: 제목에 `인공지능·AI·AX·생성형·LLM` 등이 있으면 `tier1`, `스마트도시·스마트시티·빅데이터·자율주행·로봇·데이터`
  등 인접 키워드로만 걸리면 `accepted`. 축산 방역 맥락의 `AI`(조류인플루엔자)는 제외합니다.
- **id**: `sha256("koreakr:" + newsId)[:16]` / `sha256("cheonan:" + nttId)[:16]` — 재수집해도 값이
  변하지 않아 중복이 생기지 않습니다. `collect_korea.py`는 추가로 기존 기사 `url`에서 `newsId`를
  직접 뽑아 대조하므로, 이식 시점에 들어온 과거분과도 절대 겹치지 않습니다.
- `collect_korea.py`는 상세 페이지를 열지 않고 목록 페이지의 리드문(lead)·발행일·기관명만으로
  기사를 구성합니다 — 상세 페이지 본문은 PDF/한글 파일을 변환한 iframe 뷰어라 텍스트 추출이
  불안정합니다.
- `collect_cheonan.py`는 목록은 매번 전체를 훑되, 상세 페이지(본문)는 **신규 기사와 아직 요약이
  없는 기사만** 읽습니다. 누적 기사가 늘수록 실행시간이 같이 늘어나 시간 예산을 정작 신규 기사
  요약에 못 쓰기 때문입니다(65건 기준 67초 → 28초). 저장된 기사의 snippet·부제·주제를 최신
  본문으로 다시 만들려면 `--refresh` 를 줍니다.
- **AI 요약**: 환경변수 `ANTHROPIC_API_KEY` 가 있을 때만 수행하고, 없으면 조용히 건너뜁니다.
  요약이 없는 기사도 화면에는 정상 표시됩니다(제목 클릭 시 원문으로 이동).
- **시간 예산**(`--budget-min`): 요약 시간은 그날 기사 수에 따라 크게 출렁입니다. 예산을 넘기면
  남은 작업을 다음 실행으로 넘기고, **그때까지 수집한 건 반드시 저장·커밋**합니다. 워크플로
  `timeout-minutes` 에 걸려 잡이 강제 종료되면 요약이 병합보다 앞에 있어서 그날치가 통째로
  날아가기 때문입니다. 조회기간을 10일씩 겹쳐 잡고, `collect_korea.py` 는 남은 시간에 지난 실행에서
  밀린 요약을 보충하므로 넘긴 작업은 다음 실행에서 이어집니다.
- 수집 후 `news/index.json` · `topics.json` · `agencies.json[].newsCount` 를 **월별 파일에서 통째로
  다시 계산**하므로 합계가 어긋나지 않습니다.

## AI 동향보고서

`scripts/build_reports.py` 가 수집된 보도자료와 AI 요약을 근거로 **천안시 관점** 동향보고서를
Claude(`claude-opus-5`)로 만듭니다. `ANTHROPIC_API_KEY` 가 없으면 아무것도 쓰지 않고 오류로 끝납니다.

```bash
python scripts/build_reports.py --dry-run          # API 호출 없이 무엇을 만들지와 입력 크기만 출력
python scripts/build_reports.py --quarter 2025-Q3  # 분기 하나만 생성(가장 작은 분기 — 첫 시험용)
python scripts/build_reports.py                    # 필요한 것만 생성
python scripts/build_reports.py --force            # 확정된 분기까지 전부 다시 생성
python scripts/build_reports.py --render-only      # 저장된 json 으로 md/html·목록만 다시 그림(무료)
```

- **분기 보고서**: 진행 중인 분기는 실행마다 다시 만들고, 끝난 분기는 끝난 뒤 한 번 더 만들어
  확정(`complete`)한 다음부터는 건드리지 않습니다. 기사 40건 미만인 분기(분기 첫날 등)는 건너뜁니다.
- **전체 보고서**: 기사 2천여 건을 한 번에 넣으면 컨텍스트 한도에 가깝고 비싸서, 분기 보고서들과
  천안시 보도자료 전체를 입력으로 종합합니다. 최신 전체 보고서의 「한눈에 보기」가 리포트 탭
  하단 「AX 주요 동향」(`highlights.json`)으로 들어갑니다.
- **출처 검증**: 모델에는 기사마다 id 를 붙여 넘기고 근거를 id 로만 돌려받습니다. 링크는 스크립트가
  `data/news` 에서 찾아 붙이므로 모델이 URL 을 지어낼 수 없고, 입력에 없는 id 는 버리며 근거가
  하나도 남지 않은 항목은 뺍니다(버린 수는 보고서 json 의 `validation` 과 로그 경고로 남습니다).
  건수·통계도 모델이 아니라 스크립트가 계산합니다.
- **비용**(Opus 5 기준 추정): 분기 보고서 1건 약 $1~2, 전체 약 $1. 첫 실행(분기 5건 + 전체)은
  약 $10, 이후 매월 실행은 약 $3. 실행 로그에 보고서별 토큰 수와 추정 비용이 찍힙니다.
- 새 보고서는 `data/reports/cheonan/` 에 둡니다. `data/reports/` 바로 아래 지식재산처 관점 원본과
  파일명(`quarter-2026-Q3.md` 등)이 겹치기 때문입니다.

## 천안시 관점으로 바꾼 부분

| 영역 | 내용 |
|---|---|
| 기관 고정 | `HOME_AGENCY_ID = "cheonan"` (app.js) — 사이드바·히트맵·월별추이 카드에서 항상 첫 자리 |
| 분류 | `local`(지자체) 분류와 필터 칩 신설 |
| 벤치마킹 | 천안시 자체 기사를 제외하고, 공공행정·데이터·인프라 주제와 지자체 적용 신호가 있는 사례에 가산점 |
| 세부주제 | 공공행정에 `지방행정·지자체 AX` 버킷 추가 |
| 브랜드 | 천안 블루 `#2257b4` / 진한 단계 `#1c4690` / 오렌지 `#d64210` / 그린 `#00a439`(로고 심볼색) |
| 자산 | 지식재산처 로고·캐릭터 제거, 빈 결과 일러스트는 중립 SVG. **기관 로고 이미지는 쓰지 않는다** — 천안시 CI 는 사용 지침 확인 전이라 넣지 않고, 기관 표시는 헤더의 '천안시 누리집' 텍스트 링크로 대신한다 |

## 알려진 제약

1. **`data/reports/` 바로 아래 보고서 10건과 하이라이트 8건은 지식재산처 관점 원본**이라 화면에서
   내리고 `archived`/`archivedItems` 로 보관만 합니다. 리포트 탭에는 `build_reports.py` 가 만든
   천안시 관점 보고서만 나옵니다.
2. **키워드 관계망(`data/keywords.json`)은 정부 부처 940건 기준**입니다. 천안시는 최근 6개월 구간에
   28건뿐이라 상위 90개 커트라인(28건)에 드는 천안시 전용 키워드가 없어, 다시 계산해도 그림이
   사실상 바뀌지 않습니다. 원본 생성 스크립트(`build_keywords.py`)가 없어 재구현 시 기존 어휘 품질이
   달라질 위험이 있어 그대로 두었습니다.
3. 천안시 기사에 `AI 요약`을 새로 붙이려면 `ANTHROPIC_API_KEY` 가 필요합니다(현재 61건은 이미 생성됨).

## 자동 갱신

`.github/workflows/collect.yml` 이 매일 07:20 KST 에 `collect_korea.py`(정부 부처) →
`collect_cheonan.py`(천안시) 순서로 돌리고, 변경분이 있으면 커밋합니다.
`.github/workflows/reports.yml` 은 매월 1일 12:00 KST 에 `build_reports.py` 를 돌려 보고서를
갱신합니다. Actions 화면의 **Run workflow** 버튼으로 언제든 수동 실행할 수 있고, 분기 하나만
만들거나(`quarter`) 전부 다시 만들 수(`force`) 있습니다. 두 워크플로 모두 저장소 시크릿
`ANTHROPIC_API_KEY` 를 씁니다 — 등록하면 매일 수집의 AI 요약도 함께 켜집니다.
GitHub Pages 로 배포하려면 저장소를 만들고 Pages 를 `main` 브랜치 루트로 지정하면 됩니다.

---

원본: Gov.AX Insight — Designed by Buyong JEONG (2026-07-26)
