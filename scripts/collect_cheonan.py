#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""천안시 AI/AX 보도자료 수집기.

천안시 누리집 보도자료 게시판(BBSMSTR_000000000030)을 제목 키워드로 검색해
인공지능 전환(AX) 관련 보도자료를 골라내고, 이 사이트의 data/ 스키마에 맞춰
누적 저장한다. 정부 부처 데이터(korea.kr 수집분)는 건드리지 않는다.

  python scripts/collect_cheonan.py            # 수집 + 파생데이터 재계산
  python scripts/collect_cheonan.py --no-summary   # AI 요약 생략
  python scripts/collect_cheonan.py --dry-run      # 파일을 쓰지 않고 결과만 출력

AI 요약은 ANTHROPIC_API_KEY 가 있을 때만 수행한다(없으면 조용히 건너뛴다).
요약이 없는 기사도 화면에서는 정상 표시되며, 제목 클릭 시 원문으로 바로 간다.

주의: korea.kr 정책브리핑은 지자체 보도자료를 다루지 않기 때문에 천안시는
반드시 시 누리집에서 직접 수집해야 한다.
"""
from __future__ import annotations

import argparse
import hashlib
import html as html_mod
import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
KST = timezone(timedelta(hours=9))

BOARD = "https://www.cheonan.go.kr/bbs/BBSMSTR_000000000030"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126 Safari/537.36")

AGENCY_ID = "cheonan"
AGENCY_NAME = "천안시"
SOURCE_NAME = "천안시 보도자료"
SOURCE_DOMAIN = "www.cheonan.go.kr"

# 정부 부처 데이터와 같은 기간을 공유해야 월별 추이 비교가 성립한다.
START_MONTH = os.environ.get("CHEONAN_START_MONTH", "2025-07")

# 제목에 이 키워드가 있으면 tier1(핵심), 아래 인접 키워드로만 걸리면 accepted.
TIER1_KEYWORDS = ["인공지능", "AI", "AX", "생성형", "챗GPT", "ChatGPT",
                  "머신러닝", "딥러닝", "LLM", "에이전트"]
ADJACENT_KEYWORDS = ["스마트도시", "디지털전환", "빅데이터", "디지털트윈",
                     "자율주행", "로봇", "데이터"]
SEARCH_KEYWORDS = TIER1_KEYWORDS + ADJACENT_KEYWORDS

# 지자체 보도자료에서 "AI"는 조류인플루엔자(Avian Influenza)를 뜻하는 경우가 많다.
# 제목 검색이라 본문 오탐은 적지만, 축산·방역 맥락이면 AX 뉴스가 아니므로 뺀다.
AI_FALSE_POSITIVE = re.compile(
    r"조류\s*인플루엔자|조류독감|고병원성|가금|산란계|살처분|방역대|구제역|축산농가")

# 주제 자동 분류 규칙 — 위에서부터 먼저 맞는 것이 대표 주제(primary_topic)가 된다.
# data/topics.json 의 13개 주제 id 와 반드시 일치해야 한다.
TOPIC_RULES = [
    ("genai",     r"생성형|챗GPT|ChatGPT|LLM|거대언어|초거대"),
    ("agent",     r"에이전트|챗봇|상담봇|AI\s*비서|명예직원"),
    ("physical",  r"로봇|드론|웨어러블|자율주행|자율차|무인"),
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

SUMMARY_MODEL = os.environ.get("CHEONAN_SUMMARY_MODEL", "claude-opus-5")
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
SUMMARY_SYSTEM = (
    "너는 대한민국 지방자치단체 보도자료를 정확히 요약하는 정책 분석가다.\n"
    "반드시 제공된 본문에 실제로 적힌 사실만 쓴다. 본문에 없는 수치·기관명·일정·예산을 "
    "절대 만들어내지 않는다. 확인되지 않는 내용은 아예 쓰지 않는다.\n"
    "summary 의 각 줄은 '(라벨) 내용' 형식이며 라벨은 다음 중에서 고른다: "
    "(내용) (배경) (현황) (방식) (계획) (효과) (규모) (협력) (일정).\n"
    "topics 와 primary_topic 은 반드시 다음 id 중에서만 고른다: " + ", ".join(TOPIC_IDS) + "."
)


# ---------------------------------------------------------------- HTTP


def http_get(url: str, retries: int = 3, pause: float = 0.35) -> str:
    """게시판은 트래픽이 적은 지자체 서버다. 재시도 간격을 넉넉히 두고 예의 있게 긁는다."""
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
    s = html_mod.unescape(s).replace(" ", " ")
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in s.split("\n")]
    return "\n".join(ln for ln in lines if ln)


# ---------------------------------------------------------------- 수집


def scrape_list() -> dict:
    """제목 키워드로 게시판을 훑어 후보 글의 id·제목·팀명·등록일을 모은다."""
    found: dict[str, dict] = {}
    for kw in SEARCH_KEYWORDS:
        first = http_get(f"{BOARD}/list.do?searchCondition=subject"
                         f"&searchKeyword={quote(kw)}&pageIndex=1&pageUnit=21")
        m = re.search(r"총 게시물<strong>([\d,]+)</strong>", first)
        total = int(m.group(1).replace(",", "")) if m else 0
        if not total:
            print(f"  {kw:<10} 0")
            continue
        pages = (total + 20) // 21
        new = 0
        for p in range(1, pages + 1):
            page = first if p == 1 else http_get(
                f"{BOARD}/list.do?searchCondition=subject"
                f"&searchKeyword={quote(kw)}&pageIndex={p}&pageUnit=21")
            for block in page.split("fn_search_detail('")[1:]:
                nttid = block.split("'", 1)[0]
                # id 자릿수는 시기에 따라 다르다(구: B+11자리, 신규: B+12자리 + 접미사).
                if not re.fullmatch(r"B[0-9A-Za-z]{12,32}", nttid):
                    continue
                tm = re.search(r'<strong class="bbs__title">(.*?)</strong>', block)
                if not tm:
                    continue
                title = html_mod.unescape(re.sub(r"<[^>]+>", "", tm.group(1))).strip()
                team = ""
                wm = re.search(r'<li class="writer">.*?</b>(.*?)</li>', block, re.S)
                if wm:
                    team = html_mod.unescape(re.sub(r"<[^>]+>", "", wm.group(1))).strip()
                dm = re.search(r"(\d{4}-\d{2}-\d{2})", block)
                published = dm.group(1) if dm else ""
                if nttid in found:
                    if kw not in found[nttid]["matched"]:
                        found[nttid]["matched"].append(kw)
                    continue
                found[nttid] = {"nttId": nttid, "title": title, "team": team,
                                "published": published, "matched": [kw]}
                new += 1
        print(f"  {kw:<10} total={total:<5} new={new}")
    return found


def keep(item: dict) -> bool:
    if not item["published"] or item["published"][:7] < START_MONTH:
        return False
    if AI_FALSE_POSITIVE.search(item["title"]):
        return False
    return True


def fetch_body(nttid: str) -> str:
    page = http_get(f"{BOARD}/view.do?nttId={nttid}")
    m = re.search(r'(?s)<div class="board-view__contents-inner">(.*?)<div class="board-view__file"',
                  page)
    if not m:
        m = re.search(r'(?s)<div class="board-view__contents-inner">(.*?)</div>\s*</div>\s*</div>',
                      page)
    return strip_html(m.group(1)) if m else ""


# ---------------------------------------------------------------- 가공


def news_id(nttid: str) -> str:
    """부처 데이터와 같은 16자리 hex 형식. nttId 기반이라 재수집해도 값이 안 변한다."""
    return hashlib.sha256(f"cheonan:{nttid}".encode("utf-8")).hexdigest()[:16]


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


def build_record(item: dict, body: str, now_iso: str) -> dict:
    tier, reason = tier_of(item["title"])
    topics, primary = guess_topics(item["title"], body)
    return {
        "id": news_id(item["nttId"]),
        "agency_id": AGENCY_ID,
        "title": item["title"],
        "url": f"{BOARD}/view.do?nttId={item['nttId']}",
        "published": item["published"],
        "source": SOURCE_NAME,
        "collector": "cheonan",
        "source_domain": SOURCE_DOMAIN,
        "snippet": make_snippet(body),
        "subtitle": make_subtitle(body),
        "tier": tier,
        "matched": item["matched"],
        "reason": reason,
        "ai_confirmed": True,
        "first_seen": now_iso,
        "topics": topics,
        "primary_topic": primary,
        "dept": item["team"],
        "nttId": item["nttId"],
    }


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


def merge_month_files(records: list, dry: bool) -> tuple[int, int]:
    """월별 파일에 천안시 기사를 병합한다. 같은 id 는 갱신, 없으면 추가."""
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


def all_news() -> list:
    rows = []
    for path in sorted((DATA / "news").glob("[0-9][0-9][0-9][0-9]-[0-9][0-9].json")):
        rows.extend(load_json(path, []))
    return rows


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
        "updated": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "+00:00"),
        "months": months,
        "total": len(rows),
        "byAgency": ordered,
        "byTier": {k: by_tier[k] for k in ("tier1", "accepted") if k in by_tier},
    }
    if not dry:
        save_json(DATA / "news" / "index.json", doc)
    return doc


def rebuild_topics(dry: bool) -> dict:
    """topics.json 의 matrix/totals/quarters/newsTotal/topTopic 을 다시 계산한다.

    matrix 는 primary_topic 1건당 1카운트다(원본 데이터에서 matrix 총합 == 전체
    뉴스 건수인 것으로 검증했다). 천안시를 넣고도 이 항등식이 유지돼야 한다.
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

    # 천안시가 항상 맨 앞에 오도록 기관 순서를 잡는다(화면 정렬과 별개로 데이터도 일관되게).
    agencies = [AGENCY_ID] if AGENCY_ID in matrix else []
    agencies += [a for a in doc.get("agencies", []) if a in matrix and a != AGENCY_ID]
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


def summarize(records: list, bodies: dict, dry: bool) -> int:
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
    done = 0
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
            body = bodies.get(r["nttId"], "")
            if len(body) < 80:
                continue
            prompt = (f"다음은 천안시가 배포한 보도자료다.\n\n"
                      f"제목: {r['title']}\n담당: {r.get('dept', '')}\n"
                      f"발행일: {r['published']}\n\n본문:\n{body}")
            try:
                resp = client.messages.create(
                    model=SUMMARY_MODEL,
                    max_tokens=4000,
                    system=SUMMARY_SYSTEM,
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
        if changed and not dry:
            save_json(path, store)
    return done


# ---------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description="천안시 AI/AX 보도자료 수집기")
    ap.add_argument("--no-summary", action="store_true", help="AI 요약을 건너뛴다")
    ap.add_argument("--dry-run", action="store_true", help="파일을 쓰지 않는다")
    ap.add_argument("--limit", type=int, default=0, help="상세 수집 건수 제한(테스트용)")
    args = ap.parse_args()

    print(f"천안시 보도자료 수집 — {START_MONTH} 이후, 키워드 {len(SEARCH_KEYWORDS)}종")
    candidates = scrape_list()
    wanted = [c for c in candidates.values() if keep(c)]
    wanted.sort(key=lambda c: c["published"], reverse=True)
    if args.limit:
        wanted = wanted[:args.limit]
    print(f"\n후보 {len(candidates)}건 → 대상 {len(wanted)}건")

    now_iso = datetime.now(KST).replace(microsecond=0).isoformat()
    records, bodies = [], {}
    for i, item in enumerate(wanted, 1):
        body = fetch_body(item["nttId"])
        bodies[item["nttId"]] = body
        records.append(build_record(item, body, now_iso))
        print(f"  {i:3}/{len(wanted)}  {item['published']}  {item['title'][:40]}")

    if not args.no_summary:
        print("\nAI 요약")
        summarize(records, bodies, args.dry_run)

    added, updated = merge_month_files(records, args.dry_run)
    sync_agency_counts(args.dry_run)
    idx = rebuild_index(args.dry_run)
    rebuild_topics(args.dry_run)

    print(f"\n신규 {added}건 · 갱신 {updated}건")
    print(f"전체 누적 {idx.get('total', 0)}건 · 천안시 {idx.get('byAgency', {}).get(AGENCY_ID, 0)}건")
    if args.dry_run:
        print("(--dry-run: 파일을 쓰지 않았습니다)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
