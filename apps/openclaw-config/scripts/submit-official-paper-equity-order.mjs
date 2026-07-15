#!/usr/bin/env node
// Phase 6 Task 4 (2026-07-15 plan): this script used to build an OrderTicket
// by hand (quote lookup, budget check, everything) and POST it directly to
// broker-executor's /v1/tickets - no proposal, no owner-only approval, no
// shared secret. That direct path is now permanently closed: the endpoint
// requires a `proposalId` for an already-approved (approved/approved_half)
// proposal plus the `X-AlphaLoop-Broker-Secret` header (see
// apps/broker-executor/src/index.ts's Global Constraints ①/②) - a bare
// ticket body like this script used to send is rejected with 403 (pinned by
// apps/broker-executor/src/index.test.ts's "manual script" negative test).
//
// This is now a thin shell: it makes NO network call and submits NOTHING.
// It only prints the two-step replacement flow (create the trade as a
// proposal, then approve it - approval is what triggers execution) and
// exits non-zero, so a script or muscle-memory invocation fails loud instead
// of silently no-op'ing or, worse, appearing to hang waiting on a rejected
// HTTP call.
const [sideArg, symbolArg, quantityArg] = process.argv.slice(2);

const lines = [
  "submit-official-paper-equity-order.mjs 不再直接下单。",
  "Phase 6 起，broker-executor 的 /v1/tickets 要求已批准的提案（proposal），不再接受直接构造的工单。",
  "请改用两步流程（proposals.mjs）：",
  "  1) 创建提案：",
  "     pnpm exec node apps/openclaw-config/scripts/proposals.mjs create \\",
  "       --owner <memberId> --symbol <SYMBOL> --side <buy|sell> --quantity <N> \\",
  "       --limit-price <PRICE> --reason \"manual: <人工下单说明>\"",
  "  2) 批准（owner 本人操作，自动触发执行）：",
  "     pnpm exec node apps/openclaw-config/scripts/proposals.mjs approve \\",
  "       --token <create 输出的 approval_token> --actor <memberId>",
  "approve 命令在批准成功后会自动携带 proposalId 与共享密钥调用 broker-executor 执行；",
  "执行结果（成交/未确认/被拒）会体现在提案状态与生命周期记录中。"
];

if (sideArg && symbolArg && quantityArg) {
  lines.push(
    "",
    `（收到的旧式参数 "${sideArg} ${symbolArg} ${quantityArg}" 已无法直接下单，请对照上方流程改用 --side ${sideArg} --symbol ${symbolArg} --quantity ${quantityArg}。）`
  );
}

console.error(lines.join("\n"));
process.exit(1);
