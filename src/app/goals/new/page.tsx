"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { KikiAvatar } from "@/components/layout/KikiAvatar";
import { useGoalStore } from "@/stores/goalStore";

export default function NewGoalPage({
  searchParams,
}: {
  searchParams?: { title?: string };
}) {
  const router = useRouter();
  const title = searchParams?.title?.trim() ?? "";
  const createGoalFromInput = useGoalStore((state) => state.createGoalFromInput);

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-6 flex items-start gap-3">
          <KikiAvatar size="sm" />
          <div className="px-4 py-3 text-sm leading-6 text-[#374151]">
            {title ? `准备创建“${title}”。` : "输入目标后开始规划。"}
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Link href="/" className="rounded-lg border border-[#D0D7DE] px-4 py-2 text-sm text-[#111] hover:bg-[#F5F6F8]">取消</Link>
          <button
            className="rounded-lg bg-[#111] px-4 py-2 text-sm text-white hover:bg-[#333]"
            disabled={!title}
            onClick={() => {
              const nextGoal = createGoalFromInput(title);
              router.push(`/goals/${nextGoal.id}`);
            }}
          >
            确认创建
          </button>
        </div>
      </div>
    </div>
  );
}
