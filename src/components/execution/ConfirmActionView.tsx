export function ConfirmActionView({ summary, onConfirm, onRevise }: { summary: string; onConfirm: () => void; onRevise: () => void }) {
  return (
    <div className="rounded-2xl bg-[#FFFDFA] p-5 text-[13px] leading-6 text-[#374151] shadow-[inset_0_0_0_1px_#EEEAE2]">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-[#7C632D]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#D6B75F]" />
        <span>等待你确认</span>
      </div>
      <div className="mt-4 text-[14px] leading-7 text-[#374151]">{summary}</div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="rounded-xl bg-[#111] px-4 py-2.5 text-[13px] font-semibold text-white transition hover:-translate-y-px hover:bg-[#2B2B2B]"
          onClick={onConfirm}
        >
          确认执行
        </button>
        <button
          type="button"
          className="bg-transparent px-0 py-2 text-[13px] text-[#6B7280] hover:text-[#1F2933]"
          onClick={onRevise}
        >
          让 KiKi 改方案
        </button>
      </div>
    </div>
  );
}
