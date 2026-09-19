"""천안 일반 뉴스: 공개 뉴스 검색 RSS의 제목·출처·발행일·링크만 보관."""
import concurrent.futures
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'data/local-news.json'
KST = timezone(timedelta(hours=9))
PAPERS = ['대전일보', '충청투데이', '중도일보', '충청일보', '충청신문', '충남일보',
          '금강일보', '굿모닝충청', '시사뉴스24', '뉴스파고', '천안신문', '천안아산신문', 'C뉴스041']
NATIONAL = ['연합뉴스', '뉴시스', '뉴스1', '조선일보', '중앙일보', '동아일보', '한겨레', '경향신문',
            '한국일보', '서울신문', '국민일보', '세계일보', '문화일보', '매일경제', '한국경제']
ALIASES = {'yna.co.kr': '연합뉴스', 'newspago.com': '뉴스파고', 'hankyung.com': '한국경제',
           'ajunews.com': '아주경제', 'cctoday.co.kr': '충청투데이', 'sisanews24.co.kr': '시사뉴스24',
           'v.daum.net': '다음 뉴스 (매체 미확인)'}


def topic(title):
    for label, pattern in [('사건·안전', '사고|(?<!문)화재|경찰|범죄|재난|폭우|소방|학대'),
                           ('행정·정치', '시의회|시장|시정|의원|예산|정책'),
                           ('경제·개발', '산업|기업|투자|분양|아파트|개발|일자리|반도체|산단'),
                           ('교육·복지', '학교|교육|학생|대학|복지|돌봄'),
                           ('문화·생활', '축제|공연|문화|체육|축구|관광|리그|배구|천안시티')]:
        if re.search(pattern, title):
            return label
    return '기타'


def fetch(paper, now):
    query = '천안 when:7d' + (f' "{paper}"' if paper else '')
    url = 'https://news.google.com/rss/search?' + urlencode(dict(q=query, hl='ko', gl='KR', ceid='KR:ko'))
    try:
        with urlopen(Request(url, headers={'User-Agent': 'CheonanNewsDashboard/1.0'}), timeout=25) as response:
            root = ET.fromstring(response.read(3_000_000))
        rows = []
        for item in root.findall('./channel/item'):
            raw_source = item.findtext('source', '').strip()
            source = ALIASES.get(raw_source, raw_source)
            if source in ('Naver Blog', 'SK브로드밴드 회사소개'):
                continue
            if paper and re.sub(r'\s', '', source).lower() != re.sub(r'\s', '', paper).lower():
                continue
            title = item.findtext('title', '').removesuffix(' - ' + raw_source).strip()
            if '천안' not in title or '천안함' in title:
                continue
            link = item.findtext('link', '')
            if urlparse(link).scheme not in ('http', 'https'):
                continue
            try:
                published = parsedate_to_datetime(item.findtext('pubDate', '')).astimezone(KST)
            except (ValueError, TypeError):
                continue
            if not now - timedelta(days=7) <= published <= now + timedelta(minutes=5):
                continue
            key = source + ':' + re.sub(r'\s+', ' ', title)
            rows.append(dict(id=hashlib.sha256(key.encode()).hexdigest()[:20], title=title,
                             source=source, url=link, published=published.isoformat(), topic=topic(title),
                             group='충청·지역' if source in PAPERS else ('중앙·통신' if source in NATIONAL else '기타 매체')))
        return rows, dict(name=paper or '전체 매체 검색', status='ok', count=len(rows), checkedAt=now.isoformat())
    except Exception as error:
        return [], dict(name=paper or '전체 매체 검색', status='error', count=0,
                        checkedAt=now.isoformat(), error=type(error).__name__)


def main():
    now = datetime.now(KST)
    old = json.loads(OUTPUT.read_text(encoding='utf-8')) if OUTPUT.exists() else {'articles': []}
    articles = {}
    for r in old['articles']:
        if r['published'] < (now - timedelta(days=30)).isoformat() or r['source'] in ('Naver Blog', 'SK브로드밴드 회사소개'):
            continue
        r['source'] = ALIASES.get(r['source'], r['source'])
        r['id'] = hashlib.sha256((r['source'] + ':' + re.sub(r'\s+', ' ', r['title'])).encode()).hexdigest()[:20]
        r['group'] = '충청·지역' if r['source'] in PAPERS else ('중앙·통신' if r['source'] in NATIONAL else '기타 매체')
        r['topic'] = topic(r['title'])
        articles[r['id']] = r
    statuses = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for rows, status in pool.map(lambda name: fetch(name, now), [''] + PAPERS + NATIONAL):
            articles.update({r['id']: r for r in rows})
            statuses.append(status)
            print(f"{status['name']}: {status['status']} / {len(rows)}")
    success = sum(s['status'] == 'ok' for s in statuses)
    doc = dict(updated=now.isoformat(), lastSuccess=now.isoformat() if success else old.get('lastSuccess'),
               method='Google 뉴스 검색 RSS · 제목에 천안 포함 · 최근 7일 검색 / 30일 보관',
               sources=statuses, articles=sorted(articles.values(), key=lambda r: r['published'], reverse=True))
    OUTPUT.parent.mkdir(exist_ok=True)
    temporary = OUTPUT.with_suffix('.tmp')
    temporary.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(OUTPUT)
    if success != len(statuses):
        print('::warning::일부 매체 검색 실패. 이전 기사는 유지했습니다.')
    if not success:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
