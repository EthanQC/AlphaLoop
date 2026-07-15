/**
 * Phase 4 Task 7 - full seam test (plan Task 7's explicit deliverable):
 * fixtures -> collectL1News(fake fetch) -> clusterArticles ->
 * buildEventFromCluster -> upsertEventWithSources (temp db) -> platform
 * listNewsEvents -> GET /news, all through the REAL functions on both sides
 * of the app boundary (only `fetch`/the Longbridge news fetcher are faked -
 * everything else is the genuine engine/store/platform code) - proving the
 * "single writer, two render faces" claim end-to-end rather than by
 * assertion.
 *
 * apps/openclaw-config/scripts is plain .mjs with no package.json/build step
 * of its own (see data/news.ts's own header comment on why this app
 * re-implements rather than imports its store reader) - this test file is
 * the one place that's an acceptable exception: it exists specifically to
 * prove the two sides agree, so it imports the engine-side .mjs modules
 * directly by relative path (test files are excluded from this app's tsconfig
 * project - see tsconfig.json's `exclude` - so this never affects
 * `pnpm typecheck`/`pnpm build`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiTokenRepository, MemberRepository, openTradingDatabase, type Member } from "@packages/shared-types";

import { createPlatformServer } from "../server.js";

// @ts-expect-error - plain .mjs, no type declarations; see module header.
import { collectL1News } from "../../../openclaw-config/scripts/news-sources.mjs";
// @ts-expect-error - plain .mjs, no type declarations; see module header.
import { buildEventFromCluster, clusterArticles } from "../../../openclaw-config/scripts/news-engine.mjs";
// @ts-expect-error - plain .mjs, no type declarations; see module header.
import { upsertEventWithSources } from "../../../openclaw-config/scripts/news-store.mjs";

const CLS_XML = `<?xml version="1.0"?><rss><channel>
  <item>
    <title>美联储维持利率不变，市场解读为中性</title>
    <link>https://cls.cn/telegraph/seam-100</link>
    <pubDate>Wed, 15 Jul 2026 08:00:00 GMT</pubDate>
    <source>财联社</source>
  </item>
</channel></rss>`;

// Same story, a second independent wire - deliberately near-identical
// wording (title-similarity clustering, not URL identity) so
// clusterArticles merges the two into ONE event with TWO sources, which is
// exactly the "一事一卡" behavior this seam test exists to prove.
const WALLSTREETCN_XML = `<?xml version="1.0"?><rss><channel>
  <item>
    <title>美联储维持利率不变，市场解读为中性</title>
    <link>https://wallstreetcn.com/live/seam-200</link>
    <pubDate>Wed, 15 Jul 2026 08:05:00 GMT</pubDate>
    <source>华尔街见闻</source>
  </item>
</channel></rss>`;

const EMPTY_XML = `<?xml version="1.0"?><rss><channel></channel></rss>`;

function fakeFetch(url: string | URL) {
  const target = String(url);
  if (target.includes("/cls/telegraph")) {
    return Promise.resolve({ ok: true, status: 200, statusText: "OK", text: async () => CLS_XML });
  }
  if (target.includes("/wallstreetcn/live")) {
    return Promise.resolve({ ok: true, status: 200, statusText: "OK", text: async () => WALLSTREETCN_XML });
  }
  if (target.includes("/gelonghui/live") || target.includes("/gelonghui/hot-article") || target.includes("/cls/depth") || target.includes("/wallstreetcn/news")) {
    return Promise.resolve({ ok: true, status: 200, statusText: "OK", text: async () => EMPTY_XML });
  }
  // Every other L1 source (Yahoo/Google) fails on purpose - exercises
  // collectL1News's per-source-failure-never-blocks contract, and keeps this
  // fixture minimal (RSSHub alone is enough to prove the seam).
  return Promise.reject(new Error("seam test: source intentionally unavailable"));
}

function makeTempDbPath(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-news-seam-"));
  return { dbPath: join(dir, "trading.sqlite"), dir };
}

describe("Phase 4 Task 7 seam: collectL1News -> clusterArticles -> buildEventFromCluster -> upsertEventWithSources -> platform GET /news", () => {
  let tempDir: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    const { dbPath, dir } = makeTempDbPath();
    tempDir = dir;
    db = openTradingDatabase(dbPath) as unknown as DatabaseSync;

    const member: Member = {
      id: "member_seam",
      email: "seam@example.com",
      displayName: "Seam Tester",
      riskTags: [],
      stockTags: [],
      showPerformance: true,
      status: "active",
      createdAt: "2026-07-01T00:00:00.000Z"
    };
    new MemberRepository(db).upsert(member);
    token = new ApiTokenRepository(db).issue(member.id, "seam-test").token;

    server = createPlatformServer({ db, repoRoot: process.cwd(), now: () => new Date("2026-07-15T12:00:00Z") });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("clusters the two-source fixture into one event and renders it exactly once with both sources and an impact badge", async () => {
    const { articles, warnings } = await collectL1News({
      symbols: ["QQQ.US"],
      env: { RSSHUB_BASE_URL: "http://fake-rsshub.invalid" },
      fetchImpl: fakeFetch,
      longbridgeNewsFetcher: async () => []
    });

    // Sanity: the seam genuinely exercised the "some sources fail, one
    // survives" path, not a lucky all-succeed run.
    expect(warnings.length).toBeGreaterThan(0);
    expect(articles.length).toBeGreaterThanOrEqual(2);

    const clusters = clusterArticles(articles);
    // The two near-identical CLS/WSJ articles merge into ONE cluster.
    const fedCluster = clusters.find((cluster: { articles: Array<{ title: string }> }) =>
      cluster.articles.some((article) => article.title.includes("美联储维持利率不变"))
    );
    expect(fedCluster).toBeDefined();
    expect(fedCluster.articles).toHaveLength(2);

    const event = buildEventFromCluster(fedCluster, ["QQQ.US"]);
    expect(event.sources).toHaveLength(2);

    const result = upsertEventWithSources(
      db,
      {
        clusterKey: event.clusterKey,
        titleZh: event.titleZh,
        summaryZh: event.summaryZh,
        impactDirection: event.impact.direction,
        impactAffected: event.impact.affected,
        impactReason: event.impact.reason
      },
      event.sources
    );
    expect(result.insertedSources).toBe(2);

    const response = await fetch(`${baseUrl}/news`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = await response.text();

    // The story appears exactly once - one event CARD (not one per source;
    // news-engine.mjs's own impact-reason/summary heuristics can legitimately
    // echo the same headline text into more than one field of a single card
    // for a generic, unclassified Chinese headline like this fixture's, so
    // counting raw title-text occurrences would be a false failure - the
    // card-boundary class combo (only ever emitted by renderEventCard, not
    // by the filter-chips card) is what actually proves "one cluster, one
    // card", which is Task 7's actual "一事一卡" guarantee).
    const cardOccurrences = body.split('<section class="card w2 dt-w2">').length - 1;
    expect(cardOccurrences).toBe(1);
    // Both sources' publisher names are present on that one card.
    expect(body).toContain("财联社");
    expect(body).toContain("华尔街见闻");
    // An impact badge (方向 label) is rendered.
    expect(body).toMatch(/class="[uda]"[^>]*>(利好|利空|中性|待验证)</u);
    // Both original links, each rendered as a safe external anchor.
    expect(body).toContain('href="https://cls.cn/telegraph/seam-100"');
    expect(body).toContain('href="https://wallstreetcn.com/live/seam-200"');
    expect(body).toContain('rel="noreferrer"');
  });
});
