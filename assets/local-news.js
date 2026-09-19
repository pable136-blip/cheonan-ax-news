/* 일반 언론 뉴스는 AX 보도자료 데이터와 독립적으로 표시한다. */
(() => {
  const root = document.getElementById('tab-local-news');
  const $ = s => root.querySelector(s);
  const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let doc, limit = 50, read;
  try { read = new Set(JSON.parse(localStorage.getItem('cheonan-local-read') || '[]')); } catch { read = new Set(); }
  const day = date => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Seoul'}).format(date);
  function mark(id) {
    read.add(id);
    try { localStorage.setItem('cheonan-local-read', JSON.stringify([...read].slice(-5000))); } catch {}
  }
  function render() {
    const query = $('#ln-query').value.trim().toLowerCase();
    const today = day(new Date()), days = Number($('#ln-days').value);
    const start = day(new Date(Date.now() - (days-1)*86400000));
    const rows = doc.articles.filter(r => r.published.slice(0,10) >= start && r.published.slice(0,10) <= today &&
      (!$('#ln-paper').value || r.source === $('#ln-paper').value) &&
      (!$('#ln-topic').value || r.topic === $('#ln-topic').value) &&
      (!$('#ln-unread').checked || !read.has(r.id)) && (r.title+' '+r.source).toLowerCase().includes(query));
    $('#ln-summary').textContent = `${days === 1 ? '오늘' : `최근 ${days}일`} ${rows.length}건 · 미확인 ${rows.filter(r=>!read.has(r.id)).length}건`;
    $('#ln-list').innerHTML = rows.slice(0,limit).map(r => `<article class="ln-row ${read.has(r.id)?'read':''}"><div><strong>${escape(r.source)}</strong><br><small>${escape(r.group)}</small></div><div><h3><a href="${/^https?:\/\//i.test(r.url)?escape(r.url):'#'}" target="_blank" rel="noopener noreferrer" data-id="${escape(r.id)}">${escape(r.title)} ↗</a></h3><small>${escape(r.published.slice(0,16).replace('T',' '))} · ${escape(r.topic)} · 검색 경유 원문</small></div><button data-read="${escape(r.id)}">${read.has(r.id)?'읽음':'읽음 표시'}</button></article>`).join('') || '<p class="ln-empty">선택한 조건의 수집 기사가 없습니다. 기간을 넓히거나 다음 검색에서 확인해 주세요.</p>';
    $('#ln-more').hidden = rows.length <= limit;
  }
  root.addEventListener('click', e => {
    const a = e.target.closest('[data-id]'), b = e.target.closest('[data-read]');
    if (a) { mark(a.dataset.id); a.closest('article').classList.add('read'); }
    if (b) { mark(b.dataset.read); render(); }
  });
  root.querySelectorAll('input,select').forEach(e => e.addEventListener('input',()=>{limit=50;if(doc)render();}));
  $('#ln-more').onclick = () => {limit+=50;render();};
  fetch('data/local-news.json').then(r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{
    doc=data;
    const names = [...new Set([...doc.sources.filter(s=>s.name!=='전체 매체 검색').map(s=>s.name),...doc.articles.map(r=>r.source)])];
    names.forEach(name=>{const o=document.createElement('option');o.value=name;o.textContent=name;$('#ln-paper').append(o);});
    $('#ln-updated').textContent = `수집 시도: ${doc.updated.slice(0,16).replace('T',' ')} (한국시간)`;
    $('#ln-status').innerHTML = doc.sources.map(s=>`<li>${escape(s.name)} · ${s.status==='error'?'수집 실패 (이전 기사 유지)':`${s.count}건 검색됨`} · <a target="_blank" rel="noopener noreferrer" href="https://search.daum.net/search?w=news&amp;q=${encodeURIComponent('천안 '+ (s.name==='전체 매체 검색'?'':s.name))}">다음 확인 ↗</a></li>`).join('');
    if(Date.now()-Date.parse(doc.updated)>36*3600000) $('#ln-updated').textContent += ' · 갱신이 지연되고 있습니다';
    render();
  }).catch(()=>{$('#ln-list').innerHTML='<p class="ln-empty">뉴스 데이터를 불러오지 못했습니다. 잠시 후 다시 열거나 다음 검색을 이용해 주세요.</p>';});
})();
