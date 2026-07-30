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
 * directly by relative path. It stays out of this app's BUILD (tsconfig.json
 * excludes the test files, so nothing here is emitted to dist), but as of I10
 * it IS typechecked: root tsconfig.tests.json compiles every test file with
 * `allowJs`, which resolves the three .mjs imports below - which is why they
 * no longer carry `@ts-expect-error`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiTokenRepository, MemberRepository, openTradingDatabase, type Member } from "@packages/shared-types";

import { createPlatformServer } from "../server.js";

import { collectL1News } from "../../../openclaw-config/scripts/news-sources.mjs";
import { buildEventFromCluster, clusterArticles } from "../../../openclaw-config/scripts/news-engine.mjs";
import { upsertEventWithSources } from "../../../openclaw-config/scripts/news-store.mjs";

// collectL1News is plain JS, so TypeScript infers its parameter from the
// destructuring defaults in news-sources.mjs (`symbols = []` -> never[],
// `fetchImpl = fetch` -> the full DOM fetch signature). That inference is an
// artifact of JS defaults, not the module's real contract, and it rejects both
// a real symbol list and a partial-Response fake. This alias states the two
// arguments this seam passes; the call below still runs the REAL .mjs function.
const collectL1NewsSeam = collectL1News as unknown as (input: {
  symbols: string[];
  env?: Record<string, string | undefined>;
  fetchImpl?: unknown;
  longbridgeNewsFetcher?: () => Promise<unknown[]>;
}) => Promise<{ articles: Array<{ title: string }>; warnings: string[] }>;

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
    const { articles, warnings } = await collectL1NewsSeam({
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
    expect(fedCluster?.articles).toHaveLength(2);

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

// ---------------------------------------------------------------------------
// 2026-07-30: /news pages the 7-day window instead of shipping all of it
// ---------------------------------------------------------------------------

/**
 * 120 REAL wire headlines, read verbatim out of the mini's live
 * `news_event_sources` table (a byte-copy of runtime/trading.sqlite, rows from
 * 2026-07-23..30), wrapped in the RSSHub feed shape the real parser consumes.
 *
 * They are real for a specific reason. A first cut of this test generated
 * headlines from a template ("第N号快讯：<主语><动词>，机构给出不同解读") and the REAL
 * clusterer collapsed 120 of them into 16 events, because a shared boilerplate
 * suffix is exactly what title-similarity clustering is built to notice. A
 * paging test built on that would have been testing the template, not the pager.
 * Real 财联社/华尔街见闻 快讯 cluster the way production does: 200 of them yielded
 * 193 events, 120 yield ~116.
 *
 * Every row under test is written by the real writer - the XML below goes
 * through the real fetchRsshubFeed parser inside collectL1News, the real
 * clusterArticles, the real buildEventFromCluster and the real
 * upsertEventWithSources - so the paged reader pages over production rows, not
 * over hand-written INSERTs. Only the publication TIMES are assigned here, to
 * place the corpus inside this suite's frozen 7-day window.
 *
 * For the corpus this stands in for, see the byte measurements in routes/news.ts
 * (1303 events / 2,122,507 bytes in a single response).
 */
const LIVE_WIRE_HEADLINES = [
  "费城半导体指数跌5% 美光科技跌超7%",
  "乌机构：顿涅茨克地区两重镇处于俄火力控制下",
  "意大利和沙特重申支持落实“两国方案”",
  "中外科学家揭示植物高效光合作用分子机制",
  "硕世生物控制权生变：十年一致行动突告终止 控股股东面临解散诉讼|速读公告",
  "大和资本：美联储声明料将基本保持不变",
  "NextEra与Brookfield拟投资1000亿美元 建设AI数据中心园区",
  "消息人士：伊朗仍在镐山进行铀浓缩",
  "CBOT大豆日内跌幅达2.0%，报1192.92。",
  "长江存储：网传“核心 3DNAND专利全部19项权利要求被裁定无效”系严重误导性描述",
  "AI医疗人才缺口将达250万 AI医疗复合型人才薪资涨30%",
  "“反科技”标签大放异彩 这国股市在芯片动荡中创新高",
  "美国财政部拍卖两年期浮息国债（FRNs），贴现利率0.050%。",
  "格隆汇7月29日｜美国财政部拍卖四个月期国债，得标利率3.875%，投标倍数3.04。",
  "美以闭门会谈无实质成果 战略节奏存差异",
  "美国财政部拍卖四个月期国债，得标利率3.875%，投标倍数3.04。",
  "凯投宏观：“AI列车”将重回正轨，维持标普500指数年底目标8250点",
  "欧洲STOXX 600指数初步收跌0.27%，报645.10点。",
  "兆易创新掌门人抛增持计划 此前减持套现44亿",
  "谷歌为macOS版Gemini应用新增Fn键唤醒语音控制功能。",
  "近十年主动ETF规模年均复合增长率达44%",
  "内盘期货夜市涨跌各异，乙二醇收涨4.7%，低硫燃油、燃油涨约3.3%",
  "伊拉克总理取消与沙特王储的会晤。（路透）",
  "携手共建粤港澳大湾区·中央企业对接会在京举行",
  "恐慌指数VIX日内涨幅达10.0%，报20.04；标普500指数目前跌0.88%。",
  "菲律宾东部海域发生5.6级地震",
  "华尔街投行刷新交易收入纪录 欧洲同行面临更高竞争门槛",
  "Kis上调SK海力士股价目标24%，至470万韩元（7月29日收盘报141万韩元）。",
  "美国财政部：今日伊朗制裁针对借助霍尔木兹海峡牟利的行为。",
  "丰业银行下调微软目标价至470美元",
  "EIA：美国上周原油库存减少716.7万桶",
  "SC原油主力合约涨超5%",
  "中际旭创香港公开发售认购倍数为16.84倍，中际旭创国际发售认购倍数为9.73倍。",
  "美国7月24日当周EIA精炼厂设备利用率变化 1.1%，前值 -0.1%。",
  "美国7月24日当周EIA精炼油库存变动 106.2万桶，前值 139.5万桶。",
  "美国7月24日当周EIA汽油库存变动 0.7万桶，前值 76.5万桶。",
  "美国7月24日当周EIA库欣地区原油库存变动 -77.1万桶，前值 -67.4万桶。",
  "美国7月24日当周EIA原油库存变动 -716.7万桶，前值 201万桶。",
  "美股跌幅扩大，纳指跌超1%，英伟达跌超3%",
  "荷兰国际：如果美联储维持利率不变，美元走势将受油价影响",
  "美股异动丨现货黄金跌破4000美元，黄金白银集体走低",
  "提醒：北京时间22:30，美国能源信息署（EIA）将发布政府版原油库存周报。",
  "法拉利备受争议的纯电车型Luce仅用两个月便达成2026年销售目标。（英国金融时报）",
  "台积电：熊本晶圆厂的恢复需要一定时间",
  "日本熊本县地震造成重大人员伤亡，我使馆发布提醒",
  "伊拉克总理办公室：伊拉克安全委员会授意外交部针对美国与沙特的行动采取法律行动。",
  "马斯克与X平台广告商就长期法律纠纷达成和解",
  "马斯克与X广告商达成法律和解。（英国金融时报）",
  "7月国内乙二醇装置迎检修高峰期 同期港口库存降至五年低位",
  "现货黄金跌破4000美元",
  "美国宣布制裁油轮，因其与伊朗存在关联。（彭博）",
  "美股异动｜哈门那跌超7%，Q2业绩超预期但维持全年盈利指引不变",
  "现货黄金跌破4000美元/盎司关口，报3999.38美元/盎司，日内跌0.7%。",
  "瑞银：下调康宁目标价至196美元",
  "原油短线波动不大，报道称美国公布伊朗相关制裁。",
  "格隆汇7月29日丨据媒体消息，美国公布伊朗相关制裁措施，对与伊朗有关的油轮实施制裁。",
  "美国或要求部分驻中东部队上交手机。（路透）",
  "托尔斯滕·弗赖当选德国联盟党议会党团主席",
  "上海发布户外广告内容合规指引：住宅电梯夜间时段原则上不得播放有声广告",
  "撤单≠免罚！渔翁信息科创板IPO终止后遭罚1790万元",
  "荷兰合作银行：日本央行或需释放强烈的加息信号以遏制日元跌势",
  "美联储7月利率决议关注点",
  "刚果（金）埃博拉疫情持续传播",
  "国务院国资委：突出抓好企业科技创新能力提升，加强关键核心技术协同攻关",
  "美股异动｜宝洁跌近6%，新财年净销售额及盈利指引不及预期",
  "岚图发布自研“虎踞”底盘",
  "联合国官员：超4亿非洲人仍缺乏基本饮用水",
  "“电报”创始人被全球通缉",
  "全国汽车标准化技术委员会正开展相关工作规范汽车灯光安装使用",
  "高盛：美联储加息概率三分之一，或迎1997年以来非降息会议最大意外",
  "苹果、可口可乐股价续刷记录新高",
  "即时零售开新局：朴朴超市入驻淘宝闪购、线下开火锅店",
  "泽连斯基请求美紧急提供300枚“爱国者”拦截弹",
  "美股异动丨福特汽车涨超5%创6月初以来新高，再次上调全年盈测",
  "麦格理：将Paypal目标价上调至62美元",
  "日本九州岛附近海域发生5.3级地震",
  "美银：将可口可乐目标价上调至100美元",
  "苏州上半年签约亿元以上项目1594个",
  "诺奖级AlphaFold团队被拆散 DeepMind科研战略迎重大调整",
  "特朗普拟公布220亿美元杜勒斯机场重建计划",
  "德国拟立法允许使用AI辅助审核移民申请",
  "波罗的海干散货运价指数跌至四周低点，因海岬型和超灵便型船运价走低",
  "驻日本大使馆提醒中国公民注意防范地震灾害",
  "北美科技软件股指数ETF涨0.9%，报92.64美元，处于连续第四个交易日反弹之中。",
  "特朗普称伊朗将遭“痛击” 不排除继续打击其地区代理人",
  "美股三大指数集体低开，SK海力士绩后跌超1%",
  "航行警告！南海海域实弹射击",
  "日本熊本县再次地震 震感强烈",
  "地方AMC改革新动作：中原资产投资管理集团揭牌",
  "日本熊本县再次地震感强烈",
  "华尔街围绕SpaceX股价波动推出结构性产品 寻求对冲上市后下跌风险",
  "澳大利亚或将迎来60年来首座新建炼油厂",
  "格隆汇7月29日｜日本气象厅：日本天草地区发生地震。",
  "应急管理部针对四川启动国家地质灾害四级应急响应",
  "摩通私银：日本央行料按兵不动，预计日元未来6至12个月徘徊于160附近水平",
  "远洋控股拟对9笔债券购回：标的债券本金额合计177.92亿元，购回资金总额8亿元",
  "印尼开始进口俄罗斯石油以加强能源安全",
  "国联民生509万元竞得民生证券0.02%股份，持股将升至100%",
  "港股公告精选｜新东方上一财年净利润增长约3成 香港电讯中期营收近190亿港元",
  "前美联储理事米兰认为利率应维持不变",
  "高盛：美联储会议或迎近30年来最大政策意外",
  "美团月付遭批量盗刷，多地用户中招？回应：或遭遇电信诈骗，正配合警方调查",
  "格隆汇7月29日｜据伊朗迈赫尔通讯社，伊朗外长阿拉格齐向政府报告了与阿曼的谈判情况以及与乌克兰外长的联系情况。",
  "格隆汇7月29日｜美联储：FOMC会议将于周三上午（北京时间晚上）9:00按计划恢复。",
  "摩根大通：预计美国财政部因中期选举暂不调整债券发行计划",
  "兆日科技：控股股东拟筹划股份转让事宜 股票明起停牌",
  "美国FCC禁令突袭逆变器板块：光储龙头大跌，已有产品仍可销售",
  "特朗普称美国将强力打击伊朗 中东局势升级推动油价大幅飙升",
  "港股风向标｜恒指逼近26000点创反弹新高 AI主线能否止跌引关注",
  "周三美股盘前你需要了解的全球要闻",
  "35个数商企业优秀产品集中发布 金融场景加速开放 上海如何共建数据产业生态？",
  "珠海：上半年GDP同比增长5.2%",
  "全国首条“垂直岸线、直达码头”海铁联运专用线投运",
  "策略师：通胀放缓为美联储留出了按兵不动的空间",
  "中国文昌航天发射场完成50次发射任务 新一代大推力运载火箭高稳定高密度发射常态化",
  "阎非已任东航集团董事、党组副书记",
  "世界粮食计划署：刚果（金）东部近1000万人面临粮食危机",
  "葛卫东：“我是相信没结束的，谁停下，接下来的就会遭到降维打击”",
  "大行评级｜花旗：上调福特汽车目标价至20美元，评级升至“买入”",
  "石药集团：CRB-701用于口咽癌二线治疗的注册性临床试验获美国FDA批准"
];

function buildBulkFeedXml(): string {
  const items = LIVE_WIRE_HEADLINES.map((title, index) => {
    // 2026-07-09T00:00Z + 45 min per item keeps every item inside the page's
    // 7-day window relative to this suite's frozen clock (2026-07-15T12:00Z).
    const published = new Date(Date.parse("2026-07-09T00:00:00.000Z") + index * 45 * 60 * 1000);
    return `<item><title>${title}</title>`
      + `<link>https://cls.cn/telegraph/bulk-${index + 1}</link>`
      + `<pubDate>${published.toUTCString()}</pubDate><source>财联社</source></item>`;
  });
  return `<?xml version="1.0"?><rss><channel>${items.join("")}</channel></rss>`;
}

describe("seam: GET /news pages the 7-day window (measured 2.02 MB -> 86 KB on the live corpus)", () => {
  let tempDir: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let token: string;
  let persistedEvents = 0;

  beforeEach(async () => {
    const { dbPath, dir } = makeTempDbPath();
    tempDir = dir;
    db = openTradingDatabase(dbPath) as unknown as DatabaseSync;

    const member: Member = {
      id: "member_paging",
      email: "paging@example.com",
      displayName: "Paging Tester",
      riskTags: [],
      stockTags: [],
      showPerformance: true,
      status: "active",
      createdAt: "2026-07-01T00:00:00.000Z"
    };
    new MemberRepository(db).upsert(member);
    token = new ApiTokenRepository(db).issue(member.id, "paging-test").token;

    const bulkXml = buildBulkFeedXml();
    const { articles } = await collectL1NewsSeam({
      symbols: ["QQQ.US"],
      env: { RSSHUB_BASE_URL: "http://fake-rsshub.invalid" },
      fetchImpl: (url: string | URL) =>
        String(url).includes("/cls/telegraph")
          ? Promise.resolve({ ok: true, status: 200, statusText: "OK", text: async () => bulkXml })
          : fakeFetch(url),
      longbridgeNewsFetcher: async () => []
    });

    const clusters = clusterArticles(articles);
    persistedEvents = 0;
    for (const cluster of clusters) {
      const event = buildEventFromCluster(cluster, ["QQQ.US"]);
      upsertEventWithSources(
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
      persistedEvents += 1;
    }
    // The volume this suite is about has to actually exist, or every assertion
    // below would pass vacuously on a one-page feed.
    expect(persistedEvents).toBeGreaterThan(100);

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

  async function readPage(query: string): Promise<{ body: string; cards: number }> {
    const response = await fetch(`${baseUrl}/news${query}`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = await response.text();
    return { body, cards: body.split('<section class="card w2 dt-w2">').length - 1 };
  }

  it("caps one response at 50 cards and states the true total", async () => {
    const { body, cards } = await readPage("");

    expect(cards).toBe(50);
    const expectedPages = Math.ceil(persistedEvents / 50);
    expect(body).toContain(`近 7 天共 ${persistedEvents} 件事件，当前第 1/${expectedPages} 页（第 1-50 件`);
    // Never the empty state: 50 real cards are on the page.
    expect(body).not.toContain("近 7 天没有聚类到任何新闻事件。");
  });

  it("walks every page exactly once - no duplicated and no unreachable event", async () => {
    const expectedPages = Math.ceil(persistedEvents / 50);
    const seen: string[] = [];
    for (let page = 1; page <= expectedPages; page += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordered walk is the point
      const { body } = await readPage(page === 1 ? "" : `?page=${page}`);
      // Every card renders its sources' 原文 links, and each feed item has its
      // own `bulk-N` link, so the links are a per-source fingerprint: a link
      // showing up on two pages means an event was served twice, and a missing
      // one means an event no reader can reach.
      for (const match of body.matchAll(/telegraph\/bulk-(\d+)/gu)) {
        seen.push(match[1] as string);
      }
    }
    const unique = new Set(seen);
    expect(unique.size).toBe(seen.length);
    expect(unique.size).toBe(LIVE_WIRE_HEADLINES.length);
  });

  it("keeps the topbar data time on the newest event even when the reader pages back", async () => {
    const first = await readPage("");
    const last = await readPage(`?page=${Math.ceil(persistedEvents / 50)}`);
    const stamp = /数据时间 [0-9-]+ [0-9:]+/u;

    expect(first.body).toMatch(stamp);
    expect(last.body.match(stamp)?.[0]).toBe(first.body.match(stamp)?.[0]);
  });

  it("clamps an out-of-range page instead of rendering a blank grid", async () => {
    const { body, cards } = await readPage("?page=9999");
    const expectedPages = Math.ceil(persistedEvents / 50);

    expect(cards).toBeGreaterThan(0);
    expect(body).toContain(`当前第 ${expectedPages}/${expectedPages} 页`);
    expect(body).not.toContain("近 7 天没有聚类到任何新闻事件。");
  });

  it("filters first and pages second - the pager keeps the active filter", async () => {
    const { body } = await readPage("?topic=宏观");

    // Every bulk item implicates no ticker, so 宏观 matches all of them: the
    // filter narrows the SET, the page size slices what is left, and the pager's
    // links carry the filter forward rather than silently dropping it.
    expect(body).toContain("/news?topic=%E5%AE%8F%E8%A7%82&amp;page=2");
  });
});
