"use strict";

// 상태
const state = {
  agencies: [],
  categories: [],
  agencyById: {},
  news: [],
  newsById: {},
  selectedAgency: null,
  category: "all",
  topic: "all",
  query: "",
  sort: "date_desc",
  topics: null,
  topicById: {},
  dashTopic: "all",
  dashHeatmapExpanded: false,
  dashBenchExpanded: false,
  agencyZeroExpanded: false,
  page: 1,
  pageSize: 20,
  summaryById: {},
  keywords: null,
  dashDateMinTs: null,
  dashDateMaxTs: null,
  dashRangeStartTs: null,
  dashRangeEndTs: null,
  milestones: null,
  msLane: "all",
  msSortDesc: true,
  trendIncludeCurrent: false,
};

// ── 이 사이트의 주체 기관(우리 기관) ──────────────────────────────
// 기관 목록(sortedAgencies/renderAgencies)과 히트맵(renderHeatmap), 기관별 추이
// 카드에서는 보도자료 건수와 무관하게 항상 맨 위에 고정하고, 벤치마킹(renderBench)
// 에서는 '타 기관 사례'가 성립하도록 제외한다.
// 기관이 또 바뀌어도 이 세 줄만 고치면 되도록 한 곳에 모아 둔다.
const HOME_AGENCY_ID = "cheonan";
const HOME_AGENCY_NAME = "천안시";
const isHomeAgency = (a) => !!a && a.id === HOME_AGENCY_ID;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
// highlights.json 원문 HTML은 href 값의 &를 이미 &amp;로 올바르게 인코딩해 두는데,
// 정규식으로 그 텍스트를 그대로 캡처해 쓰면(파싱이 아니라 문자열 매칭이라 디코딩이
// 안 됨) esc()가 한 번 더 인코딩해 &amp;amp;가 된다 — 매칭/링크 생성 전에 되돌린다.
const unescHtml = (s) =>
  String(s == null ? "" : s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// 주제색 위에 올릴 글자색 — 주제 팔레트는 계열별로 밝은 단계를 포함하므로(흰 배경
// 대비 3:1 미만) 밝은 색 위에 흰 글자를 올리면 읽히지 않는다. 상대휘도로 흰색/먹색을
// 골라 칩이 활성화됐을 때의 가독성을 보장한다.
function inkOn(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return "#fff";
  const ch = (i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
  // 흰 글자 대비 vs 먹 글자 대비를 비교해 더 잘 읽히는 쪽
  return (1.05 / (lum + 0.05)) >= ((lum + 0.05) / 0.05) ? "#fff" : "#0b0b0b";
}

// 심플·프로페셔널 라인 아이콘(인라인 SVG, currentColor)
const ICON_AGENCY =
  '<svg class="ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V9.5L12 5l7 4.5V21M9.5 21v-5h5v5"/></svg>';
const ICON_DATE =
  '<svg class="ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="16" rx="2"/><path d="M8 3v3M16 3v3M3.5 9.5h17"/></svg>';
const ICON_CHEVRON =
  '<svg class="ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

async function getJSON(path, fallback) {
  try {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) {
    return fallback;
  }
}

// 첫 화면을 그리는 데 먼저 받는 최근 개월 수. 뉴스 목록 기본 정렬이 최신순이라
// 이 범위만으로 첫 페이지가 완성되고, 나머지 과거 월은 뒤이어 받아 채운다.
const FIRST_PAINT_MONTHS = 6;

// 월 단위 청크 로딩 — 지정한 월들의 뉴스·요약을 받아 state 에 누적한다.
// 뉴스 본문과 AI 요약은 서로 독립적이므로 두 배치를 동시에 요청한다.
async function loadMonthChunk(monthKeys) {
  if (!monthKeys.length) return;
  const [newsDocs, summaryDocs] = await Promise.all([
    Promise.all(monthKeys.map((m) => getJSON(`data/news/${m}.json`, []))),
    Promise.all(monthKeys.map((m) => getJSON(`data/summaries/${m}.json`, {}))),
  ]);
  // 목록 정렬은 렌더 시점(filteredNews)에 하므로 받은 순서대로 이어 붙이면 된다.
  const flat = newsDocs.flat();
  state.news = state.news.concat(flat);
  flat.forEach((n) => { state.newsById[n.id] = n; });
  Object.assign(state.summaryById, ...summaryDocs);
}

async function init() {
  // 초기 로딩 속도 개선: 서로 의존하지 않는 요청을 최대한 동시에 쏘고, 뉴스
  // 목록 첫 페인트에 실제로 필요 없는 데이터(키워드 관계망 등 대시보드 전용)는
  // 뒤로 미룬다. topics.json/keywords.json은 월 목록과 무관하므로 맨 처음부터
  // 미리 요청을 걸어 두고, 실제로 쓰는 시점에 결과만 기다린다(사실상 공짜).
  const topicsPromise = getJSON("data/topics.json", null);
  const keywordsPromise = getJSON("data/keywords.json", null);

  const [agenciesDoc, index, collectionStatus] = await Promise.all([
    getJSON("data/agencies.json", { categories: [], agencies: [] }),
    getJSON("data/news/index.json", { updated: null, months: [], total: 0 }),
    getJSON("data/collection-status.json", null),
  ]);
  state.categories = agenciesDoc.categories || [];
  state.agencies = agenciesDoc.agencies || [];
  state.agencyById = Object.fromEntries(state.agencies.map((a) => [a.id, a]));

  const koreaStatus = collectionStatus && collectionStatus.koreaKr;
  if (koreaStatus && koreaStatus.status === "failed") {
    $("#last-updated").textContent = "정부자료 수집 실패: " +
      new Date(koreaStatus.lastAttempt).toLocaleString("ko-KR") + " · 자동 재시도 예정";
  } else if (koreaStatus && koreaStatus.status === "partial") {
    $("#last-updated").textContent = "정부자료 일부 갱신: " +
      new Date(koreaStatus.lastAttempt).toLocaleString("ko-KR") +
      ` (${koreaStatus.agenciesChecked}/${koreaStatus.agenciesTotal}개 기관)`;
  } else {
    const updatedAt = koreaStatus && koreaStatus.lastSuccess
      ? koreaStatus.lastSuccess : index.updated;
    $("#last-updated").textContent = updatedAt
      ? "갱신: " + new Date(updatedAt).toLocaleString("ko-KR")
      : "아직 수집 전";
  }

  const months = index.months || [];
  // 누적 수집 건수는 index.json 의 total 이 정답이므로 여기서 바로 표기한다
  // (아래 단계별 로딩 중에 중간값이 잠깐 보이는 일이 없게 함).
  $("#side-total").textContent = (index.total || 0).toLocaleString("ko-KR");

  // 월이 계속 누적되면 전체 월을 한 번에 받는 방식은 초기 로딩이 선형으로 무거워진다.
  // 그래서 최근 FIRST_PAINT_MONTHS 개월만 먼저 받아 첫 화면을 그리고, 과거 월은
  // 백그라운드로 이어 받은 뒤 전 기간 기준으로 다시 그린다(검색·대시보드는 전 기간 대상).
  const recentMonths = months.slice(-FIRST_PAINT_MONTHS);
  const olderMonths = months.slice(0, Math.max(0, months.length - FIRST_PAINT_MONTHS));

  await loadMonthChunk(recentMonths);
  computeDashDateBounds();

  // 뉴스 목록 배지·주제칩에 쓰이므로 여기서 받아둔다 — 맨 처음부터 병렬로 요청
  // 중이었으므로(topicsPromise) 이 시점엔 대개 이미 도착해 있어 추가 지연이 없다.
  state.topics = await topicsPromise;
  if (state.topics) {
    state.topicById = Object.fromEntries((state.topics.topics || []).map((t) => [t.id, t]));
  }

  setupTabs();
  setupControls();
  setupSidebarToggle();
  setupNewsModal();
  setupSubtopicModal();
  setupBackToTop();
  trackVisit();
  renderCategoryChips();
  renderTopicChips();
  renderAgencies();
  renderNews();
  loadReports();
  loadMilestones();

  // 과거 월을 이어 받는다. 기본 정렬이 최신순이라 목록 첫 페이지는 그대로이고,
  // 검색·필터·기간 범위만 전 기간으로 넓어진다.
  if (olderMonths.length) {
    await loadMonthChunk(olderMonths);
    computeDashDateBounds();
    renderNews();
    // AX 동향 하이라이트의 '출처'는 요약이 있는 근거를 요약 팝업으로 연결하는데,
    // 첫 로딩 시점엔 최근 몇 개월치만 있어 오래된 근거는 매칭에 실패해 원문
    // 링크로 남는다 — 과거 월이 다 들어온 뒤 다시 그려 놓친 매칭을 채운다.
    loadAxHighlights();
  }

  // 키워드 관계망은 '월별추이' 탭에서만 쓰이므로 뉴스 목록 페인트를 막지 않게
  // 가장 마지막에 기다린다. 대시보드는 전 기간 데이터가 모두 도착한 뒤 한 번만 그린다.
  state.keywords = await keywordsPromise;
  renderDashboard();
  renderDashboard2();
}

function selectTab(tabName) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((x) => x.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${tabName}"]`)?.classList.add("active");
  $("#tab-" + tabName)?.classList.add("active");
}

function closeSidebarMobile() {
  const sidebar = $("#sidebar-panel");
  const btn = $("#sidebar-toggle");
  if (!sidebar || !btn) return;
  sidebar.classList.remove("open");
  btn.setAttribute("aria-expanded", "false");
}

function setupSidebarToggle() {
  const btn = $("#sidebar-toggle");
  const sidebar = $("#sidebar-panel");
  if (!btn || !sidebar) return;
  btn.addEventListener("click", () => {
    const open = sidebar.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(open));
  });
}

// 방문 기록 — 화면에는 아무것도 표시하지 않고 서버 로그에만 남긴다. 브라우저마다
// 익명 id 하나를 localStorage에 남겨 재방문과 순방문자를 구분하고, 수집 엔드포인트로
// 한 번 fire-and-forget 전송한다. 실패해도 페이지 이용에는 영향이 없다.
//
// 엔드포인트는 서버리스 함수(원본은 Vercel 의 api/visit.js → Vercel KV)가 있어야
// 동작한다. GitHub Pages 는 정적 호스팅이라 그런 함수가 없고, 경로도 저장소 하위가
// 아닌 도메인 루트(https://<계정>.github.io/api/visit)로 나가 매 방문마다 404 만
// 남는다. 그래서 정적 배포에서는 null 로 두어 아예 보내지 않는다.
// 서버리스 환경으로 옮기면 이 한 줄만 "/api/visit" 로 되돌리면 된다.
const VISIT_ENDPOINT = null;

function trackVisit() {
  if (!VISIT_ENDPOINT) return;
  try {
    const KEY = "govax_cid";
    let cid = localStorage.getItem(KEY);
    if (!cid) {
      cid = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(KEY, cid);
    }
    fetch(VISIT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) {
    // localStorage 접근 불가(프라이빗 모드 등) — 방문 기록만 건너뛴다.
  }
}

// 화면을 일정 길이 이상 내려서 스크롤할 항목이 많아졌을 때만 버튼을 보여준다
// (짧은 탭에서는 굳이 필요 없으므로 늘 떠 있게 하지 않음).
const BACK_TO_TOP_SHOW_AT = 400;

function setupBackToTop() {
  const btn = $("#back-to-top");
  if (!btn) return;
  const update = () => { btn.hidden = window.scrollY < BACK_TO_TOP_SHOW_AT; };
  window.addEventListener("scroll", update, { passive: true });
  update();
  btn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => selectTab(t.dataset.tab));
  });
  const brandTitle = $("#brand-title");
  if (brandTitle) {
    brandTitle.addEventListener("click", () => selectTab("news"));
    brandTitle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectTab("news");
      }
    });
  }
}

function setupControls() {
  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    state.page = 1;
    renderNews();
  });
}

function renderCategoryChips() {
  const box = $("#category-chips");
  box.innerHTML = "";
  const mk = (label, catOrNull, wide) => {
    const chip = el("button", "chip" + (wide ? " chip-wide" : ""), esc(label));
    if (catOrNull) chip.dataset.cat = catOrNull;
    return chip;
  };

  const all = mk("전체 분류", null, true);
  all.classList.add("active");
  all.addEventListener("click", () => selectCategory("all"));
  box.appendChild(all);

  // 부·처·청 — 한 줄(3열)에 배치. '처·청'은 데이터상 단일 category 라서
  // 기관명 접미사 기준으로 화면에서만 처/청 두 버튼으로 나눈다.
  [
    { label: "부", cat: "ministry" },
    { label: "처", cat: "office_cheo" },
    { label: "청", cat: "office_cheong" },
  ].forEach(({ label, cat }) => {
    const chip = mk(label, cat, false);
    chip.addEventListener("click", () => selectCategory(cat));
    box.appendChild(chip);
  });

  const committee = state.categories.find((c) => c.id === "committee");
  if (committee) {
    const chip = mk(committee.name, committee.id, true);
    chip.addEventListener("click", () => selectCategory(committee.id));
    box.appendChild(chip);
  }

  // 지자체(천안시) — agencies.json 의 categories 에 {id:"local"} 이 있을 때만 칩을
  // 만든다. agencyMatchesCategory() 의 마지막 폴백(a.category === catId)이 그대로
  // 처리하므로 필터 쪽에는 추가 수정이 필요 없다.
  const local = state.categories.find((c) => c.id === "local");
  if (local) {
    const chip = mk(local.name, local.id, true);
    chip.addEventListener("click", () => selectCategory(local.id));
    box.appendChild(chip);
  }
}

// '처·청' 은 데이터상 단일 category("office")라서, 실제 기관명 접미사(처/청)로 화면에서만 세분화한다.
function agencyMatchesCategory(a, catId) {
  if (!a || catId === "all") return true;
  if (catId === "office_cheo") return a.category === "office" && /처$/.test(a.name || "");
  if (catId === "office_cheong") return a.category === "office" && /청$/.test(a.name || "");
  return a.category === catId;
}

function selectCategory(catId) {
  state.category = catId;
  state.page = 1;
  state.agencyZeroExpanded = false;
  document.querySelectorAll("#category-chips .chip").forEach((c) => {
    const active = (catId === "all" && !c.dataset.cat) || c.dataset.cat === catId;
    c.classList.toggle("active", active);
  });
  renderAgencies();
  renderNews();
}

// 카테고리 필터 적용 후 정렬된 기관 목록(천안시 최상단 고정 + 나머지는 보도자료순).
// renderAgencies()/filteredNews() 가 동일 기준을 쓰도록 단일 소스로 둔다.
function sortedAgencies() {
  let list = state.agencies.slice();
  if (state.category !== "all") list = list.filter((a) => agencyMatchesCategory(a, state.category));
  // 천안시는 이 사이트의 주체 기관이므로 보도자료 건수와 무관하게 항상 맨 앞에 두고,
  // 나머지 기관만 건수 내림차순으로 정렬한다.
  list.sort((a, b) => {
    const ha = isHomeAgency(a) ? 1 : 0;
    const hb = isHomeAgency(b) ? 1 : 0;
    if (ha !== hb) return hb - ha;
    return (b.newsCount || 0) - (a.newsCount || 0);
  });
  return list;
}

// AX 하위주제 필터 칩(히트맵과 동일한 주제 기준, '기타' 제외)
function renderTopicChips() {
  const box = $("#topic-chips");
  if (!box) return;
  box.innerHTML = "";
  const topics = state.topics ? (state.topics.topics || []).filter((t) => t.id !== "other") : [];
  const all = el("button", "chip tchip-all active", "전체");
  all.addEventListener("click", () => selectTopic("all"));
  box.appendChild(all);
  topics.forEach((t) => {
    const chip = el("button", "chip tchip");
    chip.dataset.topic = t.id;
    chip.textContent = t.name;
    chip.style.setProperty("--tc", t.color || "#8b95a4");
    chip.style.setProperty("--tc-ink", inkOn(t.color));
    chip.addEventListener("click", () => selectTopic(t.id));
    box.appendChild(chip);
  });
}

function selectTopic(topicId) {
  state.topic = topicId;
  state.page = 1;
  document.querySelectorAll("#topic-chips .chip").forEach((c) => {
    const active = (topicId === "all" && !c.dataset.topic) || c.dataset.topic === topicId;
    c.classList.toggle("active", active);
  });
  renderNews();
}

const AGENCY_ZERO_TOP_N = 3;

function renderAgencies() {
  const ul = $("#agency-list");
  ul.innerHTML = "";

  const list = sortedAgencies();
  // 천안시는 건수가 0이 되더라도 '0건 기관' 접힘 영역으로 밀려나면 안 되므로
  // 분류 단계에서 명시적으로 제외해 항상 목록 맨 위에 남긴다.
  const nonZero = list.filter((a) => isHomeAgency(a) || (a.newsCount || 0) > 0);
  const zero = list.filter((a) => !isHomeAgency(a) && !((a.newsCount || 0) > 0));
  const expanded = state.agencyZeroExpanded || zero.length <= AGENCY_ZERO_TOP_N;
  const visibleZero = expanded ? zero : zero.slice(0, AGENCY_ZERO_TOP_N);

  const mkItem = (a) => {
    const cls = "agency-item" +
      (isHomeAgency(a) ? " home-agency" : "") +
      (state.selectedAgency === a.id ? " active" : "");
    const li = el("li", cls);
    li.innerHTML =
      `<span class="agency-name">${esc(a.name)}</span>` +
      `<span class="agency-count">${a.newsCount || 0}</span>`;
    li.addEventListener("click", () => {
      state.selectedAgency = state.selectedAgency === a.id ? null : a.id;
      state.page = 1;
      renderAgencies();
      renderNews();
      closeSidebarMobile();
    });
    return li;
  };

  nonZero.forEach((a) => ul.appendChild(mkItem(a)));
  visibleZero.forEach((a) => ul.appendChild(mkItem(a)));

  if (zero.length > AGENCY_ZERO_TOP_N) {
    const li = el("li", "agency-toggle-wrap");
    const btn = el("button", "hm-toggle agency-toggle",
      expanded ? "접기 ▲" : `0건 기관 더 보기 · ${zero.length}개 ▼`);
    li.appendChild(btn);
    btn.addEventListener("click", () => {
      state.agencyZeroExpanded = !state.agencyZeroExpanded;
      renderAgencies();
    });
    ul.appendChild(li);
  }
}

function filteredNews() {
  return state.news
    .filter((n) => (state.selectedAgency ? n.agency_id === state.selectedAgency : true))
    .filter((n) => agencyMatchesCategory(state.agencyById[n.agency_id], state.category))
    .filter((n) => (state.topic === "all" ? true : (n.topics || []).includes(state.topic)))
    .filter((n) => {
      if (!state.query) return true;
      const a = state.agencyById[n.agency_id];
      const hay = (
        n.title + " " + (n.snippet || "") + " " + (a ? a.name : "") +
        " " + (n.matched || []).join(" ")
      ).toLowerCase();
      return hay.includes(state.query);
    })
    // '마일스톤' 정렬은 정렬이 아니라 사실상 필터 — 마일스톤에 등재된 항목만
    // 남기고 최신순으로 보여준다(그냥 "마일스톤을 앞으로" 정도로는 부족하다는
    // 피드백, 2026-08-26: 총 건수도 마일스톤 건수로 집계돼야 함).
    .filter((n) => (state.sort === "milestone" ? milestoneNewsIds().has(n.id) : true))
    .sort(newsComparator(state.sort));
}

function newsComparator(sort) {
  const d = (n) => n.published || n.first_seen || "";
  if (sort === "date_asc") return (a, b) => d(a).localeCompare(d(b));
  return (a, b) => d(b).localeCompare(d(a)); // date_desc·milestone 공통(최신순)
}

// 조회 시점(오늘) 기준 발행일이 전일까지면 신규로 본다.
function isNewsNew(n) {
  const d = n.published || n.first_seen || "";
  if (d.length < 10) return false;
  const pub = new Date(d.slice(0, 10) + "T00:00:00");
  if (isNaN(pub)) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today - pub) / 86400000);
  return diffDays >= 0 && diffDays <= 1;
}

// 보도자료 부제목 추출.
// snippet 형식 예) "<제목반복> <부제…> 【관련 국정과제】… <본문>… 2026-07-24 <기관>"
// 부제는 불릿(–/-/▲ 등)이 있을 때도, 없이 공백으로만 이어질 때도 있으므로,
// '본문 시작 신호'(기관명+(직위…) / …밝혔다·발표했다) 앞부분을 부제 영역으로 본다.
// 제목 반복(띄어쓰기 차이 허용)·날짜/기관 꼬리·【관련 국정과제】 이후·첨부 안내 보일러플레이트는 제거.
const _SUB_BUL = "\\-\\u2013\\u2014\\u25b2\\u25b5\\u25bd\\u25cf\\u25cb\\u25a0\\u25a1\\u25b6\\u25e6\\u203b";
const _SUB_SEP = new RegExp("(?:^|\\s)[" + _SUB_BUL + "]\\s+");
const _SUB_BODY = new RegExp(
  "[가-힣A-Za-z0-9·]{2,18}\\s*\\(\\s*(?:장관|차관|처장|청장|위원장|부위원장|본부장|원장|국장|실장|단장|과장|직무대행|대표|사장|회장|이사장)" +
  "|(?:이라고|라고)?\\s*밝혔다|발표했다|다고\\s*밝혔");
// "첨부파일 참고"는 "첨부파일을 참고"(조사 있음)뿐 아니라 조사 없이 붙는 경우도
// 있다(실측: 2026-08-26, 금융위 마이데이터 발전방안 보도자료 — snippet이 "자세한
// 내용은 첨부파일 참고 부탁드립니다."뿐이라 이 안내문 자체가 부제로 노출됨).
const _SUB_BOILER = /첨부파일\s*(?:을|은)?\s*참고|관련 보도자료 내용입니다|대용량 첨부파일|바로보기가 지원|첨부파일명을 클릭/;
function _subEsc(c) { return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function _subStripTitle(s, t) {
  if (!t) return s;
  const re = new RegExp("^\\s*" + t.replace(/\s+/g, "").split("").map(_subEsc).join("\\s*") + "\\s*");
  return s.replace(re, "");
}
function _subClean(seg) {
  seg = seg.replace(/^[\-–—▲▵▽●○■□▶◦※·\s]+/, "").trim();
  seg = seg.replace(/\s*[\-–—]{3,}[\s\S]*$/, "").trim();  // 구분선(---) 이후 제거
  seg = seg.replace(/[\s\-–—·]+$/, "").trim();
  return seg;
}
const _SUB_PREVIEW_MAX = 130;
function subtitleOf(it) {
  if (it.subtitle) return it.subtitle;
  let s = (it.snippet || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = _subStripTitle(s, (it.title || "").trim());
  s = s.replace(/\s*20\d\d-\d\d-\d\d\s+\S+\s*$/, "").trim(); // 날짜+기관 꼬리 제거
  s = s.split("【")[0].trim();                               // 관련 국정과제 이후 제거
  const bm = s.search(_SUB_BODY);
  let region = _subClean((bm >= 0 ? s.slice(0, bm) : s).trim());
  // 소관부처 전문(예: "행정안전부 국립과학수사연구원(원장 …)는…"에서 바디 시작
  // 표지 앞의 "행정안전부")만 남는 경우가 있다 — 공백 없는 짧은 토큰은 부제가
  // 아니라 기관명 잔재일 가능성이 높으므로 제외.
  const looksLikeBareName = region && !/\s/.test(region) && region.length < 15;
  if (region && !looksLikeBareName && region.length <= 230) {
    let parts = _SUB_SEP.test(region) ? region.split(_SUB_SEP) : [region];
    parts = parts.map(_subClean).filter(Boolean).filter((p) => !_SUB_BOILER.test(p));
    const joined = parts.slice(0, 5).join(" · ");
    if (joined) return joined;
  }
  // 부제 없이 본문이 바로 시작하는 경우(예: "기관(장관 …)는 …" 로 시작) — 표시할
  // 부제 영역이 없으므로, 본문 도입부를 짧은 미리보기로 대신 보여준다.
  // 첨부파일 안내뿐이라 실질 내용이 없으면(환각 방지) 아무것도 표시하지 않는다.
  let preview = _subClean((bm >= 0 ? s.slice(bm) : s).trim());
  if (!preview || _SUB_BOILER.test(preview.slice(0, 40))) return "";
  if (preview.length > _SUB_PREVIEW_MAX) {
    preview = preview.slice(0, _SUB_PREVIEW_MAX).replace(/\s+\S*$/, "") + "…";
  }
  return preview;
}

function renderNews() {
  const list = $("#news-list");
  const empty = $("#empty");
  const af = $("#active-filter");

  if (state.selectedAgency) {
    const a = state.agencyById[state.selectedAgency];
    af.hidden = false;
    af.innerHTML = `필터: <strong>${esc(a ? a.name : state.selectedAgency)}</strong>`;
    const btn = el("button", null, "해제");
    btn.addEventListener("click", () => {
      state.selectedAgency = null;
      renderAgencies();
      renderNews();
    });
    af.appendChild(btn);
  } else {
    af.hidden = true;
  }

  list.innerHTML = "";

  const items = filteredNews();
  if (items.length === 0) {
    empty.hidden = false;
    empty.textContent = state.news.length
      ? "조건에 맞는 뉴스가 없습니다."
      : "아직 수집된 뉴스가 없습니다. 자동 수집(GitHub Actions) 첫 실행 후 표시됩니다.";
    renderPager($("#pager-top"), 0, 1, 0, 0, true);
    renderPager($("#pager-bottom"), 0, 1, 0, 0, false);
    return;
  }
  empty.hidden = true;

  // 페이지네이션
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > pages) state.page = pages;
  if (state.page < 1) state.page = 1;
  const start = (state.page - 1) * state.pageSize;
  const pageItems = items.slice(start, start + state.pageSize);

  renderPager($("#pager-top"), total, pages, start, pageItems.length, true);

  pageItems.forEach((n) => {
    const a = state.agencyById[n.agency_id];
    const sub = subtitleOf(n);
    const summary = (state.summaryById[n.id] || {}).summary || "";
    const newBadge = isNewsNew(n) ? '<span class="new-badge">NEW</span>' : "";
    const primaryId = n.primary_topic || (n.topics || [])[0];
    const primaryTopic = primaryId ? state.topicById[primaryId] : null;
    const topicDot = primaryTopic
      ? `<span class="topic-dot" style="--tc:${esc(primaryTopic.color || "#8b95a4")}" title="${esc(primaryTopic.name)}"></span>`
      : "";
    const card = el("article", "news-card" + (summary ? " clickable" : ""));
    card.innerHTML =
      `<div class="news-meta">` +
        `<span class="meta-item">${ICON_AGENCY} ${esc(a ? a.name : n.agency_id)}</span>` +
        (n.published ? `<span class="meta-item">${ICON_DATE} ${esc(n.published)}</span>` : "") +
      `</div>` +
      (summary
        ? `<h3>${topicDot}${newBadge}${esc(n.title)}</h3>`
        : `<h3>${topicDot}${newBadge}<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></h3>`) +
      (sub ? `<p class="news-sub">${esc(sub)}</p>` : "");
    if (summary) {
      card.addEventListener("click", () => openNewsModal(n, summary));
    }
    list.appendChild(card);
  });

  renderPager($("#pager-bottom"), total, pages, start, pageItems.length, false);
}

// 요약문 줄 앞의 "(배경)", "(방식)", "(특징)" 같은 짧은 분류 태그를 굵게 강조.
// summary_rules.md가 모든 줄에 이 괄호 태그를 붙이도록 하므로, 화면에서도 한눈에
// 보이게 렌더링 쪽에서 받아 처리한다.
const _SUMMARY_TAG_RE = /^(\([^()]{1,14}\))\s*(.*)$/;
// 예전 데이터(다른 월)에 남아있는 "이름 직함: 발언" 형식의 화자 인용 줄도 계속
// 굵게 강조한다(라벨은 공백 1개 포함 최대 2단어까지만 인정 — "함께 공개"처럼
// 두 단어짜리는 살리고, 일반 문장 속의 콜론은 건너뛴다).
const _SUMMARY_LABEL_RE = /^([가-힣A-Za-z0-9·]{1,8}(?: [가-힣A-Za-z0-9·]{1,8})?)\s*:\s*(.+)$/;
function summaryToHtml(summary) {
  return (summary || "").split("\n").map((line) => {
    const mTag = line.match(_SUMMARY_TAG_RE);
    if (mTag) return `<strong>${esc(mTag[1])}</strong>${mTag[2] ? " " + esc(mTag[2]) : ""}`;
    const m = line.match(_SUMMARY_LABEL_RE);
    return m ? `<strong>${esc(m[1])}:</strong> ${esc(m[2])}` : esc(line);
  }).join("\n");
}

// 마일스톤(data/milestones.json)에 오른 보도자료 id 집합 — 마일스톤은 이미
// "AI 동향" 타임라인에 오를 만큼 중요하다고 큐레이션된 정책 이벤트라, 특정
// 키워드를 새로 고르는 대신 이 판정을 그대로 재사용해 팝업 목록에서 제목
// 전체를 굵게 강조한다.
function milestoneNewsIds() {
  return new Set(((state.milestones && state.milestones.events) || []).map((e) => e.id));
}
function newsListTitleHtml(n, msIds) {
  return msIds.has(n.id) ? `<strong>${esc(n.title)}</strong>` : esc(n.title);
}

// 상세 팝업(뉴스·마일스톤 공용) — 기관·날짜·제목·AI 요약을 보여주고 '원문 보기'로 이동.
function openSummaryModal({ agency, date, title, url, summary }) {
  $("#nm-agency").innerHTML = `${ICON_AGENCY} ${esc(agency || "")}`;
  $("#nm-date").innerHTML = date ? `${ICON_DATE} ${esc(date)}` : "";
  $("#nm-title").textContent = title || "";
  $("#nm-link").href = httpUrl(url) || "#";
  $("#nm-summary").innerHTML = summaryToHtml(summary);
  $("#nm-summary").hidden = false;
  document.getElementById("news-modal").hidden = false;
}

// 뉴스 상세 팝업 — AI 요약(10줄 이내)이 있는 기사만 카드 클릭 시 표시.
// 요약이 아직 없는 기사는 카드에 팝업을 붙이지 않고, 제목 클릭 시 원문으로 바로 이동한다.
function openNewsModal(n, summary) {
  const a = state.agencyById[n.agency_id];
  openSummaryModal({
    agency: a ? a.name : n.agency_id,
    date: n.published,
    title: n.title,
    url: n.url,
    summary,
  });
}

// 마일스톤 상세 팝업 — 뉴스와 같은 팝업을 쓰되, 요약은 해당 보도자료의 AI 요약을
// 그대로 보여주고(뉴스 탭과 동일한 내용) 아직 요약이 없으면 마일스톤 설명으로 대체한다.
function openMilestoneModal(e, laneName) {
  const summary = (state.summaryById[e.id] || {}).summary || e.detail || "";
  openSummaryModal({
    agency: [e.agency, laneName].filter(Boolean).join(" · "),
    date: e.date,
    title: e.title,
    url: e.url,
    summary,
  });
}
function closeNewsModal() {
  document.getElementById("news-modal").hidden = true;
}
function setupNewsModal() {
  const modal = $("#news-modal");
  modal.addEventListener("click", (e) => {
    if (e.target.dataset.close) closeNewsModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeNewsModal();
  });
  // 원문 보기(새 창)를 클릭하면 새 창은 그대로 열리고, 팝업은 자동으로 닫는다.
  $("#nm-link").addEventListener("click", () => closeNewsModal());
}

// ---- 세부 분류 드릴다운(대시보드 "최다 주제 TOP 3" 클릭) ----
// 주제별 제목 키워드 규칙 — 실제 수집 데이터를 훑어 각 주제 안에서 반복되는
// 패턴을 근거로 만들었다(2026-08-26). 본문이 아닌 제목만 보는 가벼운 휴리스틱이라
// "기타"류 비중이 남을 수 있다 — 정밀 분류가 아니라 그 주제 안에 대략 어떤 결이
// 섞여 있는지 감을 잡기 위한 용도. 어떤 주제가 TOP3에 올라오든 뜨도록 topics.json의
// 13개 주제 전부에 규칙을 준비해뒀다(TOP3 구성이 바뀌어도 새로 손볼 필요 없음).
const SUBTOPIC_RULES = {
  genai: {
    fallback: "기타 생성형 AI 활용",
    rules: [
      ["독자 파운데이션 모델 프로젝트", /파운데이션 모델|기초 모형/],
      ["의료·바이오 응용", /의료|바이오|디지털의료기기/],
      ["행정·업무 도구 적용", /메신저|행정|업무/],
      ["국방·안보 응용", /국방|방산/],
    ],
  },
  agent: {
    fallback: "정책·전략 발표",
    rules: [
      ["공무원 자체개발(AI 정부실험실 등)", /공무원|AI\s*정부\s*실험실|자체\s*개발|직접\s*만든|직접\s*개발/],
      ["해커톤·공모전", /해커톤|챌린지|Challenge/i],
      ["AI 에이전트·비서 서비스", /비서|Agent|에이전트(?!틱)/i],
      ["에이전틱 AI 산업·생태계 전략", /에이전틱|자율형\s*인공지능|얼라이언스/],
    ],
  },
  physical: {
    fallback: "기타 피지컬 AI",
    rules: [
      ["드론", /드론/],
      ["AI 팩토리·스마트제조", /AI\s*팩토리|스마트제조|제조혁신|제조\s*AI/],
      ["로봇·휴머노이드·자율주행", /로봇|휴머노이드|자율주행/],
      ["예산·조직", /예산|편성/],
      ["현장간담회·산학연 협력", /간담회|산학연|방문/],
    ],
  },
  industry: {
    fallback: "기타 산업 AX",
    rules: [
      ["중소기업·소상공인 지원", /중소기업|소상공인|중기부/],
      ["AI 팩토리·스마트제조", /AI\s*팩토리|스마트제조|지능형.*제조/],
      ["농업·축산 현장 적용", /농업|축산|농식품/],
      ["부처 합동 현장간담회(릴레이)", /릴레이|간담회/],
      ["산업 전환 전략 발표", /전략\s*발표|확산\s*3\.0|3대\s*전략/],
    ],
  },
  data: {
    fallback: "기타 데이터 활용",
    rules: [
      ["의료데이터", /의료데이터|의료\s*인공지능|한의약/],
      ["공공데이터 품질·표준", /공공데이터|AI-Ready|데이터\s*표준|학습용\s*데이터/],
      ["산업데이터 협력", /산업데이터|제조데이터|데이터\s*협력/],
      ["노동·일터 안전 데이터", /위험\s*사업장|안전한\s*일터/],
      ["학술·통계 포럼·세미나", /심포지엄|포럼|세미나/],
    ],
  },
  infra: {
    fallback: "기타 인프라",
    rules: [
      ["AI 반도체", /반도체/],
      ["국가 AI컴퓨팅센터·클라우드", /컴퓨팅\s*센터|클라우드/],
      ["국방 인프라", /국방/],
      ["R&D·예타", /예비타당성|연구개발\s*추진|R&D/i],
      ["경진대회(AI챔피언 등)", /챔피언|100가지\s*도전/],
    ],
  },
  startup: {
    fallback: "기타 스타트업·투자",
    rules: [
      ["경진대회·해커톤·공모전", /챌린지|해커톤|경진대회|공모전/],
      ["스타트업 해외진출", /해외진출|실리콘밸리|뉴욕진출/],
      ["벤처투자·유니콘 육성", /벤처투자|유니콘/],
      ["창업 멘토링·네트워킹", /멘토링|네트워킹|컨퍼런스/],
      ["축제·행사", /축제|오디세이/],
    ],
  },
  talent: {
    fallback: "정책·사업 추진(예산·전략·지정 등)",
    rules: [
      ["교육과정·연수", /사내대학원|교육과정|연수|부트캠프|아카데미|훈련|특강|커리큘럼|교육혁신|재교육/],
      ["포럼·세미나·간담회", /포럼|세미나|컨퍼런스|콘퍼런스|간담회|워크숍|심포지엄/],
      ["행사·축제", /축제|주간|콘서트|체험/],
      ["경진대회·공모전", /해커톤|경진대회|공모전|콘테스트|챌린지|경연|Hack\s*Camp/i],
      ["채용·인사", /채용/],
      ["자격증·역량인증", /자격증|인증(?!서)/],
    ],
  },
  law: {
    fallback: "기타 법·제도",
    rules: [
      ["국가AI전략위 출범·운영", /국가인공지능전략위원회|국가AI전략위/],
      ["법령정보서비스", /법령정보|법제처/],
      ["의료제품 규제(AIRIS 등)", /AIRIS|의료제품/],
      ["세제·국제인증", /세법|국제인증/],
      ["지식재산 정책", /지식재산/],
    ],
  },
  security: {
    fallback: "기타 보안·안전",
    rules: [
      ["딥페이크·가짜뉴스 대응", /딥페이크|가짜뉴스/],
      ["사이버보안·해킹방어", /사이버|해킹|침해대응/],
      ["AI모델 안전성 평가", /안전성.*평가|AI\s*안전/],
      ["마약·범죄수사 활용", /마약|보이스피싱|수사/],
      ["국가AI전략위 TF", /전담반|테스크포스|TF/],
    ],
  },
  public: {
    fallback: "기타 공공행정",
    rules: [
      ["보건의료", /의료|병원|질환|진단|보건|건강|간호|백신|약물/],
      ["농림축산·수산", /농업|농식품|농촌|축산|수산|어업|양식|스마트팜/],
      ["복지·돌봄", /복지|돌봄|낙상|복약|취약계층|장애인/],
      ["고용·노동", /고용|취업|일자리|근로|노동|구직|퇴직공제/],
      ["안전·재난·환경", /재난|안전|환경|대기|치안|소방|수입식품|식품안전/],
      ["지식재산 행정", /특허|지식재산|KIPRIS|상표/],
      ["국방·안보", /장병|국방|전장/],
      ["행정서비스·데이터", /국민비서|행정망|민원|콜센터|공공데이터|행정서비스|정부24|온나라|이민정책|공공저작물|공공누리/],
      // 천안시 관점 — 지자체가 그대로 참고할 수 있는 지방행정 사례를 따로 모은다.
      // '정책·조직거버넌스'보다 앞에 둬야 더 구체적인 규칙이 먼저 매칭된다.
      ["지방행정·지자체 AX", /지자체|지방자치|지방정부|시청|군청|도청|기초자치|천안|충남|충청남도/],
      ["정책·조직거버넌스", /위원회|조직|부총리|전략위|정부혁신|국정|본부(?!장)|체제|승격|국무총리|장관회의|업무보고|기술자문단|지원체계|사업지원센터/],
      ["공공 AX 확산·도입", /도입|활용\s*활성화|확산|사례집|우수사례|가속화|초혁신경제|공직문화|자문단/],
      ["대국민 소통·의견수렴", /공모전|의견|시나리오|공청회|참여|모집/],
      ["국제 행정협력", /수출|해외/],
    ],
  },
  diplomacy: {
    fallback: "기타 국제협력",
    rules: [
      ["APEC", /APEC/],
      ["양자 협력(특정국가·정상·장관회담)", /한-|정상회담|장관회담|양자면담|공동위원회|국빈|정상방문/],
      ["다자기구·개발협력(UN·G20·OECD·ODA 등)", /\bUN\b|G20|유엔|OECD|G7|다자개발은행|아세안|ASEAN|ODA|개발협력|국제기구/i],
      ["국제 포럼·컨퍼런스·박람회", /포럼|심포지엄|컨퍼런스|박람회|Festa|웨비나|서밋/i],
      ["해외 빅테크·전문가 면담·초청", /오픈AI|OpenAI|벤지오|면담|초청/],
      ["글로벌 프로젝트 참여(스타게이트 등)", /스타게이트|글로벌.*프로젝트/],
      ["국제기구 파견·자문(GPAI 등)", /GPAI/],
    ],
  },
  other: {
    fallback: "기타",
    rules: [
      ["보건의료 R&D", /의료|백신|치료|질환|바이러스|한약재/],
      ["문화·인문", /문화|인문학|콘텐츠/],
      ["물류·교통", /물류|교통/],
      ["환경·기후", /녹조|환경|기후/],
      ["국제협력", /국제|해외|아시아/],
    ],
  },
};

// 제목 키워드 규칙으로는 못 잡아내는 개별 사례를 위한 수동 보정 — 지식재산처의
// 'Gov.AX Insight' 시범 운영 보도자료(id 68f8f980c7257cc6)는 제목에 "공무원"·
// "자체 개발" 같은 키워드가 없어 규칙상 폴백("정책·전략 발표")으로 빠지지만,
// 실제로는 부처가 직접 만들어 쓰는 자체개발 도구라 해당 버킷이 맞다. 정규식을
// 넓히면 다른 항목에 오분류를 일으킬 수 있어(과거 '플랫폼'/'챗봇' 키워드 확장
// 시도에서 확인됨) 이 항목 하나만 id로 지정한다. 천안시 보도자료가 오분류될
// 때도 같은 방식으로 id 를 추가하고 근거를 함께 남긴다.
const SUBTOPIC_OVERRIDES = {
  "68f8f980c7257cc6": "공무원 자체개발(AI 정부실험실 등)",
};
function classifySubtopic(topicId, title, newsId) {
  if (newsId && SUBTOPIC_OVERRIDES[newsId]) return SUBTOPIC_OVERRIDES[newsId];
  const cfg = SUBTOPIC_RULES[topicId];
  if (!cfg) return "기타";
  const t = title || "";
  for (const [name, re] of cfg.rules) {
    if (re.test(t)) return name;
  }
  return cfg.fallback;
}

function computeSubtopicBreakdown(topicId, newsList) {
  const items = newsList.filter((n) => (n.primary_topic || (n.topics || [])[0]) === topicId);
  const buckets = new Map();
  items.forEach((n) => {
    const name = classifySubtopic(topicId, n.title, n.id);
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(n);
  });
  const total = items.length;
  return Array.from(buckets.entries())
    .map(([name, list]) => ({
      name, count: list.length,
      pct: total ? Math.round((list.length / total) * 100) : 0,
      items: list,
    }))
    .sort((a, b) => b.count - a.count);
}

// newsList를 지정하지 않으면(히트맵 대시보드에서 호출) 현재 슬라이더 구간을 쓰고,
// 지정하면(월별추이 "세부주제별 추이" 카드에서 호출) 그 목록 전체를 그대로 쓴다 —
// 두 진입점이 서로 다른 기준(구간 슬라이더 vs 전체기간)을 쓰기 때문에 통일하지 않고
// 각자 보여주고 있던 범위를 그대로 드릴다운에 반영한다.
function openSubtopicDrilldown(topicId, newsList) {
  const t = state.topicById[topicId] || {};
  const name = t.name || topicId;
  const color = t.color || "#8b95a4";
  let periodLabel;
  if (newsList) {
    periodLabel = "전체 기간";
  } else {
    newsList = newsInDashRange(state.dashRangeStartTs, state.dashRangeEndTs);
    const isFull = state.dashRangeStartTs <= state.dashDateMinTs && state.dashRangeEndTs >= state.dashDateMaxTs;
    periodLabel = isFull ? "전체 기간" : "선택 기간";
  }
  const buckets = computeSubtopicBreakdown(topicId, newsList);
  const total = buckets.reduce((s, b) => s + b.count, 0);

  const header = $("#stm-header");
  header.style.setProperty("--stm-color", color);
  header.style.setProperty("--stm-soft", color + "1f");
  $("#stm-eyebrow").textContent = "세부 분류";
  $("#stm-title").textContent = name;
  $("#stm-count").textContent = `${periodLabel} ${total}건`;
  $("#stm-sub").style.display = total ? "none" : "";
  $("#stm-sub").textContent = total ? "" : `이 기간에는 "${name}" 주제의 보도자료가 없습니다.`;

  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const msIds = milestoneNewsIds();
  $("#stm-buckets").innerHTML = buckets.map((b, i) => `
    <div class="stb-row${i === 0 ? " expanded" : ""}">
      <div class="stb-top">
        <span class="stb-name">${esc(b.name)}</span>
        <span class="stb-count">${b.count}<span class="stb-pct">${b.pct}%</span></span>
        <div class="stb-track"><div class="stb-fill" style="width:${(b.count / maxCount) * 100}%;background:${esc(color)}"></div></div>
      </div>
      <ul class="stb-examples">${b.items
        // 마일스톤에 오른 항목은 상위 5개 미리보기에 묻히지 않도록 앞으로 끌어올린다 —
        // 그래야 이 버킷에 중요 정책이 있을 때 실제로 눈에 띈다.
        .slice()
        .sort((x, y) => (msIds.has(y.id) ? 1 : 0) - (msIds.has(x.id) ? 1 : 0))
        .slice(0, 5)
        .map((n) =>
          `<li><button type="button" class="stb-ex-link" data-news-id="${esc(n.id)}">${newsListTitleHtml(n, msIds)}</button></li>`
        ).join("")}</ul>
    </div>
  `).join("");

  $("#stm-buckets").querySelectorAll(".stb-top").forEach((row) => {
    row.addEventListener("click", () => row.closest(".stb-row").classList.toggle("expanded"));
  });
  $("#stm-buckets").querySelectorAll(".stb-ex-link").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const n = state.newsById[btn.dataset.newsId];
      if (!n) return;
      const summary = (state.summaryById[n.id] || {}).summary || "";
      if (summary) openNewsModal(n, summary);
      else window.open(httpUrl(n.url) || "#", "_blank", "noopener");
    });
  });

  document.getElementById("subtopic-modal").hidden = false;
}
function closeSubtopicModal() {
  document.getElementById("subtopic-modal").hidden = true;
}
function setupSubtopicModal() {
  const modal = $("#subtopic-modal");
  modal.addEventListener("click", (e) => {
    if (e.target.dataset.close) closeSubtopicModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeSubtopicModal();
  });
}

// 페이지네이션 UI (상·하단 공용). 페이지당 개수 선택 + 이전/다음 + 페이지 번호.
const PAGE_SIZES = [10, 20, 50, 100];
function pageWindow(cur, pages) {
  // 현재 페이지 주변 + 처음/끝, 생략(…) 포함
  const out = [];
  const add = (v) => out.push(v);
  const lo = Math.max(2, cur - 2), hi = Math.min(pages - 1, cur + 2);
  add(1);
  if (lo > 2) add("…");
  for (let i = lo; i <= hi; i++) add(i);
  if (hi < pages - 1) add("…");
  if (pages > 1) add(pages);
  return out;
}
const SORT_OPTIONS = [
  { value: "date_desc", label: "최신순" },
  { value: "date_asc", label: "오래된순" },
  { value: "milestone", label: "마일스톤" },
];
function renderPager(box, total, pages, start, shown, showSort) {
  if (!box) return;
  box.innerHTML = "";
  if (total === 0) return;
  const cur = state.page;

  // 좌: 페이지당 개수 + 현재 범위
  const info = el("div", "pager-info");
  const sel = el("select", "pg-size");
  PAGE_SIZES.forEach((n) => {
    const o = el("option", null, String(n));
    o.value = String(n);
    if (n === state.pageSize) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener("change", (e) => {
    state.pageSize = parseInt(e.target.value, 10) || 20;
    state.page = 1;
    renderNews();
  });
  const lbl = el("label", "pg-sizewrap");
  lbl.append("페이지당 ", sel, " 개");
  const range = el("span", "pg-count",
    `전체 ${total.toLocaleString("ko-KR")}건 중 ${(start + 1).toLocaleString("ko-KR")}–${(start + shown).toLocaleString("ko-KR")}`);
  info.append(lbl, range);

  // 우: 페이지 네비게이션
  const nav = el("div", "pager-nav");
  const go = (p) => { state.page = p; renderNews(); scrollNewsTop(); };
  const prev = el("button", "pg-btn", "‹ 이전");
  prev.disabled = cur <= 1;
  prev.addEventListener("click", () => go(cur - 1));
  nav.appendChild(prev);
  pageWindow(cur, pages).forEach((v) => {
    if (v === "…") { nav.appendChild(el("span", "pg-ellipsis", "…")); return; }
    const b = el("button", "pg-num" + (v === cur ? " active" : ""), String(v));
    b.addEventListener("click", () => go(v));
    nav.appendChild(b);
  });
  const next = el("button", "pg-btn", "다음 ›");
  next.disabled = cur >= pages;
  next.addEventListener("click", () => go(cur + 1));
  nav.appendChild(next);

  box.append(info, nav);

  // 우: 정렬(상단 페이저에만 표시)
  if (showSort) {
    const sortBox = el("label", "sortwrap");
    const sel = el("select", "sort-select");
    SORT_OPTIONS.forEach((o) => {
      const opt = el("option", null, o.label);
      opt.value = o.value;
      if (o.value === state.sort) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", (e) => {
      state.sort = e.target.value;
      state.page = 1;
      renderNews();
    });
    sortBox.append("정렬 ", sel);
    box.appendChild(sortBox);
  }
}

function scrollNewsTop() {
  const t = document.querySelector("#tab-news .content");
  if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
}

function reportCardHTML(r) {
  const links = [];
  if (r.html) links.push(`<a class="dl primary" href="${esc(r.html)}" target="_blank" rel="noopener">보기</a>`);
  if (r.pdf) links.push(`<a class="dl" href="${esc(r.pdf)}" download>PDF</a>`);
  if (r.md) links.push(`<a class="dl" href="${esc(r.md)}" download>Markdown</a>`);
  const kindBadge = r.kind
    ? `<span class="rk rk-${r.kind === "분기" ? "q" : "all"}">${esc(r.kind)}</span> `
    : "";
  const card = el("article", "report-card");
  card.innerHTML =
    `<div><h3>${kindBadge}${esc(r.title || r.date)}</h3>` +
    `<div class="rmeta">${r.date ? esc(r.date) : ""}` +
    (r.newsCount != null ? ` · 근거 뉴스 ${r.newsCount}건` : "") + `</div></div>` +
    `<div class="report-links">${links.join(" ")}</div>`;
  return card;
}

// 분기 문자열(2026-Q3) 정렬용 키 — 연도*10 + 분기번호
function quarterSortKey(q) {
  const m = /^(\d{4})-Q([1-4])$/.exec(q || "");
  return m ? parseInt(m[1], 10) * 10 + parseInt(m[2], 10) : 0;
}

// 링크 스킴 허용목록 — 보고서·마일스톤의 url 은 CI에서 AI가 생성한 파일에서 오므로
// 그대로 href 에 넣지 않는다. http/https 만 통과시키고(javascript:·data: 등 차단),
// 통과한 값도 속성 문맥에 맞게 이스케이프한다. 부적합하면 빈 문자열을 돌려준다.
function httpUrl(u) {
  const s = String(u == null ? "" : u).trim();
  return /^https?:\/\//i.test(s) ? s : "";
}
// HTML 속성 문맥에 넣을 때는 이스케이프까지 함께 적용한다.
function safeHttpUrl(u) {
  return esc(httpUrl(u));
}

// 근거 링크가 '출처'라는 글자로 노출되면 문장을 읽는 흐름이 끊긴다. '출처' 글자는 없애고
// 바로 앞의 연월(예: 2026.1)에 링크를 걸어, 날짜를 누르면 보도자료 원문이 열리게 바꾼다.
// 앞에 날짜가 없는 근거는 작은 화살표 표식만 남긴다(근거 링크 자체는 절대 지우지 않음).
// 스킴이 부적합한 근거는 링크 없이 글자만 남겨 클릭 불가로 만든다(근거 텍스트는 보존).
// AI 요약이 있는 근거는 실제 링크 대신 data-newsid 를 단 클릭 트리거로 바꿔(뉴스 탭과
// 동일한 요약 팝업), 요약이 없는(또는 어느 뉴스와도 안 맞는) 근거만 원문 바로가기로 둔다.
function axhLinkSources(html, newsByUrl) {
  const matchNews = (url) => {
    const n = newsByUrl && newsByUrl.get(url);
    if (!n) return null;
    const summary = (state.summaryById[n.id] || {}).summary || "";
    return summary ? n : null;
  };
  let out = html.replace(
    /(\d{4}(?:\.\d{1,2}){0,2})\s*,\s*<a href="([^"]*)"[^>]*>\s*출처\s*<\/a>/g,
    (_m, date, rawUrl) => {
      const url = unescHtml(rawUrl);
      const n = matchNews(url);
      if (n) return `<span class="axh-src" data-newsid="${esc(n.id)}" tabindex="0" role="button">${date}</span>`;
      const safe = safeHttpUrl(url);
      return safe
        ? `<a class="axh-src" href="${safe}" target="_blank" rel="noopener">${date}</a>`
        : date;
    }
  );
  out = out.replace(
    /\s*,?\s*<a href="([^"]*)"[^>]*>\s*출처\s*<\/a>/g,
    (_m, rawUrl) => {
      const url = unescHtml(rawUrl);
      const n = matchNews(url);
      if (n) {
        return `<span class="axh-src axh-src-mark" data-newsid="${esc(n.id)}" tabindex="0" role="button" ` +
          `aria-label="보도자료 요약 보기">↗</span>`;
      }
      const safe = safeHttpUrl(url);
      return safe
        ? `<a class="axh-src axh-src-mark" href="${safe}" target="_blank" rel="noopener" aria-label="보도자료 원문 보기">↗</a>`
        : "";
    }
  );
  return out;
}

async function loadAxHighlights() {
  const list = $("#ax-highlights-list");
  if (!list) return;
  const h = await getJSON("data/reports/highlights.json", null);
  list.innerHTML = "";
  if (!h || !Array.isArray(h.items) || h.items.length === 0) {
    list.replaceWith(el("div", "empty", "아직 생성된 동향 요약이 없습니다."));
    return;
  }
  const newsByUrl = new Map();
  state.news.forEach((n) => { if (n.url) newsByUrl.set(n.url, n); });
  h.items.forEach((html) => {
    // 각 항목은 "<strong>제목</strong> — 근거 → 시사점" 구조 — 제목만 별도
    // 줄로 떼어내고, 나머지 세부내용(근거·시사점)은 볼드 없이 일반 글자체로
    // 그 아래 줄에 표시한다.
    let title = "";
    let rest = html;
    const titleMatch = html.match(/^<strong>(.*?)<\/strong>\s*[—-]?\s*/);
    if (titleMatch) {
      title = titleMatch[1];
      rest = html.slice(titleMatch[0].length);
    }
    // 근거·시사점 안에 강조용으로 남아있는 볼드(<strong>)도 모두 제거해
    // 일반 글자체로 통일한다.
    rest = rest.replace(/<\/?strong>/g, "");
    rest = axhLinkSources(rest, newsByUrl);
    // "무엇이 → 어떻게 바뀌고 → 왜 중요한지"처럼 화살표로 이어진 흐름을 한
    // 문장에 몰아 넣지 않고, 화살표 단위로 줄을 나눠 단계별로 읽히게 한다.
    const steps = rest.split(" → ");
    const stepsHtml = steps
      .map((s, i) => `<div class="axh-step${i === 0 ? " axh-step-first" : ""}">${s}</div>`)
      .join("");
    const titleHtml = title ? `<div class="axh-title">${title}</div>` : "";
    const li = el("li", "", titleHtml + stepsHtml);
    list.appendChild(li);
    li.querySelectorAll(".axh-src[data-newsid]").forEach((elx) => {
      const n = state.newsById[elx.dataset.newsid];
      if (!n) return;
      const open = () => openNewsModal(n, (state.summaryById[n.id] || {}).summary || "");
      elx.addEventListener("click", open);
      elx.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); }
      });
    });
  });
  const group = list.closest(".ax-highlights-group");
  if (group && h.sourceHtml) {
    let foot = group.querySelector(".ax-highlights-foot");
    if (!foot) {
      foot = el("div", "ax-highlights-foot");
      group.appendChild(foot);
    }
    foot.innerHTML =
      `전체 AX 동향보고서(${esc(h.date || "")}) 「한눈에 보기」 발췌 · ` +
      `<a href="${esc(h.sourceHtml)}" target="_blank" rel="noopener">전체 보고서 보기 ↗</a>`;
  }
}

function msFormatDate(d) {
  return String(d || "").replace(/-/g, ".");
}

function msVisibleEvents() {
  if (!state.milestones) return [];
  return (state.milestones.events || [])
    .filter((e) => state.msLane === "all" || e.lane === state.msLane)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

function msShowTip(evt, html) {
  const tip = $("#ms-tooltip");
  if (!tip) return;
  tip.innerHTML = html;
  tip.hidden = false;
  msMoveTip(evt);
}
function msMoveTip(evt) {
  const tip = $("#ms-tooltip");
  if (!tip || tip.hidden) return;
  const pad = 14;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + tip.offsetWidth > window.innerWidth - 8) x = evt.clientX - tip.offsetWidth - pad;
  if (y + tip.offsetHeight > window.innerHeight - 8) y = evt.clientY - tip.offsetHeight - pad;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}
function msHideTip() {
  const tip = $("#ms-tooltip");
  if (tip) tip.hidden = true;
}

// 영역별 진행 흐름 차트 — 각 영역(lane)을 한 행으로 두고 사건을 월 위치에 찍는다.
// 라벨은 마일스톤 제목만 노출하고, 기간이 길어지면 폰트를 줄이는 대신 SVG 자체를
// 넓게 그려 부모의 overflow-x 로 스크롤한다.
function renderMilestoneChart() {
  const box = $("#milestone-chart");
  if (!box || !state.milestones) return;
  const laneDefs = state.milestones.lanes || [];
  const events = msVisibleEvents();
  box.innerHTML = "";
  if (events.length === 0) return;

  const lanes = laneDefs.filter((l) => events.some((e) => e.lane === l.id));
  const laneColor = Object.fromEntries(laneDefs.map((l) => [l.id, l.color]));

  // 표시 구간: 사건이 있는 달의 앞뒤로 한 달씩 여유
  const ymList = events.map((e) => e.date.slice(0, 7));
  const months = [];
  const [y0, m0] = ymList[0].split("-").map(Number);
  const [y1, m1] = ymList[ymList.length - 1].split("-").map(Number);
  let cy = y0;
  let cm = m0 - 1;
  if (cm < 1) { cm = 12; cy -= 1; }
  const endTotal = y1 * 12 + (m1 + 1);
  while (cy * 12 + cm <= endTotal) {
    months.push(`${cy}-${String(cm).padStart(2, "0")}`);
    cm += 1;
    if (cm > 12) { cm = 1; cy += 1; }
  }
  const monthIndex = Object.fromEntries(months.map((m, i) => [m, i]));

  // 글자 폭을 캔버스로 실측한다 — 글자수 × 상수로 어림하면(한글·영문 폭 차이) 실제보다
  // 크게 잡혀 열 간격이 불필요하게 벌어진다. 실측하면 폰트 크기를 줄이지 않고도
  // 라벨을 촘촘히 붙일 수 있다.
  const measurer = (() => {
    const ctx = document.createElement("canvas").getContext("2d");
    const fam = getComputedStyle(document.body).fontFamily;
    return (text, weight, size) => {
      ctx.font = `${weight} ${size}px ${fam}`;
      return ctx.measureText(text).width;
    };
  })();

  // 데스크톱은 그대로 두고, 모바일 화면(680px 이하 — .ms-chart-card 모바일
  // 분기와 동일)에서만 더 촘촘하게 그린다. 리사이즈에 실시간으로 반응하진
  // 않는다(다른 레이아웃 값들도 렌더 시점 1회 측정 — 기존 설계와 동일).
  const compact = window.innerWidth <= 680;
  const COL_W = compact ? 58 : 100;      // 월 간격 — 마일스톤이 늘어나며 답답해 보여 넓힘(기존 74)
  const PAD_T = compact ? 12 : 16;
  const PAD_B = compact ? 26 : 32;
  const STEM_0 = compact ? 9 : 11;      // 1단 라벨의 줄기 길이(점 반지름보다 커야 겹치지 않음)
  const TIER_STEP = compact ? 13 : 16;   // 단이 하나 늘 때마다 벌어지는 간격(글자 높이 + 여유)
  const LABEL_GAP = compact ? 6 : 9;    // 같은 단 이웃 라벨 사이 최소 간격
  const TEXT_UP = compact ? 13 : 16;     // 줄기 끝 위쪽 라벨이 차지하는 높이
  const TEXT_DOWN = compact ? 13 : 17;   // 줄기 끝 아래쪽 라벨이 차지하는 높이
  const LANE_GAP = compact ? 8 : 10;    // 이웃 레인 사이 최소 여백 — 마일스톤이 늘어나며 답답해 보여 넓힘(기존 3)
  const BARE_LANE = compact ? 8 : 10;   // 그 방향에 라벨이 없을 때의 최소 여백
  const DOT_R = compact ? 5.5 : 7;
  const LANE_FONT = compact ? 12 : 14;   // .msc-lane-label 과 맞춰야 함(CSS 참고)
  const TITLE_FONT = compact ? 11.5 : 13; // .msc-title 과 맞춰야 함
  const MONTH_FONT = compact ? 11 : 12.5; // .msc-month 과 맞춰야 함
  const TRUNC_LEN = compact ? 14 : 18;
  const LABEL_W = Math.ceil(Math.max(...lanes.map((l) => measurer(l.name, 700, LANE_FONT)))) + (compact ? 10 : 14);

  // 같은 달·같은 영역에 사건이 여러 건이면 x를 조금씩 벌려 겹치지 않게 한다.
  const dayFrac = (d) => (Number(d.slice(8, 10)) - 1) / 31;
  const xOf = (e) => LABEL_W + (monthIndex[e.date.slice(0, 7)] + dayFrac(e.date)) * COL_W;

  // 1단계(배치) — 레인별로 라벨의 단(tier)을 먼저 정한다. 단 수에 상한을 두지 않고
  // 필요한 만큼 늘리므로 마일스톤이 계속 누적돼도 글자가 겹치지 않는다.
  // 짝수 단은 레인선 위, 홀수 단은 아래에 놓고, 같은 단에서 앞 라벨과 겹치지 않는
  // 첫 단을 고른다(tier -> 위/아래 & 단계: above = ti%2===0, level = floor(ti/2)).
  let maxRight = 0;
  const layout = lanes.map((lane) => {
    const tierRight = [];   // 각 단에서 마지막 라벨의 오른쪽 끝
    const placed = events
      .filter((e) => e.lane === lane.id)
      .sort((a, b) => xOf(a) - xOf(b))
      .map((e) => {
        const x = xOf(e);
        const labelText = e.title.length > TRUNC_LEN ? e.title.slice(0, TRUNC_LEN - 1) + "…" : e.title;
        const half = measurer(labelText, 600, TITLE_FONT) / 2;
        let ti = 0;
        while (ti < tierRight.length && x - half < tierRight[ti] + LABEL_GAP) ti += 1;
        tierRight[ti] = x + half;
        maxRight = Math.max(maxRight, x + half);
        return { e, x, labelText, tier: ti };
      });
    const levels = (parity) =>
      placed.filter((p) => p.tier % 2 === parity).reduce((mx, p) => Math.max(mx, Math.floor(p.tier / 2)), -1);
    const upLv = levels(0);
    const dnLv = levels(1);
    return {
      lane, placed,
      up: upLv < 0 ? BARE_LANE : STEM_0 + upLv * TIER_STEP + TEXT_UP,
      down: dnLv < 0 ? BARE_LANE : STEM_0 + dnLv * TIER_STEP + TEXT_DOWN,
    };
  });

  // 2단계(높이 계산) — 각 레인이 실제로 쓴 단 수만큼만 자리를 차지하게 쌓는다.
  let acc = PAD_T;
  layout.forEach((L, i) => {
    L.y = acc + L.up;
    acc = L.y + L.down + (i < layout.length - 1 ? LANE_GAP : 0);
  });
  const H = acc + PAD_B;
  // 마지막 월 눈금과 가장 오른쪽 라벨 중 더 바깥쪽에 맞춰 폭을 정한다(고정 여백 낭비 방지).
  const innerW = Math.max(1, months.length - 1) * COL_W;
  const W = Math.ceil(Math.max(LABEL_W + innerW, maxRight)) + 16;

  // 가로 스크롤 중에도 왼쪽 레인(주제) 이름이 계속 보이도록, 레인 라벨만 별도
  // svg로 떼어 sticky 처리한다(box 자체가 flex 컨테이너 — CSS 참고). 본문
  // svg는 viewBox를 LABEL_W만큼 밀어서 시작해, 기존에 LABEL_W를 더해 계산해
  // 두었던 절대좌표(xOf 등)를 그대로 재사용할 수 있게 한다.
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", "영역별 정책 마일스톤 진행 흐름 차트");
  const mainW = W - LABEL_W;
  const labelsSvg = svgEl("svg", {
    class: "msc-labels-svg", width: LABEL_W, height: H, viewBox: `0 0 ${LABEL_W} ${H}`,
  });
  const svg = svgEl("svg", {
    class: "msc-main-svg", width: mainW, height: H, viewBox: `${LABEL_W} 0 ${mainW} ${H}`,
  });

  // 월 눈금이 촘촘해지면 라벨이 붙으므로, 겹칠 만큼 좁으면 한 칸씩 건너뛰어 표기한다
  // (글자 크기는 그대로 유지).
  const monthStep = Math.max(1, Math.ceil((measurer("2026.08", 400, MONTH_FONT) + 12) / COL_W));
  months.forEach((m, i) => {
    const x = LABEL_W + i * COL_W;
    svg.appendChild(svgEl("line", { class: "msc-grid", x1: x, x2: x, y1: PAD_T - 6, y2: H - PAD_B + 6 }));
    if (i % monthStep !== 0 && i !== months.length - 1) return;
    const t = svgEl("text", { class: "msc-month", x, y: H - PAD_B + 24, "text-anchor": "middle" });
    t.textContent = m.replace("-", ".");
    svg.appendChild(t);
  });

  layout.forEach(({ lane, placed, y: laneY }) => {
    svg.appendChild(svgEl("line", { class: "msc-lane-line", x1: LABEL_W, x2: W - 8, y1: laneY, y2: laneY }));
    const label = svgEl("text", { class: "msc-lane-label", x: 0, y: laneY + 5 });
    label.textContent = lane.name;
    labelsSvg.appendChild(label);

    placed.forEach(({ e, x, labelText, tier }) => {
      const above = tier % 2 === 0;
      const dist = STEM_0 + Math.floor(tier / 2) * TIER_STEP;
      const stemY = above ? laneY - dist : laneY + dist;
      const textY = above ? stemY - 4 : stemY + 12;
      const color = laneColor[e.lane] || "#8b95a4";

      svg.appendChild(svgEl("line", {
        class: "msc-stem", x1: x, x2: x, y1: laneY, y2: stemY, stroke: color,
      }));

      const tipHtml =
        `<b>${esc(e.title)}</b>` +
        `<span class="mst-meta">${esc(msFormatDate(e.date))} · ${esc(lane.name)} · ${esc(e.agency || "")}</span>` +
        esc(e.detail || "");
      // 마일스톤 상세와 동일하게, 클릭하면 AI 요약문 팝업을 먼저 띄운다
      // (원문은 팝업 안 '원문 보기' 버튼으로 이동).
      const openDetail = () => {
        msHideTip();
        openMilestoneModal(e, lane.name);
      };

      const label2 = svgEl("text", {
        class: "msc-title" + (httpUrl(e.url) ? " msc-title-link" : ""),
        x, y: textY, "text-anchor": "middle",
      });
      label2.textContent = labelText;
      label2.addEventListener("mousemove", (ev) => msShowTip(ev, tipHtml));
      label2.addEventListener("mouseleave", msHideTip);
      if (httpUrl(e.url)) {
        label2.addEventListener("click", openDetail);
        label2.setAttribute("role", "button");
        label2.setAttribute("tabindex", "0");
        label2.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openDetail(); }
        });
      }
      svg.appendChild(label2);

      const dot = svgEl("circle", {
        class: "msc-dot" + (httpUrl(e.url) ? " msc-dot-link" : ""), cx: x, cy: laneY, r: DOT_R,
        fill: color, stroke: "var(--surface)", "stroke-width": 2.5,
      });
      dot.addEventListener("mousemove", (ev) => msShowTip(ev, tipHtml));
      dot.addEventListener("mouseleave", msHideTip);
      if (httpUrl(e.url)) dot.addEventListener("click", openDetail);
      svg.appendChild(dot);
    });
  });

  box.appendChild(labelsSvg);
  box.appendChild(svg);
}

function renderMilestoneFilters() {
  const box = $("#milestone-filters");
  if (!box || !state.milestones) return;
  box.innerHTML = "";
  const lanes = state.milestones.lanes || [];
  const all = el("button", "ms-chip active", "전체");
  all.addEventListener("click", () => selectMilestoneLane("all"));
  box.appendChild(all);
  lanes.forEach((lane) => {
    const chip = el("button", "ms-chip");
    chip.dataset.lane = lane.id;
    chip.innerHTML = `<span class="ms-chip-dot" style="background:${esc(lane.color)}"></span>${esc(lane.name)}`;
    chip.addEventListener("click", () => selectMilestoneLane(lane.id));
    box.appendChild(chip);
  });
}

function selectMilestoneLane(laneId) {
  state.msLane = laneId;
  document.querySelectorAll("#milestone-filters .ms-chip").forEach((c) => {
    const active = (laneId === "all" && !c.dataset.lane) || c.dataset.lane === laneId;
    c.classList.toggle("active", active);
  });
  renderMilestoneChart();
  renderMilestoneTimeline();
}

function toggleMilestoneSort() {
  state.msSortDesc = !state.msSortDesc;
  const btn = $("#ms-sort-toggle");
  if (btn) btn.textContent = state.msSortDesc ? "최근 순 ↓" : "오래된 순 ↑";
  renderMilestoneTimeline();
}

function renderMilestoneTimeline() {
  const box = $("#milestone-timeline");
  const empty = $("#milestone-empty");
  if (!box || !state.milestones) return;
  const laneById = Object.fromEntries((state.milestones.lanes || []).map((l) => [l.id, l]));
  const events = msVisibleEvents();
  if (state.msSortDesc) events.reverse();

  box.innerHTML = "";
  if (empty) empty.hidden = events.length > 0;
  if (events.length === 0) return;

  events.forEach((e) => {
    const lane = laneById[e.lane] || { name: "", color: "#8b95a4" };
    const item = el("div", "ms-item");
    item.style.setProperty("--ms-lane-color", lane.color);
    item.innerHTML = `
      <div class="ms-dot"></div>
      <div class="ms-card">
        <div class="ms-card-head">
          <span class="ms-date">${esc(msFormatDate(e.date))}</span>
          <span class="ms-lane-pill"><span class="ms-chip-dot"></span>${esc(lane.name)}</span>
          <span class="ms-agency">${esc(e.agency || "")}</span>
        </div>
        <h3 class="ms-title">${
          httpUrl(e.url)
            ? `<a class="ms-title-link" href="${safeHttpUrl(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>`
            : esc(e.title)
        }</h3>
        <p class="ms-detail">${esc(e.detail)}</p>
      </div>`;
    // 제목을 누르면 뉴스 탭과 똑같이 요약문 팝업을 먼저 띄운다(원문은 팝업 안 버튼으로).
    // href 는 그대로 두어 새 탭으로 열기·Ctrl+클릭 등은 원문으로 바로 가게 남겨 둔다.
    const titleLink = item.querySelector(".ms-title-link");
    if (titleLink) {
      titleLink.addEventListener("click", (ev) => {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
        ev.preventDefault();
        openMilestoneModal(e, lane.name);
      });
    }
    box.appendChild(item);
  });
}

async function loadMilestones() {
  const box = $("#milestone-timeline");
  if (!box) return;
  state.milestones = await getJSON("data/milestones.json", null);
  if (!state.milestones || !Array.isArray(state.milestones.events)) {
    box.replaceWith(el("div", "empty", "아직 생성된 마일스톤이 없습니다."));
    return;
  }
  renderMilestoneFilters();
  renderMilestoneChart();
  renderMilestoneTimeline();

  const sortBtn = $("#ms-sort-toggle");
  if (sortBtn) sortBtn.addEventListener("click", toggleMilestoneSort);
  document.addEventListener("mousemove", msMoveTip);
}

async function loadReports() {
  const idx = await getJSON("data/reports/index.json", { reports: [] });
  const reports = idx.reports || [];

  // 보고서가 하나도 없으면 빈 목록 세 개 대신 '준비 중' 안내만 보여 준다.
  const pending = $("#reports-pending");
  if (pending) {
    const none = reports.length === 0;
    pending.hidden = !none;
    document.querySelectorAll("#tab-reports .report-group").forEach((g) => { g.hidden = none; });
  }
  loadAxHighlights();

  // 전체 리포트: 최신 것 1건 표시(생성일 내림차순)
  const overallBox = $("#reports-overall");
  if (overallBox) {
    overallBox.innerHTML = "";
    const overalls = reports
      .filter((r) => r.kind !== "분기")
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    if (overalls.length) overallBox.appendChild(reportCardHTML(overalls[0]));
    else overallBox.appendChild(el("div", "empty", "아직 생성된 전체 리포트가 없습니다."));
  }

  // 분기 리포트: 콤보박스로 선택(최신 분기 우선), 선택 시 상세 카드 렌더
  const sel = $("#q-report-select");
  const detail = $("#q-report-detail");
  if (!sel || !detail) return;
  const quarters = reports
    .filter((r) => r.kind === "분기")
    .sort((a, b) => quarterSortKey(b.id.replace("quarter-", "")) - quarterSortKey(a.id.replace("quarter-", "")));

  sel.innerHTML = "";
  if (quarters.length === 0) {
    sel.style.display = "none";
    detail.innerHTML = "";
    detail.appendChild(el("div", "empty", "아직 생성된 분기 리포트가 없습니다."));
    return;
  }
  sel.style.display = "";
  quarters.forEach((r, i) => {
    const q = r.id.replace("quarter-", "");
    const opt = el("option", "", q + (i === 0 ? " (최신)" : ""));
    opt.value = r.id;
    sel.appendChild(opt);
  });

  const renderSelected = () => {
    const r = quarters.find((x) => x.id === sel.value) || quarters[0];
    detail.innerHTML = "";
    detail.appendChild(reportCardHTML(r));
  };
  sel.onchange = renderSelected;
  sel.value = quarters[0].id;
  renderSelected();
}

/* ===== 대시보드 (히트맵 + KPI + 벤치마킹) ===== */
function quarterOf(dstr) {
  if (!dstr || dstr.length < 7) return null;
  const y = dstr.slice(0, 4), m = parseInt(dstr.slice(5, 7), 10);
  if (!m) return null;
  return y + "-Q" + (Math.floor((m - 1) / 3) + 1);
}

function renderDashboard() {
  if (!$("#tab-dashboard")) return;
  if (!state.topics || !state.news.length) {
    $("#dash-heatmap").innerHTML = '<div class="empty">아직 집계할 데이터가 없습니다. 수집 후 표시됩니다.</div>';
    return;
  }
  renderDashKPI();
  renderRangeSlider();
  renderHeatmap();
  renderTopicFilter();
  renderBench();
  renderTop3Cards();
}

// 히트맵+벤치마킹 아래, 최다 주제 TOP3를 카드 3장으로 다시 한번 자세히 보여준다
// (위쪽 dash-kpi의 압축된 목록과 같은 데이터).
// 데스크톱은 세부 분류를 클릭 없이 바로 보이도록 기본 펼침으로 두고 접기/펼치기
// 버튼만 따로 둔다. 모바일은 화면이 좁아 카드 3장이 각각 길게 늘어지면 스크롤
// 부담이 커지므로, 기존처럼 미리보기 한 줄 + "세부 분류 보기" 버튼(누르면 팝업)
// 방식을 그대로 유지한다.
function renderTop3Cards() {
  const box = $("#dash-top3-row");
  if (!box) return;
  const compact = window.innerWidth <= 680;
  const filtered = newsInDashRange(state.dashRangeStartTs, state.dashRangeEndTs);
  const topicCounts = {};
  filtered.forEach((n) => {
    const p = n.primary_topic || (n.topics || [])[0];
    if (p) topicCounts[p] = (topicCounts[p] || 0) + 1;
  });
  const top3 = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (!top3.length) { box.innerHTML = '<div class="empty">이 기간에는 집계할 주제가 없습니다.</div>'; return; }

  const total = filtered.length || 1;
  box.innerHTML = top3.map(([id, count], i) => {
    const t = state.topicById[id] || {};
    const name = t.name || id;
    const color = t.color || "#8b95a4";
    const buckets = computeSubtopicBreakdown(id, filtered);
    const cardStyle = `--t3-color:${esc(color)};--t3-soft:${esc(color)}1f`;

    if (compact) {
      const previewHtml = buckets.length
        ? `가장 많은 유형: <strong>${esc(buckets[0].name)}</strong> (${buckets[0].pct}%)`
        : "";
      return `<button type="button" class="top3-card top3-card-compact" data-topic-id="${esc(id)}" style="${cardStyle}">
        <div class="top3-head">
          <span class="top3-rank">${i + 1}</span>
          <span class="top3-name">${esc(name)}</span>
        </div>
        <div class="top3-metrics">
          <span class="top3-value">${count}<small>건</small></span>
          <span class="top3-share">전체의 ${Math.round((count / total) * 100)}%</span>
        </div>
        <p class="top3-preview">${previewHtml}</p>
        <div class="top3-cta">세부 분류 보기 <span class="arrow">→</span></div>
      </button>`;
    }

    const maxBucket = Math.max(1, ...buckets.map((b) => b.count));
    const barsHtml = buckets.map((b) => `
      <div class="top3-bar-row">
        <span class="top3-bar-name">${esc(b.name)}</span>
        <span class="top3-bar-count">${b.count}<span class="top3-bar-pct">${b.pct}%</span></span>
        <div class="top3-bar-track"><div class="top3-bar-fill" style="width:${(b.count / maxBucket) * 100}%"></div></div>
      </div>`).join("");

    return `<div class="top3-card" style="${cardStyle}">
      <button type="button" class="top3-head-btn" data-topic-id="${esc(id)}">
        <span class="top3-rank">${i + 1}</span>
        <span class="top3-name">${esc(name)}</span>
      </button>
      <div class="top3-metrics">
        <span class="top3-value">${count}<small>건</small></span>
        <span class="top3-share">전체의 ${Math.round((count / total) * 100)}%</span>
      </div>
      <div class="top3-breakdown">
        ${barsHtml}
      </div>
      <button type="button" class="top3-toggle" aria-expanded="true">
        세부 분류 접기 <span class="chev">▲</span>
      </button>
    </div>`;
  }).join("");

  box.querySelectorAll(".top3-card-compact[data-topic-id], .top3-head-btn[data-topic-id]").forEach((btn) => {
    btn.addEventListener("click", () => openSubtopicDrilldown(btn.dataset.topicId));
  });
  box.querySelectorAll(".top3-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".top3-card");
      const expanded = btn.getAttribute("aria-expanded") === "true";
      card.querySelector(".top3-breakdown").hidden = expanded;
      btn.setAttribute("aria-expanded", String(!expanded));
      btn.innerHTML = expanded
        ? `세부 분류 펼치기 <span class="chev">▼</span>`
        : `세부 분류 접기 <span class="chev">▲</span>`;
    });
  });
}

// 히트맵 기간 슬라이더 범위 — 첫 수집일 ~ 오늘.
function computeDashDateBounds() {
  let minTs = null;
  state.news.forEach((n) => {
    const d = n.published || n.first_seen || "";
    if (d.length < 10) return;
    const t = new Date(d.slice(0, 10) + "T00:00:00").getTime();
    if (minTs === null || t < minTs) minTs = t;
  });
  const now = new Date();
  const maxTs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  state.dashDateMinTs = minTs === null ? maxTs : minTs;
  state.dashDateMaxTs = maxTs;
  state.dashRangeStartTs = state.dashDateMinTs;
  state.dashRangeEndTs = state.dashDateMaxTs;
}

// 선택 기간(startTs~endTs, 포함)에 발행된 뉴스만으로 기관×주제 행렬을 다시 계산.
// data/topics.json 의 서버 집계 matrix 와 동일 기준(대표 주제 primary_topic 1건당 1카운트).
function _newsDateTs(n) {
  const d = n.published || n.first_seen || "";
  if (d.length < 10) return null;
  return new Date(d.slice(0, 10) + "T00:00:00").getTime();
}

// 히트맵 기간 슬라이더로 선택된 구간(startTs~endTs, 포함)에 발행된 뉴스만.
function newsInDashRange(startTs, endTs) {
  return state.news.filter((n) => {
    const t = _newsDateTs(n);
    return t !== null && t >= startTs && t <= endTs;
  });
}

function computeHeatmapMatrix(startTs, endTs) {
  const matrix = {};
  newsInDashRange(startTs, endTs).forEach((n) => {
    const primary = n.primary_topic || (n.topics || [])[0];
    if (!primary) return;
    const aid = n.agency_id;
    matrix[aid] = matrix[aid] || {};
    matrix[aid][primary] = (matrix[aid][primary] || 0) + 1;
  });
  return matrix;
}

function renderRangeSlider() {
  const box = $("#dash-rangeslider");
  if (!box) return;
  const totalDays = Math.max(1, Math.round((state.dashDateMaxTs - state.dashDateMinTs) / 86400000));
  const startDay = Math.round((state.dashRangeStartTs - state.dashDateMinTs) / 86400000);
  const endDay = Math.round((state.dashRangeEndTs - state.dashDateMinTs) / 86400000);
  const fmt = (ts) => new Date(ts).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });

  box.innerHTML =
    `<div class="range-slider">` +
      `<div class="range-slider-track-wrap">` +
        `<div class="range-slider-track"></div>` +
        `<div class="range-slider-fill" id="range-fill"></div>` +
        `<div class="range-slider-tip" id="range-tip-start"></div>` +
        `<div class="range-slider-tip" id="range-tip-end"></div>` +
        `<input type="range" id="range-start" min="0" max="${totalDays}" value="${startDay}">` +
        `<input type="range" id="range-end" min="0" max="${totalDays}" value="${endDay}">` +
      `</div>` +
      `<div class="range-slider-labels"><span id="range-label-start">${fmt(state.dashDateMinTs)}</span>` +
      `<span id="range-label-end">${fmt(state.dashDateMaxTs)}</span></div>` +
    `</div>`;

  const trackWrap = box.querySelector(".range-slider-track-wrap");
  const startInput = $("#range-start");
  const endInput = $("#range-end");
  const fill = $("#range-fill");
  const tipStart = $("#range-tip-start");
  const tipEnd = $("#range-tip-end");

  const updateFill = () => {
    const s = parseInt(startInput.value, 10);
    const e = parseInt(endInput.value, 10);
    fill.style.left = (s / totalDays * 100) + "%";
    fill.style.right = (100 - (e / totalDays * 100)) + "%";
  };

  // 드래그 중인 두 노드의 날짜 말풍선이 겹치면(구간이 좁을 때) 서로 밀어 이격시킨다.
  const positionTips = () => {
    const w = trackWrap.clientWidth;
    const s = parseInt(startInput.value, 10);
    const e = parseInt(endInput.value, 10);
    let sx = (s / totalDays) * w;
    let ex = (e / totalDays) * w;
    const tipW = Math.max(tipStart.offsetWidth, tipEnd.offsetWidth, 60);
    const minGap = tipW + 8;
    if (ex - sx < minGap) {
      const mid = (sx + ex) / 2;
      sx = mid - minGap / 2;
      ex = mid + minGap / 2;
    }
    tipStart.style.left = Math.max(0, Math.min(w, sx)) + "px";
    tipEnd.style.left = Math.max(0, Math.min(w, ex)) + "px";
  };

  updateFill();
  tipStart.textContent = fmt(state.dashRangeStartTs);
  tipEnd.textContent = fmt(state.dashRangeEndTs);
  positionTips();

  startInput.addEventListener("pointerdown", () => tipStart.classList.add("show"));
  endInput.addEventListener("pointerdown", () => tipEnd.classList.add("show"));
  window.addEventListener("pointerup", () => {
    tipStart.classList.remove("show");
    tipEnd.classList.remove("show");
  });

  startInput.addEventListener("input", () => {
    let s = parseInt(startInput.value, 10);
    const e = parseInt(endInput.value, 10);
    if (s > e) { s = e; startInput.value = String(s); }
    state.dashRangeStartTs = state.dashDateMinTs + s * 86400000;
    tipStart.textContent = fmt(state.dashRangeStartTs);
    updateFill();
    positionTips();
    renderDashKPI();
    renderHeatmap();
    renderTop3Cards();
  });
  endInput.addEventListener("input", () => {
    let e = parseInt(endInput.value, 10);
    const s = parseInt(startInput.value, 10);
    if (e < s) { e = s; endInput.value = String(e); }
    state.dashRangeEndTs = state.dashDateMinTs + e * 86400000;
    tipEnd.textContent = fmt(state.dashRangeEndTs);
    updateFill();
    positionTips();
    renderDashKPI();
    renderHeatmap();
    renderTop3Cards();
  });
}

// 앞 3개 타일(누적 뉴스/활성 기관/최다 주제)은 히트맵 기간 슬라이더의 선택 구간을 따라
// 실시간으로 다시 집계한다(전체 구간이면 "누적"/"활성 기관" 원래 문구, 일부 구간이면
// "선택기간"으로 문구를 바꿔 값의 의미를 명확히 함). 마지막 분기 증감 타일은 달력상
// 분기 대 분기 비교라 임의 구간과 성격이 달라 전체 데이터 기준을 유지한다.
function renderDashKPI() {
  const box = $("#dash-kpi");
  const filtered = newsInDashRange(state.dashRangeStartTs, state.dashRangeEndTs);
  const isFullRange = state.dashRangeStartTs <= state.dashDateMinTs && state.dashRangeEndTs >= state.dashDateMaxTs;

  const activeAgencies = new Set(filtered.map((n) => n.agency_id)).size;

  const topicCounts = {};
  filtered.forEach((n) => {
    const p = n.primary_topic || (n.topics || [])[0];
    if (p) topicCounts[p] = (topicCounts[p] || 0) + 1;
  });
  // 1위만 보여주면 구간을 옮겨도 압도적 1위 주제(AI 인재·교육)만 계속 보여
  // 구간별 변화가 잘 안 느껴진다는 피드백 — 상위 3개를 함께 보여준다.
  const top3 = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, n]) => {
      const t = state.topicById[id] || {};
      return { id, name: t.name || id, color: t.color || "#8b95a4", n };
    });

  const qc = {};
  state.news.forEach((n) => {
    const q = quarterOf(n.published || n.first_seen);
    if (q) qc[q] = (qc[q] || 0) + 1;
  });
  const qs = Object.keys(qc).sort();
  const lastQ = qs[qs.length - 1];
  const prevQ = qs[qs.length - 2];
  // 아직 안 끝난 분기(예: 8월 기준 2026-Q3)를 이미 끝난 지난 분기 전체와 그대로
  // 비교하면 진행 중인 분기가 실제보다 훨씬 줄어든 것처럼 보인다(실측 피드백,
  // 2026-08-26). 오늘이 이번 분기(lastQ) 안에 있으면, 지난 분기도 이번 분기와
  // 같은 일수만큼만 세어 공정하게 비교한다(예: 이번 분기 시작~오늘이 57일째면,
  // 지난 분기도 시작일로부터 57일치만 집계).
  const todayStr = new Date().toISOString().slice(0, 10);
  const quarterStartStr = (q) => {
    const [y, qn] = q.split("-Q").map(Number);
    return `${y}-${String((qn - 1) * 3 + 1).padStart(2, "0")}-01`;
  };
  const addDaysStr = (dateStr, days) => {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const isCurQOngoing = !!lastQ && quarterOf(todayStr) === lastQ;
  let delta = 0;
  let deltaBase = 0;
  let deltaNote = "";
  if (lastQ && prevQ) {
    if (isCurQOngoing) {
      const curQStart = quarterStartStr(lastQ);
      const elapsedDays = Math.floor(
        (new Date(todayStr + "T00:00:00Z") - new Date(curQStart + "T00:00:00Z")) / 86400000
      ) + 1;
      const prevQStart = quarterStartStr(prevQ);
      const prevWindowEnd = addDaysStr(prevQStart, elapsedDays);
      const prevCountSameWindow = state.news.filter((n) => {
        const d = (n.published || n.first_seen || "").slice(0, 10);
        return d >= prevQStart && d < prevWindowEnd;
      }).length;
      deltaBase = prevCountSameWindow;
      delta = qc[lastQ] - prevCountSameWindow;
      deltaNote = `지난 분기 같은 기간(${prevQStart}~${addDaysStr(prevQStart, elapsedDays - 1)}) 대비`;
    } else {
      deltaBase = qc[prevQ];
      delta = qc[lastQ] - qc[prevQ];
    }
  }
  const dArrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "·";
  const dColor = delta > 0 ? "var(--up)" : delta < 0 ? "var(--primary)" : "var(--text-dim)";
  const dPct = deltaBase > 0 ? Math.round((Math.abs(delta) / deltaBase) * 100) : null;
  const simpleTile = (v, l, d, dc, title) =>
    `<div class="kpi"${title ? ` title="${esc(title)}"` : ""}>` +
      `<span class="kpi-v">${esc(String(v))}</span>` +
      `<span class="kpi-l">${esc(l)}</span>` +
      (d ? `<span class="kpi-d" style="color:${dc}">${esc(d)}</span>` : "") +
    `</div>`;

  const topicsTile =
    `<div class="kpi kpi-topics">` +
      `<span class="kpi-l">${esc(isFullRange ? "최다 주제 TOP 3" : "선택기간 최다 주제 TOP 3")}</span>` +
      (top3.length
        ? `<ol class="kpi-topic-list">` + top3.map((t) =>
            `<li><span class="kpi-topic-dot" style="background:${esc(t.color)}"></span>` +
            `<button type="button" class="kpi-topic-name clickable" data-topic-id="${esc(t.id)}">${esc(t.name)}</button>` +
            `<span class="kpi-topic-n">${t.n}</span></li>`
          ).join("") + `</ol>`
        : `<span class="kpi-v sm">—</span>`) +
    `</div>`;

  box.innerHTML =
    simpleTile(filtered.length, isFullRange ? "누적 AX 뉴스" : "선택기간 AX 뉴스") +
    simpleTile(activeAgencies, isFullRange ? "활성 기관" : "선택기간 활성기관") +
    topicsTile +
    simpleTile(lastQ ? qc[lastQ] : 0, (lastQ || "최근 분기") + " 수집" + (isCurQOngoing ? " · 진행중" : ""),
      delta ? dArrow + " " + Math.abs(delta) + (dPct !== null ? ` (${dPct}%)` : "") : "", dColor, deltaNote);

  box.querySelectorAll(".kpi-topic-name[data-topic-id]").forEach((btn) => {
    btn.addEventListener("click", () => openSubtopicDrilldown(btn.dataset.topicId));
  });
}

function dashTopicsCols() {
  return (state.topics.topics || []).filter((t) => t.id !== "other");
}

const HEATMAP_TOP_N = 20;

function renderHeatmap() {
  const cols = dashTopicsCols();
  // 천안시는 이 사이트의 주체 기관이라 보도자료 건수와 무관하게 항상 첫 행에 고정하고,
  // 나머지 기관만 보도자료 건수(newsCount, 뉴스 탭 사이드바와 동일 기준) 내림차순으로
  // 정렬한다. 첫 행이므로 아래 HEATMAP_TOP_N 으로 잘라도 천안시 행은 항상 남는다.
  // 행 강조(.home-agency → 볼드체·강조색)로 한 번 더 눈에 띄게 한다.
  const allRows = state.agencies.slice().sort((a, b) => {
    const ha = isHomeAgency(a) ? 1 : 0;
    const hb = isHomeAgency(b) ? 1 : 0;
    if (ha !== hb) return hb - ha;
    return (b.newsCount || 0) - (a.newsCount || 0);
  });
  const expanded = state.dashHeatmapExpanded || allRows.length <= HEATMAP_TOP_N;
  const rows = expanded ? allRows : allRows.slice(0, HEATMAP_TOP_N);
  const m = computeHeatmapMatrix(state.dashRangeStartTs, state.dashRangeEndTs);
  let max = 1;
  allRows.forEach((a) => cols.forEach((t) => { max = Math.max(max, (m[a.id] || {})[t.id] || 0); }));
  // 로그 스케일: 최댓값이 이상치여도 흔한 값들이 명암 단계로 뚜렷이 구분되도록.
  const lmax = Math.log(max + 1) || 1;
  const bucket = (v) => (v <= 0 ? 0 : Math.min(5, 1 + Math.floor((Math.log(v + 1) / lmax) * 4.999)));

  let head = '<tr><th class="hm-corner"></th>' + cols.map((t) =>
    `<th title="${esc(t.name)}"><span class="hm-th">${esc(t.name)}</span></th>`).join("") + "</tr>";
  const body = rows.map((a) => {
    const rowCls = isHomeAgency(a) ? "home-agency" : "";
    const cells = cols.map((t) => {
      const v = (m[a.id] || {})[t.id] || 0;
      const b = bucket(v);
      return `<td class="hm-cell b${b}" data-a="${a.id}" data-t="${t.id}" ` +
        `title="${esc(a.name)} · ${esc(t.name)}: ${v}건">${v || ""}</td>`;
    }).join("");
    return `<tr${rowCls ? ` class="${rowCls}"` : ""}><td class="hm-ag">${esc(a.name)}</td>${cells}</tr>`;
  }).join("");

  const toggle = allRows.length > HEATMAP_TOP_N
    ? `<button id="hm-toggle" class="hm-toggle">${
        expanded ? "접기 ▲" : `더 보기 · 전체 ${allRows.length}개 기관 ▼`
      }</button>`
    : "";

  $("#dash-heatmap").innerHTML =
    `<div class="hm-scroll"><table class="hm">${head}${body}</table></div>` +
    `<div class="hm-legend">활동 적음 ` +
    [0, 1, 2, 3, 4, 5].map((b) => `<i class="b${b}"></i>`).join("") +
    ` 많음 · <b class="home-agency-key">${esc(HOME_AGENCY_NAME)}</b> 행 강조</div>` +
    toggle;

  $("#dash-heatmap").querySelectorAll(".hm-cell").forEach((c) => {
    c.addEventListener("click", () => showDrill(c.dataset.a, c.dataset.t));
  });
  const toggleBtn = $("#hm-toggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      state.dashHeatmapExpanded = !state.dashHeatmapExpanded;
      renderHeatmap();
    });
  }
}

function showDrill(agencyId, topicId) {
  const a = state.agencyById[agencyId];
  const t = state.topicById[topicId];
  const items = newsInDashRange(state.dashRangeStartTs, state.dashRangeEndTs)
    .filter((n) => n.agency_id === agencyId && (n.primary_topic || (n.topics || [])[0]) === topicId)
    .sort((x, y) => (y.published || "").localeCompare(x.published || ""));
  const box = $("#dash-drill");
  box.hidden = false;
  // 요약이 있으면 제목 클릭 시 뉴스 탭과 동일한 요약 팝업을 띄우고(진짜 링크가
  // 아니라 클릭 트리거), 요약이 없는 기사만 제목이 원문으로 바로가기 링크가 된다.
  const list = items.map((n) => {
    const summary = (state.summaryById[n.id] || {}).summary || "";
    const titleHtml = summary
      ? `<span class="drill-t" data-newsid="${esc(n.id)}" tabindex="0" role="button">${esc(n.title)}</span>`
      : `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>`;
    return `<li>${titleHtml}` +
      (n.published ? ` <span class="d-date">${esc(n.published)}</span>` : "") + `</li>`;
  }).join("");
  box.innerHTML =
    `<div class="drill-head"><b>${esc(a ? a.name : agencyId)}</b> · ${esc(t ? t.name : topicId)} ` +
    `<span class="drill-cnt">${items.length}건</span>` +
    `<button class="drill-x" aria-label="닫기">✕</button></div>` +
    (items.length ? `<ul class="drill-list">${list}</ul>` : `<div class="empty">해당 뉴스가 없습니다.</div>`);
  box.querySelector(".drill-x").addEventListener("click", () => { box.hidden = true; });
  box.querySelectorAll(".drill-t").forEach((elx) => {
    const n = state.newsById[elx.dataset.newsid];
    if (!n) return;
    const open = () => openNewsModal(n, (state.summaryById[n.id] || {}).summary || "");
    elx.addEventListener("click", open);
    elx.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); }
    });
  });
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderTopicFilter() {
  const box = $("#dash-topicfilter");
  const cols = dashTopicsCols();
  const mk = (id, name, color) => {
    const on = state.dashTopic === id ? " on" : "";
    const style = color ? `style="--tc:${color};--tc-ink:${inkOn(color)}"` : "";
    return `<button class="tf${on}" data-t="${id}" ${style}>${esc(name)}</button>`;
  };
  box.innerHTML = mk("all", "전체", null) + cols.map((t) => mk(t.id, t.name, t.color)).join("");
  box.querySelectorAll(".tf").forEach((b) => b.addEventListener("click", () => {
    state.dashTopic = b.dataset.t;
    state.dashBenchExpanded = false;
    renderTopicFilter();
    renderBench();
  }));
}

const BENCH_TOP_N = 10;
const BENCH_POOL_CAP = 100;

// 벤치마킹 사례 "참조 가치" 점수 — 신규 LLM 호출 없이 이미 있는 수집 메타데이터로 추정.
//   tier1(제목에 핵심 AI 키워드 직접 매칭)이 accepted(LLM이 보조판단으로 채택)보다 AX 중심성이 높고,
//   matched 키워드 수가 많을수록 AX와 다각도로 관련됨. AI 요약이 있으면(본문이 충분히 실질적이라
//   요약이 만들어졌다는 뜻) 참조 자료로서 가치가 조금 더 높다고 봄. 동점이면 최신순.
// 천안시 관점 가산 — 기초지자체가 바로 참고·이식할 수 있는 사례를 위로 올린다.
const BENCH_LOCAL_TOPICS = new Set(["public", "data", "infra"]);
const BENCH_LOCAL_RE = /지자체|지방자치|지방정부|시청|군청|도청|주민|민원|생활밀착|현장\s*적용|시범\s*도입/;

function benchScore(n) {
  let s = n.tier === "tier1" ? 100 : 0;
  s += (n.matched || []).length * 10;
  if ((state.summaryById[n.id] || {}).summary) s += 5;
  // 공공행정 계열 주제이거나 제목에 지자체 적용 신호가 있으면 천안시 입장에서 참조 가치가 높다.
  const primary = n.primary_topic || (n.topics || [])[0];
  if (BENCH_LOCAL_TOPICS.has(primary)) s += 20;
  if (BENCH_LOCAL_RE.test(n.title || "")) s += 30;
  return s;
}

function renderBench() {
  const box = $("#dash-bench");
  // 벤치마킹은 '우리 기관(천안시) 밖의 사례'를 보는 패널 — 천안시 자체 보도자료만 제외한다.
  let items = state.news.filter((n) => n.agency_id !== HOME_AGENCY_ID);
  if (state.dashTopic !== "all") {
    items = items.filter((n) => (n.primary_topic || (n.topics || [])[0]) === state.dashTopic);
  }
  items = items.sort((x, y) => {
    const d = benchScore(y) - benchScore(x);
    return d !== 0 ? d : (y.published || "").localeCompare(x.published || "");
  }).slice(0, BENCH_POOL_CAP);
  if (!items.length) {
    box.innerHTML = '<div class="empty">천안시가 참고할 만한 타 기관 사례가 이 주제에는 아직 없습니다.</div>';
    return;
  }
  const expanded = state.dashBenchExpanded || items.length <= BENCH_TOP_N;
  const visible = expanded ? items : items.slice(0, BENCH_TOP_N);

  const cards = visible.map((n) => {
    const a = state.agencyById[n.agency_id];
    const primaryId = n.primary_topic || (n.topics || [])[0];
    const pt = primaryId && primaryId !== "other" ? state.topicById[primaryId] : null;
    const tagHtml = pt ? `<span class="topic-badge bench-tag" style="--tc:${pt.color}">${esc(pt.name)}</span>` : "";
    const summary = (state.summaryById[n.id] || {}).summary || "";
    // 요약이 있으면 제목 클릭 시 뉴스 탭과 동일한 요약 팝업, 없으면 원문 바로가기.
    const titleHtml = summary
      ? `<span class="bench-t" data-newsid="${esc(n.id)}" tabindex="0" role="button">${esc(n.title)}</span>`
      : `<a class="bench-t" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>`;
    return `<article class="bench-item">` +
      `<div class="bench-m"><span class="bench-ag">${ICON_AGENCY} ${esc(a ? a.shortName || a.name : n.agency_id)}</span>` +
      tagHtml +
      (n.published ? `<span class="bench-date">${esc(n.published)}</span>` : "") + `</div>` +
      titleHtml +
      `</article>`;
  }).join("");

  const toggle = items.length > BENCH_TOP_N
    ? `<button id="bench-toggle" class="hm-toggle">${
        expanded ? "접기 ▲" : `더 보기 · 최근 ${items.length}건 ▼`
      }</button>`
    : "";

  box.innerHTML = cards + toggle;
  box.querySelectorAll(".bench-t[data-newsid]").forEach((elx) => {
    const n = state.newsById[elx.dataset.newsid];
    if (!n) return;
    const open = () => openNewsModal(n, (state.summaryById[n.id] || {}).summary || "");
    elx.addEventListener("click", open);
    elx.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); }
    });
  });

  const toggleBtn = $("#bench-toggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      state.dashBenchExpanded = !state.dashBenchExpanded;
      renderBench();
    });
  }
}

// ===== 대시보드 2 — 주제별 트렌드(시계열) =====
// 월별 총계 + 세부주제(12종, '기타' 제외)별 월별 시리즈를 news 원본에서 직접 집계.
// 별도 백엔드 산출물 없이 state.news(published)+primary_topic만으로 계산.
// 서버가 미리 계산해 저장해 둔 값을 읽는 게 아니라 호출 시점마다 새로 집계하므로,
// '월별추이' 탭의 총 건수·활성기관 수는 별도 배치 없이 매일 자동으로 최신 상태를
// 반영한다(README '월별추이 탭' 절 참고) — 화면이 안 바뀌어 보인다면 데이터가
// 멈춘 게 아니라 페이지를 새로고침하지 않았을 가능성이 크다.
function computeMonthlySeries(includeCurrent = false) {
  // 조회일이 속한 이번 달은 아직 집계가 끝나지 않아(예: 8월 10일에 보면 8월분은
  // 10일치뿐) 전월 대비 급감처럼 보이는 왜곡이 생긴다 — 기본은 완결된 전월까지만
  // 표시. '전체 AX 뉴스 추이' 차트에서만 사용자가 화살표 토글로 명시적으로
  // 요청하면(includeCurrent) 진행 중인 이번 달도 함께 그린다.
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const monthSet = new Set();
  state.news.forEach((n) => {
    const d = n.published || n.first_seen || "";
    if (d.length >= 7) monthSet.add(d.slice(0, 7));
  });
  if (!includeCurrent) monthSet.delete(currentMonthKey);
  const months = Array.from(monthSet).sort();

  const totalByMonth = Object.fromEntries(months.map((m) => [m, 0]));
  const topics = (state.topics?.topics || []).filter((t) => t.id !== "other");
  const byTopic = Object.fromEntries(topics.map((t) => [t.id, Object.fromEntries(months.map((m) => [m, 0]))]));
  // 그 달에 보도자료를 낸 기관 수(활성기관) — 몇 건이 아니라 몇 "곳"이 움직였는지.
  const agencySetByMonth = Object.fromEntries(months.map((m) => [m, new Set()]));

  state.news.forEach((n) => {
    const d = n.published || n.first_seen || "";
    if (d.length < 7) return;
    const mk = d.slice(0, 7);
    if (!(mk in totalByMonth)) return;
    totalByMonth[mk] += 1;
    const p = n.primary_topic || (n.topics || [])[0];
    if (p && byTopic[p]) byTopic[p][mk] += 1;
    if (n.agency_id) agencySetByMonth[mk].add(n.agency_id);
  });
  const activeAgencyByMonth = Object.fromEntries(
    months.map((m) => [m, agencySetByMonth[m].size])
  );
  return { months, totalByMonth, byTopic, topics, activeAgencyByMonth };
}

const AGENCY_TREND_TOP_N = 10;

// 완결된 전월까지의 누적 보도자료 건수 기준 상위 N개 기관의 월별 시리즈 —
// months가 이미 computeMonthlySeries()에서 진행 중인 이번 달을 뺀 "완결월"만
// 남긴 상태라, totals는 자연히 "전월까지 누적"이 된다(2026-08-26 요청으로
// "(전월 누적 기준)" 라벨과 일치하도록 함 — 직전 한 달 건수만 보던 방식은
// 월초에 원래 활발한 기관이 일시적으로 밀려나는 문제가 있어 되돌림). 기관은
// 12개 주제와 달리 고정 색 체계가 없고 10개를 한 차트에 겹치면 읽히지
// 않으므로(과기정통부 월 최대 50건 vs 농림축산식품부 8건 — 공통 축에서는
// 9개 선이 바닥에 눌린다) 기관별 카드로 나눠 그린다.
function computeAgencyMonthlySeries() {
  const { months } = computeMonthlySeries();
  const inRange = new Set(months);
  const totals = {};
  const byAgency = {};
  state.news.forEach((n) => {
    const d = n.published || n.first_seen || "";
    if (d.length < 7) return;
    const mk = d.slice(0, 7);
    if (!inRange.has(mk)) return;
    const aid = n.agency_id;
    if (!aid) return;
    totals[aid] = (totals[aid] || 0) + 1;
    byAgency[aid] = byAgency[aid] || {};
    byAgency[aid][mk] = (byAgency[aid][mk] || 0) + 1;
  });
  // 천안시는 건수가 적어도 카드가 항상 보이도록 키를 만들어 두고 첫 자리에 고정한다
  // (기관 목록·히트맵과 같은 '우리 기관은 늘 보인다' 원칙).
  if (!(HOME_AGENCY_ID in totals)) totals[HOME_AGENCY_ID] = 0;
  const top = Object.keys(totals)
    .sort((a, b) => {
      const ha = a === HOME_AGENCY_ID ? 1 : 0;
      const hb = b === HOME_AGENCY_ID ? 1 : 0;
      if (ha !== hb) return hb - ha;
      return totals[b] - totals[a];
    })
    .slice(0, AGENCY_TREND_TOP_N)
    .map((aid) => ({
      id: aid,
      name: (state.agencyById[aid] || {}).name || aid,
      total: totals[aid],
      values: months.map((m) => (byAgency[aid] || {})[m] || 0),
    }));
  return { months, top };
}

// 상위 기관 월별 추이 — 기관마다 규모 차이가 커서 카드별로 y축을 따로 잡는다(추세 모양이
// 보이도록). 대신 카드마다 그 기관의 최고치를 함께 적어, 카드 높이를 기관 간 크기 비교로
// 오해하지 않게 한다.
function renderTrendAgencies() {
  const box = $("#trend-agencies");
  if (!box) return;
  const { months, top } = computeAgencyMonthlySeries();
  if (!months.length || !top.length) { box.innerHTML = ""; return; }
  const n = months.length;
  const W = 220, H = 52, PAD = 4;
  const x = (i) => PAD + (n === 1 ? (W - PAD * 2) / 2 : ((W - PAD * 2) * i) / (n - 1));

  box.innerHTML = top.map((a) => {
    const values = a.values;
    const max = Math.max(1, ...values);
    const y = (v) => PAD + (H - PAD * 2) - (v / max) * (H - PAD * 2);
    const path = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const last = values[n - 1];
    const delta = last - (n > 1 ? values[n - 2] : 0);
    const dArrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "·";
    const dColor = delta > 0 ? "var(--up)" : delta < 0 ? "var(--primary)" : "var(--text-dim)";
    const points = values.map((v, i) =>
      `<circle class="trend-mini-hit" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="7">` +
      `<title>${esc(monthLabel(months[i]))}월 · ${esc(a.name)} ${v}건</title></circle>`
    ).join("");
    return `<div class="trend-card clickable" data-agency-id="${esc(a.id)}" tabindex="0" role="button" ` +
      `aria-label="${esc(a.name)} 이번 달 보도자료 보기">` +
      `<div class="trend-card-h"><span class="trend-card-name">${esc(a.name)}</span>` +
        `<span class="trend-card-sub">누적 ${a.total.toLocaleString("ko-KR")}건</span></div>` +
      `<div class="trend-card-body">` +
        `<span class="trend-card-value">${last.toLocaleString("ko-KR")}<small>건</small></span>` +
        `<span class="trend-card-delta" style="color:${dColor}">` +
          (delta !== 0 ? `${dArrow} ${Math.abs(delta)}` : "변동없음") + `</span>` +
      `</div>` +
      `<svg class="trend-mini" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" ` +
        `aria-label="${esc(a.name)} 월별 추이, 최근 달 ${last}건, 기간 내 최고 ${max}건">` +
        `<path class="trend-mini-line" d="${path}"></path>` +
        `<circle class="trend-mini-end trend-mini-end-ag" cx="${x(n - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4"></circle>` +
        points +
      `</svg>` +
      `<div class="trend-card-scale">최고 ${max}건</div>` +
    `</div>`;
  }).join("");

  box.querySelectorAll(".trend-card[data-agency-id]").forEach((card) => {
    const go = () => openAgencyMonthNews(card.dataset.agencyId);
    card.addEventListener("click", go);
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); }
    });
  });
}

// "보도자료 상위 10개 기관 추이" 카드 클릭 — 조회일(오늘)이 속한 달과 그 전월,
// 두 달치 그 기관 보도자료 목록을 세부분류 팝업(#subtopic-modal)에 재사용해
// 보여준다(이번 달만 두면 월초에는 목록이 거의 비어 보인다는 피드백,
// 2026-08-26). 트렌드 차트 자체는 "이번 달은 집계가 안 끝나 왜곡된다"는 이유로
// 진행 중인 달을 빼고 그리지만(computeMonthlySeries), 이 팝업은 차트가 아니라
// "요즘 이 기관이 낸 보도자료가 뭐지?"에 답하는 용도라 진행 중인 달도 그대로
// 포함한다.
function openAgencyMonthNews(agencyId) {
  const a = state.agencyById[agencyId] || {};
  const name = a.name || agencyId;
  const now = new Date();
  const curMk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMk = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;
  const monthNum = now.getMonth() + 1;
  const prevMonthNum = prevDate.getMonth() + 1;
  const items = state.news
    .filter((n) => n.agency_id === agencyId && [curMk, prevMk].includes((n.published || n.first_seen || "").slice(0, 7)))
    .sort((x, y) => (y.published || y.first_seen || "").localeCompare(x.published || x.first_seen || ""));
  const prevCount = items.filter((n) => (n.published || n.first_seen || "").slice(0, 7) === prevMk).length;
  const curCount = items.filter((n) => (n.published || n.first_seen || "").slice(0, 7) === curMk).length;

  const header = $("#stm-header");
  header.style.setProperty("--stm-color", "var(--primary)");
  header.style.setProperty("--stm-soft", "var(--seal-soft)");
  $("#stm-eyebrow").textContent = `${prevMonthNum}~${monthNum}월 보도자료`;
  $("#stm-title").textContent = name;
  $("#stm-count").textContent = `전월 ${prevCount}건 / 이번달 ${curCount}건`;
  $("#stm-sub").style.display = items.length ? "none" : "";
  $("#stm-sub").textContent = items.length
    ? ""
    : `${prevMonthNum}~${monthNum}월에는 아직 등록된 보도자료가 없습니다.`;

  const msIds = milestoneNewsIds();
  $("#stm-buckets").innerHTML = items.length
    ? `<ul class="stm-newslist">${items.map((n) => `
        <li class="stm-news-row">
          <span class="stm-news-date">${esc((n.published || n.first_seen || "").slice(5, 10))}</span>
          <button type="button" class="stm-news-title" data-news-id="${esc(n.id)}">${newsListTitleHtml(n, msIds)}</button>
        </li>`).join("")}</ul>`
    : "";

  $("#stm-buckets").querySelectorAll(".stm-news-title").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = state.newsById[btn.dataset.newsId];
      if (!n) return;
      const summary = (state.summaryById[n.id] || {}).summary || "";
      if (summary) openNewsModal(n, summary);
      else window.open(httpUrl(n.url) || "#", "_blank", "noopener");
    });
  });

  document.getElementById("subtopic-modal").hidden = false;
}

function monthLabel(mk) {
  const [y, m] = mk.split("-");
  return `${y.slice(2)}.${parseInt(m, 10)}`;
}

// 점들을 부드러운 곡선으로 잇는 SVG path("M...C...") — Catmull-Rom을 3차 베지어로
// 환산(장력 1/6), 각 점을 정확히 지나가면서 꺾이지 않고 완만하게 이어짐.
function smoothPathD(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  const d = [`M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d.push(`C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`);
  }
  return d.join(" ");
}

// 전체 추이 — 단일 시리즈 완만한 곡선+영역 차트, 크로스헤어+말풍선 툴팁(호버·키보드 포커스 공통)
function renderTrendOverall() {
  const box = $("#trend-overall");
  if (!box) return;
  const { months, totalByMonth, activeAgencyByMonth } = computeMonthlySeries(state.trendIncludeCurrent);
  if (!months.length) {
    box.innerHTML = '<div class="empty">아직 집계할 데이터가 없습니다.</div>';
    return;
  }
  const values = months.map((m) => totalByMonth[m]);
  const agencyValues = months.map((m) => activeAgencyByMonth[m]);
  const max = Math.max(1, ...values);
  // 활성기관 수는 전체 건수와 스케일이 전혀 달라(건수는 수백, 기관수는 수십) 같은
  // 축에 그리면 기관수 선이 바닥에 눌려 안 보인다 — 오른쪽에 별도 축을 둔다.
  const maxAgency = Math.max(1, ...agencyValues);
  const n = months.length;

  // '이번 달' 토글로 진행 중인 달까지 펼쳤을 때는, 그 달이 아직 끝나지 않은
  // 조회일까지의 부분 집계라는 걸 라벨에서도 알 수 있게 "26.8"이 아니라
  // "26.8.26"처럼 조회일자까지 표기한다.
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const lastIsToday = state.trendIncludeCurrent && months[n - 1] === todayKey;
  const tickLabel = (m, i) => (lastIsToday && i === n - 1) ? `${monthLabel(m)}.${now.getDate()}` : monthLabel(m);

  const W = 900, H = 200, PAD_L = 40, PAD_R = 34, PAD_T = 16, PAD_B = 26;
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
  const x = (i) => PAD_L + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const y = (v) => PAD_T + innerH - (v / max) * innerH;
  const y2 = (v) => PAD_T + innerH - (v / maxAgency) * innerH;

  const points = values.map((v, i) => [x(i), y(v)]);
  const linePath = smoothPathD(points);
  const areaPath = `${linePath} L${x(n - 1).toFixed(1)},${(PAD_T + innerH).toFixed(1)} ` +
    `L${x(0).toFixed(1)},${(PAD_T + innerH).toFixed(1)} Z`;
  const points2 = agencyValues.map((v, i) => [x(i), y2(v)]);
  const linePath2 = smoothPathD(points2);

  const yTicks = Array.from(new Set([0, Math.round(max / 2), max]));
  const gridlines = yTicks.map((v) => {
    const yy = y(v);
    return `<line class="trend-gridline" x1="${PAD_L}" y1="${yy.toFixed(1)}" x2="${W - PAD_R}" y2="${yy.toFixed(1)}"></line>` +
      `<text class="trend-axis-y" x="${PAD_L - 8}" y="${yy.toFixed(1)}" text-anchor="end" dominant-baseline="middle">${v}</text>`;
  }).join("");
  const y2Ticks = Array.from(new Set([0, Math.round(maxAgency / 2), maxAgency]));
  const y2Labels = y2Ticks.map((v) => {
    const yy = y2(v);
    return `<text class="trend-axis-y2" x="${W - PAD_R + 8}" y="${yy.toFixed(1)}" text-anchor="start" dominant-baseline="middle">${v}</text>`;
  }).join("");

  const xLabelEvery = Math.max(1, Math.ceil(n / 7));
  const xLabels = months.map((m, i) => (i % xLabelEvery === 0 || i === n - 1)
    ? `<text class="trend-axis-x" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(tickLabel(m, i))}</text>`
    : "").join("");

  const stepW = n > 1 ? innerW / (n - 1) : innerW;
  const hitRects = months.map((m, i) => {
    const rx = Math.max(PAD_L, x(i) - stepW / 2);
    return `<rect class="trend-hit" data-i="${i}" x="${rx.toFixed(1)}" y="${PAD_T}" width="${stepW.toFixed(1)}" ` +
      `height="${innerH}" tabindex="0" role="img" ` +
      `aria-label="${esc(tickLabel(m, i))} ${values[i]}건 · 활성기관 ${agencyValues[i]}개"></rect>`;
  }).join("");

  const lastX = x(n - 1), lastY = y(values[n - 1]), lastY2 = y2(agencyValues[n - 1]);

  box.innerHTML =
    `<div class="trend-legend">` +
      `<span class="trend-legend-item"><i class="trend-legend-dot primary"></i>월별 보도자료 건수</span>` +
      `<span class="trend-legend-item"><i class="trend-legend-dot agencies"></i>활성기관 수</span>` +
      `<button type="button" id="trend-expand-toggle" class="trend-expand-btn${state.trendIncludeCurrent ? " expanded" : ""}" ` +
        `aria-pressed="${state.trendIncludeCurrent}" ` +
        `aria-label="${state.trendIncludeCurrent ? "진행 중인 이번 달 제외하기" : "진행 중인 이번 달 포함해서 보기"}">` +
        `<span>오늘 기준</span>${ICON_CHEVRON}` +
      `</button>` +
    `</div>` +
    `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" ` +
      `aria-label="전체 AX 뉴스 월별 추이 및 활성기관 수 라인 차트">` +
      `<g class="trend-gridlines">${gridlines}</g>` +
      `<path class="trend-area" d="${areaPath}"></path>` +
      `<path class="trend-line" d="${linePath}"></path>` +
      `<path class="trend-line-agencies" d="${linePath2}"></path>` +
      `<circle class="trend-end-dot" cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="5"></circle>` +
      `<circle class="trend-end-dot-agencies" cx="${lastX.toFixed(1)}" cy="${lastY2.toFixed(1)}" r="4"></circle>` +
      `<g class="trend-xlabels">${xLabels}</g>` +
      `<g class="trend-y2labels">${y2Labels}</g>` +
      `<line id="trend-crosshair" class="trend-crosshair" x1="0" y1="${PAD_T}" x2="0" y2="${PAD_T + innerH}" hidden></line>` +
      `<g class="trend-hits">${hitRects}</g>` +
    `</svg>` +
    `<div id="trend-tip" class="trend-tip" hidden></div>`;

  const svg = box.querySelector(".trend-svg");
  const crosshair = $("#trend-crosshair");
  const tip = $("#trend-tip");

  const showAt = (i) => {
    const cx = x(i);
    crosshair.setAttribute("x1", cx.toFixed(1));
    crosshair.setAttribute("x2", cx.toFixed(1));
    crosshair.hidden = false;
    tip.hidden = false;
    tip.innerHTML = "";
    const b = el("b", null, (lastIsToday && i === n - 1) ? esc(tickLabel(months[i], i)) : esc(monthLabel(months[i])) + "월");
    const s = el("span", null, values[i].toLocaleString("ko-KR") + "건");
    const s2 = el("span", null, "활성기관 " + agencyValues[i].toLocaleString("ko-KR") + "개");
    tip.appendChild(b);
    tip.appendChild(s);
    tip.appendChild(s2);
    const pct = Math.min(94, Math.max(6, (cx / W) * 100));
    tip.style.left = pct + "%";
  };
  const hide = () => { crosshair.hidden = true; tip.hidden = true; };

  svg.querySelectorAll(".trend-hit").forEach((r) => {
    const i = parseInt(r.dataset.i, 10);
    r.addEventListener("pointerenter", () => showAt(i));
    r.addEventListener("pointermove", () => showAt(i));
    r.addEventListener("focus", () => showAt(i));
    r.addEventListener("blur", hide);
  });
  svg.addEventListener("pointerleave", hide);

  $("#trend-expand-toggle")?.addEventListener("click", () => {
    state.trendIncludeCurrent = !state.trendIncludeCurrent;
    renderTrendOverall();
  });
}

// 세부주제별 추이 — 주제마다 독립된 스탯 타일+스파크라인(작은 다중 차트).
// 12개 색을 한 차트에 겹치면(범주형 팔레트 한계상 8색이 안전 상한) 식별이 어려워지므로,
// 카드마다 분리해 스파크라인은 절제색(회색)으로 긋고 이번 달 끝점만 그 주제의 색으로 강조한다.
function renderTrendGrid() {
  const box = $("#trend-grid");
  if (!box) return;
  const { months, byTopic, topics } = computeMonthlySeries();
  if (!months.length) { box.innerHTML = ""; return; }
  const n = months.length;
  const W = 220, H = 52, PAD = 4;
  const x = (i) => PAD + (n === 1 ? (W - PAD * 2) / 2 : ((W - PAD * 2) * i) / (n - 1));

  const cards = topics.map((t) => {
    const series = byTopic[t.id];
    const values = months.map((m) => series[m]);
    const max = Math.max(1, ...values);
    const y = (v) => PAD + (H - PAD * 2) - (v / max) * (H - PAD * 2);
    const path = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const last = values[n - 1];
    const prev = n > 1 ? values[n - 2] : 0;
    const delta = last - prev;
    const dArrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "·";
    const dColor = delta > 0 ? "var(--up)" : delta < 0 ? "var(--primary)" : "var(--text-dim)";
    const points = values.map((v, i) =>
      `<circle class="trend-mini-hit" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="7">` +
      `<title>${esc(monthLabel(months[i]))}월 · ${esc(t.name)} ${v}건</title></circle>`
    ).join("");
    return `<div class="trend-card clickable" data-topic-id="${esc(t.id)}" tabindex="0" role="button" ` +
      `aria-label="${esc(t.name)} 세부 분류 보기">` +
      `<div class="trend-card-h"><span class="trend-dot" style="background:${esc(t.color)}"></span>` +
        `<span class="trend-card-name">${esc(t.name)}</span></div>` +
      `<div class="trend-card-body">` +
        `<span class="trend-card-value">${last.toLocaleString("ko-KR")}<small>건</small></span>` +
        `<span class="trend-card-delta" style="color:${dColor}">` +
          (delta !== 0 ? `${dArrow} ${Math.abs(delta)}` : "변동없음") + `</span>` +
      `</div>` +
      `<svg class="trend-mini" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" ` +
        `aria-label="${esc(t.name)} 월별 추이, 이번 달 ${last}건">` +
        `<path class="trend-mini-line" d="${path}"></path>` +
        `<circle class="trend-mini-end" cx="${x(n - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4" fill="${esc(t.color)}"></circle>` +
        points +
      `</svg>` +
    `</div>`;
  }).join("");

  box.innerHTML = cards;

  box.querySelectorAll(".trend-card[data-topic-id]").forEach((card) => {
    const go = () => openSubtopicDrilldown(card.dataset.topicId, state.news);
    card.addEventListener("click", go);
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); }
    });
  });
}

// ===== 키워드 관계망 (지식그래프) =====
// data/keywords.json 의 graph 는 build_keywords.py 가 미리 계산한다 —
// 관계 = "같은 보도자료에 함께 등장"(동시출현, 자카드로 정규화), 좌표 = 힘기반 배치.
// 배치를 서버에서 결정적으로 계산하므로 볼 때마다 그림이 흔들리지 않고, 느린 기기에서도
// 시뮬레이션 부하가 없다.
// 원 크기 = 언급된 보도자료 수, 원 색 = 주로 걸린 주제, 선 굵기 = 관계 강도.
// 글자는 먹색을 유지한다: 주제 팔레트의 밝은 계열은 흰 배경 대비가 2.3~2.7:1로 본문 텍스트
// 기준(4.5:1)에 못 미쳐, 색을 글자에 입히면 읽히지 않는다(색은 원이 담당).
const KG_R_MIN = 6, KG_R_MAX = 23;
const KG_LABEL_MIN = 12, KG_LABEL_MAX = 20;

function renderKeywordGraph() {
  const box = $("#keyword-cloud");
  if (!box) return;
  const kw = state.keywords;
  const g = kw && kw.graph;
  const nodes = (g && g.nodes) || [];
  const edges = (g && g.edges) || [];
  if (!nodes.length) {
    box.innerHTML = '<div class="empty">최근 요약에서 추출할 키워드가 아직 없습니다.</div>';
    return;
  }
  const W = g.width || 1000, H = g.height || 620;
  const counts = nodes.map((n) => n.count);
  const cmin = Math.min(...counts), cmax = Math.max(...counts);
  const scale = (c, lo, hi) => {
    if (cmax === cmin) return (lo + hi) / 2;
    const t = (Math.sqrt(c) - Math.sqrt(cmin)) / (Math.sqrt(cmax) - Math.sqrt(cmin));
    return lo + t * (hi - lo);
  };
  const smax = Math.max(...edges.map((e) => e.score), 0.0001);

  // 이웃 목록 — 호버 시 관계된 노드만 남기고 나머지를 흐리게 하는 데 쓴다
  const nb = nodes.map(() => new Set());
  edges.forEach((e, i) => { nb[e.source].add(i); nb[e.target].add(i); });

  const edgeSvg = edges.map((e, i) => {
    const a = nodes[e.source], b = nodes[e.target];
    const w = 0.55 + (e.score / smax) * 1.35;
    return `<line class="kg-edge" data-e="${i}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ` +
      `stroke-width="${w.toFixed(2)}"><title>${esc(a.text)} ↔ ${esc(b.text)} · 같은 보도자료 ${e.co}건</title></line>`;
  }).join("");

  const nodeSvg = nodes.map((n, i) => {
    const r = scale(n.count, KG_R_MIN, KG_R_MAX);
    const fs = scale(n.count, KG_LABEL_MIN, KG_LABEL_MAX);
    const color = n.color || "#8b95a4";
    const tname = n.topic_name || "기타";
    return `<g class="kg-node" data-i="${i}" data-kw="${esc(n.text)}" tabindex="0" role="button" ` +
      `aria-label="${esc(n.text)}, ${n.count}건, ${esc(tname)}">` +
      `<title>${esc(n.text)} · ${n.count}건 보도자료에서 언급 · 주로 ${esc(tname)}</title>` +
      `<circle class="kg-dot" cx="${n.x}" cy="${n.y}" r="${r.toFixed(1)}" fill="${esc(color)}"></circle>` +
      `<text class="kg-label" x="${n.x}" y="${(n.y + r + fs * 0.95).toFixed(1)}" ` +
      `text-anchor="middle" font-size="${fs.toFixed(1)}">${esc(n.text)}</text></g>`;
  }).join("");

  box.innerHTML =
    `<svg class="kg" viewBox="0 0 ${W} ${H}" role="img" ` +
      `aria-label="키워드 관계망 — 노드 ${nodes.length}개, 관계 ${edges.length}개">` +
      `<g class="kg-edges">${edgeSvg}</g><g class="kg-nodes">${nodeSvg}</g></svg>`;

  const svg = box.querySelector(".kg");
  const clear = () => {
    svg.classList.remove("kg-focus");
    svg.querySelectorAll(".kg-node.on, .kg-edge.on").forEach((x) => x.classList.remove("on"));
  };
  const focus = (i) => {
    clear();
    svg.classList.add("kg-focus");
    const nodeEls = svg.querySelectorAll(".kg-node");
    const edgeEls = svg.querySelectorAll(".kg-edge");
    nodeEls[i].classList.add("on");
    nb[i].forEach((ei) => {
      edgeEls[ei].classList.add("on");
      const e = edges[ei];
      nodeEls[e.source === i ? e.target : e.source].classList.add("on");
    });
  };
  svg.querySelectorAll(".kg-node").forEach((el) => {
    const i = Number(el.dataset.i);
    el.addEventListener("mouseenter", () => focus(i));
    el.addEventListener("focus", () => focus(i));
    el.addEventListener("mouseleave", clear);
    el.addEventListener("blur", clear);
    const go = () => {
      // 뉴스 탭으로 이동해 그 키워드로 검색 — 관계망에서 본 단어의 실제 기사를 바로 확인
      const q = el.dataset.kw || "";
      const input = $("#search");
      if (input) input.value = q;
      state.query = q.toLowerCase();   // filteredNews()가 소문자 기준으로 비교한다
      state.page = 1;
      selectTab("news");
      renderNews();
      scrollNewsTop();
    };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); }
    });
  });

  const meta = $("#keyword-cloud-meta");
  if (meta) {
    const ms = kw.months || [];
    const range = ms.length ? (ms.length > 1 ? `${monthLabel(ms[0])}~${monthLabel(ms[ms.length - 1])}` : monthLabel(ms[0])) : "";
    meta.textContent = `${range} 요약 ${kw.docs || 0}건에서 추출 · 원 크기 = 언급된 보도자료 수 · ` +
      `색 = 주로 걸린 주제 · 선 = 같은 보도자료에 함께 등장(굵을수록 관계 강함) · ` +
      `노드에 올리면 관계된 키워드만 표시, 클릭하면 해당 키워드로 뉴스 검색`;
  }
}

function renderDashboard2() {
  if (!state.topics) return;
  renderTrendOverall();
  renderTrendGrid();
  renderKeywordGraph();
  renderTrendAgencies();
}

init();
