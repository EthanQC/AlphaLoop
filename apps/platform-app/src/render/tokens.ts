/**
 * Theme + structural CSS, copied VERBATIM from
 * docs/superpowers/specs/ui-samples/final.html - the single source of truth
 * for AlphaLoop's visual design. Do not restyle or "improve" any of these
 * strings. If a value here needs to change, the change belongs in
 * final.html first, and these constants get re-copied from it.
 *
 * Split into four pieces so layout.ts (and later route templates) can
 * compose them without re-parsing final.html's <style> block:
 *   - THEME_LIGHT_CSS / THEME_DARK_CSS: the two `:root[data-theme=...]`
 *     variable blocks (every custom property, verbatim values).
 *   - COLOR_SCHEME_CSS: the `prefers-color-scheme`/`color-scheme` glue that
 *     makes native form controls and scrollbars match the active theme.
 *   - STRUCTURAL_CSS: everything else - reset, layout shell, bento grid,
 *     card/pill/tape/tabs rules, and the >=1024px desktop media query.
 */

export const THEME_LIGHT_CSS = `/* ============ 主题 token（定稿：浅色=作战室 C / 暗色=盯盘室终端 A；绿涨红跌） ============ */
:root, :root[data-theme="light"]{
  --bg:#F2F5FA; --card:#FFFFFF; --card2:#F7FAFE; --ink:#12233F; --sub:#5A6B87;
  --accent:#1E40AF; --accent-soft:#EAF0FB; --accent-border:#C8D6F2;
  --amber:#B45309; --amber-bg:#FFF7E8; --amber-border:#F0DFBB;
  --up:#12805C; --up-bg:#E8F3EE; --down:#D5342B;
  --line:#E1E8F2; --tape-bg:#FFFFFF; --nav-bg:#FFFFFFF0; --shadow:0 26px 60px rgba(30,50,90,.14);
  --frame:#D5DDEA; --page:#E7ECF4; --btn2-border:#C9D5EC; --btn2-bg:#FFFFFF;
}`;

export const THEME_DARK_CSS = `:root[data-theme="dark"]{
  --bg:#0A0E1A; --card:#101627; --card2:#151C30; --ink:#E8ECF5; --sub:#98A2BB;
  --accent:#38BDF8; --accent-soft:#12213A; --accent-border:#24304F;
  --amber:#F5B84B; --amber-bg:#1D1A10; --amber-border:#3D3420;
  --up:#34D399; --up-bg:#0E271F; --down:#FF5C5C;
  --line:#1E2740; --tape-bg:#0C1220; --nav-bg:#0C1120E6; --shadow:0 30px 80px rgba(0,0,0,.6);
  --frame:#232B44; --page:#05070D; --btn2-border:#2A3554; --btn2-bg:transparent;
}`;

export const COLOR_SCHEME_CSS = `@media (prefers-color-scheme: dark){
  :root:not([data-theme]){ color-scheme: dark; }
}
:root[data-theme="dark"]{ color-scheme: dark; }`;

export const STRUCTURAL_CSS = `*{box-sizing:border-box;margin:0;padding:0}
html{font-size:16px}
body{background:var(--page);color:var(--ink);font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;line-height:1.6;transition:background .2s ease}
a{color:inherit;text-decoration:none}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:6px}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.u{color:var(--up)} .d{color:var(--down)} .a{color:var(--amber)}
/* ============ 应用框架：移动=底部tab；桌面=左侧导航 ============ */
.app{min-height:100dvh;background:var(--bg);max-width:1440px;margin:0 auto;display:flex}
.sidenav{display:none}
.main{flex:1;min-width:0;padding:0 0 84px}
/* ticker tape（暗色主题签名，浅色下同样保留但弱化） */
.tape{overflow:hidden;border-bottom:1px solid var(--line);background:var(--tape-bg);white-space:nowrap}
.tape-track{display:inline-flex;gap:28px;padding:8px 14px;animation:tape 28s linear infinite;font-size:12.5px}
.tape span{color:var(--sub)} .tape b{font-weight:600;margin-left:6px}
@keyframes tape{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@media (prefers-reduced-motion:reduce){.tape-track{animation:none}}
.topbar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;font-size:12.5px;color:var(--sub);gap:10px}
.topbar b{color:var(--ink);font-size:15px;font-weight:650}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--up);margin-right:6px;box-shadow:0 0 6px var(--up)}
.theme-btn{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:99px;padding:5px 12px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.pill{font-size:10.5px;border-radius:99px;padding:1.5px 8px;font-weight:500;white-space:nowrap}
.pill.ok{background:var(--up-bg);color:var(--up)}
.pill.warn{background:var(--amber-bg);color:var(--amber)}
/* bento */
.bento{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:13px 14px;position:relative}
.w2{grid-column:span 2}
.card h2{font-size:12px;font-weight:600;color:var(--sub);margin-bottom:8px;display:flex;align-items:center;gap:6px}
.card h2 .pill{margin-left:auto}
.ask{display:flex;align-items:center;gap:10px;background:var(--accent-soft);border:1.5px solid var(--accent-border);border-radius:11px;padding:12px 13px;color:var(--sub);font-size:14.5px;cursor:text}
.ask-hint{margin-top:8px;font-size:12px;color:var(--sub)}
.ask-hint a{color:var(--accent)}
.kpirow{display:flex;align-items:flex-end;gap:14px;row-gap:6px;flex-wrap:wrap}
.kpi-main .num{font-size:26px;font-weight:650;line-height:1.05;letter-spacing:-.02em}
.kpi .num{font-size:14px;font-weight:650}
.lbl{font-size:11px;color:var(--sub);margin-top:2px}
.vs{margin-top:8px;font-size:12px;color:var(--sub)}
.vs a{color:var(--accent)}
.statcard{display:flex;flex-direction:column;justify-content:space-between}
.stat-line{display:flex;justify-content:space-between;font-size:12.5px;padding:5px 0;border-bottom:1px dashed var(--line)}
.stat-line:last-child{border-bottom:none}
.stat-line b{font-weight:600}
.card.amber{background:var(--amber-bg);border-color:var(--amber-border)}
.todo{display:flex;justify-content:space-between;align-items:center;gap:10px}
.todo .t1{font-size:14.5px;font-weight:650}
.todo .t2{font-size:12px;color:var(--sub);margin-top:2px}
.todo .go{background:var(--accent);color:#fff;border-radius:9px;font-size:12.5px;padding:8px 13px;white-space:nowrap;font-weight:500}
:root[data-theme="dark"] .todo .go{color:#04263A}
.eta{font-size:11.5px;color:var(--amber)}
.alert{display:flex;gap:8px;font-size:12.5px;padding:6px 0;border-bottom:1px dashed var(--line);align-items:baseline}
.alert:last-child{border-bottom:none}
.alert time{font-size:11px;color:var(--sub);flex:none}
.alert b{font-weight:600}
.disc{font-size:13px;line-height:1.55}
.disc .days{display:inline-block;margin-top:8px;font-size:11.5px;color:var(--up);background:var(--up-bg);border-radius:99px;padding:1px 8px}
.report h3{font-size:16px;font-weight:700;line-height:1.5;margin-bottom:5px}
.report p{font-size:13px;color:var(--sub);margin-bottom:10px}
.report-links{display:flex;gap:8px}
.btn{flex:1;text-align:center;border:1px solid var(--btn2-border);border-radius:9px;padding:9px 0;font-size:13px;color:var(--accent);background:var(--btn2-bg);font-weight:500;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
:root[data-theme="dark"] .btn.primary{color:#04263A}
/* 移动底部 tab */
.tabs{position:fixed;bottom:0;left:0;right:0;display:flex;background:var(--nav-bg);backdrop-filter:blur(10px);border-top:1px solid var(--line);padding:7px 0 calc(10px + env(safe-area-inset-bottom));z-index:50}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:10.5px;color:var(--sub)}
.tab.on{color:var(--accent)}
.tab svg{width:22px;height:22px}
/* ============ 桌面布局（≥1024px）：左侧导航 + 多列 bento ============ */
@media (min-width:1024px){
  .tabs{display:none}
  .main{padding:0 28px 48px}
  .sidenav{display:flex;flex-direction:column;width:212px;flex:none;border-right:1px solid var(--line);padding:22px 14px;gap:4px;position:sticky;top:0;height:100dvh}
  .brand{font-size:17px;font-weight:750;letter-spacing:.02em;padding:0 10px 18px}
  .brand span{color:var(--accent)}
  .nav-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;font-size:14px;color:var(--sub);cursor:pointer}
  .nav-item svg{width:19px;height:19px}
  .nav-item.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
  .nav-item:hover{background:var(--card2)}
  .sidenav .theme-btn{margin-top:auto;justify-content:center}
  .bento{grid-template-columns:repeat(4,1fr);gap:14px;padding:0}
  .w2{grid-column:span 2}
  .dt-w2{grid-column:span 2}
  .dt-w4{grid-column:span 4}
  .card{padding:16px 18px;border-radius:18px}
  .kpi-main .num{font-size:32px}
}`;
