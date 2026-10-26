/**
 * `memory_review_status` 工具：回合内自审的状态查询与结算。
 *
 * 模型在快照提示到期时先用 `memory` 工具完成回顾（`reviewMode:'suggest'` 用
 * `action:'suggest'` 入队，`'auto'` 直接写入），然后调用本工具的 `complete`。
 * `complete` 只在真正完成回顾后调用；重复调用只会把计数清零（再次 complete
 * 的 diff 为空）。
 */
import { deliverReviewNotice } from './nudge.js';
import { sessionIdFromExec } from './review-registry.js';
import { loadReviewState, reviewStatus } from './review-state.js';

const DESCRIPTION = `Check or complete the periodic memory review for this session.

Use action='status' to see whether a review is due and how many turns have passed since the last one.
Use action='complete' ONLY after you have actually finished the review and written (or deliberately skipped)
the durable facts. In 'suggest' mode, stage memory changes with the memory tool's action='suggest'
(queue for the left sidebar); in 'auto' mode write them directly. If there is nothing worth saving, say
"Nothing to save." and then call complete. Completing resets the turn counter and records the diff.`;

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'complete'],
      description: "'status' reports the review counter; 'complete' finalizes a review you have actually done.",
    },
  },
  required: ['action'],
  additionalProperties: false,
};

function failure(error) {
  return { success: false, error: error?.message ?? String(error) };
}

export function reviewToolDefinition({ dir, interval, mode = 'suggest', suggestions, scheduler } = {}) {
  if (!dir) throw new Error('reviewToolDefinition requires a dir');

  function stateView() {
    const state = loadReviewState(dir);
    const status = reviewStatus(state, interval);
    let pending = 0;
    try {
      pending = suggestions?.count ? suggestions.count() : 0;
    } catch {
      pending = 0;
    }
    return {
      success: true,
      due: status.due,
      turns_since: status.turns_since,
      interval: status.interval,
      last_review_at: state.last_review_at,
      last_completed_at: state.last_completed_at,
      mode,
      suggestions_pending: pending,
    };
  }

  return {
    name: 'memory_review_status',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {};
      const action = input.action ?? 'status';
      if (action !== 'status' && action !== 'complete') {
        return { success: false, error: `Unknown action '${action}'. Use: status, complete` };
      }
      try {
        if (action === 'status') return stateView();
        const sessionId = sessionIdFromExec(exec);
        const result = scheduler?.finishReview?.(sessionId);
        // 回顾提示随工具结果进入下一步上下文：deferContext 注入 user 角色的
        // notice（inbox 只接受 user 消息，developer 角色会让整回合失败）。
        if (result?.notice) {
          deliverReviewNotice(result.notice, { deferContext: exec?.deferContext, agent: exec?.agent });
        }
        return {
          ...stateView(),
          summary: `回顾完成：${result?.summary ?? '没有需要保存的内容'}`,
        };
      } catch (error) {
        return failure(error);
      }
    },
  };
}
