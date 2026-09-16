#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""정부 부처 AI/AX 보도자료 수집기 (대한민국 정책브리핑 korea.kr).

data/agencies.json 에 koreaKrOrgCode 가 채워진 기관마다 korea.kr 보도자료
게시판을 기관코드(repCode) + 최근 날짜범위로 조회해, 제목에 AX 키워드가
있는 글만 골라 누적 저장한다. 천안시 자체 보도자료는 collect_cheonan.py 가
맡으므로 여기서는 건드리지 않는다.

korea.kr 목록 페이지는 제목뿐 아니라 리드문(lead)·발행일·기관명을 함께
내려주므로, 상세 페이지를 따로 열지 않고 목록 응답만으로 기사를 구성한다
(상세 페이지 본문은 PDF/한글 파일을 변환한 iframe 뷰어라 텍스트 추출이
불안정하다 — 목록의 리드문이 더 안정적인 소스다).

  python scripts/collect_korea.py                 # 수집 + 파생데이터 재계산
  python scripts/collect_korea.py --no-summary     # AI 요약 생략
  python scripts/collect_korea.py --dry-run        # 파일을 쓰지 않고 결과만 출력
  python scripts/collect_korea.py --lookback-days 30  # 조회 기간 조정(기본 10일)
"""
from __future__ import annotations

import argparse
import hashlib
import html as html_mod
import re
import sys
from datetime import datetime, timedelta

from _common import (
    AI_FALSE_POSITIVE,
    DATA,
    KST,
    TIER1_KEYWORDS,
    ADJACENT_KEYWORDS,
    Budget,
    guess_topics,
    http_get,
    load_json,
    merge_month_files,
    pending_summary_records,
    rebuild_index,
    rebuild_topics,
    summarize,
    sync_agency_counts,
    tier_of,
)

LIST_URL = "https://www.korea.kr/briefing/pressReleaseList.do"
VIEW_URL = "https://www.korea.kr/briefing/pressReleaseView.do"
SOURCE_NAME = "대한민국 정책브리핑"
SOURCE_DOMAIN = "www.korea.kr"

# 이 조회기간보다 예전 기사만 새로 나타나는 경우는 없다고 보고, 매일 실행되는
# 워크플로에서도 실행이 며칠 건너뛰어도 놓치지 않게 여유 있게 겹쳐서 조회한다.
DEFAULT_LOOKBACK_DAYS = 10

# 부처 수가 50곳이 넘어 조회·요약 시간이 날마다 크게 출렁인다. 워크플로의
# timeout-minutes 에 걸려 통째로 날아가기 전에 스스로 멈추도록 예산을 둔다.
DEFAULT_BUDGET_MIN = 25

KEYWORD_PATTERN = re.compile(
    "|".join(re.escape(k) for k in TIER1_KEYWORDS + ADJACENT_KEYWORDS), re.IGNORECASE)

LIST_ITEM = re.compile(
    r'pressReleaseView\.do\?newsId=(?P<newsId>\d+)[^"\']*?["\']>\s*'
    r'<span class="text">\s*<strong>(?P<title>.*?)</strong>\s*'
    r'<span class="lead">\s*(?P<lead>.*?)\s*</span>\s*'
    r'<span class="source">\s*<span>(?P<date>[\d-]+)</span>\s*<span>(?P<agency>.*?)</span>',
    re.S,
)

TOTAL_PATTERN = re.compile(r"검색결과\s*총\s*<strong>([\d,]+)</strong>")


def clean(fragment: str) -> str:
    return html_mod.unescape(re.sub(r"<[^>]+>", "", fragment)).strip()


# ---------------------------------------------------------------- 수집


def load_agencies() -> list[dict]:
    doc = load_json(DATA / "agencies.json", {"agencies": []})
    return [a for a in doc.get("agencies", [])
            if a.get("koreaKrOrgCode") and a.get("id") != "cheonan"]


def scrape_agency(agency_id: str, rep_code: str, start_date: str, end_date: str) -> list[dict]:
    """한 기관의 지정 기간 보도자료를 전부 긁어와 후보 목록으로 반환한다."""
    items: list[dict] = []
    page = 1
    while True:
        html = http_get(
            f"{LIST_URL}?repCodeType=&repCode={rep_code}&srchWord="
            f"&pageIndex={page}&startDate={start_date}&endDate={end_date}&period=")
        found_this_page = 0
        for m in LIST_ITEM.finditer(html):
            found_this_page += 1
            title = clean(m.group("title"))
            items.append({
                "newsId": m.group("newsId"),
                "title": title,
                "lead": clean(m.group("lead")),
                "published": m.group("date"),
                "agency_name": clean(m.group("agency")),
                "agency_id": agency_id,
            })
        if found_this_page == 0:
            break
        # 응답에 총 건수가 있으면 그걸로, 없으면 페이지가 꽉 찼을 때만 다음 페이지로.
        total_m = TOTAL_PATTERN.search(html)
        total = int(total_m.group(1).replace(",", "")) if total_m else None
        if total is not None and page * 20 >= total:
            break
        if total is None and found_this_page < 20:
            break
        page += 1
        if page > 20:  # 안전장치 — 기간을 너무 넓게 잡아도 무한루프는 안 되게.
            break
    return items


def keep(item: dict) -> bool:
    if not KEYWORD_PATTERN.search(item["title"]):
        return False
    if AI_FALSE_POSITIVE.search(item["title"]):
        return False
    return True


# ---------------------------------------------------------------- 가공


def news_id(news_id_raw: str) -> str:
    """다른 수집기와 같은 16자리 hex. newsId 기반이라 재수집해도 값이 안 변한다."""
    return hashlib.sha256(f"koreakr:{news_id_raw}".encode("utf-8")).hexdigest()[:16]


def build_record(item: dict, now_iso: str) -> dict:
    tier, reason = tier_of(item["title"])
    matched = [kw for kw in TIER1_KEYWORDS + ADJACENT_KEYWORDS
               if kw.lower() in item["title"].lower()]
    topics, primary = guess_topics(item["title"], item["lead"])
    snippet = f"{item['lead']} {item['published']} {item['agency_name']}".strip()
    return {
        "id": news_id(item["newsId"]),
        "agency_id": item["agency_id"],
        "title": item["title"],
        "url": f"{VIEW_URL}?newsId={item['newsId']}",
        "published": item["published"],
        "source": SOURCE_NAME,
        "collector": "koreakr",
        "source_domain": SOURCE_DOMAIN,
        "snippet": snippet,
        "subtitle": "",
        "tier": tier,
        "matched": matched or [reason],
        "reason": reason,
        "ai_confirmed": True,
        "first_seen": now_iso,
        "topics": topics,
        "primary_topic": primary,
        "newsId": item["newsId"],
    }


def known_news_ids() -> set[str]:
    """이미 저장된 기사의 korea.kr newsId 집합. url 에서 뽑아낸다(스키마에 별도
    필드가 없는 과거 이식분도 있어서, id 재계산 방식에 의존하지 않고 직접 파싱한다)."""
    ids = set()
    for path in sorted((DATA / "news").glob("[0-9][0-9][0-9][0-9]-[0-9][0-9].json")):
        for n in load_json(path, []):
            m = re.search(r"newsId=(\d+)", n.get("url", ""))
            if m:
                ids.add(m.group(1))
    return ids


# ---------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description="정부 부처 AI/AX 보도자료 수집기 (korea.kr)")
    ap.add_argument("--no-summary", action="store_true", help="AI 요약을 건너뛴다")
    ap.add_argument("--dry-run", action="store_true", help="파일을 쓰지 않는다")
    ap.add_argument("--lookback-days", type=int, default=DEFAULT_LOOKBACK_DAYS,
                     help="오늘부터 며칠 전까지 조회할지(기본 10일, 여유 있게 겹쳐 조회)")
    ap.add_argument("--limit", type=int, default=0, help="대상 건수 제한(테스트용)")
    ap.add_argument("--budget-min", type=float, default=DEFAULT_BUDGET_MIN,
                    help=f"실행 시간 예산(분, 기본 {DEFAULT_BUDGET_MIN}분, 0이면 무제한). "
                         "초과하면 남은 작업을 다음 실행으로 넘기고 수집분은 저장한다")
    args = ap.parse_args()

    budget = Budget(args.budget_min)
    end = datetime.now(KST).date()
    start = end - timedelta(days=args.lookback_days)
    agencies = load_agencies()
    print(f"정부 부처 보도자료 수집 — {start}~{end}, 기관 {len(agencies)}곳 · {budget}")

    seen_ids = known_news_ids()
    candidates: dict[str, dict] = {}
    for n, a in enumerate(agencies, 1):
        # 조회 단계에서 예산이 끝나면 남은 기관은 다음 실행에 맡긴다. 조회기간을
        # 10일씩 겹쳐 잡으므로 여기서 건너뛴 기관도 놓치지 않는다.
        if budget.expired:
            print(f"  ⏱ 조회 시간 예산 초과 — 남은 기관 {len(agencies) - n + 1}곳은 다음 실행으로 넘깁니다.")
            break
        try:
            found = scrape_agency(a["id"], a["koreaKrOrgCode"], str(start), str(end))
        except RuntimeError as e:
            print(f"  {a['id']:<12} 조회 실패: {e}")
            continue
        wanted = [it for it in found if it["newsId"] not in seen_ids and keep(it)]
        for it in wanted:
            candidates[it["newsId"]] = it
        if found or wanted:
            print(f"  {a['id']:<12} 조회={len(found):<4} 신규대상={len(wanted)}")

    wanted = sorted(candidates.values(), key=lambda c: c["published"], reverse=True)
    if args.limit:
        wanted = wanted[:args.limit]
    print(f"\n전체 신규 대상 {len(wanted)}건")

    now_iso = datetime.now(KST).replace(microsecond=0).isoformat()
    records = [build_record(it, now_iso) for it in wanted]
    bodies = {r["id"]: r["snippet"] for r in records}

    backfilled: list = []
    if not args.no_summary:
        print("\nAI 요약")
        summarize(records, bodies, args.dry_run, SOURCE_NAME, budget)
        # 예산이 남았으면 지난 실행에서 밀린 기사를 이어서 요약한다.
        if not budget.expired:
            backfilled, old_bodies = pending_summary_records("koreakr")
            if backfilled:
                print(f"\n지난 실행에서 밀린 요약 {len(backfilled)}건 보충 · {budget}")
                summarize(backfilled, old_bodies, args.dry_run, SOURCE_NAME, budget)

    added, updated = merge_month_files(records + backfilled, args.dry_run)
    sync_agency_counts(args.dry_run)
    idx = rebuild_index(args.dry_run)
    rebuild_topics(args.dry_run)

    print(f"\n신규 {added}건 · 갱신 {updated}건 · {budget}")
    print(f"전체 누적 {idx.get('total', 0)}건")
    if args.dry_run:
        print("(--dry-run: 파일을 쓰지 않았습니다)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
