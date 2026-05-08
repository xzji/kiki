export function ConfirmActionView({ summary, onConfirm, onRevise }: { summary: string; onConfirm: () => void; onRevise: () => void }) {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-5 text-sm leading-7 text-[#374151]">{summary}</div>
      <div className="flex justify-center gap-3">
        <button className="rounded-lg bg-[#111] px-5 py-2 text-sm text-white hover:bg-[#333]" onClick={onConfirm}>确认执行</button>
        <button className="rounded-lg border border-[#D0D7DE] px-5 py-2 text-sm text-[#111] hover:bg-[#F5F6F8]" onClick={onRevise}>让 KiKi 改方案</button>
      </div>
    </div>
  );
}
