---
components:
  htmlEmbed:
    kind: html-embed
    title: 一次查询的缓存命中层级
    height: 320px
    source: 内联示例（自包含 HTML，零外部请求）
    html: |
      <!doctype html>
      <html lang="zh-CN">
      <head>
      <meta charset="utf-8">
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #2f3242; background: #f7f8fb; }
        .wrap { padding: 14px 16px 12px; }
        .bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
        .hint { color: #5c6273; font-size: 12px; }
        button { border: 1px solid #c9cede; background: #fff; color: #3b4054; border-radius: 8px; padding: 5px 12px; font: inherit; cursor: pointer; }
        button:hover { border-color: #7c72e8; color: #5a4fd8; }
        .row { display: grid; grid-template-columns: 6.5rem 1fr; gap: 10px; align-items: center; margin-bottom: 8px; }
        .row b { font-weight: 600; font-size: 12.5px; }
        .steps { display: flex; gap: 6px; }
        .step { flex: 1; padding: 6px 8px; text-align: center; border: 1px solid #dfe2ec; border-radius: 8px; background: #fff; color: #858b9e; font-size: 12px; transition: all .18s; }
        .step.on { border-color: #7c72e8; background: #eceafd; color: #5a4fd8; font-weight: 600; }
        .foot { margin: 8px 0 0; font-size: 11.5px; color: #858b9e; }
      </style>
      </head>
      <body>
      <div class="wrap">
        <div class="bar">
          <span class="hint">同一次查询在三种策略下的回源深度对比</span>
          <button id="replay" type="button">重放</button>
        </div>
        <div class="row"><b>L1 命中</b><div class="steps" data-row="l1"><span class="step">应用</span><span class="step">本地缓存</span><span class="step">返回</span></div></div>
        <div class="row"><b>L2 命中</b><div class="steps" data-row="l2"><span class="step">应用</span><span class="step">Redis</span><span class="step">返回</span></div></div>
        <div class="row"><b>穿透回源</b><div class="steps" data-row="db"><span class="step">应用</span><span class="step">Redis</span><span class="step">MySQL</span><span class="step">返回</span></div></div>
        <p class="foot">高亮按路径逐格步进：命中层级越浅，链路越短；点「重放」重新播放一遍。</p>
      </div>
      <script>
        var timers = [];
        function play() {
          timers.forEach(clearTimeout);
          timers = [];
          document.querySelectorAll('.step').forEach(function (s) { s.classList.remove('on'); });
          var delay = 0;
          ['l1', 'l2', 'db'].forEach(function (row, i) {
            delay = i * 500;
            document.querySelectorAll('[data-row="' + row + '"] .step').forEach(function (step, j) {
              timers.push(setTimeout(function () { step.classList.add('on'); }, delay + j * 380));
            });
          });
        }
        document.getElementById('replay').addEventListener('click', play);
        play();
      </script>
      </body>
      </html>
---

<at-html-embed data-key="htmlEmbed"></at-html-embed>
