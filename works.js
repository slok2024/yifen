export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ==========================================
    // 路由 1: API - 获取基础元数据 (物理年份和科目列表)
    // ==========================================
    if (url.pathname === "/api/meta") {
      try {
        const yearsResult = await env.shandong_yifen.prepare(
          "SELECT DISTINCT year FROM score_sections ORDER BY year DESC"
        ).all();
        const yearsList = yearsResult.results.map(r => r.year);

        const sampleResult = await env.shandong_yifen.prepare(
          "SELECT * FROM score_sections LIMIT 1"
        ).all();
        
        let subjects = ["全体"];
        if (sampleResult.results.length > 0) {
          const columns = Object.keys(sampleResult.results[0]);
          let subSet = new Set();
          columns.forEach(c => {
            if (c.includes("_本段")) subSet.add(c.split("_")[0].trim());
          });
          if (subSet.size > 0) subjects = Array.from(subSet);
        }

        return new Response(JSON.stringify({ yearsList, subjects }), {
          headers: { "Content-Type": "application/json;charset=UTF-8" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // ==========================================
    // 路由 2: API - 区间对比检索
    // ==========================================
    if (url.pathname === "/api/query") {
      try {
        const params = url.searchParams;
        const years = params.get("years").split(",").map(Number);
        const subject = params.get("subject");
        const mode = params.get("mode");
        const minVal = parseInt(params.get("min"));
        const maxVal = parseInt(params.get("max"));

        // 【已修复】动态兼容“全体”与其他科目的数据库列名后缀
        const numCol = subject === "全体" ? "全体_本段" : `${subject}_本段人数`;
        const accCol = subject === "全体" ? "全体_累计" : `${subject}_累计人数`;

        let finalMinScore = 750;
        let finalMaxScore = 0;

        if (mode === 'rank') {
          for (const y of years) {
            const resMin = await env.shandong_yifen.prepare(
              `SELECT score FROM score_sections WHERE year = ? AND \`${accCol}\` >= ? ORDER BY \`${accCol}\` ASC LIMIT 1`
            ).bind(y, minVal).first("score");
            
            const resMax = await env.shandong_yifen.prepare(
              `SELECT score FROM score_sections WHERE year = ? AND \`${accCol}\` <= ? ORDER BY \`${accCol}\` DESC LIMIT 1`
            ).bind(y, maxVal).first("score");

            if (resMin !== null) finalMinScore = Math.min(finalMinScore, resMin);
            if (resMax !== null) finalMaxScore = Math.max(finalMaxScore, resMax);
          }
          if (finalMinScore > finalMaxScore) {
            let tmp = finalMinScore; finalMinScore = finalMaxScore; finalMaxScore = tmp;
          }
        } else {
          finalMinScore = minVal;
          finalMaxScore = maxVal;
        }

        let rows = [];
        for (const y of years) {
          const res = await env.shandong_yifen.prepare(
            `SELECT year, score, \`${numCol}\` as num, \`${accCol}\` as acc FROM score_sections WHERE year = ? AND score BETWEEN ? AND ?`
          ).bind(y, finalMinScore, finalMaxScore).all();
          rows.push(...res.results);
        }

        return new Response(JSON.stringify({ finalMinScore, finalMaxScore, rows }), {
          headers: { "Content-Type": "application/json;charset=UTF-8" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // ==========================================
    // 路由 3: API - 跨年双向等值换算
    // ==========================================
    if (url.pathname === "/api/convert") {
      try {
        const params = url.searchParams;
        const subject = params.get("subject");
        const baseYear = parseInt(params.get("baseYear"));
        const cType = params.get("cType");
        const inputVal = parseInt(params.get("inputVal"));
        const targetYears = params.get("targetYears").split(",").map(Number);

        // 【已修复】动态兼容“全体”与其他科目的数据库列名后缀
        const accCol = subject === "全体" ? "全体_累计" : `${subject}_累计人数`;

        const bTotal = await env.shandong_yifen.prepare(`SELECT MAX(\`${accCol}\`) as m FROM score_sections WHERE year = ?`).bind(baseYear).first("m") || 1;
        
        let bRank = 0;
        let approxScore = 0;

        if (cType === 'score') {
          bRank = await env.shandong_yifen.prepare(`SELECT \`${accCol}\` FROM score_sections WHERE year = ? AND score = ?`).bind(baseYear, inputVal).first(accCol);
          approxScore = inputVal;
          if (bRank === null) throw new Error("基准年未查到该分数对应名次");
        } else {
          bRank = inputVal;
          approxScore = await env.shandong_yifen.prepare(`SELECT score FROM score_sections WHERE year = ? AND \`${accCol}\` >= ? ORDER BY \`${accCol}\` ASC LIMIT 1`).bind(baseYear, bRank).first("score") || 0;
        }

        let conversions = [];
        for (const tYear of targetYears) {
          const tTotal = await env.shandong_yifen.prepare(`SELECT MAX(\`${accCol}\`) as m FROM score_sections WHERE year = ?`).bind(tYear).first("m") || 1;
          const tRank = Math.round(bRank * (tTotal / bTotal));
          
          const tScore = await env.shandong_yifen.prepare(`SELECT score FROM score_sections WHERE year = ? AND \`${accCol}\` >= ? ORDER BY \`${accCol}\` ASC LIMIT 1`).bind(tYear, tRank).first("score") || 0;

          conversions.push({ tYear, tRank, tScore });
        }

        return new Response(JSON.stringify({ bRank, approxScore, conversions }), {
          headers: { "Content-Type": "application/json;charset=UTF-8" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // ==========================================
    // 路由 4: 渲染前端 UI 界面
    // ==========================================
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>山东高考一分一段检索与跨年双向换算系统</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: 'Microsoft YaHei', sans-serif; background-color: #f4f7f6; padding: 20px; }
        .card { border-radius: 8px; border: none; box-shadow: 0 4px 12px rgba(0,0,0,0.05); margin-bottom: 20px; }
        .nav-tabs .nav-link.active { color: #3182ce; border-bottom: 3px solid #3182ce; background: transparent; font-weight: bold; }
        .tab-content { background: white; padding: 20px; border-radius: 0 0 8px 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); min-height: 450px; }
        .table-container { max-height: 500px; overflow-y: auto; }
        .sticky-thead th { position: sticky; top: 0; background-color: #2d3748; color: white; z-index: 10; }
        .chart-container { position: relative; height: 450px; width: 100%; margin-bottom: 15px; }
        
        .dropdown-multiselect { position: relative; width: 100%; }
        .dropdown-toggle-custom { background: #fff; border: 1px solid #dee2e6; border-radius: 6px; padding: 6px 12px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; min-height: 38px; }
        .dropdown-toggle-custom::after { content: ""; border-top: 0.3em solid; border-right: 0.3em solid transparent; border-bottom: 0; border-left: 0.3em solid transparent; display: inline-block; margin-left: 0.255em; vertical-align: 0.255em; }
        .dropdown-menu-custom { position: absolute; top: 100%; left: 0; z-index: 1000; display: none; min-width: 100%; max-height: 250px; overflow-y: auto; margin: 0.125rem 0 0; background-color: #fff; border: 1px solid rgba(0,0,0,.15); border-radius: 0.25rem; box-shadow: 0 6px 12px rgba(0,0,0,0.1); padding: 8px 12px; }
        .dropdown-menu-custom.show { display: block; }
        .dropdown-item-checkbox { display: flex; align-items: center; padding: 4px 8px; border-radius: 4px; }
        .dropdown-item-checkbox:hover { background-color: #f8f9fa; }
        .dropdown-item-checkbox input { margin-right: 8px; cursor: pointer; }
        .dropdown-item-checkbox label { cursor: pointer; width: 100%; margin-bottom: 0; }
    </style>
</head>
<body>
<div class="container-fluid" style="max-width: 1300px; margin: 0 auto;">
    <div class="d-flex align-items-center justify-content-between mb-4 border-bottom pb-3">
        <div>
            <h3 class="text-primary fw-bold mb-1">📊 山东高考一分一段检索与跨年双向换算系统</h3>
            <p class="text-muted mb-0">PRO双向全能版：Cloudflare D1 驱动云端实时处理</p>
        </div>
        <div><span id="engine-status" class="badge bg-secondary p-2 fs-6">D1 数据库连接中...</span></div>
    </div>

    <ul class="nav nav-tabs border-bottom-0" id="mainTab" role="tablist">
        <li class="nav-item"><button class="nav-link active" id="query-tab" data-bs-toggle="tab" data-bs-target="#query-panel">🔍 多年区间检索与横向图表</button></li>
        <li class="nav-item"><button class="nav-link" id="convert-tab" data-bs-toggle="tab" data-bs-target="#convert-panel">🔄 跨年份分/位同值双向换算</button></li>
    </ul>

    <div class="tab-content">
        <!-- 面板一：区间检索与图形化 -->
        <div class="tab-pane fade show active" id="query-panel">
            <div class="row mb-3 g-3">
                <div class="col-md-3">
                    <label class="form-label fw-bold">选择年份</label>
                    <div class="dropdown-multiselect">
                        <div class="dropdown-toggle-custom fw-bold" id="query-year-toggle" onclick="toggleDropdown('query-year-menu')">加载年份中...</div>
                        <div class="dropdown-menu-custom" id="query-year-menu"></div>
                    </div>
                </div>
                <div class="col-md-2"><label class="form-label fw-bold">选择科目</label><select id="query-subject" class="form-select text-primary fw-bold"></select></div>
                <div class="col-md-2">
                    <label class="form-label fw-bold">检索模式</label>
                    <select id="query-mode" class="form-select" onchange="switchQueryModeLabels()">
                        <option value="score">按【分数】区间</option>
                        <option value="rank">按【位次】区间</option>
                    </select>
                </div>
                <div class="col-md-2"><label class="form-label fw-bold" id="lbl-query-min">分值最小值</label><input type="number" id="query-min" class="form-control" value="550"></div>
                <div class="col-md-3"><label class="form-label fw-bold" id="lbl-query-max">分值最大值</label><input type="number" id="query-max" class="form-control" value="600"></div>
            </div>
            
            <div class="mb-4">
                <button class="btn btn-primary px-4 fw-bold" onclick="executeSearch()">⚡ 执行区间对比</button>
                <button class="btn btn-outline-success ms-2 fw-bold" onclick="exportToExcel('result-table', '高考区间多年度对比数据')">📤 导出数据</button>
            </div>

            <div class="card p-3 mb-4 d-none" id="chart-card">
                <div class="d-flex flex-wrap justify-content-between align-items-center mb-3 border-bottom pb-2 gap-2">
                    <h5 class="fw-bold mb-0">📈 多年数据可视化横向对比图</h5>
                    <div class="d-flex flex-wrap gap-3 align-items-center">
                        <div>
                            <span class="text-muted small me-2">数据过滤:</span>
                            <input type="radio" class="btn-check" name="queryDataType" id="qd-acc" value="acc" checked onchange="updateQueryChart()">
                            <label class="btn btn-sm btn-outline-secondary" for="qd-acc">累计位次</label>
                            <input type="radio" class="btn-check" name="queryDataType" id="qd-num" value="num" onchange="updateQueryChart()">
                            <label class="btn btn-sm btn-outline-secondary" for="qd-num">本段人数</label>
                        </div>
                        <div class="border-start ps-3">
                            <span class="text-muted small me-2">图表类型:</span>
                            <select id="queryChartSelector" class="form-select form-select-sm d-inline-block w-auto" onchange="updateQueryChart()">
                                <option value="line">📈 折线图</option>
                                <option value="bar">📊 柱状图</option>
                                <option value="horizontalBar">📋 条形图</option>
                                <option value="area">⛰️ 面积图</option>
                                <option value="radar">🕸️ 雷达图</option>
                                <option value="pie">🍕 饼图 (限本段人数)</option>
                            </select>
                        </div>
                    </div>
                </div>
                <div class="chart-container"><canvas id="trendChart"></canvas></div>
            </div>

            <div class="table-container border rounded">
                <table class="table table-bordered table-striped table-hover mb-0" id="result-table">
                    <thead class="sticky-thead" id="table-thead"><tr><th>高考分数</th><th class="text-muted">请选择条件执行检索</th></tr></thead>
                    <tbody id="table-tbody"><tr><td colspan="10" class="text-center text-muted py-4">等待数据加载...</td></tr></tbody>
                </table>
            </div>
        </div>

        <!-- 面板二：精准双向换算 -->
        <div class="tab-pane fade" id="convert-panel">
            <div class="row g-3 bg-light p-3 rounded border mb-4">
                <div class="col-md-2"><label class="form-label fw-bold">换算科目</label><select id="convert-subject" class="form-select text-primary fw-bold"></select></div>
                <div class="col-md-2"><label class="form-label fw-bold">基准年份 (源)</label><select id="convert-base" class="form-select" onchange="filterConvertTargetYears()"></select></div>
                <div class="col-md-2">
                    <label class="form-label fw-bold">基准输入类型</label>
                    <select id="convert-type" class="form-select bg-white text-success fw-bold" onchange="switchConvertPlaceholder()">
                        <option value="score">输入【分数】</option>
                        <option value="rank">输入【位次/名次】</option>
                    </select>
                </div>
                <div class="col-md-2"><label class="form-label fw-bold" id="lbl-convert-input">输入分值</label><input type="number" id="convert-input" class="form-control" value="589"></div>
                <div class="col-md-4">
                    <label class="form-label fw-bold">目标对比年份（下拉多选）</label>
                    <div class="dropdown-multiselect">
                        <div class="dropdown-toggle-custom fw-bold" id="convert-year-toggle" onclick="toggleDropdown('convert-year-menu')">等待选择基准年...</div>
                        <div class="dropdown-menu-custom" id="convert-year-menu"></div>
                    </div>
                </div>
            </div>

            <div class="mb-4">
                <button class="btn btn-success px-4 fw-bold" onclick="executeConvert()">🔮 计算跨年同值分/位</button>
                <button class="btn btn-outline-success ms-2 fw-bold" onclick="exportToExcel('convert-table', '双向名次分数跨年换算表')">📤 导出数据</button>
            </div>

            <div class="card p-3 mb-4 d-none" id="convert-chart-card">
                <div class="d-flex flex-wrap justify-content-between align-items-center mb-3 border-bottom pb-2 gap-2">
                    <h5 class="fw-bold mb-0" id="convert-chart-title">📊 各年份换算对比图</h5>
                    <div class="d-flex gap-3 align-items-center">
                        <div>
                            <input type="radio" class="btn-check" name="convertChartType" id="cc-score" value="score" checked onchange="updateConvertChart()">
                            <label class="btn btn-sm btn-outline-success" for="cc-score">对应等值分视角</label>
                            <input type="radio" class="btn-check" name="convertChartType" id="cc-rank" value="rank" onchange="updateConvertChart()">
                            <label class="btn btn-sm btn-outline-success" for="cc-rank">映射位次视角</label>
                        </div>
                        <div class="border-start ps-3">
                            <select id="convertChartSelector" class="form-select form-select-sm d-inline-block w-auto" onchange="updateConvertChart()">
                                <option value="bar">📊 柱状图</option>
                                <option value="horizontalBar">📋 条形图</option>
                                <option value="line">📈 折线图</option>
                                <option value="radar">🕸️ 雷达图</option>
                                <option value="polarArea">🔘 极地图</option>
                            </select>
                        </div>
                    </div>
                </div>
                <div class="chart-container"><canvas id="convertChart"></canvas></div>
            </div>

            <div class="table-container border rounded">
                <table class="table table-bordered table-striped table-hover mb-0" id="convert-table">
                    <thead class="sticky-thead">
                        <tr style="background-color: #2c5282; color: white;">
                            <th class="text-center">目标年份</th>
                            <th class="text-center">换算科目</th>
                            <th class="text-center">基准年参考(分数/位次)</th>
                            <th class="text-center">比例换算后目标位次</th>
                            <th class="text-center bg-success text-white fw-bold">最终对应等值分数</th>
                        </tr>
                    </thead>
                    <tbody id="convert-tbody">
                        <tr><td colspan="5" class="text-center text-muted py-4">暂无换算数据，请选择条件点击计算</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</div>

<script>
let yearsList = [];
let chartInstance = null; let convertChartInstance = null;
let lastSearchData = null; let lastConvertData = null;

document.addEventListener('click', function(e) {
    if(!e.target.closest('.dropdown-multiselect')) {
        document.querySelectorAll('.dropdown-menu-custom').forEach(function(m) { m.classList.remove('show'); });
    }
});

function toggleDropdown(id) {
    document.querySelectorAll('.dropdown-menu-custom').forEach(function(m) { if(m.id !== id) m.classList.remove('show'); });
    document.getElementById(id).classList.toggle('show');
}

function switchQueryModeLabels() {
    const isRank = document.getElementById('query-mode').value === 'rank';
    document.getElementById('lbl-query-min').innerText = isRank ? "位次最小值(名)" : "分值最小值";
    document.getElementById('lbl-query-max').innerText = isRank ? "位次最大值(名)" : "分值最大值";
    if(isRank) {
        document.getElementById('query-min').value = 10000;
        document.getElementById('query-max').value = 30000;
    } else {
        document.getElementById('query-min').value = 550;
        document.getElementById('query-max').value = 600;
    }
}

function switchConvertPlaceholder() {
    const type = document.getElementById('convert-type').value;
    document.getElementById('lbl-convert-input').innerText = type === 'rank' ? "输入目标位次(名)" : "输入分值";
    document.getElementById('convert-input').value = type === 'rank' ? 25000 : 589;
}

window.onload = async function() {
    try {
        const response = await fetch('/api/meta');
        const meta = await response.json();
        
        if (meta.error) throw new Error(meta.error);

        yearsList = meta.yearsList;
        const subjects = meta.subjects;

        document.getElementById('engine-status').className = "badge bg-success text-white fs-6 p-2";
        document.getElementById('engine-status').innerText = "云端 D1 已就绪";

        const queryMenu = document.getElementById('query-year-menu');
        queryMenu.innerHTML = '';
        yearsList.forEach((y, idx) => {
            let checkedStr = idx < 3 ? 'checked' : ''; 
            let div = document.createElement('div');
            div.className = 'dropdown-item-checkbox';
            div.innerHTML = '<input type="checkbox" class="year-chk" value="' + y + '" id="q-chk-' + y + '" ' + checkedStr + ' onchange="updateQueryToggleText()">' +
                             '<label for="q-chk-' + y + '">' + y + '年</label>';
            queryMenu.appendChild(div);
        });
        updateQueryToggleText();

        const qS = document.getElementById('query-subject');
        const cS = document.getElementById('convert-subject'); 
        const cB = document.getElementById('convert-base');
        qS.innerHTML=''; cS.innerHTML=''; cB.innerHTML='';
        subjects.forEach(s => { qS.add(new Option(s, s)); cS.add(new Option(s, s)); });
        yearsList.forEach(y => { cB.add(new Option(y+" 年", y)); });
        if (subjects.includes("全体")) { qS.value = "全体"; cS.value = "全体"; }
        filterConvertTargetYears();

    } catch (e) { 
        document.getElementById('engine-status').className = "badge bg-danger text-white fs-6 p-2";
        document.getElementById('engine-status').innerText = "数据库元数据获取失败";
        alert("初始化失败，请检查 Cloudflare D1 绑定是否正确: " + e.message); 
    }
};

function updateQueryToggleText() {
    let checkedBoxes = document.querySelectorAll('.year-chk:checked');
    let toggleBtn = document.getElementById('query-year-toggle');
    if(checkedBoxes.length === 0) { toggleBtn.innerText = "请选择年份"; } 
    else {
        let text = Array.from(checkedBoxes).map(cb => cb.value + "年").join(', ');
        toggleBtn.innerText = text.length > 25 ? "已选 " + checkedBoxes.length + " 个年份" : text;
    }
}

function filterConvertTargetYears() {
    const baseYear = parseInt(document.getElementById('convert-base').value);
    const convertMenu = document.getElementById('convert-year-menu'); convertMenu.innerHTML = '';
    yearsList.forEach(y => {
        if(y === baseYear) return;
        let div = document.createElement('div');
        div.className = 'dropdown-item-checkbox';
        div.innerHTML = '<input type="checkbox" class="convert-target-chk" value="' + y + '" id="c-chk-' + y + '" checked onchange="updateConvertToggleText()">' +
                         '<label for="c-chk-' + y + '">' + y + '年</label>';
        convertMenu.appendChild(div);
    });
    updateConvertToggleText();
}

function updateConvertToggleText() {
    let checkedBoxes = document.querySelectorAll('.convert-target-chk:checked');
    let toggleBtn = document.getElementById('convert-year-toggle');
    if(checkedBoxes.length === 0) { toggleBtn.innerText = "请选择目标年份"; } 
    else {
        let text = Array.from(checkedBoxes).map(cb => cb.value + "年").join(', ');
        toggleBtn.innerText = text.length > 25 ? "已选 " + checkedBoxes.length + " 个年份" : text;
    }
}

async function executeSearch() {
    let checkedYearBoxes = document.querySelectorAll('.year-chk:checked');
    if(checkedYearBoxes.length === 0) return alert("请勾选有效年份！");
    let selectedYears = Array.from(checkedYearBoxes).map(cb => parseInt(cb.value)).sort((a,b) => b-a);
    
    const sub = document.getElementById('query-subject').value;
    const mode = document.getElementById('query-mode').value;
    let valMin = parseInt(document.getElementById('query-min').value) || 0;
    let valMax = parseInt(document.getElementById('query-max').value) || 0;

    document.getElementById('table-tbody').innerHTML = '<tr><td colspan="10" class="text-center py-4"><div class="spinner-border text-primary" role="status"></div> 云端计算中...</td></tr>';

    try {
        const res = await fetch("/api/query?years=" + selectedYears.join(',') + "&subject=" + encodeURIComponent(sub) + "&mode=" + mode + "&min=" + valMin + "&max=" + valMax);
        const data = await res.json();
        if(data.error) throw new Error(data.error);

        const finalMinScore = data.finalMinScore;
        const finalMaxScore = data.finalMaxScore;
        const rows = data.rows;

        const thead = document.getElementById('table-thead');
        let headHtml = '<tr><th rowspan="2" class="align-middle text-center" style="background-color:#2d3748; color:white;">分数</th>';
        selectedYears.forEach(y => { headHtml += '<th colspan="2" class="text-center" style="background-color:#1a365d; color:white;">' + y + '年 (' + sub + ')</th>'; });
        headHtml += '</tr><tr>';
        selectedYears.forEach(y => { headHtml += '<th style="background-color:#2c5282;color:white;font-size:12px;">本段</th><th style="background-color:#9b2c2c;color:white;font-size:12px;">累计位次</th>'; });
        thead.innerHTML = headHtml + "</tr>";

        let bigDataMap = {};
        for(let s = finalMaxScore; s >= finalMinScore; s--) {
            bigDataMap[s] = {}; selectedYears.forEach(y => { bigDataMap[s][y] = { num: 0, acc: 0 }; });
        }

        rows.forEach(row => {
            if(bigDataMap[row.score] && bigDataMap[row.score][row.year]) {
                bigDataMap[row.score][row.year] = { num: row.num, acc: row.acc };
            }
        });

        const tbody = document.getElementById('table-tbody'); tbody.innerHTML = '';
        let scoresLabels = []; 
        let chartDatasetsAcc = {}; let chartDatasetsNum = {}; 
        selectedYears.forEach(y => { chartDatasetsAcc[y] = []; chartDatasetsNum[y] = []; });

        for(let s = finalMaxScore; s >= finalMinScore; s--) {
            scoresLabels.push(s + "分");
            let tr = document.createElement('tr');
            let rHtml = '<td class="text-center fw-bold bg-light">' + s + '</td>';
            selectedYears.forEach(y => {
                let n = bigDataMap[s][y].num; let a = bigDataMap[s][y].acc;
                chartDatasetsAcc[y].push(a > 0 ? a : null);
                chartDatasetsNum[y].push(n > 0 ? n : 0);
                rHtml += '<td class="text-center">' + (n>0?n:'-') + '</td><td class="text-center text-danger fw-bold">' + (a>0?a:'-') + '</td>';
            });
            tr.innerHTML = rHtml; tbody.appendChild(tr);
        }
        scoresLabels.reverse(); 
        selectedYears.forEach(y => { chartDatasetsAcc[y].reverse(); chartDatasetsNum[y].reverse(); });
        
        lastSearchData = { selectedYears, scoresLabels, chartDatasetsAcc, chartDatasetsNum };
        document.getElementById('chart-card').classList.remove('d-none');
        updateQueryChart();
    } catch (err) {
        alert("查询失败：" + err.message);
    }
}

function updateQueryChart() {
    if(!lastSearchData) return;
    let selectedType = document.getElementById('queryChartSelector').value;
    let filterType = document.querySelector('input[name="queryDataType"]:checked').value;
    
    const ctx = document.getElementById('trendChart').getContext('2d');
    if(chartInstance) chartInstance.destroy();
    
    let colors = ['#3182ce', '#e53e3e', '#38a169', '#d69e2e', '#805ad5'];
    let isAcc = (filterType === 'acc');
    
    if(selectedType === 'pie' && isAcc) {
        alert("📊 提示：累计位次不适合做饼图展示，已自动切换为【本段人数】展示饼图！");
        document.getElementById('qd-num').checked = true;
        filterType = 'num'; isAcc = false;
    }

    let chartType = selectedType;
    let optionsExtra = {};
    
    if(selectedType === 'horizontalBar') {
        chartType = 'bar';
        optionsExtra = { indexAxis: 'y' };
    } else if(selectedType === 'area') {
        chartType = 'line';
    }

    let datasets = [];

    if(selectedType === 'pie') {
        let pieData = lastSearchData.selectedYears.map(y => lastSearchData.chartDatasetsNum[y].reduce((a,b)=>a+b, 0));
        datasets.push({
            label: '区间段总人数占比',
            data: pieData,
            backgroundColor: colors.slice(0, lastSearchData.selectedYears.length)
        });
        chartInstance = new Chart(ctx, {
            type: 'pie',
            data: { labels: lastSearchData.selectedYears.map(y=>y+"年"), datasets: datasets },
            options: { responsive: true, maintainAspectRatio: false }
        });
        return;
    }

    datasets = lastSearchData.selectedYears.map((y, i) => {
        let rawData = isAcc ? lastSearchData.chartDatasetsAcc[y] : lastSearchData.chartDatasetsNum[y];
        return {
            label: y + "年" + (isAcc ? "累计位次" : "本段人数"), 
            data: rawData,
            borderColor: colors[i % colors.length], 
            backgroundColor: (selectedType === 'area' || selectedType === 'radar') ? colors[i % colors.length] + '30' : (chartType === 'bar' ? colors[i % colors.length] + 'cc' : 'transparent'), 
            fill: selectedType === 'area',
            borderWidth: 2, 
            tension: 0.15
        };
    });
    
    let axisOptions = {
        y: { reverse: isAcc && selectedType !== 'radar' && selectedType !== 'horizontalBar' },
        x: { reverse: false }
    };
    
    if(selectedType === 'horizontalBar') {
        axisOptions = { x: { reverse: isAcc }, y: {} };
    }

    chartInstance = new Chart(ctx, {
        type: chartType, 
        data: { labels: lastSearchData.scoresLabels, datasets: datasets },
        options: Object.assign({ 
            responsive: true, 
            maintainAspectRatio: false, 
            scales: (selectedType === 'radar') ? {} : axisOptions
        }, optionsExtra)
    });
}

async function executeConvert() {
    const sub = document.getElementById('convert-subject').value;
    const baseYear = document.getElementById('convert-base').value;
    const cType = document.getElementById('convert-type').value;
    const inputVal = document.getElementById('convert-input').value;

    let checkedTargetBoxes = document.querySelectorAll('.convert-target-chk:checked');
    if(checkedTargetBoxes.length === 0) return alert("请勾选目标年份！");
    let targetYears = Array.from(checkedTargetBoxes).map(cb => parseInt(cb.value)).sort((a,b) => b-a);

    const tbody = document.getElementById('convert-tbody'); 
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4"><div class="spinner-border text-success" role="status"></div> 云端科学换算中...</td></tr>';

    try {
        const res = await fetch("/api/convert?subject=" + encodeURIComponent(sub) + "&baseYear=" + baseYear + "&cType=" + cType + "&inputVal=" + inputVal + "&targetYears=" + targetYears.join(','));
        const data = await res.json();
        
        if (data.error) throw new Error(data.error);

        tbody.innerHTML = '';
        let baseReferenceText = cType === 'score' ? inputVal + " 分 (对应第 " + data.bRank + " 名)" : "第 " + inputVal + " 名 (约 " + data.approxScore + " 分)";

        let chartLabels = []; let chartScores = []; let chartRanks = [];

        data.conversions.forEach(item => {
            chartLabels.push(item.tYear + "年");
            chartScores.push(item.tScore);
            chartRanks.push(item.tRank);

            let tr = document.createElement('tr');
            tr.innerHTML = '<td class="text-center fw-bold">' + item.tYear + ' 年</td>' +
                '<td class="text-center">' + sub + '</td>' +
                '<td class="text-center text-muted">' + baseReferenceText + '</td>' +
                '<td class="text-center text-secondary">等值映射至第 <b>' + item.tRank + '</b> 名</td>' +
                '<td class="text-center text-success fw-bold fs-5 bg-light">' + item.tScore + ' 分</td>';
            tbody.appendChild(tr);
        });

        lastConvertData = { chartLabels, chartScores, chartRanks, baseYear, cType, inputVal };
        document.getElementById('convert-chart-card').classList.remove('d-none');
        updateConvertChart();

    } catch(e) { 
        alert("换算出现错误: " + e.message); 
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger py-4">换算失败</td></tr>';
    }
}

function updateConvertChart() {
    if(!lastConvertData) return;
    let chartView = document.querySelector('input[name="convertChartType"]:checked').value;
    let selectedVisual = document.getElementById('convertChartSelector').value;
    
    const ctxConvert = document.getElementById('convertChart').getContext('2d');
    if(convertChartInstance) convertChartInstance.destroy();

    document.getElementById('convert-chart-title').innerText = "📊 各年份换算对比（基准：" + lastConvertData.baseYear + "年 " + (lastConvertData.cType==='score'?lastConvertData.inputVal+'分':lastConvertData.inputVal+'位') + "）";
    
    let isScoreView = (chartView === 'score');
    let targetData = isScoreView ? lastConvertData.chartScores : lastConvertData.chartRanks;

    let chartType = selectedVisual;
    let extraOpts = {};

    if(selectedVisual === 'horizontalBar') {
        chartType = 'bar';
        extraOpts = { indexAxis: 'y' };
    }

    convertChartInstance = new Chart(ctxConvert, {
        type: chartType,
        data: {
            labels: lastConvertData.chartLabels,
            datasets: [{ 
                label: isScoreView ? '等值分数 (分)' : '映射位次 (名)', 
                data: targetData, 
                backgroundColor: isScoreView ? 'rgba(56, 161, 105, 0.6)' : 'rgba(49, 130, 206, 0.6)', 
                borderColor: isScoreView ? '#38a169' : '#3182ce', 
                fill: true,
                borderWidth: 2 
            }]
        },
        options: Object.assign({
            responsive: true, maintainAspectRatio: false,
            scales: (chartType === 'radar' || chartType === 'polarArea') ? {} : { 
                y: { 
                    reverse: !isScoreView && selectedVisual !== 'horizontalBar',
                    min: (isScoreView && selectedVisual !== 'horizontalBar') ? Math.max(0, Math.min(...targetData) - 10) : undefined,
                    max: (isScoreView && selectedVisual !== 'horizontalBar') ? Math.min(750, Math.max(...targetData) + 10) : undefined
                },
                x: { reverse: !isScoreView && selectedVisual === 'horizontalBar' }
            }
        }, extraOpts)
    });
}

function exportToExcel(tableId, filename) {
    let table = document.getElementById(tableId);
    let wb = XLSX.utils.table_to_book(table, { sheet: "数据" });
    XLSX.writeFile(wb, filename + ".xlsx");
}
</script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};