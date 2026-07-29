/**
 * The one empty-state shape every reading surface uses (2026-07-30
 * spec-drift remediation, U3).
 *
 * WHY: the operator opened `/stock/TSM.US` and the entire personal half of
 * the page was the word 「暂无论点」. A bare 暂无 tells a reader nothing they
 * did not already know from the blank space, and - worse - it is ambiguous
 * between "the system has nothing for you" and "the system is broken". Every
 * empty state in this app now answers two questions instead:
 *
 *   `what` - what this block WOULD show, so an empty one is legible as
 *            "nothing to show" rather than "something failed";
 *   `how`  - how it gets filled (which producer writes it, or what the
 *            reader can do), so an empty block is actionable.
 *
 * `how` must describe a mechanism that actually exists in this system. An
 * empty state that invites the reader to use a feature we never built is
 * the same class of lie as a fabricated number.
 */
import { html, type Html } from "./html.js";

/**
 * Renders the standard two-line empty state. Both arguments are escaped as
 * text by the `html` tagged template.
 */
export function renderEmptyState(what: string, how: string): Html {
  return html`<div class="empty-state">
    <p style="font-size:13px;color:var(--sub);margin:0">${what}</p>
    <p style="font-size:12px;color:var(--sub);margin:5px 0 0;line-height:1.65;opacity:.85">${how}</p>
  </div>`;
}

/**
 * A compact one-line variant for empty states nested INSIDE a populated card
 * (e.g. a thesis that has no bear points yet), where the two-line form would
 * dominate the content it sits under.
 */
export function renderInlineEmptyState(text: string): Html {
  return html`<p style="font-size:12px;color:var(--sub);margin:2px 0 0">${text}</p>`;
}
