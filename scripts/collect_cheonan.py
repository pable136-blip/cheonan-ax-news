#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""천안시 AI/AX 보도자료 수집기.

천안시 누리집 보도자료 게시판(BBSMSTR_000000000030)을 제목 키워드로 검색해
인공지능 전환(AX) 관련 보도자료를 골라내고, 이 사이트의 data/ 스키마에 맞춰
누적 저장한다. 정부 부처 데이터(korea.kr 수집분)는 collect_korea.py 가 맡는다.

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
import os
import re
import sys
from datetime import datetime
from urllib.parse import quote

from _common import (
    AI_FALSE_POSITIVE,
    KST,
    SEARCH_KEYWORDS,
    TIER1_KEYWORDS,
    guess_topics,
    http_get,
    make_snippet,
    make_subtitle,
    merge_month_files,
    rebuild_index,
    rebuild_topics,
    strip_html,
    summarize,
    sync_agency_counts,
    tier_of,
)

BOARD = "https://www.cheonan.go.kr/bbs/BBSMSTR_000000000030"

AGENCY_ID = "cheonan"
AGENCY_NAME = "천안시"
SOURCE_NAME = "천안시 보도자료"
SOURCE_DOMAIN = "www.cheonan.go.kr"

# 정부 부처 데이터와 같은 기간을 공유해야 월별 추이 비교가 성립한다.
START_MONTH = os.environ.get("CHEONAN_START_MONTH", "2025-07")


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
        record = build_record(item, body, now_iso)
        bodies[record["id"]] = body
        records.append(record)
        print(f"  {i:3}/{len(wanted)}  {item['published']}  {item['title'][:40]}")

    if not args.no_summary:
        print("\nAI 요약")
        summarize(records, bodies, args.dry_run, SOURCE_NAME)

    added, updated = merge_month_files(records, args.dry_run)
    sync_agency_counts(args.dry_run)
    idx = rebuild_index(args.dry_run)
    rebuild_topics(args.dry_run, pinned_agency_id=AGENCY_ID)

    print(f"\n신규 {added}건 · 갱신 {updated}건")
    print(f"전체 누적 {idx.get('total', 0)}건 · 천안시 {idx.get('byAgency', {}).get(AGENCY_ID, 0)}건")
    if args.dry_run:
        print("(--dry-run: 파일을 쓰지 않았습니다)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
