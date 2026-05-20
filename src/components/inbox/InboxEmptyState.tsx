"use client";

export function InboxEmptyState() {
  return (
    <section className="flex min-h-[58vh] items-center justify-center px-4 text-center">
      <div className="max-w-[360px]">
        <div className="text-[15px] font-medium text-[#1F2328]">暂无要处理的事项</div>
        <p className="mt-2 text-[13px] leading-6 text-[#8C9198]">
          需要你知晓、补充、决策的信息，都会在这里看到
        </p>
      </div>
    </section>
  );
}
