"use client";

import { useState } from "react";

import type { QA } from "@/types/kiki";

export function ListeningQAView({ questions, onComplete }: { questions: QA[]; onComplete: () => void }) {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const current = questions[index];

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-4">
        <div className="mb-3 h-10 rounded-lg bg-[#F5F6F8]" />
        <div className="text-sm font-semibold text-[#111]">{current.question}</div>
        <div className="mt-4 space-y-2">
          {current.options.map((option, optionIndex) => (
            <button key={option} onClick={() => setSelected(optionIndex)} className={`block w-full rounded-lg border px-3 py-3 text-left text-sm ${selected === optionIndex ? "border-[#111] bg-[#F8FAFC]" : "border-[#E5E7EB] bg-white"}`}>
              {String.fromCharCode(65 + optionIndex)}. {option}
            </button>
          ))}
        </div>
        {revealed ? <div className="mt-4 rounded-lg bg-[#F8FAFC] p-3 text-sm text-[#374151]">正确答案：{String.fromCharCode(65 + current.answerIndex)}。{current.explanation}</div> : null}
      </div>
      <div className="flex justify-center">
        {!revealed ? (
          <button className="rounded-lg bg-[#111] px-5 py-2 text-sm text-white hover:bg-[#333]" onClick={() => setRevealed(true)} disabled={selected === null}>提交本题</button>
        ) : (
          <button className="rounded-lg border border-[#D0D7DE] px-5 py-2 text-sm text-[#111] hover:bg-[#F5F6F8]" onClick={() => {
            if (index === questions.length - 1) onComplete();
            else {
              setIndex((prev) => prev + 1);
              setSelected(null);
              setRevealed(false);
            }
          }}>{index === questions.length - 1 ? "完成" : "下一题"}</button>
        )}
      </div>
    </div>
  );
}
