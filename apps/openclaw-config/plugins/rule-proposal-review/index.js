import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(pluginDir, "..", "..", "..", "..");
const commandPattern =
  /^(?:@\S+\s+|<at[^>]*>.*?<\/at>\s*)?(?:确认激活|二次确认激活|人工确认激活|建议激活|申请激活|一审建议激活|继续观察|观察|暂不激活|拒绝|归档)\s+proposal_[A-Za-z0-9_:-]+/u;

const plugin = {
  id: "rule-proposal-review",
  name: "Rule Proposal Review",
  description: "Deterministically handles Feishu rule-proposal review replies before model dispatch.",
  register(api) {
    api.on("before_dispatch", async (event, ctx) => {
      const outcome = await handleRuleProposalReview(api, {
        channel: event.channel ?? ctx.channelId,
        message: event.body ?? event.content,
        actor: event.senderId ?? ctx.senderId,
        replyShape: "dispatch"
      });
      return outcome;
    });

    api.on("before_agent_reply", async (event, ctx) => {
      return handleRuleProposalReview(api, {
        channel: ctx.channelId ?? ctx.messageProvider,
        message: event.cleanedBody,
        actor: ctx.senderId,
        replyShape: "agent"
      });
    });
  }
};

export default plugin;

async function handleRuleProposalReview(api, { channel, message, actor, replyShape }) {
  const config = resolveConfig(api.pluginConfig);
  if (String(channel ?? "").toLowerCase() !== config.channel) {
    return undefined;
  }

  const normalizedMessage = normalizeMessage(message ?? "");
  if (!commandPattern.test(normalizedMessage)) {
    return undefined;
  }

  const reviewActor = String(actor ?? "feishu-operator");
  try {
    const result = await runReviewScript({
      repoRoot: config.repoRoot,
      message: normalizedMessage,
      actor: reviewActor,
      notify: config.notify
    });

    api.logger.info?.(
      `rule-proposal-review handled ${result.proposalId ?? "unknown"} action=${result.action ?? "unknown"} status=${result.status ?? "unknown"}`
    );

    if (!config.returnText) {
      return { handled: true };
    }

    return handledResult(replyShape, renderSuccess(result));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    api.logger.warn?.(`rule-proposal-review failed: ${reason}`);
    return handledResult(replyShape, renderFailure(reason));
  }
}

function resolveConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  return {
    repoRoot: typeof config.repoRoot === "string" && config.repoRoot.trim()
      ? config.repoRoot.trim()
      : defaultRepoRoot,
    channel: typeof config.channel === "string" && config.channel.trim()
      ? config.channel.trim().toLowerCase()
      : "feishu",
    notify: typeof config.notify === "boolean" ? config.notify : true,
    returnText: typeof config.returnText === "boolean" ? config.returnText : false
  };
}

function normalizeMessage(value) {
  return String(value ?? "")
    .replace(/[ \t\r\n]+/gu, " ")
    .trim();
}

function runReviewScript({ repoRoot, message, actor, notify }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const scriptPath = join(repoRoot, "apps", "openclaw-config", "scripts", "review-rule-proposal.mjs");
    const args = [
      scriptPath,
      "from-feishu",
      message,
      "--actor",
      actor
    ];
    if (!notify) {
      args.push("--no-notify");
    }

    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error([`review-rule-proposal.mjs exit ${code}`, stderr, stdout].filter(Boolean).join("\n").trim()));
        return;
      }

      try {
        resolvePromise(JSON.parse(stdout.trim()));
      } catch (error) {
        rejectPromise(new Error(`无法解析审核脚本输出：${error instanceof Error ? error.message : String(error)}\n${stdout}`));
      }
    });
  });
}

function renderSuccess(result) {
  const status = result.status ?? "unknown";
  const effective = result.effective ?? "规则未激活，active-version 未改变";
  return [
    "规则提案审核已处理。",
    `提案：${result.proposalId ?? "unknown"}`,
    `状态：${status}`,
    `结果：${effective}`
  ].join("\n");
}

function renderFailure(reason) {
  return [
    "规则提案审核未完成。",
    reason,
    "",
    "有效格式：继续观察/拒绝/归档/建议激活 <proposal-id> 原因；二次确认必须使用：确认激活 <proposal-id> HUMAN_APPROVED 原因。"
  ].join("\n");
}

function handledResult(replyShape, text) {
  if (replyShape === "agent") {
    return {
      handled: true,
      reply: { text }
    };
  }

  return {
    handled: true,
    text
  };
}
