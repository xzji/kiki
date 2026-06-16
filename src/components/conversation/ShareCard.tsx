"use client";

import { forwardRef } from "react";

import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { KikiAvatar } from "@/components/layout/KikiAvatar";
import { ProductLogo } from "@/components/layout/Sidebar";

/**
 * 分享卡片：用于导出为图片。
 * 复用会话内的 MarkdownRenderer 与头像样式，保证导出图片与会话内看到的样式一致。
 * 该组件在离屏渲染，宽度固定，高度由内容自适应。
 */
export const ShareCard = forwardRef<HTMLDivElement, { question: string; answer: string }>(
  function ShareCard({ question, answer }, ref) {
    return (
      <div ref={ref} className="w-[760px] bg-[#F3F4F6] px-12 pb-9 pt-11">
        <div className="rounded-[28px] border-2 border-[#E5E7EB] bg-white/60 p-8">
          {question.trim() ? (
            <div className="flex items-start justify-end gap-3">
              <div className="max-w-[520px] rounded-2xl rounded-br-sm bg-[#111] px-4 py-2.5 text-sm leading-6 text-white">
                {question}
              </div>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#534f69]/25 bg-[#E9E6FF] text-[13px] text-[#5F5AA2]">
                J
              </div>
            </div>
          ) : null}

          <div className="mt-7 flex items-start gap-3">
            <KikiAvatar size="md" />
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-[13px] font-medium text-[#1F2328]">KiKi</div>
              <MarkdownRenderer content={answer.trim() || "当前回复"} />
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2.5 text-right">
          <ProductLogo size={32} />
          <div className="leading-tight">
            <div className="text-[13px] font-semibold text-[#6B7280]">生成自KiKi Agent</div>
            <div className="text-[11px] font-medium text-[#8C9198]">
              https://kikiagent-production.up.railway.app
            </div>
          </div>
        </div>
      </div>
    );
  },
);
