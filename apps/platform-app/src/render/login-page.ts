/**
 * The login page (and the 401 page, which is the same page with a heading
 * swap - identity.ts's renderUnauthorizedPage delegates here).
 *
 * Standalone chrome on purpose: renderPage (./layout.ts) needs a signed-in
 * member for its topbar and renders the five-destination sidenav, neither of
 * which makes sense for someone who is not logged in yet. What IS shared is
 * the design language - every color, radius and font here comes from the same
 * ./tokens.ts constants (copied verbatim from final.html) the rest of the app
 * renders with, so the login screen is visibly the same product.
 *
 * NO SCRIPT AT ALL: the whole flow is two plain `<form method="post">`
 * submissions. That is a deliberate CSP choice - the app's policy is
 * `script-src 'nonce-<nonce>'` with no `'unsafe-inline'` (security.ts), and
 * the fewer nonce'd scripts exist the less there is to get wrong. The one
 * casualty is the theme toggle (which lives in layout.ts's inline script):
 * this page instead honors the OS setting through a
 * `prefers-color-scheme` media query built from the SAME dark-theme token
 * block, so it can never drift from the app's dark palette.
 */
import { html, joinHtml, trustedHtml, type Html } from "./html.js";
import { COLOR_SCHEME_CSS, STRUCTURAL_CSS, THEME_DARK_CSS, THEME_LIGHT_CSS } from "./tokens.js";

/**
 * The dark token block re-scoped to "OS says dark AND no explicit choice has
 * been stamped on <html>". Derived from THEME_DARK_CSS by selector rewrite
 * rather than copied, so a future edit to the dark palette lands here too;
 * if the rewrite ever fails to match, the page simply stays light (the
 * `:root` light block always applies), never unstyled.
 */
const DARK_AUTO_CSS = `@media (prefers-color-scheme: dark){
${THEME_DARK_CSS.replace(':root[data-theme="dark"]{', ":root:not([data-theme]){")}
}`;

const AUTH_CSS = `.auth-wrap{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--bg)}
.auth-card{width:100%;max-width:26rem;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:26px 24px 22px}
.auth-brand{font-size:17px;font-weight:750;letter-spacing:.02em;margin-bottom:18px}
.auth-brand span{color:var(--accent)}
.auth-card h1{font-size:19px;font-weight:650;margin-bottom:6px}
.auth-lede{font-size:13px;color:var(--sub);margin-bottom:16px}
.auth-note{font-size:12.5px;border-radius:10px;padding:9px 11px;margin-bottom:14px;line-height:1.5}
.auth-note.info{background:var(--accent-soft);border:1px solid var(--accent-border);color:var(--ink)}
.auth-note.warn{background:var(--amber-bg);border:1px solid var(--amber-border);color:var(--amber)}
.auth-field{margin-bottom:14px}
.auth-field label{display:block;font-size:12px;color:var(--sub);margin-bottom:6px}
.auth-field input{width:100%;background:var(--card2);border:1.5px solid var(--accent-border);border-radius:11px;padding:11px 13px;font-size:15px;color:var(--ink);font-family:inherit}
.auth-field input:focus{outline:3px solid var(--accent);outline-offset:1px}
.auth-field input.code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;letter-spacing:.4em;text-align:center;font-size:20px}
.auth-submit{width:100%;background:var(--accent);border:1px solid var(--accent);color:#fff;border-radius:10px;padding:11px 0;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
:root[data-theme="dark"] .auth-submit{color:#04263A}
@media (prefers-color-scheme: dark){:root:not([data-theme]) .auth-submit{color:#04263A}}
.auth-foot{margin-top:16px;font-size:11.5px;color:var(--sub);line-height:1.6}
.auth-foot a{color:var(--accent)}`;

/** Which of the two steps to render. */
export type LoginStep = "email" | "code";

export interface LoginPageOptions {
  /** Per-request CSP nonce. This page emits no `<script>`, so it only lands
   * on a `<meta>` tag - kept so every page in the app exposes the nonce the
   * same way (identity.ts's original 401 page already did this). */
  nonce: string;
  step: LoginStep;
  /** Echoed into the code step's hidden field so the verify POST knows which
   * member is being confirmed. Escaped like any other interpolation. */
  email?: string;
  /** Neutral/informational banner (e.g. 验证码已发送). */
  notice?: string;
  /** Problem banner (e.g. 验证码不正确). */
  error?: string;
  /** Overrides the default heading (the 401 page passes 未获授权). */
  heading?: string;
}

function renderBanner(text: string | undefined, tone: "info" | "warn"): Html {
  if (!text) {
    return trustedHtml("");
  }
  const role = tone === "warn" ? trustedHtml(' role="alert"') : trustedHtml("");
  return html`<p class="auth-note ${tone}"${role}>${text}</p>`;
}

function renderEmailStep(): Html {
  return html`<form method="post" action="/login">
    <div class="auth-field">
      <label for="email">邮箱地址</label>
      <input
        id="email"
        name="email"
        type="email"
        inputmode="email"
        autocomplete="email"
        required
        placeholder="you@example.com"
      >
    </div>
    <button class="auth-submit" type="submit">发送验证码</button>
  </form>`;
}

function renderCodeStep(email: string | undefined): Html {
  return html`<form method="post" action="/login/verify">
    <input type="hidden" name="email" value="${email ?? ""}">
    <div class="auth-field">
      <label for="code">6 位验证码</label>
      <input
        id="code"
        name="code"
        type="text"
        inputmode="numeric"
        pattern="[0-9]{6}"
        maxlength="6"
        autocomplete="one-time-code"
        class="code"
        required
        placeholder="000000"
      >
    </div>
    <button class="auth-submit" type="submit">登录</button>
  </form>`;
}

/**
 * Renders the complete login document. Self-contained: no external requests
 * of any kind (no `<script src>`, `<link>`, remote font or image), matching
 * the app-wide CSP `default-src 'none'`.
 */
export function renderLoginPage(options: LoginPageOptions): string {
  const heading = options.heading ?? (options.step === "email" ? "登录 AlphaLoop" : "输入验证码");
  const lede =
    options.step === "email"
      ? "输入你的圈内邮箱，验证码会发送到你的飞书。"
      : "验证码已发送到该邮箱对应成员的飞书，10 分钟内有效。";

  const form = options.step === "email" ? renderEmailStep() : renderCodeStep(options.email);
  const banners = joinHtml([renderBanner(options.error, "warn"), renderBanner(options.notice, "info")]);

  const page = html`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csp-nonce" content="${options.nonce}">
<meta name="robots" content="noindex, nofollow">
<title>${heading} · AlphaLoop</title>
<style>${trustedHtml(THEME_LIGHT_CSS)}
${trustedHtml(THEME_DARK_CSS)}
${trustedHtml(DARK_AUTO_CSS)}
${trustedHtml(COLOR_SCHEME_CSS)}
${trustedHtml(STRUCTURAL_CSS)}
${trustedHtml(AUTH_CSS)}</style>
</head>
<body>
<main class="auth-wrap">
  <div class="auth-card">
    <div class="auth-brand">Alpha<span>Loop</span></div>
    <h1>${heading}</h1>
    <p class="auth-lede">${lede}</p>
    ${banners}
    ${form}
    <p class="auth-foot">仅圈内成员可登录。为保护成员隐私，无论邮箱是否在册，本页都会显示同样的结果。<br>没收到验证码？请确认邮箱无误并已在飞书中与本机器人建立过会话，或联系圈主。</p>
  </div>
</main>
</body>
</html>
`;

  return page.__html;
}
