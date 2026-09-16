#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""여러 수집기(collect_cheonan.py, collect_korea.py)가 공유하는 로직.

키워드·주제 분류 규칙과 data/ 파일 입출력(월별 병합, index.json/topics.json/
agencies.json 재계산)을 한 곳에 모아둔다. 두 수집기가 각자 복사해 두면
"AX 뉴스로 칠 키워드"나 "합계 계산 방식"이 조용히 갈라질 수 있어서 공유한다.
"""
from __future__ import annotations

import html as html_mod
import json
import re
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
KST = timezone(timedelta(hours=9))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126 Safari/537.36")

# 제목에 이 키워드가 있으면 tier1(핵심), 아래 인접 키워드로만 걸리면 accepted.
TIER1_KEYWORDS = ["인공지능", "AI", "AX", "생성형", "챗GPT", "ChatGPT",
                  "머신러닝", "딥러닝", "LLM", "에이전트"]
ADJACENT_KEYWORDS = ["스마트도시", "스마트시티", "디지털전환", "빅데이터", "디지털트윈",
                     "자율주행", "로봇", "데이터"]
SEARCH_KEYWORDS = TIER1_KEYWORDS + ADJACENT_KEYWORDS

# 보도자료에서 "AI"는 조류인플루엔자(Avian Influenza)를 뜻하는 경우가 많다.
# 제목 검색이라 본문 오탐은 적지만, 축산·방역 맥락이면 AX 뉴스가 아니므로 뺀다.
AI_FALSE_POSITIVE = re.compile(
    r"조류\s*인플루엔자|조류독감|고병원성|가금|산란계|살처분|방역대|구제역|축산농가")

# 주제 자동 분류 규칙 — 위에서부터 먼저 맞는 것이 대표 주제(primary_topic)가 된다.
# data/topics.json 의 13개 주제 id 와 반드시 일치해야 한다.
TOPIC_RULES = [
    ("genai",     r"생성형|챗GPT|ChatGPT|LLM|거대언어|초거대"),
    ("agent",     r"에이전트|챗봇|상담봇|AI\s*비서|명예직원"),
    ("physical",  r"로봇|드론|웨어러블|자율주행|자율차|무인"),
    ("smartcity", r"스마트도시|스마트시티"),
    ("talent",    r"교육|인재|양성|강좌|특강|실습|아카데미|연수|경진대회|학교|평생학습|직무교육"),
    ("industry",  r"제조|스마트공장|산단|산업단지|기업|공장|생산|소부장|반도체|모빌리티"),
    ("infra",     r"데이터센터|GPU|컴퓨팅|인프라|클라우드|전산|서버"),
    ("startup",   r"창업|스타트업|투자|벤처|육성|공모\s*선정|유치"),
    ("security",  r"안전|보안|재난|화재|방범|관제|사고|위험|응급|침수"),
    ("data",      r"데이터|빅데이터|분석|공공데이터|통계|디지털트윈"),
    ("public",    r"행정|시민|복지|돌봄|민원|서비스|건강|의료|보건|도서관|관광|농업|영농|교통|버스"),
    ("law",       r"조례|법|제도|거버넌스|윤리|규제|지침|정책\s*수립|전략\s*수립"),
    ("diplomacy", r"협약|MOU|국제|글로벌|해외|교류|협력\s*체계|자매도시"),
]
TOPIC_IDS = [t for t, _ in TOPIC_RULES] + ["other"]

SUMMARY_MODEL = "claude-opus-5"
SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "string",
            "description": "각 줄이 '(라벨) 내용' 형식인 4~8줄 한국어 요약. 줄바꿈으로 구분.",
        },
        "subtitle": {"type": "string", "description": "부제 한 줄 (40자 내외)"},
        "topics": {"type": "array", "items": {"type": "string"}},
        "primary_topic": {"type": "string"},
        "keywords": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "subtitle", "topics", "primary_topic", "keywords"],
    "additionalProperties": False,
}


def summary_system(source_label: str) -> str:
    return (
        f"너는 대한민국 {source_label}를 정확히 요약하는 정책 분석가다.\n"
        "반드시 제공된 본문에 실제로 적힌 사실만 쓴다. 본문에 없는 수치·기관명·일정·예산을 "
        "절대 만들어내지 않는다. 확인되지 않는 내용은 아예 쓰지 않는다.\n"
        "summary 의 각 줄은 '(라벨) 내용' 형식이며 라벨은 다음 중에서 고른다: "
        "(내용) (배경) (현황) (방식) (계획) (효과) (규모) (협력) (일정).\n"
        "topics 와 primary_topic 은 반드시 다음 id 중에서만 고른다: " + ", ".join(TOPIC_IDS) + "."
    )


# ---------------------------------------------------------------- 시간 예산


class Budget:
    """실행 시간 예산. 초과하면 남은 작업을 다음 실행으로 넘긴다.

    워크플로의 timeout-minutes 에 걸려 잡이 강제 종료되면 수집분까지 통째로
    날아간다(요약이 merge_month_files 앞에 있어서 파일에 아무것도 안 쓰인 상태).
    그래서 잡 타임아웃보다 먼저 스스로 멈추고, 그때까지 모은 건 반드시 저장한다.
    수집기는 며칠치를 겹쳐 조회하고 요약도 보충 패스가 있으니, 넘긴 작업은
    다음 실행에서 이어서 처리된다.
    """

    def __init__(self, minutes: float):
        self.seconds = max(0.0, minutes * 60)
        self.started = time.monotonic()

    @property
    def remaining(self) -> float:
        return self.seconds - (time.monotonic() - self.started)

    @property
    def expired(self) -> bool:
        return self.seconds > 0 and self.remaining <= 0

    def __str__(self) -> str:
        if self.seconds <= 0:
            return "시간 예산 없음(무제한)"
        return f"{self.seconds / 60:.0f}분 예산 중 {max(0.0, self.remaining) / 60:.1f}분 남음"


# ---------------------------------------------------------------- HTTP


def http_get(url: str, retries: int = 3, pause: float = 0.35) -> str:
    """공공기관 서버는 트래픽이 적다. 재시도 간격을 넉넉히 두고 예의 있게 긁는다."""
    last = None
    for attempt in range(1, retries + 1):
        try:
            req = Request(url, headers={"User-Agent": UA, "Accept-Language": "ko"})
            with urlopen(req, timeout=90) as r:
                raw = r.read()
            time.sleep(pause)
            return raw.decode("utf-8", errors="replace")
        except (HTTPError, URLError, TimeoutError, OSError) as e:
            last = e
            if attempt < retries:
                time.sleep(2 * attempt)
    raise RuntimeError(f"GET 실패: {url} ({last})")


def strip_html(fragment: str) -> str:
    s = re.sub(r"(?s)<script.*?</script>", " ", fragment)
    s = re.sub(r"(?s)<style.*?</style>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = re.sub(r"(?i)</p>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html_mod.unescape(s).replace(" ", " ")
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in s.split("\n")]
    return "\n".join(ln for ln in lines if ln)


# ---------------------------------------------------------------- 분류


def tier_of(title: str) -> tuple[str, str]:
    for kw in TIER1_KEYWORDS:
        if kw.lower() in title.lower():
            return "tier1", "제목에 AI 핵심 키워드 포함"
    return "accepted", "제목의 인접 키워드로 AX 밀접 판정"


def guess_topics(title: str, body: str) -> tuple[list, str]:
    text = f"{title}\n{body}"
    hits = [tid for tid, pat in TOPIC_RULES if re.search(pat, text)]
    if not hits:
        return ["other"], "other"
    return hits[:3], hits[0]


def make_snippet(body: str, limit: int = 140) -> str:
    for line in body.split("\n"):
        if len(line) >= 40 and not line.startswith("-"):
            return line[:limit] + ("…" if len(line) > limit else "")
    flat = " ".join(body.split("\n"))[:limit]
    return flat


def make_subtitle(body: str, limit: int = 60) -> str:
    for line in body.split("\n")[:3]:
        if line.startswith("-"):
            s = line.lstrip("-").strip()
            return s[:limit] + ("…" if len(s) > limit else "")
    return ""


# ---------------------------------------------------------------- 파일 IO


def load_json(path: Path, fallback):
    if not path.exists():
        return fallback
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def all_news() -> list:
    rows = []
    for path in sorted((DATA / "news").glob("[0-9][0-9][0-9][0-9]-[0-9][0-9].json")):
        rows.extend(load_json(path, []))
    return rows


def merge_month_files(records: list, dry: bool) -> tuple[int, int]:
    """월별 파일에 기사를 병합한다. 같은 id 는 갱신, 없으면 추가."""
    by_month = defaultdict(list)
    for r in records:
        by_month[r["published"][:7]].append(r)

    added = updated = 0
    for month, rows in sorted(by_month.items()):
        path = DATA / "news" / f"{month}.json"
        existing = load_json(path, [])
        index = {n["id"]: i for i, n in enumerate(existing)}
        for r in rows:
            if r["id"] in index:
                prev = existing[index[r["id"]]]
                # 최초 수집 시각은 보존한다(NEW 배지 판정에 쓰인다).
                r["first_seen"] = prev.get("first_seen", r["first_seen"])
                existing[index[r["id"]]] = r
                updated += 1
            else:
                existing.append(r)
                added += 1
        existing.sort(key=lambda n: (n.get("published", ""), n.get("id", "")), reverse=True)
        if not dry:
            save_json(path, existing)
    return added, updated


def rebuild_index(dry: bool) -> dict:
    """news/index.json 을 월별 파일에서 통째로 다시 계산한다(합계가 항상 맞도록)."""
    rows = all_news()
    months = sorted({p.stem for p in (DATA / "news").glob("[0-9][0-9][0-9][0-9]-[0-9][0-9].json")})
    by_agency: dict = defaultdict(int)
    by_tier: dict = defaultdict(int)
    for n in rows:
        by_agency[n.get("agency_id", "?")] += 1
        by_tier[n.get("tier", "accepted")] += 1

    prev = load_json(DATA / "news" / "index.json", {})
    # 기존 기관 순서를 유지하고 새 기관은 뒤에 붙인다(diff 를 읽기 쉽게).
    ordered = {k: by_agency[k] for k in prev.get("byAgency", {}) if k in by_agency}
    for k, v in by_agency.items():
        ordered.setdefault(k, v)

    doc = {
        "updated": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "months": months,
        "total": len(rows),
        "byAgency": ordered,
        "byTier": {k: by_tier[k] for k in ("tier1", "accepted") if k in by_tier},
    }
    if not dry:
        save_json(DATA / "news" / "index.json", doc)
    return doc


def rebuild_topics(dry: bool, pinned_agency_id: str = "cheonan") -> dict:
    """topics.json 의 matrix/totals/quarters/newsTotal/topTopic 을 다시 계산한다.

    matrix 는 primary_topic 1건당 1카운트다(원본 데이터에서 matrix 총합 == 전체
    뉴스 건수인 것으로 검증했다). pinned_agency_id 를 넣고도 이 항등식이 유지돼야 한다.
    """
    doc = load_json(DATA / "topics.json", None)
    if not doc:
        return {}
    topic_ids = [t["id"] for t in doc.get("topics", [])]
    rows = all_news()

    matrix: dict = {}
    totals: dict = defaultdict(int)
    quarters: dict = defaultdict(lambda: defaultdict(int))
    for n in rows:
        tid = n.get("primary_topic") or (n.get("topics") or ["other"])[0]
        if tid not in topic_ids:
            tid = "other"
        aid = n.get("agency_id", "?")
        matrix.setdefault(aid, {t: 0 for t in topic_ids})
        matrix[aid][tid] += 1
        totals[tid] += 1
        pub = n.get("published", "")
        if len(pub) >= 7:
            q = f"{pub[:4]}-Q{(int(pub[5:7]) - 1) // 3 + 1}"
            quarters[q][tid] += 1

    # 지정된 기관(기본 천안시)이 항상 맨 앞에 오도록 기관 순서를 잡는다
    # (화면 정렬과 별개로 데이터도 일관되게).
    agencies = [pinned_agency_id] if pinned_agency_id in matrix else []
    agencies += [a for a in doc.get("agencies", []) if a in matrix and a != pinned_agency_id]
    agencies += [a for a in matrix if a not in agencies]

    top_id = max(totals, key=lambda k: totals[k]) if totals else None
    doc["updated"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    doc["agencies"] = agencies
    doc["matrix"] = {a: matrix[a] for a in agencies}
    doc["totals"] = {t: totals.get(t, 0) for t in topic_ids}
    doc["quarters"] = {q: dict(quarters[q]) for q in sorted(quarters)}
    doc["newsTotal"] = len(rows)
    if top_id:
        name = next((t["name"] for t in doc["topics"] if t["id"] == top_id), top_id)
        doc["topTopic"] = {"id": top_id, "name": name, "count": totals[top_id]}
    if not dry:
        save_json(DATA / "topics.json", doc)
    return doc


def sync_agency_counts(dry: bool) -> None:
    """agencies.json 의 newsCount 를 실제 건수와 맞춘다(사이드바 정렬 기준)."""
    doc = load_json(DATA / "agencies.json", None)
    if not doc:
        return
    counts: dict = defaultdict(int)
    for n in all_news():
        counts[n.get("agency_id", "?")] += 1
    for a in doc.get("agencies", []):
        a["newsCount"] = counts.get(a["id"], 0)
    if not dry:
        save_json(DATA / "agencies.json", doc)


# ---------------------------------------------------------------- AI 요약


def summarize(records: list, bodies: dict, dry: bool, source_label: str,
              budget: "Budget | None" = None) -> int:
    import os

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("  ANTHROPIC_API_KEY 없음 — AI 요약을 건너뜁니다.")
        return 0
    try:
        import anthropic
    except ImportError:
        print("  anthropic 패키지 없음 (pip install anthropic) — AI 요약을 건너뜁니다.")
        return 0

    client = anthropic.Anthropic(api_key=api_key)
    system = summary_system(source_label)
    done = deferred = 0
    out_of_budget = False
    by_month = defaultdict(list)
    for r in records:
        by_month[r["published"][:7]].append(r)

    for month, rows in sorted(by_month.items()):
        path = DATA / "summaries" / f"{month}.json"
        store = load_json(path, {})
        changed = False
        for r in rows:
            if r["id"] in store and store[r["id"]].get("summary"):
                continue
            body = bodies.get(r["id"], "")
            if len(body) < 80:
                continue
            # 예산이 끝나도 break 하지 않고 끝까지 훑는다 — 남은 건수를 정확히
            # 세고, 이미 요약한 달의 store 를 빠짐없이 저장하기 위해서다.
            if out_of_budget or (budget is not None and budget.expired):
                out_of_budget = True
                deferred += 1
                continue
            prompt = (f"다음은 {source_label}다.\n\n"
                      f"제목: {r['title']}\n담당: {r.get('dept', '')}\n"
                      f"발행일: {r['published']}\n\n본문:\n{body}")
            try:
                resp = client.messages.create(
                    model=SUMMARY_MODEL,
                    max_tokens=4000,
                    system=system,
                    messages=[{"role": "user", "content": prompt}],
                    output_config={"format": {"type": "json_schema",
                                              "schema": SUMMARY_SCHEMA}},
                )
            except Exception as e:  # 한 건 실패가 전체 수집을 막지 않게 한다.
                print(f"  요약 실패 {r['id']}: {e}")
                continue
            text = next((b.text for b in resp.content if b.type == "text"), "")
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                print(f"  요약 파싱 실패 {r['id']}")
                continue
            store[r["id"]] = {
                "summary": parsed["summary"],
                "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            }
            if parsed.get("subtitle"):
                r["subtitle"] = parsed["subtitle"]
            topics = [t for t in parsed.get("topics", []) if t in TOPIC_IDS]
            if topics:
                r["topics"] = topics[:3]
            if parsed.get("primary_topic") in TOPIC_IDS:
                r["primary_topic"] = parsed["primary_topic"]
            changed = True
            done += 1
            print(f"  요약 {done}건째 · {r['title'][:36]}")
            # 잡이 강제 종료돼도 여기까지는 남도록 주기적으로 flush 한다.
            if done % 10 == 0 and not dry:
                save_json(path, store)
        if changed and not dry:
            save_json(path, store)

    if out_of_budget:
        print(f"  ⏱ 요약 시간 예산 초과 — {done}건 완료, 남은 {deferred}건은 다음 실행으로 넘깁니다.")
    return done


def summarized_ids() -> set:
    """AI 요약이 이미 붙어 있는 기사 id 집합."""
    have = set()
    for path in (DATA / "summaries").glob("[0-9][0-9][0-9][0-9]-[0-9][0-9].json"):
        for nid, s in load_json(path, {}).items():
            if s.get("summary"):
                have.add(nid)
    return have


def stored_ids(collector: str) -> set:
    """해당 수집기가 이미 저장해 둔 기사 id 집합."""
    return {n["id"] for n in all_news() if n.get("collector") == collector}


def pending_summary_records(collector: str) -> tuple[list, dict]:
    """이미 저장돼 있지만 요약이 아직 없는 기사를 모아 온다(요약 보충 패스용).

    korea.kr 수집기는 저장된 newsId 를 재수집 대상에서 빼기 때문에, 시간 예산이나
    API 오류로 한 번 요약이 밀린 기사는 이 패스가 없으면 영영 요약되지 않는다.
    본문은 수집 때 기사에 저장해 둔 snippet 을 그대로 쓴다(상세 페이지를 다시
    긁지 않아도 되는 수집기에만 해당).
    """
    have = summarized_ids()

    records, bodies = [], {}
    for n in all_news():
        if n.get("collector") != collector or n["id"] in have:
            continue
        body = n.get("snippet", "")
        if len(body) < 80:  # summarize() 가 어차피 건너뛴다.
            continue
        records.append(n)
        bodies[n["id"]] = body
    records.sort(key=lambda n: n.get("published", ""), reverse=True)
    return records, bodies
