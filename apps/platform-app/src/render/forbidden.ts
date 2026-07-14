/**
 * Shared 403 page for owner-gated routes (Task 7: `/proposal/<id>` and
 * `/research/<id>`). Deliberately its own small module (not folded into
 * identity.ts's renderUnauthorizedPage) - a 401 means "we don't know who you
 * are" (identity.ts's concern), a 403 here means "we know exactly who you
 * are, and this content belongs to someone else" - a different failure mode
 * with a different message, and per the plan (req §7: "被拒" must be
 * distinguishable) the two must never collapse into the same status code or
 * wording.
 *
 * Renders through the full page shell (render/layout.ts) - same as every
 * other page past Task 3 - rather than the bare identity.ts 401 page, since
 * by the time a caller reaches this function `resolveIdentity` has already
 * succeeded (there IS a logged-in member to show in the topbar); only the
 * authorization check on top of that identity failed.
 */
import { html } from "./html.js";
import { renderPage, type NavId } from "./layout.js";

export interface ForbiddenPageMember {
  displayName: string;
}

/**
 * Renders the 403 page shown when a resolved, logged-in member requests a
 * row that exists but belongs to someone else. `nav` picks which sidenav/tab
 * item is highlighted - callers pass whichever section the gated resource
 * conceptually belongs under (proposal.ts passes "paper", research.ts passes
 * "home").
 */
export function renderForbiddenPage(member: ForbiddenPageMember, nav: NavId, nonce: string, now: Date): string {
  const body = html`<div class="bento">
    <section class="card w2 dt-w4">
      <h2>403 无权访问</h2>
      <p style="font-size:13px;color:var(--sub)">这是其他成员的私有内容。</p>
    </section>
  </div>`;

  return renderPage({
    title: "403 无权访问",
    nav,
    member: { displayName: member.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml: body,
    nonce,
    now
  });
}
