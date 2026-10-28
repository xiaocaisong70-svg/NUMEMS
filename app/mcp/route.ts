import { env } from "cloudflare:workers";
import { currentActor, readState, mutateState, schedulerActor } from "@/lib/portal-service";
import { runJobs, refreshSeatQueue } from "@/lib/jobs";
import { observeWorkspace, prepareTest, workPlan, claimOperation, completeOperation, deferOperation, reviewFailure, verifiedReviewReceipt, FAILURE_CODES, setBridgeMode,
  setTestDeadline, recordSchedule, type BridgeState, type Observation } from "@/lib/codex-bridge";
import { transition } from "@/lib/seat-engine";
import { reminderMode } from "@/lib/reminder-policy";
import { recordIdleFailure, applyIdleObservation } from "@/lib/official-idle-state";
import { restoreV11History } from "@/lib/history-rollback";
export const dynamic = "force-dynamic";

const personSchema = { type: "object", properties: {
  email: { type: "string" }, role: { type: "string", enum: ["member", "admin", "owner"] },
}, required: ["email", "role"], additionalProperties: false };
const observationSchema = { type: "object", properties: {
  workspaceId: { type: "string" }, accountEmail: { type: "string" }, pageUrl: { type: "string" },
  observedAt: { type: "string" }, complete: { type: "boolean" }, totalSeats: { type: "integer" },
  members: { type: "array", items: personSchema }, invites: { type: "array", items: personSchema },
}, required: ["workspaceId", "accountEmail", "pageUrl", "observedAt", "complete", "totalSeats", "members", "invites"], additionalProperties: false };
const tools = [
  {
    name:"version_rollback_status",description:"仅读取当前 D1 修订与 V11 回退前提，不修改数据或成员。",
    inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true},
  },
  {
    name:"prepare_v11_rollback",description:"仅管理员显式维护：停用所有调度且原租约结案后，按当前修订把归档补回当前状态，为 V11 回退准备；保留归档，不恢复旧数据库快照。",
    inputSchema:{type:"object",properties:{expectedRevision:{type:"integer",minimum:0}},required:["expectedRevision"],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false},
  },
  {
    name:"observe_idle_workspace", description:"定期只读对账的完整官方证据；CAS 再核实无未完成租约、无全局故障且证据基线未变化，不办理外部动作。",
    inputSchema:{type:"object",properties:{observation:observationSchema,expectedObservedAt:{type:["string","null"]}},required:["observation","expectedObservedAt"],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false},
  },
  {
    name: "record_idle_observation_failure", description: "仅登记无租约、未开始外部动作的定期官方核对故障，不变更成员或释放席位；不能覆盖现有故障。",
    inputSchema: { type: "object", properties: {failureCode: {type:"string",enum:["browser_unavailable","login_expired","workspace_mismatch","capacity_mismatch","role_mismatch","unknown"]}, expectedObservedAt:{type:["string","null"]}}, required:["failureCode","expectedObservedAt"], additionalProperties:false },
    annotations: {readOnlyHint:false,destructiveHint:false,idempotentHint:false},
  },
  {
    name: "defer_seat_operation",
    description: "登记故障。仅在未claim且未开始外部动作时，暂时加载/网络/安全验证页使用browser_unavailable，由普通程序只读复核恢复；其它全局故障保持暂停。邮件/单一成员/单次审批仅隔离目标。不会确认成功或释放席位。",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["invite", "remove", "mail"] }, targetId: { type: "string" },
      failureCode: { type: "string", enum: FAILURE_CODES }, detail: { type: "string" },
    }, required: ["kind", "targetId", "failureCode"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "review_seat_failure",
    description: "retry_not_started仅重排明确未开始的隔离项；resume_workspace需管理员核查；recover_browser仅允许程序对未开始操作的browser_unavailable故障恢复；resume_preclaim_inventory限定未开始名单故障；resume_verified_operation仅允许已完成原操作回执且审计、目标、故障ID和新鲜完整证据一致时恢复。所有恢复均禁止有未完成租约。",
    inputSchema: { type: "object", properties: {
      decision: { type: "string", enum: ["retry_not_started", "resume_workspace", "recover_browser", "resume_preclaim_inventory", "resume_verified_operation"] },
      operationId: { type: "string" }, expectedFailureId: { type: "string" }, expectedTargetId: { type: "string" }, observation: observationSchema,
    }, required: ["decision"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "verified_review_receipt", description: "仅管理员按原故障、申请及操作 ID 查询已提交的安全复核回执；只读，不重做任何操作。",
    inputSchema: { type: "object", properties: {failureId:{type:"string"}, targetId:{type:"string"},
      operationId:{type:"string"}}, required:["failureId","targetId","operationId"], additionalProperties:false },
    annotations: {readOnlyHint:true},
  },
  {
    name: "record_codex_schedule", description: "本地定时任务或按需队列检查程序已实际安装核对后登记其ID；空字符串表示清除登记，不代替真正暂停任务。",
    inputSchema: { type: "object", properties: { scheduleId: { type: "string" } }, required: ["scheduleId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "set_test_deadline", description: "仅用于授权邮箱的已加入测试席位：把截止时间调至30分钟提醒窗口或立即到期，用于端到端验收，不改变其他员工租期。",
    inputSchema: { type: "object", properties: {
      requestId: { type: "string" }, stage: { type: "string", enum: ["reminder", "expire"] },
    }, required: ["requestId", "stage"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "seat_portal_status",
    description: "查看门户当前工作队列、30分钟提醒与Codex执行器状态。仅管理员可用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "process_seat_queue",
    description: "处理小时制排队、到期与30分钟提醒，返回Codex待办。实际邀请/移除由授权浏览器执行后回执。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "refresh_seat_queue",
    description: "仅同步小时制队列、到期、网页提醒及后台心跳；不会发邮件或改变官方成员。可由普通程序在传输超时后安全重新核对。仅管理员可用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "observe_workspace", description: "保存刚从官方后台完整读取的成员和邀请证据，核对工作空间及Owner；首次自动盘点，后续核对接受邀请和已移除状态。",
    inputSchema: { type: "object", properties: { observation: observationSchema }, required: ["observation"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "prepare_test_request", description: "为用户明确授权的hit_wangning@outlook.com创建1小时测试申请并仅开启该邮箱的测试模式；不会发送邀请。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "claim_seat_operation", description: "取得一个独占办理租约。邀请/移除需60秒内的完整官方证据；邮件需有效30分钟提醒。必须核实真实结果再complete，结果不明不可重试。",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["invite", "remove", "mail"] }, targetId: { type: "string" },
    }, required: ["kind", "targetId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "complete_seat_operation", description: "提交实际执行回执。邀请/移除必须提供操作后的完整官方快照；撤回待接受邀请期间若员工已成为普通成员，使用joined加完整快照安全结束原租约并保留成员，不算移除成功；邮件必须提供Gmail消息ID。用failureCode明确故障。",
    inputSchema: { type: "object", properties: {
      operationId: { type: "string" }, token: { type: "string" },
      outcome: { type: "string", enum: ["verified", "joined", "uncertain", "blocked"] },
      observation: observationSchema, providerMessageId: { type: "string" }, detail: { type: "string" },
      invitationSentAt: { type: "string", description: "邀请点击发送成功时记录的UTC时间；只能是本次claim后、官方核实前的真实时间，用于5分钟加入倒计时。" },
      failureCode: { type: "string", enum: FAILURE_CODES },
    }, required: ["operationId", "token", "outcome"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "release_test_request", description: "请求回收指定授权邮箱的测试席位；只将测试申请推进待回收，不直接移除真实成员。",
    inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "set_codex_live", description: "完成真实邀请和成员回收验证后启用普通程序办理；网页提醒模式无需邮件通道，relay模式还须验证提醒投递。也可随时暂停。",
    inputSchema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return new Response("Cross-origin requests are not permitted.", { status: 403 });
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json"))
    return new Response("JSON is required.", { status: 415 });
  let id: unknown = null;
  try {
    const raw = await request.text();
    if (raw.length > 8000) return new Response("Request too large", { status: 413 });
    const body = JSON.parse(raw);
    id = body.id ?? null;
    let result: unknown;
    if (body.method === "server/discover") {
      result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
        serverInfo: { name: "numems-seat-portal", version: "1.0.0" } };
    } else if (body.method === "initialize") {
      result = { protocolVersion: "2025-03-26", capabilities: { tools: {} },
        serverInfo: { name: "numems-seat-portal", version: "1.0.0" } };
    } else if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    } else if (body.method === "tools/list") {
      result = { tools };
    } else if (body.method === "tools/call") {
      const actor = await currentActor();
      if (!actor?.isAdmin) throw new Error("只有已登录的门户管理员可以运行此工具。");
      if (body.params?.name === "version_rollback_status") {
        if(Object.keys(body.params?.arguments??{}).length)throw new Error("回退状态不接受参数。");
        const {state,revision}=await readState();const b=(state as BridgeState).codex;
        return Response.json({jsonrpc:"2.0",id,result:{content:[{type:"text",text:JSON.stringify({revision,
          schedulerEnabled:state.config.automationEnabled,memberEnabled:b?.enabled??false,
          busy:!!b?.lease,holds:b?.holds?.length??0,
          incompatiblePending:state.requests.filter(r=>r.status==="pending_removal"&&r.removalReason==="whitelist_revoked").length})}]}},{headers:{"Cache-Control":"no-store"}});
      }
      if(body.params?.name === "prepare_v11_rollback") {
        const args=body.params?.arguments;
        if(!args || Object.keys(args).join(',')!=="expectedRevision" || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision<0 || !env.DB)
          throw new Error("回退参数无效。");
        const prepared=await restoreV11History(env.DB,args.expectedRevision);
        return Response.json({jsonrpc:"2.0",id,result:{content:[{type:"text",text:JSON.stringify(prepared)}]}},{headers:{"Cache-Control":"no-store"}});
      }
      if (body.params?.name === "refresh_seat_queue") {
        const args = body.params?.arguments === undefined ? {} : body.params.arguments;
        if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length)
          throw new Error("队列刷新不接受参数。");
        const jobs = await refreshSeatQueue();
        result = { content: [{ type: "text", text: JSON.stringify({ ...jobs,
          plan: workPlan((await readState()).state as BridgeState, new Date().toISOString()) }) }] };
      } else if (body.params?.name === "process_seat_queue") {
        const jobs = await runJobs();
        result = { content: [{ type: "text", text: JSON.stringify({ ...jobs,
          plan: workPlan((await readState()).state as BridgeState, new Date().toISOString()) }) }] };
      } else if (body.params?.name === "seat_portal_status") {
        const { state } = await readState();
        result = { content: [{ type: "text", text: JSON.stringify({
          requests: state.requests.length,
          pendingNotices: state.notices.filter(n => n.status === "pending").length,
          inventoryVerified: state.config.inventoryVerified,
          plan: workPlan(state as BridgeState, new Date().toISOString()),
        }) }] };
      } else if (body.params?.name === "verified_review_receipt") {
        const args = body.params?.arguments;
        if (!args || typeof args !== "object" || Array.isArray(args) ||
            Object.keys(args).sort().join(",") !== "failureId,operationId,targetId")
          throw new Error("复核回执查询参数无效。");
        const {state} = await readState();
        result = {content:[{type:"text",text:JSON.stringify(verifiedReviewReceipt(state as BridgeState,args))}]};
      } else {
        const name = body.params?.name;
        const args = body.params?.arguments ?? {};
        const now = new Date().toISOString();
        const token = crypto.randomUUID();
        const state = await mutateState(current => {
          const s = current as BridgeState;
          if (name === "observe_workspace") return observeWorkspace(s, args.observation as Observation, now);
          if (name === "record_idle_observation_failure") return recordIdleFailure(s, args, new Date().toISOString());
          if (name === "observe_idle_workspace") return applyIdleObservation(s, args, new Date().toISOString());
          if (name === "defer_seat_operation") return deferOperation(s, args, now);
          // A CAS retry can happen long after the request began. The guarded
          // recovery must measure snapshot age on each retry, not against the
          // original request time. Preserve existing timing for other decisions.
          if (name === "review_seat_failure") return reviewFailure(s, args,
            args.decision === "resume_verified_operation" ? new Date().toISOString() : now);
          if (name === "prepare_test_request") return prepareTest(s, now);
          if (name === "record_codex_schedule") return recordSchedule(s, args.scheduleId, now);
          if (name === "set_test_deadline") return setTestDeadline(s, args.requestId, args.stage, now);
          if (name === "claim_seat_operation") {
            if (args.kind === "mail") throw new Error(reminderMode(env.REMINDER_DELIVERY_MODE) === "in_app"
              ? "当前仅在网页提醒，已禁用提醒邮件。官方邀请邮件不受影响。"
              : "邮件由普通程序通道办理，禁止另行发送。");
            if (!["invite", "remove", "mail"].includes(args.kind) || typeof args.targetId !== "string") throw new Error("办理参数无效。");
            return claimOperation(s, args.kind, args.targetId, token, now);
          }
          if (name === "complete_seat_operation") return completeOperation(s, args,
            s.codex?.operationFailureOrigin?.operationId === args.operationId &&
              ["verified", "joined"].includes(args.outcome) ? new Date().toISOString() : now);
          if (name === "set_codex_live") {
            if (typeof args.enabled !== "boolean") throw new Error("启用参数无效。");
            return setBridgeMode(s, args.enabled, now);
          }
          if (name === "release_test_request") {
            const r = s.requests.find(r => r.id === args.requestId && r.isTest === true);
            if (!r) throw new Error("只允许回收已登记的测试申请。");
            return transition(s, schedulerActor, { type: "release", id: r.id }, now);
          }
          throw new Error("未知工具。");
        });
        result = { content: [{ type: "text", text: JSON.stringify(workPlan(state as BridgeState, now)) }] };
      }
    } else {
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
    return Response.json({ jsonrpc: "2.0", id, result },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ jsonrpc: "2.0", id, result: {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : "操作失败。" }],
    } }, { headers: { "Cache-Control": "no-store" } });
  }
}
