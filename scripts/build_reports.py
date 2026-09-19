#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""천안시 관점 AX 동향보고서(분기·전체)와 리포트 탭 「한눈에 보기」를 만든다.

근거는 수집기가 쌓아 둔 보도자료와 AI 요약(data/summaries)이다. 모델에는 기사마다
id 를 붙여 넘기고 근거를 id 로만 돌려받는다. 출처 링크는 이 스크립트가 id 로
data/news 에서 찾아 붙이므로 모델이 URL 을 지어내거나 잘못 옮길 수 없고, 입력에
없는 id 는 버린다. 건수·통계도 모델이 세지 않고 여기서 계산해 넘긴다.

  분기 보고서  data/reports/cheonan/quarter-YYYY-QN.{json,md,html}
      진행 중인 분기는 매번 다시 만들고, 끝난 분기는 끝난 뒤 한 번 더 만들어
      확정(complete)한 다음부터는 건드리지 않는다.
  전체 보고서  data/reports/cheonan/overall-YYYY-MM-DD.{json,md,html}
      기사 2천여 건을 한 번에 넣으면 컨텍스트 한도에 가깝고 비싸서, 분기 보고서들과
      천안시 보도자료 전체를 입력으로 종합한다. 분기 보고서가 모두 있어야 만든다.
  한눈에 보기  data/reports/highlights.json 의 items — 최신 전체 보고서의 요점.

data/reports/ 바로 아래 파일은 지식재산처 관점 원본 보관본이다(index.json 의
archived). 파일명(quarter-2026-Q3.md 등)이 겹치므로 새 보고서는 cheonan/ 에 둔다.

  python scripts/build_reports.py                    # 필요한 것만 생성
  python scripts/build_reports.py --quarter 2026-Q3  # 그 분기 하나만(전체 보고서는 건너뜀)
  python scripts/build_reports.py --force            # 확정된 분기까지 전부 다시 생성
  python scripts/build_reports.py --dry-run          # API 호출 없이 계획과 입력 크기만 출력
  python scripts/build_reports.py --render-only      # 저장된 json 으로 md/html/목록만 다시 그림

API 를 부를 수 없는 환경(내부망 등)에서는 모델 호출만 손으로 대신한다. 프롬프트를 파일로
받아 모델에 넣고, 받은 JSON 을 도로 넣으면 검증·렌더링은 똑같이 거친다.

  python scripts/build_reports.py --quarter 2026-Q3 --prompt-out q3.txt
  python scripts/build_reports.py --quarter 2026-Q3 --from-json q3.json --label "claude-opus-5"
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from _common import DATA, KST, TOPIC_IDS, Budget, all_news, load_json, save_json, warn

REPORT_MODEL = "claude-opus-5"
# 로그에 찍는 추정 비용용 단가(USD / 100만 토큰). 실제 청구액은 콘솔에서 확인한다.
PRICE_IN, PRICE_OUT = 5.0, 25.0

REPORTS = DATA / "reports"
OUT = REPORTS / "cheonan"
OUT_REL = "data/reports/cheonan"
HOME = "cheonan"
TOP_AGENCIES = 8           # 기관별 동향에 올릴 기관 수(천안시는 별도 절)
MIN_QUARTER_NEWS = 40      # 이보다 적으면 분기 보고서를 만들지 않는다(분기 첫날 등)
DEFAULT_BUDGET_MIN = 100   # 워크플로 timeout-minutes(120)보다 작게
CALL_RESERVE_MIN = 15      # 보고서 1건에 이 정도는 걸린다고 보고, 남은 예산이 이보다 적으면 새로 시작하지 않는다

# Actions 입력칸에 손으로 치는 값이라 너그럽게 받는다: 2026-Q3, 2026q3, 2026 Q3, 2026년 3분기.
QUARTER_RE = re.compile(r"^(\d{4})\D*([1-4])\s*(?:분기)?$", re.IGNORECASE)
REPORT_TOPICS = [t for t in TOPIC_IDS if t != "other"]


class ReportError(Exception):
    """보고서 1건 실패. 다음 보고서는 계속 시도한다."""


class FatalAPIError(Exception):
    """키·권한·한도처럼 다음 보고서도 똑같이 실패할 오류."""


# ---------------------------------------------------------------- 데이터


class Corpus:
    def __init__(self):
        self.news = all_news()
        self.by_id = {n["id"]: n for n in self.news}
        self.summaries: dict = {}
        for path in (DATA / "summaries").glob("[0-9][0-9][0-9][0-9]-[0-9][0-9].json"):
            self.summaries.update(load_json(path, {}))
        self.agencies = {a["id"]: a for a in
                         load_json(DATA / "agencies.json", {}).get("agencies", [])}
        self.topic_names = {t["id"]: t["name"] for t in
                            load_json(DATA / "topics.json", {}).get("topics", [])}

    def agency_name(self, aid: str, short: bool = False) -> str:
        a = self.agencies.get(aid) or {}
        return (a.get("shortName") if short else None) or a.get("name") or aid

    def body(self, n: dict) -> str:
        return (self.summaries.get(n["id"], {}).get("summary") or n.get("snippet") or "").strip()

    def refs(self, ids: list) -> list[dict]:
        return [self.by_id[i] for i in ids if i in self.by_id]


def quarter_of(day: str) -> str:
    return f"{day[:4]}-Q{(int(day[5:7]) - 1) // 3 + 1}"


def quarter_bounds(q: str) -> tuple[date, date]:
    y, n = int(q[:4]), int(q[-1])
    start = date(y, 3 * n - 2, 1)
    nxt = date(y + 1, 1, 1) if n == 4 else date(y, 3 * n + 1, 1)
    return start, nxt - timedelta(days=1)


def quarter_label(q: str) -> str:
    return f"{q[:4]}년 {q[-1]}분기"


def compute_stats(rows: list[dict], period_key) -> dict:
    """보고서 머리말·부록·프롬프트에 쓰는 확정 수치. period_key 는 월 또는 분기."""
    by_period = Counter(period_key(n["published"]) for n in rows)
    by_agency = Counter(n.get("agency_id", "?") for n in rows)
    # 주제는 기사에 붙은 태그 기준(한 기사에 여러 개) — 대표 주제 1개만 세면 흐름이 뭉개진다.
    by_topic = Counter(t for n in rows for t in (n.get("topics") or []) if t in REPORT_TOPICS)
    return {
        "total": len(rows),
        "home": by_agency.get(HOME, 0),
        "byPeriod": dict(sorted(by_period.items())),
        "byAgency": dict(by_agency.most_common()),
        "byTopic": dict(by_topic.most_common()),
    }


def top_agencies(stats: dict) -> list[str]:
    return [a for a in stats["byAgency"] if a != HOME][:TOP_AGENCIES]


# ---------------------------------------------------------------- 프롬프트

SYSTEM = """너는 천안시 공무원을 위해 정부 부처와 천안시의 인공지능 전환(AX) 보도자료를 분석하는 정책 분석가다.

읽는 사람은 천안시(충청남도의 기초자치단체) 공무원이다. 중앙정부 AX 정책의 흐름을 파악하고, 시 행정에서 무엇을 준비할지 판단하려고 이 보고서를 읽는다. 그래서 기초지자체에 의미 있는 소식 — 지자체가 참여할 수 있는 공모·국비 사업, 지자체 행정에 옮겨 올 수 있는 사례, 새 법령·지침이 지자체에 요구하는 준비, 지역 산업·인재·시민 서비스와의 접점 — 에 무게를 두고, 중앙부처 내부 인사·조직 소식처럼 지자체와 거리가 먼 것은 비중을 낮춘다.

사실 규칙:
- 기관명·수치·날짜·예산·사업명은 제공된 기사에 적힌 것만 쓴다. 기사에 없는 내용은 추측해 채우지 말고 쓰지 않는다.
- 사실을 담은 항목에는 근거 기사의 id 를 refs 에 넣는다. id 는 입력의 [ ] 안 문자열을 그대로 쓴다.
- 천안시가 한 일은 천안시 보도자료에 있는 것만 쓴다. 다른 기관의 사업을 천안시가 한 것처럼 쓰지 않는다.
- 시사점과 실행 아이디어는 제안이다. "~를 검토할 만하다", "~가 필요하다"처럼 제안의 말투로 쓰고, 이미 정해진 일처럼 쓰지 않는다.
- 건수를 말할 때는 입력의 통계 값을 쓴다.

문체: 한국어 개조식. 문장은 짧게 쓴다. 핵심 수치와 고유명사는 **굵게** 표시해도 되지만 그 밖의 마크다운은 쓰지 않는다."""


def article_block(c: Corpus, n: dict) -> str:
    head = f"[{n['id']}] {n['published']} · {c.agency_name(n.get('agency_id', ''))}"
    return f"{head}\n제목: {n['title']}\n{c.body(n)}"


def stats_lines(c: Corpus, st: dict, period_word: str) -> list[str]:
    periods = " · ".join(f"{k} {v}건" for k, v in st["byPeriod"].items())
    agencies = ", ".join(f"{c.agency_name(a)} {v}건"
                         for a, v in list(st["byAgency"].items())[:15])
    topics = ", ".join(f"{c.topic_names.get(t, t)} {v}건" for t, v in st["byTopic"].items())
    return [
        f"- 기사 {st['total']}건, 이 중 천안시 {st['home']}건",
        f"- {period_word}별: {periods}",
        f"- 기관별(상위 15): {agencies}",
        f"- 주제 태그별(한 기사에 여러 주제): {topics}",
    ]


def task_lines(c: Corpus, st: dict, order: list[str], scope: str) -> list[str]:
    agencies = ", ".join(f"{a}({c.agency_name(a)} {st['byAgency'][a]}건)" for a in order)
    topics = ", ".join(f"{t}({c.topic_names.get(t, t)})" for t in REPORT_TOPICS)
    return [
        "작성할 내용:",
        f"- headline: {scope}을 한 문장으로.",
        "- brief(한눈에 보기): 가장 중요한 흐름 4~6개. evidence 는 일어난 사실, "
        "implication 은 천안시에 주는 의미.",
        "- cheonan: 천안시 보도자료의 흐름. overview 한 단락과 points 2~5개. "
        "천안시 기사가 없으면 overview 에 그렇게 쓰고 points 는 빈 배열로 둔다.",
        "- milestones: 핵심 정책 이정표 6~10개.",
        f"- agencies: 다음 기관마다 포인트 2~4개 — {agencies}",
        f"- topics: 의미 있는 주제 흐름 4~8개. topic_id 는 다음 중 하나: {topics}",
        "- ideas: 천안시 실행 아이디어 3~5개. rationale 은 근거가 된 정부 동향, "
        "action 은 천안시가 해 볼 수 있는 구체적인 첫 단계.",
    ]


def quarter_prompt(c: Corpus, q: str, rows: list[dict], st: dict, order: list[str],
                   today: date) -> str:
    start, end = quarter_bounds(q)
    rows = sorted(rows, key=lambda n: (n["published"], n["id"]))
    home = [article_block(c, n) for n in rows if n.get("agency_id") == HOME]
    gov = [article_block(c, n) for n in rows if n.get("agency_id") != HOME]
    ongoing = (f" 이 분기는 아직 진행 중이며 {today}까지 수집된 기사만 있다."
               if today <= end else "")
    # 긴 자료를 앞에, 지시를 뒤에 둔다.
    return "\n\n".join([
        "<천안시_보도자료>\n" + ("\n\n".join(home) or "(이 분기 천안시 보도자료 없음)")
        + "\n</천안시_보도자료>",
        "<정부_보도자료>\n" + "\n\n".join(gov) + "\n</정부_보도자료>",
        "<통계>\n" + "\n".join(stats_lines(c, st, "월")) + "\n</통계>",
        f"위 보도자료로 {quarter_label(q)}({start}~{end}) AX 동향보고서를 작성하라.{ongoing}",
        "\n".join(task_lines(c, st, order, "이 분기")),
    ])


def digest_quarter(c: Corpus, doc: dict) -> str:
    """분기 보고서를 전체 보고서 입력용 텍스트로 줄인다. 실행 아이디어(제안)는
    사실이 아니므로 빼고, 사실 항목만 근거 id 와 함께 넘긴다."""
    r, st = doc["report"], doc["stats"]
    refs = lambda ids: f" [refs: {', '.join(ids)}]" if ids else ""
    lines = [f"<분기_보고서 분기=\"{doc['period']['quarter']}\" 기사=\"{st['total']}\" "
             f"천안시=\"{st['home']}\">", f"요약: {r['headline']}", "한눈에 보기:"]
    lines += [f"- {b['title']}: {b['evidence']} → {b['implication']}{refs(b['refs'])}"
              for b in r["brief"]]
    lines.append(f"천안시: {r['cheonan']['overview']}")
    lines += [f"- {p['title']}: {p['body']}{refs(p['refs'])}" for p in r["cheonan"]["points"]]
    lines.append("마일스톤:")
    lines += [f"- {m['title']}: {m['body']}{refs(m['refs'])}" for m in r["milestones"]]
    lines.append("기관별:")
    for a in r["agencies"]:
        lines += [f"- {c.agency_name(a['agency_id'])} / {p['title']}: {p['body']}{refs(p['refs'])}"
                  for p in a["points"]]
    lines.append("주제별:")
    lines += [f"- {c.topic_names.get(t['topic_id'], t['topic_id'])} / {t['title']}: "
              f"{t['body']}{refs(t['refs'])}" for t in r["topics"]]
    lines.append("</분기_보고서>")
    return "\n".join(lines)


def cited_ids(doc: dict) -> list[str]:
    r = doc["report"]
    items = (r["brief"] + r["cheonan"]["points"] + r["milestones"] + r["topics"]
             + [p for a in r["agencies"] for p in a["points"]])
    return [i for it in items for i in it["refs"]]


def overall_prompt(c: Corpus, qdocs: list[dict], st: dict, order: list[str]) -> str:
    ids = dict.fromkeys(i for d in qdocs for i in cited_ids(d))
    index = [f"[{n['id']}] {n['published']} · {c.agency_name(n.get('agency_id', ''))} · {n['title']}"
             for n in sorted(c.refs(list(ids)), key=lambda n: (n["published"], n["id"]))
             if n.get("agency_id") != HOME]
    home = [article_block(c, n) for n in sorted(c.news, key=lambda n: (n["published"], n["id"]))
            if n.get("agency_id") == HOME]
    first, last = min(st["byPeriod"]), max(st["byPeriod"])
    return "\n\n".join([
        "\n\n".join(digest_quarter(c, d) for d in qdocs),
        "<근거_기사_목록>\n" + "\n".join(index) + "\n</근거_기사_목록>",
        "<천안시_보도자료>\n" + "\n\n".join(home) + "\n</천안시_보도자료>",
        "<통계>\n" + "\n".join(stats_lines(c, st, "분기")) + "\n</통계>",
        f"위 분기 보고서들은 같은 방식으로 앞서 만든 것이고, 그 안의 사실은 [refs] 기사에 근거한다. "
        f"이를 종합해 {first}~{last} 전체 기간의 AX 동향보고서를 작성하라. "
        "분기를 나열하지 말고 기간을 관통하는 흐름과 그 변화를 쓰되, 최근 분기에 무게를 둔다. "
        "근거 id 는 분기 보고서의 refs, 근거 기사 목록, 천안시 보도자료에 있는 것만 쓴다.",
        "\n".join(task_lines(c, st, order, "전체 기간")),
    ])


# ---------------------------------------------------------------- 출력 스키마


def _obj(props: dict) -> dict:
    return {"type": "object", "properties": props, "required": list(props),
            "additionalProperties": False}


def _str(desc: str = "") -> dict:
    return {"type": "string", "description": desc} if desc else {"type": "string"}


REFS = {"type": "array", "items": {"type": "string"},
        "description": "근거 기사 id 목록 — 입력의 [ ] 안 문자열 그대로"}
POINT = _obj({"title": _str("한 줄 제목"), "body": _str(), "refs": REFS})


def report_schema(agency_ids: list[str]) -> dict:
    return _obj({
        "headline": _str("보고서 전체를 한 문장으로(60자 내외)"),
        "brief": {"type": "array", "description": "한눈에 보기 4~6개", "items": _obj({
            "title": _str("흐름을 한 줄로"),
            "evidence": _str("무엇이 일어났는지 — 기사에 적힌 사실과 수치"),
            "implication": _str("천안시에 주는 의미(제안의 말투)"),
            "refs": REFS,
        })},
        "cheonan": _obj({
            "overview": _str("천안시 보도자료 흐름 한 단락"),
            "points": {"type": "array", "items": POINT},
        }),
        "milestones": {"type": "array", "description": "핵심 정책 이정표", "items": POINT},
        "agencies": {"type": "array", "items": _obj({
            "agency_id": {"type": "string", "enum": agency_ids},
            "points": {"type": "array", "items": POINT},
        })},
        "topics": {"type": "array", "items": _obj({
            "topic_id": {"type": "string", "enum": REPORT_TOPICS},
            "title": _str("흐름을 한 줄로"),
            "body": _str(),
            "refs": REFS,
        })},
        "ideas": {"type": "array", "description": "천안시 실행 아이디어 3~5개", "items": _obj({
            "title": _str(),
            "rationale": _str("왜 — 근거가 된 정부 동향"),
            "action": _str("어떻게 — 천안시가 해 볼 수 있는 구체적인 첫 단계"),
            "refs": REFS,
        })},
    })


# ---------------------------------------------------------------- 생성


def generate(client, prompt: str, schema: dict, label: str) -> tuple[dict, dict]:
    import anthropic

    print(f"  {label}: 생성 요청 (입력 {len(prompt):,}자)… 수 분 걸립니다", flush=True)
    t0 = time.monotonic()
    try:
        # 출력이 길고(수만 토큰) 수 분이 걸리므로 스트리밍으로 받는다(HTTP 타임아웃 방지).
        # fallbacks="default": 모델이 안전 분류기로 요청을 거절하면 서버가 권장 모델로
        # 같은 요청을 다시 돌린다. 보도자료 분석에서 거절될 일은 드물지만 한 건 때문에
        # 월간 보고서가 통째로 빠지지 않게 켜 둔다.
        with client.beta.messages.stream(
            model=REPORT_MODEL,
            max_tokens=64000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            thinking={"type": "adaptive"},
            output_config={"effort": "high",
                           "format": {"type": "json_schema", "schema": schema}},
            system=SYSTEM,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            msg = stream.get_final_message()
    except anthropic.AuthenticationError as e:
        raise FatalAPIError("API 키가 올바르지 않습니다(401). 키를 다시 확인하세요.") from e
    except anthropic.PermissionDeniedError as e:
        raise FatalAPIError(f"이 키로는 요청할 권한이 없습니다(403): {e.message}") from e
    except anthropic.RateLimitError as e:
        raise FatalAPIError(
            f"요청 한도(429)에 걸렸습니다: {e.message}\n"
            "  새로 만든 조직은 한도가 낮게 시작하거나 월 사용 한도가 걸려 있을 수 있습니다 — "
            "Claude Console 의 Settings > Limits / Billing 을 확인하세요.") from e
    except anthropic.BadRequestError as e:
        # 크레딧 부족도 400 으로 온다. 다음 보고서도 똑같이 실패하므로 멈춘다.
        raise FatalAPIError(f"요청이 거부됐습니다(400): {e.message}") from e
    except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
        raise ReportError(f"API 오류(일시적일 수 있음): {e}") from e

    secs = time.monotonic() - t0
    if msg.stop_reason == "refusal":
        raise ReportError(f"모델이 응답을 거절했습니다: {getattr(msg, 'stop_details', None)}")
    if msg.stop_reason == "max_tokens":
        raise ReportError("출력이 max_tokens 에서 잘렸습니다")
    text = next((b.text for b in msg.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ReportError(f"응답 JSON 파싱 실패: {e}") from e

    u = msg.usage
    cost = (u.input_tokens * PRICE_IN + u.output_tokens * PRICE_OUT) / 1e6
    print(f"  {label}: 완료 {secs / 60:.1f}분 · 입력 {u.input_tokens:,} / 출력 "
          f"{u.output_tokens:,} 토큰 · 추정 ${cost:.2f}"
          + (f" · 응답 모델 {msg.model}" if msg.model != REPORT_MODEL else ""), flush=True)
    return data, {"model": msg.model, "inputTokens": u.input_tokens,
                  "outputTokens": u.output_tokens, "seconds": round(secs)}


def clean_report(data: dict, allowed: set[str], order: list[str]) -> tuple[dict, dict]:
    """모델 출력을 검증한다. 입력에 없는 근거 id 는 버리고, 근거가 하나도 남지 않은
    사실 항목은 통째로 뺀다(근거 없는 문장을 보고서에 싣지 않는다)."""
    dropped = {"refs": 0, "items": 0}

    def refs(xs) -> list[str]:
        out: list[str] = []
        for x in xs or []:
            x = str(x).strip().strip("[]")
            if x not in allowed:
                dropped["refs"] += 1
            elif x not in out:
                out.append(x)
        return out

    def facts(items, need_refs: bool = True) -> list[dict]:
        kept = []
        for it in items or []:
            it = {**it, "refs": refs(it.get("refs"))}
            if need_refs and not it["refs"]:
                dropped["items"] += 1
                continue
            kept.append(it)
        return kept

    agencies = []
    for a in data.get("agencies") or []:
        if a.get("agency_id") in order and all(x["agency_id"] != a["agency_id"] for x in agencies):
            points = facts(a.get("points"))
            if points:
                agencies.append({"agency_id": a["agency_id"], "points": points})
    agencies.sort(key=lambda a: order.index(a["agency_id"]))

    report = {
        "headline": (data.get("headline") or "").strip(),
        "brief": facts(data.get("brief")),
        "cheonan": {"overview": ((data.get("cheonan") or {}).get("overview") or "").strip(),
                    "points": facts((data.get("cheonan") or {}).get("points"))},
        "milestones": facts(data.get("milestones")),
        "agencies": agencies,
        "topics": [t for t in facts(data.get("topics")) if t.get("topic_id") in REPORT_TOPICS],
        "ideas": facts(data.get("ideas"), need_refs=False),
    }
    return report, dropped


def sort_milestones(c: Corpus, report: dict) -> None:
    # 날짜는 모델에게 받지 않고 근거 기사의 발행일로 정한다(확인 가능한 값).
    def first_day(m):
        days = [n["published"] for n in c.refs(m["refs"])]
        return min(days) if days else ""
    report["milestones"].sort(key=first_day)


def quarter_job(c: Corpus, q: str, today: date) -> dict:
    """보고서 1건의 재료 — 프롬프트, 응답 형식, 허용 근거 id, 문서 뼈대.

    모델을 부르는 일과 떼어 둔다. API 로 부를 때(generate)와 손으로 받아올 때
    (--prompt-out/--from-json)가 같은 검증·렌더링 경로를 타게 하기 위해서다.
    """
    rows = [n for n in c.news if quarter_of(n["published"]) == q]
    st = compute_stats(rows, lambda d: d[:7])
    order = top_agencies(st)
    start, end = quarter_bounds(q)
    return {
        "label": f"{q} 분기 보고서",
        "prompt": quarter_prompt(c, q, rows, st, order, today),
        "schema": report_schema(order),
        "allowed": {n["id"] for n in rows},
        "order": order,
        "meta": {
            "perspective": "cheonan",
            "kind": "quarter",
            "id": f"quarter-{q}",
            "title": f"{q} AX 동향보고서",
            "period": {"quarter": q, "start": str(start), "end": str(end)},
            "generated": str(today),
            "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            # 분기가 끝난 뒤에 만든 보고서만 확정본이다 — 이후 실행에서는 다시 만들지 않는다.
            "complete": today > end,
            "stats": st,
        },
    }


def overall_job(c: Corpus, qdocs: list[dict], today: date) -> dict:
    st = compute_stats(c.news, quarter_of)
    order = top_agencies(st)
    allowed = {i for d in qdocs for i in cited_ids(d)}
    allowed |= {n["id"] for n in c.news if n.get("agency_id") == HOME}
    days = sorted(n["published"] for n in c.news)
    return {
        "label": "전체 보고서",
        "prompt": overall_prompt(c, qdocs, st, order),
        "schema": report_schema(order),
        "allowed": allowed,
        "order": order,
        "meta": {
            "perspective": "cheonan",
            "kind": "overall",
            "id": f"overall-{today}",
            "title": f"전체 AX 동향보고서 ({today})",
            "period": {"start": days[0], "end": days[-1],
                       "quarters": [d["period"]["quarter"] for d in qdocs]},
            "generated": str(today),
            "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "stats": st,
        },
    }


def assemble(c: Corpus, job: dict, data: dict, usage: dict) -> dict:
    report, dropped = clean_report(data, job["allowed"], job["order"])
    sort_milestones(c, report)
    note_dropped(job["label"], dropped)
    return {**job["meta"], "usage": usage, "validation": dropped, "report": report}


def build_from_api(client, c: Corpus, job: dict) -> dict:
    data, usage = generate(client, job["prompt"], job["schema"], job["label"])
    return assemble(c, job, data, usage)


def note_dropped(label: str, dropped: dict) -> None:
    if dropped["refs"] or dropped["items"]:
        warn(f"{label} 보고서 검증 — 입력에 없는 근거 id {dropped['refs']}개, "
             f"근거가 없어 뺀 항목 {dropped['items']}개")


# ---------------------------------------------------------------- 렌더링


def esc(s) -> str:
    # assets/app.js 의 esc/unescHtml 과 같은 치환표 — highlights.json 의 href 를
    # 화면이 되돌려 뉴스 url 과 대조하므로 인코딩 방식이 같아야 한다.
    return re.sub(r"[&<>\"']", lambda m: {"&": "&amp;", "<": "&lt;", ">": "&gt;",
                                           '"': "&quot;", "'": "&#39;"}[m.group()], str(s))


BOLD = re.compile(r"\*\*(.+?)\*\*")


def rich(s: str) -> str:
    return BOLD.sub(r"<strong>\1</strong>", esc(s))


def plain(s: str) -> str:
    return BOLD.sub(r"\1", s)


def md_day(day: str) -> str:
    return f"{int(day[5:7])}.{int(day[8:10])}"


def ref_label(c: Corpus, n: dict) -> str:
    return f"{c.agency_name(n.get('agency_id', ''), short=True)} {md_day(n['published'])}"


def md_refs(c: Corpus, ids: list) -> str:
    links = [f"[{ref_label(c, n)}]({n['url']})" for n in c.refs(ids)]
    return f" ({', '.join(links)})" if links else ""


def html_refs(c: Corpus, ids: list) -> str:
    links = [f'<a class="src" href="{esc(n["url"])}" target="_blank" rel="noopener" '
             f'title="{esc(n["title"])}">{esc(ref_label(c, n))}</a>' for n in c.refs(ids)]
    return f' <span class="refs">{" ".join(links)}</span>' if links else ""


def meta_line(c: Corpus, doc: dict) -> str:
    st, p = doc["stats"], doc["period"]
    span = f"{p['start']} ~ {p['end']}"
    if doc["kind"] == "quarter" and not doc.get("complete"):
        span += f" (진행 중 — {doc['generated']}까지 수집분)"
    return (f"생성일 {doc['generated']} · 대상기간 {span} · 근거 뉴스 {st['total']:,}건"
            f"(천안시 {st['home']}건) · 작성 {doc['usage']['model']}")


DISCLAIMER = ("AI가 수집된 보도자료 요약을 근거로 자동 작성한 참고자료입니다. 사실은 각 항목의 "
              "출처 링크로 원문을 확인하세요. 시사점과 실행 아이디어는 AI의 제안이며 천안시의 "
              "공식 입장이 아닙니다.")


def stat_tables(c: Corpus, doc: dict) -> list[tuple[str, list[tuple[str, int]]]]:
    st = doc["stats"]
    period = "월별" if doc["kind"] == "quarter" else "분기별"
    return [
        (f"{period} 기사 수", list(st["byPeriod"].items())),
        ("기관별 기사 수(상위 10)",
         [(c.agency_name(a), v) for a, v in list(st["byAgency"].items())[:10]]),
        ("주제 태그별 기사 수(한 기사에 여러 주제)",
         [(c.topic_names.get(t, t), v) for t, v in st["byTopic"].items()]),
    ]


def render_md(c: Corpus, doc: dict) -> str:
    r, st = doc["report"], doc["stats"]
    out = [f"# {doc['title']} — 천안시 관점", "",
           f"> {meta_line(c, doc)}", ">", f"> ※ {DISCLAIMER}", "",
           f"**{plain(r['headline'])}**", "", "---", "", "## 한눈에 보기", ""]
    out += [f"- **{plain(b['title'])}** — {b['evidence']}{md_refs(c, b['refs'])} → {b['implication']}"
            for b in r["brief"]]
    out += ["", "## 1. 천안시 동향", "", r["cheonan"]["overview"], ""]
    out += [f"- **{plain(p['title'])}** — {p['body']}{md_refs(c, p['refs'])}"
            for p in r["cheonan"]["points"]]
    out += ["", "## 2. 핵심 마일스톤", ""]
    out += [f"{i}. **{plain(m['title'])}** — {m['body']}{md_refs(c, m['refs'])}"
            for i, m in enumerate(r["milestones"], 1)]
    out += ["", "## 3. 주요 기관별 정책동향", ""]
    for a in r["agencies"]:
        out += [f"### {c.agency_name(a['agency_id'])} — {st['byAgency'].get(a['agency_id'], 0)}건", ""]
        out += [f"- **{plain(p['title'])}** — {p['body']}{md_refs(c, p['refs'])}" for p in a["points"]]
        out.append("")
    out += ["## 4. 주제별 흐름", ""]
    out += [f"- **{c.topic_names.get(t['topic_id'], t['topic_id'])}"
            f"({st['byTopic'].get(t['topic_id'], 0)}건) — {plain(t['title'])}**: "
            f"{t['body']}{md_refs(c, t['refs'])}" for t in r["topics"]]
    out += ["", "## 5. 천안시 실행 아이디어", ""]
    for i, idea in enumerate(r["ideas"], 1):
        out += [f"### {i}) {plain(idea['title'])}", "", f"- **왜**: {idea['rationale']}",
                f"- **어떻게**: {idea['action']}"]
        if idea["refs"]:
            out.append(f"- **근거**:{md_refs(c, idea['refs'])}")
        out.append("")
    out += ["---", "", "## 부록. 통계", ""]
    for caption, rows in stat_tables(c, doc):
        out += [f"**{caption}**", "", "| 구분 | 건수 |", "|---|---:|"]
        out += [f"| {k} | {v:,} |" for k, v in rows]
        out.append("")
    return "\n".join(out)


HTML_STYLE = """
  :root { --primary:#2257b4; --primary-dim:#1c4690; --accent:#d64210; --green:#00a439;
          --ink:#1c2531; --muted:#5b6472; --line:#e1e6ee; --soft:#eef3fb; --warn-bg:#fdf3ee; }
  * { box-sizing:border-box; }
  body { font-family:"Pretendard Variable","Pretendard","Malgun Gothic","Apple SD Gothic Neo",sans-serif;
         max-width:880px; margin:0 auto; padding:52px 36px 90px; color:var(--ink);
         line-height:1.75; font-size:15.5px; -webkit-font-smoothing:antialiased; }
  .kicker { font-size:12.5px; letter-spacing:.08em; color:var(--primary); font-weight:700; margin-bottom:10px; }
  h1 { font-size:26px; line-height:1.4; color:var(--primary-dim); margin:0 0 18px;
       padding-bottom:16px; border-bottom:3px solid var(--primary); }
  .meta, .warn { font-size:13px; padding:10px 14px; border-radius:6px; margin:0 0 8px; }
  .meta { color:var(--muted); background:#f4f6f9; border-left:3px solid var(--primary); }
  .warn { color:#7a3a17; background:var(--warn-bg); border-left:3px solid var(--accent); }
  .headline { font-size:17px; font-weight:700; color:var(--primary-dim); margin:28px 0 8px; }
  h2 { font-size:19px; margin:44px 0 16px; color:var(--primary-dim); padding-bottom:9px;
       border-bottom:2px solid var(--line); }
  h3 { font-size:15.5px; margin:26px 0 12px; padding:7px 14px; border-left:4px solid var(--primary);
       color:var(--primary-dim); background:linear-gradient(90deg,var(--soft),transparent);
       border-radius:0 6px 6px 0; }
  ul, ol { padding-left:22px; margin:0 0 8px; }
  li { margin-bottom:12px; }
  strong { color:var(--primary-dim); }
  .brief li { margin-bottom:18px; }
  .brief .impl { margin-top:4px; color:var(--primary-dim); }
  .brief .impl::before { content:"→ "; color:var(--accent); font-weight:700; }
  .refs { white-space:normal; }
  a.src { display:inline-block; font-size:12px; font-weight:600; color:var(--primary);
          background:var(--soft); border-radius:4px; padding:0 6px; margin:0 2px;
          text-decoration:none; line-height:1.7; }
  a.src:hover { background:var(--primary); color:#fff; }
  .idea { border:1px solid var(--line); border-radius:8px; padding:14px 18px; margin:0 0 14px; }
  .idea h3 { margin:0 0 8px; background:none; border:0; padding:0; }
  .idea p { margin:4px 0; }
  .idea .lbl { font-weight:700; color:var(--green); margin-right:6px; }
  table { border-collapse:collapse; width:100%; font-size:13.5px; margin:8px 0 22px; }
  th, td { border-bottom:1px solid var(--line); padding:7px 12px; text-align:left; }
  th { background:var(--primary-dim); color:#fff; font-weight:600; }
  td.n { text-align:right; font-variant-numeric:tabular-nums; }
  .caption { font-weight:700; margin:18px 0 4px; }
  @media print { body { padding:0; } a.src { background:none; padding:0; } }
"""


def render_html(c: Corpus, doc: dict) -> str:
    r, st = doc["report"], doc["stats"]
    h = ["<!DOCTYPE html>", '<html lang="ko"><head><meta charset="UTF-8">',
         '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
         f"<title>{esc(doc['title'])} — 천안시 관점</title>",
         # 내부망에서도 열리도록 사이트와 같은 로컬 폰트를 쓴다(CDN 미사용).
         '<link rel="stylesheet" href="../../../assets/fonts.css">',
         f"<style>{HTML_STYLE}</style></head><body>",
         '<div class="kicker">천안 AX 인사이트 · AI 자동작성 동향보고서</div>',
         f"<h1>{esc(doc['title'])} — 천안시 관점</h1>",
         f'<p class="meta">{esc(meta_line(c, doc))}</p>',
         f'<p class="warn">{esc(DISCLAIMER)}</p>',
         f'<p class="headline">{rich(plain(r["headline"]))}</p>',
         "<h2>한눈에 보기</h2>", '<ol class="brief">']
    h += [f"<li><strong>{rich(plain(b['title']))}</strong><div>{rich(b['evidence'])}"
          f"{html_refs(c, b['refs'])}</div><div class=\"impl\">{rich(b['implication'])}</div></li>"
          for b in r["brief"]]
    h += ["</ol>", "<h2>1. 천안시 동향</h2>", f"<p>{rich(r['cheonan']['overview'])}</p>", "<ul>"]
    h += [f"<li><strong>{rich(plain(p['title']))}</strong> — {rich(p['body'])}"
          f"{html_refs(c, p['refs'])}</li>" for p in r["cheonan"]["points"]]
    h += ["</ul>", "<h2>2. 핵심 마일스톤</h2>", "<ol>"]
    h += [f"<li><strong>{rich(plain(m['title']))}</strong> — {rich(m['body'])}"
          f"{html_refs(c, m['refs'])}</li>" for m in r["milestones"]]
    h += ["</ol>", "<h2>3. 주요 기관별 정책동향</h2>"]
    for a in r["agencies"]:
        h.append(f"<h3>{esc(c.agency_name(a['agency_id']))} — "
                 f"{st['byAgency'].get(a['agency_id'], 0)}건</h3><ul>")
        h += [f"<li><strong>{rich(plain(p['title']))}</strong> — {rich(p['body'])}"
              f"{html_refs(c, p['refs'])}</li>" for p in a["points"]]
        h.append("</ul>")
    h += ["<h2>4. 주제별 흐름</h2>", "<ul>"]
    h += [f"<li><strong>{esc(c.topic_names.get(t['topic_id'], t['topic_id']))}"
          f"({st['byTopic'].get(t['topic_id'], 0)}건) — {rich(plain(t['title']))}</strong><br>"
          f"{rich(t['body'])}{html_refs(c, t['refs'])}</li>" for t in r["topics"]]
    h += ["</ul>", "<h2>5. 천안시 실행 아이디어</h2>"]
    for i, idea in enumerate(r["ideas"], 1):
        h += [f'<div class="idea"><h3>{i}) {rich(plain(idea["title"]))}</h3>',
              f'<p><span class="lbl">왜</span>{rich(idea["rationale"])}</p>',
              f'<p><span class="lbl">어떻게</span>{rich(idea["action"])}</p>']
        if idea["refs"]:
            h.append(f'<p><span class="lbl">근거</span>{html_refs(c, idea["refs"])}</p>')
        h.append("</div>")
    h.append("<h2>부록. 통계</h2>")
    for caption, rows in stat_tables(c, doc):
        h += [f'<p class="caption">{esc(caption)}</p>',
              "<table><tr><th>구분</th><th>건수</th></tr>"]
        h += [f'<tr><td>{esc(k)}</td><td class="n">{v:,}</td></tr>' for k, v in rows]
        h.append("</table>")
    h.append("</body></html>")
    return "\n".join(h) + "\n"


def write_report(c: Corpus, doc: dict, save_doc: bool = True) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    if save_doc:
        save_json(OUT / f"{doc['id']}.json", doc)
    for ext, text in (("md", render_md(c, doc)), ("html", render_html(c, doc))):
        with (OUT / f"{doc['id']}.{ext}").open("w", encoding="utf-8", newline="\n") as f:
            f.write(text)


def saved_docs() -> list[dict]:
    docs = [load_json(p, None) for p in sorted(OUT.glob("*.json"))]
    return [d for d in docs if d and d.get("perspective") == "cheonan"]


def latest_overall() -> dict | None:
    overalls = [d for d in saved_docs() if d["kind"] == "overall"]
    return max(overalls, key=lambda d: d["generatedAt"]) if overalls else None


def write_index() -> None:
    """리포트 탭 목록(index.json)을 cheonan/ 의 보고서로 다시 만든다. archived 는 그대로 둔다."""
    prev = load_json(REPORTS / "index.json", {})
    entries = [{
        "id": d["id"],
        "kind": "분기" if d["kind"] == "quarter" else "전체",
        "date": d["generated"],
        "title": d["title"],
        "md": f"{OUT_REL}/{d['id']}.md",
        "html": f"{OUT_REL}/{d['id']}.html",
        "newsCount": d["stats"]["total"],
    } for d in saved_docs()]
    # 실행 시각 같은 값은 넣지 않는다 — 목록이 그대로면 파일도 그대로여야 빈 커밋이 안 생긴다.
    doc = {
        "_comment": "reports 는 scripts/build_reports.py 가 만든 천안시 관점 보고서(data/reports/cheonan/)다. "
                    "archived 는 지식재산처 관점 원본 보관본으로 화면에 노출하지 않는다.",
        "reports": entries,
    }
    for k in ("archivedAt", "archived"):
        if k in prev:
            doc[k] = prev[k]
    save_json(REPORTS / "index.json", doc)


def highlight_item(c: Corpus, b: dict) -> str:
    # assets/app.js loadAxHighlights 가 읽는 형식: "<strong>제목</strong> — 근거 → 시사점".
    # 근거 뒤의 "YYYY.M.D, <a href>출처</a>" 는 화면에서 날짜 링크(또는 요약 팝업)로 바뀐다.
    src = ", ".join(f'{n["published"][:4]}.{md_day(n["published"])}, '
                    f'<a href="{esc(n["url"])}">출처</a>' for n in c.refs(b["refs"]))
    return (f"<strong>{esc(plain(b['title']))}</strong> — {rich(b['evidence'])}"
            + (f" ({src})" if src else "") + f" → {rich(b['implication'])}")


def write_highlights(c: Corpus) -> None:
    doc = latest_overall()
    if not doc:
        return
    prev = load_json(REPORTS / "highlights.json", {})
    out = {
        "_comment": "items 는 최신 천안시 관점 전체 보고서의 「한눈에 보기」를 scripts/build_reports.py 가 "
                    "옮긴 것이다. archivedItems 는 지식재산처 관점 원본 보관본으로 화면에 노출하지 않는다.",
        "title": "AX 주요 동향 — 천안시 관점",
        "sourceReportId": doc["id"],
        "sourceHtml": f"{OUT_REL}/{doc['id']}.html",
        "date": doc["generated"],
        "items": [highlight_item(c, b) for b in doc["report"]["brief"]],
    }
    if "archivedItems" in prev:
        out["archivedItems"] = prev["archivedItems"]
    save_json(REPORTS / "highlights.json", out)


# ---------------------------------------------------------------- main


def plan(c: Corpus, args) -> tuple[list[str], list[str]]:
    """(이번에 만들 분기, 보고서 대상 분기 전체)를 돌려준다. 최근 분기부터 —
    예산이 모자라면 오래된 분기가 다음 실행으로 밀린다."""
    counts = Counter(quarter_of(n["published"]) for n in c.news)
    eligible = sorted((q for q, v in counts.items() if v >= MIN_QUARTER_NEWS), reverse=True)
    if args.quarter:
        return [args.quarter], eligible
    todo = []
    for q in eligible:
        doc = load_json(OUT / f"quarter-{q}.json", None)
        if args.force or not doc or not doc.get("complete"):
            todo.append(q)
    return todo, eligible


def dry_run(c: Corpus, todo: list[str], want_overall: bool, today: date) -> None:
    client = None
    if os.environ.get("ANTHROPIC_API_KEY"):
        import anthropic
        client = anthropic.Anthropic()

    def show(label: str, prompt: str) -> None:
        line = f"  {label}: 입력 {len(prompt):,}자"
        if client is not None:  # 토큰 세기는 무료다.
            n = client.messages.count_tokens(
                model=REPORT_MODEL, system=SYSTEM,
                messages=[{"role": "user", "content": prompt}]).input_tokens
            line += f" · {n:,} 토큰 · 입력만 추정 ${n * PRICE_IN / 1e6:.2f}"
        print(line)

    for q in todo:
        rows = [n for n in c.news if quarter_of(n["published"]) == q]
        st = compute_stats(rows, lambda d: d[:7])
        show(f"{q} 분기 보고서({len(rows)}건)",
             quarter_prompt(c, q, rows, st, top_agencies(st), today))
    if want_overall:
        qdocs = [d for d in saved_docs() if d["kind"] == "quarter"]
        if qdocs:
            st = compute_stats(c.news, quarter_of)
            show("전체 보고서(저장된 분기 보고서 기준)",
                 overall_prompt(c, qdocs, st, top_agencies(st)))
        else:
            print("  전체 보고서: 분기 보고서를 먼저 만들어야 입력 크기를 알 수 있습니다")
    if client is None:
        print("  (ANTHROPIC_API_KEY 가 있으면 토큰 수와 입력 비용도 보여 줍니다)")


def prompt_file(job: dict) -> str:
    """손으로 모델에 넣을 수 있게 프롬프트와 응답 형식을 한 파일에 담는다."""
    return "\n\n".join([
        SYSTEM,
        job["prompt"],
        "응답은 아래 JSON 스키마에 맞는 JSON 하나로만 쓴다. 설명 문장이나 코드펜스는 붙이지 않는다.",
        json.dumps(job["schema"], ensure_ascii=False, indent=2),
    ])


def fail(msg: str, code: int = 1) -> int:
    """중단 사유를 알리고 종료 코드를 돌려준다. Actions 에서는 ::error:: 로 올려, 로그를
    열지 않아도(로그 열람은 관리자 권한이 필요하다) 실행 요약 화면에서 바로 보이게 한다."""
    print(f"::error::{msg}" if os.environ.get("GITHUB_ACTIONS") == "true" else msg)
    return code


def main() -> int:
    # 콘솔이 아닌 곳(파이프·리디렉션)으로 출력할 때 윈도우 기본 인코딩(cp949)에 없는
    # 문자('—' 등) 때문에 죽지 않게 한다.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")

    ap = argparse.ArgumentParser(description="천안시 관점 AX 동향보고서 생성")
    ap.add_argument("--quarter", help="이 분기 하나만 생성(예: 2026-Q3). 전체 보고서는 건너뜀")
    ap.add_argument("--force", action="store_true", help="확정된 분기까지 전부 다시 생성")
    ap.add_argument("--dry-run", action="store_true", help="API 호출 없이 계획과 입력 크기만 출력")
    ap.add_argument("--prompt-out", metavar="파일",
                    help="모델에 보낼 프롬프트와 응답 형식을 파일로 저장하고 끝낸다(API 를 쓸 수 "
                         "없는 환경용). --quarter 를 주면 그 분기, 없으면 전체 보고서")
    ap.add_argument("--from-json", metavar="파일",
                    help="모델이 돌려준 JSON 을 읽어 검증·생성한다(--prompt-out 의 짝)")
    ap.add_argument("--label", default="수동 입력",
                    help="--from-json 으로 만든 보고서에 남길 작성 주체(기본: 수동 입력)")
    ap.add_argument("--render-only", action="store_true",
                    help="저장된 json 으로 md/html·목록·한눈에 보기만 다시 만든다(API 호출 없음)")
    ap.add_argument("--budget-min", type=float, default=DEFAULT_BUDGET_MIN,
                    help=f"실행 시간 예산(분, 기본 {DEFAULT_BUDGET_MIN}분, 0이면 무제한). 남은 "
                         f"예산이 {CALL_RESERVE_MIN}분 아래면 새 보고서를 시작하지 않는다")
    args = ap.parse_args()
    if args.quarter:
        m = QUARTER_RE.match(args.quarter.strip())
        if not m:
            return fail(f"분기 형식이 잘못됐습니다: {args.quarter!r} (예: 2026-Q3)", 2)
        args.quarter = f"{m.group(1)}-Q{m.group(2)}"

    today = datetime.now(KST).date()
    c = Corpus()

    if args.render_only:
        docs = saved_docs()
        for d in docs:
            write_report(c, d, save_doc=False)
        write_index()
        write_highlights(c)
        print(f"저장된 보고서 {len(docs)}건을 다시 그렸습니다.")
        return 0

    todo, eligible = plan(c, args)
    if args.quarter and args.quarter not in eligible:
        return fail(f"{args.quarter} 은 기사가 {MIN_QUARTER_NEWS}건 미만이거나 없는 분기입니다. "
                    f"대상 분기: {', '.join(sorted(eligible))}", 2)
    want_overall = not args.quarter and (args.force or bool(todo) or latest_overall() is None)
    print(f"AX 동향보고서 — 분기 {len(todo)}건({', '.join(todo) or '없음'})"
          f" · 전체 {'생성' if want_overall else '생략'} · 모델 {REPORT_MODEL}")

    if args.dry_run:
        dry_run(c, todo, want_overall, today)
        return 0

    # API 없이 모델 호출만 손으로 대신하는 경로. 대상은 1건이다.
    if args.prompt_out or args.from_json:
        if args.quarter:
            job = quarter_job(c, args.quarter, today)
        else:
            qdocs = {d["period"]["quarter"]: d for d in saved_docs() if d["kind"] == "quarter"}
            missing = [q for q in eligible if q not in qdocs]
            if missing:
                return fail("전체 보고서는 분기 보고서가 모두 있어야 만듭니다. "
                            f"빠진 분기: {', '.join(missing)}", 2)
            job = overall_job(c, [qdocs[q] for q in sorted(qdocs)], today)
        if args.prompt_out:
            text = prompt_file(job)
            Path(args.prompt_out).write_text(text, encoding="utf-8", newline="\n")
            print(f"{job['label']} 프롬프트를 {args.prompt_out} 에 썼습니다 ({len(text):,}자).")
            return 0
        try:
            data = json.loads(Path(args.from_json).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            return fail(f"{args.from_json} 를 읽지 못했습니다: {e}", 2)
        doc = assemble(c, job, data, {"model": args.label, "inputTokens": 0,
                                      "outputTokens": 0, "seconds": 0})
        write_report(c, doc)
        write_index()
        write_highlights(c)
        print(f"{job['label']} 생성 완료 — {OUT_REL}/{doc['id']}.html")
        return 0

    if not os.environ.get("ANTHROPIC_API_KEY"):
        return fail("ANTHROPIC_API_KEY 가 없습니다. 보고서는 AI 없이 만들 수 없어 중단합니다. "
                    "GitHub 에서는 저장소 Settings > Secrets and variables > Actions 에 등록하세요.")
    import anthropic

    client = anthropic.Anthropic()
    budget = Budget(args.budget_min)
    failed: list[str] = []
    fatal = None

    def has_time(label: str) -> bool:
        if budget.seconds and budget.remaining < CALL_RESERVE_MIN * 60:
            warn(f"시간 예산이 {CALL_RESERVE_MIN}분 미만 남아 {label}을 다음 실행으로 넘깁니다 ({budget}).")
            return False
        return True

    for q in todo:
        if not has_time(f"{q} 분기 보고서"):
            failed.append(q)
            continue
        try:
            write_report(c, build_from_api(client, c, quarter_job(c, q, today)))
        except ReportError as e:
            warn(f"{q} 분기 보고서 실패 — {e}")
            failed.append(q)
        except FatalAPIError as e:
            fatal = e
            break

    if want_overall and fatal is None:
        qdocs = {d["period"]["quarter"]: d for d in saved_docs() if d["kind"] == "quarter"}
        missing = [q for q in eligible if q not in qdocs]
        if missing:
            warn(f"분기 보고서가 빠져 있어({', '.join(missing)}) 전체 보고서는 다음 실행으로 넘깁니다.")
        elif has_time("전체 보고서"):
            try:
                job = overall_job(c, [qdocs[q] for q in sorted(qdocs)], today)
                write_report(c, build_from_api(client, c, job))
            except ReportError as e:
                warn(f"전체 보고서 실패 — {e}")
                failed.append("전체")
            except FatalAPIError as e:
                fatal = e
        else:
            failed.append("전체")

    # 실패가 있어도 그때까지 만든 보고서는 목록에 반영한다.
    write_index()
    write_highlights(c)

    if fatal is not None:
        return fail(f"보고서 생성 중단 — {fatal}")
    if failed:
        # 예약 실행은 한 달에 한 번이라 '다음 실행'이 멀다. 실패로 끝내 알림이 가게 한다.
        print(f"\n만들지 못한 보고서: {', '.join(failed)} — 다음 실행에서 이어서 만듭니다"
              "(Actions 에서 수동 실행하면 바로 이어집니다).")
        return 1
    print("\n완료.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
