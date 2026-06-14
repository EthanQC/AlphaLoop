import type { ExecutionResult, OrderTicket } from "@packages/shared-types";

export const LIVE_EXECUTION_ENABLED = false;
export const OPTION_AUTOMATION_ENABLED = false;

export function rejectDisabledExecution(ticket: OrderTicket): ExecutionResult | null {
  if (ticket.environment === "live") {
    return rejected(ticket, [
      "实盘自动执行已被交易宪法禁用。",
      "真实资金流程只能停在结构化建议卡和人工复核。"
    ]);
  }

  if (ticket.assetClass === "option") {
    return rejected(ticket, [
      "期权自动化已按操作策略禁用。",
      "自动执行只接受股票和 ETF 工单。"
    ]);
  }

  if (ticket.environment === "shadow") {
    return rejected(ticket, [
      "影子执行已按操作策略禁用。",
      "历史期权模拟记录只读，不能创建新的自动化工单。"
    ]);
  }

  return null;
}

function rejected(ticket: OrderTicket, reasons: string[]): ExecutionResult {
  return {
    ticketId: ticket.id,
    environment: ticket.environment,
    status: "rejected",
    provider: "broker-executor",
    reasons
  };
}
